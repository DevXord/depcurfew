// sudo depcurfew apply --user (or init --user) with HOME kept: files and directories it creates under the home
// directory belong to the owner of the home directory, not to root, so that the user can still change them (and run
// depcurfew init --user --force) afterwards. Only root can give files away, so the tests run only as root.
import { chownSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeChangeSets } from '../../src/apply/workspace.ts';
import { isInside } from '../../src/paths.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;
const NOBODY = 65534;

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

const owner = (path: string) => {
  const stats = lstatSync(path);
  return [stats.uid, stats.gid];
};

describe.skipIf(!asRoot)('apply --user and init --user as root in the home directory of another user', () => {
  it('init --user gives ~/.config/depcurfew and the user policy to the owner of the home directory', async () => {
    const environment = fakeMachine({}, temporary);
    chownSync(environment.home, NOBODY, NOBODY);
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_OK);
    const policy = userPolicyPath(environment);
    expect(owner(policy)).toEqual([NOBODY, NOBODY]);
    expect(owner(dirname(policy))).toEqual([NOBODY, NOBODY]);
    expect(owner(dirname(dirname(policy)))).toEqual([NOBODY, NOBODY]);
    // A second run with --force replaces the file and keeps its owner.
    expect((await exec(environment, 'init', '--user', '--force')).code).toBe(EXIT_OK);
    expect(owner(policy)).toEqual([NOBODY, NOBODY]);
  });

  it('apply --user gives new directories and files under the home directory to its owner, and leaves the home directory itself alone', async () => {
    const environment = fakeMachine({ python: { pip: '26.2.2' } }, temporary);
    mkdirSync(dirname(userPolicyPath(environment)), { recursive: true });
    writeFileSync(userPolicyPath(environment), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
    chownSync(environment.home, NOBODY, NOBODY);
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_OK);
    const pipConf = userFileOf('pip', environment);
    expect(owner(pipConf)).toEqual([NOBODY, NOBODY]);
    expect(owner(dirname(pipConf))).toEqual([NOBODY, NOBODY]);
    expect(statSync(environment.home).uid).toBe(NOBODY);
    // ~/.config existed already (it holds the user policy) and keeps its owner.
    expect(owner(dirname(dirname(pipConf)))).toEqual([0, 0]);
  });

  it('keeps root as the owner of files it creates outside the home directory', async () => {
    const machine = fakeMachine({ python: { pip: '26.2.2' } }, temporary);
    const config = join(machine.root, 'config');
    const environment: UserEnvironment = { ...machine, env: { ...machine.env, XDG_CONFIG_HOME: config } };
    mkdirSync(dirname(userPolicyPath(environment)), { recursive: true });
    writeFileSync(userPolicyPath(environment), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
    chownSync(environment.home, NOBODY, NOBODY);
    expect((await exec(environment, 'apply', '--user')).code).toBe(EXIT_OK);
    expect(owner(userFileOf('pip', environment))).toEqual([0, 0]);
    expect(owner(dirname(userFileOf('pip', environment)))).toEqual([0, 0]);
  });
});

describe.skipIf(!asRoot)('writeChangeSets with an owner for new files', () => {
  it('creates missing directories one level at a time and gives each to the owner', () => {
    const machine = fakeMachine({}, temporary);
    writeChangeSets([{ root: machine.home, changes: [{ file: 'a/b/c.txt', before: null, after: 'c\n' }] }], { ownerOfNew: () => ({ uid: NOBODY, gid: NOBODY }) });
    expect(owner(join(machine.home, 'a'))).toEqual([NOBODY, NOBODY]);
    expect(owner(join(machine.home, 'a', 'b'))).toEqual([NOBODY, NOBODY]);
    expect(owner(join(machine.home, 'a', 'b', 'c.txt'))).toEqual([NOBODY, NOBODY]);
  });

  it('asks for the owner by the real path, so that what a symlink leads out of the home directory stays root\'s', () => {
    const machine = fakeMachine({}, temporary);
    const elsewhere = join(machine.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(machine.home, 'link'));
    const ownerOfNew = (path: string) => (isInside(machine.home, path) ? { uid: NOBODY, gid: NOBODY } : undefined);
    writeChangeSets([{ root: machine.home, changes: [{ file: 'link/new/x.txt', before: null, after: 'x\n' }] }], { ownerOfNew });
    expect(owner(elsewhere)).toEqual([0, 0]);
    expect(owner(join(machine.home, 'link'))).toEqual([0, 0]);
    expect(owner(join(elsewhere, 'new'))).toEqual([0, 0]);
    expect(owner(join(elsewhere, 'new', 'x.txt'))).toEqual([0, 0]);
  });
});
