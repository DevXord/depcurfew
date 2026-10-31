// JSON for stdout (apply, explain, check, doctor --json and --sarif) that a terminal or a log viewer cannot be tricked
// by. JSON.stringify escapes C0 controls, but keeps C1 controls (U+0080 to U+009F, which some terminals take as the
// start of an escape sequence), the Unicode bidirectional formatting characters (U+202E and the like, which show text
// in another order than it has) and the line and paragraph separators. Names and values from a repository or a
// registry can carry them, so they are written as \uHHHH escapes too, which every JSON parser reads back unchanged.

/** C1 controls, ALM, LRM, RLM, the line and paragraph separators, LRE to RLO and LRI to PDI. */
const UNSAFE = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** JSON.stringify(value, null, space) with the characters above escaped; they can only stand inside strings. */
export function safeJson(value: unknown, space?: string | number): string {
  return (JSON.stringify(value, null, space) ?? 'null').replace(UNSAFE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
