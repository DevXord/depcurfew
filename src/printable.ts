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

/** The user part of a URL in a text: from `start` (after ://) to the @ at `at`, with the scheme in lower case. */
interface UserPart {
  start: number;
  at: number;
  scheme: string;
}

/** A letter, digit, +, - or . (RFC 3986: what a scheme is made of after its first letter). */
function schemeCharacter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e;
}

function letter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/** What ends the authority of a URL (WHATWG URL: /, ?, #, and \ for http and https), and whitespace, which ends a URL in text. */
function endsAuthority(code: number): boolean {
  return code === 0x2f || code === 0x3f || code === 0x23 || code === 0x5c || code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0x85 || code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0x3000 || code === 0xfeff || (code >= 0x2000 && code <= 0x200a);
}

/**
 * The user parts of the URLs in a text (decision D-168): after scheme://, everything up to the last @ before the
 * authority ends, as WHATWG URL (npm) and pip read a URL, so that a password with an unencoded @ is a user part to its
 * end, and a token alone (https://TOKEN@host) is one too; a URL written after another (a://b://TOKEN@host) counts
 * as one of its own. Linear in the length of the text: a scan forward stops at the / of the next ://, and a scan back
 * for its scheme at the start of the URL before it.
 */
function userParts(text: string): UserPart[] {
  const parts: UserPart[] = [];
  for (let from = 0; ; ) {
    const separator = text.indexOf('://', from);
    if (separator === -1) return parts;
    let begin = separator;
    while (begin > from && schemeCharacter(text.charCodeAt(begin - 1))) begin--;
    while (begin < separator && !letter(text.charCodeAt(begin))) begin++;
    const start = separator + 3;
    let at = -1;
    for (let end = start; end < text.length && !endsAuthority(text.charCodeAt(end)); end++) if (text.charCodeAt(end) === 0x40) at = end;
    if (begin < separator && at !== -1) parts.push({ start, at, scheme: text.slice(begin, separator).toLowerCase() });
    from = start;
  }
}

/** The text with each user part replaced by what `replace` makes of it (with the @ when it returns one). */
function replaceUserParts(text: string, replace: (part: UserPart, userinfo: string) => string): string {
  const parts = userParts(text);
  if (parts.length === 0) return text;
  let result = '';
  let last = 0;
  for (const part of parts) {
    result += text.slice(last, part.start) + replace(part, text.slice(part.start, part.at));
    last = part.at + 1;
  }
  return result + text.slice(last);
}

/**
 * The text with the user name and password of every URL in it left out (https://user:token@host/ becomes
 * https://host/): a registry URL from .npmrc may carry them, and depcurfew shows and sends no credentials.
 */
export function withoutCredentials(text: string): string {
  return replaceUserParts(text, () => '');
}

/** The text that stands for credentials in messages and diffs. */
const REDACTED = '<redacted>';

/**
 * The text with the user name and password of every URL in it shown as <redacted> (https://user:token@host/ becomes
 * https://<redacted>@host/), as the diff of apply shows them: for messages, where people should see that a URL
 * carries credentials without seeing them. A token alone counts as credentials too; only the login name of an ssh URL
 * without a password (git+ssh://git@github.com) stays, since it is no secret and says which account the key is for.
 * Use withoutCredentials for a URL that depcurfew sends anywhere. printable and safeJson apply it to every text
 * depcurfew writes (decision D-168).
 */
export function redactCredentials(text: string): string {
  return replaceUserParts(text, (part, userinfo) => {
    if (userinfo === '' || userinfo === REDACTED) return `${userinfo}@`;
    if (part.scheme.split('+').includes('ssh') && !userinfo.includes(':')) return `${userinfo}@`;
    return `${REDACTED}@`;
  });
}

/**
 * The text with every control character but tab written as `\xHH`, e.g. ESC as `\x1b`, and every invisible
 * character (INVISIBLE) and the line and paragraph separators as `\uHHHH` or `\u{HHHHH}`. Line breaks are control
 * characters too, so a value from a file cannot start a line of its own; `lines: true` keeps line feeds, for text
 * depcurfew lays out in lines itself, such as a snippet to add by hand. The user name and password of a URL show as
 * <redacted> (redactCredentials, decision D-168). Apply it before adding colors.
 */
export function printable(text: string, options: { lines?: boolean } = {}): string {
  return redactCredentials(text)
    .replace(options.lines === true ? CONTROLS_BUT_LINE_FEEDS : CONTROLS, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(INVISIBLE, visible)
    .replace(LINE_SEPARATORS, visible);
}
