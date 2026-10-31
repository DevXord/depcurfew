// doctor --user reads values as the tools read them (decision D-092): a switch that turns a protection off is on for
// every value the tool does not read as off (fail closed), YAML merge keys count where the tool's loader applies them,
// and uv's [pip] no-build = false, which cannot turn the top-level no-build off, is not reported. Temporary home and PATH.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Version } from '../../src/apply/version.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { loadUserPolicy } from '../../src/user/policy.ts';
import { environmentOverrides } from '../../src/user/variables.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A home directory and a PATH with tools installed from npm or PyPI (name → version), with the default user policy or none. */
function machine(options: { npm?: Record<string, string>; python?: Record<string, string>; policy?: boolean; env?: Record<string, string> } = {}): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-values-'));
  temporary.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const [name, version] of Object.entries(options.npm ?? {})) {
    writeFileSync(join(bin, name), '#!/bin/sh\n');
    mkdirSync(join(bin, 'node_modules', name), { recursive: true });
    writeFileSync(join(bin, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, bin: { [name]: `bin/${name}.js` } }));
  }
  for (const [name, version] of Object.entries(options.python ?? {})) {
    writeFileSync(join(bin, name), 'binary');
    const info = join(root, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`);
    writeFileSync(join(info, 'entry_points.txt'), `[console_scripts]\n${name} = ${name}.__main__:main\n`);
  }
  const environment: UserEnvironment = { platform, home, env: { PATH: bin, ...options.env } };
  if (options.policy !== false) {
    const path = userPolicyPath(environment);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPolicy(DEFAULT_POLICY));
  }
  return environment;
}

function userFile(id: ToolId, environment: UserEnvironment, version?: Version): string {
  const tool = knowledgeBase.find((candidate) => candidate.id === id);
  const file = tool === undefined ? null : userFileFor(tool, version);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (path === undefined) throw new Error(`no user file for ${id}`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

const applyUser = (environment: UserEnvironment) => writeUserChanges(planUserApply(loadUserPolicy(environment).policy, { environment }));
const weakens = (environment: UserEnvironment) => runUserDoctor({ environment }).findings.filter((finding) => finding.rule === 'user-config-weakens');
const keysOf = (environment: UserEnvironment) => weakens(environment).map((finding) => /^(\S+)/u.exec(finding.message)?.[1]);

describe('switches that allow every install script, as the tools parse them', () => {
  it.each(['yes', '1', '0', '', 'FALSE', 'no'])('reports dangerously-allow-all-builds=%s in ~/.npmrc, which pnpm 10 reads as true', (value) => {
    const environment = machine({ npm: { pnpm: '10.28.0' }, policy: false });
    writeFileSync(join(environment.home, '.npmrc'), `dangerously-allow-all-builds=${value}\n`);
    expect(keysOf(environment)).toEqual(['dangerously-allow-all-builds']);
  });

  it.each(['false', ' false ', 'null', 'undefined', '"false"'])('does not report dangerously-allow-all-builds=%s, which pnpm 10 reads as off', (value) => {
    const environment = machine({ npm: { pnpm: '10.28.0' }, policy: false });
    writeFileSync(join(environment.home, '.npmrc'), `dangerously-allow-all-builds=${value}\n`);
    expect(weakens(environment)).toEqual([]);
  });

  it('reports a key without a value, which is true', () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: false });
    writeFileSync(join(environment.home, '.npmrc'), 'dangerously-allow-all-scripts\n');
    expect(keysOf(environment)).toEqual(['dangerously-allow-all-scripts']);
  });

  it('reports dangerously-allow-all-scripts=1 in ~/.npmrc, which npm keeps as a true string', () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: false });
    writeFileSync(join(environment.home, '.npmrc'), 'dangerously-allow-all-scripts=1\n');
    expect(weakens(environment)[0]?.message).toContain('dangerously-allow-all-scripts = "1" in ~/.npmrc runs every dependency install script');
  });

  it.each([
    ['"false"', true],
    ['yes', true],
    ['"true"', true],
    ['{}', true],
    ['false', false],
    ['0', false],
    ['null', false],
    ['""', false],
  ])('in the pnpm config.yaml, dangerouslyAllowAllBuilds: %s weakens: %s', (value, reported) => {
    const environment = machine({ npm: { pnpm: '11.28.10' }, policy: false });
    writeFileSync(userFile('pnpm', environment), `dangerouslyAllowAllBuilds: ${value}\n`);
    expect(keysOf(environment)).toEqual(reported ? ['dangerouslyAllowAllBuilds'] : []);
  });

  it.each([
    ['1', true],
    ['"yes"', true],
    ['false', false],
    ['"0"', false],
  ])('in ~/.yarnrc.yml, enableScripts: %s weakens: %s (Yarn takes 1 as true)', (value, reported) => {
    const environment = machine({ npm: { yarn: '4.18.1' }, policy: false });
    writeFileSync(userFile('yarn', environment), `enableScripts: ${value}\n`);
    expect(keysOf(environment)).toEqual(reported ? ['enableScripts'] : []);
  });

  it('reports use_uv = "yes" in the PDM config.toml, which PDM reads as true', () => {
    const environment = machine({ python: { pdm: '2.29.5' }, policy: false });
    writeFileSync(userFile('pdm', environment), 'use_uv = "yes"\n');
    expect(keysOf(environment)).toEqual(['use_uv']);
    writeFileSync(userFile('pdm', environment), 'use_uv = "no"\n');
    expect(keysOf(environment)).toEqual([]);
  });

  it('reports npm_config_dangerously_allow_all_builds=1 for pnpm 10 and shows its value, but not false', () => {
    const tools = knowledgeBase.filter((tool) => tool.id === 'pnpm' || tool.id === 'npm');
    const env = (value: string): UserEnvironment => ({ platform, home: tmpdir(), env: { npm_config_dangerously_allow_all_builds: value, NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: value } });
    expect(environmentOverrides(env('1'), tools, { pnpm: [10, 28, 0], npm: [11, 21, 1] }).map((override) => [override.tool, override.name, override.anyValue])).toEqual([
      ['npm', 'NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS', false],
      ['pnpm', 'npm_config_dangerously_allow_all_builds', false],
    ]);
    expect(environmentOverrides(env('false'), tools, { pnpm: [10, 28, 0], npm: [11, 21, 1] })).toEqual([]);
    expect(environmentOverrides(env('yes'), tools, { pnpm: [11, 28, 10], npm: [11, 21, 1] }).map((override) => override.name)).toEqual(['NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS']);

    const environment = machine({ npm: { pnpm: '10.28.0' }, policy: false, env: { npm_config_dangerously_allow_all_builds: 'yes' } });
    const finding = runUserDoctor({ environment }).findings.find((item) => item.rule === 'user-environment-overrides');
    expect(finding?.message).toContain('npm_config_dangerously_allow_all_builds=yes is set in the environment');
  });
});

describe('YAML merge keys in the user files', () => {
  it('reports a value the pnpm config.yaml merges in with <<, at the line that sets it', () => {
    const environment = machine({ npm: { pnpm: '11.28.10' }, policy: false });
    const path = userFile('pnpm', environment);
    writeFileSync(path, 'base: &b\n  dangerouslyAllowAllBuilds: true\n<<: *b\n');
    const [finding] = weakens(environment);
    expect(finding?.message).toMatch(/^dangerouslyAllowAllBuilds = true in .*config\.yaml runs every dependency build script/u);
    expect(finding?.location.line).toBe(2);
  });

  it('lets a key of the map itself win over the merged one, in any order', () => {
    const environment = machine({ npm: { pnpm: '11.28.10' }, policy: false });
    const path = userFile('pnpm', environment);
    writeFileSync(path, 'base: &b\n  dangerouslyAllowAllBuilds: true\n<<: *b\ndangerouslyAllowAllBuilds: false\n');
    expect(weakens(environment)).toEqual([]);
    writeFileSync(path, 'base: &b\n  dangerouslyAllowAllBuilds: true\ndangerouslyAllowAllBuilds: false\n<<: [*b]\n');
    expect(weakens(environment)).toEqual([]);
  });

  it('does not merge in ~/.yarnrc.yml, where Yarn reads << as a key it does not know', () => {
    const environment = machine({ npm: { yarn: '4.18.1' }, policy: false });
    writeFileSync(userFile('yarn', environment), 'base: &b\n  enableScripts: true\n<<: *b\n');
    expect(weakens(environment)).toEqual([]);
  });

  it('reports a merge key that does not refer to a map as a file it cannot check', () => {
    const environment = machine({ npm: { pnpm: '11.28.10' }, policy: false });
    writeFileSync(userFile('pnpm', environment), 'minimumReleaseAge: 1440\n<<: 5\n');
    const findings = runUserDoctor({ environment }).findings;
    expect(findings.map((finding) => [finding.rule, finding.level, finding.location.line])).toEqual([['user-config-unreadable', 'error', 2]]);
    expect(findings[0]?.message).toContain('the merge key << at line 2, column 1 must refer to a map or a list of maps');
  });
});

describe('uv [pip] no-build = false', () => {
  it('is not reported, because uv joins it with the top-level no-build, and apply --user leaves it', () => {
    const environment = machine({ python: { uv: '0.13.6' } });
    const path = userFile('uv', environment);
    writeFileSync(path, '[pip]\nno-build = false\nexclude-newer = false\n');
    applyUser(environment);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('\nno-build = false\n');
    expect(text).not.toMatch(/^exclude-newer = false$/mu);
    expect(runUserDoctor({ environment }).findings).toEqual([]);
  });
});
