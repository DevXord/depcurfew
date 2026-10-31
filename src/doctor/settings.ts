// Reading settings from configuration files with their line numbers, for doctor: INI (.npmrc), YAML, TOML
// (bunfig.toml) and JSON/JSONC. Unreadable files give no value; detection already reports them.
import { LineCounter, isMap, isScalar, isSeq, type Document, type Node, type Pair } from 'yaml';
import { extraOf, isRecord } from '../apply/facts.ts';
import { jsonElementOffsets, jsonGet, jsonOffset } from '../apply/json-edit.ts';
import { BLOCK_END, isBlockStart } from '../apply/block.ts';
import type { Repository } from '../detect/repository.ts';
import { npm } from '../knowledge/npm.ts';
import { parseYamlDocument } from '../yaml-parse.ts';

export interface Setting {
  file: string;
  /** 1-based line of the key. */
  line: number;
  value: unknown;
}

export interface IniEntry {
  key: string;
  /** As npm reads it: without quotes, escapes and a trailing comment; "true" for a key without =. */
  value: string;
  line: number;
  /** Inside depcurfew's managed block. */
  managed: boolean;
  /** The [section] the key belongs to; undefined at the top level, the only level npm takes settings from. */
  section?: string;
}

const NPMRC = extraOf(npm, 'npmrcFormat', isRecord);
const isChars = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const COMMENT_LINES = isChars(NPMRC['commentLines']) ? NPMRC['commentLines'] : [];
const INLINE_COMMENTS = isChars(NPMRC['inlineComments']) ? NPMRC['inlineComments'] : [];
const ESCAPE = typeof NPMRC['escape'] === 'string' ? NPMRC['escape'] : '\\';
const SECTION = new RegExp(String(NPMRC['sectionHeader']), 'u');
const KEY_WITHOUT_VALUE = String(NPMRC['keyWithoutValue']);

/** A key or value as the ini package reads it (its unsafe()): quotes removed, or cut at an unescaped comment. */
function iniText(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.endsWith(quote)) {
    const inner = quote === "'" ? text.slice(1, -1) : text;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner;
    }
  }
  let result = '';
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      result += character === ESCAPE || INLINE_COMMENTS.includes(character) ? character : `${ESCAPE}${character}`;
      escaped = false;
    } else if (INLINE_COMMENTS.includes(character)) {
      break;
    } else if (character === ESCAPE) {
      escaped = true;
    } else {
      result += character;
    }
  }
  return (escaped ? `${result}${ESCAPE}` : result).trim();
}

/** One line of an .npmrc file as npm's ini reads it (extra.npmrcFormat): nothing, a [section] header, or a key and value. */
export type IniLine = { section: string } | { key: string; value: string };

/**
 * A line of an .npmrc file, without its line break, as npm reads it: comment and blank lines give nothing, quotes are
 * removed from keys and values, a key without = is true; `key[]` keeps its brackets. apply reads lines with this too.
 */
export function iniLine(raw: string): IniLine | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || COMMENT_LINES.some((mark) => trimmed.startsWith(mark))) return undefined;
  const header = SECTION.exec(raw);
  if (header !== null) return { section: iniText(header[1] ?? '') };
  const equals = raw.indexOf('=');
  if (equals === 0) return undefined;
  return {
    key: iniText(equals === -1 ? raw : raw.slice(0, equals)),
    value: equals === -1 ? KEY_WITHOUT_VALUE : iniText(raw.slice(equals + 1)),
  };
}

/** npm's ini splits lines at every carriage return and line feed, so a lone \r also ends a line. */
const INI_LINE_BREAK = /\r\n|\r|\n/u;

/**
 * Every setting line of an .npmrc file as npm reads it (extra.npmrcFormat), including keys below a [section] header,
 * which npm does not apply; `key[]` keeps its brackets.
 */
export function iniLines(text: string): IniEntry[] {
  const entries: IniEntry[] = [];
  let managed = false;
  let section: string | undefined;
  text.split(INI_LINE_BREAK).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (isBlockStart(trimmed)) managed = true;
    else if (trimmed === BLOCK_END) managed = false;
    const line = iniLine(raw);
    if (line === undefined) return;
    if ('section' in line) {
      section = line.section;
      return;
    }
    entries.push({ key: line.key, value: line.value, line: index + 1, managed, ...(section === undefined ? {} : { section }) });
  });
  return entries;
}

/** The top-level settings of an .npmrc file: the keys npm applies. */
export function iniEntries(text: string): IniEntry[] {
  return iniLines(text).filter((entry) => entry.section === undefined);
}

/** A camelCase setting as pnpm 10 reads it from .npmrc, e.g. minimumReleaseAge as minimum-release-age. */
export function npmrcKey(setting: string): string {
  return setting.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
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

/** The text yamlSetting parsed last: rules ask for several settings of the same file in a row. Only read, never changed. */
let lastYaml: { text: string; document: Document.Parsed; lineCounter: LineCounter } | undefined;

/** The YAML node at `path` and the line of its key; the value is not converted, which takes long for a large node. */
function yamlNode(text: string, path: readonly string[]): { node: Node | null; line: number } | undefined {
  if (lastYaml?.text !== text) {
    const lineCounter = new LineCounter();
    lastYaml = { text, document: parseYamlDocument(text, lineCounter), lineCounter };
  }
  const { document, lineCounter } = lastYaml;
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
  return { node, line: lineCounter.linePos(keyOffset).line };
}

/** The YAML value at `path` and the line of its key. */
export function yamlSetting(text: string, path: readonly string[]): { value: unknown; line: number } | undefined {
  const found = yamlNode(text, path);
  if (found === undefined) return undefined;
  const { node, line } = found;
  const value: unknown = node === null ? null : isMap(node) || isSeq(node) || isScalar(node) ? (node.toJSON() as unknown) : undefined;
  return { value, line };
}

/** The line of the key at `path` in YAML, without its value. */
export function yamlKeyLine(text: string, path: readonly string[]): number | undefined {
  return yamlNode(text, path)?.line;
}

/** The 1-based line of an offset, found by binary search in the positions of the line breaks of `text`. */
export function lineIndex(text: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) breaks.push(index);
  return (offset) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((breaks[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

/** The line of every element of the JSON array at `path`, from one parse. */
export function jsonElementLines(text: string, path: readonly (string | number)[]): number[] | undefined {
  const offsets = jsonElementOffsets(text, path);
  if (offsets === undefined) return undefined;
  const line = lineIndex(text);
  return offsets.map(line);
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
