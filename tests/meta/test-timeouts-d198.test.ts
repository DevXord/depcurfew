// Decision D-198 (extends D-188): the time limits of the tests measure the CPU time of the test process, so the clock
// of Vitest must not decide before them. Its defaults, 5 s for a test and 10 s for a hook, did on busy Windows runners:
// between 2026-11-01 and 2026-11-10 eight jobs failed with "Test timed out in 5000ms" and 24 with "Hook timed out in
// 10000ms", while the code was as fast as ever. vitest.config.ts gives every test 60 s and every hook 120 s, far above
// the CPU limits, and no test sets a shorter timeout of its own.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';

const TESTS = join(import.meta.dirname, '..');

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('timeouts of tests and hooks (decision D-198)', () => {
  it('every test has at least 60 s unless it asks for more', ({ task }) => {
    expect(task.timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('vitest.config.ts gives tests 60 s and hooks 120 s', () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(60_000);
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(120_000);
  });

  it('no test file sets a timeout shorter than that', () => {
    const shorter: string[] = [];
    for (const file of testFiles(TESTS)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\{ timeout: ([\d_]+) \}|\}, ([\d_]+)\);$/gmu)) {
        const value = Number((match[1] ?? match[2] ?? '').replaceAll('_', ''));
        if (value < 60_000) shorter.push(`${relative(TESTS, file)}: ${match[0]}`);
      }
    }
    expect(shorter).toEqual([]);
  });
});
