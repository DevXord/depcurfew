// Unified diff of two texts (Myers' algorithm on lines), for `apply --dry-run`.

type Operation = { kind: 'same' | 'delete' | 'insert'; line: string };

/** Marks a last line without a line break, so it differs from the same line with one, as in `diff -u`. */
const NO_EOL = '\u0000';

function lines(text: string): string[] {
  if (text === '') return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  else result[result.length - 1] += NO_EOL;
  return result;
}

/** The shortest edit script from `a` to `b`. */
function myers(a: readonly string[], b: readonly string[]): Operation[] {
  const max = a.length + b.length;
  const offset = max + 1;
  const frontier = new Array<number>(2 * max + 3).fill(0);
  const trace: number[][] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push([...frontier]);
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0))
          ? (frontier[offset + k + 1] ?? 0)
          : (frontier[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= a.length && y >= b.length) break outer;
    }
  }
  const operations: Operation[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as number[];
    const k = x - y;
    const previousK =
      k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? k + 1 : k - 1;
    const previousX = v[offset + previousK] ?? 0;
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

function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** A unified diff with three lines of context; empty when the texts are equal. `before` is null for a new file. */
export function unifiedDiff(file: string, before: string | null, after: string, context = 3): string {
  if (before === after) return '';
  const operations = myers(lines(before ?? ''), lines(after));
  const output = [before === null ? '--- /dev/null' : `--- a/${file}`, `+++ b/${file}`];

  let index = 0;
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

    let oldStart = 1;
    let newStart = 1;
    for (const operation of operations.slice(0, start)) {
      if (operation.kind !== 'insert') oldStart += 1;
      if (operation.kind !== 'delete') newStart += 1;
    }
    const hunk = operations.slice(start, stop);
    const oldCount = hunk.filter((operation) => operation.kind !== 'insert').length;
    const newCount = hunk.filter((operation) => operation.kind !== 'delete').length;
    output.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const operation of hunk) {
      const prefix = operation.kind === 'same' ? ' ' : operation.kind === 'delete' ? '-' : '+';
      if (operation.line.endsWith(NO_EOL)) output.push(`${prefix}${operation.line.slice(0, -1)}`, '\\ No newline at end of file');
      else output.push(`${prefix}${operation.line}`);
    }
    index = stop;
    start = stop;
  }
  return `${output.join('\n')}\n`;
}
