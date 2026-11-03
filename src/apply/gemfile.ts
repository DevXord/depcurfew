// The source calls of a Gemfile (or gems.rb), read and edited line by line without running Ruby (decision D-152).
// apply edits only a plain call: source "<URL>" with a literal URL, optionally in parentheses, optionally with
// cooldown: <number>, on one line of its own, with nothing after it but a comment. Any other form (a block, other
// options, a variable or an interpolated string, a call over several lines) is reported, never edited, so the edit
// cannot change what the Gemfile means.

/** A source call of a Gemfile. */
export interface GemfileSource {
  /** 1-based line of the call. */
  line: number;
  /** The URL when the first argument is a string literal without interpolation. */
  url?: string;
  /** The cooldown: keyword: its days when they are a number literal, 'other' for any other value; absent without one. */
  cooldown?: number | 'other';
  /** A plain call apply can edit (see the comment at the top). */
  plain: boolean;
  /** The call has a block (source "…" do … end), so it is the source of the gems in the block only. */
  block: boolean;
}

const QUOTED = String.raw`"(?:[^"\\#]|\\.|#(?!\{))*"|'(?:[^'\\]|\\.)*'`;
const KEY = String.raw`(?:cooldown:|:cooldown[ \t]*=>|"cooldown"[ \t]*(?::|=>)|'cooldown'[ \t]*=>)`;
/** source "URL"[, cooldown: N] with or without parentheses, and an optional comment. */
const PLAIN = new RegExp(
  String.raw`^(?<head>[ \t]*source(?:\(|[ \t]+)[ \t]*)(?<url>${QUOTED})(?<option>[ \t]*,[ \t]*${KEY}[ \t]*(?<days>\d+))?(?<tail>[ \t]*(?<close>\))?[ \t]*(?:#.*)?)$`,
  'u',
);
/** The start of a source call: source followed by a space or a parenthesis, not an assignment, a method or a hash key. */
const CALL = /^[ \t]*source(?:\(|[ \t]+(?![ \t]*(?:=[^=~>]|\.|:[^:])))/u;
const COOLDOWN = new RegExp(String.raw`${KEY}[ \t]*(?<value>[^,)\s#]*)`, 'u');
const HEREDOC = /<<[~-]?(["'`]?)([A-Za-z_][A-Za-z0-9_]*)\1/gu;

/** The value of a Ruby string literal (only the escapes of quotes and backslashes matter for a URL). */
function literal(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/gu, '$1');
}

/**
 * Which lines are Ruby code: not inside =begin … =end or the body of a heredoc (<<~ID … ID). A rough reading that errs
 * towards leaving a line alone: the start of a heredoc is looked for anywhere on its line.
 */
function codeLines(lines: readonly string[]): boolean[] {
  const code: boolean[] = [];
  let comment = false;
  const heredocs: { id: string; indented: boolean }[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/u, '');
    if (comment) {
      code.push(false);
      if (/^=end(?:\s|$)/u.test(line)) comment = false;
      continue;
    }
    const open = heredocs[0];
    if (open !== undefined) {
      code.push(false);
      if ((open.indented ? line.trim() : line) === open.id) heredocs.shift();
      continue;
    }
    if (/^=begin(?:\s|$)/u.test(line)) {
      comment = true;
      code.push(false);
      continue;
    }
    code.push(true);
    for (const match of line.matchAll(HEREDOC)) {
      const id = match[2];
      if (id !== undefined) heredocs.push({ id, indented: match[0].startsWith('<<~') || match[0].startsWith('<<-') });
    }
  }
  return code;
}

/** Every source call of the text, in order. */
export function gemfileSources(text: string): GemfileSource[] {
  const lines = text.split('\n');
  const code = codeLines(lines);
  const found: GemfileSource[] = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/u, '');
    if (code[index] !== true || !CALL.test(line)) return;
    const plain = PLAIN.exec(line);
    const opened = /^[ \t]*source\(/u.test(line);
    if (plain?.groups !== undefined && (plain.groups['close'] !== undefined) === opened) {
      const days = plain.groups['days'];
      found.push({ line: index + 1, url: literal(plain.groups['url'] ?? ''), ...(days === undefined ? {} : { cooldown: Number(days) }), plain: true, block: false });
      return;
    }
    const rest = line.replace(/^[ \t]*source\(?[ \t]*/u, '');
    const url = new RegExp(`^(?:${QUOTED})`, 'u').exec(rest)?.[0];
    const value = COOLDOWN.exec(line)?.groups?.['value'];
    const block = /\bdo(?:[ \t]*\|[^|]*\|)?[ \t]*(?:#.*)?$/u.test(line) || /\{[^}]*$/u.test(line.replace(/#\{[^}]*\}/gu, ''));
    found.push({
      line: index + 1,
      ...(url === undefined ? {} : { url: literal(url) }),
      ...(value === undefined ? {} : { cooldown: /^\d+$/u.test(value) ? Number(value) : 'other' }),
      plain: false,
      block,
    });
  });
  return found;
}

/** Whether a URL names a gem server: the same host, with or without a trailing slash, in any case. */
export function sameServer(url: string, server: string): boolean {
  const normalized = (value: string) => value.trim().replace(/\/+$/u, '').toLowerCase();
  const target = normalized(server).replace(/^https?:\/\//u, '');
  const value = normalized(url);
  return value === `https://${target}` || value === `http://${target}`;
}

/** The text with the cooldown of the plain source call on each of `lines` set to `days`; other lines stay as they are. */
export function setSourceCooldown(text: string, lines: readonly number[], days: number): string {
  const all = text.split('\n');
  for (const number of lines) {
    const raw = all[number - 1];
    if (raw === undefined) continue;
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr === '' ? raw : raw.slice(0, -1);
    const match = PLAIN.exec(line);
    const groups = match?.groups;
    if (groups === undefined) continue;
    const head = groups['head'] ?? '';
    const url = groups['url'] ?? '';
    const option = groups['option'];
    const written = groups['days'];
    const tail = groups['tail'] ?? '';
    const replaced = option === undefined || written === undefined ? `${head}${url}, cooldown: ${days}${tail}` : `${head}${url}${option.slice(0, option.length - written.length)}${days}${tail}`;
    all[number - 1] = `${replaced}${cr}`;
  }
  return all.join('\n');
}

/**
 * The Gemfile Bundler reads in a directory: gems.rb when it is there, otherwise Gemfile (extra.gemfileNames, which
 * lists the names in the order Bundler looks for them).
 */
export function gemfileIn(isFile: (file: string) => boolean, names: readonly string[] = ['gems.rb', 'Gemfile'], directory = ''): string {
  const join = (name: string) => (directory === '' || directory === '.' ? name : `${directory}/${name}`);
  return join(names.find((name) => isFile(join(name))) ?? names.at(-1) ?? 'Gemfile');
}
