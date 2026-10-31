// What the file system running the tests allows. Windows refuses control characters in file names, keeps only the
// write bit of a file's mode (the read-only attribute), and lets a process create symlinks only with a privilege
// (an administrator or Developer Mode); links to directories use junctions there, which need none.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const windows = process.platform === 'win32';

let symlinks: boolean | undefined;

/** Whether this process may create a symlink to a file; tried once in a temporary directory, which is removed. */
export function canSymlink(): boolean {
  if (symlinks !== undefined) return symlinks;
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-symlink-'));
  try {
    writeFileSync(join(directory, 'target'), '');
    symlinkSync(join(directory, 'target'), join(directory, 'link'));
    symlinks = true;
  } catch {
    symlinks = false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return symlinks;
}

/** The part of a file mode both systems keep: all of it, or on Windows only whether the owner may write. */
export function comparableMode(mode: number): number {
  return windows ? mode & 0o200 : mode & 0o777;
}
