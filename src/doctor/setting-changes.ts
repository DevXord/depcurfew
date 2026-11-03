// The settings a change planned by depcurfew apply sets or removes, as the tool reads its file: .npmrc lines, YAML,
// JSON and TOML values by their key path. Comments, depcurfew's markers and a setting moved into the managed block
// with the same value are no change. config-drift words its notes against the default policy with them (decision
// D-149); a file of another format, or one that does not parse, is compared line by line.
import { lines, myers } from '../apply/diff.ts';
import { yamlOptionsFor } from '../apply/facts.ts';
import { parseJsonc } from '../detect/jsonc.ts';
import { parseToml, TomlDateTime } from '../detect/toml.ts';
import { parseYaml } from '../yaml-parse.ts';
import { iniEntries } from './settings.ts';
import { readGemfile } from '../apply/gemfile.ts';
import { extraOf } from '../apply/facts.ts';
import { bundler } from '../knowledge/bundler.ts';

/** The Gemfiles of Bundler (extra.gemfileNames), read as source calls (decision D-159). */
const GEMFILES: ReadonlySet<string> = new Set(extraOf(bundler, 'gemfileNames', (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')));

export interface SettingChanges {
  /** Each setting with the value it gets, as `key=value` (.npmrc), `path = value` (TOML) or `path: value`. */
  set: string[];
  /** The settings that are no longer set, by name (or the line, for a file compared line by line). */
  removed: string[];
}

/** The values of every setting of a file by its key path; a list holds the values of each entry of a list of tables. */
type Values = Map<string, string[]>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof TomlDateTime);

/** A value as JSON, with TOML's big integers and dates as written. */
function valueText(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item instanceof TomlDateTime ? item.text : item)) ?? String(value)
  );
}

function add(values: Values, path: string, text: string): void {
  const list = values.get(path);
  if (list === undefined) values.set(path, [text]);
  else list.push(text);
}

/**
 * Every leaf of the data under `path`: scalars and lists of scalars are values; an empty table is one too. The entries
 * of a list of tables (updates in dependabot.yml) are written `updates[]`, so that the same setting in each counts once.
 */
function flatten(node: unknown, path: string, values: Values): void {
  if (Array.isArray(node) && node.some(isObject)) {
    for (const item of node) flatten(item, `${path}[]`, values);
    return;
  }
  if (isObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0 && path !== '') add(values, path, '{}');
    for (const key of keys) flatten(node[key], path === '' ? key : `${path}.${key}`, values);
    return;
  }
  if (path !== '') add(values, path, valueText(node));
}

type Format = { kind: 'ini' } | { kind: 'data'; parse: (text: string) => unknown; separator: string };

function formatOf(file: string): Format | undefined {
  const name = file.split('/').at(-1) ?? file;
  if (name === '.npmrc') return { kind: 'ini' };
  if (/\.ya?ml$/u.test(name)) return { kind: 'data', parse: (text) => parseYaml(text, yamlOptionsFor(file)), separator: ': ' };
  if (/\.jsonc?$/u.test(name)) return { kind: 'data', parse: parseJsonc, separator: ': ' };
  if (name.endsWith('.toml') || name === 'Pipfile') return { kind: 'data', parse: (text) => parseToml(text).root, separator: ' = ' };
  return undefined;
}

/** The settings of a file in a known format, or undefined when it does not parse. */
function valuesOf(format: Format, text: string): Values | undefined {
  const values: Values = new Map();
  if (format.kind === 'ini') {
    // npm reads the last line of a key; a key[] line adds to a list.
    for (const entry of iniEntries(text)) {
      if (entry.key.endsWith('[]')) add(values, entry.key, entry.value);
      else values.set(entry.key, [entry.value]);
    }
    return values;
  }
  try {
    flatten(text.trim() === '' ? {} : format.parse(text), '', values);
  } catch {
    return undefined;
  }
  return values;
}

function same(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  const sorted = [...left].sort();
  return [...right].sort().every((item, index) => item === sorted[index]);
}

/** Lines that hold no setting: blank lines, comments and the lines depcurfew writes around its settings. */
function isSettingLine(line: string): boolean {
  return line !== '' && !line.startsWith('#') && !line.startsWith('//') && !line.startsWith(';');
}

/** A file depcurfew cannot read as settings: the lines apply adds and removes, without the ones it only moves. */
function lineChanges(before: string, after: string): SettingChanges {
  const added: string[] = [];
  const removed: string[] = [];
  for (const operation of myers(lines(before), lines(after))) {
    const line = operation.line.replace(/[\r\u0000]/gu, '').trim();
    if (operation.kind === 'same' || !isSettingLine(line)) continue;
    (operation.kind === 'insert' ? added : removed).push(line);
  }
  const moved = new Set(added.filter((line) => removed.includes(line)));
  return { set: [...new Set(added.filter((line) => !moved.has(line)))], removed: [...new Set(removed.filter((line) => !moved.has(line)))] };
}

/**
 * A Gemfile: the cooldown: apply sets on its source calls, as `cooldown: 7`, never the line it rewrites, which would
 * read as removing the source (decision D-159). Both texts are as on disk, so readGemfile reads \r\n as one newline in
 * them, as apply reads the file (decision D-163).
 */
function gemfileChanges(before: string, after: string): SettingChanges {
  const old = new Map(readGemfile(before).sources.map((source) => [source.line, source.cooldown]));
  const set = new Set<string>();
  for (const source of readGemfile(after).sources) {
    if (typeof source.cooldown === 'number' && old.get(source.line) !== source.cooldown) set.add(`cooldown: ${source.cooldown}`);
  }
  return { set: [...set], removed: [] };
}

/** What a planned change of `file` sets and removes; both empty when only comments, markers or the layout change. */
export function settingChanges(file: string, before: string | null, after: string): SettingChanges {
  const name = file.split('/').at(-1) ?? file;
  if (before !== null && GEMFILES.has(name)) return gemfileChanges(before, after);
  const format = formatOf(file);
  const old = format === undefined ? undefined : valuesOf(format, before ?? '');
  const now = format === undefined ? undefined : valuesOf(format, after);
  if (format === undefined || old === undefined || now === undefined) return lineChanges(before ?? '', after);
  const separator = format.kind === 'ini' ? '=' : format.separator;
  const set: string[] = [];
  for (const [path, list] of now) {
    if (same(old.get(path), list)) continue;
    for (const value of new Set(list)) set.push(`${path}${separator}${value}`);
  }
  const removed = [...old.keys()].filter((path) => !now.has(path));
  return { set, removed };
}
