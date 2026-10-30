// .npmrc: settings that depcurfew manages live in one marked block. The same keys set elsewhere are commented out
// (with a note) rather than deleted, because npm would otherwise use whichever value it reads last. A line commented
// out so comes back as it was once the policy no longer manages its key.
import { commentedOut, insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED, TURNED_OFF } from './block.ts';

function keyOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return undefined;
  const equals = trimmed.indexOf('=');
  if (equals === -1) return undefined;
  return trimmed.slice(0, equals).trim().replace(/\[\]$/u, '');
}

export function writeIniBlock(body: string, entries: readonly string[], managedKeys: readonly string[]): string {
  const managed = new Set(managedKeys);
  const removed = removeBlock(splitLines(body));
  const lines = removed.lines.map((line) => {
    const original = commentedOut(line);
    if (original !== undefined) return managed.has(keyOf(original) ?? '') ? line : original;
    const key = keyOf(line);
    return key !== undefined && managed.has(key) ? `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  return joinLines(
    removed.at === undefined ? insertBlock(lines, lines.length, entries) : insertBlock(lines, removed.at, entries, removed.separated),
  );
}
