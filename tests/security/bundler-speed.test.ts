// A Gemfile just under the 1 MiB that apply and doctor read takes linear time (decision D-159). Before, regular
// expressions of src/apply/gemfile.ts backtracked quadratically on long runs of spaces after the URL, on many #{ and on
// a URL of slashes, and the queue of heredocs moved every entry for each one that ended: apply --dry-run took over
// 120 s on such a Gemfile and doctor over 60 s. Each shape now takes a fraction of a second; the limit leaves a wide
// margin for slow CI machines.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readGemfile, sameServer } from '../../src/apply/gemfile.ts';
import { applyProject } from '../../src/apply/index.ts';
import { MAX_FILE_SIZE } from '../../src/detect/repository.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A text of `piece` repeated to just under the limit, between `head` and `tail`. */
function fill(head: string, piece: string, tail: string): string {
  const room = MAX_FILE_SIZE - head.length - tail.length - 16;
  return `${head}${piece.repeat(Math.floor(room / piece.length))}${tail}`;
}

const SHAPES: [string, string][] = [
  ['spaces after source', fill('source', ' ', 'x\n')],
  ['spaces after the URL', fill('source "https://rubygems.org"', ' ', 'x\n')],
  ['spaces before =', fill('source', ' ', '=x\n')],
  ['spaces in parentheses', fill('source(', ' ', '"https://rubygems.org"   x\n')],
  ['#{ without } in a comment', fill('source x ', '#{', '\n')],
  ['#{" nested in a string', fill('X = "', '#{"', '\n')],
  ['a URL of slashes', fill('source "', '/', 'x"\n')],
  ['many heredocs on one line', `X = [${'<<A, '.repeat(Math.floor((MAX_FILE_SIZE - 64) / 7))}]\n${'A\n'.repeat(Math.floor((MAX_FILE_SIZE - 64) / 7))}`],
  ['many heredocs on one line without bodies', fill('X = [', '<<A, ', ']\n')],
  ['many heredocs and their bodies', fill('X = [<<A, <<A, <<A, <<A]\n', 'A\n', '')],
  ['many source lines', fill('', 'source "https://rubygems.org"\n', '')],
  ['many ? and :', fill('X = ', 'a ? b : ', '1\n')],
  ['many =begin lines', fill('=begin\n', '=begin\n', '=end\n')],
];

describe('a Gemfile of 1 MiB', () => {
  it.each(SHAPES)('%s: apply --dry-run and doctor each take well under 2 s', (_, text) => {
    expect(text.length).toBeLessThan(MAX_FILE_SIZE);
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-bundler-speed-'));
    temporary.push(root);
    writeFileSync(join(root, 'Gemfile'), text);
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '7d' } }));
    let start = performance.now();
    applyProject(root, { write: false });
    expect(performance.now() - start).toBeLessThan(2000);
    start = performance.now();
    runDoctor(root);
    expect(performance.now() - start).toBeLessThan(2000);
    start = performance.now();
    readGemfile(text);
    expect(performance.now() - start).toBeLessThan(2000);
  }, 60_000);

  it('compares a URL of a million slashes in linear time', () => {
    const start = performance.now();
    expect(sameServer(`${'/'.repeat(1_000_000)}x`, 'https://rubygems.org')).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
