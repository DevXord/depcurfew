// apply --user when a user file cannot be used or the environment is unusual (review of 1.2.0): every problem is an
// error or a warning that names the file as the user sees it (~/.config/pip/pip.conf), never a silent skip, and
// nothing is written outside the home directory's real places.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { validatePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { planUserApply } from '../../src/user/apply.ts';
import { shownPath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { canSymlink } from '../support/platform.ts';
import { fakeMachine, shownPolicy, shownUserFile, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function policy(document: unknown): ResolvedPolicy {
  const result = validatePolicy(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] } };

/** Writes the user policy of the environment. */
function withPolicy(environment: UserEnvironment, document: unknown = POLICY): void {
  const path = userPolicyPath(environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(document));
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

const PIP = { pip: '26.1' };

describe('apply --user reports a user file it cannot read instead of skipping it', () => {
  const cases: [string, (path: string) => void, (shown: string) => string, (shown: string) => string][] = [
    [
      'is not UTF-8',
      (path) => writeFileSync(path, Buffer.from([0xff, 0xfe, 0x5b, 0x67, 0x0a])),
      (shown) => `${shown} is not valid UTF-8, so depcurfew does not edit it; save it as UTF-8`,
      (shown) => `Save ${shown} as UTF-8, then run depcurfew apply --user again`,
    ],
    [
      'is larger than 1 MiB',
      (path) => writeFileSync(path, `[global]\n${'#'.repeat(1024 * 1024)}\n`),
      (shown) => `${shown} is larger than 1 MiB, so depcurfew does not edit it`,
      (shown) => `Make ${shown} smaller than 1 MiB, then run depcurfew apply --user again; or add the settings of the user policy by hand`,
    ],
    [
      'is a directory',
      (path) => mkdirSync(path),
      (shown) => `${shown} cannot be read: it is a directory`,
      (shown) => `Remove or rename the directory ${shown}, then run depcurfew apply --user again`,
    ],
  ];
  it.each(cases)('a pip.conf that %s is an error with the file as the user sees it and a fix for it, and nothing is planned', (_name, prepare, message, fix) => {
    const environment = fakeMachine({ python: PIP }, temporary);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    prepare(path);
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const planned = planUserApply(policy(POLICY), { environment });
    expect(planned.report.errors).toEqual([`pip: cannot edit ${shown}: ${message(shown)}`]);
    expect(planned.report.failures).toEqual([{ tool: 'pip', file: shown, message: message(shown), fix: fix(shown) }]);
  });

  it.skipIf(!canSymlink())('a symlinked pip.conf is an error', () => {
    const environment = fakeMachine({ python: PIP }, temporary);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(environment.root, 'elsewhere.conf'), '[global]\n');
    symlinkSync(join(environment.root, 'elsewhere.conf'), path);
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const planned = planUserApply(policy(POLICY), { environment });
    expect(planned.report.errors).toEqual([`pip: cannot edit ${shown}: ${shown} is a symlink; depcurfew does not write through symlinks`]);
    expect(planned.report.failures[0]?.fix).toBe(
      `Replace the symlink ${shown} with the file it points to, so that depcurfew apply --user can write it, or add the settings of the user policy to that file by hand`,
    );
  });

  it('reports a regular file where the directory of pip.conf belongs', () => {
    const environment = fakeMachine({ python: PIP }, temporary);
    const directory = dirname(userFileOf('pip', environment, [26, 1, 0]));
    mkdirSync(dirname(directory), { recursive: true });
    writeFileSync(directory, 'not a directory\n');
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const planned = planUserApply(policy(POLICY), { environment });
    expect(planned.report.errors).toEqual([`pip: cannot edit ${shown}: ${shownPath(directory, environment)} is not a directory`]);
    expect(planned.report.failures[0]?.fix).toBe(`Move the file ${shownPath(directory, environment)} out of the way, then run depcurfew apply --user again`);
  });

  it('writes nothing at all on the command line, and says where and how to run again', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' }, python: PIP }, temporary);
    withPolicy(environment);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([0xff, 0x0a]));
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `error: pip: cannot edit ${shown}: ${shown} is not valid UTF-8, so depcurfew does not edit it; save it as UTF-8 (cannot-edit)\n  fix: Save ${shown} as UTF-8, then run depcurfew apply --user again\n`,
    );
    expect(result.stderr).toContain('depcurfew: nothing written because of the errors above.\n');
    expect(existsSync(join(environment.home, '.npmrc'))).toBe(false);
  });
});

describe('apply --user names user files as the user sees them, in text and JSON', () => {
  it('reports invalid TOML in uv.toml with the path under ~/, the line, and a fix for apply --user', async () => {
    const environment = fakeMachine({ python: { uv: '0.13.6' } }, temporary);
    withPolicy(environment);
    const path = userFileOf('uv', environment);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'exclude-newer = = 1\n');
    const shown = shownUserFile('uv', environment);
    const fix = `Fix the TOML error in ${shown} at line 1, then run depcurfew apply --user again`;
    const text = await exec(environment, 'apply', '--user', '--dry-run');
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stderr).toMatch(new RegExp(`error: uv: cannot edit ${shown.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}: invalid TOML at line 1\\b.* \\(cannot-edit\\)\n`, 'u'));
    expect(text.stderr).toContain(`(cannot-edit)\n  fix: ${fix}\n`);
    const json = await exec(environment, 'apply', '--user', '--json');
    const document = JSON.parse(json.stdout) as { errors: Record<string, unknown>[] };
    expect(document.errors).toEqual([
      { code: 'cannot-edit', level: 'error', tool: 'uv', location: { file: shown, line: 1 }, message: expect.stringMatching(new RegExp(`^uv: cannot edit ${shown.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}: invalid TOML at line 1`, 'u')), fix },
    ]);
  });

  it.skipIf(!canSymlink())('names a symlinked ~/.npmrc as ~/.npmrc, with the tool', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    withPolicy(environment);
    writeFileSync(join(environment.root, 'npmrc'), 'save-exact=true\n');
    symlinkSync(join(environment.root, 'npmrc'), join(environment.home, '.npmrc'));
    const result = await exec(environment, 'apply', '--user');
    expect(result.stderr).toContain('error: npm: cannot edit ~/.npmrc: ~/.npmrc is a symlink; depcurfew does not write through symlinks (cannot-edit)\n');
  });
});

describe.skipIf(process.platform === 'win32')('apply --user with a relative XDG_CONFIG_HOME', () => {
  it('skips the tools that would read it, with a warning, and keeps those that ignore a relative value', () => {
    const machine = fakeMachine({ python: { pip: '26.1', uv: '0.13.6', poetry: '2.5.1' } }, temporary);
    const environment: UserEnvironment = { ...machine, platform: 'linux', env: { ...machine.env, XDG_CONFIG_HOME: 'cfg' } };
    const planned = planUserApply(policy(POLICY), { environment });
    // uv uses XDG_CONFIG_HOME only when it is absolute, so it falls back to ~/.config/uv.
    expect(planned.report.changes.map((change) => change.file)).toEqual(['~/.config/uv/uv.toml']);
    const relative = planned.report.warningDetails.filter((warning) => warning.code === 'user-directory-relative');
    expect(relative.map((warning) => warning.tool)).toEqual(['pip', 'poetry']);
    expect(relative[0]).toEqual({
      code: 'user-directory-relative',
      tool: 'pip',
      message: 'pip: XDG_CONFIG_HOME is the relative path "cfg", so pip reads cfg/pip/pip.conf relative to the directory each command runs in, a different file in each directory; nothing is written for it',
      fix: 'Set XDG_CONFIG_HOME to an absolute path, or unset it, then run depcurfew apply --user again',
    });
    expect(relative[1]?.message).toBe('Poetry: XDG_CONFIG_HOME is the relative path "cfg", and depcurfew does not know where Poetry looks for its user file then, so nothing is written for it');
    expect(existsSync(join(process.cwd(), 'cfg'))).toBe(false);
  });
});

describe('apply --user with a home directory that does not exist', () => {
  it('refuses with an error instead of creating it', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const home = join(machine.root, 'missing-home');
    const config = join(machine.root, 'config');
    const environment: UserEnvironment = { ...machine, home, env: { ...machine.env, XDG_CONFIG_HOME: config, APPDATA: config } };
    withPolicy(environment);
    const planned = planUserApply(policy(POLICY), { environment });
    expect(planned.report.changes).toEqual([]);
    expect(planned.report.errors).toEqual([`the home directory ${home} does not exist, so depcurfew apply --user has nowhere to write the user configuration`]);
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    expect(result.stderr).toContain(`(home-missing)\n  fix: Set ${variable} to an existing directory, or run depcurfew apply --user as a user who has a home directory\n`);
    const json = JSON.parse((await exec(environment, 'apply', '--user', '--json')).stdout) as { errors: { code: string; location: { file: string } }[] };
    expect(json.errors.map((error) => [error.code, error.location.file])).toEqual([['home-missing', home]]);
    expect(existsSync(home)).toBe(false);
  });
});

describe('apply --user --for', () => {
  it('accepts a version of two parts, as pip --version prints it', async () => {
    const machine = fakeMachine({}, temporary);
    // A pip whose version cannot be read from its files.
    writeFileSync(join(machine.root, 'venv', 'bin', 'pip'), '#!/bin/sh\n');
    withPolicy(machine);
    const result = await exec(machine, 'apply', '--user', '--dry-run', '--for', 'pip@26.1');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('+uploaded-prior-to = P3D\n');
  });

  it('warns when it names a tool that apply --user does not configure', () => {
    const environment = fakeMachine({}, temporary);
    const auto = planUserApply(policy(POLICY), { environment, versions: { pnpm: [10, 1, 0] } });
    expect(auto.report.warningDetails.find((warning) => warning.code === 'version-not-used')).toEqual({
      code: 'version-not-used',
      tool: 'pnpm',
      message: 'pnpm: --for pnpm@10.1.0 is not used, because pnpm is not in PATH and the user policy has targets "auto"',
      fix: `Add "pnpm" to targets in ${shownPolicy(environment)} to configure pnpm anyway, or leave out --for pnpm@10.1.0`,
    });
    const listed = planUserApply(policy({ ...POLICY, targets: ['npm'] }), { environment, versions: { pnpm: [10, 1, 0] } });
    expect(listed.report.warningDetails.find((warning) => warning.code === 'version-not-used')).toEqual({
      code: 'version-not-used',
      tool: 'pnpm',
      message: `pnpm: --for pnpm@10.1.0 is not used, because targets in ${shownPolicy(environment)} does not list pnpm`,
      fix: `Add "pnpm" to targets in ${shownPolicy(environment)}, or leave out --for pnpm@10.1.0`,
    });
  });

  it('says that targets lists no package manager when it lists only bots', () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const planned = planUserApply(policy({ ...POLICY, targets: ['renovate'] }), { environment });
    expect(planned.report.warningDetails).toEqual([
      {
        code: 'nothing-to-configure',
        message: `no tools to configure: targets in ${shownPolicy(environment)} lists no package manager, and depcurfew apply --user configures only package managers`,
        fix: `List the package managers under targets in ${shownPolicy(environment)}, or set targets to "auto" to configure the ones in PATH`,
      },
    ]);
  });
});

describe('apply --user with a user policy it cannot use', () => {
  it('says to fix the user policy, not a depcurfew.json in a repository', async () => {
    const environment = fakeMachine({}, temporary);
    withPolicy(environment, { version: 1, cooldown: { minimum: 'soon' } });
    const invalid = await exec(environment, 'apply', '--user');
    expect(invalid.stderr).toContain(`fix: Fix these problems in ${shownPolicy(environment)}; an editor that reads its $schema shows them as you type\n`);
    rmSync(userPolicyPath(environment));
    mkdirSync(userPolicyPath(environment));
    const directory = await exec(environment, 'apply', '--user');
    expect(directory.stderr).toContain(`fix: Make ${shownPolicy(environment)} a regular file of at most 1 MiB that the user running depcurfew can read\n`);
  });
});

describe('apply --user keeps the file it reads', () => {
  it('leaves a pip.conf it cannot edit as it was', async () => {
    const environment = fakeMachine({ python: PIP }, temporary);
    withPolicy(environment);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([0xff, 0x0a]));
    await exec(environment, 'apply', '--user');
    expect([...readFileSync(path)]).toEqual([0xff, 0x0a]);
  });
});

describe('apply --user and a file the tool reads ahead of its user file', () => {
  it('warns when ~/.npmrc gives pnpm 10 another value of a key written to rc, with the line and a fix', async () => {
    const environment = fakeMachine({ npm: { pnpm: '10.26.0' } }, temporary);
    withPolicy(environment);
    writeFileSync(join(environment.home, '.npmrc'), 'save-exact=true\nminimum-release-age=0\n');
    const rc = shownUserFile('pnpm', environment, [10, 26, 0]);
    const planned = planUserApply(policy(POLICY), { environment });
    expect(planned.report.changes.map((change) => change.file)).toEqual([rc]);
    expect(planned.report.warningDetails.filter((warning) => warning.code === 'user-setting-overridden')).toEqual([
      {
        code: 'user-setting-overridden',
        tool: 'pnpm',
        location: { file: '~/.npmrc', line: 2 },
        message: `pnpm: minimum-release-age=0 in ~/.npmrc (line 2) overrides the minimum-release-age=4320 that depcurfew apply --user writes to ${rc}, because pnpm 10.26.0 reads ~/.npmrc ahead of it`,
        fix: 'Remove the minimum-release-age line from ~/.npmrc, or set it to 4320 there',
      },
    ]);
    const result = await exec(environment, 'apply', '--user');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(`Created ${rc}\n`);
    expect(result.stderr).toContain('(user-setting-overridden)\n  fix: Remove the minimum-release-age line from ~/.npmrc, or set it to 4320 there\n');
  });

  it('says nothing when ~/.npmrc has the same value, or none', () => {
    const environment = fakeMachine({ npm: { pnpm: '10.26.0' } }, temporary);
    const codes = () => planUserApply(policy(POLICY), { environment }).report.warningDetails.map((warning) => warning.code);
    expect(codes()).not.toContain('user-setting-overridden');
    writeFileSync(join(environment.home, '.npmrc'), 'minimum-release-age=4320\n');
    expect(codes()).not.toContain('user-setting-overridden');
  });
});
