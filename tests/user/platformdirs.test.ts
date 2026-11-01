// Poetry and PDM on macOS ask platformdirs for their user config directory, and where it is depends on the installed
// platformdirs (decision D-101): its version is read from the .dist-info next to the tool's own. Without it, apply
// --user writes where the docs say and names the other files; doctor --user checks every file the tool may read.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseVersion } from '../../src/apply/version.ts';
import { pdm } from '../../src/knowledge/pdm.ts';
import { poetry } from '../../src/knowledge/poetry.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import { planUserApply } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { locateUserFile, userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { loadUserPolicy } from '../../src/user/policy.ts';
import { fakeMachine } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const HOME = '/Users/ada';
const SUPPORT = `${HOME}/Library/Application Support`;

/** Where the tool reads its user file on macOS for a platformdirs version (undefined: not known) and the variables. */
function macPath(tool: ToolKnowledge, platformdirs: string | undefined, env: Record<string, string>): string | undefined {
  const file = userFileFor(tool, parseVersion(tool.id === 'poetry' ? '2.5.1' : '2.29.5'), platformdirs === undefined ? undefined : parseVersion(platformdirs));
  return file === null ? undefined : userFilePath(file, { platform: 'darwin', home: HOME, env });
}

describe('the macOS user file of Poetry and PDM by platformdirs version', () => {
  it('is in Application Support before platformdirs 4.6.0, whatever XDG_CONFIG_HOME says, and where the docs say when the version is not known', () => {
    expect(macPath(poetry, '4.5.1', { XDG_CONFIG_HOME: '/cfg' })).toBe(`${SUPPORT}/pypoetry/config.toml`);
    expect(macPath(pdm, '4.5.1', { XDG_CONFIG_HOME: '/cfg' })).toBe(`${SUPPORT}/pdm/config.toml`);
    expect(macPath(poetry, undefined, { XDG_CONFIG_HOME: '/cfg' })).toBe(`${SUPPORT}/pypoetry/config.toml`);
  });

  it('follows XDG_CONFIG_HOME from 4.6.0, and XDG_DATA_HOME too until 4.9.6', () => {
    expect(macPath(poetry, '4.6.0', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/pypoetry/config.toml');
    expect(macPath(poetry, '4.9.5', { XDG_DATA_HOME: '/data' })).toBe('/data/pypoetry/config.toml');
    expect(macPath(pdm, '4.9.6', { XDG_DATA_HOME: '/data' })).toBe(`${SUPPORT}/pdm/config.toml`);
    expect(macPath(pdm, '4.14.2', { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' })).toBe('/cfg/pdm/config.toml');
    expect(macPath(poetry, '4.14.2', { XDG_CONFIG_HOME: '  ' })).toBe(`${SUPPORT}/pypoetry/config.toml`);
  });

  it('reads a relative XDG_CONFIG_HOME from the current directory until 4.11.8, which ignores it', () => {
    const file = userFileFor(poetry, parseVersion('2.5.1'), parseVersion('4.11.7'));
    const located = file === null ? undefined : locateUserFile(file, { platform: 'darwin', home: HOME, env: { XDG_CONFIG_HOME: 'cfg' }, cwd: '/work' });
    expect(located).toEqual({ relative: { variable: 'XDG_CONFIG_HOME', value: 'cfg', file: 'cfg/pypoetry/config.toml', path: '/work/cfg/pypoetry/config.toml' } });
    expect(macPath(poetry, '4.11.8', { XDG_CONFIG_HOME: 'cfg' })).toBe(`${SUPPORT}/pypoetry/config.toml`);
  });

  it('leaves Linux and Windows as they were', () => {
    const file = userFileFor(poetry, parseVersion('2.5.1'), parseVersion('4.5.1'));
    expect(file === null ? undefined : userFilePath(file, { platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '/cfg' } })).toBe('/cfg/pypoetry/config.toml');
  });
});

/** A macOS machine (paths are POSIX, so not on Windows) with the tool and, when given, platformdirs in its environment. */
function mac(tool: 'poetry' | 'pdm', platformdirs: string | undefined, env: Record<string, string> = {}): UserEnvironment & { root: string } {
  const python: Record<string, string> = { [tool]: tool === 'poetry' ? '2.5.1' : '2.29.5', ...(platformdirs === undefined ? {} : { platformdirs }) };
  const machine = fakeMachine({ python }, temporary);
  const environment = { ...machine, platform: 'darwin' as const, env: { ...machine.env, ...env } };
  const policy = userPolicyPath(environment);
  mkdirSync(dirname(policy), { recursive: true });
  writeFileSync(policy, renderPolicy(DEFAULT_POLICY));
  return environment;
}

const plan = (environment: UserEnvironment) => planUserApply(loadUserPolicy(environment).policy, { environment }).report;

describe.skipIf(process.platform === 'win32')('apply --user and doctor --user for Poetry and PDM on macOS', () => {
  it('writes $XDG_CONFIG_HOME/pypoetry/config.toml when Poetry\'s environment has platformdirs 4.14.2', () => {
    const environment = mac('poetry', '4.14.2', {});
    const config = join(environment.root, 'cfg');
    // The user policy stays where init --user wrote it; only Poetry's file moves.
    const report = planUserApply(loadUserPolicy(environment).policy, { environment: { ...environment, env: { ...environment.env, XDG_CONFIG_HOME: config } } }).report;
    expect(report.changes.map((change) => change.path)).toEqual([join(config, 'pypoetry', 'config.toml')]);
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('user-file-uncertain');
  });

  it('writes Application Support for platformdirs 4.5.1, with no warning', () => {
    const environment = mac('pdm', '4.5.1', { XDG_CONFIG_HOME: '/elsewhere' });
    const report = plan(environment);
    expect(report.changes.map((change) => change.file)).toEqual(['~/Library/Application Support/pdm/config.toml']);
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('user-file-uncertain');
  });

  it('without platformdirs in Poetry\'s environment writes where the docs say and names the other file, how to tell and what to unset', () => {
    const environment = mac('poetry', undefined, { XDG_CONFIG_HOME: '/cfg' });
    const report = plan(environment);
    expect(report.changes.map((change) => change.file)).toEqual(['~/Library/Application Support/pypoetry/config.toml']);
    const warning = report.warningDetails.find((entry) => entry.code === 'user-file-uncertain');
    expect(warning).toEqual({
      code: 'user-file-uncertain',
      tool: 'poetry',
      location: { file: '~/Library/Application Support/pypoetry/config.toml' },
      message:
        "Poetry: depcurfew cannot read the version of platformdirs in Poetry's environment, which decides where Poetry reads its user file here: ~/Library/Application Support/pypoetry/config.toml (platformdirs before 4.6.0), or /cfg/pypoetry/config.toml (platformdirs 4.6.0 and later); depcurfew apply --user writes ~/Library/Application Support/pypoetry/config.toml, where the Poetry docs put it",
      fix: "Look for the platformdirs-<version>.dist-info folder next to Poetry's own in the site-packages folder of Poetry's environment to see which file Poetry reads, or unset XDG_CONFIG_HOME so that every platformdirs version reads ~/Library/Application Support/pypoetry/config.toml, then run depcurfew apply --user again",
    });
  });

  it('gives no warning without platformdirs when no variable moves the file', () => {
    const report = plan(mac('pdm', undefined));
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('user-file-uncertain');
    expect(report.changes.map((change) => change.file)).toEqual(['~/Library/Application Support/pdm/config.toml']);
  });

  it('doctor --user checks the file platformdirs gives, or every candidate when its version is not known', () => {
    const known = mac('poetry', '4.14.2');
    const config = join(known.root, 'cfg');
    const environment = { ...known, env: { ...known.env, XDG_CONFIG_HOME: config } };
    mkdirSync(join(config, 'pypoetry'), { recursive: true });
    writeFileSync(join(config, 'pypoetry', 'config.toml'), '[solver]\nmin-release-age = 0\n');
    const support = join(known.home, 'Library', 'Application Support', 'pypoetry');
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, 'config.toml'), '[solver]\nmin-release-age-exclude = ["left-pad"]\n');
    const report = runUserDoctor({ environment });
    const weakens = report.findings.filter((finding) => finding.rule === 'user-config-weakens').map((finding) => finding.location.file);
    expect(weakens).toEqual([join(config, 'pypoetry', 'config.toml')]);

    const unknown = mac('poetry', undefined, { XDG_CONFIG_HOME: config });
    mkdirSync(join(unknown.home, 'Library', 'Application Support', 'pypoetry'), { recursive: true });
    writeFileSync(join(unknown.home, 'Library', 'Application Support', 'pypoetry', 'config.toml'), '[solver]\nmin-release-age-exclude = ["left-pad"]\n');
    const both = runUserDoctor({ environment: unknown });
    expect(both.findings.filter((finding) => finding.rule === 'user-config-weakens').map((finding) => finding.location.file).sort()).toEqual(
      ['~/Library/Application Support/pypoetry/config.toml', join(config, 'pypoetry', 'config.toml')].sort(),
    );
    expect(both.notices.map((notice) => notice.message).join('\n')).toContain("Poetry: depcurfew cannot read the version of platformdirs in Poetry's environment");
  });
});
