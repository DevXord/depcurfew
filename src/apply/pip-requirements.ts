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
  let at = 0;
  while (at < removed.lines.length && (removed.lines[at]?.trim().startsWith('#') ?? false)) at += 1;
  const lines = removed.lines.map((line) => {
    const option = optionOf(line);
    return option !== undefined && managed.has(option) ? `${SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  // Only a blank line before the block is added, which removing the block takes away again.
  return joinLines(insertBlock(lines, removed.at ?? at, entries, removed.at === undefined ? undefined : removed.separated));
}
