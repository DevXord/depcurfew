// .bundle/config and the values of BUNDLE_COOLDOWN read as Bundler reads them (decision D-159). Bundler does not read
// .bundle/config as YAML but with Gem::YAMLSerializer, a line reader that keeps quotes unless a value starts and ends
// with the same one and cuts a value at its first # (extra.configFormat), and reads the number settings with Ruby's
// String#to_i (extra.stringToInteger). Reading the file with a YAML library gives other values: ~, null and true are
// no text there, and "14" # two weeks is 14 for YAML but the text "14" with its quotes, so 0, for Bundler.
import { extraOf, isRecord } from '../apply/facts.ts';
import { bundler } from '../knowledge/bundler.ts';

interface ConfigFormat {
  comment: string;
  quotes: string[];
  indentPerLevel: number;
}

interface IntegerText {
  whitespace: string[];
  signs: string[];
  prefix: string;
  separator: string;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const FORMAT = extraOf(bundler, 'configFormat', (value): value is ConfigFormat => isRecord(value) && typeof value['comment'] === 'string' && isStrings(value['quotes']) && typeof value['indentPerLevel'] === 'number');
const INTEGER = extraOf(
  bundler,
  'stringToInteger',
  (value): value is IntegerText => isRecord(value) && isStrings(value['whitespace']) && isStrings(value['signs']) && typeof value['prefix'] === 'string' && typeof value['separator'] === 'string',
);
const WHITESPACE = new Set(INTEGER.whitespace);

/** Ruby's \s and ISSPACE. */
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

/** Ruby's String#strip: whitespace and NUL at both ends. */
function strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (isSpace(text[start]) || text[start] === '\0')) start++;
  while (end > start && (isSpace(text[end - 1]) || text[end - 1] === '\0')) end--;
  return text.slice(start, end);
}

/**
 * String#to_i of a text: leading whitespace, one sign, an optional 0d, then decimal digits with single underscores
 * between them; 0 without a digit. "0x10" is 0, "1e3" is 1, "0d14" is 14.
 */
export function rubyToI(text: string): number {
  let at = 0;
  while (at < text.length && WHITESPACE.has(text[at] ?? '')) at++;
  let sign = 1;
  const signChar = text[at] ?? '';
  if (INTEGER.signs.includes(signChar)) {
    if (signChar === '-') sign = -1;
    at++;
  }
  if (text.length - at > INTEGER.prefix.length && text.slice(at, at + INTEGER.prefix.length).toLowerCase() === INTEGER.prefix) at += INTEGER.prefix.length;
  let digits = '';
  let previous = '';
  for (; at < text.length; at++) {
    const c = text[at] ?? '';
    if (c >= '0' && c <= '9') digits += c;
    else if (c !== INTEGER.separator || previous === INTEGER.separator || previous === '') break;
    previous = c;
  }
  return digits === '' ? 0 : sign * Number(digits);
}

/** A line as HASH_REGEX of Gem::YAMLSerializer reads it: the key, the value without matching quotes, and its depth. */
function hashLine(line: string): { indent: number; key: string; quoted: boolean; value: string } | undefined {
  let spaces = 0;
  while (line[spaces] === ' ') spaces++;
  const hash = line.indexOf(FORMAT.comment, spaces);
  const limit = hash === -1 ? line.length : hash;
  const qualifies = (at: number) => line[at] === ':' && (at + 1 === line.length || isSpace(line[at + 1]));
  // The key is [^#]+, greedy: it ends at the last colon before the first # that is followed by whitespace or the end.
  let colon = -1;
  for (let at = limit - 1; at > spaces; at--) {
    if (qualifies(at)) {
      colon = at;
      break;
    }
  }
  let indent = spaces;
  if (colon === -1) {
    // A colon right after the indentation: the regex gives one space back to the key.
    if (spaces === 0 || !qualifies(spaces) || limit <= spaces) return undefined;
    colon = spaces;
    indent = spaces - 1;
  }
  let rest = line.slice(colon + 1);
  if (rest.startsWith(' ')) rest = rest.slice(1);
  const quote = rest[0] ?? '';
  const quoted = FORMAT.quotes.includes(quote) && rest.length >= 2 && rest.endsWith(quote);
  return { indent, key: line.slice(indent, colon), quoted, value: quoted ? rest.slice(1, -1) : rest };
}

/** A line as ARRAY_REGEX reads it: "- value". */
function arrayLine(line: string): string | undefined {
  let spaces = 0;
  while (line[spaces] === ' ') spaces++;
  if (line[spaces] !== '-' || line[spaces + 1] !== ' ') return undefined;
  const rest = line.slice(spaces + 2);
  const quote = rest[0] ?? '';
  return FORMAT.quotes.includes(quote) && rest.length >= 2 && rest.endsWith(quote) ? rest.slice(1, -1) : rest;
}

/** strip_comment: a value is cut at its first # unless it starts with one. */
function stripComment(value: string): string {
  return value.includes(FORMAT.comment) && !value.startsWith(FORMAT.comment) ? strip(value.slice(0, value.indexOf(FORMAT.comment))) : value;
}

type Entry = { kind: 'text'; value: string; line: number } | { kind: 'map'; map: Map<string, Entry>; line: number } | { kind: 'list'; line: number };

/** What Bundler reads for a top-level key of .bundle/config. */
export type BundleConfigValue =
  /** The text Bundler takes, with the 1-based line it comes from and that line as written. */
  | { kind: 'text'; value: string; line: number; written: string }
  /** A map or a list: Bundler stops with an error when it reads the setting. */
  | { kind: 'other'; line: number; written: string };

/**
 * The value of a top-level key of .bundle/config as Bundler reads it: the last line of the key wins; 'error' when the
 * reader fails on the file (a line deeper than any map, a list item before a key), which stops every bundle command.
 */
export function bundleConfigValue(text: string, key: string): BundleConfigValue | 'error' | undefined {
  const lines = text.split(/\r?\n/u);
  const top = new Map<string, Entry>();
  const stack: (Map<string, Entry> | undefined)[] = [top];
  let lastHash: Map<string, Entry> | undefined;
  let lastKey = '';
  for (const [index, line] of lines.entries()) {
    const hash = hashLine(line);
    if (hash !== undefined) {
      const value = stripComment(hash.value);
      const target = stack[Math.floor(hash.indent / FORMAT.indentPerLevel)];
      if (target === undefined) return 'error';
      if (!hash.quoted && value === '') {
        const map = new Map<string, Entry>();
        target.set(hash.key, { kind: 'map', map, line: index + 1 });
        stack[Math.floor(hash.indent / FORMAT.indentPerLevel) + 1] = map;
        lastKey = hash.key;
        lastHash = target;
      } else {
        target.set(hash.key, value === '[]' ? { kind: 'list', line: index + 1 } : { kind: 'text', value, line: index + 1 });
      }
      continue;
    }
    const item = arrayLine(line);
    if (item === undefined) continue;
    if (lastHash === undefined) return 'error';
    lastHash.set(lastKey, { kind: 'list', line: lastHash.get(lastKey)?.line ?? index + 1 });
  }
  // load_config replaces . in keys with __; a key that has none is the setting only when spelled exactly so.
  const entry = [...top].findLast(([name]) => name.replaceAll('.', '__') === key)?.[1];
  if (entry === undefined) return undefined;
  const written = lines[entry.line - 1] ?? '';
  return entry.kind === 'text' ? { kind: 'text', value: entry.value, line: entry.line, written } : { kind: 'other', line: entry.line, written };
}
