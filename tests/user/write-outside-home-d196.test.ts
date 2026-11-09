// Decision D-196: run as root in the home directory of another user (sudo with HOME kept), apply --user and init --user
// write nothing through a symbolic link that leads out of the real home directory. The owner of the home directory
// could point ~/.config/pip or ~/.npmrc at a file of root (or of the system) and have root rewrite it (found by the review
// of 1.6.0, already in 1.5.2). Files under an absolute XDG_CONFIG_HOME outside the home directory are written as before.
import { chownSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

async function exec(environment: UserEnvironment, ...argv: string[]): Promise<{ code: number; output: string }> {
  let output = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-09T12:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (output += text), stderr: (text) => (output += text) }, dependencies);
  return { code, output };
}

/** A machine whose home directory belongs to nobody, with the user policy, and a directory of root outside it. */
function machine(installed: Parameters<typeof fakeMachine>[0]): { environment: UserEnvironment; system: string } {
  const environment = fakeMachine(installed, temporary);
  const policy = userPolicyPath(environment);
  mkdirSync(dirname(policy), { recursive: true });
  writeFileSync(policy, JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
  const system = join(dirname(environment.home), 'system');
  mkdirSync(system, { recursive: true });
  chownSync(environment.home, NOBODY, NOBODY);
  return { environment, system };
}

describe.skipIf(!asRoot)('apply --user and init --user as root through a link out of the home directory (decision D-196)', () => {
  it('apply --user writes nothing through a directory link to a directory of root', async () => {
    const { environment, system } = machine({ python: { pip: '26.2.2' } });
    const pipConf = userFileOf('pip', environment);
    symlinkSync(system, dirname(pipConf));
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).not.toBe(EXIT_OK);
    expect(existsSync(join(system, 'pip.conf'))).toBe(false);
    expect(result.output).toContain(`~/.config/pip leads to ${realpathSync(system)}, outside the home directory ${environment.home}`);
  });

  // apply --user refused a link in place of the file itself already; this stays so.
  it('apply --user writes nothing through a file link to a file of root, and leaves that file as it is', async () => {
    const { environment, system } = machine({ npm: { npm: '11.21.1' } });
    const target = join(system, 'npmrc');
    writeFileSync(target, 'registry=https://registry.npmjs.org/\n');
    symlinkSync(target, userFileOf('npm', environment));
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).not.toBe(EXIT_OK);
    expect(readFileSync(target, 'utf8')).toBe('registry=https://registry.npmjs.org/\n');
    expect(result.output).toContain(`~/.npmrc leads to ${realpathSync(target)}, outside the home directory ${environment.home}`);
  });

  it('init --user writes no user policy through a link out of the home directory', async () => {
    const environment = fakeMachine({}, temporary);
    const system = join(dirname(environment.home), 'system');
    mkdirSync(system, { recursive: true });
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(dirname(policy)), { recursive: true });
    symlinkSync(system, dirname(policy));
    chownSync(environment.home, NOBODY, NOBODY);
    const result = await exec(environment, 'init', '--user');
    expect(result.code).not.toBe(EXIT_OK);
    expect(existsSync(join(system, 'depcurfew.json'))).toBe(false);
    expect(result.output).toContain(`~/.config/depcurfew leads to ${realpathSync(system)}, outside the home directory ${environment.home}`);
  });

  it('still writes through a link that stays in the home directory, and under an absolute XDG_CONFIG_HOME elsewhere', async () => {
    const { environment } = machine({ python: { pip: '26.2.2' } });
    const pipConf = userFileOf('pip', environment);
    const dotfiles = join(environment.home, 'dotfiles', 'pip');
    mkdirSync(dotfiles, { recursive: true });
    symlinkSync(dotfiles, dirname(pipConf));
    expect((await exec(environment, 'apply', '--user')).code).toBe(EXIT_OK);
    expect(readFileSync(join(dotfiles, 'pip.conf'), 'utf8')).toContain('depcurfew managed block');

    const other = machine({ python: { pip: '26.2.2' } });
    const config = join(dirname(other.environment.home), 'xdg');
    const elsewhere: UserEnvironment = { ...other.environment, env: { ...other.environment.env, XDG_CONFIG_HOME: config } };
    mkdirSync(dirname(userPolicyPath(elsewhere)), { recursive: true });
    writeFileSync(userPolicyPath(elsewhere), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
    expect((await exec(elsewhere, 'apply', '--user')).code).toBe(EXIT_OK);
    expect(existsSync(userFileOf('pip', elsewhere))).toBe(true);
  });
});
