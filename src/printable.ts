// Text for people that carries something from a repository or a registry (file and package names, configuration keys
// and values, deprecation messages, install scripts) shows control characters as visible text, so that a crafted name
// cannot move the cursor, clear a line, set the window title or show a fake link (ANSI and OSC sequences) in a
// terminal or a CI log. Bidirectional controls (U+202E and the like) are written as \uHHHH too, so that a name cannot
// be shown in another order than it has (Trojan Source). JSON and SARIF need nothing of this: JSON.stringify escapes
// control characters itself.

/** C0 controls but tab, DEL and C1 controls; with `lines`, line feeds stay too. */
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/gu;
const CONTROLS_BUT_LINE_FEEDS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
/** The Unicode bidirectional formatting characters: ALM, LRM, RLM, LRE to RLO, LRI to PDI. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * The text with every control character but tab written as `\xHH`, e.g. ESC as `\x1b`. Line breaks are control
 * characters too, so a value from a file cannot start a line of its own; `lines: true` keeps line feeds, for text
 * depcurfew lays out in lines itself, such as a snippet to add by hand. Apply it before adding colors.
 */
export function printable(text: string, options: { lines?: boolean } = {}): string {
  return text
    .replace(options.lines === true ? CONTROLS_BUT_LINE_FEEDS : CONTROLS, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(BIDI, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
