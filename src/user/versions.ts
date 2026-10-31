// The installed version of a tool, read from files next to its executable (decision D-087): depcurfew never runs
// another program. A tool installed from npm has a package.json whose `bin` names the executable; one installed from
// PyPI has a .dist-info folder whose entry points or RECORD name it. Anything else stays unknown.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { parseVersion, type Version } from '../apply/version.ts';
import type { UserEnvironment } from './locate.ts';

export interface InstalledVersion {
  version: Version;
  text: string;
  /** The file the version was read from. */
  file: string;
}

const MAX_FILE = 1024 * 1024;
const WINDOWS_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1', ''];

function readSmall(path: string): string | undefined {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

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
  const version = parseVersion(text);
  return version === undefined ? undefined : { version, text, file };
}

/** A package.json whose bin field names `name`. */
function packageVersion(file: string, name: string): InstalledVersion | undefined {
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
  return names.includes(name) && typeof version === 'string' ? versionOf(version, file) : undefined;
}

function fromNpm(executable: string, real: string, name: string, module: typeof posix): InstalledVersion | undefined {
  // Through the symlink npm creates: walk up from the real file to the package that declares the executable.
  for (let directory = module.dirname(real), depth = 0; depth < 6; directory = module.dirname(directory), depth += 1) {
    const found = packageVersion(module.join(directory, 'package.json'), name);
    if (found !== undefined) return found;
    if (module.dirname(directory) === directory) break;
  }
  // A Windows shim (npm.cmd) sits in the prefix next to node_modules.
  return packageVersion(module.join(module.dirname(executable), 'node_modules', name, 'package.json'), name);
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

function fromPython(real: string, name: string, module: typeof posix): InstalledVersion | undefined {
  const prefix = module.dirname(module.dirname(real));
  const sitePackages = [
    ...list(module.join(prefix, 'lib'))
      .filter((entry) => /^python3(\.\d+)?$/u.test(entry))
      .map((entry) => module.join(prefix, 'lib', entry, 'site-packages')),
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
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The installed version of the executable `name` found in PATH, read from files; undefined when it cannot be read. */
export function installedVersion(name: string, ecosystem: 'npm' | 'pypi', environment: UserEnvironment): InstalledVersion | undefined {
  const executable = findExecutable(name, environment);
  if (executable === undefined) return undefined;
  const module = environment.platform === 'win32' ? win32 : posix;
  let real: string;
  try {
    real = realpathSync(executable);
  } catch {
    return undefined;
  }
  return ecosystem === 'npm' ? fromNpm(executable, real, name, module) : fromPython(real, name, module);
}
