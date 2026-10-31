// The repository boundary: a repository may sit at the root of a drive or share (P:\ from subst, a Dev Drive,
// \\nas\share\ on Windows, / on Linux), where root + separator is not a prefix of the paths inside it.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, posix, relative, sep, win32 } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Workspace } from '../src/apply/workspace.ts';
import { Repository } from '../src/detect/repository.ts';
import { isAbsoluteAnywhere, isInside } from '../src/paths.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('isInside', () => {
  it.each([
    ['/', '/etc/hostname', true],
    ['/', '/', true],
    ['/repo', '/repo', true],
    ['/repo', '/repo/a/b', true],
    ['/repo', '/repo/..data', true],
    ['/repo', '/repo-evil/x', false],
    ['/repo', '/other', false],
    ['/repo', '/', false],
  ])('posix: %s holds %s: %s', (root, path, expected) => {
    expect(isInside(root, path, posix)).toBe(expected);
  });

  it.each([
    ['P:\\', 'P:\\package.json', true],
    ['P:\\', 'P:\\', true],
    ['\\\\nas\\share\\', '\\\\nas\\share\\package.json', true],
    ['\\\\nas\\share\\repo', '\\\\nas\\share\\repo\\.npmrc', true],
    // A junction or a cwd written in another case names the same directory.
    ['D:\\Projekty\\depcurfew', 'd:\\projekty\\depcurfew\\shared\\package.json', true],
    ['D:\\Projekty\\depcurfew', 'D:\\Projekty\\depcurfew-evil\\x', false],
    ['D:\\Projekty\\depcurfew', 'E:\\other\\x', false],
    ['P:\\', 'Q:\\package.json', false],
  ])('win32: %s holds %s: %s', (root, path, expected) => {
    expect(isInside(root, path, win32)).toBe(expected);
  });
});

describe('isAbsoluteAnywhere', () => {
  it.each([
    ['/etc/req.txt', true],
    ['\\x\\req.txt', true],
    ['\\\\nas\\share\\req.txt', true],
    ['C:\\x\\req.txt', true],
    ['c:/x/req.txt', true],
    ['D:req.txt', true],
    ['req.txt', false],
    ['sub\\req.txt', false],
    ['../req.txt', false],
  ])('%s: %s', (path, expected) => {
    expect(isAbsoluteAnywhere(path)).toBe(expected);
  });
});

describe('a repository at the root of a file system', () => {
  const file = (() => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-root-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'policy.txt'), 'inside\n');
    return realpathSync(join(directory, 'policy.txt'));
  })();
  // / on Linux and macOS, the drive of the temporary directory (C:\) on Windows.
  const root = parse(file).root;
  const path = relative(root, file).split(sep).join('/');

  it('reads its files', () => {
    const repository = new Repository(root);
    expect(repository.readText(path)).toBe('inside\n');
    expect(repository.warnings).toEqual([]);
  });

  it('edits its files', () => {
    expect(new Workspace(root).read(path)).toBe('inside\n');
  });
});
