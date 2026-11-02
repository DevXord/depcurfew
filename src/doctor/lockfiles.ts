// Reading lockfiles for doctor: where each package comes from (registry, git, tarball URL, local tarball, local
// directory, workspace) and, where the format records it, whether it has install scripts. The spelling of every
// format comes from the knowledge base (extra.lockfileFormat).
import { posix } from 'node:path';
import { isRecord, values } from '../apply/facts.ts';
import { parseJsonc } from '../detect/jsonc.ts';
import type { Repository } from '../detect/repository.ts';
import type { PackageManagerInfo } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { listing } from '../apply/requirements.ts';
import { isAbsoluteAnywhere } from '../paths.ts';
import { parseYaml, parseYamlDocuments } from '../yaml-parse.ts';
import { composerEntries, composerManifest, declaredRepositories } from './composer.ts';
import { pdmEntries, pipfileLockEntries, poetryEntries, pylockEntries, requirementsEntries, requirementsFormatOf, requirementsIncludes, uvEntries } from './python-lockfiles.ts';

/** Lockfiles are often larger than configuration files. */
export const MAX_LOCKFILE_SIZE = 64 * 1024 * 1024;

/**
 * YAML lockfiles (pnpm-lock.yaml, Yarn Berry's yarn.lock) are parsed into a syntax tree that takes about 60 times the
 * size of the file in memory: a 16 MiB one about 1 GiB of the 2 GiB that Node.js gives itself on a CI runner with
 * 7 GB of memory. A larger one is reported as not checked instead of ending doctor without a report.
 */
export const MAX_YAML_LOCKFILE_SIZE = 16 * 1024 * 1024;

export type Source = 'registry' | 'git' | 'remoteTarball' | 'file' | 'directory' | 'workspace' | 'unknown';

export interface LockEntry {
  name: string;
  /** How the lockfile names the source, for messages. */
  spec: string;
  source: Source;
  /** undefined when the format does not record install scripts. */
  installScript: boolean | undefined;
  /** Text to look for when reporting the line. */
  anchor: string;
  /** The line, when the parser knows it. */
  line?: number;
  /** A requirement without a package name (a bare URL or path): `name` is its location, and no allow-list matches it. */
  unnamed?: boolean;
  /**
   * The exact version of a package from a registry that the tool installs, when the lockfile pins one (doctor --osv and
   * the install-script notes, decisions D-127 and D-129): for npm the version of the registry tarball of resolved, for
   * pnpm the one of resolution.tarball when there is one, for Yarn the version of the resolution (decision D-135).
   */
  version?: string;
  /** Composer: a plugin that declares extra.plugin-optional, which Composer skips without a terminal when it is not allowed (decision D-134). */
  optional?: true;
  /** npm, pnpm and Yarn: the registry package the tool installs, when it is not `name` (a tarball of another package). */
  registryName?: string;
  /**
   * What the lockfile says the entry is, when that differs from what the tool installs (decision D-135): npm's name and
   * version fields (`label`, with the key of the entry) beside the registry tarball of resolved, pnpm's key beside the
   * registry tarball of resolution.tarball, Yarn's version field beside the version of the resolution.
   */
  mislabel?: { tool: 'npm'; key: string; label: string } | { tool: 'pnpm'; key: string; label: string } | { tool: 'yarn'; label: string; resolution: string };
  /** Composer: why it installs a package that has an archive from its VCS source instead (decision D-136), for messages. */
  why?: string;
  /**
   * Composer: an archive from a host of Packagist.org's packages next to a VCS source on a host that is not the one of
   * that archive (decision D-136), which Packagist.org never writes: the source Composer falls back to in some cases.
   */
  otherSource?: { spec: string; distHost: string; sourceHost: string };
}

export interface Lockfile {
  file: string;
  entries: LockEntry[];
  /** Whether the format records install scripts at all. */
  recordsScripts: boolean;
  /** 1-based line of an entry's anchor (searched on demand, since lockfiles are large). */
  lineOf(entry: LockEntry): number | undefined;
  /** pip requirements files: every file whose global options (such as --only-binary) apply to this one's packages. */
  optionFiles?: readonly string[];
  /** A pip requirements file, which may name a range instead of a version; not a lockfile written by a tool. */
  requirements?: true;
}

type Format = Record<string, unknown>;

/**
 * How much the searches of one finder read in all (decision D-135): LINE_SEARCH_READINGS times the text, and
 * LINE_SEARCH_FLOOR characters more, so that a small file may miss many anchors. Anchors in the order of the file take
 * one reading together; an anchor that is not where the last one stopped takes up to two. Searching the whole file for
 * each of 20 000 entries of a minified lockfile took minutes; once the budget is spent, the remaining anchors have no
 * line. Reading 1 GiB takes indexOf about a second.
 */
const LINE_SEARCH_READINGS = 16;
const LINE_SEARCH_FLOOR = 64 * 1024 * 1024;

/**
 * A JSON anchor as a minified file writes it: `"name":{` for `"name": {`, `"name":"a/b"` for `"name": "a/b"`;
 * undefined for anchors that do not start with a key.
 */
function compactAnchor(anchor: string): string | undefined {
  const compact = anchor.replace(/^("(?:[^"\\]|\\.)*"): (?=\S)/u, '$1:');
  return compact === anchor ? undefined : compact;
}

/**
 * Finds the 1-based line of each anchor. Rules ask in the order the entries were parsed, which is the order of the
 * file, so each search continues where the last one stopped and a large lockfile is not scanned once per entry. An
 * anchor not after that point is looked for from the start, and a JSON anchor also as a minified file writes it (that
 * spelling first once it has matched); an anchor not found is remembered, and all searches together read at most the
 * budget above (plus one search), so the time stays linear in the size of the text.
 */
function lineFinder(text: string, start = 0): (anchor: string) => number | undefined {
  let newlines: number[] | undefined;
  let cursor = start;
  let budget = LINE_SEARCH_READINGS * text.length + LINE_SEARCH_FLOOR;
  let compactFirst = false;
  const missing = new Set<string>();
  // indexOf from `from`, charged with what it read: up to the match, or to the end.
  const search = (anchor: string, from: number): number => {
    if (budget <= 0) return -1;
    const offset = text.indexOf(anchor, from);
    budget -= (offset === -1 ? text.length : offset + anchor.length) - from;
    return offset;
  };
  const find = (anchor: string): number => {
    const offset = search(anchor, cursor);
    return offset === -1 && cursor > 0 ? search(anchor, 0) : offset;
  };
  return (anchor) => {
    if (missing.has(anchor)) return undefined;
    const compact = compactAnchor(anchor);
    const spellings = compact === undefined ? [anchor] : compactFirst ? [compact, anchor] : [anchor, compact];
    let offset = -1;
    let found = anchor;
    for (const spelling of spellings) {
      offset = find(spelling);
      if (offset === -1) continue;
      found = spelling;
      if (spelling === compact) compactFirst = true;
      break;
    }
    if (offset === -1) {
      if (budget > 0) missing.add(anchor);
      return undefined;
    }
    cursor = offset + found.length;
    if (newlines === undefined) {
      newlines = [];
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) newlines.push(index);
    }
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((newlines[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Splits name@spec, where the name may be scoped and the spec may contain @ (git@host). */
export function splitSpec(key: string): { name: string; spec: string } {
  const at = key.startsWith('@') ? key.indexOf('@', key.indexOf('/') + 1) : key.indexOf('@');
  return at <= 0 ? { name: key, spec: '' } : { name: key.slice(0, at), spec: key.slice(at + 1) };
}

const HTTP = /^https?:\/\//u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** `{ version }` for an exact version of a registry package, else nothing: what doctor --osv looks up. */
function exactVersion(source: Source, version: string | undefined): { version: string } | Record<string, never> {
  return source === 'registry' && version !== undefined && EXACT_VERSION.test(version) ? { version } : {};
}

/** The full version of semver (FULL in internal/re.js of semver 7.8.5), with the version and the build as groups. */
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][a-zA-Z0-9-]*))*))?(?:\+([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/u;

/**
 * A version as semver.parse reads it (semver 7.8.5, which npm and Yarn use): three numbers without leading zeros, an
 * optional pre-release and build, an optional leading v, spaces around it, at most 256 characters. `core` is the version
 * semver gives (without the v and the build), `build` the build metadata.
 */
function parseSemver(text: string): { core: string; build: string | undefined } | undefined {
  if (text.length > 256) return undefined;
  const match = SEMVER.exec(text.trim());
  if (match === null) return undefined;
  const [, major = '', minor = '', patch = '', pre, build] = match;
  if ([major, minor, patch].some((part) => Number(part) > Number.MAX_SAFE_INTEGER)) return undefined;
  return { core: `${major}.${minor}.${patch}${pre === undefined ? '' : `-${pre}`}`, build };
}

/** The base a relative resolution.tarball of pnpm is read against: pnpm resolves it against the registry, whose path only adds to the front. */
const RELATIVE_BASE = 'https://registry.invalid/';

/**
 * The path of a tarball URL as the registry reads it (decisions D-135 and D-136): without the query and the fragment,
 * which name no other file (the fragment is not even sent), with its percent-escapes decoded; a relative URL (pnpm)
 * is read against the registry. undefined for a URL that is not http(s) or does not decode.
 */
function tarballPath(url: string, relative: boolean): string | undefined {
  try {
    const parsed = relative && !HTTP.test(url) ? new URL(url, RELATIVE_BASE) : new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

/** Whether a tarball URL has the layout of a registry tarball (/-/ in its path), whatever depcurfew reads from it. */
function registryLayout(url: string, format: Format, relative: boolean): boolean {
  return tarballPath(url, relative)?.includes(String(format['separator'])) === true;
}

/**
 * The registry package whose tarball a URL is, as npm reads it from resolved (versionFromTgz, npm extra.tarballIdentity,
 * decisions D-135 and D-136): /<name>/-/<name>-<version>.tgz in the path the registry reads, with the scope before the
 * name and any path of the registry before them. undefined for a path in another layout.
 */
function tarballIdentity(url: string, format: Format, relative = false): { name: string; version: string } | undefined {
  const separator = String(format['separator']);
  const extension = String(format['extension']);
  const path = tarballPath(url, relative);
  if (path === undefined) return undefined;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!base.endsWith(extension)) return undefined;
  const parts = path.slice(1).split(separator);
  if (parts.length < 2 || parts.pop() !== base) return undefined;
  const pieces = (parts.pop() ?? '').split(new RegExp(String(format['scopeSeparator']), 'iu'));
  const project = pieces.pop() ?? '';
  const scope = pieces.pop();
  if (project === '' || !base.startsWith(`${project}-`)) return undefined;
  const version = parseSemver(base.slice(project.length + 1, base.length - extension.length));
  if (version === undefined) return undefined;
  return { name: scope?.startsWith('@') === true ? `${scope}/${project}` : project, version: version.core };
}

/** Where npm installs the dependency `name` of the package at `from`: its own node_modules, else the nearest parent's. */
function installedAt(packages: Format, from: string, name: string): string | undefined {
  for (let base = from; ; ) {
    const location = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (location in packages) return location;
    if (base === '') return undefined;
    const parent = base.lastIndexOf('/node_modules/');
    base = parent === -1 ? '' : base.slice(0, parent);
  }
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

interface UrlOverride {
  name: string;
  /** Path of the tarball URL, matched at the end of resolved, whose host npm may have rewritten. */
  path: string;
}

/** Packages that overrides (npm, root package.json only) replace with a tarball URL, at any depth of nesting. */
function urlOverrides(overrides: unknown, parent: string | undefined, selfKey: string, found: UrlOverride[] = []): UrlOverride[] {
  if (!isRecord(overrides)) return found;
  for (const [key, value] of Object.entries(overrides)) {
    const name = key === selfKey ? parent : splitSpec(key).name;
    if (typeof value === 'string') {
      const path = HTTP.test(value) ? urlPath(value) : '';
      if (name !== undefined && path !== '') found.push({ name, path });
    } else {
      urlOverrides(value, name, selfKey, found);
    }
  }
  return found;
}

function npmEntries(text: string, format: Format, workspaces: readonly string[], manifest: unknown, overridesFormat: Format | undefined, identityFormat: Format | undefined): LockEntry[] {
  const document = JSON.parse(text) as unknown;
  if (!isRecord(document) || !isRecord(document['packages'])) throw new UnsupportedLockfile('it has no "packages" section (lockfileVersion 1 is not read)');
  const packages = document['packages'];
  const registry = new RegExp(String(format['registryTarball']), 'u');
  const scriptsKey = String(format['installScripts']);
  const fields = strings(format['dependencyFields']);
  // A package declared or overridden with a URL comes from that URL, also when the URL is a registry tarball: its
  // resolved URL then looks like any registry package's (and npm may rewrite the host to the configured registry),
  // while npm skips the release-age check for it. An AI agent can pin a fresh version that way.
  const fromUrl = new Set<string>();
  for (const [key, value] of Object.entries(packages)) {
    if (!isRecord(value)) continue;
    for (const field of fields) {
      const dependencies = value[field];
      if (!isRecord(dependencies)) continue;
      for (const [name, spec] of Object.entries(dependencies)) {
        const location = typeof spec === 'string' && HTTP.test(spec) ? installedAt(packages, key, name) : undefined;
        if (location !== undefined) fromUrl.add(location);
      }
    }
  }
  const overrides =
    overridesFormat !== undefined && isRecord(manifest)
      ? urlOverrides(manifest[String(overridesFormat['field'])], undefined, String(overridesFormat['selfKey']))
      : [];
  const entries: LockEntry[] = [];
  for (const [key, value] of Object.entries(packages)) {
    if (!key.includes('node_modules/') || !isRecord(value)) continue;
    const name = typeof value['name'] === 'string' ? value['name'] : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = typeof value['resolved'] === 'string' ? value['resolved'] : '';
    // Without resolved, npm installs name@version, so a version such as git+https://… is where the package comes from.
    const version = typeof value['version'] === 'string' ? value['version'] : '';
    const spec = resolved !== '' || format['specWithoutResolved'] !== 'version' ? resolved : version;
    let source: Source = 'unknown';
    if (value[String(format['linkFlag'])] === true) source = workspaces.includes(resolved) ? 'workspace' : 'directory';
    else if (strings(format['gitPrefixes']).some((prefix) => spec.startsWith(prefix))) source = 'git';
    else if (spec.startsWith(String(format['filePrefix']))) source = /\.(?:tgz|tar\.gz)$/u.test(spec) ? 'file' : 'directory';
    else if (HTTP.test(spec)) {
      const overridden = overrides.some((override) => override.name === name && urlPath(spec).endsWith(override.path));
      source = registry.test(spec) && !fromUrl.has(key) && !overridden ? 'registry' : 'remoteTarball';
    }
    else if (resolved === '' && (spec === '' || EXACT_VERSION.test(spec))) source = 'registry';
    const entry: LockEntry = { name, spec, source, installScript: value[scriptsKey] === true, anchor: `${JSON.stringify(key)}: {`, ...exactVersion(source, version) };
    // npm installs the tarball of resolved, whatever the name and version fields say (extra.tarballIdentity, D-135),
    // also when a query or a fragment follows its file name; a registry tarball URL from which depcurfew reads no name
    // and version is an entry without an exact version, never the version field (D-136).
    const fetched = source === 'registry' && resolved !== '' && identityFormat !== undefined;
    const identity = fetched ? tarballIdentity(resolved, identityFormat) : undefined;
    if (fetched && identity === undefined) delete entry.version;
    if (identity !== undefined) {
      entry.version = identity.version;
      if (identity.name !== name) entry.registryName = identity.name;
      if (identity.name !== name || (version !== '' && version !== identity.version)) entry.mislabel = { tool: 'npm', key, label: version === '' ? name : `${name}@${version}` };
    }
    entries.push(entry);
  }
  return entries;
}

/** The project lockfile of a pnpm-lock.yaml and where it starts: the last document when a boot document comes first. */
function pnpmGraph(text: string, documents: Format | undefined): { document: unknown; start: number } {
  const marker = documents?.['bootMarker'];
  if (typeof marker !== 'string' || documents?.['graph'] !== 'last' || text.split(/\r?\n/u, 1)[0] !== marker) return { document: parseYaml(text), start: 0 };
  const all = parseYamlDocuments(text);
  for (const document of all) if (document.errors.length > 0) throw document.errors[0] as Error;
  const last = all.at(-1);
  return { document: last?.toJS() as unknown, start: last?.range[0] ?? 0 };
}

function pnpmEntries(text: string, format: Format, documents: Format | undefined, identityFormat: Format | undefined): { entries: LockEntry[]; start: number } {
  const { document, start } = pnpmGraph(text, documents);
  if (!isRecord(document)) return { entries: [], start };
  if (!String(document['lockfileVersion']).startsWith('9')) throw new UnsupportedLockfile(`its lockfileVersion ${String(document['lockfileVersion'])} is not read; depcurfew reads 9.0`);
  const hosts = strings(format['gitHostedTarballHosts']);
  const entries: LockEntry[] = [];
  const packages = isRecord(document['packages']) ? document['packages'] : {};
  for (const [key, value] of Object.entries(packages)) {
    const { name, spec } = splitSpec(key);
    const resolution = isRecord(value) && isRecord(value['resolution']) ? value['resolution'] : {};
    const tarball = typeof resolution['tarball'] === 'string' ? resolution['tarball'] : '';
    let host = '';
    try {
      host = HTTP.test(tarball) ? new URL(tarball).hostname : HTTP.test(spec) ? new URL(spec).hostname : '';
    } catch {
      host = '';
    }
    let source: Source = 'registry';
    if (spec.startsWith(String(format['gitKeyPrefix'])) || resolution['type'] === format['gitType']) source = 'git';
    else if (resolution[String(format['gitHostedFlag'])] === true || (host !== '' && hosts.includes(host))) source = 'git';
    else if (resolution['type'] === format['directoryType']) source = 'directory';
    else if (spec.startsWith('file:')) source = 'file';
    else if (HTTP.test(spec)) source = 'remoteTarball';
    // A registry package is name@version; a key may carry a suffix in parentheses (peers, a patch hash).
    const entry: LockEntry = { name, spec, source, installScript: undefined, anchor: key, ...exactVersion(source, spec.split('(', 1)[0]) };
    // pnpm fetches resolution.tarball when it is there (extra.tarballResolution, D-135), a relative one from the
    // registry; a registry tarball of another package or version is what it installs. A URL in the layout of a
    // registry tarball that depcurfew cannot read gives no exact version (D-136); a URL in a layout of its own (a
    // registry such as GitHub Packages) leaves the key.
    const fetched = source === 'registry' && tarball !== '' && !tarball.startsWith('file:') && identityFormat !== undefined;
    const identity = fetched ? tarballIdentity(tarball, identityFormat, true) : undefined;
    if (fetched && identity === undefined && registryLayout(tarball, identityFormat, true)) delete entry.version;
    if (identity !== undefined && (identity.name !== name || identity.version !== entry.version)) {
      entry.version = identity.version;
      if (identity.name !== name) entry.registryName = identity.name;
      entry.mislabel = { tool: 'pnpm', key, label: key };
    }
    entries.push(entry);
  }
  // link: dependencies other than workspace: ones are local directories, listed only under importers.
  const importers = isRecord(document['importers']) ? document['importers'] : {};
  for (const importer of Object.values(importers)) {
    if (!isRecord(importer)) continue;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = isRecord(importer[group]) ? importer[group] : {};
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (!isRecord(dependency) || typeof dependency['version'] !== 'string') continue;
        const specifier = typeof dependency['specifier'] === 'string' ? dependency['specifier'] : '';
        if (dependency['version'].startsWith('link:') && !specifier.startsWith('workspace:')) {
          entries.push({ name, spec: specifier, source: 'directory', installScript: undefined, anchor: `specifier: ${specifier}` });
        }
      }
    }
  }
  return { entries, start };
}

function yarnSource(locator: string, format: Format): Source {
  if (locator.startsWith(String(format['workspace']))) return 'workspace';
  if (locator.startsWith(String(format['registry']))) return 'registry';
  if (locator.startsWith(String(format['patch']))) {
    const inner = decodeURIComponent(locator.slice(String(format['patch']).length).split('#')[0] ?? '');
    return yarnSource(splitSpec(inner).spec, format);
  }
  if (locator.startsWith(String(format['file']))) {
    const path = locator.slice(String(format['file']).length).split('#')[0]?.split('::')[0] ?? '';
    return new RegExp(String(format['tarball']), 'u').test(path) ? 'file' : 'directory';
  }
  if (strings(format['directory']).some((prefix) => locator.startsWith(prefix))) return 'directory';
  if (locator.includes(String(format['gitCommit'])) || /^(git\+|git:|ssh:|git@|github:)/u.test(locator)) return 'git';
  if (HTTP.test(locator)) return 'remoteTarball';
  return 'unknown';
}

/**
 * The registry package Yarn fetches for a resolution (yarn extra.registryFetch, decision D-135): the name and the version
 * of an npm: locator, cleaned as Yarn cleans it, also inside a patch: locator. undefined when Yarn fetches no registry
 * version for it.
 */
function yarnRegistry(name: string, spec: string, fetch: Format, depth = 0): { name: string; version: string } | undefined {
  const patch = String(fetch['patch']);
  if (spec.startsWith(patch) && depth < 4) {
    let inner: string;
    try {
      inner = decodeURIComponent(spec.slice(patch.length).split(String(fetch['patchEnd']))[0] ?? '');
    } catch {
      return undefined;
    }
    const locator = splitSpec(inner);
    return yarnRegistry(locator.name, locator.spec, fetch, depth + 1);
  }
  const protocol = String(fetch['protocol']);
  if (!spec.startsWith(protocol)) return undefined;
  const selector = spec.slice(protocol.length).split(String(fetch['params']))[0] ?? '';
  const parsed = parseSemver(selector);
  return parsed === undefined ? undefined : { name, version: `${parsed.core}${parsed.build === undefined ? '' : `+${parsed.build}`}` };
}

function yarnEntries(text: string, format: Format, fetch: Format | undefined): LockEntry[] {
  const document = parseYaml(text);
  if (!isRecord(document)) return [];
  return Object.entries(document)
    .filter(([key, value]) => key !== '__metadata' && isRecord(value) && typeof value['resolution'] === 'string')
    .map(([, value]) => {
      const resolution = (value as Record<string, unknown>)['resolution'] as string;
      const { name, spec } = splitSpec(resolution);
      const source = yarnSource(spec, format);
      const field = (value as Record<string, unknown>)['version'];
      const version = typeof field === 'string' ? field : undefined;
      const entry: LockEntry = { name, spec, source, installScript: undefined, anchor: `resolution: "${resolution}"` };
      if (source !== 'registry') return entry;
      if (fetch === undefined) return { ...entry, ...exactVersion(source, version) };
      // Yarn fetches the version of the resolution; the version field is a label (decision D-135).
      const fetched = yarnRegistry(name, spec, fetch);
      if (fetched === undefined) return entry;
      return {
        ...entry,
        version: fetched.version,
        ...(fetched.name === name ? {} : { registryName: fetched.name }),
        ...(version === undefined || version === fetched.version ? {} : { mislabel: { tool: 'yarn' as const, label: version, resolution } }),
      };
    });
}

function bunEntries(text: string, format: Format): LockEntry[] {
  const document = parseJsonc(text);
  const packages = isRecord(document) && isRecord(document['packages']) ? document['packages'] : {};
  const tarball = new RegExp(String(format['tarball']), 'u');
  const scriptsKey = String(format['installScripts']);
  const entries: LockEntry[] = [];
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    const { name, spec } = splitSpec(value[0]);
    let source: Source = 'registry';
    if (strings(format['git']).some((prefix) => spec.startsWith(prefix))) source = 'git';
    else if (spec.startsWith(String(format['workspace']))) source = 'workspace';
    else if (strings(format['directory']).some((prefix) => spec.startsWith(prefix))) source = 'directory';
    else if (HTTP.test(spec)) source = 'remoteTarball';
    else if (/^(\.{1,2}\/|\/)/u.test(spec) && tarball.test(spec)) source = 'file';
    const info = (value as unknown[]).find((item) => isRecord(item));
    entries.push({ name, spec, source, installScript: isRecord(info) && info[scriptsKey] === true, anchor: `${JSON.stringify(key)}: [`, ...exactVersion(source, spec) });
  }
  return entries;
}

function denoEntries(text: string, format: Format): { entries: LockEntry[]; recordsScripts: boolean } {
  const document = JSON.parse(text) as unknown;
  if (!isRecord(document)) return { entries: [], recordsScripts: false };
  const recordsScripts = Number(document['version']) >= Number(format['installScriptsSinceLockfile']);
  const npm = isRecord(document['npm']) ? document['npm'] : {};
  const scriptsKey = String(format['installScripts']);
  const entries = Object.entries(npm).map(([key, value]): LockEntry => {
    const { name, spec } = splitSpec(key);
    // name@version, with the separator and the versions of its peer dependencies when it has some.
    const peers = typeof format['peerSeparator'] === 'string' ? format['peerSeparator'] : undefined;
    return {
      name,
      spec,
      source: 'registry',
      installScript: recordsScripts ? isRecord(value) && value[scriptsKey] === true : undefined,
      anchor: `${JSON.stringify(key)}: {`,
      ...exactVersion('registry', peers === undefined ? spec : spec.split(peers, 1)[0]),
    };
  });
  return { entries, recordsScripts };
}

/** A lockfile in a version or shape depcurfew does not read; the message says why. */
class UnsupportedLockfile extends Error {}

/**
 * A lockfile that could not be checked. An unreadable one (missing, outside the repository, too large, invalid) is
 * also a repository warning, which unreadable-config reports as an error; an unsupported format version is not.
 */
export type LockfileResult = { ok: true; lockfile: Lockfile } | { ok: false; file: string; reason: string; unreadable: boolean };

function documentsOf(tool: ToolKnowledge): Format | undefined {
  const fact = tool.extra?.['lockfileDocuments'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return isRecord(value) ? value : undefined;
}

/** The package.json next to a lockfile, or undefined when it is missing or not JSON. */
function readManifest(repository: Repository, lockfile: string): unknown {
  const text = repository.readText(posix.join(posix.dirname(lockfile), 'package.json'));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function overridesFormatOf(tool: ToolKnowledge): Format | undefined {
  return extraFormat(tool, 'overrides');
}

/** A record fact of the tool's extra, or undefined when the knowledge base has none. */
function extraFormat(tool: ToolKnowledge, key: string): Format | undefined {
  const fact = tool.extra?.[key];
  const value = fact === undefined ? undefined : values(fact)[0];
  return isRecord(value) ? value : undefined;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]+:/iu;

/**
 * pip reads the files a requirements file includes with -r and -c too, relative to the including file, and their
 * global options apply to the whole install. For each requirements file of the trees under `roots`: every file of its
 * tree. An include that cannot be read (a URL, a missing file, a path outside the repository) is reported.
 */
function requirementsTrees(repository: Repository, roots: readonly string[], format: Format): Map<string, string[]> {
  const trees = new Map<string, string[]>();
  for (const root of roots) {
    const tree: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (tree.includes(file)) continue;
      tree.push(file);
      const text = repository.readText(file, MAX_LOCKFILE_SIZE);
      if (text === undefined) continue;
      const unreadable: string[] = [];
      for (const { path, line } of requirementsIncludes(text, format)) {
        const target = posix.normalize(posix.join(posix.dirname(file), path.replaceAll('\\', '/')));
        const reason = URL_LIKE.test(path)
          ? 'a URL'
          : isAbsoluteAnywhere(path) || target === '..' || target.startsWith('../')
            ? 'outside the repository'
            : repository.isFile(target)
              ? undefined
              : 'missing';
        if (reason === undefined) queue.push(target);
        else unreadable.push(`${path} (line ${line}, ${reason})`);
      }
      if (unreadable.length > 0) repository.warn('unreadable-include', `cannot read the files that ${file} includes: ${listing(unreadable)}`, [file]);
    }
    for (const file of tree) trees.set(file, [...new Set([...(trees.get(file) ?? []), ...tree])]);
  }
  return trees;
}

/** A tool's extra.lockfileFormat. */
function lockfileFormatOf(tool: ToolKnowledge | undefined): Format | undefined {
  const fact = tool?.extra?.['lockfileFormat'];
  const format = fact === undefined ? undefined : values(fact)[0];
  return isRecord(format) ? format : undefined;
}

/** pylock.toml and pylock.<name>.toml, which pip's knowledge names; detection gives one to the tool that wrote it. */
function isPylock(pip: ToolKnowledge | undefined, file: string): boolean {
  const lockfiles = pip?.project?.lockfiles;
  const names = lockfiles === undefined ? [] : values(lockfiles).flatMap((list) => list.flatMap((entry) => [...entry.value]));
  const pattern = pip?.extra?.['lockfilePattern'] === undefined ? undefined : values(pip.extra['lockfilePattern'])[0];
  return names.includes(file) || (typeof pattern === 'string' && new RegExp(pattern, 'u').test(file));
}

/**
 * The 1-based line of every entry, found in one pass in the order of the entries (the order of the file) the first
 * time a line is asked for, so that two rules asking for different entries get the same lines.
 */
function entryLines(text: string, start: number, entries: readonly LockEntry[]): (entry: LockEntry) => number | undefined {
  let lines: Map<LockEntry, number | undefined> | undefined;
  return (entry) => {
    if (entry.line !== undefined) return entry.line;
    if (lines === undefined) {
      const find = lineFinder(text, start);
      lines = new Map(entries.map((item) => [item, item.line ?? find(item.anchor)]));
    }
    return lines.has(entry) ? lines.get(entry) : lineFinder(text, start)(entry.anchor);
  };
}

/** Lockfiles already read in a doctor run (one Repository): both lockfile rules read the same ones. */
const READ = new WeakMap<Repository, Map<PackageManagerInfo, LockfileResult[]>>();

/** The lockfiles a package manager uses, each read and parsed once per Repository. */
export function readLockfiles(
  repository: Repository,
  manager: PackageManagerInfo,
  tool: ToolKnowledge,
  workspaces: readonly string[],
  tools: readonly ToolKnowledge[] = [],
): LockfileResult[] {
  let read = READ.get(repository);
  if (read === undefined) {
    read = new Map();
    READ.set(repository, read);
  }
  let results = read.get(manager);
  if (results === undefined) {
    results = parseLockfiles(repository, manager, tool, workspaces, tools);
    read.set(manager, results);
  }
  return results;
}

/** A pnpm-lock.yaml or a Yarn Berry yarn.lock, which are parsed as YAML. */
function isYamlLockfile(tool: ToolKnowledge, file: string): boolean {
  return (tool.id === 'pnpm' || tool.id === 'yarn') && /\.ya?ml$|(?:^|\/)yarn\.lock$/u.test(file);
}

function parseLockfiles(
  repository: Repository,
  manager: PackageManagerInfo,
  tool: ToolKnowledge,
  workspaces: readonly string[],
  tools: readonly ToolKnowledge[],
): LockfileResult[] {
  const format = lockfileFormatOf(tool);
  if (format === undefined) return [];
  const pip = tool.id === 'pip' ? tool : tools.find((entry) => entry.id === 'pip');
  const pylockFormat = lockfileFormatOf(pip);
  const lockfiles = manager.evidence.filter((item) => item.kind === 'lockfile').map((item) => item.file);
  // pip has no lockfile of its own beyond pylock.toml; its requirements files, and the files they include, say where
  // packages come from too.
  const requirements = tool.id === 'pip' ? requirementsTrees(repository, manager.configFiles, requirementsFormatOf(tool)) : new Map<string, string[]>();
  const files = [...new Set([...lockfiles, ...requirements.keys()])];
  return files.map((file): LockfileResult => {
    if (file.endsWith('.lockb')) return { ok: false, file, reason: 'it is a binary file in an undocumented format', unreadable: false };
    const text = repository.readText(file, MAX_LOCKFILE_SIZE);
    if (text === undefined) {
      if (!repository.warnings.some((warning) => warning.files.includes(file))) repository.warn('invalid-file', `cannot read ${file}`, [file]);
      return { ok: false, file, reason: 'it cannot be read', unreadable: true };
    }
    if (isYamlLockfile(tool, file) && Buffer.byteLength(text) > MAX_YAML_LOCKFILE_SIZE) {
      const limit = MAX_YAML_LOCKFILE_SIZE / (1024 * 1024);
      repository.warn(
        'lockfile-too-large',
        `${file} is larger than ${limit} MiB, the limit for YAML lockfiles (parsing a larger one needs more memory than a CI runner gives Node.js), and was not read`,
        [file],
      );
      return { ok: false, file, reason: 'it is too large', unreadable: true };
    }
    try {
      let entries: LockEntry[];
      let recordsScripts = format['installScripts'] !== null;
      let start = 0;
      if (tool.id === 'npm') entries = npmEntries(text, format, workspaces, readManifest(repository, file), overridesFormatOf(tool), extraFormat(tool, 'tarballIdentity'));
      else if (tool.id === 'pnpm') {
        // The layout of registry tarball URLs, as npm reads it (npm extra.tarballIdentity).
        const npmTool = tools.find((entry) => entry.id === 'npm');
        const identity = tool.extra?.['tarballResolution'] === undefined || npmTool === undefined ? undefined : extraFormat(npmTool, 'tarballIdentity');
        ({ entries, start } = pnpmEntries(text, format, documentsOf(tool), identity));
      }
      else if (tool.id === 'yarn') entries = yarnEntries(text, format, extraFormat(tool, 'registryFetch'));
      else if (tool.id === 'bun') entries = bunEntries(text, format);
      else if (pylockFormat !== undefined && lockfiles.includes(file) && isPylock(pip, file)) {
        entries = pylockEntries(text, pylockFormat, workspaces);
        recordsScripts = pylockFormat['installScripts'] !== null;
      } else if (tool.id === 'uv') entries = uvEntries(text, format, workspaces);
      else if (tool.id === 'poetry') entries = poetryEntries(text, format);
      else if (tool.id === 'pdm') entries = pdmEntries(text, format);
      else if (tool.id === 'pipenv') entries = pipfileLockEntries(text, format);
      else if (tool.id === 'pip') entries = requirementsEntries(text, requirementsFormatOf(tool));
      else if (tool.id === 'composer') entries = composerEntries(text, tool, declaredRepositories(repository, tool), composerManifest(repository));
      else ({ entries, recordsScripts } = denoEntries(text, format));
      const optionFiles = requirements.get(file);
      const isRequirements = tool.id === 'pip' && !(lockfiles.includes(file) && isPylock(pip, file));
      return {
        ok: true,
        lockfile: { file, entries, recordsScripts, lineOf: entryLines(text, start, entries), ...(optionFiles === undefined ? {} : { optionFiles }), ...(isRequirements ? { requirements: true as const } : {}) },
      };
    } catch (error) {
      if (error instanceof UnsupportedLockfile) return { ok: false, file, reason: error.message, unreadable: false };
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      repository.warn('invalid-file', `cannot parse ${file}: ${message}`, [file]);
      return { ok: false, file, reason: `it cannot be parsed (${message})`, unreadable: true };
    }
  });
}
