// TOML files (bunfig.toml, uv.toml, pyproject.toml, poetry.toml): the managed block goes at the end of one table
// (e.g. [install] or [tool.uv]), or among the top-level keys before the first table when the table is ''. TOML
// forbids defining a table twice, so the block cannot simply be appended with its own header. Managed keys set
// elsewhere in that table, or as dotted keys (install.key = ...) outside it, are commented out with a note, every
// line of the value, and come back as they were once the policy no longer manages them. Values are followed across
// lines, so a line inside an array or a multi-line string is never taken for a key or a header. A file with blocks
// in several tables names the table in each block's marker.
import { blockLabel, blockStart, commentedOut, insertBlock, joinLines, removeBlock, removeBlockAt, splitLines, SUPERSEDED, TURNED_OFF, type BlockScope, type RemovedBlock } from './block.ts';

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

/** The table each line is in (undefined before the first table), following values over several lines. */
function tablesOf(lines: readonly string[]): (string | undefined)[] {
  const tables: (string | undefined)[] = [];
  let current: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const header = HEADER.exec(line);
    if (header !== null) current = header[1];
    tables[index] = current;
    if (header === null && keyOf(line) !== undefined) {
      const end = valueEnd(lines, index);
      for (let next = index + 1; next <= end; next++) tables[next] = current;
      index = end;
    }
  }
  return tables;
}

/**
 * Removes the block with this marker. A labeled block that is not there yet may have been written by an earlier
 * version without the label: an unlabeled block inside the same table is then taken for it.
 */
function removeOwnBlock(lines: readonly string[], table: string, label: string | undefined): RemovedBlock {
  const removed = removeBlock(lines, blockStart(label));
  if (removed.at !== undefined || label === undefined) return removed;
  const tables = tablesOf(lines);
  const legacy = lines.findIndex((line, index) => blockLabel(line) === '' && (tables[index] ?? '') === table);
  return legacy === -1 ? removed : removeBlockAt(lines, legacy);
}

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
    const header = HEADER.exec(line);
    if (header !== null) {
      current = header[1];
      section = 'table';
      continue;
    }
    const original = commentedOut(line);
    if (original === undefined) {
      if (keyOf(line) !== undefined) index = valueEnd(lines, index);
      continue;
    }
    const noted = HEADER.exec(original);
    if (noted !== null) {
      const name = noted[1] ?? '';
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
    const header = HEADER.exec(line);
    if (header !== null) {
      const name = header[1] ?? '';
      inManagedTable = name.startsWith(prefix) && isManaged(name.slice(prefix.length));
      if (inManagedTable) {
        lines[index] = `${note}${line.trim()}`;
        continue;
      }
      current = name;
      boundaries.push(index);
      if (!line.trim().startsWith('[[')) headers.set(index, current);
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
  while (end < lines.length && !HEADER.test(lines[end] ?? '')) {
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
  if (HEADER.test(result[after] ?? '')) result.splice(after, 0, '');
  return result;
}
