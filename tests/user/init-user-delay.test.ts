// init --user keeps the longest release-age delay the user files of the installed tools already set, as init does in
// a project (decisions D-075 and D-101), so that apply --user does not shorten it. Temporary home and PATH.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, shownPolicy, shownUserFile, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

async function exec(environment: UserEnvironment, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-01T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

/** Writes a user file, creating its directory (on Windows the fake home has no AppData yet). */
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const minimum = (environment: UserEnvironment): unknown => (JSON.parse(readFileSync(userPolicyPath(environment), 'utf8')) as { cooldown: { minimum: unknown } }).cooldown.minimum;

describe('init --user and a longer delay in the user files', () => {
  it('takes min-release-age=7 from ~/.npmrc as 7d, says where it found it, and apply --user then keeps it', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    write(userFileOf('npm', environment), 'registry=https://registry.npmjs.org/\nmin-release-age=7\n');
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      `Created ${shownPolicy(environment)} with the default policy.\n` +
        // A note with its code and fix (decision D-122).
        'note: cooldown.minimum is 7d instead of 3d, to keep the longest release-age delay already set: min-release-age=7 in ~/.npmrc (line 2) (cooldown-kept)\n' +
        `  fix: Leave cooldown.minimum as it is to keep that delay, or lower it in ${shownPolicy(environment)} before you run depcurfew apply --user\n` +
        'Run depcurfew apply --user --dry-run to see what it writes into the user-level configuration of your tools.\n',
    );
    expect(minimum(environment)).toBe('7d');
    const plan = await exec(environment, 'apply', '--user', '--dry-run', '--json');
    const report = JSON.parse(plan.stdout) as { warnings: { code: string }[] };
    expect(report.warnings.map((warning) => warning.code)).not.toContain('cooldown-shortened');
    // The block keeps the line as it is: 7 days, not 3.
    expect(plan.stdout).toContain('apply --user instead\\n min-release-age=7\\n');
  });

  it('takes exclude-newer = "2 weeks" from uv.toml as 14d', async () => {
    const environment = fakeMachine({ python: { uv: '0.13.6' } }, temporary);
    write(userFileOf('uv', environment), '# mine\nexclude-newer = "2 weeks"\n');
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(
      `note: cooldown.minimum is 14d instead of 3d, to keep the longest release-age delay already set: exclude-newer = "2 weeks" in ${shownUserFile('uv', environment)} (line 2) (cooldown-kept)\n`,
    );
    expect(minimum(environment)).toBe('14d');
  });

  it('keeps the default when no user file sets a delay, or only a shorter one, a date or a value the tool ignores', async () => {
    const none = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const plain = await exec(none, 'init', '--user');
    expect(plain.stdout).not.toContain('cooldown.minimum is');
    expect(minimum(none)).toBe('3d');

    const shorter = fakeMachine({ npm: { npm: '11.21.1' }, python: { uv: '0.13.6' } }, temporary);
    write(userFileOf('npm', shorter), 'min-release-age=1\n');
    write(userFileOf('uv', shorter), 'exclude-newer = "2026-01-01T00:00:00Z"\n');
    expect((await exec(shorter, 'init', '--user')).stdout).not.toContain('cooldown.minimum is');
    expect(minimum(shorter)).toBe('3d');
  });

  it('picks the longest of several tools and rounds up to whole minutes (Bun counts seconds)', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1', bun: '1.4.4' } }, temporary);
    write(userFileOf('npm', environment), 'min-release-age=4\n');
    // 400001 seconds are 6666.68 minutes, longer than 4 days (5760 minutes): the policy gets 6667m, never the shorter 6666m.
    write(userFileOf('bun', environment), '[install]\nminimumReleaseAge = 400001\n');
    const result = await exec(environment, 'init', '--user');
    expect(result.stdout).toContain(`note: cooldown.minimum is 6667m instead of 3d, to keep the longest release-age delay already set: install.minimumReleaseAge = 400001 in ${shownUserFile('bun', environment)} (line 2) (cooldown-kept)\n`);
    expect(minimum(environment)).toBe('6667m');
  });

  it('reads min-release-age in ~/.npmrc as days for Deno, whose own setting takes minutes, and skips values Deno ignores', async () => {
    const environment = fakeMachine({ npm: { deno: '2.9.8' } }, temporary);
    write(userFileOf('deno', environment), 'min-release-age=5\n');
    expect((await exec(environment, 'init', '--user')).stdout).toContain('min-release-age=5 in ~/.npmrc (line 1) (cooldown-kept)\n');
    expect(minimum(environment)).toBe('5d');

    const ignored = fakeMachine({ npm: { deno: '2.9.8' } }, temporary);
    write(userFileOf('deno', ignored), 'min-release-age=72h\n');
    expect((await exec(ignored, 'init', '--user')).stdout).not.toContain('cooldown.minimum is');
  });

  it('keeps the delay with --force too, and reads it from inside depcurfew\'s managed block', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    expect((await exec(environment, 'init', '--user')).code).toBe(EXIT_OK);
    writeFileSync(userPolicyPath(environment), readFileSync(userPolicyPath(environment), 'utf8').replace('"3d"', '"10d"'));
    expect((await exec(environment, 'apply', '--user')).code).toBe(EXIT_OK);
    expect(readFileSync(join(environment.home, '.npmrc'), 'utf8')).toContain('min-release-age=10\n');
    const again = await exec(environment, 'init', '--user', '--force');
    expect(again.stdout).toContain(`Overwrote ${shownPolicy(environment)} with the default policy.\nnote: cooldown.minimum is 10d instead of 3d`);
    expect(minimum(environment)).toBe('10d');
  });
});
