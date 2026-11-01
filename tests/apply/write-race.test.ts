// A directory on the path of a file apply writes that becomes a symlink after apply looked at it (D-107): apply
// checks again right before staging and right before each rename that the file's directory is still inside the
// root, and the same directory it was when the file was staged, and writes nothing otherwise.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProject, ApplyWriteError, planRepository } from '../../src/apply/index.ts';
import { WriteFailed, writeChanges } from '../../src/apply/workspace.ts';
import { parsePolicy } from '../../src/policy/validate.ts';
import { windows } from '../support/platform.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/repos/multi-project', import.meta.url));
const POLICY = readFileSync(new URL('../fixtures/expected/multi-project/depcurfew.json', import.meta.url), 'utf8');

let directory: string;
let outside: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'depcurfew-write-race-'));
  outside = mkdtempSync(join(tmpdir(), 'depcurfew-write-race-outside-'));
  cpSync(FIXTURE, directory, { recursive: true });
  writeFileSync(join(directory, 'depcurfew.json'), POLICY);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Moves frontend out of the repository and leaves a symlink to it in its place. */
function swapFrontend(): void {
  renameSync(join(directory, 'frontend'), join(outside, 'frontend'));
  symlinkSync(join(outside, 'frontend'), join(directory, 'frontend'), 'dir');
}

function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
}

describe.skipIf(windows)('apply writes nothing through a directory swapped for a symlink', () => {
  it('between the plan and the write', () => {
    const before = readFileSync(join(directory, '.github', 'dependabot.yml'), 'utf8');
    let failure: unknown;
    try {
      applyProject(directory, { beforeWrite: swapFrontend });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplyWriteError);
    const error = failure as ApplyWriteError;
    expect(error.code).toBe('cannot-write');
    expect(error.file).toBe('frontend/.npmrc');
    expect(error.message).toBe('cannot write frontend/.npmrc: a directory on its path is a symlink that leads outside the directory depcurfew writes to');
    expect(error.fix).toBe('Make every directory on the way to frontend/.npmrc a real directory inside the repository rather than a symlink, then run depcurfew apply again');
    expect(existsSync(join(outside, 'frontend', '.npmrc'))).toBe(false);
    expect(readFileSync(join(outside, 'frontend', 'package.json'), 'utf8')).toBe(readFileSync(join(FIXTURE, 'frontend', 'package.json'), 'utf8'));
    // The files written before it were put back: nothing changed in the repository.
    expect(readFileSync(join(directory, '.github', 'dependabot.yml'), 'utf8')).toBe(before);
    expect(snapshot(outside)).toEqual(['frontend', 'frontend/package-lock.json', 'frontend/package.json']);
  });

  it('between staging and the renames, putting back what was renamed', () => {
    const policy = parsePolicy(POLICY);
    if (!policy.ok) throw new Error('invalid policy');
    const report = planRepository(directory, policy.policy);
    const before = readFileSync(join(directory, '.github', 'dependabot.yml'), 'utf8');
    let failure: unknown;
    try {
      writeChanges(directory, report.changes, {
        staged: () => {
          // The temporary files of frontend move along with it; a symlink to the moved directory takes its place.
          swapFrontend();
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WriteFailed);
    expect((failure as WriteFailed).file).toBe('frontend/.npmrc');
    expect((failure as WriteFailed).reason).toBe('a directory on its path is a symlink that leads outside the directory depcurfew writes to');
    expect(readFileSync(join(directory, '.github', 'dependabot.yml'), 'utf8')).toBe(before);
    expect(existsSync(join(outside, 'frontend', '.npmrc'))).toBe(false);
    expect(readFileSync(join(outside, 'frontend', 'package.json'), 'utf8')).toBe(readFileSync(join(FIXTURE, 'frontend', 'package.json'), 'utf8'));
    expect(snapshot(outside)).toEqual(['frontend', 'frontend/package-lock.json', 'frontend/package.json']);
  });

  it('when a directory inside the root is swapped for a symlink to another one inside the root after staging', () => {
    const changes = [{ file: 'a/file.txt', before: null, after: 'text\n' }];
    let failure: unknown;
    try {
      writeChanges(directory, changes, {
        staged: () => {
          renameSync(join(directory, 'a'), join(directory, 'b'));
          symlinkSync(join(directory, 'backend'), join(directory, 'a'), 'dir');
        },
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as WriteFailed).reason).toBe('a directory on its path changed while depcurfew was writing');
    expect(existsSync(join(directory, 'backend', 'file.txt'))).toBe(false);
  });

  it('creates no directory outside the root', () => {
    symlinkSync(outside, join(directory, 'out'), 'dir');
    expect(() => writeChanges(directory, [{ file: 'out/new/file.txt', before: null, after: 'text\n' }])).toThrow(WriteFailed);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('still writes through a symlink that stays inside the root', () => {
    symlinkSync(join(directory, 'backend'), join(directory, 'api'), 'dir');
    writeChanges(directory, [{ file: 'api/notes.txt', before: null, after: 'text\n' }]);
    expect(readFileSync(join(directory, 'backend', 'notes.txt'), 'utf8')).toBe('text\n');
  });
});
