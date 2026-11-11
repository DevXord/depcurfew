// Decision D-164: pnpm 12.15+ takes settings from the files and config dependencies include in pnpm-workspace.yaml names,
// and the updateConfig hook of a pnpmfile or a config-dependency plugin can change every setting. The fixtures of the
// rules are in tests/fixtures/doctor/{pnpm-config-unverifiable,config-drift,broad-exclusion}; the apply fixtures are
// tests/fixtures/repos/pnpm-include-* and pnpm-plugin.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpuNow } from './support/cpu-time.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pnpmHooks } from '../src/apply/pnpm-hooks.ts';
import { MAX_PROBLEMS, readPnpmIncludes } from '../src/apply/pnpm-includes.ts';
import { applyProject } from '../src/apply/index.ts';
import { parseVersion, type Version } from '../src/apply/version.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { pnpm } from '../src/knowledge/pnpm.ts';
import { parseYaml } from '../src/yaml-parse.ts';

const REPOS = fileURLToPath(new URL('fixtures/repos/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const V12_16 = parseVersion('12.16.1') as Version;

function includes(files: Record<string, string>, version: Version | undefined = V12_16) {
  return readPnpmIncludes(pnpm, version, (file) => files[file]);
}

function copy(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `depcurfew-d164-${name}-`));
  temporary.push(directory);
  cpSync(join(REPOS, name), directory, { recursive: true });
  return directory;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) });
  return { code, stdout, stderr };
}

describe('include in pnpm-workspace.yaml as pnpm reads it', () => {
  it('gives a listed setting to its file even when the file omits it, and a setting a * file defines to that file', () => {
    const found = includes({
      'pnpm-workspace.yaml': "include:\n  ./config/security.yaml: [minimumReleaseAge, allowBuilds]\n  ./config/all.yaml: '*'\nnodeLinker: hoisted\n",
      'config/security.yaml': 'minimumReleaseAge: 4320\n',
      'config/all.yaml': 'dangerouslyAllowAllBuilds: true\n',
    });
    expect(found?.problems).toEqual([]);
    expect(found?.owner('minimumReleaseAge')).toEqual({ kind: 'file', file: 'config/security.yaml' });
    // Reserved by the list although the file does not set it.
    expect(found?.owner('allowBuilds')).toEqual({ kind: 'file', file: 'config/security.yaml' });
    // permissions shares the owner of allowBuilds (canonical_setting_name).
    expect(found?.owner('permissions')).toEqual({ kind: 'file', file: 'config/security.yaml' });
    expect(found?.owner('dangerouslyAllowAllBuilds')).toEqual({ kind: 'file', file: 'config/all.yaml' });
    expect(found?.owner('nodeLinker')).toEqual({ kind: 'file', file: 'pnpm-workspace.yaml' });
    // A setting nobody owns is written into pnpm-workspace.yaml.
    expect(found?.owner('blockExoticSubdeps')).toEqual({ kind: 'file', file: 'pnpm-workspace.yaml' });
    expect(found?.files).toEqual(['config/security.yaml', 'config/all.yaml']);
  });

  it('names the config dependency that owns a setting, and a file outside the directory', () => {
    const found = includes({
      'pnpm-workspace.yaml': "configDependencies:\n  '@acme/policy': 1.0.0\ninclude:\n  '@acme/policy': [minimumReleaseAge]\n  ../shared/pnpm.yaml: [allowBuilds]\n",
    });
    expect(found?.problems).toEqual([]);
    expect(found?.owner('minimumReleaseAge')).toEqual({ kind: 'dependency', name: '@acme/policy', line: 4 });
    expect(found?.owner('allowBuilds')).toEqual({ kind: 'outside', spec: '../shared/pnpm.yaml', line: 5 });
  });

  it('is not read before pnpm 12.15.0, without include, or from a manifest that does not parse', () => {
    const files = { 'pnpm-workspace.yaml': "include:\n  ./a.yaml: '*'\n", 'a.yaml': 'minimumReleaseAge: 0\n' };
    expect(includes(files, parseVersion('12.14.0'))).toBeUndefined();
    expect(includes(files, parseVersion('12.15.0'))?.owner('minimumReleaseAge')).toEqual({ kind: 'file', file: 'a.yaml' });
    // The latest known version reads it.
    expect(includes(files, undefined)?.owner('minimumReleaseAge')).toEqual({ kind: 'file', file: 'a.yaml' });
    expect(includes({ 'pnpm-workspace.yaml': 'minimumReleaseAge: 4320\n' })).toBeUndefined();
    expect(includes({ 'pnpm-workspace.yaml': 'include: [\n' })).toBeUndefined();
  });

  it('finds what pnpm rejects, with the error code pnpm gives', () => {
    const found = includes({
      'pnpm-workspace.yaml': [
        'include:',
        "  ./a.yaml: [minimumReleaseAge]",
        "  ./b.yaml: [minimumReleaseAge]",
        "  ./c/*.yaml: '*'",
        "  ./d.json: '*'",
        "  '@acme/policy': '*'",
        "  pnpm-plugin-x: [pnpmfile]",
        "  undeclared-policy: [trustPolicy]",
        "  ./missing.yaml: [catalog]",
        "  ./nested.yaml: '*'",
        "  ./e.yaml: [catalogs.react]",
        "  ./f.yaml: [catalogs]",
        'dangerouslyAllowAllBuilds: false',
        '',
      ].join('\n'),
      'a.yaml': 'strictDepBuilds: false\n',
      'b.yaml': '',
      'nested.yaml': "include:\n  ./x.yaml: '*'\n",
      'e.yaml': '',
      'f.yaml': '',
    });
    expect(found?.problems.map((problem) => [problem.code, problem.file, problem.line, problem.message])).toEqual([
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 4, 'the source "./c/*.yaml" is a glob, which pnpm does not accept'],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 5, 'the source "./d.json" is not a .yaml or .yml file'],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 6, "the config dependency @acme/policy is delegated '*', but a config dependency always needs a list of settings"],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 7, 'pnpmfile cannot be delegated to the config dependency pnpm-plugin-x'],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 9, 'missing.yaml, which include names, does not exist or cannot be read (pnpm needs every included file, also an empty one)'],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 10, 'nested.yaml has an include of its own, which only pnpm-workspace.yaml may have'],
      ['ERR_PNPM_DUPLICATE_SETTING', 'pnpm-workspace.yaml', 3, 'minimumReleaseAge is delegated to ./a.yaml and to ./b.yaml'],
      // catalogs overlaps the first catalog reserved before it, the default one, which pnpm names catalog.
      ['ERR_PNPM_DUPLICATE_SETTING', 'pnpm-workspace.yaml', 12, 'catalog is delegated to ./missing.yaml and to ./f.yaml'],
      ['ERR_PNPM_SETTING_NOT_DELEGATED', 'a.yaml', 1, './a.yaml defines strictDepBuilds, which include does not give to it'],
      ['ERR_PNPM_INVALID_WORKSPACE_INCLUDE', 'pnpm-workspace.yaml', 8, 'the config dependency undeclared-policy is not declared in configDependencies'],
    ]);
  });

  it('reads a long list and a large file in linear time, and reports at most a few problems', () => {
    // 20 000 settings listed twice, defined in pnpm-workspace.yaml where a list reserves them, and 20 000 settings a list
    // does not give: a lookup through the whole list for each key took 6 s here. The files are parsed first, as
    // detection does, so that only the reading of include is timed.
    const settings = Array.from({ length: 20_000 }, (_, index) => `k${index}`);
    const files = {
      'pnpm-workspace.yaml': `include:\n  ./a.yaml: [${settings.join(', ')}]\n  ./b.yaml: [${settings.join(', ')}]\n${settings.map((key) => `${key}: 1`).join('\n')}\n`,
      'a.yaml': `${settings.map((key) => `other${key}: 1`).join('\n')}\n`,
      'b.yaml': '',
    };
    for (const text of Object.values(files)) parseYaml(text, { merge: true });
    const started = cpuNow();
    const found = includes(files);
    expect(cpuNow() - started).toBeLessThan(3_000);
    expect(found?.problems.length).toBe(MAX_PROBLEMS);
  });
});

describe('pnpmfiles and plugins pnpm loads', () => {
  const read = (files: Record<string, string>) => ({ read: (file: string) => files[file], isFile: (file: string) => files[file] !== undefined });

  it('looks for .pnpmfile.mjs first from pnpm 11, and only for .pnpmfile.cjs in pnpm 10', () => {
    const files = { 'pnpm-workspace.yaml': 'minimumReleaseAge: 4320\n', '.pnpmfile.mjs': 'export const hooks = {}\n', '.pnpmfile.cjs': 'module.exports = {}\n' };
    expect(pnpmHooks(pnpm, V12_16, read(files)).map((hook) => hook.file)).toEqual(['.pnpmfile.mjs']);
    expect(pnpmHooks(pnpm, parseVersion('11.0.0'), read(files)).map((hook) => hook.file)).toEqual(['.pnpmfile.mjs']);
    expect(pnpmHooks(pnpm, parseVersion('10.34.9'), read(files)).map((hook) => hook.file)).toEqual(['.pnpmfile.cjs']);
    // Before 10.8.0 no pnpmfile has updateConfig.
    expect(pnpmHooks(pnpm, parseVersion('10.7.1'), read(files))).toEqual([]);
  });

  it('takes the plugin patterns of the version, in the order of the names', () => {
    const files = { 'pnpm-workspace.yaml': "configDependencies:\n  pnpm-plugin-b: 1.0.0\n  '@acme/pnpm-plugin-a': 1.0.0\n  '@pnpm/plugin-c': 1.0.0\n  '@acme/other': 1.0.0\n  my-pnpm-plugin-x: 1.0.0\n" };
    const names = (version: string) => pnpmHooks(pnpm, parseVersion(version), read(files)).map((hook) => (hook.kind === 'plugin' ? hook.name : hook.file));
    expect(names('10.15.0')).toEqual(['@acme/pnpm-plugin-a', '@pnpm/plugin-c', 'pnpm-plugin-b']);
    expect(names('10.13.0')).toEqual(['@pnpm/plugin-c', 'pnpm-plugin-b']);
    expect(names('10.12.0')).toEqual([]);
  });

  it('knows what @pnpm/plugin-better-defaults sets from 0.3.0, also for a range that may resolve to it', () => {
    const known = (spec: string) => {
      const [hook] = pnpmHooks(pnpm, V12_16, read({ 'pnpm-workspace.yaml': `configDependencies:\n  '@pnpm/plugin-better-defaults': ${JSON.stringify(spec)}\n` }));
      return hook?.kind === 'plugin' ? hook.known?.settings : 'none';
    };
    expect(known('0.3.0+sha512-AAAA')).toEqual({ minimumReleaseAge: 1440, blockExoticSubdeps: true });
    expect(known('^0.2.0')).toEqual({ minimumReleaseAge: 1440, blockExoticSubdeps: true });
    expect(known('0.2.1')).toBeUndefined();
  });

  it('reads the settings that choose pnpmfiles where include gives them, and pnpmfile paths from that file', () => {
    const files = {
      'pnpm-workspace.yaml': "include:\n  ./config/hooks.yaml: [pnpmfile, configDependencies]\n",
      'config/hooks.yaml': "pnpmfile: [./hooks.cjs, /etc/pnpm/hooks.cjs]\nconfigDependencies:\n  '@pnpm/plugin-x': 1.0.0\n",
      'config/hooks.cjs': 'module.exports = {}\n',
      '.pnpmfile.mjs': 'export const hooks = {}\n',
    };
    expect(pnpmHooks(pnpm, V12_16, read(files))).toEqual([
      { kind: 'plugin', name: '@pnpm/plugin-x', spec: '1.0.0', file: 'config/hooks.yaml', line: 3 },
      { kind: 'pnpmfile', file: 'config/hooks.cjs', setting: 'pnpmfile' },
      { kind: 'pnpmfile', file: 'config/hooks.yaml', line: 1, setting: 'pnpmfile', path: '/etc/pnpm/hooks.cjs' },
    ]);
  });

  it('adds the pnpmfiles of workspace projects without a shared lockfile', () => {
    const files = { 'pnpm-workspace.yaml': 'sharedWorkspaceLockfile: false\n', 'packages/a/.pnpmfile.cjs': 'module.exports = {}\n', '.pnpmfile.cjs': 'module.exports = {}\n' };
    expect(pnpmHooks(pnpm, V12_16, { ...read(files), packages: ['packages/a', 'packages/b'] }).map((hook) => hook.file)).toEqual(['.pnpmfile.cjs', 'packages/a/.pnpmfile.cjs']);
  });
});

describe('apply and doctor on a pnpm project with include', () => {
  it('writes nothing into pnpm-workspace.yaml that a file of include owns, and a second apply changes nothing', () => {
    const directory = copy('pnpm-include-list');
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } }));
    const report = applyProject(directory, { write: true });
    expect(report.errors).toEqual([]);
    expect(report.changes.map((change) => change.file)).toEqual(['config/security.yaml']);
    expect(applyProject(directory, { write: true }).changes).toEqual([]);
    expect(runDoctor(directory).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it('explain shows the files of include, the pnpmfiles and plugins, and the settings a config dependency keeps from apply', async () => {
    const plugin = await exec('explain', '--json', join(REPOS, 'pnpm-plugin'));
    const report = JSON.parse(plugin.stdout) as { project: { warnings: { code: string; level: string; location?: { file: string; line?: number }; fix: string }[] } };
    expect(report.project.warnings.map((warning) => [warning.code, warning.level, warning.location])).toEqual([
      ['pnpm-hook', 'warning', { file: '.pnpmfile.mjs', line: 2 }],
      ['pnpm-hook', 'warning', { file: 'pnpm-workspace.yaml', line: 2 }],
    ]);
    const text = await exec('explain', join(REPOS, 'pnpm-plugin'));
    expect(text.stdout).toContain('  pnpm-hook: pnpm loads the pnpmfile of the config dependency @pnpm/plugin-better-defaults (configDependencies in pnpm-workspace.yaml, line 2)');

    const list = await exec('explain', join(REPOS, 'pnpm-include-list'));
    expect(list.stdout).toContain('    config files: config/catalog.yaml, config/security.yaml, pnpm-workspace.yaml');

    const directory = copy('pnpm-include-dependency');
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] }, sources: { git: 'deny', remoteTarball: 'deny' } }));
    const owned = await exec('explain', directory);
    expect(owned.stdout).toContain('    pnpm: cannot apply: minimumReleaseAge belongs to the config dependency @acme/pnpm-policy (include in pnpm-workspace.yaml, line 4)');
    expect(owned.stdout).toMatch(/installScripts deny, allow esbuild:\n {4}pnpm: nothing written; warning: pnpm: allowBuilds not written: allowBuilds belongs to the config dependency @acme\/pnpm-policy/u);
    expect(owned.stdout).toMatch(/sources git deny, remoteTarball deny:\n {4}pnpm: nothing written; warning: pnpm: blockExoticSubdeps stops git and tarball sources only for indirect dependencies;[^\n]*; warning: pnpm: blockExoticSubdeps not written:/u);
  });

  it('notes that the delay of a config dependency cannot be read when doctor compares with the default policy', async () => {
    const directory = copy('pnpm-include-dependency');
    const result = await exec('doctor', '--json', directory);
    const report = JSON.parse(result.stdout) as { notices: { code: string; message: string }[]; findings: { rule: string; message: string }[] };
    expect(report.notices).toContainEqual(expect.objectContaining({ code: 'config-drift', message: 'pnpm: minimumReleaseAge comes from the config dependency @acme/pnpm-policy (include in pnpm-workspace.yaml, line 4), whose value depcurfew cannot read' }));
    expect(report.findings.filter((finding) => finding.rule === 'pnpm-config-unverifiable').map((finding) => finding.message)).toEqual([
      'include in pnpm-workspace.yaml gives minimumReleaseAge, allowBuilds and blockExoticSubdeps to the config dependency @acme/pnpm-policy, whose settings depcurfew cannot read, so it cannot verify these settings, and depcurfew apply does not write them',
    ]);
  });
});
