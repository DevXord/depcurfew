// The installed version of a tool, read from files next to its executable (decision D-087): depcurfew never runs
// another program. A tool installed from npm has a package.json of its own package (one of the packages that install
// it, not corepack's) whose `bin` names the executable; one installed from PyPI has a .dist-info folder whose entry
// points or RECORD name it. A Corepack shim runs the version lastKnownGood.json names, and Yarn 2+ runs the release
// yarnPath in ~/.yarnrc.yml names, which its file name gives (decision D-101). Anything else stays unknown.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
import { environment as environmentFacts } from '../knowledge/environment.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { readLimitedText } from '../read-limited.ts';
import { parseYamlDocument } from '../yaml-parse.ts';
import { locateUserFile, shownPath, userFileFor, userFilePath, type UserEnvironment } from './locate.ts';

export interface InstalledVersion {
  version: Version;
  text: string;
  /** The file the version was read from. */
  file: string;
  /** Where the version comes from, for the list of what doctor --user checked, when it is not the files next to the executable in PATH. */
  from?: string;
}

const MAX_FILE = 1024 * 1024;
const WINDOWS_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1', ''];

const readSmall = (path: string): string | undefined => readLimitedText(path, MAX_FILE);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function variable(environment: UserEnvironment, name: string): string | undefined {
  if (environment.platform !== 'win32') return environment.env[name];
  const key = Object.keys(environment.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : environment.env[key];
}

/** The first file named like the tool in a PATH directory (on Windows also with .exe, .cmd, .bat or .ps1). */
export function findExecutable(name: string, environment: UserEnvironment): string | undefined {
  const module = environment.platform === 'win32' ? win32 : posix;
  const entries = (variable(environment, 'PATH') ?? '').split(module.delimiter).filter((entry) => entry !== '' && module.isAbsolute(entry));
  for (const directory of entries) {
    for (const suffix of environment.platform === 'win32' ? WINDOWS_SUFFIXES : ['']) {
      const candidate = module.join(directory, `${name}${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function versionOf(text: string | undefined, file: string): InstalledVersion | undefined {
  if (text === undefined) return undefined;
  // Python releases may have two parts (pip 24.0): the missing patch is 0.
  const version = parseVersion(/^\d+\.\d+$/u.test(text) ? `${text}.0` : text);
  return version === undefined ? undefined : { version, text, file };
}

type PackageFound = InstalledVersion | { corepack: string } | null | undefined;

/**
 * A package.json whose bin field names `name`: the version when it is the tool's own package (named like the tool, in
 * the tool's scope, such as @pnpm/exe, or another package that installs it, such as @yarnpkg/cli-dist), corepack's
 * version for corepack's shims, null when another package declares the executable, undefined when it does not.
 */
function packageVersion(file: string, name: string): PackageFound {
  const text = readSmall(file);
  if (text === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const { bin, name: packageName, version } = manifest as Record<string, unknown>;
  const names = typeof bin === 'string' ? [typeof packageName === 'string' ? packageName.replace(/^@[^/]+\//u, '') : ''] : typeof bin === 'object' && bin !== null ? Object.keys(bin) : [];
  if (!names.includes(name)) return undefined;
  if (typeof packageName === 'string' && packageName === corepackPackage() && typeof version === 'string') return { corepack: version };
  const own = packageName === name || (typeof packageName === 'string' && (packageName.startsWith(`@${name}/`) || ownPackages(name).includes(packageName)));
  if (!own || typeof version !== 'string') return null;
  return versionOf(version, file) ?? null;
}

const corepackPackage = (): string | undefined => values(environmentFacts.corepack.package)[0];

/** The npm packages that install the tool itself besides the one named like it (@yarnpkg/cli-dist for Yarn 2+). */
function ownPackages(name: string): readonly string[] {
  const packages = values(environmentFacts.corepack.toolPackages)[0];
  return packages?.[name as ToolId] ?? [];
}

/**
 * The version a Corepack shim runs outside a project: the one lastKnownGood.json in Corepack's home folder names
 * (environment.corepack.defaults); undefined when the file or the entry is missing, or the folder is not known.
 */
function fromCorepack(name: string, corepackVersion: string, environment: UserEnvironment): InstalledVersion | undefined {
  const defaults = values(environmentFacts.corepack.defaults)[0];
  const running = parseVersion(corepackVersion);
  const since = defaults === undefined ? undefined : parseVersion(defaults.since);
  if (defaults === undefined || running === undefined || since === undefined || compareVersions(running, since) < 0) return undefined;
  const located = locateUserFile(defaults, environment);
  if (located === undefined || 'relative' in located) return undefined;
  const text = readSmall(located.path);
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
  const reference = isRecord(parsed) && Object.hasOwn(parsed, name) ? parsed[name] : undefined;
  if (typeof reference !== 'string') return undefined;
  // The hash after + (1.22.22+sha1.ac34...) is not part of the version.
  const found = versionOf(reference.split('+', 1)[0] ?? '', located.path);
  return found === undefined ? undefined : { ...found, from: shownPath(located.path, environment) };
}

function fromNpm(executable: string, real: string, name: string, module: typeof posix, environment: UserEnvironment): InstalledVersion | undefined {
  const decide = (found: PackageFound): InstalledVersion | undefined =>
    found === null || found === undefined ? undefined : 'corepack' in found ? fromCorepack(name, found.corepack, environment) : found;
  // Through the symlink npm creates: walk up from the real file to the package that declares the executable. The
  // first one decides: when it is corepack's, the version is the one Corepack runs outside a project.
  for (let directory = module.dirname(real), depth = 0; depth < 6; directory = module.dirname(directory), depth += 1) {
    const found = packageVersion(module.join(directory, 'package.json'), name);
    if (found !== undefined) return decide(found);
    if (module.dirname(directory) === directory) break;
  }
  // A Windows shim (npm.cmd) sits in the prefix next to node_modules; corepack enable puts its shims next to corepack's.
  const prefix = module.join(module.dirname(executable), 'node_modules');
  const own = packageVersion(module.join(prefix, name, 'package.json'), name);
  if (own !== undefined) return decide(own);
  const corepack = corepackPackage();
  return corepack === undefined ? undefined : decide(packageVersion(module.join(prefix, corepack, 'package.json'), name));
}

const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, '_');

function declaresScript(distInfo: string, name: string, module: typeof posix): boolean {
  const entryPoints = readSmall(module.join(distInfo, 'entry_points.txt')) ?? '';
  let section = '';
  for (const line of entryPoints.split(/\r?\n/u)) {
    const header = /^\s*\[(.+)\]\s*$/u.exec(line);
    if (header !== null) section = header[1]?.trim() ?? '';
    else if (section === 'console_scripts' && line.split('=')[0]?.trim() === name) return true;
  }
  const record = readSmall(module.join(distInfo, 'RECORD')) ?? '';
  return record.split(/\r?\n/u).some((line) => {
    const path = line.split(',')[0]?.replaceAll('\\', '/') ?? '';
    return path.endsWith(`/bin/${name}`) || path.endsWith(`/Scripts/${name}.exe`) || path.endsWith(`/scripts/${name}`);
  });
}

/** The .dist-info of a Python tool whose entry points or RECORD name the executable, with its site-packages folder. */
function pythonDistInfo(real: string, name: string, module: typeof posix): { found: InstalledVersion; sitePackages: string } | undefined {
  const prefix = module.dirname(module.dirname(real));
  // site-packages of a virtual environment or a pip install --user; dist-packages where Debian and Ubuntu install them.
  const sitePackages = [
    ...list(module.join(prefix, 'lib'))
      .filter((entry) => /^python3(\.\d+)?$/u.test(entry))
      .flatMap((entry) => [module.join(prefix, 'lib', entry, 'site-packages'), module.join(prefix, 'lib', entry, 'dist-packages')]),
    module.join(prefix, 'Lib', 'site-packages'),
  ];
  for (const directory of sitePackages) {
    for (const entry of list(directory)) {
      const match = /^(.+)-([^-]+)\.dist-info$/u.exec(entry);
      if (match === null || normalized(match[1] ?? '') !== normalized(name)) continue;
      const distInfo = module.join(directory, entry);
      if (!declaresScript(distInfo, name, module)) continue;
      const metadata = readSmall(module.join(distInfo, 'METADATA')) ?? '';
      const stated = /^Version:\s*(\S+)\s*$/mu.exec(metadata)?.[1] ?? match[2];
      const found = versionOf(stated, module.join(distInfo, 'METADATA'));
      if (found !== undefined) return { found, sitePackages: directory };
    }
  }
  return undefined;
}

/** The version in the .dist-info of a distribution in a site-packages folder. */
function distributionVersion(sitePackages: string, name: string, module: typeof posix): InstalledVersion | undefined {
  for (const entry of list(sitePackages)) {
    const match = /^(.+)-([^-]+)\.dist-info$/u.exec(entry);
    if (match === null || normalized(match[1] ?? '') !== normalized(name)) continue;
    const metadata = module.join(sitePackages, entry, 'METADATA');
    const stated = /^Version:\s*(\S+)\s*$/mu.exec(readSmall(metadata) ?? '')?.[1] ?? match[2];
    const found = versionOf(stated, metadata);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The executable `name` found in PATH and the real file behind it. */
function resolved(name: string, environment: UserEnvironment): { executable: string; real: string; module: typeof posix } | undefined {
  const executable = findExecutable(name, environment);
  if (executable === undefined) return undefined;
  try {
    return { executable, real: realpathSync(executable), module: environment.platform === 'win32' ? win32 : posix };
  } catch {
    return undefined;
  }
}

/** The installed version of the executable `name` found in PATH, read from files; undefined when it cannot be read. */
export function installedVersion(name: string, ecosystem: 'npm' | 'pypi', environment: UserEnvironment): InstalledVersion | undefined {
  const found = resolved(name, environment);
  if (found === undefined) return undefined;
  const { executable, real, module } = found;
  return ecosystem === 'npm' ? fromNpm(executable, real, name, module, environment) : pythonDistInfo(real, name, module)?.found;
}

/**
 * The version of a library installed next to a Python tool (the platformdirs that Poetry and PDM call), read from its
 * .dist-info in the tool's site-packages; undefined when the tool or the library is not found there.
 */
export function libraryVersion(tool: ToolKnowledge, library: string, environment: UserEnvironment): InstalledVersion | undefined {
  if (ecosystemOfTool(tool) !== 'pypi') return undefined;
  const found = resolved(tool.id, environment);
  const site = found === undefined ? undefined : pythonDistInfo(found.real, tool.id, found.module);
  return site === undefined || found === undefined ? undefined : distributionVersion(site.sitePackages, library, found.module);
}

interface YarnPathFact {
  key: string;
  releaseFile: string;
  variables: readonly string[];
}
const isYarnPath = (value: unknown): value is YarnPathFact =>
  isRecord(value) && typeof value['key'] === 'string' && typeof value['releaseFile'] === 'string' && Array.isArray(value['variables']);
const isClassic = (value: unknown): value is { until: string } => isRecord(value) && typeof value['until'] === 'string';

/** What Yarn 1.x is called in messages: depcurfew configures only the later Yarn (extra.classicUserFile). */
export const YARN_CLASSIC = 'Yarn Classic';

/**
 * The name of a tool at an installed version, for the list of what doctor --user checked: Yarn before the version of
 * extra.classicUserFile is Yarn Classic, not the Yarn depcurfew configures (decision D-116).
 */
export function installedToolName(tool: ToolKnowledge, version: Version | undefined): string {
  if (version === undefined || tool.extra?.['classicUserFile'] === undefined) return tool.name;
  const until = parseVersion(extraOf(tool, 'classicUserFile', isClassic).until);
  return until !== undefined && compareVersions(version, until) < 0 ? YARN_CLASSIC : tool.name;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The release yarnPath in the home .yarnrc.yml names (extra.yarnPath), when its file name gives an exact version
 * (yarn-4.10.3.cjs, as yarn set version names it) and the file exists. Not when a variable that changes the file Yarn
 * runs is set, and not for Yarn Classic, which never reads .yarnrc.yml.
 */
function fromYarnPath(tool: ToolKnowledge, environment: UserEnvironment, global: InstalledVersion | undefined): InstalledVersion | undefined {
  if (tool.extra?.['yarnPath'] === undefined) return undefined;
  const fact = extraOf(tool, 'yarnPath', isYarnPath);
  const classic = tool.extra['classicUserFile'] === undefined ? undefined : parseVersion(extraOf(tool, 'classicUserFile', isClassic).until);
  if (global !== undefined && classic !== undefined && compareVersions(global.version, classic) < 0) return undefined;
  const names = new Set(fact.variables.map((name) => name.toUpperCase()));
  // Yarn reads YARN_* variables in any case.
  if (Object.entries(environment.env).some(([name, value]) => names.has(name.toUpperCase()) && (value?.trim() ?? '') !== '')) return undefined;
  const file = userFileFor(tool, global?.version);
  const rc = file === null ? undefined : userFilePath(file, environment);
  const text = rc === undefined ? undefined : readSmall(rc);
  if (rc === undefined || text === undefined) return undefined;
  const document = parseYamlDocument(text);
  if (document.errors.length > 0) return undefined;
  const value: unknown = document.get(fact.key);
  // ${VARIABLE} references are replaced by Yarn, from an environment depcurfew may not see.
  if (typeof value !== 'string' || value.trim() === '' || value.includes('${')) return undefined;
  const module = environment.platform === 'win32' ? win32 : posix;
  // A relative yarnPath is resolved against the folder of the .yarnrc.yml that sets it.
  const release = module.resolve(module.dirname(rc), value.trim());
  const [before, after] = fact.releaseFile.split('<version>');
  const pattern = new RegExp(`^${escaped(before ?? '')}(.+)${escaped(after ?? '')}$`, 'u');
  const named = pattern.exec(module.basename(release))?.[1];
  const version = named === undefined ? undefined : parseVersion(named);
  if (named === undefined || version === undefined || !isFile(release)) return undefined;
  return { version, text: named, file: release, from: `${fact.key} in ${shownPath(rc, environment)}` };
}

/** The version of a tool that runs outside a project, read from files: the executable in PATH, or the release yarnPath names. */
export function toolVersion(tool: ToolKnowledge, environment: UserEnvironment): InstalledVersion | undefined {
  const global = installedVersion(tool.id, ecosystemOfTool(tool), environment);
  return fromYarnPath(tool, environment, global) ?? global;
}
