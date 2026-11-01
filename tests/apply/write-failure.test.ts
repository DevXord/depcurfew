// `depcurfew apply` when the file system refuses a read or a write (D-074). The tests run as any user, root
// included, so node:fs is wrapped to fail on chosen files instead of relying on file permissions.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '../../src/apply/workspace.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import { comparableMode, windows } from '../support/platform.ts';

const fault = vi.hoisted(() => ({
  /** Fail renameSync onto a path that ends like this. */
  rename: undefined as string | undefined,
  /** Fail creating a temporary file next to a path that ends like this. */
  write: undefined as string | undefined,
  /** Fail openSync and readFileSync of a path that ends like this. */
  read: undefined as string | undefined,
  /** The mode of every temporary file right after it was created. */
  modes: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const refuse = (call: string, path: string): never => {
    throw Object.assign(new Error(`EACCES: permission denied, ${call} '${path}'`), { code: 'EACCES', syscall: call, path });
  };
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fault.rename !== undefined && String(to).endsWith(fault.rename)) refuse('rename', String(to));
      actual.renameSync(from, to);
    },
    // writeChanges creates each temporary file with openSync and writes it through the descriptor.
    openSync: (path: string, flags: number | string, mode?: number) => {
      const temporary = String(path).includes('.depcurfew-');
      if (temporary && fault.write !== undefined && String(path).split('.depcurfew-')[0]?.endsWith(fault.write)) refuse('open', String(path));
      if (fault.read !== undefined && String(path).endsWith(fault.read)) refuse('open', String(path));
      const descriptor = actual.openSync(path, flags, mode);
      if (temporary) fault.modes.push(actual.fstatSync(descriptor).mode & 0o777);
      return descriptor;
    },
    readFileSync: (path: string, options?: unknown) => {
      if (fault.read !== undefined && String(path).endsWith(fault.read)) refuse('open', String(path));
      return actual.readFileSync(path, options as never);
    },
  };
});

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  fault.rename = undefined;
  fault.write = undefined;
  fault.read = undefined;
  fault.modes = [];
});

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-write-failure-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'package.json'), '{ "name": "demo", "packageManager": "npm@11.19.1" }\n');
  writeFileSync(join(directory, 'renovate.json'), '{\n  "extends": ["config:recommended"]\n}\n');
  writeFileSync(join(directory, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n', { mode: 0o600 });
  writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm", "renovate"] }\n');
  return directory;
}

/**
 * The fix for a rename refused with EACCES: on Windows that means another program holds the file or it is read-only
 * (apply tries again for a few seconds first), elsewhere that the user may not write it.
 */
const refusedFix = windows
  ? 'Close the program that has renovate.json open (an editor or a sync client; a virus scan ends by itself), clear the read-only attribute if it is set (attrib -r renovate.json), then run depcurfew apply again'
  : 'Make renovate.json and its directory writable for the user that runs depcurfew, then run depcurfew apply again';

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).map((file) => [file, readFileSync(join(directory, file), 'utf8')]));
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('apply when a file cannot be written', () => {
  it('puts back what it wrote and reports the file, with a code and a fix', async () => {
    const directory = project();
    const before = snapshot(directory);
    fault.rename = 'renovate.json';
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: cannot write renovate.json: permission denied (cannot-write)\n');
    expect(result.stderr).toContain(`  fix: ${refusedFix}\n`);
    expect(result.stderr).toContain('note: nothing written because of the errors above\n');
    expect(result.stderr).not.toContain('unexpected error');
    expect(snapshot(directory)).toEqual(before);
    expect(comparableMode(statSync(join(directory, '.npmrc')).mode)).toBe(comparableMode(0o600));
  });

  it('prints one JSON document on stdout with --json', async () => {
    const directory = project();
    const before = snapshot(directory);
    fault.rename = 'renovate.json';
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe('');
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({ schemaVersion: 1, policy: 'valid', dryRun: false, written: false, changes: [], summary: { changes: 0, errors: 1 } });
    expect(document['errors']).toEqual([
      {
        code: 'cannot-write',
        level: 'error',
        location: { file: 'renovate.json' },
        message: 'cannot write renovate.json: permission denied',
        fix: refusedFix,
      },
    ]);
    expect(snapshot(directory)).toEqual(before);
  });

  it('reports a directory it cannot write a temporary file into', async () => {
    const directory = project();
    const before = snapshot(directory);
    fault.write = '.npmrc';
    const result = await exec('apply', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('error: cannot write .npmrc: permission denied (cannot-write)\n');
    expect(snapshot(directory)).toEqual(before);
  });

  it('creates the temporary file of .npmrc with the mode of .npmrc', async () => {
    const directory = project();
    const renovate = statSync(join(directory, 'renovate.json')).mode;
    const result = await exec('apply', directory);
    expect(result.code).toBe(0);
    // .npmrc and renovate.json, in the order of their names; Windows keeps only whether the file can be written.
    expect(fault.modes.map(comparableMode)).toEqual([0o600, renovate].map(comparableMode));
    expect(comparableMode(statSync(join(directory, '.npmrc')).mode)).toBe(comparableMode(0o600));
  });
});

describe('apply when a file cannot be read', () => {
  it('says in plain words that permission is denied', () => {
    const directory = project();
    fault.read = '.npmrc';
    expect(() => new Workspace(directory).read('.npmrc')).toThrow('.npmrc cannot be read: permission denied');
  });

  it('reports the file as one that cannot be edited', async () => {
    const directory = project();
    fault.read = 'renovate.json';
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as { errors: { code: string; location: { file: string }; message: string }[] };
    expect(document.errors.map((error) => [error.code, error.location.file, error.message])).toEqual([
      ['cannot-edit', 'renovate.json', 'Renovate: cannot edit renovate.json: renovate.json cannot be read: permission denied'],
    ]);
  });
});
