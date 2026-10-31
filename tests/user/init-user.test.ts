// depcurfew init --user where the home directory or the way to the user policy is not usable (review of 1.2.0): an
// error with the path as the user sees it and what to do, never a stack trace and never a home directory created.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { windows } from '../support/platform.ts';
import { fakeMachine } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
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

const variable = windows ? 'USERPROFILE' : 'HOME';

describe('init --user with a home directory that does not exist', () => {
  it('refuses with home-missing, as apply --user does, and creates nothing', async () => {
    const machine = fakeMachine({}, temporary);
    const home = join(machine.root, 'nonexistent');
    const environment: UserEnvironment = { ...machine, home };
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `error: the home directory ${home} does not exist, so depcurfew init --user writes no user policy (home-missing)\n  fix: Set ${variable} to an existing directory, or run depcurfew init --user as a user who has a home directory\n`,
    );
    expect(existsSync(home)).toBe(false);
  });

  it('refuses also when XDG_CONFIG_HOME or APPDATA would put the user policy elsewhere', async () => {
    const machine = fakeMachine({}, temporary);
    const home = join(machine.root, 'nonexistent');
    const config = join(machine.root, 'config');
    mkdirSync(config);
    const environment: UserEnvironment = { ...machine, home, env: { ...machine.env, XDG_CONFIG_HOME: config, APPDATA: config } };
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('(home-missing)');
    expect(existsSync(userPolicyPath(environment))).toBe(false);
    expect(existsSync(home)).toBe(false);
  });
});

describe('init --user with a file where a directory belongs', () => {
  it('names ~/.config when it is a regular file, with a fix, instead of crashing', async () => {
    const environment = fakeMachine({}, temporary);
    const policy = userPolicyPath(environment);
    const blocker = join(policy, '..', '..');
    writeFileSync(blocker, 'not a directory\n');
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).not.toContain('unexpected error');
    const shown = windows ? '~/AppData/Roaming' : '~/.config';
    expect(result.stderr).toBe(
      `error: ${shown} is not a directory, so depcurfew init --user cannot create ${shown}/depcurfew/depcurfew.json (cannot-write)\n  fix: Move the file ${shown} out of the way, then run depcurfew init --user again\n`,
    );
  });

  it('names ~/.config/depcurfew when it is a regular file', async () => {
    const environment = fakeMachine({}, temporary);
    const policy = userPolicyPath(environment);
    mkdirSync(join(policy, '..', '..'), { recursive: true });
    writeFileSync(join(policy, '..'), '');
    const result = await exec(environment, 'init', '--user', '--force');
    expect(result.code).toBe(EXIT_FAILURE);
    const shown = windows ? '~/AppData/Roaming/depcurfew' : '~/.config/depcurfew';
    expect(result.stderr).toContain(`error: ${shown} is not a directory, so depcurfew init --user cannot create ${shown}/depcurfew.json (cannot-write)\n`);
    expect(result.stderr).toContain(`fix: Move the file ${shown} out of the way, then run depcurfew init --user again\n`);
  });
});
