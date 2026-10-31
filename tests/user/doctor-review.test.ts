// doctor --user where it used to stay silent or speak awkwardly (review of 1.2.0): a home directory that does not
// exist, a relative XDG_CONFIG_HOME, --for for a tool that is not installed, ~/.npmrc that pnpm 10 reads ahead of a
// rc file apply --user has not written yet, and messages that name the tool once, hide credentials visibly and give
// the line of a broken user policy and a fix for each file they cannot check.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { canSymlink, windows } from '../support/platform.ts';
import { fakeMachine, shownPolicy, shownUserFile, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function withPolicy(environment: UserEnvironment, text = renderPolicy(DEFAULT_POLICY)): void {
  const path = userPolicyPath(environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Writes a tool's user file, with its directory. */
function userFile(id: Parameters<typeof userFileOf>[0], environment: UserEnvironment, text: string | Buffer, version?: Parameters<typeof userFileOf>[2]): string {
  const path = userFileOf(id, environment, version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function cli(environment: UserEnvironment, ...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-10-31T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => undefined }, dependencies);
  return { code, stdout };
}

const variable = windows ? 'USERPROFILE' : 'HOME';

describe('doctor --user with a home directory that does not exist', () => {
  it('is an error, also next to a valid user policy elsewhere, instead of "No problems found"', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const home = join(machine.root, 'nohome');
    const config = join(machine.root, 'xdg');
    const environment: UserEnvironment = { ...machine, home, env: { ...machine.env, XDG_CONFIG_HOME: config, APPDATA: config } };
    withPolicy(environment);
    const report = runUserDoctor({ environment });
    expect(report.policy).toBe('valid');
    expect(report.findings).toEqual([
      {
        rule: 'user-config-unreadable',
        level: 'error',
        location: { file: home },
        message: `the home directory ${home} does not exist, so depcurfew doctor --user cannot check the user configuration in it`,
        fix: `Set ${variable} to an existing directory, or run depcurfew doctor --user as a user who has a home directory`,
      },
    ]);
    const text = await cli(environment, 'doctor', '--user');
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stdout).not.toContain('No problems found');
    const json = await cli(environment, 'doctor', '--user', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ summary: { error: 1 } });
  });

  it('is an error without a user policy too', () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const environment: UserEnvironment = { ...machine, home: join(machine.root, 'nohome') };
    expect(runUserDoctor({ environment }).findings.map((finding) => [finding.rule, finding.level])).toEqual([['user-config-unreadable', 'error']]);
  });
});

describe.skipIf(windows)('doctor --user with a relative XDG_CONFIG_HOME', () => {
  it('warns about the variable, naming the tools, and checks the pip.conf pip reads from the current directory', () => {
    const machine = fakeMachine({ python: { pip: '26.2.2', poetry: '2.5.1', uv: '0.13.6' } }, temporary);
    const cwd = mkdtempSync(join(tmpdir(), 'depcurfew-cwd-'));
    temporary.push(cwd);
    mkdirSync(join(cwd, 'cfg', 'pip'), { recursive: true });
    writeFileSync(join(cwd, 'cfg', 'pip', 'pip.conf'), '[global]\nno-binary = :all:\n');
    const environment: UserEnvironment = { ...machine, platform: 'linux', cwd, env: { ...machine.env, XDG_CONFIG_HOME: 'cfg' } };
    const report = runUserDoctor({ environment });
    const relative = report.findings.filter((finding) => finding.location.variable === 'XDG_CONFIG_HOME');
    expect(relative).toEqual([
      {
        rule: 'user-environment-overrides',
        level: 'warning',
        location: { file: 'environment', variable: 'XDG_CONFIG_HOME' },
        message:
          'XDG_CONFIG_HOME is the relative path "cfg": pip reads cfg/pip/pip.conf relative to the directory each command runs in, and where Poetry looks for its user file then is not known, so depcurfew apply --user writes nothing for them',
        fix: 'Set XDG_CONFIG_HOME to an absolute path, or unset it, in your shell profile or CI settings, then run depcurfew apply --user',
      },
    ]);
    const weakens = report.findings.filter((finding) => finding.rule === 'user-config-weakens');
    expect(weakens).toEqual([
      expect.objectContaining({
        location: { file: join(cwd, 'cfg', 'pip', 'pip.conf'), line: 2 },
        message: expect.stringContaining(`no-binary = ":all:" in [global] of ${join(cwd, 'cfg', 'pip', 'pip.conf')} (pip) builds every package from source`) as string,
      }),
    ]);
  });

  it('says it once for one tool, without a user policy', () => {
    const machine = fakeMachine({ python: { poetry: '2.5.1' } }, temporary);
    const environment: UserEnvironment = { ...machine, platform: 'linux', cwd: machine.root, env: { ...machine.env, XDG_CONFIG_HOME: 'cfg' } };
    const report = runUserDoctor({ environment });
    expect(report.policy).toBe('missing');
    expect(report.findings.map((finding) => finding.message)).toEqual([
      'XDG_CONFIG_HOME is the relative path "cfg": where Poetry looks for its user file then is not known, so depcurfew apply --user writes nothing for it',
    ]);
  });
});

describe('doctor --user --for', () => {
  it('notes a version given for a tool that is not in PATH, as apply --user warns about it', () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    for (const policy of [false, true]) {
      if (policy) withPolicy(environment);
      const report = runUserDoctor({ environment, versions: { pnpm: [10, 26, 0] } });
      expect(report.notices.map((notice) => notice.message)).toContain('pnpm: --for pnpm@10.26.0 is not used, because pnpm is not in PATH, so doctor --user does not check it');
    }
  });

  it('says nothing about a version it uses', () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const report = runUserDoctor({ environment, versions: { npm: [11, 21, 1] } });
    expect(report.notices.map((notice) => notice.message).join('\n')).not.toContain('is not used');
  });
});

describe('doctor --user and the ~/.npmrc that pnpm 10 reads ahead of its rc file', () => {
  it('reports a different value of a key apply --user would write, before rc exists', () => {
    const environment = fakeMachine({ npm: { pnpm: '10.26.0' } }, temporary);
    withPolicy(environment);
    writeFileSync(join(environment.home, '.npmrc'), 'minimum-release-age=0\n');
    const rc = shownUserFile('pnpm', environment, [10, 26, 0]);
    const report = runUserDoctor({ environment });
    const found = report.findings.find((finding) => finding.rule === 'user-config-weakens');
    expect(found).toEqual({
      rule: 'user-config-weakens',
      level: 'warning',
      location: { file: '~/.npmrc', line: 1 },
      message: `minimum-release-age = "0" in ~/.npmrc replaces the minimum-release-age that depcurfew apply --user writes to ${rc} (pnpm reads ~/.npmrc ahead of it), so the user policy does not hold there`,
      fix: `Remove minimum-release-age from ~/.npmrc, or give it the value in ${rc}`,
    });
    expect(report.findings.map((finding) => finding.rule)).toContain('user-config-drift');
  });
});

describe('doctor --user names the tool once in a message', () => {
  it('moves the version range of a pnpm effect next to the file', () => {
    const environment = fakeMachine({ npm: { pnpm: '11.28.10' } }, temporary);
    const shown = shownUserFile('pnpm', environment);
    userFile('pnpm', environment, 'minimumReleaseAge: 0\n');
    expect(runUserDoctor({ environment }).findings.map((finding) => finding.message)).toEqual([
      `minimumReleaseAge = 0 in ${shown} (pnpm 11+) turns the default release-age delay off in every project that does not set it itself`,
    ]);
  });

  it('names a tool its effect does not name after the file, without a comma before the scope', () => {
    const environment = fakeMachine({ python: { pip: '26.2.2' } }, temporary);
    const shown = shownUserFile('pip', environment);
    userFile('pip', environment, '[global]\nuploaded-prior-to = P0D\n');
    expect(runUserDoctor({ environment }).findings.map((finding) => finding.message)).toEqual([
      `uploaded-prior-to = "P0D" in [global] of ${shown} (pip) turns the upload-time delay off in every project that does not set it itself`,
    ]);
  });

  it('says that pnpm 10 reads ~/.npmrc ahead of rc in the same parentheses', () => {
    const environment = fakeMachine({ npm: { pnpm: '10.28.0' } }, temporary);
    writeFileSync(join(environment.home, '.npmrc'), 'dangerously-allow-all-builds=true\n');
    expect(runUserDoctor({ environment }).findings.map((finding) => finding.message)).toEqual([
      `dangerously-allow-all-builds = "true" in ~/.npmrc (pnpm 10 reads it ahead of ${shownUserFile('pnpm', environment, [10, 28, 0])}) runs every dependency build script in projects without build settings of their own and in global installs`,
    ]);
  });

  it('names the tool of an environment variable once', () => {
    const environment = fakeMachine({ npm: { pnpm: '11.28.10', npm: '11.21.1' } }, temporary);
    const pnpm: UserEnvironment = { ...environment, env: { ...environment.env, pnpm_config_minimum_release_age: '0', NPM_CONFIG_USERCONFIG: '/elsewhere/npmrc' } };
    const messages = runUserDoctor({ environment: pnpm }).findings.map((finding) => finding.message);
    expect(messages).toContain('pnpm_config_minimum_release_age is set in the environment (pnpm 11+): overrides minimumReleaseAge from every file');
    expect(messages).toContain('NPM_CONFIG_USERCONFIG is set in the environment: makes npm read another user file');
  });
});

describe('doctor --user shows where credentials were', () => {
  it('as <redacted>@, the same form as the diff of apply --user', () => {
    const environment = fakeMachine({ python: { pip: '26.2.2' } }, temporary);
    userFile('pip', environment, '[global]\nfind-links = https://bob:ghp_TOKEN@host.example.com/links\n');
    const [finding] = runUserDoctor({ environment }).findings;
    expect(finding?.message).toContain('find-links = "https://<redacted>@host.example.com/links"');
    expect(JSON.stringify(finding)).not.toMatch(/ghp_TOKEN|bob/u);
  });
});

describe('doctor --user with a user policy that is not valid JSON', () => {
  it('gives the line of the error in the location', () => {
    const environment = fakeMachine({}, temporary);
    withPolicy(environment, '{\n  "version": 1,,\n}\n');
    const [finding] = runUserDoctor({ environment }).findings;
    expect(finding).toMatchObject({ rule: 'user-policy-invalid', location: { file: shownPolicy(environment), line: 2 } });
    expect(finding?.message).toContain('line 2');
  });
});

describe('doctor --user next to a user policy gives a fix for each file it cannot check', () => {
  it('a pip.conf that is not UTF-8', () => {
    const environment = fakeMachine({ python: { pip: '26.2.2' } }, temporary);
    withPolicy(environment);
    userFile('pip', environment, Buffer.from([0xff, 0x0a]));
    const shown = shownUserFile('pip', environment);
    const [finding] = runUserDoctor({ environment }).findings.filter((candidate) => candidate.rule === 'user-config-unreadable');
    expect(finding?.fix).toBe(`Save ${shown} as UTF-8, then run depcurfew apply --user again`);
  });

  it('a uv.toml with a syntax error, with its line', () => {
    const environment = fakeMachine({ python: { uv: '0.13.6' } }, temporary);
    withPolicy(environment);
    userFile('uv', environment, 'exclude-newer = = 1\n');
    const shown = shownUserFile('uv', environment);
    const [finding] = runUserDoctor({ environment }).findings.filter((candidate) => candidate.rule === 'user-config-unreadable');
    expect(finding).toMatchObject({ location: { file: shown, line: 1 }, fix: `Fix the TOML error in ${shown} at line 1, then run depcurfew apply --user again` });
  });

  it.skipIf(!canSymlink())('a symlinked ~/.npmrc', () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    withPolicy(environment);
    writeFileSync(join(environment.root, 'npmrc'), 'save-exact=true\n');
    symlinkSync(join(environment.root, 'npmrc'), join(environment.home, '.npmrc'));
    const [finding] = runUserDoctor({ environment }).findings.filter((candidate) => candidate.rule === 'user-config-unreadable');
    expect(finding?.fix).toBe('Replace the symlink ~/.npmrc with the file it points to, so that depcurfew apply --user can write it, or add the settings of the user policy to that file by hand');
  });
});
