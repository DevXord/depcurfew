// apply --user writes the user files of all tools or none, although they live in different directories (one
// workspace root each): a file that cannot be written puts back the ones already replaced, and the error names it as
// the user sees it. node:fs is wrapped to fail on chosen files, as in tests/apply/write-failure.test.ts, because the
// tests may run as root, which file permissions do not stop.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { windows } from '../support/platform.ts';
import { fakeMachine, shownUserFile, userFileOf } from '../support/user.ts';

const fault = vi.hoisted(() => ({
  /** Fail renameSync onto a path that ends like this. */
  rename: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (fault.rename !== undefined && String(to).endsWith(fault.rename)) {
        throw Object.assign(new Error(`EACCES: permission denied, rename '${String(to)}'`), { code: 'EACCES', syscall: 'rename', path: String(to) });
      }
      actual.renameSync(from, to);
    },
  };
});

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  fault.rename = undefined;
});

async function exec(environment: UserEnvironment, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-10-31T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

/** npm and uv, with ~/.npmrc in the home directory and the uv directory already there: two workspace roots. */
function twoRoots(): UserEnvironment & { root: string } {
  const environment = fakeMachine({ npm: { npm: '11.21.1' }, python: { uv: '0.13.6' } }, temporary);
  const policy = userPolicyPath(environment);
  mkdirSync(dirname(policy), { recursive: true });
  writeFileSync(policy, JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
  writeFileSync(join(environment.home, '.npmrc'), 'save-exact=true\n');
  mkdirSync(dirname(userFileOf('uv', environment)), { recursive: true });
  return environment;
}

/** Every file under a directory with its text, to compare before and after. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = readFileSync(join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

describe('apply --user when one user file cannot be written', () => {
  it('puts back the files of the other tools and names the file under ~/', async () => {
    const environment = twoRoots();
    const before = snapshot(environment.home);
    fault.rename = windows ? 'uv\\uv.toml' : 'uv/uv.toml';
    const shown = shownUserFile('uv', environment);
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`error: cannot write ${shown}: permission denied (cannot-write)\n`);
    if (!windows) expect(result.stderr).toContain(`  fix: Make ${shown} and its directory writable for the user that runs depcurfew, then run depcurfew apply --user again\n`);
    expect(result.stderr).toContain('depcurfew: nothing written because of the errors above.\n');
    expect(snapshot(environment.home)).toEqual(before);
    expect(existsSync(userFileOf('uv', environment))).toBe(false);
  });

  it('says so in JSON: nothing written, the file under ~/', async () => {
    const environment = twoRoots();
    const before = snapshot(environment.home);
    fault.rename = windows ? 'uv\\uv.toml' : 'uv/uv.toml';
    const shown = shownUserFile('uv', environment);
    const result = await exec(environment, 'apply', '--user', '--json');
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({ written: false, changes: [], errors: [{ code: 'cannot-write', level: 'error', location: { file: shown }, message: `cannot write ${shown}: permission denied` }] });
    expect(snapshot(environment.home)).toEqual(before);
  });

  it('writes both files when nothing fails', async () => {
    const environment = twoRoots();
    const result = await exec(environment, 'apply', '--user');
    expect(result.stdout).toBe(`Updated ~/.npmrc\nCreated ${shownUserFile('uv', environment)}\n`);
    expect(readFileSync(userFileOf('uv', environment), 'utf8')).toContain('exclude-newer = "3 days"\n');
  });
});
