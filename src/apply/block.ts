// Managed blocks for line-based formats (INI and TOML), marked so that depcurfew can find and replace them.

export const BLOCK_START = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead';
export const BLOCK_END = '# <<< depcurfew managed block';
export const SUPERSEDED = '# depcurfew: superseded by the managed block: ';
/** For a managed key commented out when no block is written, such as a switch the policy turns off. */
export const TURNED_OFF = '# depcurfew: turned off; depcurfew.json manages this setting: ';

/** The start marker of a managed block; a file with one block per TOML table names the table in each marker. */
export function blockStart(table?: string): string {
  return table === undefined ? BLOCK_START : BLOCK_START.replace(': ', ` [${table}]: `);
}

const LABELED_START = new RegExp(`^${BLOCK_START.replace(': ', ' \\[[^\\]]*\\]: ').replace(/[.]/gu, '\\.')}$`, 'u');

export function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === BLOCK_START || LABELED_START.test(trimmed);
}

/** The lines without the managed block, where it was, and whether a blank line separated it from what came before. */
export function removeBlock(lines: readonly string[], marker = BLOCK_START): { lines: string[]; at: number | undefined; separated: boolean } {
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) return { lines: [...lines], at: undefined, separated: false };
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
