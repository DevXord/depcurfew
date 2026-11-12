// TOML files (bunfig.toml, uv.toml, pyproject.toml, poetry.toml): the managed block goes at the end of one table
// (e.g. [install] or [tool.uv]), or among the top-level keys before the first table when the table is ''. TOML
// forbids defining a table twice, so the block cannot simply be appended with its own header. Managed keys set
// elsewhere in that table, or as dotted keys (install.key = ...) outside it, are commented out with a note, every
// line of the value, and come back as they were once the policy no longer manages them. Values are followed across
// lines, so a line inside an array or a multi-line string is never taken for a key or a header. A file with blocks
// in several tables names the table in each block's marker.
import { BLOCK_END, BLOCK_PREFIX, blockLabel, blockStart, commentedOut, insertBlock, joinLines, removeBlockAt, splitLines, SUPERSEDED, TURNED_OFF, type BlockScope, type RemovedBlock } from './block.ts';

const BARE_KEY = /^[A-Za-z0-9_-]+/u;
const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };

/** A "basic" or 'literal' key part from the quote at `start`, with the index after it; undefined when it does not close on the line. */
function quotedPart(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start] ?? '';
  if (text.startsWith(quote.repeat(3), start)) return undefined;
  let value = '';
  let index = start + 1;
  for (;;) {
    const char = text[index];
    if (char === undefined) return undefined;
    index += 1;
    if (char === quote) return { value, end: index };
    if (quote === "'" || char !== '\\') {
      value += char;
      continue;
    }
    const escape = text[index] ?? '';
    const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : escape === 'x' ? 2 : 0;
    if (digits === 0) {
      const replaced = ESCAPES[escape];
      if (replaced === undefined) return undefined;
      value += replaced;
      index += 1;
      continue;
    }
    const hex = text.slice(index + 1, index + 1 + digits);
    if (hex.length !== digits || !/^[0-9A-Fa-f]+$/u.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) return undefined;
    value += String.fromCodePoint(Number.parseInt(hex, 16));
    index += 1 + digits;
  }
}

/**
 * A key as TOML reads it, from `start` of `text`: bare, "basic" (with escapes) and 'literal' parts joined by dots, with
 * spaces or tabs around each dot (decision D-167), and the index after it; undefined when no key starts there.
 */
function readKey(text: string, start: number): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  let index = start;
  const spaces = () => {
    while (text[index] === ' ' || text[index] === '\t') index += 1;
  };
  for (;;) {
    spaces();
    const char = text[index];
    if (char === '"' || char === "'") {
      const part = quotedPart(text, index);
      if (part === undefined) return undefined;
      parts.push(part.value);
      index = part.end;
    } else {
      const bare = BARE_KEY.exec(text.slice(index, index + 256))?.[0];
      if (bare === undefined) return undefined;
      parts.push(bare);
      index += bare.length;
    }
    spaces();
    if (text[index] !== '.') return { parts, end: index };
    index += 1;
  }
}

/**
 * A key path in one spelling, so that [tool."uv"], [tool . uv] and [tool.uv] name the same table, as they do in TOML:
 * parts that can be bare are written bare, the others as JSON strings.
 */
function keyName(parts: readonly string[]): string {
  return parts.map((part) => (/^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part))).join('.');
}

/** The table a header line names ([table] or [[table]]), in the spelling of keyName; undefined for any other line. */
export function headerOf(line: string): { name: string; array: boolean } | undefined {
  const start = line.search(/\S/u);
  if (start === -1 || line[start] !== '[') return undefined;
  const array = line[start + 1] === '[';
  const key = readKey(line, start + (array ? 2 : 1));
  if (key === undefined) return undefined;
  const close = array ? ']]' : ']';
  if (!line.startsWith(close, key.end)) return undefined;
  const rest = line.slice(key.end + close.length).trim();
  return rest === '' || rest.startsWith('#') ? { name: keyName(key.parts), array } : undefined;
}

function isHeader(line: string): boolean {
  return headerOf(line) !== undefined;
}

/** The key of a `key = value` line in the spelling of keyName: quoted and dotted keys as TOML reads them. */
export function keyOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) return undefined;
  const key = readKey(trimmed, 0);
  if (key !== undefined && trimmed[key.end] === '=') return keyName(key.parts);
  // Not a key TOML reads: the text before = as it is, so that the value after it is still followed.
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

/** The table each line is in (undefined before the first table), following values over several lines. */
function tablesOf(lines: readonly string[]): (string | undefined)[] {
  const tables: (string | undefined)[] = [];
  let current: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const header = headerOf(line);
    if (header !== undefined) current = header.name;
    tables[index] = current;
    if (header === undefined && keyOf(line) !== undefined) {
      const end = valueEnd(lines, index);
      for (let next = index + 1; next <= end; next++) tables[next] = current;
      index = end;
    }
  }
  return tables;
}

/**
 * Whether each line starts outside every value: not inside a multi-line string, nor inside an array or inline table
 * that goes on over several lines (decision E04). Only there can a line be a marker of depcurfew's managed block.
 */
function outsideValues(lines: readonly string[]): boolean[] {
  const outside: boolean[] = [];
  let state: ValueState = { depth: 0, string: '' };
  for (const line of lines) {
    outside.push(state.depth <= 0 && state.string === '');
    state = scanLine(line, state);
    // A header such as [table] opens and closes its brackets on the line; a value that is not closed carries on.
    if (state.depth < 0) state = { ...state, depth: 0 };
  }
  return outside;
}

/** A managed block of a TOML file: the line of its start marker, its label ('' for none) and the line of its end marker. */
export interface TomlBlock {
  start: number;
  label: string;
  /** undefined when no end marker follows outside values: the block then runs to the end of the file. */
  end: number | undefined;
}

/**
 * The managed blocks of a TOML file, read as TOML reads the file (decision E04): a marker line inside a multi-line
 * string or a multi-line array is text of that value, so a block wrapped in a string is no block, whatever its lines say.
 * The one reader of markers in TOML files, for apply, apply --user, doctor and doctor --user.
 */
export function tomlBlocks(lines: readonly string[]): TomlBlock[] {
  return readBlocks(lines).blocks;
}

/** The blocks, and whether each line starts outside values, worked out only when some line has a start marker's text. */
function readBlocks(lines: readonly string[]): { blocks: TomlBlock[]; outside: boolean[] | undefined } {
  if (!lines.some((line) => line.includes(BLOCK_PREFIX))) return { blocks: [], outside: undefined };
  const outside = outsideValues(lines);
  const blocks: TomlBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (outside[index] !== true) continue;
    const label = blockLabel(lines[index] ?? '');
    if (label === undefined) continue;
    let end: number | undefined;
    for (let next = index + 1; next < lines.length; next++) {
      if (outside[next] === true && (lines[next] ?? '').trim() === BLOCK_END) {
        end = next;
        break;
      }
    }
    blocks.push({ start: index, label, end });
    if (end === undefined) break;
    index = end;
  }
  return { blocks, outside };
}

/** The 1-based lines between the markers of the managed blocks of a TOML text, read by tomlBlocks. */
export function tomlBlockLines(text: string): Set<number> {
  const all = text.split(/\r?\n/u);
  const inside = new Set<number>();
  for (const block of tomlBlocks(all)) {
    for (let line = block.start + 1; line < (block.end ?? all.length); line++) inside.add(line + 1);
  }
  return inside;
}

/** Whether apply wrote anything into a TOML text: a managed block outside values, or a line it commented out. */
export function hasManagedTomlLines(body: string): boolean {
  if (!body.includes(BLOCK_PREFIX) && !body.includes(SUPERSEDED.trim()) && !body.includes(TURNED_OFF.trim())) return false;
  const all = splitLines(body);
  if (tomlBlocks(all).length > 0) return true;
  const outside = outsideValues(all);
  return all.some((line, index) => outside[index] === true && commentedOut(line) !== undefined);
}

/**
 * The lines without the managed block with this label, and without every copy of it, read by tomlBlocks: a marker in
 * a value is text of the value and stays (decision E04).
 */
function removeTomlBlock(lines: readonly string[], label: string): RemovedBlock {
  const blocks = tomlBlocks(lines).filter((block) => block.label === label);
  const first = blocks[0];
  if (first === undefined) return { lines: [...lines], at: undefined, separated: false };
  // One pass for every copy, as removeBlockAt does for one: the block's lines, and the blank line before it.
  const drop = new Set<number>();
  let separated = false;
  for (const block of blocks) {
    const end = block.end ?? block.start;
    const before = block.start - 1;
    const blank = before >= 0 && !drop.has(before) && (lines[before] ?? '').trim() === '';
    for (let index = block.start; index <= end; index++) drop.add(index);
    if (blank) drop.add(before);
    if (block === first) separated = blank;
  }
  const rest = lines.filter((_, index) => !drop.has(index));
  let at = 0;
  for (let index = 0; index < first.start; index++) if (!drop.has(index)) at += 1;
  return { lines: rest, at: Math.min(at, rest.length), separated };
}

/**
 * Removes the block with this marker. A labeled block that is not there yet may have been written by an earlier
 * version without the label: an unlabeled block inside the same table is then taken for it.
 */
function removeOwnBlock(lines: readonly string[], table: string, label: string | undefined): RemovedBlock {
  const removed = removeTomlBlock(lines, label ?? '');
  if (removed.at !== undefined || label === undefined) return removed;
  const tables = tablesOf(lines);
  const legacy = tomlBlocks(lines).find((block) => block.label === '' && (tables[block.start] ?? '') === table);
  return legacy === undefined ? removed : removeBlockAt(lines, legacy.start, legacy.end ?? legacy.start);
}

/** The line where the value around line `index` starts: the last line before it that starts outside values. */
function valueStart(outside: readonly boolean[], index: number): number {
  let start = index;
  while (start > 0 && outside[start] !== true) start -= 1;
  return start;
}

/**
 * The check after each edit of a TOML block (decision E04): with entries, the file has the block with this label
 * once, outside every value, in `table` (the top level for ''), and its end marker after it; without entries, no
 * such block. Throws an error whose message names the line, with a fix, which apply reports as cannot-edit.
 */
export function checkTomlBlock(body: string, table: string, label: string | undefined, scope: BlockScope, written: boolean): void {
  const all = splitLines(body);
  const wanted = blockLabel(blockStart(label, scope)) ?? '';
  const read = readBlocks(all);
  const blocks = read.blocks.filter((block) => block.label === wanted);
  const name = table === '' ? 'the top level' : `[${table}]`;
  const refuse = (message: string, fix: string): never => {
    throw Object.assign(new Error(message), { fix });
  };
  if (!written) {
    const left = blocks[0];
    if (left !== undefined) refuse(`the block depcurfew manages for ${name} is still there at line ${left.start + 1} after it was removed`, `Remove the lines from line ${left.start + 1} to the end of the block by hand, then run depcurfew apply again`);
    return;
  }
  const outside = read.outside ?? outsideValues(all);
  // A marker in a value is only a problem when the block apply wrote is not found outside values.
  if (blocks.length !== 1) {
    const hidden = all.findIndex((line, index) => outside[index] !== true && blockLabel(line) === wanted);
    if (hidden !== -1) {
      const start = valueStart(outside, hidden) + 1;
      refuse(`the block depcurfew manages for ${name} would be inside the value that starts at line ${start}, where tools read it as text`, `Move the settings of ${name} out of the value that starts at line ${start}, then run depcurfew apply again`);
    }
  }
  const block = blocks[0];
  if (block === undefined) return refuse(`the block depcurfew manages for ${name} is missing after the edit`, `Add the settings by hand, then run depcurfew apply again`);
  if (blocks.length > 1) refuse(`the block depcurfew manages for ${name} is there more than once, at lines ${blocks.map((item) => item.start + 1).join(', ')}`, `Keep one of the blocks, then run depcurfew apply again`);
  if (block.end === undefined) refuse(`the block depcurfew manages for ${name} at line ${block.start + 1} has no end marker`, `Add the line "${BLOCK_END}" after its settings, then run depcurfew apply again`);
  // The table of the block: the nearest header above it on a line outside values (a header cannot sit in a value).
  let found = '';
  for (let index = block.start - 1; index >= 0; index--) {
    if (outside[index] !== true) continue;
    const header = headerOf(all[index] ?? '');
    if (header !== undefined) {
      found = header.name;
      break;
    }
  }
  if (found !== table) {
    const tool = table === '' ? 'the tool' : TABLE_TOOLS.find(([prefix]) => table === prefix || table.startsWith(`${prefix}.`))?.[1] ?? 'the tool';
    refuse(`the block depcurfew manages for ${name} would be in ${found === '' ? 'the top level' : `[${found}]`} at line ${block.start + 1}, where ${tool} does not read it`, `Move the block under ${table === '' ? 'the top level, before the first table' : `the [${table}] header`}, then run depcurfew apply again`);
  }
}

/** Which tool reads a table of pyproject.toml, for the message of checkTomlBlock. */
const TABLE_TOOLS: readonly [string, string][] = [
  ['tool.uv', 'uv'],
  ['tool.poetry', 'Poetry'],
  ['tool.pdm', 'PDM'],
];

/**
 * Lines apply commented out in this table (and the dotted keys and subtables of it) come back as they were, every
 * line of the value, when the policy no longer manages their key. Lines commented out in other tables stay.
 */
function restoreLines(lines: string[], table: string, isManaged: (key: string) => boolean): void {
  const topLevel = table === '';
  const prefix = topLevel ? '' : `${table}.`;
  let current: string | undefined;
  // After a header apply commented out: 'restored' when it came back, 'kept' when it stays commented out.
  let section: 'table' | 'restored' | 'kept' = 'table';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const header = headerOf(line);
    if (header !== undefined) {
      current = header.name;
      section = 'table';
      continue;
    }
    const original = commentedOut(line);
    if (original === undefined) {
      if (keyOf(line) !== undefined) index = valueEnd(lines, index);
      continue;
    }
    const noted = headerOf(original);
    if (noted !== undefined) {
      const name = noted.name;
      section = name.startsWith(prefix) && !isManaged(name.slice(prefix.length)) ? 'restored' : 'kept';
      if (section === 'restored') lines[index] = original;
      continue;
    }
    const key = keyOf(original);
    if (key === undefined || section === 'kept') continue;
    const dotted = !topLevel && current === undefined && key.startsWith(prefix);
    const inTable = topLevel ? current === undefined : current === table;
    if (section === 'table' && !((inTable && !isManaged(key)) || (dotted && !isManaged(key.slice(prefix.length))))) continue;
    lines[index] = original;
    // The other lines of the value were commented out with "# ".
    let state = scanLine(original.slice(original.indexOf('=') + 1), { depth: 0, string: '' });
    while ((state.depth > 0 || state.string !== '') && lines[index + 1]?.startsWith('# ') === true) {
      index += 1;
      lines[index] = (lines[index] ?? '').slice(2);
      state = scanLine(lines[index] ?? '', state);
    }
  }
}

export function writeTomlBlock(body: string, table: string, entries: readonly string[], managedKeys: readonly string[], label?: string, scope: BlockScope = 'project'): string {
  const edited = editTomlBlock(body, table, entries, managedKeys, label, scope);
  checkTomlBlock(edited, table, label, scope, entries.length > 0);
  return edited;
}

function editTomlBlock(body: string, table: string, entries: readonly string[], managedKeys: readonly string[], label: string | undefined, scope: BlockScope): string {
  const managed = new Set(managedKeys);
  const marker = blockStart(label, scope);
  const removed = removeOwnBlock(splitLines(body), table, label);
  const lines = [...removed.lines];
  const topLevel = table === '';
  // A top-level block at the start of the file may be followed by the blank line topBlock adds before a table: when
  // the block goes away, that blank line goes with it.
  if (topLevel && entries.length === 0 && removed.at === 0 && lines[0]?.trim() === '') lines.shift();
  // Tables by the line of their header; array-of-tables headers ([[...]]) only end the table before them.
  const headers = new Map<number, string>();
  const boundaries: number[] = [];
  let current: string | undefined;
  // Keys at the top level that define the table (install.key = ..., install = { ... }) and stay after this edit.
  let definedAtTop = false;
  // A managed key may also be written as a dotted key (key.sub = ...) or as a table of its own ([table.key]).
  const isManaged = (key: string) => managed.has(key) || [...managed].some((name) => key.startsWith(`${name}.`));
  restoreLines(lines, table, isManaged);
  const prefix = topLevel ? '' : `${table}.`;
  const note = entries.length === 0 ? TURNED_OFF : SUPERSEDED;
  let inManagedTable = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const header = headerOf(line);
    if (header !== undefined) {
      const name = header.name;
      inManagedTable = name.startsWith(prefix) && isManaged(name.slice(prefix.length));
      if (inManagedTable) {
        lines[index] = `${note}${line.trim()}`;
        continue;
      }
      current = name;
      boundaries.push(index);
      if (!header.array) headers.set(index, current);
      continue;
    }
    const key = keyOf(line);
    if (key === undefined) continue;
    const end = valueEnd(lines, index);
    const inTable = (topLevel ? current === undefined : current === table) && isManaged(key);
    const dotted = !topLevel && current === undefined && key.startsWith(`${table}.`) && isManaged(key.slice(table.length + 1));
    if (inManagedTable || inTable || dotted) {
      lines[index] = `${note}${line.trim()}`;
      for (let next = index + 1; next <= end; next++) lines[next] = `# ${lines[next] ?? ''}`;
    } else if (!topLevel && current === undefined && (key === table || key.startsWith(`${table}.`) || table.startsWith(`${key}.`))) {
      definedAtTop = true;
    }
    index = end;
  }
  if (entries.length === 0) return joinLines(withoutCreatedTable(lines, table, removed));

  if (topLevel) {
    const firstTable = boundaries[0] ?? lines.length;
    if (removed.at !== undefined && removed.at <= firstTable) return joinLines(topBlock(lines, removed.at, entries, removed.separated, marker));
    let end = firstTable;
    while (end > 0 && lines[end - 1]?.trim() === '') end -= 1;
    return joinLines(topBlock(lines, end, entries, undefined, marker));
  }

  const headerIndex = [...headers].find(([, name]) => name === table)?.[0] ?? -1;
  const nextHeaderAfter = (from: number) => boundaries.find((index) => index > from) ?? -1;
  if (headerIndex === -1) {
    if (definedAtTop) {
      throw new Error(`${table} is defined with dotted keys or an inline table, so a [${table}] table cannot be added; move its settings under a [${table}] header`);
    }
    const prefix = lines.length > 0 && lines.at(-1)?.trim() !== '' ? [...lines, ''] : lines;
    return joinLines([...prefix, `[${table}]`, ...insertBlock([], 0, entries, undefined, marker)]);
  }
  if (removed.at !== undefined && removed.at > headerIndex) {
    const nextHeader = nextHeaderAfter(headerIndex);
    if (nextHeader === -1 || removed.at <= nextHeader) return joinLines(insertBlock(lines, removed.at, entries, removed.separated, marker));
  }
  let end = nextHeaderAfter(headerIndex);
  if (end === -1) end = lines.length;
  while (end > headerIndex + 1 && lines[end - 1]?.trim() === '') end -= 1;
  return joinLines(insertBlock(lines, end, entries, undefined, marker));
}

/**
 * The table apply created for its block goes away with the block when nothing else is in it (decision D-116). apply
 * writes such a table as its header with the block right below it, and the blank line before the header; a block it
 * added to a table that was there follows a blank line after the header, which removeBlockAt reports as `separated`.
 * So a table with anything else in it, with a comment on its header line, or with the block apart from the header, is
 * the user's and stays, also when it is empty.
 */
function withoutCreatedTable(lines: string[], table: string, removed: RemovedBlock): string[] {
  const at = removed.at;
  if (table === '' || at === undefined || removed.separated || at === 0) return lines;
  const header = at - 1;
  if (lines[header]?.trim() !== `[${table}]`) return lines;
  let end = at;
  while (end < lines.length && !isHeader(lines[end] ?? '')) {
    if ((lines[end] ?? '').trim() !== '') return lines;
    end += 1;
  }
  const rest = [...lines.slice(0, header), ...lines.slice(at)];
  // The blank line apply wrote before the header goes too, unless it now separates the content before from a header.
  if (header > 0 && rest[header - 1]?.trim() === '' && (header === rest.length || rest[header]?.trim() === '')) rest.splice(header - 1, 1);
  return rest;
}

/**
 * A top-level block, with a blank line before a table header that follows it right away. A key that follows it stays
 * where it is, so that a second run changes nothing.
 */
function topBlock(lines: string[], at: number, entries: readonly string[], separate: boolean | undefined, marker: string): string[] {
  const result = insertBlock(lines, at, entries, separate, marker);
  const after = at + (result.length - lines.length);
  if (isHeader(result[after] ?? '')) result.splice(after, 0, '');
  return result;
}
