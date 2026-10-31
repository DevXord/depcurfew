// Unified diff of two texts (Myers' algorithm on lines), for `apply --dry-run`.
import { isAbsoluteAnywhere } from '../paths.ts';
import { printable } from '../printable.ts';

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
  const operations = myers(lines(before ?? ''), lines(after));
  const name = printable(file);
  const [oldName, newName] = isAbsoluteAnywhere(file) ? [name, name] : [`a/${name}`, `b/${name}`];
  const output = [before === null ? '--- /dev/null' : `--- ${oldName}`, `+++ ${newName}`];
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
    for (const operation of hunk) {
      const prefix = operation.kind === 'same' ? ' ' : operation.kind === 'delete' ? '-' : '+';
      if (operation.line.endsWith(NO_EOL)) output.push(`${prefix}${shown(operation.line.slice(0, -1))}`, '\\ No newline at end of file');
      else output.push(`${prefix}${shown(operation.line)}`);
    }
    index = stop;
    start = stop;
  }
  return `${output.join('\n')}\n`;
}

/**
 * Keys whose value is a secret, in INI (.npmrc, pip.conf), TOML and YAML lines: npm's _auth, _authToken and
 * _password (also under a //host/: prefix), and in any file a key that ends in token, password or secret, or
 * npmAuthIdent. depcurfew writes none of these keys; the names only decide which values a diff hides, so they err on
 * the side of hiding (decision D-091).
 */
const SECRET_KEY = /^(?:_auth|npmauthident|[a-z0-9_-]*(?:token|password|passwd|secret))$/iu;
/** key = value: the key is everything before the first `=`, as in .npmrc, where it may hold colons (//host:443/:_auth). */
const EQUALS = /^(\s*(?:-\s+)?["']?)([^="'\s][^="']*?)(["']?\s*=\s*)(.*)$/u;
/** key: value, as in YAML. */
const COLON = /^(\s*(?:-\s+)?["']?)([A-Za-z0-9_.-]+)(["']?\s*:(?:\s+|$))(.*)$/u;
/** A key and its value inside an inline table or a flow mapping: { token = "…", url = "…" }, {npmAuthToken: …}. */
const INLINE = /([{,]\s*["']?)([A-Za-z0-9_.-]+)(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^,{}[\]\s][^,}\s]*)/gu;
/** A reference to an environment variable (${NPM_TOKEN}, $NPM_TOKEN) is no secret, and shows where the value comes from. */
const REFERENCE = /^(["']?)\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)\1$/u;
/** The user name and password of a URL (scheme://user:password@host); a password may hold an unencoded @. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#]*@/giu;
const REDACTED = '<redacted>';

function isSecret(key: string, value: string): boolean {
  const name = key.split(/[:.]/u).at(-1)?.trim() ?? '';
  return SECRET_KEY.test(name) && value.trim() !== '' && !REFERENCE.test(value.trim());
}

/** A line of a configuration file with the value of a secret key and the user and password of URLs as <redacted>. */
export function redactSecrets(line: string): string {
  for (const pattern of [EQUALS, COLON]) {
    const match = pattern.exec(line);
    if (match !== null && isSecret(match[2] ?? '', match[4] ?? '')) return `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}${REDACTED}`;
  }
  return line
    .replace(INLINE, (whole, before: string, key: string, separator: string, value: string) => (isSecret(key, value) ? `${before}${key}${separator}${REDACTED}` : whole))
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}
