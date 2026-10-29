// bunfig.toml: the managed block goes at the end of one table (e.g. [install]); TOML forbids defining a table
// twice, so the block cannot simply be appended with its own header. Managed keys set elsewhere in that table,
// or as dotted keys (install.key = ...) outside it, are commented out with a note, every line of the value. Values
// are followed across lines, so a line inside an array or a multi-line string is never taken for a key or a header.
import { insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED, TURNED_OFF } from './block.ts';

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u;

function keyOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) return undefined;
  const equals = trimmed.indexOf('=');
  if (equals === -1) return undefined;
  return trimmed.slice(0, equals).trim().replace(/^["']|["']$/gu, '');
}

interface ValueState {
  /** Open brackets and braces of arrays and inline tables. */
  depth: number;
  /** The open string's delimiter, or '' outside strings. */
  string: '' | '"' | "'" | '"""' | "'''";
}

/** Follows a value through one line: strings (with escapes), multi-line strings, arrays, inline tables, comments. */
function scanLine(line: string, state: ValueState): ValueState {
  let { depth, string } = state;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (string === '"""' || string === "'''") {
      if (string === '"""' && char === '\\') index += 1;
      else if (line.startsWith(string, index)) {
        string = '';
        index += 2;
      }
      continue;
    }
    if (string === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') string = '';
      continue;
    }
    if (string === "'") {
      if (char === "'") string = '';
      continue;
    }
    if (char === '#') break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      string = line.startsWith('"""', index) ? '"""' : "'''";
      index += 2;
    } else if (char === '"' || char === "'") string = char;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
  // A single-line string cannot continue on the next line.
  return { depth, string: string === '"' || string === "'" ? '' : string };
}

/** The index of the last line of the value that starts after the `=` on line `index`. */
function valueEnd(lines: readonly string[], index: number): number {
  const line = lines[index] ?? '';
  let state = scanLine(line.slice(line.indexOf('=') + 1), { depth: 0, string: '' });
  let end = index;
  while ((state.depth > 0 || state.string !== '') && end + 1 < lines.length) {
    end += 1;
    state = scanLine(lines[end] ?? '', state);
  }
  return end;
}

export function writeTomlBlock(body: string, table: string, entries: readonly string[], managedKeys: readonly string[]): string {
  const managed = new Set(managedKeys);
  const removed = removeBlock(splitLines(body));
  const lines = [...removed.lines];
  // Tables by the line of their header; array-of-tables headers ([[...]]) only end the table before them.
  const headers = new Map<number, string>();
  const boundaries: number[] = [];
  let current: string | undefined;
  // Keys at the top level that define the table (install.key = ..., install = { ... }) and stay after this edit.
  let definedAtTop = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const header = HEADER.exec(line);
    if (header !== null) {
      current = header[1];
      boundaries.push(index);
      if (!line.trim().startsWith('[[') && current !== undefined) headers.set(index, current);
      continue;
    }
    const key = keyOf(line);
    if (key === undefined) continue;
    const end = valueEnd(lines, index);
    const inTable = current === table && managed.has(key);
    const dotted = current === undefined && key.startsWith(`${table}.`) && managed.has(key.slice(table.length + 1));
    if (inTable || dotted) {
      lines[index] = `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${line.trim()}`;
      for (let next = index + 1; next <= end; next++) lines[next] = `# ${lines[next] ?? ''}`;
    } else if (current === undefined && (key === table || key.startsWith(`${table}.`))) {
      definedAtTop = true;
    }
    index = end;
  }
  if (entries.length === 0) return joinLines(lines);

  const headerIndex = [...headers].find(([, name]) => name === table)?.[0] ?? -1;
  const nextHeaderAfter = (from: number) => boundaries.find((index) => index > from) ?? -1;
  if (headerIndex === -1) {
    if (definedAtTop) {
      throw new Error(`${table} is defined with dotted keys or an inline table, so a [${table}] table cannot be added; move its settings under a [${table}] header`);
    }
    const prefix = lines.length > 0 && lines.at(-1)?.trim() !== '' ? [...lines, ''] : lines;
    return joinLines([...prefix, `[${table}]`, ...insertBlock([], 0, entries)]);
  }
  if (removed.at !== undefined && removed.at > headerIndex) {
    const nextHeader = nextHeaderAfter(headerIndex);
    if (nextHeader === -1 || removed.at <= nextHeader) return joinLines(insertBlock(lines, removed.at, entries, removed.separated));
  }
  let end = nextHeaderAfter(headerIndex);
  if (end === -1) end = lines.length;
  while (end > headerIndex + 1 && lines[end - 1]?.trim() === '') end -= 1;
  return joinLines(insertBlock(lines, end, entries));
}
