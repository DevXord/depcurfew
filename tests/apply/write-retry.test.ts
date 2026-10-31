// Writing on Windows: another process (an antivirus scanner, the search indexer, an editor) may hold a file for a
// moment, and Windows then refuses to replace or remove it with EPERM, EACCES or EBUSY. writeChanges tries again with
// growing waits there, and says which temporary files it could not remove and where the earlier text of a file it could
// not put back is. node:fs is wrapped to fail on chosen files; the platform and the wait are passed in.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyWriteError, type ApplyReport } from '../../src/apply/index.ts';
import { WriteFailed, writeChanges, type FileChange } from '../../src/apply/workspace.ts';

const fault = vi.hoisted(() => ({
  /** renameSync onto a path ending like this fails with `code`, `times` times (Infinity: always). */
  rename: undefined as { suffix: string; code: string; times: number } | undefined,
  /** renameSync of a temporary file that restores the earlier text of a path ending like this always fails. */
  restore: undefined as string | undefined,
  /** rmSync of a temporary file next to a path ending like this always fails with EPERM. */
  remove: undefined as string | undefined,
  renames: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fail = (code: string, call: string, path: string): never => {
    throw Object.assign(new Error(`${code}: refused, ${call} '${path}'`), { code, syscall: call, path });
  };
  const renameSync = (from: string, to: string) => {
    const rule = fault.rename;
    if (rule !== undefined && String(to).endsWith(rule.suffix) && fault.renames < rule.times) {
      fault.renames += 1;
      fail(rule.code, 'rename', String(to));
    }
    if (fault.restore !== undefined && String(to).endsWith(fault.restore) && actual.readFileSync(from, 'utf8') === 'old\n') fail('EPERM', 'rename', String(to));
    actual.renameSync(from, to);
  };
  const rmSync = (path: string, options?: object) => {
    if (fault.remove !== undefined && String(path).includes(`${fault.remove}.depcurfew-`)) fail('EPERM', 'rm', String(path));
    actual.rmSync(path, options);
  };
  return { ...actual, renameSync, rmSync, default: { ...actual, renameSync, rmSync } };
});

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  fault.rename = undefined;
  fault.restore = undefined;
  fault.remove = undefined;
  fault.renames = 0;
});

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-write-retry-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'a.txt'), 'old\n');
  writeFileSync(join(directory, 'b.txt'), 'old\n');
  return directory;
}

const CHANGES: FileChange[] = [
  { file: 'a.txt', before: 'old\n', after: 'new\n' },
  { file: 'b.txt', before: 'old\n', after: 'new\n' },
];

function contents(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).map((file) => [file, readFileSync(join(directory, file), 'utf8')]));
}

function failure(action: () => void): WriteFailed {
  try {
    action();
  } catch (error) {
    if (error instanceof WriteFailed) return error;
    throw error;
  }
  throw new Error('writeChanges did not fail');
}

describe('writeChanges on Windows', () => {
  it('tries a rename again while another program holds the file', () => {
    const directory = project();
    const waits: number[] = [];
    fault.rename = { suffix: 'b.txt', code: 'EBUSY', times: 3 };
    writeChanges(directory, CHANGES, { platform: 'win32', sleep: (milliseconds) => waits.push(milliseconds) });
    expect(contents(directory)).toEqual({ 'a.txt': 'new\n', 'b.txt': 'new\n' });
    expect(waits).toEqual([10, 20, 40]);
  });

  it.each(['EPERM', 'EACCES'])('tries again on %s too', (code) => {
    const directory = project();
    const waits: number[] = [];
    fault.rename = { suffix: 'a.txt', code, times: 1 };
    writeChanges(directory, CHANGES, { platform: 'win32', sleep: (milliseconds) => waits.push(milliseconds) });
    expect(contents(directory)).toEqual({ 'a.txt': 'new\n', 'b.txt': 'new\n' });
    expect(waits).toEqual([10]);
  });

  it('gives up after a few seconds, puts back what it wrote and removes its temporary files', () => {
    const directory = project();
    const waits: number[] = [];
    fault.rename = { suffix: 'b.txt', code: 'EPERM', times: Number.POSITIVE_INFINITY };
    const error = failure(() => writeChanges(directory, CHANGES, { platform: 'win32', sleep: (milliseconds) => waits.push(milliseconds) }));
    expect(error.file).toBe('b.txt');
    expect(error.busy).toBe(true);
    expect(error.message).toBe('operation not permitted');
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeGreaterThanOrEqual(3000);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(5000);
    expect(contents(directory)).toEqual({ 'a.txt': 'old\n', 'b.txt': 'old\n' });
  });

  it('does not wait on other systems, where EBUSY does not pass', () => {
    const directory = project();
    const waits: number[] = [];
    fault.rename = { suffix: 'a.txt', code: 'EBUSY', times: 1 };
    const error = failure(() => writeChanges(directory, CHANGES, { platform: 'linux', sleep: (milliseconds) => waits.push(milliseconds) }));
    expect(error.busy).toBe(true);
    expect(waits).toEqual([]);
    expect(contents(directory)).toEqual({ 'a.txt': 'old\n', 'b.txt': 'old\n' });
  });

  it('keeps a file with the earlier text when it cannot put a file back, and says where it is', () => {
    const directory = project();
    fault.rename = { suffix: 'b.txt', code: 'EBUSY', times: Number.POSITIVE_INFINITY };
    fault.restore = 'a.txt';
    const error = failure(() => writeChanges(directory, CHANGES, { platform: 'win32', sleep: () => undefined }));
    expect(error.unrestored).toEqual(['a.txt']);
    const backup = Object.keys(contents(directory)).find((file) => file.startsWith('a.txt.depcurfew-')) as string;
    expect(backup).toBeDefined();
    expect(error.backups).toEqual({ 'a.txt': backup });
    expect(readFileSync(join(directory, backup), 'utf8')).toBe('old\n');
    expect(error.message).toBe(`the file is busy; a.txt had already been replaced and could not be put back (its earlier text is in ${backup})`);
  });

  it('names the temporary files it cannot remove instead of failing with a stack trace', () => {
    const directory = project();
    fault.rename = { suffix: 'a.txt', code: 'EPERM', times: Number.POSITIVE_INFINITY };
    fault.remove = 'b.txt';
    const error = failure(() => writeChanges(directory, CHANGES, { platform: 'win32', sleep: () => undefined }));
    const leftover = Object.keys(contents(directory)).find((file) => file.startsWith('b.txt.depcurfew-')) as string;
    expect(error.leftovers).toEqual([leftover]);
    expect(error.message).toBe(`operation not permitted; the temporary file ${leftover} could not be removed`);
    expect(existsSync(join(directory, 'a.txt'))).toBe(true);
  });
});

describe('what apply says about a file another program holds', () => {
  const report = { changes: CHANGES, warnings: [], errors: [], failures: [], snippets: [] } as unknown as ApplyReport;
  const busy = (code: string, platform: NodeJS.Platform, extra: { unrestored?: string[]; backups?: Record<string, string>; leftovers?: string[] } = {}) =>
    new ApplyWriteError(
      new WriteFailed('.npmrc', Object.assign(new Error(code), { code }), extra.unrestored ?? [], { platform, backups: extra.backups ?? {}, leftovers: extra.leftovers ?? [] }),
      report,
    );

  it('tells to close the program or clear the read-only attribute on Windows', () => {
    expect(busy('EPERM', 'win32').fix).toBe(
      'Close the program that has .npmrc open (an editor or a sync client; a virus scan ends by itself), clear the read-only attribute if it is set (attrib -r .npmrc), then run depcurfew apply again',
    );
    expect(busy('EBUSY', 'linux').fix).toBe('Close the program that has .npmrc open, then run depcurfew apply again');
  });

  it('keeps the advice about permissions for EACCES and EPERM elsewhere', () => {
    expect(busy('EPERM', 'linux').fix).toBe('Make .npmrc and its directory writable for the user that runs depcurfew, then run depcurfew apply again');
  });

  it('says where the earlier text is and which temporary files to delete', () => {
    const error = busy('EBUSY', 'win32', { unrestored: ['renovate.json'], backups: { 'renovate.json': 'renovate.json.depcurfew-1-2-3' }, leftovers: ['.npmrc.depcurfew-1-2-4'] });
    expect(error.fix).toBe(
      'Restore renovate.json from renovate.json.depcurfew-1-2-3, which holds its earlier text, or from version control. Delete .npmrc.depcurfew-1-2-4. Close the program that has .npmrc open (an editor or a sync client; a virus scan ends by itself), clear the read-only attribute if it is set (attrib -r .npmrc), then run depcurfew apply again',
    );
  });
});
