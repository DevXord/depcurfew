// .npmrc: settings that depcurfew manages live in one marked block. The same keys set elsewhere are commented out
// (with a note) rather than deleted, because npm would otherwise use whichever value it reads last. A line commented
// out so comes back as it was once the policy no longer manages its key.
import { iniLine } from '../doctor/settings.ts';
import { BLOCK_START, commentedOut, insertBlock, joinLines, removeBlock, splitLines, SUPERSEDED, TURNED_OFF } from './block.ts';

/**
 * The setting a line sets, read as npm reads it, with the reader doctor uses (extra.npmrcFormat): quotes removed,
 * a key without = included, a trailing comment cut off; `key[]` as `key`.
 */
function keyOf(line: string): string | undefined {
  const parsed = iniLine(line);
  return parsed === undefined || 'section' in parsed ? undefined : parsed.key.replace(/\[\]$/u, '');
}

/** A [section] header as npm's ini reads it (extra.npmrcFormat): the keys below it are not npm settings. */
function isSection(line: string): boolean {
  const parsed = iniLine(line);
  return parsed !== undefined && 'section' in parsed;
}

/**
 * The parts of a line that npm reads as lines of their own. Editors get text with LF line endings, so a carriage
 * return left in a line is one npm's ini also breaks lines at.
 */
function parts(line: string): string[] {
  return line.split('\r');
}

export function writeIniBlock(body: string, entries: readonly string[], managedKeys: readonly string[], marker = BLOCK_START): string {
  const managed = new Set(managedKeys);
  const removed = removeBlock(splitLines(body));
  // npm applies only the keys above the first section header, so the block goes there (also when an older apply
  // appended it below a header), and keys of a section are other settings, left alone.
  const header = removed.lines.findIndex((line) => parts(line).some(isSection));
  const topLevel = header === -1 ? removed.lines.length : header;
  let inSection = false;
  const lines = removed.lines.map((line) =>
    parts(line)
      .map((part) => {
        if (isSection(part)) inSection = true;
        const original = commentedOut(part);
        // A key commented out below a section header (by an older apply) is another setting: it comes back.
        if (original !== undefined) return !inSection && managed.has(keyOf(original) ?? '') ? part : original;
        const key = inSection ? undefined : keyOf(part);
        return key !== undefined && managed.has(key) ? `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${part.trim()}` : part;
      })
      .join('\r'),
  );
  if (entries.length === 0) return joinLines(lines);
  if (removed.at !== undefined && removed.at <= topLevel) return joinLines(insertBlock(lines, removed.at, entries, removed.separated, marker));
  // A new block goes above the comment lines that introduce the first section (not above keys it commented out).
  const introduces = (line: string) => /^\s*[#;]/u.test(line) && !line.startsWith(SUPERSEDED) && !line.startsWith(TURNED_OFF);
  let at = topLevel;
  while (header !== -1 && at > 0 && introduces(lines[at - 1] ?? '')) at -= 1;
  // Above the blank lines before them too, so that they stay the user's: removing the block later takes only the
  // blank line insertBlock adds before it.
  while (header !== -1 && at > 0 && (lines[at - 1] ?? '').trim() === '') at -= 1;
  return joinLines(insertBlock(lines, at, entries, undefined, marker));
}
