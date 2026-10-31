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

/** A [section] header as npm's ini parser reads it (extra.npmrcFormat): the keys below it are not npm settings. */
const SECTION = /^\[[^\]]*\]\s*$/u;

export function writeIniBlock(body: string, entries: readonly string[], managedKeys: readonly string[]): string {
  const managed = new Set(managedKeys);
  const removed = removeBlock(splitLines(body));
  // npm applies only the keys above the first section header, so the block goes there (also when an older apply
  // appended it below a header), and keys of a section are other settings, left alone.
  const header = removed.lines.findIndex((line) => SECTION.test(line));
  const topLevel = header === -1 ? removed.lines.length : header;
  const lines = removed.lines.map((line, index) => {
    const original = commentedOut(line);
    // A key commented out below a section header (by an older apply) is another setting: it comes back.
    if (original !== undefined) return index < topLevel && managed.has(keyOf(original) ?? '') ? line : original;
    const key = index < topLevel ? keyOf(line) : undefined;
    return key !== undefined && managed.has(key) ? `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  if (removed.at !== undefined && removed.at <= topLevel) return joinLines(insertBlock(lines, removed.at, entries, removed.separated));
  // A new block goes above the comment lines that introduce the first section (not above keys it commented out).
  const introduces = (line: string) => /^\s*[#;]/u.test(line) && !line.startsWith(SUPERSEDED) && !line.startsWith(TURNED_OFF);
  let at = topLevel;
  while (header !== -1 && at > 0 && introduces(lines[at - 1] ?? '')) at -= 1;
  // Above the blank lines before them too, so that they stay the user's: removing the block later takes only the
  // blank line insertBlock adds before it.
  while (header !== -1 && at > 0 && (lines[at - 1] ?? '').trim() === '') at -= 1;
  return joinLines(insertBlock(lines, at, entries));
}
