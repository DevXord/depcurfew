// Reading files someone else can put in place: regular files only, never more than the limit, and no waiting on a
// FIFO or trusting the size /proc reports.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readLimited, readLimitedText } from '../src/read-limited.ts';
import { canSymlink } from './support/platform.ts';

const root = mkdtempSync(join(tmpdir(), 'depcurfew-read-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readLimited', () => {
  it('reads a regular file up to the limit and refuses a larger one', () => {
    const file = join(root, 'small.txt');
    writeFileSync(file, 'abcdef');
    expect(readLimitedText(file, 6)).toBe('abcdef');
    expect(readLimited(file, 5)).toEqual({ ok: false, problem: 'too-large' });
  });

  it('tells a missing path and a directory apart', () => {
    expect(readLimited(join(root, 'none'), 10)).toEqual({ ok: false, problem: 'missing' });
    mkdirSync(join(root, 'folder'));
    expect(readLimited(join(root, 'folder'), 10)).toMatchObject({ ok: false, problem: 'not-a-file' });
  });

  it.skipIf(process.platform === 'win32')('returns at once for a FIFO instead of waiting for a writer', () => {
    const fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(readLimited(fifo, 10)).toEqual({ ok: false, problem: 'not-a-file' });
  });

  it.skipIf(!existsSync('/proc/self/status'))('does not trust the size 0 that /proc reports', () => {
    expect(readLimitedText('/proc/self/status', 1024 * 1024)).toContain('Name:');
    expect(readLimited('/proc/self/status', 10)).toEqual({ ok: false, problem: 'too-large' });
  });

  it.skipIf(!canSymlink() || process.platform === 'win32')('refuses a symlink with noFollow and follows it otherwise', () => {
    const target = join(root, 'target.txt');
    writeFileSync(target, 'x');
    const link = join(root, 'link.txt');
    symlinkSync(target, link);
    expect(readLimited(link, 10, { noFollow: true })).toEqual({ ok: false, problem: 'symlink' });
    expect(readLimitedText(link, 10)).toBe('x');
  });
});
