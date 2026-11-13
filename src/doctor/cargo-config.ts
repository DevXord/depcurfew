// The settings of Cargo's configuration that decide its release-age delay, read where depcurfew apply does not write
// them (E10): an argument of cargo --config (KEY=VALUE in TOML, or a path to a file) and Cargo configuration files. The
// keys come from the knowledge base: registry.global-min-publish-age (cooldown.setting), registries.crates-io
// .min-publish-age (extra.registryMinPublishAge) and resolver.incompatible-publish-age (extra.resolverSwitch). Nothing is
// run; an argument is read only within a size and a nesting depth.
import { extraOf, isRecord, settingOf } from '../apply/facts.ts';
import type { Repository } from '../detect/repository.ts';
import { parseToml, type TomlDocument } from '../detect/toml.ts';
import type { OverrideValues, ToolKnowledge } from '../knowledge/types.ts';

/** The longest --config argument depcurfew reads, in characters. */
export const MAX_CONFIG_ARGUMENT = 16 * 1024;
/** The deepest nesting of arrays and inline tables depcurfew reads in a --config argument. */
export const MAX_CONFIG_DEPTH = 32;

/** A key of Cargo's configuration that decides the delay, and the values that weaken it. */
export interface DelayKey {
  /** The dotted key as messages write it: registry.global-min-publish-age. */
  key: string;
  path: readonly string[];
  values: OverrideValues;
}

/** The keys that decide Cargo's delay, from the knowledge base. */
export function delayKeys(tool: ToolKnowledge): DelayKey[] {
  const keys: DelayKey[] = [];
  const global = settingOf(tool.cooldown.setting);
  if (global !== null) keys.push({ key: global, path: global.split('.'), values: 'delay' });
  const registry = tool.extra?.['registryMinPublishAge'] === undefined ? undefined : extraOf(tool, 'registryMinPublishAge', isRecord);
  if (registry !== undefined && typeof registry['key'] === 'string' && typeof registry['cratesIo'] === 'string') {
    const leaf = registry['key'].split('.').at(-1) ?? 'min-publish-age';
    keys.push({ key: `registries.${registry['cratesIo']}.${leaf}`, path: ['registries', registry['cratesIo'], leaf], values: 'delay' });
  }
  const resolver = tool.extra?.['resolverSwitch'] === undefined ? undefined : extraOf(tool, 'resolverSwitch', isRecord);
  if (resolver !== undefined && typeof resolver['key'] === 'string' && typeof resolver['turnsOff'] === 'string') keys.push({ key: resolver['key'], path: resolver['key'].split('.'), values: [resolver['turnsOff']] });
  return keys;
}

/** A value of a delay key in a document, with its line. */
export interface DelaySetting {
  key: DelayKey;
  value: unknown;
  line?: number;
}

function valueAt(document: TomlDocument, path: readonly string[]): unknown {
  let current: unknown = document.root;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** The delay keys a parsed Cargo configuration sets, and whether it has an include. */
export function delaySettings(document: TomlDocument, keys: readonly DelayKey[]): { settings: DelaySetting[]; include: boolean } {
  const settings: DelaySetting[] = [];
  for (const key of keys) {
    const value = valueAt(document, key.path);
    if (value === undefined) continue;
    const line = document.lineOf(key.path);
    settings.push(line === undefined ? { key, value } : { key, value, line });
  }
  return { settings, include: document.root['include'] !== undefined };
}

/** The deepest nesting of [ and { in a text, counted without regard to strings (a deeper count only stops the reading). */
function nesting(text: string): number {
  let depth = 0;
  let deepest = 0;
  for (const character of text) {
    if (character === '[' || character === '{') deepest = Math.max(deepest, ++depth);
    else if ((character === ']' || character === '}') && depth > 0) depth--;
  }
  return deepest;
}

/** A path as written, relative to the root of the repository, when it stays inside it. */
function repositoryPath(argument: string): string | undefined {
  const parts: string[] = [];
  for (const part of argument.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined) return undefined;
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 || argument.startsWith('/') ? undefined : parts.join('/');
}

/**
 * What a cargo --config argument sets (extra.configOverride): a file of the repository when one has that path (Cargo
 * takes an existing file over TOML), else KEY=VALUE in TOML. An argument that is neither, or too long or too deep to
 * read, is `unreadable` with the reason; TOML that Cargo cannot parse sets nothing, as Cargo stops there.
 */
export type ConfigArgument =
  | { kind: 'settings'; settings: DelaySetting[]; include: boolean; file?: string }
  | { kind: 'unreadable'; reason: string };

export function readConfigArgument(repository: Repository, argument: string, keys: readonly DelayKey[]): ConfigArgument {
  if (argument.length > MAX_CONFIG_ARGUMENT) return { kind: 'unreadable', reason: `an argument longer than the ${MAX_CONFIG_ARGUMENT / 1024} KiB depcurfew reads` };
  const path = repositoryPath(argument);
  const text = path === undefined ? undefined : repository.readText(path);
  if (path !== undefined && text !== undefined) {
    try {
      return { kind: 'settings', ...delaySettings(parseToml(text), keys), file: path };
    } catch {
      return { kind: 'unreadable', reason: `${path}, a file depcurfew cannot parse` };
    }
  }
  if (!argument.includes('=')) return { kind: 'unreadable', reason: `${argument}, a file depcurfew cannot read` };
  if (nesting(argument) > MAX_CONFIG_DEPTH) return { kind: 'unreadable', reason: `an argument nested deeper than the ${MAX_CONFIG_DEPTH} levels depcurfew reads` };
  try {
    return { kind: 'settings', ...delaySettings(parseToml(argument), keys) };
  } catch {
    return { kind: 'settings', settings: [], include: false };
  }
}

/** The deepest chain of include depcurfew follows from one configuration file. */
export const MAX_INCLUDE_DEPTH = 8;

/** A Cargo configuration file read for its delay keys, with the file that included it. */
export interface ReadConfigFile {
  file: string;
  settings: DelaySetting[];
  /** The [env] entries whose name is a variable of the delay, with their values and lines. */
  env: { name: string; value: unknown; line?: number }[];
  includedBy?: string;
  /** Includes depcurfew cannot follow: outside the repository or nested too deep, with the line of the include. */
  unreadable: { path: string; line?: number }[];
}

/** The directory of a path ('' for a file at the root). */
const directoryOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The paths of an include (extra.configInclude): strings or tables with path, each with whether it is optional. */
function includePaths(value: unknown): { path: string; optional: boolean }[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items.flatMap((item) => {
    if (typeof item === 'string') return [{ path: item, optional: false }];
    if (isRecord(item) && typeof item['path'] === 'string') return [{ path: item['path'], optional: item['optional'] === true }];
    return [];
  });
}

/**
 * A Cargo configuration file and the files it includes, depth first (Cargo merges a file over its includes). A file
 * depcurfew cannot parse, or a missing include that is not optional, stops Cargo, so it sets nothing; an include outside
 * the repository, of an absolute path or nested deeper than MAX_INCLUDE_DEPTH cannot be read and is listed.
 */
export function readConfigFiles(repository: Repository, file: string, keys: readonly DelayKey[], variables: ReadonlySet<string>): ReadConfigFile[] {
  const result: ReadConfigFile[] = [];
  const seen = new Set<string>();
  const visit = (path: string, includedBy: string | undefined, depth: number): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = repository.readText(path);
    if (text === undefined) return;
    let document: TomlDocument;
    try {
      document = parseToml(text);
    } catch {
      return;
    }
    const entry: ReadConfigFile = { file: path, ...delaySettings(document, keys), env: [], unreadable: [], ...(includedBy === undefined ? {} : { includedBy }) };
    const env = document.root['env'];
    if (isRecord(env)) {
      for (const [name, value] of Object.entries(env)) {
        if (!variables.has(name)) continue;
        const line = document.lineOf(['env', name]);
        entry.env.push(line === undefined ? { name, value } : { name, value, line });
      }
    }
    result.push(entry);
    const line = document.lineOf(['include']);
    for (const include of includePaths(document.root['include'])) {
      const target = include.path.startsWith('/') || /^[A-Za-z]:/u.test(include.path) ? undefined : repositoryPath(`${directoryOf(path)}/${include.path}`);
      if (target === undefined || depth >= MAX_INCLUDE_DEPTH) {
        entry.unreadable.push(line === undefined ? { path: include.path } : { path: include.path, line });
        continue;
      }
      visit(target, path, depth + 1);
    }
  };
  visit(file, undefined, 0);
  return result;
}
