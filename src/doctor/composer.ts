// Composer for doctor: the repositories of the root composer.json, where composer.lock says each package comes from,
// and the version that wrote composer.lock. Only the root composer.json declares repositories (dependencies' ones
// are ignored), so a package that does not come from Packagist or another Composer repository comes from one of them.
import { extraOf, isRecord } from '../apply/facts.ts';
import { compareVersions, parseVersion } from '../apply/version.ts';
import type { Repository } from '../detect/repository.ts';
import { matchSegment, wildcardMatch } from '../detect/wildcard.ts';
import type { ComposerInstallPreferenceKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { COMPOSER_PREFIX, validatePackagePattern } from '../policy/package-pattern.ts';
import { jsonSetting } from './settings.ts';
import type { LockEntry, Source } from './lockfiles.ts';

export const COMPOSER_MANIFEST = 'composer.json';

export interface RepositoryTypes {
  vcs: string[];
  directory: string[];
  file: string[];
  inline: string[];
  registry: string[];
  disable: string;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const isRepositoryTypes = (value: unknown): value is RepositoryTypes =>
  isRecord(value) && isStrings(value['vcs']) && isStrings(value['directory']) && isStrings(value['file']) && isStrings(value['inline']) && typeof value['disable'] === 'string';

export function repositoryTypes(tool: ToolKnowledge): RepositoryTypes {
  return extraOf(tool, 'repositoryTypes', isRepositoryTypes);
}

/** A repository the root composer.json declares, with the source kind its packages have. */
export interface DeclaredRepository {
  /** Index in the list, or the key in the deprecated object form. */
  key: string | number;
  type: string;
  url: string | undefined;
  /** git: a VCS repository; remoteTarball: a package repository whose package downloads from a URL; registry: a Composer repository. */
  kind: Source | 'registry' | 'disable';
  /** The packages a package repository defines. */
  names: string[];
  line: number;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** The root composer.json, parsed once per run; undefined when it is missing or invalid (unreadable-config reports it). */
export function composerManifest(repository: Repository): Record<string, unknown> | undefined {
  if (!repository.isFile(COMPOSER_MANIFEST)) return undefined;
  const parsed = repository.parseOnce(COMPOSER_MANIFEST, parseJson);
  return isRecord(parsed) ? parsed : undefined;
}

/** The source kind of an inline package: its dist when it downloads from a URL, else its source (a VCS checkout). */
function inlineKind(definition: unknown): Source {
  const packages = Array.isArray(definition) ? definition : [definition];
  for (const item of packages) {
    if (!isRecord(item)) continue;
    const dist = item['dist'];
    if (isRecord(dist) && typeof dist['url'] === 'string') return /^https?:\/\//iu.test(dist['url']) ? 'remoteTarball' : 'file';
    if (isRecord(item['source'])) return 'git';
  }
  return 'unknown';
}

function inlineNames(definition: unknown): string[] {
  const packages = Array.isArray(definition) ? definition : [definition];
  return packages.flatMap((item) => (isRecord(item) && typeof item['name'] === 'string' ? [item['name'].toLowerCase()] : []));
}

/** The repositories of the root composer.json, in order; entries depcurfew cannot read are left out. */
export function declaredRepositories(repository: Repository, tool: ToolKnowledge): DeclaredRepository[] {
  const text = repository.readText(COMPOSER_MANIFEST);
  const manifest = composerManifest(repository);
  if (text === undefined || manifest === undefined) return [];
  const types = repositoryTypes(tool);
  const list = manifest['repositories'];
  const entries: [string | number, unknown][] = Array.isArray(list) ? list.map((item, index): [number, unknown] => [index, item]) : isRecord(list) ? Object.entries(list) : [];
  return entries.flatMap(([key, entry]): DeclaredRepository[] => {
    const line = jsonSetting(text, ['repositories', key])?.line ?? jsonSetting(text, ['repositories'])?.line ?? 1;
    if (!isRecord(entry)) return [];
    if (entry[types.disable] === false) return [{ key, type: types.disable, url: undefined, kind: 'disable', names: [], line }];
    const type = typeof entry['type'] === 'string' ? entry['type'].toLowerCase() : '';
    const url = typeof entry['url'] === 'string' ? entry['url'] : undefined;
    let kind: DeclaredRepository['kind'] = 'unknown';
    if (types.vcs.includes(type)) kind = 'git';
    else if (types.directory.includes(type)) kind = 'directory';
    else if (types.file.includes(type)) kind = 'file';
    else if (types.inline.includes(type)) kind = inlineKind(entry['package']);
    else if (types.registry.includes(type)) kind = 'registry';
    return [{ key, type, url, kind, names: types.inline.includes(type) ? inlineNames(entry['package']) : [], line }];
  });
}

/** The ports a URL leaves out for its scheme, as the WHATWG URL standard does (decision D-138). */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' };

/**
 * A repository URL as host and path, so that https://github.com/a/b, git@github.com:a/b.git and the like compare equal;
 * the default port of http and https is left out, as a URL leaves it out (https://github.com:443/a/b is github.com).
 */
export function normalizedUrl(url: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.*)$/u.exec(url);
  const scheme = scp === null ? /^([a-z][a-z0-9+.-]*):\/\//iu.exec(url)?.[1]?.toLowerCase() : undefined;
  const text = (scp === null ? url : `${scp[1] ?? ''}/${scp[2] ?? ''}`)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
    .replace(/^[^/@]*@/u, '')
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '')
    .toLowerCase();
  const port = scheme === undefined ? undefined : DEFAULT_PORTS[scheme];
  return port === undefined ? text : text.replace(new RegExp(`^([^/]*):${port}(?=/|$)`, 'u'), '$1');
}

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** Whether a dist URL is a file on this machine: no scheme (a path, also C:/…) or file://. */
function isLocal(url: string): boolean {
  return /^file:\/\//iu.test(url) || !REMOTE.test(url);
}

interface Format {
  sections: string[];
  name: string;
  version: string;
  installScripts: string;
  pluginType: string;
  /** The types Composer loads as plugins (composer-plugin, and the legacy composer-installer), compared in lower case. */
  pluginTypes: string[];
  /** Where a plugin declares that Composer may skip it without asking (extra.plugin-optional). */
  optionalPlugin: string[];
  source: string;
  dist: string;
  pathType: string;
  archiveTypes: string[];
}

const isFormat = (value: unknown): value is Format =>
  isRecord(value) &&
  isStrings(value['sections']) &&
  typeof value['name'] === 'string' &&
  typeof value['version'] === 'string' &&
  typeof value['pluginType'] === 'string' &&
  isStrings(value['pluginTypes']) &&
  isStrings(value['optionalPlugin']) &&
  typeof value['pathType'] === 'string';

const isBranches = (value: unknown): value is { prefix: string; suffix: string } => isRecord(value) && typeof value['prefix'] === 'string' && typeof value['suffix'] === 'string';

function describe(location: unknown): string {
  return isRecord(location) ? [location['type'], location['url']].filter((part) => typeof part === 'string').join(' ') : '';
}

/** The host of a URL (with its port), in lower case, as normalizedUrl gives it. */
export function hostOf(url: string): string {
  return normalizedUrl(url).split('/')[0] ?? '';
}

/**
 * The hosts the archives of a registry package come from (decision D-134): those of Composer's VCS drivers for the hosts
 * it knows by default (extra.registryDistHosts), and the hosts of the repositories composer.json declares.
 */
function registryHosts(tool: ToolKnowledge, repositories: readonly DeclaredRepository[]): Set<string> {
  const known = extraOf(tool, 'registryDistHosts', isStrings);
  const archives = repositoryArchiveHosts(tool);
  return new Set([
    ...known,
    ...repositories.flatMap((entry) => {
      if (entry.url === undefined || entry.kind === 'disable') return [];
      const host = hostOf(entry.url);
      // A Composer repository whose archives are on another host (extra.repositoryArchiveHosts, decision D-141).
      return [host, ...(entry.kind === 'registry' && Object.hasOwn(archives, host) ? (archives[host] ?? []) : [])];
    }),
  ]);
}

const isHostLists = (value: unknown): value is Record<string, string[]> => isRecord(value) && Object.values(value).every(isStrings);

/** The hosts of the archives of Composer repositories other than Packagist.org, by the host of the repository (decision D-141). */
export function repositoryArchiveHosts(tool: ToolKnowledge): Record<string, string[]> {
  return tool.extra?.['repositoryArchiveHosts'] === undefined ? {} : extraOf(tool, 'repositoryArchiveHosts', isHostLists);
}

const isHostNames = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((host) => typeof host === 'string');

/** The hosts a VCS driver reads as another one: www.github.com is github.com for GitHubDriver (extra.sourceHostAliases, decision D-138). */
function hostAliases(tool: ToolKnowledge): Record<string, string> {
  return tool.extra?.['sourceHostAliases'] === undefined ? {} : extraOf(tool, 'sourceHostAliases', isHostNames);
}

/**
 * A repository URL as Composer's VCS drivers compare it: normalizedUrl, with the host a driver reads as another one
 * replaced by that one (www.github.com/a/b is github.com/a/b), so that a VCS repository of composer.json and a source
 * of composer.lock that name the same repository compare equal (decision D-141).
 */
export function comparableUrl(tool: ToolKnowledge, url: string): string {
  const normalized = normalizedUrl(url);
  const [host = '', ...rest] = normalized.split('/');
  const aliases = hostAliases(tool);
  return Object.hasOwn(aliases, host) ? [aliases[host] ?? host, ...rest].join('/') : normalized;
}

/** A value at a path of a JSON object. */
function valueAt(item: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), item);
}

/**
 * The packages of composer.lock with the source each comes from: a path repository (dist type path), an artifact
 * repository (an archive at a local path), a package repository of the root composer.json (by the names it defines),
 * a VCS repository of the root composer.json (by its URL), a VCS checkout when the entry has no dist or a dist without
 * a type (Composer then installs from its source, decision D-134) or when config.preferred-install of composer.json
 * makes Composer check it out (decision D-136), else Packagist or another Composer repository; an archive from a host
 * that is neither one those registries use nor the host of a declared repository is a source depcurfew does not
 * recognize, and an archive of Packagist.org's hosts next to a source on another host is noted on the entry. Names are in lower case, as Composer reads them. Plugins are the packages whose code Composer runs: of
 * type composer-plugin or composer-installer, in any case.
 */
export function composerEntries(text: string, tool: ToolKnowledge, repositories: readonly DeclaredRepository[], manifest?: Record<string, unknown>): LockEntry[] {
  const format = extraOf(tool, 'lockfileFormat', isFormat);
  const branches = extraOf(tool, 'branchVersions', isBranches);
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error('composer.lock is not a JSON object');
  const vcs = new Map(repositories.filter((entry) => entry.kind === 'git' && entry.url !== undefined).map((entry) => [comparableUrl(tool, entry.url ?? ''), entry]));
  const inline = repositories.filter((entry) => entry.names.length > 0);
  const hosts = registryHosts(tool, repositories);
  const pluginTypes = new Set(format.pluginTypes.map((type) => type.toLowerCase()));
  const entries: LockEntry[] = [];
  for (const section of format.sections) {
    const packages = document[section];
    if (!Array.isArray(packages)) continue;
    for (const item of packages) {
      if (!isRecord(item) || typeof item[format.name] !== 'string') continue;
      const written = item[format.name] as string;
      const name = written.toLowerCase();
      const dist = isRecord(item[format.dist]) ? (item[format.dist] as Record<string, unknown>) : undefined;
      const source = isRecord(item[format.source]) ? (item[format.source] as Record<string, unknown>) : undefined;
      const distUrl = typeof dist?.['url'] === 'string' ? dist['url'] : undefined;
      const sourceUrl = typeof source?.['url'] === 'string' ? source['url'] : undefined;
      let kind: Source = 'registry';
      let spec = describe(dist) || describe(source);
      const fromInline = inline.find((entry) => entry.names.includes(name));
      if (dist?.['type'] === format.pathType) kind = 'directory';
      else if (distUrl !== undefined && isLocal(distUrl) && format.archiveTypes.includes(String(dist?.['type']))) kind = 'file';
      else if (fromInline !== undefined) kind = fromInline.kind === 'registry' || fromInline.kind === 'disable' ? 'unknown' : fromInline.kind;
      // getAvailableSources offers a source or a dist only when it has a type (a value PHP takes for true).
      const offered = (location: Record<string, unknown> | undefined) => location !== undefined && typeof location['type'] === 'string' && location['type'] !== '' && location['type'] !== '0';
      const locked = item[format.version];
      const dev = typeof locked === 'string' && (locked.startsWith(branches.prefix) || locked.endsWith(branches.suffix));
      let why: string | undefined;
      let preference: LockEntry['preferredInstall'];
      let otherSource: LockEntry['otherSource'];
      // A release of a Composer repository that Composer checks out of its VCS source (no usable dist, or
      // config.preferred-install), which doctor --osv still looks up (decision D-141).
      let checkedOutRelease = false;
      if (kind === 'registry' && [sourceUrl, distUrl].some((url) => url !== undefined && vcs.has(comparableUrl(tool, url)))) {
        kind = 'git';
        spec = describe(source) || spec;
      } else if (kind === 'registry' && sourceUrl !== undefined && (distUrl === undefined || !offered(dist))) {
        // Without a dist, Composer checks the package out of the repository its source names (extra.sourceInstall).
        kind = 'git';
        checkedOutRelease = true;
        spec = describe(source);
        if (dist !== undefined) why = 'its dist has no type, so Composer cannot download its archive';
      } else if (kind === 'registry' && sourceUrl !== undefined && offered(source) && (preference = sourcePreference(manifest, tool, name, dev)) !== undefined) {
        // config.preferred-install makes Composer check it out instead of downloading the archive (decision D-136).
        kind = 'git';
        checkedOutRelease = true;
        spec = describe(source);
        why = preference.why;
      } else if (kind === 'registry' && distUrl !== undefined && !isLocal(distUrl) && !hosts.has(hostOf(distUrl))) {
        kind = 'unknown';
      } else if (kind === 'registry' && distUrl !== undefined && sourceUrl !== undefined && offered(source)) {
        otherSource = sourceElsewhere(tool, distUrl, sourceUrl, describe(source));
      }
      // The version of a release, as Composer wrote it, for doctor --osv (decisions D-126, D-134 and D-141); a branch has
      // none, and a package from a host depcurfew does not know or one Composer checks out of its source still names its release.
      const release =
        (kind === 'registry' || checkedOutRelease || (kind === 'unknown' && fromInline === undefined)) &&
        typeof locked === 'string' &&
        locked !== '' &&
        !locked.startsWith(branches.prefix) &&
        !locked.endsWith(branches.suffix);
      const type = item[format.installScripts];
      const plugin = typeof type === 'string' && pluginTypes.has(type.toLowerCase());
      entries.push({
        name,
        spec,
        source: kind,
        installScript: plugin,
        anchor: `"${format.name}": ${JSON.stringify(written)}`,
        ...(release ? { version: locked } : {}),
        ...(plugin && valueAt(item, format.optionalPlugin) === true ? { optional: true as const } : {}),
        ...(kind === 'git' && why !== undefined ? { why } : {}),
        ...(kind === 'git' && preference !== undefined ? { preferredInstall: preference } : {}),
        ...(otherSource === undefined ? {} : { otherSource }),
      });
    }
  }
  return entries;
}

const isPreference = (value: unknown): value is ComposerInstallPreferenceKnowledge =>
  isRecord(value) && ['setting', 'default', 'dist', 'source', 'auto', 'everything'].every((key) => typeof value[key] === 'string');

/**
 * Why Composer installs a locked package that has both an archive and a source from the source, by config.preferred-install
 * of the root composer.json (extra.installPreference, decision D-136), with the entry of the setting that decides it
 * (decision D-138); undefined when it downloads the archive. A string "source" always, "dist" never, "auto" and any
 * other string for a dev version (preferDist and preferSource both off); an object by its first key that matches the
 * name, in any case and with * for any characters, "*" last and "dist" when the object has no "*": "dist" never,
 * "auto" for a dev version, any other value always.
 */
function sourcePreference(manifest: Record<string, unknown> | undefined, tool: ToolKnowledge, name: string, dev: boolean): LockEntry['preferredInstall'] {
  if (tool.extra?.['installPreference'] === undefined) return undefined;
  const fact = extraOf(tool, 'installPreference', isPreference);
  const config = manifest?.['config'];
  const setting = isRecord(config) ? config[fact.setting] : undefined;
  const where = `config.${fact.setting} in ${COMPOSER_MANIFEST}`;
  const forDev = (text: string) => (dev ? `${text}, which installs dev versions from their source` : undefined);
  // `cause` without the setting and its file, so that init can name the file of a project and the line (decision D-141).
  const found = (value: string, cause: string | undefined, key?: string) => (cause === undefined ? undefined : { ...(key === undefined ? {} : { key }), value, why: `${where} ${cause}`, cause });
  if (typeof setting === 'string') {
    if (setting === fact.source) return found(setting, `is "${setting}"`);
    if (setting === fact.dist) return undefined;
    return found(setting, forDev(`is ${JSON.stringify(setting)}`));
  }
  if (!isRecord(setting)) return undefined;
  const keys = [...Object.keys(setting).filter((key) => key !== fact.everything), fact.everything];
  for (const key of keys) {
    if (!pluginPatternMatches(name, key)) continue;
    // A name that no key matches gets "dist" (the default), so only a key written out gives another value.
    const preference = Object.hasOwn(setting, key) ? setting[key] : fact.default;
    if (preference === fact.dist) return undefined;
    const given = `gives ${JSON.stringify(preference)} for ${key}`;
    return found(typeof preference === 'string' ? preference : JSON.stringify(preference), preference === fact.auto ? forDev(given) : given, key);
  }
  return undefined;
}

/** The packages of composer.lock that one entry of config.preferred-install makes Composer check out (decision D-138). */
export interface Checkouts {
  preference: NonNullable<LockEntry['preferredInstall']>;
  entries: LockEntry[];
}

/** The entries of composer.lock checked out because of config.preferred-install, by its entry, in the order of the lockfile. */
export function checkoutsByPreference(entries: readonly LockEntry[]): Checkouts[] {
  const groups = new Map<string, Checkouts>();
  for (const entry of entries) {
    if (entry.source !== 'git' || entry.preferredInstall === undefined) continue;
    const key = entry.preferredInstall.key ?? '';
    const group = groups.get(key) ?? { preference: entry.preferredInstall, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The line in composer.json of the entry of config.preferred-install, when it can be found. */
export function preferenceLine(text: string | undefined, preference: Checkouts['preference']): number | undefined {
  if (text === undefined) return undefined;
  return jsonSetting(text, ['config', 'preferred-install', ...(preference.key === undefined ? [] : [preference.key])])?.line;
}

/** The packages of a group as a message lists them: the first `most` with their line in the lockfile, the rest counted. */
export function listedCheckouts(entries: readonly LockEntry[], lineOf: (entry: LockEntry) => number | undefined, most = 10): string {
  const shown = entries.slice(0, most).map((entry) => {
    const line = lineOf(entry);
    return line === undefined ? entry.name : `${entry.name} (line ${line})`;
  });
  return `${shown.join(', ')}${entries.length > most ? ` and ${entries.length - most} more` : ''}`;
}

/** How a message says that Composer checks the packages out: "1 package of composer.lock from its VCS repository instead of its archive". */
export function checkedOut(count: number, file: string): string {
  return count === 1 ? `1 package of ${file} from its VCS repository instead of its archive` : `${count} packages of ${file} from their VCS repositories instead of their archives`;
}

/** What to change in composer.json (`manifest`, as a message names it) so that Composer takes the archives again. */
export function preferenceChange(preference: Checkouts['preference'], manifest = COMPOSER_MANIFEST): string {
  const setting = `config.preferred-install in ${manifest}`;
  return preference.key === undefined
    ? `Set ${setting} to "dist", or remove it, so Composer installs packages from their archives`
    : `Remove ${JSON.stringify(preference.key)} from ${setting}, or set it to "dist", so Composer installs these packages from their archives`;
}

/**
 * An archive from a host of registryDistHosts next to a source on another host than the one the VCS driver of that
 * archive gives (extra.registrySourceHosts, decision D-136): Packagist.org never writes such an entry.
 */
function sourceElsewhere(tool: ToolKnowledge, distUrl: string, sourceUrl: string, spec: string): LockEntry['otherSource'] {
  if (tool.extra?.['registrySourceHosts'] === undefined) return undefined;
  const hosts = extraOf(tool, 'registrySourceHosts', isHostNames);
  // The hosts a VCS driver reads as another one: www.github.com is github.com for GitHubDriver (decision D-138).
  const same = hostAliases(tool);
  const distHost = hostOf(distUrl);
  const expected = Object.hasOwn(hosts, distHost) ? hosts[distHost] : undefined;
  const sourceHost = hostOf(sourceUrl);
  const read = Object.hasOwn(same, sourceHost) ? same[sourceHost] : sourceHost;
  return expected === undefined || read === expected ? undefined : { spec, distHost, sourceHost };
}

/** The host of the source the VCS driver gives a package whose archive is on `distHost` (extra.registrySourceHosts). */
export function sourceHostOf(tool: ToolKnowledge, distHost: string): string {
  const hosts = tool.extra?.['registrySourceHosts'] === undefined ? {} : extraOf(tool, 'registrySourceHosts', isRecord);
  const host = hosts[distHost];
  return typeof host === 'string' ? host : distHost;
}

/** The first Composer that no longer falls back from an archive to its source by default (extra.sourceFallback). */
export function fallbackRemoved(tool: ToolKnowledge): string {
  const fact = tool.extra?.['sourceFallback'] === undefined ? undefined : extraOf(tool, 'sourceFallback', isRecord);
  return typeof fact?.['since'] === 'string' ? fact['since'] : '2.10.0';
}

/**
 * The repositories of a kind the policy denies that no entry of composer.lock comes from, as far as depcurfew can tell;
 * a VCS repository matches an entry whose source names it, as Composer's drivers compare URLs (comparableUrl).
 */
export function unmatchedRepositories(tool: ToolKnowledge, repositories: readonly DeclaredRepository[], entries: readonly LockEntry[]): DeclaredRepository[] {
  return repositories.filter((repository) => {
    if (repository.kind === 'git') {
      if (repository.url === undefined) return true;
      const wanted = comparableUrl(tool, repository.url);
      return !entries.some((entry) => entry.source === 'git' && (entry.spec.toLowerCase().includes(normalizedUrl(repository.url ?? '')) || entry.spec.split(/\s+/u).some((word) => word !== '' && comparableUrl(tool, word) === wanted)));
    }
    if (repository.names.length > 0) return !entries.some((entry) => repository.names.includes(entry.name.toLowerCase()));
    if (repository.kind === 'directory' || repository.kind === 'file') return !entries.some((entry) => entry.source === repository.kind);
    return false;
  });
}

/** Whether a key of allow-plugins covers a package: * stands for any characters, case is ignored (BasePackage::packageNameToRegexp). */
export function pluginPatternMatches(name: string, pattern: string): boolean {
  return matchSegment(name.toLowerCase(), pattern.toLowerCase());
}

/**
 * Whether a key of allow-plugins or of cooldown.ignore matches every vendor/name package: only * with at most one /
 * between them ("*", "*\/*"), since Composer's * matches / too (extra.allowAllPlugins).
 */
export function matchesEveryComposerName(key: string): boolean {
  return /^\*+(?:\/\*+)?$/u.test(key);
}

/**
 * Whether a key Composer reads as a name pattern (allow-plugins, cooldown.ignore) says no more than the policy's
 * patterns: a name, in any case, that one of them matches, or a pattern depcurfew apply wrote, which is one of them.
 */
export function keyCoveredBy(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  if (lower.includes('*')) return patterns.includes(lower);
  return patterns.some((pattern) => wildcardMatch(lower, pattern));
}

/** The key as depcurfew.json writes it (composer:vendor/name in lower case), or undefined when the policy cannot name it. */
export function composerPolicyName(key: string): string | undefined {
  const name = `${COMPOSER_PREFIX}${key.toLowerCase()}`;
  return validatePackagePattern(name) === undefined ? name : undefined;
}

/** Whether a name from composer.lock is a Composer package name (lowercase vendor/name, no pattern), which a fix may quote. */
export function isComposerName(name: string): boolean {
  return !name.includes('*') && composerPolicyName(name) === `${COMPOSER_PREFIX}${name}`;
}

/** What config.allow-plugins decides for a plugin; `legacy`: composer.lock is older than allow-plugins (see pluginDecision). */
export interface PluginDecision {
  allowed: boolean | undefined;
  key?: string;
  legacy?: { pluginApi: string | undefined; below: string; allowsAllUntil: string };
}

const isLegacyFact = (value: unknown): value is { below: string; missing: string; allowsAllUntil: string } =>
  isRecord(value) && typeof value['below'] === 'string' && typeof value['missing'] === 'string' && typeof value['allowsAllUntil'] === 'string';

/**
 * What config.allow-plugins of composer.json decides for a plugin: true (allowed), false (blocked) or undefined (not
 * listed, so Composer asks, or fails without a terminal), with the key that decides. Composer takes the first key that
 * matches; true for the whole setting allows every plugin and false none. With `lock` (the plugin-api-version of
 * composer.lock, undefined when it has none), an empty or missing allow-plugins next to a composer.lock older than
 * allow-plugins lets Composer 2.2 to 2.9 load every plugin without asking (extra.legacyLockPlugins): the plugin counts
 * as allowed, with `legacy`.
 */
export function pluginDecision(manifest: Record<string, unknown> | undefined, name: string, lock?: { tool: ToolKnowledge; pluginApi: string | undefined }): PluginDecision {
  const config = manifest?.['config'];
  const setting = isRecord(config) ? config['allow-plugins'] : undefined;
  if (setting === true || setting === false) return { allowed: setting };
  const empty = setting === undefined || (Array.isArray(setting) && setting.length === 0) || (isRecord(setting) && Object.keys(setting).length === 0);
  if (empty && lock !== undefined) {
    const fact = extraOf(lock.tool, 'legacyLockPlugins', isLegacyFact);
    const api = parseVersion(lock.pluginApi ?? fact.missing);
    const below = parseVersion(fact.below);
    // A plugin-api-version depcurfew cannot read counts as an old one.
    if (below !== undefined && (api === undefined || compareVersions(api, below) < 0)) {
      return { allowed: true, legacy: { pluginApi: lock.pluginApi, below: fact.below, allowsAllUntil: fact.allowsAllUntil } };
    }
  }
  if (!isRecord(setting)) return { allowed: undefined };
  const key = Object.keys(setting).find((pattern) => pluginPatternMatches(name, pattern));
  return key === undefined ? { allowed: undefined } : { allowed: setting[key] === true, key };
}

/** An entry of config.policy.cooldown.ignore: a name of the list, or a key of the object with its value. */
export interface IgnoreEntry {
  key: string;
  line: number | undefined;
  /** The value of an object entry (a reason, a rule or a list of rules); absent in the list form. */
  value?: unknown;
}

/** The entries of the ignore setting at `path` in a composer.json text; none when it is neither a list nor an object. */
export function ignoreEntries(text: string | undefined, path: readonly string[]): IgnoreEntry[] {
  if (text === undefined) return [];
  const found = jsonSetting(text, path);
  const value = found?.value;
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => (typeof item === 'string' ? [{ key: item, line: jsonSetting(text, [...path, index])?.line ?? found?.line }] : []));
  }
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => ({ key, value: item, line: jsonSetting(text, [...path, key])?.line ?? found?.line }));
  return [];
}

/**
 * The ignore entries of `now` that exempt a package from the cooldown although cooldown.exclude does not, and that are
 * still there in `planned` (the file as depcurfew apply leaves it, which removes only the entries it wrote). Keys that
 * match every package are left to broad-exclusion.
 */
export function ignoreOutsidePolicy(now: string | undefined, planned: string | undefined, path: readonly string[], patterns: readonly string[]): IgnoreEntry[] {
  const kept = new Set(ignoreEntries(planned, path).map((entry) => entry.key));
  return ignoreEntries(now, path).filter((entry) => kept.has(entry.key) && !matchesEveryComposerName(entry.key) && !keyCoveredBy(entry.key, patterns));
}

/**
 * What is wrong with such an entry and what to do, the same in apply (exclude-entry-outside-policy) and doctor
 * (config-drift). `line` puts the line into the message, for apply's text; `relock` is the command that writes the new
 * content-hash of composer.lock.
 */
export function ignoreOutsideText(entry: IgnoreEntry, where: { setting: string; file: string; policyFile: string; relock: string }, line = false): { message: string; fix: string } {
  const at = line && entry.line !== undefined ? ` (line ${entry.line})` : '';
  const name = composerPolicyName(entry.key);
  return {
    message: `${where.setting} in ${where.file}${at} lists ${entry.key}, which Composer exempts from the release-age delay, but cooldown.exclude in ${where.policyFile} does not exclude it`,
    fix: `Remove ${JSON.stringify(entry.key)} from ${where.setting} in ${where.file} and run ${where.relock}${name === undefined ? '' : `, or add ${name} to cooldown.exclude in ${where.policyFile}`}`,
  };
}

export interface LockedApi {
  file: string;
  version: string;
  line: number | undefined;
}

/** plugin-api-version of composer.lock: the plugin API of the Composer that wrote it. */
export function lockedPluginApi(repository: Repository, tool: ToolKnowledge, lockfile: string): LockedApi | undefined {
  const fact = extraOf(tool, 'pluginApiVersion', (value): value is { key: string } => isRecord(value) && typeof value['key'] === 'string');
  // The limit of lockfiles (MAX_LOCKFILE_SIZE in lockfiles.ts, which imports this module).
  const text = repository.readText(lockfile, 64 * 1024 * 1024);
  if (text === undefined) return undefined;
  const found = jsonSetting(text, [fact.key]);
  return typeof found?.value === 'string' ? { file: lockfile, version: found.value, line: found.line } : undefined;
}
