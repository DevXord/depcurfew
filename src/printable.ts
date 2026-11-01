// Text for people that carries something from a repository or a registry (file and package names, configuration keys
// and values, deprecation messages, install scripts) shows control characters as visible text, so that a crafted name
// cannot move the cursor, clear a line, set the window title or show a fake link (ANSI and OSC sequences) in a
// terminal or a CI log. Bidirectional controls (U+202E and the like) are written as \uHHHH too, so that a name cannot
// be shown in another order than it has (Trojan Source), and so are the other invisible characters (zero-width
// characters, tag characters, variation selectors), which can hide text from a person that a model still reads. JSON
// and SARIF go through safeJson instead (src/json-safe.ts).

/** C0 controls but tab, DEL and C1 controls; with `lines`, line feeds stay too. */
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/gu;
const CONTROLS_BUT_LINE_FEEDS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
/**
 * Characters that change how text is shown or read without being seen: the format characters (\p{Cf}: the
 * bidirectional controls ALM, LRM, RLM, LRE to RLO and LRI to PDI, zero-width space, joiners, word joiner, invisible
 * operators, the byte order mark, the soft hyphen, the tag characters U+E0001 and U+E0020 to U+E007F), the rest of the
 * tag block (U+E0000 to U+E007F), whose characters spell hidden ASCII that a model may read, the variation selectors
 * (U+FE00 to U+FE0F, U+E0100 to U+E01EF), and letters that show as blank space: the Hangul fillers U+115F, U+1160,
 * U+3164 and U+FFA0 and the blank braille pattern U+2800, which can hide a word or pass for a space.
 */
export const INVISIBLE = /[\p{Cf}\u{e0000}-\u{e007f}\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u115f\u1160\u3164\uffa0\u2800]/gu;

/** The line and paragraph separators, which some viewers and parsers take as a line break. */
const LINE_SEPARATORS = /[\u2028\u2029]/gu;

/** A character of INVISIBLE as \uHHHH, or \u{HHHHH} beyond the BMP. */
function visible(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** The user name and password of a URL (scheme://user:password@host), anywhere in a text. */
const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu;

/**
 * The text with the user name and password of every URL in it left out (https://user:token@host/ becomes
 * https://host/): a registry URL from .npmrc may carry them, and depcurfew shows and sends no credentials.
 */
export function withoutCredentials(text: string): string {
  return text.replace(CREDENTIALS, '$1');
}

/** user:password@ whose password may hold an unencoded @, as in the diff of apply (src/apply/diff.ts). */
const USER_AND_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#]*@/giu;

/**
 * The text with the user name and password of every URL in it shown as <redacted> (https://user:token@host/ becomes
 * https://<redacted>@host/), as the diff of apply shows them: for messages, where people should see that a URL
 * carries credentials without seeing them. Use withoutCredentials for a URL that depcurfew sends anywhere.
 */
export function redactCredentials(text: string): string {
  return text.replace(USER_AND_PASSWORD, '$1<redacted>@').replace(CREDENTIALS, (whole, scheme: string) => (whole === `${scheme}<redacted>@` ? whole : `${scheme}<redacted>@`));
}

/**
 * The text with every control character but tab written as `\xHH`, e.g. ESC as `\x1b`, and every invisible
 * character (INVISIBLE) and the line and paragraph separators as `\uHHHH` or `\u{HHHHH}`. Line breaks are control
 * characters too, so a value from a file cannot start a line of its own; `lines: true` keeps line feeds, for text
 * depcurfew lays out in lines itself, such as a snippet to add by hand. Apply it before adding colors.
 */
export function printable(text: string, options: { lines?: boolean } = {}): string {
  return text
    .replace(options.lines === true ? CONTROLS_BUT_LINE_FEEDS : CONTROLS, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(INVISIBLE, visible)
    .replace(LINE_SEPARATORS, visible);
}
