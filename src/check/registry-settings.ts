// Where an install in a directory would get its packages from, as far as configuration files say (decision D-113).
//
// npm reads the user's ~/.npmrc and the .npmrc of its local prefix: the nearest directory from the current one up
// with a package.json or a node_modules directory, or the workspace root above it (extra.localPrefix of npm).
// depcurfew takes the registries and the dist-tag of that .npmrc only when the prefix is a directory of the policy:
// the directory of depcurfew.json or one of its projects (or, without a policy, the directory the check is about).
// Any other directory can hold an .npmrc that someone else wrote, and a registry named there could vouch for any
// package, so its settings are not used but reported (`unread`): the packages they apply to are not vouched for.
//
// Yarn, Bun, uv, Poetry, PDM and Pipenv have registry or index settings of their own (extra.registrySettings), which
// depcurfew does not read at all; they are reported the same way for the packages those tools install. An index that
// serves only the packages pinned to it (uv's explicit index, Poetry's explicit source, a Pipfile source other than
// the first) is reported for those packages (decision D-120).
//
// Every file is read as a regular file of at most 1 MiB: a FIFO, a device or a huge file in its place is skipped with
// a note, so that it can neither hang depcurfew nor exhaust its memory. Workspace patterns are matched with a limit on
// their number, their length and the steps matching takes, so that a package.json cannot make it take minutes.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { extraOf, isRecord, values } from '../apply/facts.ts';
import { tomlValueAt, parseToml, type TomlDocument, type TomlValue } from '../detect/toml.ts';
import { matchSegment, OutOfSteps, spendSteps, type StepBudget } from '../detect/wildcard.ts';
import { iniEntries } from '../doctor/settings.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type {
  CommandLineParsing,
  IndexEntriesKnowledge,
  IndexEntryEffect,
  NpmLocalPrefixKnowledge,
  NpmVersionSelectionKnowledge,
  RegistryConfigKnowledge,
  RegistrySettingKnowledge,
  ToolId,
} from '../knowledge/types.ts';
import { isInside } from '../paths.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { withoutCredentials } from '../printable.ts';
import { readLimited } from '../read-limited.ts';
import { readYamlDocument } from '../yaml-parse.ts';
import { defaultIndex } from './pypi.ts';
import { isMap, isScalar, type Node } from 'yaml';

/** The largest configuration file depcurfew check reads. */
export const MAX_CONFIG_SIZE = 1024 * 1024;

/**
 * The most workspace patterns of one package.json depcurfew matches, the longest pattern, and the most steps matching
 * them against one directory takes (decision D-120). Real projects list a few patterns of a few dozen characters; a
 * package.json beyond any of these limits is not matched, and depcurfew says so.
 */
export const MAX_WORKSPACE_PATTERNS = 1000;
export const MAX_WORKSPACE_PATTERN_LENGTH = 1000;
export const MAX_WORKSPACE_STEPS = 2_000_000;

/** A setting of a configuration file and where it is written, for messages: registry= in .npmrc, line 3. */
export interface WrittenSetting {
  value: string;
  where: string;
  /** The file and line, as messages show them (decision D-118: the location of a notice). */
  file?: string;
  line?: number;
}

/** A registry setting that the install would use but depcurfew does not take, so the packages it applies to are not vouched for. */
export interface UnreadSetting {
  /** The tool whose configuration file it is (npm for .npmrc, which pnpm and Bun read too). */
  tool: ToolId;
  /** The file, as messages show it. */
  file: string;
  line: number;
  /**
   * all: where every package comes from; scope: the registry of the packages of `scope`; tag: the dist-tag npm prefers;
   * package: the index of the one Python package `package`, which `pin` pins to it (decision D-120).
   */
  applies: 'all' | 'scope' | 'tag' | 'package';
  /** The scope with @. */
  scope?: string;
  /** The Python package, normalized and without pypi:. */
  package?: string;
  /** Where the package is pinned to the index. */
  pin?: { file: string; line: number };
  /** replaces: the registry, index or dist-tag used instead of the one depcurfew used; adds: another place to install from. */
  effect: 'replaces' | 'adds';
  /** The URL (without credentials) or dist-tag it sets; undefined when depcurfew cannot read it (a variable, another type). */
  value?: string;
  /**
   * The .npmrc of a workspace package that npm skips, as depcurfew matched the workspace exactly as npm does (decision
   * D-124): it counts for pnpm and Bun, which read .npmrc by rules of their own, and for npm only when its command line
   * may turn workspaces off (CheckRequest.workspacesOption).
   */
  skippedByNpm?: true;
}

/**
 * A registry URL as it is compared: scheme and host in lower case, without user name, password and trailing slashes.
 * undefined for a value that is not an http:// or https:// URL, or that holds a variable ($NAME, ${NAME}), which the
 * tool may expand to anything.
 */
export function registryKey(value: string): string | undefined {
  const text = value.trim();
  if (text.includes('$')) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, '')}${url.search}`;
}

/** Whether two registry URLs name the same registry (registryKey). */
export function sameRegistry(a: string, b: string): boolean {
  const left = registryKey(a);
  return left !== undefined && left === registryKey(b);
}

/** The value of a setting as a URL without credentials, when it is one depcurfew can read. */
function urlValue(value: string): string | undefined {
  return registryKey(value) === undefined ? undefined : withoutCredentials(value.trim());
}

/** A configuration file that was not read, and why. */
export interface SkippedFile {
  file: string;
  reason: string;
  /** The whole notice, when only a part of the file was not used (the workspaces of a package.json, decision D-120). */
  notice?: string;
  /** What a person and an agent can do about it, when it is not to make the file one that depcurfew can read. */
  fix?: string;
  agentFix?: string;
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

let workspacesNames: { name: string; shorthands: readonly string[] } | undefined;

/**
 * The name of npm's workspaces option without dashes and its shorthands, read from the knowledge base once: the hook
 * asks this for every npm install of a command, which may name a hundred thousand (decision D-124).
 */
function workspacesOptionNames(): { name: string; shorthands: readonly string[] } {
  if (workspacesNames !== undefined) return workspacesNames;
  const { prefix } = npmFacts();
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  const parsing = npm?.extra?.['parsing'] === undefined ? undefined : (values(npm.extra['parsing'])[0] as CommandLineParsing | undefined);
  const shorthands = Object.entries(parsing?.shorthands ?? {}).filter(([, expansion]) => expansion[0] === prefix.workspacesOption).map(([short]) => short.toLowerCase());
  workspacesNames = { name: prefix.workspacesOption.replace(/^-+/u, ''), shorthands };
  return workspacesNames;
}

/**
 * Whether an npm command, as the scan gives it (its words after quotes, escapes and aliases), may set workspaces on its
 * command line, the only place npm reads that setting from for its local prefix (extra.localPrefix of npm, decision
 * D-124): a word that starts with a dash and, without its dashes, any no- in front and a value, is a prefix of the
 * option's name (npm 11 expands abbreviations; also w, which is --workspace), starts with it, or is one of its
 * shorthands (ws, extra.parsing). With workspaces false, npm keeps a workspace package as its local prefix and reads its
 * .npmrc. It errs towards yes.
 */
export function mayTurnWorkspacesOff(command: string): boolean {
  const { name, shorthands } = workspacesOptionNames();
  return command.split(/\s+/u).some((word) => {
    if (!word.startsWith('-')) return false;
    const bare = (word.replace(/^-+/u, '').replace(/^(?:no-)+/iu, '').split('=')[0] ?? '').toLowerCase();
    return bare !== '' && (name.startsWith(bare) || bare.startsWith(name) || shorthands.includes(bare));
  });
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

/**
 * Whether a workspace pattern (* within a directory, ** across directories) matches a relative directory. Dynamic
 * programming over (directory part, pattern part), so that each ** costs at most a row of steps instead of trying
 * both ways (which took minutes for 18 of them, decision D-120); every step comes out of `budget`.
 */
function matchesWorkspace(directory: readonly string[], pattern: readonly string[], budget: StepBudget): boolean {
  // Consecutive ** match what one does.
  const parts = pattern.filter((part, index) => part !== '**' || pattern[index - 1] !== '**');
  if (!parts.includes('**') && parts.length !== directory.length) return false;
  // row[j]: whether the directory from part `at` matches the pattern from part j; below: the same from part at + 1.
  let row = new Uint8Array(parts.length + 1);
  let below = new Uint8Array(parts.length + 1);
  for (let at = directory.length; at >= 0; at--) {
    spendSteps(budget, parts.length + 1);
    row.fill(0);
    row[parts.length] = at === directory.length ? 1 : 0;
    const inside = at < directory.length;
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index] ?? '';
      if (part === '**') row[index] = row[index + 1] === 1 || (inside && below[index] === 1) ? 1 : 0;
      else row[index] = inside && below[index + 1] === 1 && matchSegment(directory[at] ?? '', part, budget) ? 1 : 0;
    }
    [row, below] = [below, row];
  }
  return below[0] === 1;
}

/**
 * The parts of a workspace pattern (without its leading !) when depcurfew reads it exactly as npm 12.2.1 does
 * (@npmcli/map-workspaces 6.0.0 with glob 13 and minimatch 10, extra.localPrefix of npm, decision D-124): npm strips
 * one leading ./ or the leading slashes, and each part is ** (any depth) or literal characters with * (any run within
 * one directory). Characters glob gives another meaning (? [ ] { } ( ) ! \ #), a trailing slash, an empty part, . and
 * .. give undefined: depcurfew's matcher may read them otherwise.
 */
function exactPattern(pattern: string): string[] | undefined {
  const parts = pattern.replace(/^\.?\/+/u, '').split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[?[\]{}()!\\#]/u.test(part)) ? parts : undefined;
}

/**
 * Whether @npmcli/package-json reads the package.json of a workspace root without an error, as npm does before it
 * looks at the workspaces: a bin list with something other than names, or a directories.bin that npm expands, may
 * throw there, and npm then passes over that root (decision D-124).
 */
function normalizesAsRoot(manifest: Record<string, unknown>): boolean {
  const directories = manifest['directories'];
  const binDirectory = isRecord(directories) ? directories['bin'] : undefined;
  const bin = manifest['bin'];
  if (Boolean(binDirectory) && !Boolean(bin)) return false;
  return !Array.isArray(bin) || bin.every((entry) => typeof entry === 'string');
}

/**
 * Whether each of `parts` below `root` is a directory listed under that exact name (no symlink, the same case) and
 * none starts with a dot, which glob's * and ** do not match: the path npm's glob finds is then the one depcurfew
 * compares (decision D-124).
 */
function listedPath(root: string, parts: readonly string[]): boolean {
  let parent = root;
  for (const part of parts) {
    if (part.startsWith('.')) return false;
    try {
      if (!readdirSync(parent, { withFileTypes: true }).some((entry) => entry.name === part && entry.isDirectory())) return false;
    } catch {
      return false;
    }
    parent = join(parent, part);
  }
  return true;
}

/** A workspace root lists the directory (exact: npm is sure to take it so, decision D-124), does not, or depcurfew cannot tell. */
type WorkspaceListing = false | { exact: boolean } | { unsure: string };

/**
 * Whether the package.json of `root` lists `directory` as a workspace: an array of patterns or an object with them,
 * ! excluding, node_modules never (@npmcli/map-workspaces). Patterns depcurfew cannot read do not match, so a doubt
 * keeps the nearer directory as the prefix, whose .npmrc is then reported if it sets a registry. More patterns, longer
 * ones or more matching steps than depcurfew allows give `unsure` with the reason (decision D-120).
 *
 * `exact` when npm is sure to match the directory too (decision D-124): on a POSIX system, a root package.json that npm
 * reads without an error, patterns that are all text and exclusions that are literal paths (map-workspaces drops a
 * pattern that a negated glob matches as text, so a negated glob may exclude more than depcurfew reads), a pattern
 * that matches the directory and that depcurfew reads exactly as npm (exactPattern), and a path glob walks under the
 * same names (listedPath).
 */
function listsWorkspace(root: string, directory: string, fact: NpmLocalPrefixKnowledge): WorkspaceListing {
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
  if (list.length > MAX_WORKSPACE_PATTERNS) return { unsure: `it lists more than ${MAX_WORKSPACE_PATTERNS} patterns` };
  if (list.some((entry) => typeof entry === 'string' && entry.length > MAX_WORKSPACE_PATTERN_LENGTH)) return { unsure: `a pattern in it is longer than ${MAX_WORKSPACE_PATTERN_LENGTH} characters` };
  const budget: StepBudget = { left: MAX_WORKSPACE_STEPS };
  let included = false;
  // Whether npm reads the root and the patterns as depcurfew does, and whether a pattern it reads so matches.
  let exact = process.platform !== 'win32' && isRecord(manifest) && normalizesAsRoot(manifest);
  let exactMatch = false;
  try {
    for (const entry of list) {
      if (typeof entry !== 'string') {
        exact = false;
        continue;
      }
      const bangs = /^!*/u.exec(entry)?.[0].length ?? 0;
      const exactParts = exactPattern(entry.slice(bangs));
      if (bangs % 2 === 1 && (exactParts === undefined || exactParts.some((part) => part.includes('*')))) exact = false;
      const pattern = entry.slice(bangs).replace(/^\.\//u, '').replace(/\/+$/u, '').split('/').filter((part) => part !== '' && part !== '.');
      if (pattern.length === 0 || pattern.includes('..') || !matchesWorkspace(parts, pattern, budget)) continue;
      // An odd number of ! excludes, whatever the order of the patterns.
      if (bangs % 2 === 1) return false;
      included = true;
      if (exactParts !== undefined) exactMatch = true;
    }
  } catch (error) {
    if (error instanceof OutOfSteps) return { unsure: `its patterns take more than ${MAX_WORKSPACE_STEPS} steps to match` };
    throw error;
  }
  return included ? { exact: exact && exactMatch && listedPath(root, parts) } : false;
}

/** A directory whose package.json may list npm's local prefix as a workspace, which depcurfew could not tell. */
export interface WorkspaceDoubt {
  root: string;
  reason: string;
}

/**
 * npm's local prefix for a command run in `start`: the nearest directory with package.json or node_modules, or the
 * workspace root that lists it (then `workspace` is that nearer directory), else `start` (extra.localPrefix of npm).
 * `exact`: npm is sure to take `workspace` for a workspace of that root, so it skips the .npmrc there unless its command
 * line turns workspaces off (decision D-124). `unsure` lists the directories on the way whose workspaces depcurfew did
 * not match (decision D-120).
 */
export function npmLocalPrefix(start: string): { prefix: string; workspace?: string; exact?: true; unsure?: WorkspaceDoubt[] } {
  const { prefix: fact } = npmFacts();
  const first = realPath(start);
  let found: string | undefined;
  const unsure: WorkspaceDoubt[] = [];
  const doubts = () => (unsure.length === 0 ? {} : { unsure });
  for (let directory = first; ; directory = dirname(directory)) {
    const manifest = isFile(join(directory, fact.markers.file));
    if (found === undefined) {
      if (manifest || isDirectory(join(directory, fact.markers.directory))) found = directory;
    } else if (fact.workspaceRoot && manifest && isFile(join(found, fact.markers.file))) {
      const listed = listsWorkspace(directory, found, fact);
      if (listed !== false && 'exact' in listed) return { prefix: directory, workspace: found, ...(listed.exact ? { exact: true as const } : {}), ...doubts() };
      if (listed !== false) unsure.push({ root: directory, reason: listed.unsure });
    }
    if (dirname(directory) === directory) break;
  }
  return { prefix: found ?? first, ...doubts() };
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
  /** The local prefix given with npm --prefix, which npm takes as it is instead of looking for package.json. */
  prefix?: string | undefined;
}

/**
 * What the .npmrc files npm reads for an install in `start` set: the registries and the dist-tag depcurfew uses, the
 * settings it does not take, and the files it could not read.
 */
export function npmrcSettings(start: string, options: NpmrcOptions): NpmrcSettings {
  const { config, tagKey, prefix: prefixFact } = npmFacts();
  const result: NpmrcSettings = { registry: undefined, scopes: new Map(), tag: undefined, unread: [], skipped: [] };
  const userPath = join(options.home, config.userFile.replace(/^~[/\\]/u, ''));
  const apply = (text: string, file: string) => {
    for (const { key, value, line } of iniEntries(text)) {
      const where = `${key}= in ${file}, line ${line}`;
      // A user name and password in a registry URL are neither sent (fetch refuses them anyway) nor shown.
      if (key === config.key) result.registry = { value: withoutCredentials(value), where, file, line };
      else if (tagKey !== undefined && key === tagKey) result.tag = { value, where, file, line };
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
  // npm --prefix names the local prefix itself (extra.localPrefix of npm, decision D-118).
  const { prefix, workspace, exact, unsure = [] } = options.prefix === undefined ? npmLocalPrefix(start) : { prefix: realPath(options.prefix), workspace: undefined, exact: undefined };
  const unread = (directory: string, skippedByNpm = false) => {
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
    const skipped = skippedByNpm ? { skippedByNpm: true as const } : {};
    for (const { key, value, line } of iniEntries(read.text)) {
      const url = urlValue(value);
      const named = url === undefined ? {} : { value: url };
      if (key === config.key) result.unread.push({ tool: 'npm', file, line, applies: 'all', effect: 'replaces', ...named, ...skipped });
      else if (tagKey !== undefined && key === tagKey) result.unread.push({ tool: 'npm', file, line, applies: 'tag', effect: 'replaces', ...(value.includes('$') ? {} : { value: value.trim() }), ...skipped });
      else if (key.startsWith('@') && key.endsWith(config.scopeKeySuffix)) {
        result.unread.push({ tool: 'npm', file, line, applies: 'scope', scope: key.slice(0, -config.scopeKeySuffix.length), effect: 'replaces', ...named, ...skipped });
      }
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
  // Where depcurfew matched the workspace exactly as npm does, they count only where npm may read them (decision D-124).
  if (workspace !== undefined && !trusted.has(workspace)) unread(workspace, exact === true);
  // A package.json whose workspaces depcurfew did not match may make its directory npm's local prefix (decision
  // D-120): said in a notice, and a registry the .npmrc there sets counts as one depcurfew did not check.
  for (const doubt of unsure) {
    const file = shownFile(base, join(doubt.root, prefixFact.markers.file));
    const directory = shownFile(base, doubt.root) || '.';
    result.skipped.push({
      file,
      reason: doubt.reason,
      notice: `the workspaces of ${file} were not matched: ${doubt.reason}; depcurfew cannot tell whether npm takes ${directory} for the workspace root, so a registry the ${config.file} there sets counts as one depcurfew did not check`,
      fix: `Keep the workspaces of ${file} to at most ${MAX_WORKSPACE_PATTERNS} patterns of at most ${MAX_WORKSPACE_PATTERN_LENGTH} characters (a glob such as packages/* covers many directories), so that depcurfew can tell which ${config.file} npm reads`,
      agentFix: `Tell the user that depcurfew did not match the workspaces of ${file}; do not change it yourself`,
    });
    if (doubt.root !== prefix && !trusted.has(doubt.root)) unread(doubt.root);
  }
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

/**
 * A place where a setting is written: its line, the key that * stood for, its value as a URL and what it does; for an
 * index used only by the packages pinned to it, one place per pinned package.
 */
interface Place {
  line: number;
  key?: string;
  value?: string;
  effect: 'replaces' | 'adds';
  package?: string;
  pin?: { file: string; line: number };
}

/** A package pinned to an index by name: the package (normalized), and the file and line of the pin. */
interface Pin {
  package: string;
  file: string;
  line: number;
}

/** The key paths of a TOML document that `path` (with * for any key of a table) names. */
function tomlPaths(document: TomlDocument, path: readonly string[]): string[][] {
  let found: string[][] = [[]];
  for (const wanted of path) {
    found = found.flatMap((prefix) => {
      const value: TomlValue | undefined = prefix.length === 0 ? document.root : tomlValueAt(document, prefix);
      if (!isRecord(value)) return [];
      return (wanted === '*' ? Object.keys(value) : Object.hasOwn(value, wanted) ? [wanted] : []).map((name) => [...prefix, name]);
    });
  }
  return found;
}

/**
 * The packages a TOML file pins to indexes, by the index name in lower case (decision D-120): uv's tool.uv.sources,
 * Poetry's dependency tables with source, Pipfile's package tables with index; a list of tables (by environment
 * marker) pins to each index it names.
 */
function pinsIn(document: TomlDocument, file: string, pins: NonNullable<IndexEntriesKnowledge['pins']>, into: Map<string, Pin[]>): void {
  for (const table of pins.tables) {
    for (const path of tomlPaths(document, table)) {
      const packages = tomlValueAt(document, path);
      if (!isRecord(packages)) continue;
      for (const [name, value] of Object.entries(packages)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          const index = isRecord(entry) ? entry[pins.key] : undefined;
          if (typeof index !== 'string') continue;
          const pin = { package: normalizePythonName(name), file, line: document.lineOf([...path, name]) ?? 1 };
          const known = into.get(index.toLowerCase()) ?? [];
          if (!known.some((other) => other.package === pin.package && other.file === pin.file && other.line === pin.line)) into.set(index.toLowerCase(), [...known, pin]);
        }
      }
    }
  }
}

/** Whether a value of an entry is the value of a rule: text compared without regard to case. */
function sameValue(value: unknown, wanted: string | boolean): boolean {
  return typeof wanted === 'string' ? typeof value === 'string' && value.toLowerCase() === wanted.toLowerCase() : value === wanted;
}

/** What an entry of an array of index tables does: the first rule that matches, else what the first or other entries do. */
function entryEffect(entry: unknown, position: number, entries: IndexEntriesKnowledge, searchAll: boolean): IndexEntryEffect {
  const rule = isRecord(entry) ? entries.rules.find((candidate) => sameValue(entry[candidate.key], candidate.value)) : undefined;
  const effect = rule?.effect ?? (position === 0 ? entries.first : entries.others);
  // Pipenv's install_search_all_sources makes every source one that any package may come from.
  return effect === 'pinned' && searchAll ? 'adds' : effect;
}

/** The name of an index entry in lower case, when it has one. */
function entryName(entry: unknown, entries: IndexEntriesKnowledge): string | undefined {
  const name = isRecord(entry) ? entry[entries.nameKey] : undefined;
  return typeof name === 'string' ? name.toLowerCase() : undefined;
}

/** The URL a setting's value names: a string, or a table with it under `urlKey`; undefined when it is neither. */
function placeValue(value: unknown, urlKey: string | undefined): string | undefined {
  if (typeof value === 'string') return urlValue(value);
  if (urlKey !== undefined && isRecord(value) && typeof value[urlKey] === 'string') return urlValue(value[urlKey]);
  return undefined;
}

/** The places in a YAML file where the setting's path (with * for any key) is set, with the line of the last key. */
function yamlPlaces(text: string, setting: RegistrySettingKnowledge): Place[] {
  const { path } = setting;
  const { document, lineCounter } = readYamlDocument(text);
  if (document.errors.length > 0) throw new Error('it is not valid YAML');
  const places: Place[] = [];
  const walk = (node: Node | null, index: number, key: string | undefined, offset: number) => {
    if (index === path.length) {
      if (node === null) return;
      const value = isScalar(node) ? placeValue(String(node.value), setting.urlKey) : undefined;
      places.push({ line: lineCounter.linePos(offset).line, effect: setting.effect, ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) });
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

/**
 * The places in a TOML file where the setting's path (with * for any key) is set; an array of index tables counts by
 * entry, as `entries` says, and an entry used only by pinned packages once for each package `pins` pins to it.
 */
function tomlPlaces(document: TomlDocument, setting: RegistrySettingKnowledge, pins: ReadonlyMap<string, readonly Pin[]>): Place[] {
  const { path, entries, urlKey } = setting;
  const places: Place[] = [];
  const place = (line: number, key: string | undefined, raw: unknown, effect: Place['effect']): Place => {
    const value = placeValue(raw, urlKey);
    return { line, effect, ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) };
  };
  const searchAll = entries?.searchAll !== undefined && tomlValueAt(document, entries.searchAll) === true;
  for (const prefix of tomlPaths(document, path)) {
    const value = tomlValueAt(document, prefix);
    if (value === undefined) continue;
    const key = path.includes('*') ? prefix[path.lastIndexOf('*')] : undefined;
    if (Array.isArray(value) && entries !== undefined) {
      value.forEach((entry, position) => {
        const line = document.lineOf([...prefix, position]) ?? document.lineOf(prefix) ?? 1;
        const name = entryName(entry, entries);
        // An entry named as PyPI without a URL is PyPI itself (Poetry, PDM).
        const pypi = entries.pypiName !== undefined && name === entries.pypiName.toLowerCase() && !(isRecord(entry) && urlKey !== undefined && Object.hasOwn(entry, urlKey));
        const found = pypi ? { ...place(line, key, undefined, 'replaces'), value: defaultIndex() } : undefined;
        const effect = entryEffect(entry, position, entries, searchAll);
        if (effect !== 'pinned') {
          places.push(found === undefined ? place(line, key, entry, effect) : { ...found, effect });
          return;
        }
        for (const pin of name === undefined ? [] : (pins.get(name) ?? [])) {
          places.push({ ...(found ?? place(line, key, entry, 'replaces')), package: pin.package, pin: { file: pin.file, line: pin.line } });
        }
      });
      continue;
    }
    // A list (extra-index-url, find-links) has no single URL to compare, so it counts as a value depcurfew cannot read.
    places.push(place(document.lineOf(prefix) ?? 1, key, Array.isArray(value) ? undefined : value, setting.effect));
  }
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
  const pinFiles = settings.flatMap((setting) => (setting.entries?.pins === undefined ? [] : [setting.entries.pins]));
  const names = [...new Set([...settings.map((setting) => setting.file), ...pinFiles.map((pins) => pins.file)])];
  // Each file of each directory is read and parsed once; the YAML of .yarnrc.yml is parsed by yamlPlaces.
  const found: { name: string; file: string; text: string; toml?: TomlDocument }[] = [];
  for (let directory = first; ; directory = dirname(directory)) {
    for (const name of names) {
      const path = join(directory, name);
      const file = shownFile(last, path);
      const read = readConfig(path);
      if (read === undefined) continue;
      if (!('text' in read)) {
        skipped.push({ file, reason: read.skipped });
        continue;
      }
      if (/\.ya?ml$/u.test(name)) {
        found.push({ name, file, text: read.text });
        continue;
      }
      try {
        found.push({ name, file, text: read.text, toml: parseToml(read.text) });
      } catch {
        skipped.push({ file, reason: 'it cannot be parsed' });
      }
    }
    if (directory === last || !isInside(last, directory) || dirname(directory) === directory) break;
  }
  // The packages pinned to an index by name, from every pin file on the way (decision D-120): uv takes the indexes of
  // uv.toml and pyproject.toml together, so a pin may name an index of the other file.
  const pins = new Map<string, Pin[]>();
  for (const entry of found) for (const pinned of pinFiles) if (entry.toml !== undefined && pinned.file === entry.name) pinsIn(entry.toml, entry.file, pinned, pins);
  for (const { name, file, text, toml } of found) {
    try {
      for (const setting of settings.filter((candidate) => candidate.file === name)) {
        const places = toml === undefined ? yamlPlaces(text, setting) : tomlPlaces(toml, setting, pins);
        for (const place of places) {
          unread.push({
            tool,
            file,
            line: place.line,
            applies: place.package === undefined ? setting.applies : 'package',
            effect: place.effect,
            ...(setting.applies === 'scope' && place.key !== undefined ? { scope: scopeName(place.key) } : {}),
            ...(place.package === undefined ? {} : { package: place.package }),
            ...(place.pin === undefined ? {} : { pin: place.pin }),
            ...(place.value === undefined ? {} : { value: place.value }),
          });
        }
      }
    } catch {
      skipped.push({ file, reason: 'it cannot be parsed' });
    }
  }
  return { unread, skipped };
}
