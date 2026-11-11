// Decision D-190: the local OSV.dev data guards its files as well as its directories (decision D-156). A data file
// that other users can write, or that belongs to another user, is a write problem like such a directory; a data file
// is read without following a symbolic link in its place and without a separate stat before the read, so that it
// cannot be swapped for a link or a FIFO between the two.
import { chmodSync, chownSync, copyFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalOsvData, osvDataFile } from '../../src/osv/data.ts';
import { localData } from '../support/osv-data.ts';
import { asRoot } from '../support/platform.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const posix = process.platform !== 'win32';

describe('the files of the local OSV.dev data (decision D-190)', () => {
  it.skipIf(!posix)('reports a data file every user can write, and still reads it', async () => {
    const directory = await localData(temporary, NOW);
    const file = osvDataFile(directory, 'npm');
    chmodSync(file, 0o666);
    const local = new LocalOsvData(directory);
    expect(local.writeProblem()).toMatchObject({ directory: file, kind: 'everyone' });
    expect(local.lookup({ ecosystem: 'npm', name: 'left-pad', version: '9.9.9' })).toEqual(['MAL-2026-90001']);
  });

  it.skipIf(!asRoot)('reports a data file that belongs to another user', async () => {
    const directory = await localData(temporary, NOW);
    const file = osvDataFile(directory, 'npm');
    chownSync(file, 65534, 65534);
    expect(new LocalOsvData(directory).writeProblem()).toMatchObject({ directory: file, kind: 'owner', id: 65534 });
  });

  it.skipIf(!posix)('does not follow a symbolic link in place of a data file', async () => {
    const directory = await localData(temporary, NOW);
    const file = osvDataFile(directory, 'npm');
    const elsewhere = join(directory, 'elsewhere.jsonl');
    copyFileSync(file, elsewhere);
    rmSync(file);
    symlinkSync(elsewhere, file);
    const local = new LocalOsvData(directory);
    expect(local.state('npm').status).toBe('unreadable');
    expect(local.lookup({ ecosystem: 'npm', name: 'left-pad', version: '9.9.9' })).toBeUndefined();
  });

  it.skipIf(!posix)('does not wait on a FIFO in place of a data file', async () => {
    const directory = await localData(temporary, NOW);
    const file = osvDataFile(directory, 'npm');
    renameSync(file, `${file}.old`);
    execFileSync('mkfifo', [file]);
    const local = new LocalOsvData(directory);
    expect(local.state('npm').status).toBe('unreadable');
  });
});
