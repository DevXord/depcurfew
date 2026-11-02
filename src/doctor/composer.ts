// Composer for doctor: the repositories of the root composer.json, where composer.lock says each package comes from,
// and the version that wrote composer.lock. Only the root composer.json declares repositories (dependencies' ones
// are ignored), so a package that does not come from Packagist or another Composer repository comes from one of them.
import { extraOf, isRecord } from '../apply/facts.ts';
import { compareVersions, parseVersion } from '../apply/version.ts';
import type { Repository } from '../detect/repository.ts';
import { matchSegment, wildcardMatch } from '../detect/wildcard.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
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

/** A repository URL as host and path, so that https://github.com/a/b, git@github.com:a/b.git and the like compare equal. */
export function normalizedUrl(url: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.*)$/u.exec(url);
  const text = scp === null ? url : `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  return text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
    .replace(/^[^/@]*@/u, '')
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '')
    .toLowerCase();
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
function hostOf(url: string): string {
  return normalizedUrl(url).split('/')[0] ?? '';
}

/**
 * The hosts the archives of a registry package come from (decision D-134): those of Composer's VCS drivers for the hosts
 * it knows by default (extra.registryDistHosts), and the hosts of the repositories composer.json declares.
 */
function registryHosts(tool: ToolKnowledge, repositories: readonly DeclaredRepository[]): Set<string> {
  const known = extraOf(tool, 'registryDistHosts', isStrings);
  return new Set([...known, ...repositories.flatMap((entry) => (entry.url === undefined || entry.kind === 'disable' ? [] : [hostOf(entry.url)]))]);
}

/** A value at a path of a JSON object. */
function valueAt(item: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), item);
}

/**
 * The packages of composer.lock with the source each comes from: a path repository (dist type path), an artifact
 * repository (an archive at a local path), a package repository of the root composer.json (by the names it defines),
 * a VCS repository of the root composer.json (by its URL), a VCS checkout when the entry has no dist (Composer then
 * installs from its source, decision D-134), else Packagist or another Composer repository; an archive from a host
 * that is neither one those registries use nor the host of a declared repository is a source depcurfew does not
 * recognize. Names are in lower case, as Composer reads them. Plugins are the packages whose code Composer runs: of
 * type composer-plugin or composer-installer, in any case.
 */
export function composerEntries(text: string, tool: ToolKnowledge, repositories: readonly DeclaredRepository[]): LockEntry[] {
  const format = extraOf(tool, 'lockfileFormat', isFormat);
  const branches = extraOf(tool, 'branchVersions', isBranches);
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error('composer.lock is not a JSON object');
  const vcs = new Map(repositories.filter((entry) => entry.kind === 'git' && entry.url !== undefined).map((entry) => [normalizedUrl(entry.url ?? ''), entry]));
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
      else if ([sourceUrl, distUrl].some((url) => url !== undefined && vcs.has(normalizedUrl(url)))) {
        kind = 'git';
        spec = describe(source) || spec;
      } else if (distUrl === undefined && sourceUrl !== undefined) {
        // Without a dist, Composer checks the package out of the repository its source names (extra.sourceInstall).
        kind = 'git';
        spec = describe(source);
      } else if (distUrl !== undefined && !isLocal(distUrl) && !hosts.has(hostOf(distUrl))) {
        kind = 'unknown';
      }
      // The version of a release, as Composer wrote it, for doctor --osv (decisions D-126 and D-134); a branch has none,
      // and a package from a host depcurfew does not know still names its release.
      const locked = item[format.version];
      const release =
        (kind === 'registry' || (kind === 'unknown' && fromInline === undefined)) && typeof locked === 'string' && locked !== '' && !locked.startsWith(branches.prefix) && !locked.endsWith(branches.suffix);
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
      });
    }
  }
  return entries;
}

/** The repositories of a kind the policy denies that no entry of composer.lock comes from, as far as depcurfew can tell. */
export function unmatchedRepositories(repositories: readonly DeclaredRepository[], entries: readonly LockEntry[]): DeclaredRepository[] {
  return repositories.filter((repository) => {
    if (repository.kind === 'git') return !entries.some((entry) => entry.source === 'git' && repository.url !== undefined && entry.spec.toLowerCase().includes(normalizedUrl(repository.url)));
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
