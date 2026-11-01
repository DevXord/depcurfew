// Where an install in a directory would get its packages from, as far as configuration files say (decision D-113).
//
// npm reads the user's ~/.npmrc and the .npmrc of its local prefix: the nearest directory from the current one up
// with a package.json or a node_modules directory, or the workspace root above it (extra.localPrefix of npm).
// depcurfew takes the registries and the dist-tag of that .npmrc only when the prefix is a directory of the policy:
// the directory of depcurfew.json or one of its projects (or, without a policy, the directory the check is about).
// Any other directory can hold an .npmrc that someone else wrote, and a registry named there could vouch for any
// package, so its settings are not used but reported (`unread`): the packages they apply to are not vouched for.
//
// Yarn, Bun and uv have registry settings of their own (extra.registrySettings), which depcurfew does not read at all;
// they are reported the same way for the packages those tools install.
//
// Every file is read as a regular file of at most 1 MiB: a FIFO, a device or a huge file in its place is skipped with
// a note, so that it can neither hang depcurfew nor exhaust its memory.
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { tomlValueAt, parseToml, type TomlValue } from '../detect/toml.ts';
import { wildcardMatch } from '../detect/wildcard.ts';
import { iniEntries } from '../doctor/settings.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { NpmLocalPrefixKnowledge, NpmVersionSelectionKnowledge, RegistryConfigKnowledge, RegistrySettingKnowledge, ToolId } from '../knowledge/types.ts';
import { isInside } from '../paths.ts';
import { withoutCredentials } from '../printable.ts';
import { readLimited } from '../read-limited.ts';
import { readYamlDocument } from '../yaml-parse.ts';
import { isMap, type Node } from 'yaml';

/** The largest configuration file depcurfew check reads. */
export const MAX_CONFIG_SIZE = 1024 * 1024;

/** A setting of a configuration file and where it is written, for messages: registry= in .npmrc, line 3. */
export interface WrittenSetting {
  value: string;
  where: string;
}

/** A registry setting that the install would use but depcurfew does not take, so the packages it applies to are not vouched for. */
export interface UnreadSetting {
  /** The tool whose configuration file it is (npm for .npmrc, which pnpm and Bun read too). */
  tool: ToolId;
  /** The file, as messages show it. */
  file: string;
  line: number;
  /** all: where every package comes from; scope: the registry of the packages of `scope`; tag: the dist-tag npm prefers. */
  applies: 'all' | 'scope' | 'tag';
  /** The scope with @. */
  scope?: string;
}

/** A configuration file that was not read, and why. */
export interface SkippedFile {
  file: string;
  reason: string;
}

export interface NpmrcSettings {
  /** The registry for all packages (registry=). */
  registry: WrittenSetting | undefined;
  /** Registries assigned to scopes (@scope:registry=). */
  scopes: Map<string, string>;
  /** The dist-tag npm prefers (tag=). */
  tag: WrittenSetting | undefined;
  unread: UnreadSetting[];
  skipped: SkippedFile[];
}

/** The text of a configuration file, undefined when there is none, or why it was skipped. */
export function readConfig(path: string): { text: string } | { skipped: string } | undefined {
  const result = readLimited(path, MAX_CONFIG_SIZE);
  if (result.ok) {
    const text = result.bytes.toString('utf8');
    return { text: text.startsWith('﻿') ? text.slice(1) : text };
  }
  if (result.problem === 'missing') return undefined;
  if (result.problem === 'not-a-file') return { skipped: 'it is not a regular file' };
  if (result.problem === 'too-large') return { skipped: `it is larger than ${MAX_CONFIG_SIZE / (1024 * 1024)} MiB` };
  if (result.problem === 'unreadable') return { skipped: `it cannot be read (${result.error.code ?? 'unknown error'})` };
  return { skipped: 'it is a symlink' };
}

function npmFacts(): { config: RegistryConfigKnowledge; prefix: NpmLocalPrefixKnowledge; tagKey: string | undefined } {
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  if (npm === undefined) throw new Error('the knowledge base has no npm');
  const config = extraOf(
    npm,
    'registryConfig',
    (value): value is RegistryConfigKnowledge =>
      isRecord(value) && typeof value['file'] === 'string' && typeof value['userFile'] === 'string' && typeof value['key'] === 'string' && typeof value['scopeKeySuffix'] === 'string',
  );
  const prefix = extraOf(npm, 'localPrefix', (value): value is NpmLocalPrefixKnowledge => isRecord(value) && isRecord(value['markers']) && typeof value['projectFile'] === 'string');
  const selection = npm.extra?.['versionSelection'] === undefined ? undefined : (values(npm.extra['versionSelection'])[0] as NpmVersionSelectionKnowledge | undefined);
  return { config, prefix, tagKey: selection?.tagKey };
}

/** The real path of a path, or the resolved path when it does not exist. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a workspace pattern (* within a directory, ** across directories) matches a relative directory. */
function matchesWorkspace(directory: readonly string[], pattern: readonly string[]): boolean {
  if (pattern.length === 0) return directory.length === 0;
  const [first, ...rest] = pattern;
  if (first === '**') return matchesWorkspace(directory, rest) || (directory.length > 0 && matchesWorkspace(directory.slice(1), pattern));
  return directory.length > 0 && wildcardMatch(directory[0] ?? '', first ?? '') && matchesWorkspace(directory.slice(1), rest);
}

/**
 * Whether the package.json of `root` lists `directory` as a workspace: an array of patterns or an object with them,
 * ! excluding, node_modules never (@npmcli/map-workspaces). Patterns depcurfew cannot read do not match, so a doubt
 * keeps the nearer directory as the prefix, whose .npmrc is then reported if it sets a registry.
 */
function listsWorkspace(root: string, directory: string, fact: NpmLocalPrefixKnowledge): boolean {
  const read = readConfig(join(root, fact.markers.file));
  if (read === undefined || !('text' in read)) return false;
  let manifest: unknown;
  try {
    manifest = JSON.parse(read.text);
  } catch {
    return false;
  }
  const declared = isRecord(manifest) ? manifest[fact.workspacesField] : undefined;
  const list = Array.isArray(declared) ? declared : isRecord(declared) && Array.isArray(declared[fact.workspacesObjectKey]) ? (declared[fact.workspacesObjectKey] as unknown[]) : [];
  const parts = relative(root, directory).split(sep);
  if (parts.length === 0 || parts[0] === '' || parts[0] === '..' || parts.includes('node_modules')) return false;
  let included = false;
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const bangs = /^!*/u.exec(entry)?.[0].length ?? 0;
    const pattern = entry.slice(bangs).replace(/^\.\//u, '').replace(/\/+$/u, '').split('/').filter((part) => part !== '' && part !== '.');
    if (pattern.length === 0 || pattern.includes('..') || !matchesWorkspace(parts, pattern)) continue;
    // An odd number of ! excludes, whatever the order of the patterns.
    if (bangs % 2 === 1) return false;
    included = true;
  }
  return included;
}

/**
 * npm's local prefix for a command run in `start`: the nearest directory with package.json or node_modules, or the
 * workspace root that lists it (then `workspace` is that nearer directory), else `start` (extra.localPrefix of npm).
 */
export function npmLocalPrefix(start: string): { prefix: string; workspace?: string } {
  const { prefix: fact } = npmFacts();
  const first = realPath(start);
  let found: string | undefined;
  for (let directory = first; ; directory = dirname(directory)) {
    const manifest = isFile(join(directory, fact.markers.file));
    if (found === undefined) {
      if (manifest || isDirectory(join(directory, fact.markers.directory))) found = directory;
    } else if (fact.workspaceRoot && manifest && isFile(join(found, fact.markers.file)) && listsWorkspace(directory, found, fact)) {
      return { prefix: directory, workspace: found };
    }
    if (dirname(directory) === directory) break;
  }
  return { prefix: found ?? first };
}

/** Where messages show a file: relative to `base` with / separators, like the policy file (../.npmrc above it). */
function shownFile(base: string, path: string): string {
  return relative(base, path).split(sep).join('/');
}

export interface NpmrcOptions {
  /** The directories whose .npmrc depcurfew takes: the policy's and its projects' (or the checked directory's). */
  trusted: readonly string[];
  /** The user's home directory, with ~/.npmrc. */
  home: string;
  /** The directory paths in messages are relative to. */
  base: string;
}

/**
 * What the .npmrc files npm reads for an install in `start` set: the registries and the dist-tag depcurfew uses, the
 * settings it does not take, and the files it could not read.
 */
export function npmrcSettings(start: string, options: NpmrcOptions): NpmrcSettings {
  const { config, tagKey } = npmFacts();
  const result: NpmrcSettings = { registry: undefined, scopes: new Map(), tag: undefined, unread: [], skipped: [] };
  const userPath = join(options.home, config.userFile.replace(/^~[/\\]/u, ''));
  const apply = (text: string, file: string) => {
    for (const { key, value, line } of iniEntries(text)) {
      const where = `${key}= in ${file}, line ${line}`;
      // A user name and password in a registry URL are neither sent (fetch refuses them anyway) nor shown.
      if (key === config.key) result.registry = { value: withoutCredentials(value), where };
      else if (tagKey !== undefined && key === tagKey) result.tag = { value, where };
      else if (key.startsWith('@') && key.endsWith(config.scopeKeySuffix)) result.scopes.set(key.slice(0, -config.scopeKeySuffix.length), withoutCredentials(value));
    }
  };
  const user = readConfig(userPath);
  if (user !== undefined) {
    if ('text' in user) apply(user.text, config.userFile);
    else result.skipped.push({ file: config.userFile, reason: user.skipped });
  }
  const base = realPath(options.base);
  const trusted = new Set(options.trusted.map(realPath));
  const realUser = realPath(userPath);
  const { prefix, workspace } = npmLocalPrefix(start);
  const unread = (directory: string) => {
    const path = join(directory, config.file);
    // npm does not read the user file a second time as the project's.
    if (realPath(path) === realUser) return;
    const read = readConfig(path);
    const file = shownFile(base, path);
    if (read === undefined) return;
    if (!('text' in read)) {
      result.skipped.push({ file, reason: read.skipped });
      return;
    }
    for (const { key, line } of iniEntries(read.text)) {
      if (key === config.key) result.unread.push({ tool: 'npm', file, line, applies: 'all' });
      else if (tagKey !== undefined && key === tagKey) result.unread.push({ tool: 'npm', file, line, applies: 'tag' });
      else if (key.startsWith('@') && key.endsWith(config.scopeKeySuffix)) result.unread.push({ tool: 'npm', file, line, applies: 'scope', scope: key.slice(0, -config.scopeKeySuffix.length) });
    }
  };
  if (trusted.has(prefix)) {
    const path = join(prefix, config.file);
    if (realPath(path) !== realUser) {
      const read = readConfig(path);
      const file = shownFile(base, path);
      if (read !== undefined && 'text' in read) apply(read.text, file);
      else if (read !== undefined) result.skipped.push({ file, reason: read.skipped });
    }
  } else {
    unread(prefix);
  }
  // npm skips the .npmrc of a workspace; if depcurfew took a directory for a workspace that is none, its settings count.
  if (workspace !== undefined && !trusted.has(workspace)) unread(workspace);
  return result;
}

/** The registry settings of a tool's own configuration files, from the knowledge base; empty for a tool without any. */
function registrySettingFacts(tool: ToolId): readonly RegistrySettingKnowledge[] {
  const fact = knowledgeBase.find((candidate) => candidate.id === tool)?.extra?.['registrySettings'];
  return fact === undefined ? [] : ((values(fact)[0] as readonly RegistrySettingKnowledge[] | undefined) ?? []);
}

/** Whether a tool has registry settings of its own that depcurfew does not read. */
export function hasRegistrySettings(tool: ToolId): boolean {
  return registrySettingFacts(tool).length > 0;
}

/** The scope a key of a scopes table names, with @. */
function scopeName(key: string): string {
  return key.startsWith('@') ? key : `@${key}`;
}

/** The places in a YAML file where `path` (with * for any key) is set, with the line of the last key. */
function yamlPlaces(text: string, path: readonly string[]): { line: number; key?: string }[] {
  const { document, lineCounter } = readYamlDocument(text);
  if (document.errors.length > 0) throw new Error('it is not valid YAML');
  const places: { line: number; key?: string }[] = [];
  const walk = (node: Node | null, index: number, key: string | undefined, offset: number) => {
    if (index === path.length) {
      if (node !== null) places.push({ line: lineCounter.linePos(offset).line, ...(key === undefined ? {} : { key }) });
      return;
    }
    if (node === null || !isMap(node)) return;
    for (const pair of node.items) {
      const name = String((pair.key as { value?: unknown } | null)?.value ?? '');
      const wanted = path[index];
      if (wanted !== '*' && name !== wanted) continue;
      walk(pair.value as Node | null, index + 1, wanted === '*' ? name : key, (pair.key as Node | null)?.range?.[0] ?? offset);
    }
  };
  walk(document.contents as Node | null, 0, undefined, 0);
  return places;
}

/** The places in a TOML file where `path` (with * for any key) is set; an array of tables counts by entry. */
function tomlPlaces(text: string, path: readonly string[], unlessTrue: string | undefined): { line: number; key?: string }[] {
  const document = parseToml(text);
  const places: { line: number; key?: string }[] = [];
  const walk = (prefix: (string | number)[], index: number, key: string | undefined) => {
    const value: TomlValue | undefined = prefix.length === 0 ? document.root : tomlValueAt(document, prefix as string[]);
    if (index === path.length) {
      if (value === undefined) return;
      if (Array.isArray(value) && unlessTrue !== undefined) {
        value.forEach((entry, position) => {
          if (isRecord(entry) && entry[unlessTrue] === true) return;
          places.push({ line: document.lineOf([...prefix, position]) ?? document.lineOf(prefix) ?? 1, ...(key === undefined ? {} : { key }) });
        });
        return;
      }
      places.push({ line: document.lineOf(prefix) ?? 1, ...(key === undefined ? {} : { key }) });
      return;
    }
    if (!isRecord(value)) return;
    const wanted = path[index] ?? '';
    for (const name of wanted === '*' ? Object.keys(value) : Object.hasOwn(value, wanted) ? [wanted] : []) walk([...prefix, name], index + 1, wanted === '*' ? name : key);
  };
  walk([], 0, undefined);
  return places;
}

/**
 * The registry settings of a tool's own configuration files in `start` and its parents up to `top` (only `start` when
 * it is not inside `top`), which depcurfew does not read; and the files it could not read or parse.
 */
export function toolRegistrySettings(tool: ToolId, start: string, top: string): { unread: UnreadSetting[]; skipped: SkippedFile[] } {
  const settings = registrySettingFacts(tool);
  const unread: UnreadSetting[] = [];
  const skipped: SkippedFile[] = [];
  if (settings.length === 0) return { unread, skipped };
  const first = realPath(start);
  const last = realPath(top);
  const files = [...new Set(settings.map((setting) => setting.file))];
  for (let directory = first; ; directory = dirname(directory)) {
    for (const name of files) {
      const path = join(directory, name);
      const file = shownFile(last, path);
      const read = readConfig(path);
      if (read === undefined) continue;
      if (!('text' in read)) {
        skipped.push({ file, reason: read.skipped });
        continue;
      }
      try {
        for (const setting of settings.filter((candidate) => candidate.file === name)) {
          const places = name.endsWith('.toml') ? tomlPlaces(read.text, setting.path, setting.unlessTrue) : yamlPlaces(read.text, setting.path);
          for (const place of places) {
            unread.push({ tool, file, line: place.line, applies: setting.applies, ...(setting.applies === 'scope' && place.key !== undefined ? { scope: scopeName(place.key) } : {}) });
          }
        }
      } catch {
        skipped.push({ file, reason: 'it cannot be parsed' });
      }
    }
    if (directory === last || !isInside(last, directory) || dirname(directory) === directory) break;
  }
  return { unread, skipped };
}
