// Repository never lists or reads anything outside its root (decision D-161). The shortcut of D-157 (a directory
// without a symlink on the way is its own real path) remembered directories above the root after a lookup through ..,
// so a later listing of ../sibling or .. returned their names; and a directory listed once was taken for plain for the
// rest of the run, so a file read after the directory was replaced with a symlink to outside came from outside.
// Listing now uses the shortcut only inside the root, and reading a file resolves its real path again.
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/detect/repository.ts';
import { canSymlink } from '../support/platform.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function base(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'depcurfew-repository-boundary-')));
  temporary.push(directory);
  return directory;
}

describe('Repository lists nothing above its root (decision D-161)', () => {
  it('also after a lookup there', () => {
    const top = base();
    mkdirSync(join(top, 'repo', 'inner'), { recursive: true });
    mkdirSync(join(top, 'sibling', 'deeper'), { recursive: true });
    writeFileSync(join(top, 'sibling', 'Cargo.toml'), '');
    writeFileSync(join(top, 'secret.txt'), '');
    const repository = new Repository(join(top, 'repo'));
    expect(repository.isFile('../sibling/Cargo.toml')).toBe(false);
    expect(repository.isFile('../anything')).toBe(false);
    expect(repository.isFile('inner/../../secret.txt')).toBe(false);
    expect(repository.listFiles('../sibling')).toEqual([]);
    expect(repository.listDirectories('../sibling')).toEqual([]);
    expect(repository.listDirectories('..')).toEqual([]);
    expect(repository.listFiles('..')).toEqual([]);
    expect(repository.listFiles('inner/../..')).toEqual([]);
    expect(repository.readText('../sibling/Cargo.toml')).toBeUndefined();
    expect(repository.readHead('../secret.txt')).toBeUndefined();
  });

  it('also after listing the root, while .. that stays inside works as before', () => {
    const top = base();
    mkdirSync(join(top, 'repo', 'a', 'b'), { recursive: true });
    writeFileSync(join(top, 'repo', 'a', 'x.json'), '{}');
    writeFileSync(join(top, 'outside.json'), '{}');
    const repository = new Repository(join(top, 'repo'));
    expect(repository.listDirectories('.')).toEqual(['a']);
    expect(repository.listDirectories('a')).toEqual(['b']);
    expect(repository.listFiles('a/b/..')).toEqual(['x.json']);
    expect(repository.readText('a/b/../x.json')).toBe('{}');
    expect(repository.listFiles('a/../..')).toEqual([]);
    expect(repository.readText('a/../../outside.json')).toBeUndefined();
  });
});

describe.skipIf(!canSymlink())('Repository does not read through a directory that became a symlink after it was listed (decision D-161)', () => {
  function layout(): { top: string; repository: Repository } {
    const top = base();
    mkdirSync(join(top, 'repo', 'pkg', 'sub'), { recursive: true });
    mkdirSync(join(top, 'outside', 'sub'), { recursive: true });
    writeFileSync(join(top, 'repo', 'pkg', 'package.json'), '{}');
    writeFileSync(join(top, 'repo', 'pkg', 'sub', 'package.json'), '{}');
    writeFileSync(join(top, 'outside', 'package.json'), '{"name":"outside"}');
    writeFileSync(join(top, 'outside', 'sub', 'package.json'), '{"name":"outside"}');
    return { top, repository: new Repository(join(top, 'repo')) };
  }

  function swap(top: string): void {
    renameSync(join(top, 'repo', 'pkg'), join(top, 'pkg-moved'));
    symlinkSync(join(top, 'outside'), join(top, 'repo', 'pkg'), 'junction');
  }

  it('readText, readHead and parse refuse the file and say so', () => {
    const { top, repository } = layout();
    expect(repository.listDirectories('.')).toEqual(['pkg']);
    expect(repository.listDirectories('pkg')).toEqual(['sub']);
    expect(repository.readText('pkg/package.json')).toBe('{}');
    swap(top);
    expect(repository.readText('pkg/package.json')).toBeUndefined();
    expect(repository.readText('pkg/sub/package.json')).toBeUndefined();
    expect(repository.readHead('pkg/sub/package.json')).toBeUndefined();
    expect(repository.parse('pkg/package.json', (text) => JSON.parse(text) as unknown)).toBeUndefined();
    expect(repository.warnings.map((warning) => warning.message)).toEqual([
      'pkg/package.json points outside the repository and was not read',
      'pkg/sub/package.json points outside the repository and was not read',
    ]);
  });

  it('a file that is read is the one inside, before the swap', () => {
    const { repository } = layout();
    expect(repository.listFiles('pkg')).toEqual(['package.json']);
    expect(repository.readText('pkg/sub/package.json')).toBe('{}');
    expect(repository.warnings).toEqual([]);
  });
});
