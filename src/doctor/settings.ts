// Reading settings from configuration files with their line numbers, for doctor: INI (.npmrc), YAML, TOML
// (bunfig.toml) and JSON/JSONC. Unreadable files give no value; detection already reports them.
import { LineCounter, parseDocument, isMap, isScalar, isSeq, type Node, type Pair } from 'yaml';
import { jsonGet, jsonOffset } from '../apply/json-edit.ts';
import { BLOCK_END, BLOCK_START } from '../apply/block.ts';
import type { Repository } from '../detect/repository.ts';

export interface Setting {
  file: string;
  /** 1-based line of the key. */
  line: number;
  value: unknown;
}

export interface IniEntry {
  key: string;
  value: string;
  line: number;
  /** Inside depgate's managed block. */
  managed: boolean;
}

/** Every key=value line of an .npmrc file; `key[]` keeps its brackets. */
export function iniEntries(text: string): IniEntry[] {
  const entries: IniEntry[] = [];
  let managed = false;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (line === BLOCK_START) managed = true;
    else if (line === BLOCK_END) managed = false;
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const equals = line.indexOf('=');
    if (equals === -1) return;
    const value = line.slice(equals + 1).trim().replace(/^"(.*)"$/u, '$1');
    entries.push({ key: line.slice(0, equals).trim(), value, line: index + 1, managed });
  });
  return entries;
}

/** A parsed INI value: true/false, numbers and strings as npm reads them. */
export function iniValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) if (text[index] === '\n') line += 1;
  return line;
}

/** The YAML value at `path` and the line of its key. */
export function yamlSetting(text: string, path: readonly string[]): { value: unknown; line: number } | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) return undefined;
  let node: Node | null = document.contents as Node | null;
  let keyOffset = 0;
  for (const segment of path) {
    if (node !== null && isSeq(node) && /^\d+$/u.test(segment)) {
      const item = node.items[Number(segment)] as Node | undefined;
      if (item === undefined) return undefined;
      keyOffset = item.range?.[0] ?? keyOffset;
      node = item;
      continue;
    }
    if (node === null || !isMap(node)) return undefined;
    const pair = (node.items as Pair<Node, Node | null>[]).filter((item) => isScalar(item.key) && String(item.key.value) === segment).at(-1);
    if (pair === undefined) return undefined;
    keyOffset = pair.key.range?.[0] ?? 0;
    node = pair.value;
  }
  const value: unknown = node === null ? null : isMap(node) || isSeq(node) || isScalar(node) ? (node.toJSON() as unknown) : undefined;
  return { value, line: lineCounter.linePos(keyOffset).line };
}

/** The JSON value at `path` and the line where it starts. */
export function jsonSetting(text: string, path: readonly (string | number)[]): { value: unknown; line: number } | undefined {
  let value: unknown;
  try {
    value = jsonGet(text, path);
  } catch {
    return undefined;
  }
  if (value === undefined) return undefined;
  const offset = jsonOffset(text, path);
  return { value, line: offset === undefined ? 1 : lineAt(text, offset) };
}

function tomlScalar(raw: string): unknown {
  const text = raw.replace(/\s+#.*$/u, '').trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/u.test(text)) return Number(text.replaceAll('_', ''));
  const string = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/u.exec(text);
  if (string !== null) return string[1] === undefined ? string[2] : (JSON.parse(`"${string[1]}"`) as string);
  if (text.startsWith('[') && text.endsWith(']')) {
    const items = text.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s][^,]*/gu) ?? [];
    return items.map((item) => tomlScalar(item.trim()));
  }
  return text;
}

/** A key of a TOML table (`[table]` section or a dotted `table.key` at the top level). Single-line values only. */
export function tomlSetting(text: string, table: string, key: string): { value: unknown; line: number } | undefined {
  let current = '';
  let found: { value: unknown; line: number } | undefined;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]/u.exec(line);
    if (header !== null) {
      current = header[1] ?? '';
      return;
    }
    if (line === '' || line.startsWith('#')) return;
    const equals = line.indexOf('=');
    if (equals === -1) return;
    const name = line.slice(0, equals).trim().replace(/^["']|["']$/gu, '');
    const matches = (current === table && name === key) || (current === '' && name === `${table}.${key}`);
    if (matches) found = { value: tomlScalar(line.slice(equals + 1)), line: index + 1 };
  });
  return found;
}

/**
 * A setting as the knowledge base names it, read from one configuration file: `.npmrc` keys, YAML and JSON paths
 * with dots, TOML `table.key`. For `.npmrc` the last line wins, as in npm.
 */
export function readSetting(repository: Repository, file: string, setting: string): Setting | undefined {
  if (setting.includes('<')) return undefined;
  const text = repository.readText(file);
  if (text === undefined) return undefined;
  const name = file.split('/').at(-1) ?? file;
  let found: { value: unknown; line: number } | undefined;
  if (name === '.npmrc') {
    const entries = iniEntries(text).filter((entry) => entry.key === setting || entry.key === `${setting}[]`);
    const last = entries.at(-1);
    if (last !== undefined) {
      found = last.key.endsWith('[]')
        ? { value: entries.filter((entry) => entry.key.endsWith('[]')).map((entry) => entry.value), line: entries[0]?.line ?? last.line }
        : { value: iniValue(last.value), line: last.line };
    }
  } else if (/\.ya?ml$/u.test(name)) {
    found = yamlSetting(text, setting.split('.'));
  } else if (name.endsWith('.toml')) {
    const dot = setting.indexOf('.');
    found = dot === -1 ? tomlSetting(text, '', setting) : tomlSetting(text, setting.slice(0, dot), setting.slice(dot + 1));
  } else if (/\.jsonc?$/u.test(name)) {
    found = jsonSetting(text, setting.split('.'));
  }
  return found === undefined ? undefined : { file, ...found };
}

/** The 1-based line of the first occurrence of `needle`, or undefined. */
export function lineOf(text: string, needle: string): number | undefined {
  const offset = text.indexOf(needle);
  return offset === -1 ? undefined : lineAt(text, offset);
}
