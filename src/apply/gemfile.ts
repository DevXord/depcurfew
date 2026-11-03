// The source calls of a Gemfile (or gems.rb), read and edited without running Ruby (decisions D-152 and D-159). The
// file is read as Ruby's lexer reads it (gemfile-scan.ts), so a line inside a string, a heredoc, a comment or after the
// end of the script is no call. apply edits only a plain call: source "<URL>" with a literal URL, optionally in
// parentheses, optionally with cooldown: <integer>, starting a statement on a line of its own, with nothing after it
// but a comment and no next line that continues it (.method). Any other form is reported, never edited, and a file the
// scanner does not read with certainty is not edited at all, so an edit cannot change how Ruby reads the rest.
import { scanRuby, type ScannedLine, type ScanToken, type ScanUnknown } from './gemfile-scan.ts';

/** A source call of a Gemfile. */
export interface GemfileSource {
  /** 1-based line of the call. */
  line: number;
  /** The URL when the first argument is a string literal whose value depcurfew reads. */
  url?: string;
  /** The cooldown: keyword: its days when they are a Ruby integer literal, 'other' for any other value; absent without one. */
  cooldown?: number | 'other';
  /** A plain call apply can edit (see the comment at the top). */
  plain: boolean;
  /** The call has a block (source "…" do … end), so it is the source of the gems in the block only. */
  block: boolean;
}

export interface GemfileReading {
  /** The source calls up to `unknown`, in order. */
  sources: GemfileSource[];
  /** Where depcurfew stopped reading the file with certainty: the file is not understood. */
  unknown?: ScanUnknown;
}

interface PlainCall {
  url: string;
  cooldown?: { value: number; start: number; end: number };
  /** Where , cooldown: N goes when the call has none: right after the URL. */
  insertAt: number;
}

/** The second token of a source line that makes it no call of source: an assignment, a method of it, a comparison. */
const NOT_A_CALL = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '||=', '&&=', '|=', '&=', '^=', '<<=', '>>=', '.', '&.', '::', '==', '===', '!=', '=~', '!~', '<=>', '?', ':']);

/** The digits of each base of a Ruby integer literal (parse_numeric, extra.rubySyntax). */
const DIGITS: Record<number, RegExp> = {
  2: /^[01](?:_?[01])*$/u,
  8: /^[0-7](?:_?[0-7])*$/u,
  10: /^[0-9](?:_?[0-9])*$/u,
  16: /^[0-9a-fA-F](?:_?[0-9a-fA-F])*$/u,
};
const PREFIXES: Record<string, number> = { x: 16, b: 2, o: 8, d: 10 };

/**
 * The value of a Ruby integer literal as Ruby reads it: 0x, 0b, 0o and 0d prefixes, a leading 0 alone for octal (010 is
 * 8), single underscores between digits; undefined for anything else (7.5, 7r, 08, 1__0), which is no Integer.
 */
export function rubyInteger(text: string): number | undefined {
  let base = 10;
  let body = text;
  const prefix = PREFIXES[text[1]?.toLowerCase() ?? ''];
  if (text[0] === '0' && prefix !== undefined) {
    base = prefix;
    body = text.slice(2);
  } else if (text === '0') {
    return 0;
  } else if (text[0] === '0') {
    base = 8;
    body = text.slice(text[1] === '_' ? 2 : 1);
  }
  const digits = DIGITS[base];
  if (digits === undefined || !digits.test(body)) return undefined;
  return Number.parseInt(body.replaceAll('_', ''), base);
}

const isOp = (token: ScanToken | undefined, text: string): boolean => token?.kind === 'op' && token.text === text;

/** The index of the value of a cooldown key at tokens[k] (cooldown:, "cooldown":, :cooldown =>, "cooldown" =>). */
function cooldownKey(tokens: readonly ScanToken[], k: number): number | undefined {
  const token = tokens[k];
  if (token === undefined) return undefined;
  if (token.kind === 'label' && token.text === 'cooldown') return k + 1;
  if ((token.kind === 'symbol' && token.text === ':cooldown') || (token.kind === 'string' && token.value === 'cooldown')) return isOp(tokens[k + 1], '=>') ? k + 2 : undefined;
  return undefined;
}

/** Whitespace Ruby skips at the start of the next line while it looks for a leading .method. */
const isLeadingSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\f' || c === '\r' || c === '\v';

/**
 * Whether the line after the one ending at `end` continues the statement: Ruby skips comment lines and joins a next
 * line that starts with .method or &.method (a blank line does not join).
 */
function continuedBelow(text: string, end: number): boolean {
  let at = end + 1;
  while (end !== -1 && at < text.length) {
    let p = at;
    while (isLeadingSpace(text[p])) p++;
    const c = text[p];
    if (c === '#') {
      const next = text.indexOf('\n', p);
      if (next === -1) return false;
      at = next + 1;
      continue;
    }
    if (c === '.') return text[p + 1] !== '.';
    if (c === '&') return text[p + 1] === '.';
    return false;
  }
  return false;
}

/** A plain source call on the line, or undefined. */
function plainCall(text: string, line: ScannedLine): PlainCall | undefined {
  if (!line.statement || !line.complete || line.block) return undefined;
  const tokens = line.tokens;
  const open = tokens[1];
  const paren = isOp(open, '(') && open?.space === false;
  if (!paren && open?.space !== true) return undefined;
  let k = paren ? 2 : 1;
  const url = tokens[k];
  if (url?.kind !== 'string' || url.value === undefined) return undefined;
  k += 1;
  let cooldown: PlainCall['cooldown'];
  if (isOp(tokens[k], ',')) {
    const at = cooldownKey(tokens, k + 1);
    const value = at === undefined ? undefined : tokens[at];
    if (at === undefined || value?.kind !== 'number') return undefined;
    const days = rubyInteger(value.text);
    if (days === undefined) return undefined;
    cooldown = { value: days, start: value.start, end: value.end };
    k = at + 1;
  }
  if (paren) {
    if (!isOp(tokens[k], ')')) return undefined;
    k += 1;
  }
  if (tokens[k]?.kind === 'comment') k += 1;
  if (k !== tokens.length) return undefined;
  const last = tokens.at(-1);
  if (last === undefined || continuedBelow(text, text.indexOf('\n', last.end))) return undefined;
  return { url: url.value, ...(cooldown === undefined ? {} : { cooldown }), insertAt: url.end };
}

/** The source call of a line that starts with source, or undefined when it is no call (source = x, source.foo). */
function sourceOf(text: string, line: ScannedLine): GemfileSource | undefined {
  const tokens = line.tokens;
  const second = tokens[1];
  if (second === undefined || second.kind === 'comment' || second.kind === 'symbol') return undefined;
  if (!second.space && !isOp(second, '(')) return undefined;
  if (second.kind === 'op' && NOT_A_CALL.has(second.text)) return undefined;
  const plain = plainCall(text, line);
  if (plain !== undefined) return { line: line.line, url: plain.url, ...(plain.cooldown === undefined ? {} : { cooldown: plain.cooldown.value }), plain: true, block: false };
  const first = isOp(second, '(') ? tokens[2] : second;
  const url = first?.kind === 'string' ? first.value : undefined;
  let cooldown: number | 'other' | undefined;
  for (let k = 1; k < tokens.length && cooldown === undefined; k++) {
    const at = cooldownKey(tokens, k);
    if (at === undefined) continue;
    const value = tokens[at];
    cooldown = value?.kind === 'number' ? (rubyInteger(value.text) ?? 'other') : 'other';
  }
  return { line: line.line, ...(url === undefined ? {} : { url }), ...(cooldown === undefined ? {} : { cooldown }), plain: false, block: line.block };
}

/** The source calls of the text as Ruby reads it, up to where depcurfew cannot read it with certainty. */
export function readGemfile(text: string): GemfileReading {
  const scan = scanRuby(text);
  const sources = scan.lines.flatMap((line) => sourceOf(text, line) ?? []);
  return { sources, ...(scan.unknown === undefined ? {} : { unknown: scan.unknown }) };
}

/** Every source call of the text, in order (readGemfile without where it stops). */
export function gemfileSources(text: string): GemfileSource[] {
  return readGemfile(text).sources;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Whether a URL names a gem server: the same host, with or without a trailing slash, in any case. */
export function sameServer(url: string, server: string): boolean {
  const normalized = (value: string) => withoutTrailingSlashes(value.trim()).toLowerCase();
  const target = normalized(server).replace(/^https?:\/\//u, '');
  const value = normalized(url);
  return value === `https://${target}` || value === `http://${target}`;
}

/**
 * The text with the cooldown of the plain source call on each of `lines` set to `days`; everything else stays as it
 * is. A text depcurfew does not read with certainty comes back unchanged.
 */
export function setSourceCooldown(text: string, lines: readonly number[], days: number): string {
  const scan = scanRuby(text);
  if (scan.unknown !== undefined) return text;
  const wanted = new Set(lines);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const line of scan.lines) {
    if (!wanted.has(line.line)) continue;
    const call = plainCall(text, line);
    if (call === undefined) continue;
    edits.push(call.cooldown === undefined ? { start: call.insertAt, end: call.insertAt, text: `, cooldown: ${days}` } : { start: call.cooldown.start, end: call.cooldown.end, text: String(days) });
  }
  let result = '';
  let at = 0;
  for (const edit of edits) {
    result += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return result + text.slice(at);
}

/**
 * The Gemfile Bundler reads in a directory: gems.rb when it is a file there, otherwise Gemfile (extra.gemfileNames,
 * which lists the names in the order Bundler looks for them).
 */
export function gemfileIn(isFile: (file: string) => boolean, names: readonly string[] = ['gems.rb', 'Gemfile'], directory = ''): string {
  const join = (name: string) => (directory === '' || directory === '.' ? name : `${directory}/${name}`);
  return join(names.find((name) => isFile(join(name))) ?? names.at(-1) ?? 'Gemfile');
}
