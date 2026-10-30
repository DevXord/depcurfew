// pip requirements files: option lines such as --only-binary=:all: in a managed block. pip applies --only-binary
// and --no-binary lines in order, so the block keeps them together and the same options elsewhere are commented
// out; the block goes after the comments that open the file (a generated file's header stays first).
import { insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED } from './block.ts';

/** The option a requirements line sets (--only-binary=x and --only-binary x alike), if it is an option line. */
function optionOf(line: string): string | undefined {
  return /^\s*(--[a-z-]+)(?=[=\s]|$)/u.exec(line)?.[1];
}

export function writeRequirementsBlock(body: string, entries: readonly string[], managedOptions: readonly string[]): string {
  const managed = new Set(managedOptions);
  const removed = removeBlock(splitLines(body));
  const lines = removed.lines.map((line) => {
    const option = optionOf(line);
    return option !== undefined && managed.has(option) ? `${SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  if (removed.at !== undefined) return joinLines(insertBlock(lines, removed.at, entries, removed.separated));
  let at = 0;
  while (at < lines.length && (lines[at]?.trim().startsWith('#') ?? false)) at += 1;
  const result = insertBlock(lines, at, entries);
  const after = at + (result.length - lines.length);
  // Keep the block apart from the requirements that follow it.
  if (result[after] !== undefined && result[after]?.trim() !== '') result.splice(after, 0, '');
  return joinLines(result);
}
