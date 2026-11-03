// The Yarn release yarnPath in .yarnrc.yml names is a version declaration of the project (decision D-165): every Yarn
// from 1.18 runs it instead of itself, so it wins over packageManager, and messages name both when they differ.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { detectProject } from '../src/detect/index.ts';
import { runDoctor } from '../src/doctor/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d165-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function repository(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d165-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch: async () => new Response('{}', { status: 404 }),
    now: () => new Date('2026-11-03T12:00:00Z'),
    stdin: async () => '',
    home: () => HOME,
  });
  return { code, stdout };
}

const BERRY_LOCK = '__metadata:\n  version: 6\n  cacheKey: 8\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n';
const POLICY = {
  version: 1,
  cooldown: { minimum: '3d', exclude: [], securityUpdates: 'bypass' },
  installScripts: { default: 'deny', allow: [], deny: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
  targets: 'auto',
  doctor: { failOn: 'warning' },
};
const RELEASE = '// A stand-in for the Yarn release that yarn set version saves here; tests never run it.\n';

/** A Yarn 3 project as yarn set version leaves it: yarnPath and the release, no packageManager. */
const yarn3 = (extra: Record<string, string | object> = {}) =>
  repository({
    'package.json': { name: 'app', private: true },
    'yarn.lock': BERRY_LOCK,
    '.yarnrc.yml': 'nodeLinker: node-modules\n\nyarnPath: .yarn/releases/yarn-3.6.4.cjs\n',
    '.yarn/releases/yarn-3.6.4.cjs': RELEASE,
    'depcurfew.json': POLICY,
    ...extra,
  });

const yarnOf = (root: string) => detectProject(root).packageManagers.find((manager) => manager.id === 'yarn');

describe('detection reads the version of the release yarnPath names', () => {
  it('as a declaration of its own, before packageManager', () => {
    const root = repository({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.12.0' },
      'yarn.lock': BERRY_LOCK,
      '.yarnrc.yml': 'nodeLinker: node-modules\n\nyarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    expect(yarnOf(root)?.versions).toEqual([
      { version: '4.9.2', source: 'yarnPath', file: '.yarnrc.yml', line: 3 },
      { version: '4.12.0', source: 'packageManager', file: 'package.json' },
    ]);
  });

  it.each([
    ['a quoted path with backslashes', 'yarnPath: ".yarn\\\\releases\\\\yarn-3.6.4.cjs"\n', '.yarn/releases/yarn-3.6.4.cjs'],
    ['a release in another folder of the repository', 'yarnPath: tools/yarn-3.6.4.cjs\n', 'tools/yarn-3.6.4.cjs'],
    ['a path through ./', 'yarnPath: ./.yarn/releases/yarn-3.6.4.cjs\n', '.yarn/releases/yarn-3.6.4.cjs'],
  ])('from %s', (_case, yarnrc, release) => {
    const root = repository({ 'package.json': { name: 'app' }, 'yarn.lock': BERRY_LOCK, '.yarnrc.yml': yarnrc, [release]: RELEASE });
    expect(yarnOf(root)?.versions).toEqual([{ version: '3.6.4', source: 'yarnPath', file: '.yarnrc.yml', line: 1 }]);
  });

  it.each([
    ['the release is not in the repository', 'yarnPath: .yarn/releases/yarn-3.6.4.cjs\n', {}],
    ['its name gives no version', 'yarnPath: .yarn/releases/yarn-remote.cjs\n', { '.yarn/releases/yarn-remote.cjs': RELEASE }],
    ['its name gives no exact version', 'yarnPath: .yarn/releases/yarn-3.x.cjs\n', { '.yarn/releases/yarn-3.x.cjs': RELEASE }],
    ['the path leaves the repository', 'yarnPath: ../yarn-3.6.4.cjs\n', {}],
    ['the path is absolute', 'yarnPath: /opt/yarn/yarn-3.6.4.cjs\n', {}],
    ['the path names a variable', 'yarnPath: ${YARN_HOME}/yarn-3.6.4.cjs\n', {}],
    ['yarnPath is not a string', 'yarnPath:\n  - .yarn/releases/yarn-3.6.4.cjs\n', { '.yarn/releases/yarn-3.6.4.cjs': RELEASE }],
  ])('not when %s: the version stays unknown', (_case, yarnrc, files) => {
    const root = repository({ 'package.json': { name: 'app' }, 'yarn.lock': BERRY_LOCK, '.yarnrc.yml': yarnrc, ...files });
    expect(yarnOf(root)?.versions).toEqual([]);
  });

  it('a Yarn 1 release under yarnPath makes the project Yarn Classic, whatever packageManager says', () => {
    const root = repository({
      'package.json': { name: 'app', packageManager: 'yarn@4.12.0' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-1.22.22.cjs\n',
      '.yarn/releases/yarn-1.22.22.cjs': RELEASE,
    });
    const detection = detectProject(root);
    expect(detection.packageManagers.find((manager) => manager.id === 'yarn')).toMatchObject({ variant: 'classic', supported: false });
    expect(detection.warnings.find((warning) => warning.code === 'yarn-classic-unsupported')?.files).toEqual(['.yarnrc.yml']);
  });

  it('a Yarn 4 release under yarnPath makes a project that pins Yarn 1 in packageManager a Yarn (Berry) project', () => {
    const root = repository({
      'package.json': { name: 'app', packageManager: 'yarn@1.22.22' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    expect(yarnOf(root)).toMatchObject({ variant: 'berry', supported: true });
  });
});

describe('apply configures the Yarn that yarnPath runs', () => {
  it('writes nothing Yarn 3.6.4 rejects when only yarnPath names the version, and says where the version is pinned', async () => {
    const root = yarn3();
    const report = applyProject(root);
    const yarnrc = readFileSync(join(root, '.yarnrc.yml'), 'utf8');
    expect(yarnrc).not.toMatch(/npmMinimalAgeGate|approvedGitRepositories/u);
    expect(yarnrc).toContain('enableScripts: false');
    const warnings = report.warningDetails.filter((warning) => warning.tool === 'yarn').map(({ code, location, message, fix }) => ({ code, location, message, fix }));
    expect(warnings.map((warning) => warning.code)).not.toContain('version-not-pinned');
    expect(warnings).toContainEqual({
      code: 'version-too-old',
      location: { file: '.yarnrc.yml', line: 3 },
      message: 'Yarn (Berry) 3.6.4 (yarnPath in .yarnrc.yml) does not support npmMinimalAgeGate (added in 4.10.2), approvedGitRepositories (added in 4.14.0); not written',
      fix: 'Run yarn set version 4.14.0 (or a later release), which saves it in .yarn/releases, points yarnPath in .yarnrc.yml to it and sets packageManager in package.json, then run depcurfew apply again',
    });
    // A second apply changes nothing.
    expect(applyProject(root).changes).toEqual([]);
  });

  it('configures for the yarnPath release, not for packageManager, and names both', async () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.12.0' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    const report = applyProject(root);
    expect(readFileSync(join(root, '.yarnrc.yml'), 'utf8')).not.toMatch(/npmMinimalAgeGate|approvedGitRepositories/u);
    expect(report.warningDetails.find((warning) => warning.code === 'version-too-old')).toMatchObject({
      location: { file: '.yarnrc.yml', line: 1 },
      message:
        'Yarn (Berry) 4.9.2 (yarnPath in .yarnrc.yml, which runs instead of yarn@4.12.0 in packageManager) does not support npmMinimalAgeGate (added in 4.10.2), approvedGitRepositories (added in 4.14.0); not written',
    });
  });

  it('writes every setting for a yarnPath release that has them, even when packageManager names an older Yarn', () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@3.6.4' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.18.1.cjs\n',
      '.yarn/releases/yarn-4.18.1.cjs': RELEASE,
    });
    const report = applyProject(root);
    const yarnrc = readFileSync(join(root, '.yarnrc.yml'), 'utf8');
    expect(yarnrc).toContain('npmMinimalAgeGate: 4320');
    expect(yarnrc).toContain('approvedGitRepositories: []');
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('version-too-old');
  });

  it('explain lists the yarnPath release with the other declarations and shows what apply leaves out', async () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.12.0' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    const { stdout } = await exec('explain', root);
    expect(stdout).toContain('    versions: 4.9.2 (.yarnrc.yml:1, yarnPath), 4.12.0 (package.json, packageManager)');
    expect(stdout).toContain('Yarn (Berry) 4.9.2 (yarnPath in .yarnrc.yml, which runs instead of yarn@4.12.0 in packageManager) does not support');
  });
});

describe('doctor checks the Yarn that yarnPath runs', () => {
  const own = (root: string, rule: string) =>
    runDoctor(root)
      .findings.filter((finding) => finding.rule === rule)
      .map(({ level, location, message, fix }) => ({ level, location, message, fix }));

  it('manager-version-too-old: settings of .yarnrc.yml the yarnPath release does not know', () => {
    // What depcurfew 1.4.1 wrote for this project: Yarn 3.6.4 stops every command at these keys.
    const root = yarn3({
      '.yarnrc.yml': 'nodeLinker: node-modules\n\nyarnPath: .yarn/releases/yarn-3.6.4.cjs\n# managed by depcurfew\nnpmMinimalAgeGate: 4320\n# managed by depcurfew\nenableScripts: false\n# managed by depcurfew\napprovedGitRepositories: []\n',
    });
    expect(own(root, 'manager-version-too-old')).toEqual([
      {
        level: 'error',
        location: { file: '.yarnrc.yml', line: 3 },
        message: 'Yarn (Berry) 3.6.4 in yarnPath (.yarnrc.yml) does not support npmMinimalAgeGate (added in 4.10.2), approvedGitRepositories (added in 4.14.0)',
        fix: 'Remove npmMinimalAgeGate and approvedGitRepositories from .yarnrc.yml, run yarn set version 4.14.0 (or a later release), which saves it in .yarn/releases, points yarnPath in .yarnrc.yml to it and sets packageManager in package.json, then run depcurfew apply again and commit the changes',
      },
    ]);
  });

  it('manager-version-too-old: the policy needs settings the yarnPath release does not have', () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.12.0' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    expect(own(root, 'manager-version-too-old')).toEqual([
      {
        level: 'error',
        location: { file: '.yarnrc.yml', line: 1 },
        message:
          'Yarn (Berry) 4.9.2 in yarnPath (.yarnrc.yml), which runs instead of yarn@4.12.0 in packageManager, does not support npmMinimalAgeGate (added in 4.10.2), approvedGitRepositories (added in 4.14.0)',
        fix: 'Run yarn set version 4.14.0 (or a later release), which saves it in .yarn/releases, points yarnPath in .yarnrc.yml to it and sets packageManager in package.json, then run depcurfew apply again and commit the changes',
      },
      {
        level: 'error',
        location: { file: 'package.json', line: 4 },
        message: 'Yarn (Berry) 4.12.0 in packageManager (package.json) does not support approvedGitRepositories (added in 4.14.0)',
        fix: 'Require Yarn (Berry) 4.14.0 or later in packageManager',
      },
    ]);
  });

  it('setting-ignored-by-version: packageManager pins another Yarn than the yarnPath release that runs', () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.12.0' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.9.2.cjs\n',
      '.yarn/releases/yarn-4.9.2.cjs': RELEASE,
    });
    expect(own(root, 'setting-ignored-by-version')).toEqual([
      {
        level: 'warning',
        location: { file: 'package.json', line: 4 },
        message:
          'packageManager in package.json pins yarn@4.12.0, but every Yarn from 1.18.0 runs the release yarnPath in .yarnrc.yml names instead, Yarn (Berry) 4.9.2, with or without Corepack, so the pin has no effect',
        fix: 'Run yarn set version 4.12.0 (or the release you mean to use), which saves it in .yarn/releases, points yarnPath in .yarnrc.yml to it and sets packageManager in package.json, so that both name the same release',
      },
    ]);
  });

  it('setting-ignored-by-version: the duration string check uses the yarnPath release and names it', () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.10.3.cjs\nnpmMinimalAgeGate: 7d\n',
      '.yarn/releases/yarn-4.10.3.cjs': RELEASE,
    });
    expect(own(root, 'setting-ignored-by-version').map((finding) => finding.message)).toEqual([
      'Yarn (Berry) 4.10.3 (yarnPath in .yarnrc.yml) ignores the duration string "7d" in npmMinimalAgeGate; strings work only since 4.11.0, so no delay applies',
    ]);
  });

  it('passes when packageManager and yarnPath name the same release, and lists the version with where it comes from', () => {
    const root = yarn3({
      'package.json': { name: 'app', private: true, packageManager: 'yarn@4.18.1' },
      '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.18.1.cjs\n',
      '.yarn/releases/yarn-4.18.1.cjs': RELEASE,
    });
    applyProject(root);
    const report = runDoctor(root);
    expect(report.findings.filter((finding) => ['manager-version-too-old', 'setting-ignored-by-version', 'config-drift'].includes(finding.rule))).toEqual([]);
    expect(report.checked?.tools).toContainEqual({ id: 'yarn', name: 'Yarn (Berry)', version: '4.18.1', versionFrom: '.yarnrc.yml' });
  });

  it('the s3b project of the review: apply, then doctor, both exit 0 and doctor reports what Yarn 3.6.4 lacks', async () => {
    const root = yarn3();
    expect((await exec('apply', root)).code).toBe(0);
    expect(readFileSync(join(root, '.yarnrc.yml'), 'utf8')).not.toMatch(/npmMinimalAgeGate|approvedGitRepositories/u);
    const doctor = await exec('doctor', '--json', root);
    const findings = (JSON.parse(doctor.stdout) as { findings: { rule: string; level: string; location: { file: string; line?: number } }[] }).findings;
    // The policy asks for a delay that Yarn 3.6.4 cannot apply: an error at yarnPath, not a pass.
    expect(findings.filter((finding) => finding.rule === 'manager-version-too-old').map((finding) => [finding.level, finding.location])).toEqual([['error', { file: '.yarnrc.yml', line: 3 }]]);
    expect(doctor.code).toBe(1);
  });
});
