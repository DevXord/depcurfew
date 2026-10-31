// A TOML reader for pyproject.toml, uv.toml, poetry.toml and the Python lockfiles. It returns plain objects and
// records the line where each key, table and array-of-tables element is defined, so findings can point at it.
// Inline tables may span lines and end with a comma, as TOML 1.1 allows, so a newer file is not rejected.

export type DateTimeKind = 'offset-date-time' | 'local-date-time' | 'local-date' | 'local-time';

/** A date or time value, kept as written. */
export class TomlDateTime {
  readonly text: string;
  readonly kind: DateTimeKind;

  constructor(text: string, kind: DateTimeKind) {
    this.text = text;
    this.kind = kind;
  }

  toString(): string {
    return this.text;
  }
}

export type TomlValue = string | number | bigint | boolean | TomlDateTime | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export interface TomlDocument {
  root: TomlTable;
  /** 1-based line where the key, table or array element at `path` is defined. */
  lineOf(path: readonly (string | number)[]): number | undefined;
}

/** How a table came to exist, which decides whether it may be defined or extended later. */
type Origin = 'implicit' | 'header' | 'dotted' | 'inline';

const BARE_KEY = /^[A-Za-z0-9_-]+/u;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/u;
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?)/u;
const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };

export function parseToml(input: string): TomlDocument {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const origins = new WeakMap<object, Origin>();
  const arraysOfTables = new WeakSet<TomlValue[]>();
  const lines = new Map<string, number>();
  let index = 0;
  let line = 1;

  const fail = (message: string, at = line): never => {
    throw new SyntaxError(`invalid TOML at line ${at}: ${message}`);
  };
  const record = (path: readonly (string | number)[]) => {
    lines.set(JSON.stringify(path), line);
  };
  const advance = (count = 1) => {
    for (let step = 0; step < count; step++) if (text[index++] === '\n') line += 1;
  };
  const skipSpaces = () => {
    while (text[index] === ' ' || text[index] === '\t') index += 1;
  };
  const skipComment = () => {
    if (text[index] === '#') while (index < text.length && text[index] !== '\n') index += 1;
  };
  /** Spaces, comments and line breaks, as allowed inside arrays and (multi-line) inline tables. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (text[index] === '\n') advance();
      else if (text.startsWith('\r\n', index)) advance(2);
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (index >= text.length) return;
    if (text[index] === '\n') advance();
    else if (text.startsWith('\r\n', index)) advance(2);
    else fail('expected a new line after the value');
  };

  const newTable = (origin: Origin): TomlTable => {
    const table: TomlTable = {};
    origins.set(table, origin);
    return table;
  };
  const isTable = (value: TomlValue | undefined): value is TomlTable =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof TomlDateTime);
  // Keys are own properties only: __proto__ or constructor in a file is data, as in other TOML parsers. A plain
  // assignment of __proto__ would replace the table's prototype instead, and a read would find Object.prototype.
  const own = (table: TomlTable, key: string): TomlValue | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
  const put = (table: TomlTable, key: string, value: TomlValue) => {
    Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true });
  };

  // Strings

  const unicode = (digits: number): string => {
    const hex = text.slice(index, index + digits);
    if (!/^[0-9A-Fa-f]+$/u.test(hex) || hex.length !== digits) fail(`invalid unicode escape \\${digits === 4 ? 'u' : 'U'}${hex}`);
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail(`invalid unicode code point ${hex}`);
    index += digits;
    return String.fromCodePoint(code);
  };
  const escape = (): string => {
    const char = text[index] ?? '';
    index += 1;
    if (char === 'u') return unicode(4);
    if (char === 'U') return unicode(8);
    if (char === 'x') return unicode(2);
    const replacement = ESCAPES[char];
    return replacement ?? fail(`invalid escape \\${char}`);
  };
  const basicString = (): string => {
    const start = line;
    index += 1;
    let value = '';
    for (;;) {
      const char = text[index];
      if (char === undefined || char === '\n' || (char === '\r' && text[index + 1] === '\n')) return fail('unterminated string', start);
      index += 1;
      if (char === '"') return value;
      value += char === '\\' ? escape() : char;
    }
  };
  const literalString = (): string => {
    const start = line;
    const end = text.indexOf("'", index + 1);
    const newline = text.indexOf('\n', index + 1);
    if (end === -1 || (newline !== -1 && newline < end)) fail('unterminated string', start);
    const value = text.slice(index + 1, end).replace(/\r$/u, '');
    index = end + 1;
    return value;
  };
  const multiLineString = (quote: '"""' | "'''"): string => {
    const start = line;
    advance(3);
    if (text[index] === '\n') advance();
    else if (text.startsWith('\r\n', index)) advance(2);
    let value = '';
    for (;;) {
      if (index >= text.length) return fail('unterminated string', start);
      if (text.startsWith(quote, index)) {
        // Up to two quotes may end the content just before the closing delimiter.
        let extra = 0;
        while (extra < 2 && text[index + 3 + extra] === quote[0]) extra += 1;
        value += quote[0]?.repeat(extra) ?? '';
        advance(3 + extra);
        return value;
      }
      const char = text[index] ?? '';
      if (quote === '"""' && char === '\\') {
        // A backslash at the end of a line removes the line break and the whitespace after it.
        const rest = /^\\[ \t]*\r?\n/u.exec(text.slice(index, index + 64));
        if (rest !== null) {
          advance(rest[0].length);
          while (/[ \t\r\n]/u.test(text[index] ?? '')) advance();
          continue;
        }
        index += 1;
        value += escape();
        continue;
      }
      if (char === '\r' && text[index + 1] === '\n') {
        value += '\n';
        advance(2);
        continue;
      }
      value += char;
      advance();
    }
  };

  // Keys

  const simpleKey = (): string => {
    const char = text[index];
    if (char === '"') return text.startsWith('"""', index) ? fail('a key cannot be a multi-line string') : basicString();
    if (char === "'") return text.startsWith("'''", index) ? fail('a key cannot be a multi-line string') : literalString();
    const match = BARE_KEY.exec(text.slice(index, index + 256));
    if (match === null) return fail('expected a key');
    index += match[0].length;
    return match[0];
  };
  const key = (): string[] => {
    const parts = [simpleKey()];
    for (;;) {
      skipSpaces();
      if (text[index] !== '.') return parts;
      index += 1;
      skipSpaces();
      parts.push(simpleKey());
    }
  };

  // Values

  const number = (raw: string): number | bigint => {
    const clean = raw.replaceAll('_', '');
    if (/^[+-]?inf$/u.test(clean)) return clean.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/u.test(clean)) return Number.NaN;
    if (/^0[xob]/u.test(clean)) {
      const value = BigInt(clean);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    if (/^[+-]?\d+$/u.test(clean)) {
      const value = BigInt(clean);
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    const value = Number(clean);
    return Number.isNaN(value) ? fail(`invalid number ${raw}`) : value;
  };

  const value = (path: (string | number)[]): TomlValue => {
    const char = text[index];
    if (char === '"') return text.startsWith('"""', index) ? multiLineString('"""') : basicString();
    if (char === "'") return text.startsWith("'''", index) ? multiLineString("'''") : literalString();
    if (char === '[') return array(path);
    if (char === '{') return inlineTable(path);
    const rest = text.slice(index, index + 64);
    if (/^true(?![A-Za-z0-9_-])/u.test(rest)) {
      index += 4;
      return true;
    }
    if (/^false(?![A-Za-z0-9_-])/u.test(rest)) {
      index += 5;
      return false;
    }
    const date = DATE_TIME.exec(rest);
    if (date !== null) {
      index += date[0].length;
      const kind: DateTimeKind = date[0].includes(':')
        ? date[0].includes('-')
          ? /(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(date[0])
            ? 'offset-date-time'
            : 'local-date-time'
          : 'local-time'
        : 'local-date';
      return new TomlDateTime(date[0], kind);
    }
    const match = NUMBER.exec(rest);
    if (match !== null) {
      index += match[0].length;
      return number(match[0]);
    }
    return fail('expected a value');
  };

  const array = (path: (string | number)[]): TomlValue[] => {
    index += 1;
    const items: TomlValue[] = [];
    for (;;) {
      skipBlank();
      if (text[index] === ']') {
        index += 1;
        return items;
      }
      items.push(value([...path, items.length]));
      skipBlank();
      if (text[index] === ',') index += 1;
      else if (text[index] !== ']') fail('expected , or ] in the array');
    }
  };

  /** Puts `item` at the dotted `parts` below `table`, creating tables on the way as `origin`. */
  const assign = (table: TomlTable, parts: readonly string[], item: TomlValue, path: readonly (string | number)[], origin: Origin) => {
    let current = table;
    const walked: (string | number)[] = [...path];
    for (const part of parts.slice(0, -1)) {
      walked.push(part);
      const next = own(current, part);
      if (next === undefined) {
        const created = newTable(origin);
        put(current, part, created);
        current = created;
      } else if (isTable(next)) {
        if (origins.get(next) === 'inline' && origin !== 'inline') fail(`${walked.join('.')} is an inline table, which cannot be extended`);
        if (origins.get(next) === 'header' && origin === 'dotted') fail(`${walked.join('.')} is a table defined by a header, which dotted keys cannot extend`);
        current = next;
      } else {
        fail(`${walked.join('.')} is already a value, not a table`);
      }
    }
    const last = parts.at(-1) as string;
    if (Object.hasOwn(current, last)) fail(`${[...walked, last].join('.')} is defined twice`);
    put(current, last, item);
    record([...walked, last]);
  };

  const inlineTable = (path: (string | number)[]): TomlTable => {
    index += 1;
    const table = newTable('inline');
    for (;;) {
      skipBlank();
      if (text[index] === '}') {
        index += 1;
        return table;
      }
      const parts = key();
      skipSpaces();
      if (text[index] !== '=') fail('expected = after the key');
      index += 1;
      skipSpaces();
      const keyLine = line;
      const item = value([...path, ...parts]);
      const valueLine = line;
      line = keyLine;
      assign(table, parts, item, path, 'inline');
      line = valueLine;
      skipBlank();
      if (text[index] === ',') index += 1;
      else if (text[index] !== '}') fail('expected , or } in the inline table');
    }
  };

  // Tables

  const root = newTable('header');
  let current = root;
  let currentPath: (string | number)[] = [];

  /** Walks the header's parent keys, creating implicit tables and stepping into the last element of arrays of tables. */
  const parentOf = (parts: readonly string[]): { table: TomlTable; path: (string | number)[] } => {
    let table = root;
    const path: (string | number)[] = [];
    for (const part of parts.slice(0, -1)) {
      path.push(part);
      const next = own(table, part);
      if (next === undefined) {
        const created = newTable('implicit');
        put(table, part, created);
        table = created;
      } else if (Array.isArray(next) && arraysOfTables.has(next)) {
        const element = next.at(-1);
        if (!isTable(element)) return fail(`${path.join('.')} is already a value, not a table`);
        path.push(next.length - 1);
        table = element;
      } else if (isTable(next)) {
        if (origins.get(next) === 'inline') fail(`${path.join('.')} is an inline table, which cannot be extended`);
        table = next;
      } else {
        fail(`${path.join('.')} is already a value, not a table`);
      }
    }
    return { table, path };
  };

  const header = () => {
    const isArray = text.startsWith('[[', index);
    index += isArray ? 2 : 1;
    skipSpaces();
    const parts = key();
    skipSpaces();
    if (!text.startsWith(isArray ? ']]' : ']', index)) fail(`expected ${isArray ? ']]' : ']'} after the table name`);
    index += isArray ? 2 : 1;
    const name = parts.join('.');
    const { table: parent, path } = parentOf(parts);
    const last = parts.at(-1) as string;
    const existing = own(parent, last);
    if (isArray) {
      let list: TomlValue[];
      if (existing === undefined) {
        list = [];
        arraysOfTables.add(list);
        put(parent, last, list);
      } else if (Array.isArray(existing) && arraysOfTables.has(existing)) {
        list = existing;
      } else {
        return fail(`${name} is not an array of tables`);
      }
      current = newTable('header');
      currentPath = [...path, last, list.length];
      list.push(current);
    } else {
      if (existing === undefined) {
        current = newTable('header');
        put(parent, last, current);
      } else if (isTable(existing)) {
        const origin = origins.get(existing);
        if (origin === 'inline') fail(`${name} is an inline table, which cannot be extended`);
        if (origin !== 'implicit') fail(`table ${name} is defined twice`);
        origins.set(existing, 'header');
        current = existing;
      } else {
        return fail(Array.isArray(existing) ? `${name} is an array, not a table` : `${name} is already a value, not a table`);
      }
      currentPath = [...path, last];
    }
    record(currentPath);
    endOfLine();
  };

  const keyValue = () => {
    const parts = key();
    skipSpaces();
    if (text[index] !== '=') fail('expected = after the key');
    index += 1;
    skipSpaces();
    const keyLine = line;
    const item = value([...currentPath, ...parts]);
    const valueLine = line;
    line = keyLine;
    assign(current, parts, item, currentPath, 'dotted');
    line = valueLine;
    endOfLine();
  };

  for (;;) {
    skipBlank();
    if (index >= text.length) break;
    if (text[index] === '[') header();
    else keyValue();
  }

  return { root, lineOf: (path) => lines.get(JSON.stringify(path)) };
}

/** The value at a key path of a parsed document, or undefined when a key on the way is missing or not a table. */
export function tomlValueAt(document: TomlDocument, path: readonly string[]): TomlValue | undefined {
  let node: TomlValue | undefined = document.root;
  for (const key of path) {
    node = typeof node === 'object' && node !== null && !Array.isArray(node) && !(node instanceof TomlDateTime) && Object.hasOwn(node, key) ? (node as TomlTable)[key] : undefined;
  }
  return node;
}
