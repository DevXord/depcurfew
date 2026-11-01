// JSON for stdout (apply, explain, check, doctor --json and --sarif, depcurfew mcp) that a terminal, a log viewer or a
// model cannot be tricked by. JSON.stringify escapes C0 controls, but keeps C1 controls (U+0080 to U+009F, which some
// terminals take as the start of an escape sequence), the line and paragraph separators and the invisible characters
// of printable (src/printable.ts): bidirectional controls (U+202E and the like, which show text in another order than
// it has), zero-width characters, tag characters and variation selectors, which hide text from a person that a model
// still reads. Names and values from a repository or a registry can carry them, so they are written as \uHHHH escapes
// too (a surrogate pair beyond the BMP), which every JSON parser reads back unchanged.
import { INVISIBLE } from './printable.ts';

/** C1 controls, the line and paragraph separators, and the invisible characters of printable. */
const UNSAFE = new RegExp(`[\\u0080-\\u009f\\u2028\\u2029]|${INVISIBLE.source}`, 'gu');

function escaped(character: string): string {
  let text = '';
  for (let index = 0; index < character.length; index++) text += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
  return text;
}

/** JSON.stringify(value, null, space) with the characters above escaped; they can only stand inside strings. */
export function safeJson(value: unknown, space?: string | number): string {
  return (JSON.stringify(value, null, space) ?? 'null').replace(UNSAFE, escaped);
}
