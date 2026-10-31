// pip requirements files: option lines such as --only-binary=:all: in a managed block. pip applies --only-binary
// and --no-binary lines in order, so the block keeps them together and the same options elsewhere are commented
// out (and come back once the policy no longer manages them); the block goes after the comments that open the file
// (a generated file's header stays first).
import { expandRequirementsOption } from '../doctor/python.ts';
import { commentedOut, insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED } from './block.ts';

/**
 * `longOptions` are those of pip's requirements parser (extra.requirementsParser): pip takes an unambiguous prefix of
 * one (--no-bin for --no-binary), so a managed option is recognized in that form too.
 */
export function writeRequirementsBlock(body: string, entries: readonly string[], managedOptions: readonly string[], longOptions: readonly string[] = []): string {
  // The option a requirements line sets (--only-binary=x and --only-binary x alike), if it is an option line.
  const optionOf = (line: string): string | undefined => {
    const option = /^\s*(--[a-z-]+)(?=[=\s]|$)/u.exec(line)?.[1];
    return option === undefined ? undefined : expandRequirementsOption(option, longOptions);
  };
  const managed = new Set(managedOptions);
  const removed = removeBlock(splitLines(body));
  let at = 0;
  while (at < removed.lines.length && (removed.lines[at]?.trim().startsWith('#') ?? false)) at += 1;
  const lines = removed.lines.map((line) => {
    const original = commentedOut(line);
    if (original !== undefined) return managed.has(optionOf(original) ?? '') ? line : original;
    const option = optionOf(line);
    return option !== undefined && managed.has(option) ? `${SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  // Only a blank line before the block is added, which removing the block takes away again.
  return joinLines(insertBlock(lines, removed.at ?? at, entries, removed.at === undefined ? undefined : removed.separated));
}
