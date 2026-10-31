// Managed blocks for line-based formats (INI and TOML), marked so that depcurfew can find and replace them.

export const BLOCK_START = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead';
/** The start marker in user-level files, which apply --user writes from the user policy. */
export const USER_BLOCK_START = '# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead';
export const BLOCK_END = '# <<< depcurfew managed block';
export const SUPERSEDED = '# depcurfew: superseded by the managed block: ';
/** For a managed key commented out when no block is written, such as a switch the policy turns off. */
export const TURNED_OFF = '# depcurfew: turned off; depcurfew.json manages this setting: ';

/** Which policy writes a block: a project's depcurfew.json, or the user policy (apply --user). */
export type BlockScope = 'project' | 'user';

/** The start marker of a managed block; a file with one block per TOML table names the table in each marker. */
export function blockStart(table?: string, scope: BlockScope = 'project'): string {
  const marker = scope === 'user' ? USER_BLOCK_START : BLOCK_START;
  return table === undefined ? marker : marker.replace(': ', ` [${table}]: `);
}

const PREFIX = '# >>> depcurfew managed block';
const TEXTS: readonly string[] = [BLOCK_START, USER_BLOCK_START].map((marker) => marker.slice(PREFIX.length));

/** The table a start marker names ('' for none), whichever policy wrote it; undefined when the line starts no block. */
export function blockLabel(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PREFIX)) return undefined;
  let rest = trimmed.slice(PREFIX.length);
  const labeled = /^ \[([^\]]*)\]/u.exec(rest);
  if (labeled !== null) rest = rest.slice(labeled[0].length);
  return TEXTS.includes(rest) ? (labeled?.[1] ?? '') : undefined;
}

export function isBlockStart(line: string): boolean {
  return blockLabel(line) !== undefined;
}

/** The original line, when `line` is one that apply commented out (superseded or turned off). */
export function commentedOut(line: string): string | undefined {
  const trimmed = line.trimStart();
  for (const note of [SUPERSEDED, TURNED_OFF]) if (trimmed.startsWith(note)) return trimmed.slice(note.length);
  return undefined;
}

/** Whether apply wrote anything into the text: a managed block, or a line it commented out. */
export function hasManagedLines(body: string): boolean {
  return splitLines(body).some((line) => isBlockStart(line) || commentedOut(line) !== undefined);
}

export interface RemovedBlock {
  lines: string[];
  /** Where the (first) block was. */
  at: number | undefined;
  /** Whether a blank line separated it from what came before. */
  separated: boolean;
}

/** The lines without the block that starts at line `start`. */
export function removeBlockAt(lines: readonly string[], start: number): RemovedBlock {
  const end = lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END);
  const stop = end === -1 ? start : end;
  const rest = [...lines.slice(0, start), ...lines.slice(stop + 1)];
  // Drop the blank line that separated the block from the content before it; insertBlock adds one after any
  // non-blank line, also when a blank line follows the block (a block at the end of a table in the middle of a file).
  let at = start;
  let separated = false;
  if (at > 0 && rest[at - 1]?.trim() === '') {
    rest.splice(at - 1, 1);
    at -= 1;
    separated = true;
  }
  return { lines: rest, at, separated };
}

/**
 * The lines without the managed block, and without every copy of it when it is there more than once. A block is the
 * same when its marker names the same table, whichever policy wrote it.
 */
export function removeBlock(lines: readonly string[], marker = BLOCK_START): RemovedBlock {
  const label = blockLabel(marker);
  const isStart = (line: string) => blockLabel(line) === label;
  const start = lines.findIndex(isStart);
  if (start === -1) return { lines: [...lines], at: undefined, separated: false };
  const first = removeBlockAt(lines, start);
  let rest = first.lines;
  for (let next = rest.findIndex(isStart); next !== -1; next = rest.findIndex(isStart)) {
    rest = removeBlockAt(rest, next).lines;
  }
  return { lines: rest, at: Math.min(first.at ?? 0, rest.length), separated: first.separated };
}

export function blockLines(entries: readonly string[], marker = BLOCK_START): string[] {
  return [marker, ...entries, BLOCK_END];
}

export function splitLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Inserts the block at `at`; a new block is separated by a blank line from preceding content. */
export function insertBlock(lines: string[], at: number, entries: readonly string[], separate?: boolean, marker = BLOCK_START): string[] {
  const block = blockLines(entries, marker);
  const before = lines.slice(0, at);
  if ((separate ?? true) && before.length > 0 && before.at(-1)?.trim() !== '') block.unshift('');
  return [...before, ...block, ...lines.slice(at)];
}
