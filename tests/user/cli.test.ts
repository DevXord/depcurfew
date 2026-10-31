// depcurfew init --user and apply --user on the command line, with a temporary home directory and PATH.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { canSymlink } from '../support/platform.ts';
import { platform, shownPolicy } from '../support/user.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function machine(npmVersion?: string): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-cli-'));
  temporary.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (npmVersion !== undefined) {
    const pkg = join(root, 'lib', 'node_modules', 'npm');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'npm', version: npmVersion, bin: { npm: 'bin/npm-cli.js' } }));
    writeFileSync(join(pkg, 'bin', 'npm-cli.js'), '');
    symlinkSync(join(pkg, 'bin', 'npm-cli.js'), join(bin, 'npm'));
  }
  return { platform, home, env: { PATH: bin } };
}

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

describe('init --user', () => {
  it('writes the default policy to ~/.config/depcurfew/depcurfew.json, creating the directory, and refuses to overwrite it without --force', async () => {
    const environment = machine();
    const first = await exec(environment, 'init', '--user');
    expect(first.code).toBe(EXIT_OK);
    expect(first.stdout).toContain(`Created ${shownPolicy(environment)} with the default policy.\n`);
    const policy = userPolicyPath(environment);
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toMatchObject({ version: 1, cooldown: { minimum: '3d' } });
    const again = await exec(environment, 'init', '--user');
    expect(again.code).toBe(EXIT_FAILURE);
    expect(again.stderr).toContain(`error: ${shownPolicy(environment)} already exists (policy-exists)`);
    expect((await exec(environment, 'init', '--user', '--force')).code).toBe(EXIT_OK);
  });

  it('takes no directory', async () => {
    const result = await exec(machine(), 'init', '--user', 'somewhere');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--user takes no directory');
  });
});

describe('apply --user', () => {
  it('says how to create the user policy when there is none', async () => {
    const environment = machine();
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain(`error: no user policy at ${shownPolicy(environment)} (policy-missing)`);
    expect(result.stderr).toContain("fix: Run 'depcurfew init --user' first");
  });

  it.skipIf(!canSymlink())('prints a diff with --dry-run and writes nothing, then writes ~/.npmrc', async () => {
    const environment = machine('11.21.1');
    await exec(environment, 'init', '--user');
    const dry = await exec(environment, 'apply', '--user', '--dry-run');
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.stdout).toContain('+++ b/~/.npmrc\n');
    expect(dry.stdout).toContain('+min-release-age=3\n');
    expect(existsSync(join(environment.home, '.npmrc'))).toBe(false);
    const wet = await exec(environment, 'apply', '--user');
    expect(wet.code).toBe(EXIT_OK);
    expect(wet.stdout).toBe('Created ~/.npmrc\n');
    expect(readFileSync(join(environment.home, '.npmrc'), 'utf8')).toContain('min-release-age=3\n');
    const json = await exec(environment, 'apply', '--user', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 1, policy: 'valid', changes: [], written: false });
  });

  it('checks --for and allows it only with --user', async () => {
    const environment = machine();
    expect((await exec(environment, 'apply', '--for', 'npm@11.21.1')).stderr).toContain('--for works only with --user');
    const wrong = await exec(environment, 'apply', '--user', '--for', 'npm@latest');
    expect(wrong.code).toBe(EXIT_USAGE);
    expect(wrong.stderr).toContain("--for expects a package manager and an exact version, e.g. --for pnpm@11.28.10, not 'npm@latest'");
    expect((await exec(environment, 'apply', '--user', '--for', 'renovate@41.0.0')).code).toBe(EXIT_USAGE);
  });
});
