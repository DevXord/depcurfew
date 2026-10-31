// doctor --user beyond drift: values that weaken every project, also next to a user policy and outside depcurfew's
// block, in the sections and files that override the user file, files it cannot check, an invalid user policy,
// credentials in what it prints and the SARIF locations of user files. Temporary home directory and PATH.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Version } from '../../src/apply/version.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { loadUserPolicy } from '../../src/user/policy.ts';
import { JsonSchemaValidator } from '../support/json-schema.ts';
import { canSymlink, windows } from '../support/platform.ts';
import { platform, shownPolicy, shownUserFile } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

interface Machine {
  /** Tools installed from npm (name → version), as shims with node_modules next to them. */
  npm?: Record<string, string>;
  /** Tools installed from PyPI (name → version), with a .dist-info; 'standalone' for a binary without one. */
  python?: Record<string, string>;
  /** The user policy: the default one, another document, raw text, or none. */
  policy?: unknown;
  env?: Record<string, string>;
}

function machine(options: Machine = {}): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-checks-'));
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
    if (version === 'standalone') continue;
    const info = join(root, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'METADATA'), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`);
    writeFileSync(join(info, 'entry_points.txt'), `[console_scripts]\n${name} = ${name}.__main__:main\n`);
  }
  const environment: UserEnvironment = { platform, home, env: { PATH: bin, ...options.env } };
  if (options.policy !== false) {
    const path = userPolicyPath(environment);
    mkdirSync(dirname(path), { recursive: true });
    const document = options.policy ?? DEFAULT_POLICY;
    writeFileSync(path, typeof document === 'string' ? document : renderPolicy(document as typeof DEFAULT_POLICY));
  }
  return environment;
}

/** The absolute path of a tool's user file for a version (the latest when undefined), created with its directory. */
function userFile(id: ToolId, environment: UserEnvironment, version?: Version): string {
  const tool = knowledgeBase.find((candidate) => candidate.id === id);
  const file = tool === undefined ? null : userFileFor(tool, version);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (path === undefined) throw new Error(`no user file for ${id}`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

const applyUser = (environment: UserEnvironment, versions?: Partial<Record<ToolId, Version>>) =>
  writeUserChanges(planUserApply(loadUserPolicy(environment).policy, { environment, ...(versions === undefined ? {} : { versions }) }));

const weakens = (report: ReturnType<typeof runUserDoctor>) => report.findings.filter((finding) => finding.rule === 'user-config-weakens');
const keysOf = (report: ReturnType<typeof runUserDoctor>) => weakens(report).map((finding) => /^(\S+)/u.exec(finding.message)?.[1]);

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

describe('weakening values next to a user policy', () => {
  it('reports allow-scripts in ~/.npmrc although the default policy covers install scripts', () => {
    const environment = machine({ npm: { npm: '11.21.1' } });
    applyUser(environment);
    writeFileSync(join(environment.home, '.npmrc'), 'allow-scripts=evil-pkg\n', { flag: 'a' });
    const report = runUserDoctor({ environment });
    expect(report.findings.map((finding) => finding.rule)).toEqual(['user-config-weakens']);
    expect(weakens(report)[0]).toMatchObject({ location: { file: '~/.npmrc' } });
    expect(weakens(report)[0]?.message).toContain('allow-scripts = "evil-pkg" in ~/.npmrc approves the install scripts of these packages');
    expect(weakens(report)[0]?.location.line).toBeGreaterThan(1);
  });

  it('reports exemptions in ~/.yarnrc.yml with their line, and the managed values apply wrote are not reported', () => {
    const environment = machine({ npm: { yarn: '4.18.1' } });
    applyUser(environment);
    const path = userFile('yarn', environment);
    writeFileSync(path, `${readFileSync(path, 'utf8')}npmPreapprovedPackages:\n  - "evil-*"\n`);
    const report = runUserDoctor({ environment });
    expect(keysOf(report)).toEqual(['npmPreapprovedPackages']);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(weakens(report)[0]?.location).toEqual({ file: shownUserFile('yarn', environment), line: lines.indexOf('npmPreapprovedPackages:') + 1 });
  });

  it('reports minimumReleaseAgeExclude in the pnpm config.yaml', () => {
    const environment = machine({ npm: { pnpm: '11.28.10' } });
    applyUser(environment);
    const path = userFile('pnpm', environment);
    writeFileSync(path, `${readFileSync(path, 'utf8')}minimumReleaseAgeExclude:\n  - evil\n`);
    expect(keysOf(runUserDoctor({ environment }))).toEqual(['minimumReleaseAgeExclude']);
  });

  it('reports Poetry exemptions and source builds in config.toml', () => {
    const environment = machine({ python: { poetry: '2.5.1' } });
    applyUser(environment);
    const path = userFile('poetry', environment);
    writeFileSync(path, readFileSync(path, 'utf8').replace('[solver]\n', '[solver]\nmin-release-age-exclude = ["evil"]\n').replace('[installer]\n', '[installer]\nno-binary = ["evil"]\n'));
    expect(keysOf(runUserDoctor({ environment })).sort()).toEqual(['installer.no-binary', 'solver.min-release-age-exclude']);
  });

  it('reports weakening uv.toml values when uv was skipped for an unknown version', () => {
    const environment = machine({ python: { uv: 'standalone' } });
    writeFileSync(userFile('uv', environment), 'exclude-newer = false\nno-build = false\nno-binary-package = ["evil"]\n');
    const withPolicy = runUserDoctor({ environment });
    expect(keysOf(withPolicy).sort()).toEqual(['exclude-newer', 'no-binary-package', 'no-build']);
    expect(withPolicy.notices.map((notice) => notice.message).join('\n')).toContain('uv: depcurfew cannot read the installed version');
    expect(withPolicy.notices.map((notice) => notice.message).join('\n')).not.toContain('nothing is written for it');
  });

  it('reports a value in depcurfew\'s block that the policy would not write, and a fake block without a policy', () => {
    const environment = machine({ npm: { npm: '11.21.1' } });
    applyUser(environment);
    const npmrc = join(environment.home, '.npmrc');
    writeFileSync(npmrc, readFileSync(npmrc, 'utf8').replace('allow-git=none', 'allow-git=none\nallow-scripts=evil'));
    const edited = runUserDoctor({ environment });
    expect(keysOf(edited)).toEqual(['allow-scripts']);
    expect(edited.findings.map((finding) => finding.rule)).toContain('user-config-drift');

    const bare = machine({ npm: { npm: '11.21.1' }, policy: false });
    writeFileSync(
      join(bare.home, '.npmrc'),
      '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\ndangerously-allow-all-scripts=true\n# <<< depcurfew managed block\n',
    );
    expect(keysOf(runUserDoctor({ environment: bare }))).toEqual(['dangerously-allow-all-scripts']);
  });

  it('does not report what the user policy itself writes into the block', () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: { version: 1, installScripts: { default: 'deny', allow: ['esbuild'] }, targets: 'auto' } });
    applyUser(environment);
    expect(readFileSync(join(environment.home, '.npmrc'), 'utf8')).toContain('allow-scripts=esbuild');
    expect(runUserDoctor({ environment }).findings).toEqual([]);
  });

  it('says once that a value applies to every project that does not set it', () => {
    const environment = machine({ python: { uv: 'standalone' }, policy: false });
    // A TOML integer too large for a number and a date do not get in the way.
    writeFileSync(userFile('uv', environment), 'exclude-newer = false\nexclude-newer-package = { big = 99999999999999999999, old = 1979-05-27 }\n');
    const [finding, table] = weakens(runUserDoctor({ environment }));
    expect(finding?.message.match(/every project/gu)).toHaveLength(1);
    expect(table?.message).toContain('exclude-newer-package = {"big":"99999999999999999999","old":"1979-05-27"}');
  });

  it('ignores keys under a [section] in ~/.npmrc, which npm does not apply', () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: false });
    writeFileSync(join(environment.home, '.npmrc'), '[other]\ndangerously-allow-all-scripts=true\n');
    expect(weakens(runUserDoctor({ environment }))).toEqual([]);
  });
});

describe('places that override the user file', () => {
  it('reports pip.conf values in [install], which beats [global] for pip install', () => {
    const environment = machine({ python: { pip: '26.2.2' } });
    applyUser(environment);
    const path = userFile('pip', environment);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n[install]\nuploaded-prior-to = P0D\nno-binary = :all:\n`);
    const report = runUserDoctor({ environment });
    expect(keysOf(report).sort()).toEqual(['no-binary', 'uploaded-prior-to']);
    const lines = readFileSync(path, 'utf8').split('\n');
    const found = weakens(report).find((finding) => finding.message.startsWith('uploaded-prior-to'));
    expect(found?.location.line).toBe(lines.indexOf('uploaded-prior-to = P0D') + 1);
    expect(found?.message).toContain('[install]');
  });

  it('reports the [pip] table of uv.toml, which uv pip reads over the top-level keys', () => {
    const environment = machine({ python: { uv: '0.13.6' } });
    applyUser(environment);
    const path = userFile('uv', environment);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n[pip]\nexclude-newer = false\n`);
    const report = runUserDoctor({ environment });
    expect(keysOf(report)).toEqual(['pip.exclude-newer']);
    expect(weakens(report)[0]?.location.line).toBe(readFileSync(path, 'utf8').split('\n').indexOf('exclude-newer = false') + 1);
  });

  it('reports ~/.npmrc values that pnpm 10 reads ahead of its rc file', () => {
    const environment = machine({ npm: { pnpm: '10.28.0' } });
    applyUser(environment);
    writeFileSync(join(environment.home, '.npmrc'), 'minimum-release-age=0\ndangerously-allow-all-builds=true\n');
    const report = runUserDoctor({ environment });
    expect(weakens(report).map((finding) => [finding.location, /^(\S+)/u.exec(finding.message)?.[1]])).toEqual([
      [{ file: '~/.npmrc', line: 1 }, 'minimum-release-age'],
      [{ file: '~/.npmrc', line: 2 }, 'dangerously-allow-all-builds'],
    ]);
    expect(weakens(report)[0]?.message).toContain(shownUserFile('pnpm', environment, [10, 28, 0]));
  });
});

describe('tools that get nothing written', () => {
  it('notes a version too old for the settings of the user policy, worded for doctor', () => {
    const environment = machine({ npm: { pnpm: '11.28.10' } });
    const report = runUserDoctor({ environment, versions: { pnpm: [0, 34, 0] } });
    const notes = report.notices.map((notice) => notice.message).join('\n');
    expect(notes).toContain('pnpm 0.34.0');
    expect(notes).not.toContain('; not written');
  });
});

describe('files doctor --user cannot check', () => {
  it('reports a pnpm config.yaml with a duplicate key as an error with its path and line', async () => {
    const environment = machine({ npm: { pnpm: '11.28.10' }, policy: false });
    writeFileSync(userFile('pnpm', environment), 'minimumReleaseAge: 4320\nminimumReleaseAge: 0\n');
    const report = runUserDoctor({ environment });
    expect(report.findings).toEqual([
      {
        rule: 'user-config-unreadable',
        level: 'error',
        location: { file: shownUserFile('pnpm', environment), line: 2 },
        message: expect.stringContaining(`${shownUserFile('pnpm', environment)} cannot be parsed`) as string,
        fix: expect.any(String) as string,
      },
    ]);
    const { code, stdout } = await cli(environment, 'doctor', '--user');
    expect(code).toBe(EXIT_FAILURE);
    expect(stdout).toContain('user-config-unreadable');
  });

  it('reports a YAML alias bomb, a file over 1 MiB and a directory in place of the file', () => {
    const bomb = machine({ npm: { yarn: '4.18.1' }, policy: false });
    const aliases = ['a: &a ["x","x","x","x","x","x","x","x","x"]', ...'bcdefgh'.split('').map((name, index) => `${name}: &${name} [${Array(9).fill(`*${'abcdefgh'[index]}`).join(',')}]`)];
    writeFileSync(userFile('yarn', bomb), `${aliases.join('\n')}\n`);
    expect(runUserDoctor({ environment: bomb }).findings.map((finding) => finding.rule)).toEqual(['user-config-unreadable']);

    const large = machine({ python: { uv: 'standalone' }, policy: false });
    writeFileSync(userFile('uv', large), `# ${'x'.repeat(1024 * 1024)}\n`);
    expect(runUserDoctor({ environment: large }).findings).toMatchObject([{ rule: 'user-config-unreadable', level: 'error', message: expect.stringContaining('larger than 1 MiB') as string }]);

    const folder = machine({ npm: { npm: '11.21.1' }, policy: false });
    mkdirSync(join(folder.home, '.npmrc'));
    expect(runUserDoctor({ environment: folder }).findings).toMatchObject([{ rule: 'user-config-unreadable', location: { file: '~/.npmrc' } }]);
  });

  it.skipIf(!canSymlink())('reports a symlinked user file that apply --user cannot edit, with the shown path', () => {
    const environment = machine({ npm: { npm: '11.21.1' } });
    const target = join(environment.home, 'dotfiles-npmrc');
    writeFileSync(target, 'save-exact=true\n');
    symlinkSync(target, join(environment.home, '.npmrc'));
    const report = runUserDoctor({ environment });
    const unreadable = report.findings.filter((finding) => finding.rule === 'user-config-unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ level: 'error', location: { file: '~/.npmrc' } });
    expect(unreadable[0]?.message).toContain('~/.npmrc');
    expect(report.notices.map((notice) => notice.message).join('\n')).not.toContain('symlink');
  });
});

describe('an invalid user policy', () => {
  it('is an error finding that names the user policy, in text, JSON and SARIF, with exit code 1', async () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: '{ "version": 1, "cooldown": { "minimum": "soon" } }\n' });
    const report = runUserDoctor({ environment });
    expect(report.policy).toBe('invalid');
    const [finding] = report.findings;
    expect(finding).toMatchObject({ rule: 'user-policy-invalid', level: 'error', location: { file: shownPolicy(environment) } });
    expect(finding?.message).toContain('cooldown');
    expect(finding?.fix).toContain(shownPolicy(environment));
    expect(finding?.fix).not.toMatch(/(^|\s)depcurfew\.json/u);
    const text = await cli(environment, 'doctor', '--user');
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stdout).not.toContain('No problems found');
    const json = await cli(environment, 'doctor', '--user', '--json');
    expect(json.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(json.stdout)).toMatchObject({ policy: 'invalid', summary: { error: 1 } });
    const sarif = JSON.parse((await cli(environment, 'doctor', '--user', '--sarif')).stdout) as { runs: { results: { ruleId: string; level: string }[] }[] };
    expect(sarif.runs[0]?.results).toMatchObject([{ ruleId: 'user-policy-invalid', level: 'error' }]);
  });
});

describe('credentials', () => {
  it('are never printed, in text, JSON or SARIF', async () => {
    const environment = machine({ python: { pip: '26.2.2' }, policy: false, env: { PIPENV_PYPI_MIRROR: 'https://alice:glpat-SECRET@mirror.example.com/simple' } });
    writeFileSync(join(environment.env['PATH'] ?? '', 'pipenv'), '#!/bin/sh\n');
    writeFileSync(userFile('pip', environment), '[global]\nfind-links = https://bob:ghp_TOKEN@host.example.com/links\n');
    for (const format of [[], ['--json'], ['--sarif']]) {
      const { stdout } = await cli(environment, 'doctor', '--user', ...format);
      expect(stdout).toContain('find-links');
      expect(stdout).toContain('PIPENV_PYPI_MIRROR');
      expect(stdout).not.toMatch(/glpat-SECRET|ghp_TOKEN|alice:|bob:/u);
    }
  });
});

describe('SARIF of doctor --user', () => {
  const validator = new JsonSchemaValidator(JSON.parse(readFileSync(new URL('../fixtures/sarif/sarif-schema-2.1.0.json', import.meta.url), 'utf8')) as Record<string, unknown>);

  it('locates user files below the home directory without a repository root, and variables as logical locations', async () => {
    const environment = machine({ npm: { npm: '11.21.1' }, policy: false, env: { NPM_CONFIG_USERCONFIG: '/elsewhere/npmrc' } });
    writeFileSync(join(environment.home, '.npmrc'), 'save-exact=true\ndangerously-allow-all-scripts=true\n');
    const { stdout } = await cli(environment, 'doctor', '--user', '--sarif');
    const sarif = JSON.parse(stdout) as Record<string, unknown>;
    expect(validator.validate(sarif)).toEqual([]);
    expect(stdout).not.toContain('%SRCROOT%');
    expect(stdout).not.toContain(environment.home.replaceAll('\\', '\\\\'));
    const [runResult] = (sarif as { runs: { originalUriBaseIds: Record<string, unknown>; results: { locations: Record<string, unknown>[] }[] }[] }).runs;
    expect(Object.keys(runResult?.originalUriBaseIds ?? {})).toEqual(['HOME']);
    const locations = runResult?.results.map((result) => result.locations[0]);
    expect(locations).toContainEqual({
      physicalLocation: { artifactLocation: { uri: '.npmrc', uriBaseId: 'HOME' }, region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 35 } },
    });
    expect(locations).toContainEqual({ logicalLocations: [{ name: 'NPM_CONFIG_USERCONFIG', kind: 'variable' }] });
  });

  it.skipIf(windows)('uses an absolute file URI for a user file outside the home directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'depcurfew-xdg-'));
    temporary.push(outside);
    const environment = machine({ python: { uv: 'standalone' }, policy: false, env: { XDG_CONFIG_HOME: outside } });
    writeFileSync(userFile('uv', environment), 'exclude-newer = false\n');
    const sarif = JSON.parse((await cli(environment, 'doctor', '--user', '--sarif')).stdout) as { runs: { results: { locations: { physicalLocation: { artifactLocation: Record<string, unknown> } }[] }[] }[] };
    expect(validator.validate(sarif)).toEqual([]);
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation).toEqual({ uri: `file://${outside}/uv/uv.toml` });
  });
});
