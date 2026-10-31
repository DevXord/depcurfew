// A file apply replaces keeps its owner when depcurfew runs as root (sudo depcurfew apply --user with HOME kept): the
// temporary file root creates belongs to root, and renamed over ~/.npmrc it would lock the user out of their own
// configuration. Only root can give a file away, so the test runs only as root, on systems with owners.
import { chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeChanges } from '../../src/apply/workspace.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;

describe.skipIf(!asRoot)('writeChanges as root', () => {
  it('gives a replaced file back to its owner and group, with its mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-owner-'));
    temporary.push(directory);
    writeFileSync(join(directory, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n', { mode: 0o600 });
    chownSync(join(directory, '.npmrc'), 65534, 65534);
    writeChanges(directory, [{ file: '.npmrc', before: '//registry.npmjs.org/:_authToken=secret\n', after: '//registry.npmjs.org/:_authToken=secret\nmin-release-age=3\n' }]);
    const stats = statSync(join(directory, '.npmrc'));
    expect([stats.uid, stats.gid, stats.mode & 0o777]).toEqual([65534, 65534, 0o600]);
  });

  it('keeps root as the owner of a file root owns, and of a new file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-owner-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'a.txt'), 'a\n');
    writeChanges(directory, [
      { file: 'a.txt', before: 'a\n', after: 'b\n' },
      { file: 'new.txt', before: null, after: 'new\n' },
    ]);
    expect(statSync(join(directory, 'a.txt')).uid).toBe(0);
    expect(statSync(join(directory, 'new.txt')).uid).toBe(0);
  });
});
