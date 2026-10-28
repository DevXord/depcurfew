// bunfig.toml: the managed block goes at the end of one table (e.g. [install]); TOML forbids defining a table
// twice, so the block cannot simply be appended with its own header. Managed keys set elsewhere in that table,
// or as dotted keys (install.key = ...) outside it, are commented out with a note.
import { insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED } from './block.ts';

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u;

function keyOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) return undefined;
  const equals = trimmed.indexOf('=');
  if (equals === -1) return undefined;
  return trimmed.slice(0, equals).trim().replace(/^["']|["']$/gu, '');
}

export function writeTomlBlock(body: string, table: string, entries: readonly string[], managedKeys: readonly string[]): string {
  const managed = new Set(managedKeys);
  const removed = removeBlock(splitLines(body));
  let current: string | undefined;
  const lines = removed.lines.map((line) => {
    const header = HEADER.exec(line);
    if (header !== null) {
      current = header[1];
      return line;
    }
    const key = keyOf(line);
    if (key === undefined) return line;
    const inTable = current === table && managed.has(key);
    const dotted = current === undefined && key.startsWith(`${table}.`) && managed.has(key.slice(table.length + 1));
    return inTable || dotted ? `${SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);

  const headerIndex = lines.findIndex((line) => HEADER.exec(line)?.[1] === table && !line.trim().startsWith('[['));
  if (headerIndex === -1) {
    const prefix = lines.length > 0 && lines.at(-1)?.trim() !== '' ? [...lines, ''] : lines;
    return joinLines([...prefix, `[${table}]`, ...insertBlock([], 0, entries)]);
  }
  if (removed.at !== undefined && removed.at > headerIndex) {
    const nextHeader = lines.findIndex((line, index) => index > headerIndex && HEADER.test(line));
    if (nextHeader === -1 || removed.at <= nextHeader) return joinLines(insertBlock(lines, removed.at, entries, removed.separated));
  }
  let end = lines.findIndex((line, index) => index > headerIndex && HEADER.test(line));
  if (end === -1) end = lines.length;
  while (end > headerIndex + 1 && lines[end - 1]?.trim() === '') end -= 1;
  return joinLines(insertBlock(lines, end, entries));
}
