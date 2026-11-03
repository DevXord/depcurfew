// Decision D-170: pip 26.3 (platformdirs 4.12.4) ignores a relative XDG_CONFIG_HOME, and on macOS a relative
// XDG_DATA_HOME; Bun reads only an absolute XDG_CONFIG_HOME from 1.4.4 on; pip stops on a pip.conf that sets a key
// (in 26.3 also only_binary next to only-binary) or a section twice, which doctor --user reports and apply --user never
// writes; Renovate reads its .github and .gitlab files on every platform.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BLOCK_END, USER_BLOCK_START } from '../../src/apply/block.ts';
import { detectProject } from '../../src/detect/index.ts';
import { bun } from '../../src/knowledge/bun.ts';
import { pip } from '../../src/knowledge/pip.ts';
import { validatePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { planUserApply } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { locateUserFile, userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { fakeMachine } from '../support/user.ts';

const windows = process.platform === 'win32';
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function policy(document: unknown): ResolvedPolicy {
  const result = validatePolicy(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const POLICY = policy({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: ['pip', 'bun'] });
const HOME = '/home/ada';
const MAC_HOME = '/Users/ada';

describe('the pip user file by version', () => {
  it('ignores a relative XDG_CONFIG_HOME on Linux from 26.3, which 26.2.2 reads from the current directory', () => {
    const relative = { platform: 'linux' as const, home: HOME, env: { XDG_CONFIG_HOME: 'cfg' }, cwd: '/work' };
    expect(locateUserFile(userFileFor(pip, [26, 3, 0])!, relative)).toEqual({ path: `${HOME}/.config/pip/pip.conf` });
    expect(locateUserFile(userFileFor(pip, [26, 3, 0])!, { ...relative, env: { XDG_CONFIG_HOME: '/srv/cfg' } })).toEqual({ path: '/srv/cfg/pip/pip.conf' });
    expect(locateUserFile(userFileFor(pip, [26, 2, 2])!, relative)).toEqual({
      relative: { variable: 'XDG_CONFIG_HOME', value: 'cfg', file: 'cfg/pip/pip.conf', path: '/work/cfg/pip/pip.conf' },
    });
  });

  it('ignores a relative XDG_DATA_HOME on macOS from 26.3, and an absolute one still skips the Library folder', () => {
    const file = userFileFor(pip, [26, 3, 0])!;
    const support = `${MAC_HOME}/Library/Application Support/pip`;
    const mac = (env: Record<string, string>, folders: readonly string[]) => userFilePath(file, { platform: 'darwin', home: MAC_HOME, env, isDirectory: (path) => folders.includes(path) });
    expect(mac({ XDG_DATA_HOME: 'data' }, [support])).toBe(`${support}/pip.conf`);
    expect(mac({ XDG_DATA_HOME: '/data' }, [support])).toBe(`${MAC_HOME}/.config/pip/pip.conf`);
    expect(mac({ XDG_DATA_HOME: '/data' }, ['/data/pip', support])).toBe('/data/pip/pip.conf');
    expect(mac({}, [support])).toBe(`${support}/pip.conf`);
  });
});

describe('the Bun user file by version', () => {
  it('takes XDG_CONFIG_HOME whenever it is set before 1.4.4, and only an absolute one from 1.4.4', () => {
    const linux = (env: Record<string, string>) => ({ platform: 'linux' as const, home: HOME, env });
    const old = userFileFor(bun, [1, 4, 3])!;
    expect(locateUserFile(old, linux({ XDG_CONFIG_HOME: '/cfg' }))).toEqual({ path: '/cfg/.bunfig.toml' });
    // Before 1.4.4 a relative or empty value is joined into a path under /, so the file is not ~/.bunfig.toml.
    expect(locateUserFile(old, linux({ XDG_CONFIG_HOME: 'cfg' }))).toEqual({ relative: { variable: 'XDG_CONFIG_HOME', value: 'cfg', file: 'cfg/.bunfig.toml' } });
    expect(locateUserFile(old, linux({ XDG_CONFIG_HOME: '' }))).toEqual({ relative: { variable: 'XDG_CONFIG_HOME', value: '', file: '.bunfig.toml' } });
    expect(userFileFor(bun, [1, 3, 0])).toBe(old);
    const current = userFileFor(bun, [1, 4, 4])!;
    expect(userFilePath(current, linux({ XDG_CONFIG_HOME: 'cfg' }))).toBe(`${HOME}/.bunfig.toml`);
    expect(userFilePath(current, linux({ XDG_CONFIG_HOME: '' }))).toBe(`${HOME}/.bunfig.toml`);
    expect(userFilePath(current, linux({ XDG_CONFIG_HOME: '/cfg' }))).toBe('/cfg/.bunfig.toml');
  });
});

describe.skipIf(windows)('apply --user with a relative XDG_CONFIG_HOME, by version', () => {
  it('writes ~/.config/pip/pip.conf for pip 26.3, and nothing for Bun 1.3.0', () => {
    const machine = fakeMachine({ python: { pip: '26.3' } }, temporary);
    const environment: UserEnvironment = { ...machine, platform: 'linux', env: { ...machine.env, XDG_CONFIG_HOME: 'cfg' } };
    const planned = planUserApply(POLICY, { environment, versions: { bun: [1, 3, 0] } });
    expect(planned.report.changes.map((change) => change.file)).toEqual(['~/.config/pip/pip.conf']);
    const relative = planned.report.warningDetails.filter((warning) => warning.code === 'user-directory-relative');
    expect(relative).toEqual([
      {
        code: 'user-directory-relative',
        tool: 'bun',
        message: 'Bun: XDG_CONFIG_HOME is the relative path "cfg", and depcurfew does not know where Bun looks for its user file then, so nothing is written for it',
        fix: 'Set XDG_CONFIG_HOME to an absolute path, or unset it, then run depcurfew apply --user again',
      },
    ]);
  });

  it('writes ~/.bunfig.toml for Bun 1.4.4', () => {
    const machine = fakeMachine({}, temporary);
    const environment: UserEnvironment = { ...machine, platform: 'linux', env: { ...machine.env, XDG_CONFIG_HOME: 'cfg' } };
    const planned = planUserApply(POLICY, { environment, versions: { bun: [1, 4, 4] } });
    expect(planned.report.changes.map((change) => change.file)).toEqual(['~/.bunfig.toml']);
  });
});

/** A Linux machine with pip at `version` and the pip.conf given (no user policy). */
function pipMachine(version: string, conf: string): UserEnvironment {
  const machine = fakeMachine({ python: { pip: version } }, temporary);
  const file = join(machine.home, '.config', 'pip', 'pip.conf');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, conf);
  return { ...machine, platform: 'linux' };
}

const unreadable = (environment: UserEnvironment) => runUserDoctor({ environment }).findings.filter((finding) => finding.rule === 'user-config-unreadable');

describe.skipIf(windows)('doctor --user and a pip.conf that sets a key or a section twice', () => {
  it('is an error when only_binary and only-binary are in one section and pip is 26.3', () => {
    expect(unreadable(pipMachine('26.3', '[global]\nonly_binary = :all:\nonly-binary = :none:\n'))).toEqual([
      {
        rule: 'user-config-unreadable',
        level: 'error',
        location: { file: '~/.config/pip/pip.conf', line: 3 },
        message:
          'only_binary (line 2) and only-binary (line 3) in [global] of ~/.config/pip/pip.conf are the same key to pip, and pip 26.3.0 stops with an error on a file that sets a key twice in one section',
        fix: 'Keep one of lines 2 and 3 in [global] of ~/.config/pip/pip.conf',
      },
    ]);
  });

  it('names the versions that stop on the file when the version of pip cannot be read', () => {
    const machine = fakeMachine({}, temporary);
    writeFileSync(join(machine.root, 'venv', 'bin', 'pip'), '#!/usr/bin/python3\n');
    const file = join(machine.home, '.config', 'pip', 'pip.conf');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[global]\nonly_binary = :all:\nonly-binary = :none:\n');
    expect(unreadable({ ...machine, platform: 'linux' }).map((finding) => finding.message)).toEqual([
      'only_binary (line 2) and only-binary (line 3) in [global] of ~/.config/pip/pip.conf are the same key to pip, and pip 26.3.0 and newer stop with an error on a file that sets a key twice in one section',
    ]);
  });

  it('counts --only-binary as only-binary, as pip reads it', () => {
    const findings = runUserDoctor({ environment: pipMachine('26.3', '[global]\n--only-binary = :none:\n') }).findings;
    expect(findings.map((finding) => [finding.rule, finding.location.line])).toContainEqual(['user-config-weakens', 2]);
    expect(unreadable(pipMachine('26.3', '[global]\nonly-binary = :all:\n--only-binary = :none:\n')).map((finding) => finding.location)).toEqual([{ file: '~/.config/pip/pip.conf', line: 3 }]);
  });

  it('is no error with pip 26.2.2, which takes the later line, so the weakening value is reported', () => {
    const environment = pipMachine('26.2.2', '[global]\nonly_binary = :all:\nonly-binary = :none:\n');
    const findings = runUserDoctor({ environment }).findings;
    expect(findings.filter((finding) => finding.rule === 'user-config-unreadable')).toEqual([]);
    expect(findings.map((finding) => [finding.rule, finding.location.line])).toContainEqual(['user-config-weakens', 3]);
  });

  it('is an error with any pip for the same key twice, and for a section twice', () => {
    expect(unreadable(pipMachine('26.2.2', '[global]\nindex-url = https://a.example/simple\nINDEX-URL = https://b.example/simple\n'))).toEqual([
      expect.objectContaining({
        location: { file: '~/.config/pip/pip.conf', line: 3 },
        message: 'index-url (line 2) and INDEX-URL (line 3) in [global] of ~/.config/pip/pip.conf are the same key to pip, and pip 26.2.2 stops with an error on a file that sets a key twice in one section',
      }),
    ]);
    expect(unreadable(pipMachine('26.3', '[global]\ntimeout = 5\ntimeout = 6\n'))).toEqual([
      expect.objectContaining({
        message: 'timeout is set twice in [global] of ~/.config/pip/pip.conf (lines 2 and 3), and pip 26.3.0 stops with an error on a file that sets a key twice in one section',
      }),
    ]);
    expect(unreadable(pipMachine('26.3', '[global]\ntimeout = 5\n\n[global]\nretries = 2\n'))).toEqual([
      {
        rule: 'user-config-unreadable',
        level: 'error',
        location: { file: '~/.config/pip/pip.conf', line: 4 },
        message: '[global] is in ~/.config/pip/pip.conf twice (lines 1 and 4), and pip 26.3.0 stops with an error on a file that has a section twice',
        fix: 'Merge the two [global] sections of ~/.config/pip/pip.conf into one',
      },
    ]);
  });

  it('names the hand-written line when the other one is in depcurfew\'s block', () => {
    const conf = `[global]\n${USER_BLOCK_START}\nonly-binary = :all:\n${BLOCK_END}\nonly_binary = :none:\n`;
    expect(unreadable(pipMachine('26.3', conf)).map((finding) => finding.fix)).toEqual([
      'Remove line 5 (only_binary) from ~/.config/pip/pip.conf: depcurfew apply --user sets only-binary in its block',
    ]);
  });

  it('is no repeat for continuation lines, comments, other sections and [DEFAULT]', () => {
    const conf = '[global]\nno-binary =\n  timeout\n  timeout\n# timeout = 1\ntimeout = 5\n[install]\ntimeout = 6\n[DEFAULT]\n[DEFAULT]\n';
    expect(unreadable(pipMachine('26.3', conf))).toEqual([]);
  });
});

describe.skipIf(windows)('apply --user and keys pip reads as one', () => {
  it('comments out every hand-written spelling of a managed key, so the file never sets it twice', () => {
    const machine = fakeMachine({ python: { pip: '26.3' } }, temporary);
    const file = join(machine.home, '.config', 'pip', 'pip.conf');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[global]\nonly_binary = :none:\n--only-binary = foo\nONLY-BINARY = bar\n');
    const environment: UserEnvironment = { ...machine, platform: 'linux' };
    const planned = planUserApply(POLICY, { environment });
    const after = planned.report.changes.find((change) => change.file === '~/.config/pip/pip.conf')?.after ?? '';
    const active = after.split('\n').filter((line) => /^\s*(?:--)?only[-_]binary\s*=/iu.test(line));
    expect(active).toEqual(['only-binary = :all:']);
  });
});

describe('Renovate configuration files', () => {
  it('counts .gitlab/renovate.json in a GitHub repository, as Renovate reads it on every platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-d170-renovate-'));
    temporary.push(root);
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.gitlab'));
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
    writeFileSync(join(root, '.gitlab', 'renovate.json'), '{}\n');
    writeFileSync(join(root, 'package.json'), '{"name":"x"}\n');
    expect(detectProject(root).bots).toEqual([{ id: 'renovate', configFiles: ['.gitlab/renovate.json'] }]);
  });
});
