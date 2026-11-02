// Composer for doctor: the repositories of the root composer.json, where composer.lock says each package comes from,
// and the version that wrote composer.lock. Only the root composer.json declares repositories (dependencies' ones
// are ignored), so a package that does not come from Packagist or another Composer repository comes from one of them.
import { extraOf, isRecord } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import { matchSegment } from '../detect/wildcard.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
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
  typeof value['pathType'] === 'string';

const isBranches = (value: unknown): value is { prefix: string; suffix: string } => isRecord(value) && typeof value['prefix'] === 'string' && typeof value['suffix'] === 'string';

function describe(location: unknown): string {
  return isRecord(location) ? [location['type'], location['url']].filter((part) => typeof part === 'string').join(' ') : '';
}

/**
 * The packages of composer.lock with the source each comes from: a path repository (dist type path), an artifact
 * repository (an archive at a local path), a package repository of the root composer.json (by the names it defines),
 * a VCS repository of the root composer.json (by its URL), else Packagist or another Composer repository. Plugins
 * (type composer-plugin) are the packages whose code Composer runs.
 */
export function composerEntries(text: string, tool: ToolKnowledge, repositories: readonly DeclaredRepository[]): LockEntry[] {
  const format = extraOf(tool, 'lockfileFormat', isFormat);
  const branches = extraOf(tool, 'branchVersions', isBranches);
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error('composer.lock is not a JSON object');
  const vcs = new Map(repositories.filter((entry) => entry.kind === 'git' && entry.url !== undefined).map((entry) => [normalizedUrl(entry.url ?? ''), entry]));
  const inline = repositories.filter((entry) => entry.names.length > 0);
  const entries: LockEntry[] = [];
  for (const section of format.sections) {
    const packages = document[section];
    if (!Array.isArray(packages)) continue;
    for (const item of packages) {
      if (!isRecord(item) || typeof item[format.name] !== 'string') continue;
      const name = item[format.name] as string;
      const dist = isRecord(item[format.dist]) ? (item[format.dist] as Record<string, unknown>) : undefined;
      const source = isRecord(item[format.source]) ? (item[format.source] as Record<string, unknown>) : undefined;
      const distUrl = typeof dist?.['url'] === 'string' ? dist['url'] : undefined;
      const sourceUrl = typeof source?.['url'] === 'string' ? source['url'] : undefined;
      let kind: Source = 'registry';
      let spec = describe(dist) || describe(source);
      const fromInline = inline.find((entry) => entry.names.includes(name.toLowerCase()));
      if (dist?.['type'] === format.pathType) kind = 'directory';
      else if (distUrl !== undefined && isLocal(distUrl) && format.archiveTypes.includes(String(dist?.['type']))) kind = 'file';
      else if (fromInline !== undefined) kind = fromInline.kind === 'registry' || fromInline.kind === 'disable' ? 'unknown' : fromInline.kind;
      else if ([sourceUrl, distUrl].some((url) => url !== undefined && vcs.has(normalizedUrl(url)))) {
        kind = 'git';
        spec = describe(source) || spec;
      }
      // The version of a release, as Composer wrote it, for doctor --osv (decision D-126); a branch has none.
      const locked = item[format.version];
      const release = kind === 'registry' && typeof locked === 'string' && locked !== '' && !locked.startsWith(branches.prefix) && !locked.endsWith(branches.suffix);
      entries.push({ name, spec, source: kind, installScript: item[format.installScripts] === format.pluginType, anchor: `"${format.name}": ${JSON.stringify(name)}`, ...(release ? { version: locked } : {}) });
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
 * What config.allow-plugins of composer.json decides for a plugin: true (allowed), false (blocked) or undefined (not
 * listed, so Composer asks, or fails without a terminal), with the key that decides. Composer takes the first key that
 * matches; true for the whole setting allows every plugin and false none.
 */
export function pluginDecision(manifest: Record<string, unknown> | undefined, name: string): { allowed: boolean | undefined; key?: string } {
  const config = manifest?.['config'];
  const setting = isRecord(config) ? config['allow-plugins'] : undefined;
  if (setting === true || setting === false) return { allowed: setting };
  if (!isRecord(setting)) return { allowed: undefined };
  const key = Object.keys(setting).find((pattern) => pluginPatternMatches(name, pattern));
  return key === undefined ? { allowed: undefined } : { allowed: setting[key] === true, key };
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
