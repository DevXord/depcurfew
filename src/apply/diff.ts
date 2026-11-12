// Unified diff of two texts (Myers' algorithm on lines), for `apply --dry-run`.
import type { ComposerCredentialsKnowledge } from '../knowledge/types.ts';
import { isAbsoluteAnywhere } from '../paths.ts';
import { printable, redactCredentials } from '../printable.ts';
import { extraOf, isRecord } from './facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';

export type Operation = { kind: 'same' | 'delete' | 'insert'; line: string };

/** Marks a last line without a line break, so it differs from the same line with one, as in `diff -u`. */
const NO_EOL = '\u0000';

export function lines(text: string): string[] {
  if (text === '') return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  else result[result.length - 1] += NO_EOL;
  return result;
}

/**
 * Above this many changed lines, or when the search would take too long, the diff is made by a quicker method that
 * keeps changes local but may not be the shortest (approximateEdit): the search keeps memory for every step, which
 * for thousands of changes in a large file would take gigabytes.
 */
const MAX_EDITS = 2000;
const MAX_STEPS = 50_000_000;

/** An edit script from `a` to `b`: the shortest one (Myers), or a close one for very different texts. */
export function myers(a: readonly string[], b: readonly string[]): Operation[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  const budget = Math.min(MAX_EDITS, Math.max(100, Math.floor(MAX_STEPS / (left.length + right.length + 1))));
  const middle = shortestEdit(left, right, budget) ?? approximateEdit(left, right);
  const same = (line: string): Operation => ({ kind: 'same', line });
  return [...a.slice(0, prefix).map(same), ...middle, ...a.slice(a.length - suffix).map(same)];
}

/** Myers' algorithm; undefined when the texts differ in more than `maxEdits` lines. */
function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): Operation[] | undefined {
  const max = Math.min(a.length + b.length, maxEdits);
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  // Only the diagonals a step can reach are kept: trace[d] holds diagonals -d-1 to d+1 before step d.
  const trace: Int32Array[] = [];
  let done = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0)) ? (frontier[offset + k + 1] ?? 0) : (frontier[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= a.length && y >= b.length) {
        done = true;
        break outer;
      }
    }
  }
  if (!done) return undefined;
  const operations: Operation[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Int32Array;
    const at = (k: number) => v[k + d + 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      operations.push({ kind: 'same', line: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === previousX) operations.push({ kind: 'insert', line: b[y - 1] as string });
      else operations.push({ kind: 'delete', line: a[x - 1] as string });
    }
    x = previousX;
    y = previousY;
  }
  return operations.reverse();
}

/**
 * A close edit script in linear time: equal lines are kept, and after a difference the nearest place where the texts
 * agree again, within a few lines, is where they continue. Changes stay where they are, as apply makes them.
 */
function approximateEdit(a: readonly string[], b: readonly string[], window = 32): Operation[] {
  const operations: Operation[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      operations.push({ kind: 'same', line: a[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    let skip: [number, number] | undefined;
    search: for (let distance = 1; distance <= window; distance++) {
      for (let fromA = 0; fromA <= distance; fromA++) {
        const fromB = distance - fromA;
        if (i + fromA < a.length && j + fromB < b.length && a[i + fromA] === b[j + fromB]) {
          skip = [fromA, fromB];
          break search;
        }
      }
    }
    const [deletes, inserts] = skip ?? [i < a.length ? 1 : 0, j < b.length ? 1 : 0];
    for (let count = 0; count < deletes; count++) operations.push({ kind: 'delete', line: a[i++] as string });
    for (let count = 0; count < inserts; count++) operations.push({ kind: 'insert', line: b[j++] as string });
  }
  return operations;
}

/** For each operation, its line in `before` (kept and removed lines) or in `after` (added lines). */
function displayLines(operations: readonly Operation[], before: readonly string[], after: readonly string[]): string[] {
  let old = 0;
  let current = 0;
  return operations.map((operation) => {
    if (operation.kind === 'insert') return after[current++] ?? operation.line;
    if (operation.kind === 'delete') return before[old++] ?? operation.line;
    current += 1;
    return before[old++] ?? operation.line;
  });
}

function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

export interface DiffOptions {
  /** Shows the values of secrets as <redacted> in every line (redactSecrets), for a diff that people or logs see. */
  redact?: boolean;
}

/**
 * A unified diff with three lines of context; empty when the texts are equal. `before` is null for a new file.
 * Control characters in the file name are shown as text (printable), so that a name cannot start a line of its own
 * and forge a header or a hunk. A file with an absolute path (a user file outside the home directory) is named as it
 * is, without the a/ and b/ of repository paths.
 */
export function unifiedDiff(file: string, before: string | null, after: string, context = 3, options: DiffOptions = {}): string {
  if (before === after) return '';
  const name = printable(file);
  const [oldName, newName] = isAbsoluteAnywhere(file) ? [name, name] : [`a/${name}`, `b/${name}`];
  const output = [before === null ? '--- /dev/null' : `--- ${oldName}`, `+++ ${newName}`];
  const operations = myers(lines(before ?? ''), lines(after));
  // Each line as redactText shows it: the line of the same number in the redacted text, so that a secret that only its
  // place in a JSON document shows (a Composer token under its host) is hidden too, and a changed secret still shows
  // as a changed line (decision D-192).
  const display = options.redact === true ? displayLines(operations, lines(before === null ? '' : redactText(file, before)), lines(redactText(file, after))) : operations.map((operation) => operation.line);
  const shown = options.redact === true ? redactSecrets : (line: string) => line;

  let index = 0;
  let counted = 0;
  let oldStart = 1;
  let newStart = 1;
  while (index < operations.length) {
    while (index < operations.length && operations[index]?.kind === 'same') index += 1;
    if (index >= operations.length) break;
    // Extend the hunk while changes are separated by at most 2 * context unchanged lines.
    let start = Math.max(0, index - context);
    let end = index;
    while (end < operations.length) {
      if (operations[end]?.kind !== 'same') {
        end += 1;
        continue;
      }
      let run = end;
      while (run < operations.length && operations[run]?.kind === 'same') run += 1;
      if (run >= operations.length || run - end > 2 * context) break;
      end = run;
    }
    const stop = Math.min(operations.length, end + context);

    // Line numbers count on from the previous hunk, so that many hunks do not recount the file each time.
    for (; counted < start; counted++) {
      if (operations[counted]?.kind !== 'insert') oldStart += 1;
      if (operations[counted]?.kind !== 'delete') newStart += 1;
    }
    const hunk = operations.slice(start, stop);
    const oldCount = hunk.filter((operation) => operation.kind !== 'insert').length;
    const newCount = hunk.filter((operation) => operation.kind !== 'delete').length;
    output.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const [offset, operation] of hunk.entries()) {
      const prefix = operation.kind === 'same' ? ' ' : operation.kind === 'delete' ? '-' : '+';
      const line = display[start + offset] ?? operation.line;
      if (line.endsWith(NO_EOL)) output.push(`${prefix}${shown(line.slice(0, -1))}`, '\\ No newline at end of file');
      else output.push(`${prefix}${shown(line)}`);
    }
    index = stop;
    start = stop;
  }
  return `${output.join('\n')}\n`;
}

/**
 * Keys whose value is a secret, in INI (.npmrc, pip.conf), TOML and YAML lines: npm's _auth, _authToken and
 * _password (also under a //host/: prefix), npm's key (a client key in PEM format, not a path; certfile and keyfile
 * are paths, decision D-115), and in any file a key that ends in token, password or secret, or npmAuthIdent.
 * depcurfew writes none of these keys; the names only decide which values a diff hides, so they err on the side of
 * hiding (decision D-091).
 */
const SECRET_KEY = /^(?:_auth|npmauthident|key|[a-z0-9_-]*(?:token|password|passwd|secret))$/iu;
/** Line terminators, which end a line for `.` and `$` of the patterns below; \n and a lone \r are split before. */
const TERMINATORS = /[\n\r\u2028\u2029]/u;
const QUOTES = new Set(['"', "'"]);
const BLANK = /\s/u;

/**
 * key = value, as in .npmrc and pip.conf: the key is everything before the first `=`, as in .npmrc, where it may hold
 * colons (//host:443/:_auth), after blanks, a dash of a YAML list and a quote, and before a closing quote and blanks;
 * the value follows the blanks after `=`. This is what /^(\s*(?:-\s+)?["']?)([^="'\s][^="']*?)(["']?\s*=\s*)(.*)$/u
 * matches, read without it: that pattern backtracks quadratically on a long run of blanks with no `=` after it (a
 * line of 80,000 tabs took 6 s), and a configuration file may be 1 MiB (decision D-192).
 */
function equalsPair(line: string): { key: string; value: string } | undefined {
  const at = line.indexOf('=');
  if (at === -1) return undefined;
  const value = line.slice(at + 1).trimStart();
  if (TERMINATORS.test(value)) return undefined;
  const before = line.slice(0, at);
  let start = 0;
  while (start < before.length && BLANK.test(before[start] ?? '')) start += 1;
  // With the dash of a YAML list and the blanks after it, or without them (then the key starts with the dash).
  const starts = [start];
  if (before[start] === '-') {
    let after = start + 1;
    while (after < before.length && BLANK.test(before[after] ?? '')) after += 1;
    if (after > start + 1) starts.unshift(after);
  }
  for (const first of starts) {
    const from = QUOTES.has(before[first] ?? '') ? first + 1 : first;
    const region = before.slice(from).trimEnd();
    const key = QUOTES.has(region.at(-1) ?? '') ? region.slice(0, -1) : region;
    if (key === '' || BLANK.test(key[0] ?? '') || [...key].some((character) => QUOTES.has(character))) continue;
    return { key, value };
  }
  return undefined;
}
/**
 * A key as YAML, TOML and JSON write it: in double quotes (with escapes), in single quotes, or bare. A quoted key may
 * hold any character, as "//registry.npmjs.org/:_authToken" does; a bare one may hold a colon that no space follows.
 */
const KEY = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_.\/@-]+(?::[A-Za-z0-9_.\/@-]+)*))`;
/** The key of key: value, as in YAML, up to its colon. */
const COLON_KEY = new RegExp(String.raw`^\s*(?:-\s+)?${KEY}\s*:(?=\s|$)`, 'u');
const BLANK_RUN = /\s*/uy;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/u;

/**
 * key: value, as in YAML: what /^\s*(?:-\s+)?KEY\s*:(?:\s+|$)(.*)$/u matched, read without backtracking over the
 * blanks after the colon (decision D-200): that pattern took seconds on a key, 40,000 blanks and a value with a line
 * separator. Its greedy blanks gave the only match there is: with fewer of them, the value (. stops at the line
 * terminators) would still have to pass the terminator it could not pass.
 */
export function colonPair(line: string): { key: string; value: string } | undefined {
  const prefix = COLON_KEY.exec(line);
  if (prefix === null) return undefined;
  BLANK_RUN.lastIndex = prefix[0].length;
  BLANK_RUN.exec(line);
  const value = line.slice(BLANK_RUN.lastIndex);
  if (LINE_TERMINATOR.test(value)) return undefined;
  return { key: prefix[1] ?? prefix[2] ?? prefix[3] ?? '', value };
}
/** A key and its value inside an inline table or a flow mapping: { token = "…", url = "…" }, {npmAuthToken: …}. */
const INLINE = new RegExp(String.raw`[{,]\s*${KEY}\s*[=:]\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,{}[\]\s][^,}\s]*)`, 'gu');
/** A reference to an environment variable (${NPM_TOKEN}, $NPM_TOKEN) is no secret, and shows where the value comes from. */
const REFERENCE = /^(["']?)\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)\1$/u;
const REDACTED = '<redacted>';

function isSecret(key: string, value: string): boolean {
  const name = key.split(/[:.]/u).at(-1)?.trim() ?? '';
  return SECRET_KEY.test(name) && value.trim() !== '' && !REFERENCE.test(value.trim());
}

/**
 * A line of a configuration file with the value of a secret key and the user part of URLs as <redacted>
 * (redactCredentials: also a token alone and a password with an unencoded @). The diff splits lines at \n only, while
 * npm's ini, pip's configparser and YAML end a line at a lone \r too (decision D-168): each part is redacted as the
 * line of its own that those tools read, so that `fund=false\r_authToken=…` hides the token.
 */
export function redactSecrets(line: string): string {
  return line.includes('\r') ? line.split('\r').map(redactLine).join('\r') : redactLine(line);
}

function redactLine(line: string): string {
  const equals = equalsPair(line);
  if (equals !== undefined && isSecret(equals.key, equals.value)) return `${line.slice(0, line.length - equals.value.length)}${REDACTED}`;
  const colon = colonPair(line);
  if (colon !== undefined && isSecret(colon.key, colon.value)) return `${line.slice(0, line.length - colon.value.length)}${REDACTED}`;
  return redactCredentials(
    line.replace(INLINE, (whole: string, double: string | undefined, single: string | undefined, bare: string | undefined, found: string) =>
      isSecret(double ?? single ?? bare ?? '', found) ? `${whole.slice(0, whole.length - found.length)}${REDACTED}` : whole,
    ),
  );
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isCredentials = (value: unknown): value is ComposerCredentialsKnowledge => isRecord(value) && isStrings(value['keys']) && typeof value['config'] === 'string' && isStrings(value['headers']);
let credentials: ComposerCredentialsKnowledge | undefined;

function composerCredentials(): ComposerCredentialsKnowledge {
  const composer = knowledgeBase.find((tool) => tool.id === 'composer');
  if (composer === undefined) throw new Error('knowledge base: composer is missing');
  credentials ??= extraOf(composer, 'credentials', isCredentials);
  return credentials;
}

/** A JSON file by its name, as detection and apply read it: .json, .jsonc and .renovaterc. */
function isJsonFile(file: string): boolean {
  const name = file.split(/[\\/]/u).at(-1) ?? file;
  return /\.jsonc?$/u.test(name) || name === '.renovaterc';
}

/** The string a JSON string literal stands for; the text between the quotes when it is not valid JSON. */
function decoded(literal: string): string {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === 'string' ? value : literal.slice(1, -1);
  } catch {
    return literal.slice(1, literal.endsWith('"') && literal.length > 1 ? -1 : undefined);
  }
}

/**
 * JSON text with the string values that are secrets as "<redacted>", by their place in the document: the value of a
 * secret key (SECRET_KEY, as in other files), every string under one of Composer's credentials, which it keys by host
 * ("github-oauth": {"github.com": "…"}), at the top (auth.json) or under config (composer.json), and the HTTP headers of
 * a repository (decision D-192). Comments are skipped, as JSONC has them. Every line stays where it is, and a file that
 * does not parse is read as far as it goes; each string is checked in constant time, however deep it is.
 */
function redactJson(text: string): string {
  const { keys, config, headers } = composerCredentials();
  const stack: { list: boolean; key: string }[] = [];
  const at = (index: number) => {
    const level = stack[index];
    return level === undefined ? undefined : level.list ? '*' : level.key;
  };
  const hidden = (value: string): boolean => {
    const first = at(0);
    if (first !== undefined && keys.includes(first) && stack.length >= 2) return true;
    const second = at(1);
    if (first === config && second !== undefined && keys.includes(second) && stack.length >= 3) return true;
    if (stack.length === headers.length + 1 && headers.every((key, index) => key === '*' || at(index) === key)) return true;
    const last = stack.at(-1);
    return last !== undefined && !last.list && isSecret(last.key, value);
  };
  let expectKey = false;
  let output = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      // A string ends at its closing quote, or at the end of the line when it has none.
      let end = index + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' && text[end + 1] !== '\n' ? 2 : 1;
      if (text[end] === '"') end += 1;
      const literal = text.slice(index, end);
      const level = stack.at(-1);
      if (level !== undefined && !level.list && expectKey) {
        level.key = decoded(literal);
        expectKey = false;
      } else if (level !== undefined && hidden(decoded(literal))) {
        output += `${text.slice(copied, index)}"${REDACTED}"`;
        copied = end;
      }
      index = end;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push({ list: character === '[', key: '' });
      expectKey = character === '{';
    } else if (character === '}' || character === ']') {
      stack.pop();
      expectKey = false;
    } else if (character === ',') expectKey = stack.at(-1)?.list === false;
    else if (character === ':') expectKey = false;
    index += 1;
  }
  return output + text.slice(copied);
}

/**
 * A file with the values of secrets as <redacted>, line for line, for what people or logs see: JSON by the place of
 * each value in the document (redactJson, then the user part of URLs), so that a Composer token under its host is
 * hidden too, also in a minified file; other files each line as redactSecrets reads it (decision D-192). The text keeps
 * its lines, so line numbers stay, and JSON stays JSON.
 */
export function redactText(file: string, text: string): string {
  if (isJsonFile(file)) return redactJson(text).split('\n').map(redactCredentials).join('\n');
  return text.split('\n').map(redactSecrets).join('\n');
}
