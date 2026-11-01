// Fixes after re-checking 1.3.0 (decision D-109): apply decides strict-allow-scripts from every place npm runs and
// doctor promises only what apply then does; projects use the Node.js version files of the root; doctor reports a
// finding once; runtime-end-of-life notes; and the wording of explain, doctor --user, apply and the project bot note.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProject, loadPolicyIfPresent, planRepository } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { renderText, RULES, runDoctor, toSarif } from '../src/doctor/index.ts';
import { runUserDoctor } from '../src/user/doctor.ts';
import { userPolicyPath } from '../src/user/policy-path.ts';
import { fakeMachine } from './support/user.ts';

const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-recheck-'));
  temporary.push(directory);
  write(directory, files);
  return directory;
}

function write(directory: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, sources: { git: 'deny', remoteTarball: 'deny' }, targets: 'auto' };
const policy = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ ...POLICY, ...extra }, null, 2)}\n`;
const manifest = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ name: 'app', version: '1.0.0', private: true, ...extra, dependencies: { 'core-js': '3.38.1' } }, null, 2)}\n`;
const LOCK = `${JSON.stringify(
  {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { 'core-js': '3.38.1' } },
      'node_modules/core-js': { version: '3.38.1', resolved: 'https://registry.npmjs.org/core-js/-/core-js-3.38.1.tgz', integrity: 'sha512-x', hasInstallScript: true },
    },
  },
  null,
  2,
)}\n`;
const CI_NPM_11 = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: npm install -g npm@11.19.1\n      - run: npm ci\n';

const npmrc = (directory: string, file = '.npmrc') => readFileSync(join(directory, file), 'utf8');
const rule = (report: ReturnType<typeof runDoctor>, id: string) => report.findings.filter((finding) => finding.rule === id);


/**
 * The invariant of D-109: a doctor fix that says depcurfew apply writes strict-allow-scripts only stands where apply
 * writes it for the repository as it is (or after the change that fix asks for, "then writes").
 */
function promisesHold(directory: string): void {
  const report = runDoctor(directory);
  const now = report.findings.filter((finding) => (finding.fix ?? '').includes('which depcurfew apply writes for this repository'));
  if (now.length === 0) return;
  const plan = planRepository(directory, loadPolicyIfPresent(directory) as NonNullable<ReturnType<typeof loadPolicyIfPresent>>);
  const written = plan.changes.some((change) => change.after.includes('strict-allow-scripts=true'));
  expect({ written, fixes: now.map((finding) => finding.fix) }).toEqual({ written: true, fixes: now.map((finding) => finding.fix) });
}

describe('strict-allow-scripts from every place npm runs (item 1)', () => {
  it('writes it for a pinned npm 12 when a Dockerfile stage runs npm 11.16, and says what that means for npm 12', () => {
    const directory = repository({
      'depcurfew.json': policy(),
      'package.json': manifest({ packageManager: 'npm@12.2.1' }),
      'package-lock.json': LOCK,
      Dockerfile: 'FROM node:24.18.0\nRUN npm ci\n',
    });
    const before = runDoctor(directory);
    const docker = rule(before, 'manager-version-too-old').filter((finding) => finding.location.file === 'Dockerfile');
    expect(docker).toHaveLength(1);
    expect(docker[0]?.fix).toMatch(/^Set strict-allow-scripts=true in \.npmrc, which depcurfew apply writes for this repository, or /u);
    // npm 11.16.0 in the Dockerfile runs core-js's scripts without strict-allow-scripts: an error, which names that npm.
    expect(rule(before, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
      ['error', 'core-js has install scripts and npm 11.16.0 (with Node.js 24.18.0 of node:24.18.0 in Dockerfile) runs them, but depcurfew.json does not allow it'],
    ]);
    promisesHold(directory);

    const report = applyProject(directory, { write: true });
    expect(npmrc(directory)).toContain('strict-allow-scripts=true\n');
    const warning = report.warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use');
    expect(warning).toEqual({
      code: 'strict-allow-scripts-for-npm-in-use',
      tool: 'npm',
      location: { file: 'Dockerfile', line: 1 },
      message:
        'npm 11.16.0 (with Node.js 24.18.0 of node:24.18.0 in Dockerfile) runs dependency install scripts that allowScripts does not cover unless strict-allow-scripts is set, so depcurfew apply writes strict-allow-scripts=true; with it, in npm 12.0.0 and later the install fails instead of blocking the script with a warning, which applies to npm 12.2.1 (packageManager in package.json)',
      fix: 'Make every place listed here run npm 12.0.0 or later (npm install -g npm@12.2.1 before it installs packages), and depcurfew apply leaves strict-allow-scripts out; pinning npm in packageManager or devEngines does not change the npm they run. Until then, review the packages an install stops at and add them to installScripts.allow or installScripts.deny in depcurfew.json',
    });
    const after = runDoctor(directory);
    expect(rule(after, 'manager-version-too-old')).toEqual([]);
    expect(rule(after, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
      ['warning', 'core-js has install scripts that npm will not run because strict-allow-scripts in .npmrc stops the install until they are allowed; the package may need them'],
    ]);
    expect(applyProject(directory, { write: true }).changes).toEqual([]);
  });

  it('does not promise strict-allow-scripts for an npm installed by hand on Node.js 22, but does after .nvmrc moves to 24.18', () => {
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest(), 'package-lock.json': LOCK, '.nvmrc': '22\n' });
    const before = runDoctor(directory);
    const nvmrc = rule(before, 'manager-version-too-old').find((finding) => finding.location.file === '.nvmrc');
    expect(nvmrc?.fix).toBe(
      'Install npm 12.0.0 where this Node.js is used (npm install -g npm@12.0.0), or install npm 11.16.0 where this Node.js is used (npm install -g npm@11.16.0) and add strict-allow-scripts=true to .npmrc by hand, or require a Node.js release that comes with npm 11.16.0 or later in .nvmrc (24.18.0 or a later 24.x; 26.3.0 or later) with strict-allow-scripts=true in .npmrc, which depcurfew apply then writes; no supported Node.js release comes with npm 12.0.0 yet',
    );
    expect(planRepository(directory, loadPolicyIfPresent(directory) as never).changes.some((change) => change.after.includes('strict-allow-scripts'))).toBe(false);
    promisesHold(directory);
    // Following the fix that changes the repository: apply then writes it.
    write(directory, { '.nvmrc': '24.18.0\n' });
    applyProject(directory, { write: true });
    expect(npmrc(directory)).toContain('strict-allow-scripts=true\n');
    expect(rule(runDoctor(directory), 'manager-version-too-old')).toEqual([]);
  });

  it('keeps strict-allow-scripts after npm is pinned to 12 while CI and the Dockerfile install npm 11.19.1, listing them in one sentence', () => {
    const directory = repository({
      'depcurfew.json': policy(),
      'package.json': manifest({ packageManager: 'npm@12.2.1' }),
      'package-lock.json': LOCK,
      Dockerfile: 'FROM node:24.18.0\nRUN npm install -g npm@11.19.1\nRUN npm ci\n',
      '.github/workflows/ci.yml': CI_NPM_11,
    });
    promisesHold(directory);
    const report = applyProject(directory, { write: true });
    expect(npmrc(directory)).toContain('strict-allow-scripts=true\n');
    const warning = report.warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use');
    expect(warning?.message).toMatch(
      /^npm 11\.19\.1 \(installed in job test of \.github\/workflows\/ci\.yml, line 9\) and npm 11\.19\.1 \(installed in Dockerfile, line 2\) run dependency install scripts that allowScripts does not cover unless strict-allow-scripts is set, so depcurfew apply writes strict-allow-scripts=true; /u,
    );
    expect(report.warningDetails.map((item) => item.code)).not.toContain('strict-allow-scripts-from-node');
    const after = runDoctor(directory);
    expect(after.findings.filter((finding) => finding.level === 'error')).toEqual([]);
  });

  it('writes it without that warning for a pinned npm 11.x when every place runs npm 11.x', () => {
    const directory = repository({
      'depcurfew.json': policy(),
      'package.json': manifest({ packageManager: 'npm@11.19.1' }),
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': CI_NPM_11,
    });
    const report = applyProject(directory, { write: true });
    expect(npmrc(directory)).toContain('strict-allow-scripts=true\n');
    expect(report.warningDetails.map((item) => item.code)).toEqual([]);
  });

  it('lists the npm versions that cannot enforce "deny" in one sentence', () => {
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest(), 'package-lock.json': LOCK, '.nvmrc': '22\n', Dockerfile: 'FROM node:20.11.0\nRUN npm ci\n' });
    const report = planRepository(directory, loadPolicyIfPresent(directory) as never);
    expect(report.warningDetails.find((item) => item.code === 'scripts-not-enforceable')?.message).toBe(
      'npm 10.2.4 (with Node.js 20.11.0 of node:20.11.0 in Dockerfile) and npm 10.5.1 to 10.9.9 (with Node.js 22 in .nvmrc) run every dependency install script and have no allow-list, so "deny" cannot be enforced there',
    );
  });
});

describe('Node.js version files of the root for projects (item 2)', () => {
  const projectRepo = (files: Record<string, string> = {}) =>
    repository({
      'depcurfew.json': policy({ projects: ['frontend'] }),
      '.nvmrc': '24.18.0\n',
      'frontend/package.json': manifest(),
      'frontend/package-lock.json': LOCK,
      ...files,
    });

  it('uses the root .nvmrc for a project without a version file of its own, in apply and doctor', () => {
    const directory = projectRepo();
    const before = runDoctor(directory);
    expect(rule(before, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
      ['error', 'core-js has install scripts and npm 11.16.0 (with Node.js 24.18.0 in .nvmrc at the repository root) runs them, but depcurfew.json does not allow it'],
    ]);
    const nvmrc = rule(before, 'manager-version-too-old').filter((finding) => finding.location.file === '.nvmrc');
    expect(nvmrc.map((finding) => [finding.level, finding.message])).toEqual([
      [
        'warning',
        'Node.js 24.18.0 in .nvmrc comes with npm 11.16.0, which does not support blocking dependency install scripts without strict-allow-scripts (since 12.0.0), and frontend has no Node.js version file of its own, so it uses this one',
      ],
    ]);
    expect(nvmrc[0]?.fix).toMatch(/^Set strict-allow-scripts=true in frontend\/\.npmrc, which depcurfew apply writes for this repository, or /u);
    promisesHold(directory);
    const report = applyProject(directory, { write: true });
    expect(npmrc(directory, 'frontend/.npmrc')).toContain('strict-allow-scripts=true\n');
    expect(report.warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use')?.message).toMatch(/^frontend: npm is not pinned for the repository, and npm 11\.16\.0 \(with Node\.js 24\.18\.0 in \.nvmrc at the repository root\) runs /u);
    const after = runDoctor(directory);
    expect(rule(after, 'manager-version-too-old')).toEqual([]);
    expect(rule(after, 'lockfile-install-scripts').map((finding) => finding.level)).toEqual(['warning']);
    expect(applyProject(directory, { write: true }).changes).toEqual([]);
  });

  it('leaves the root .nvmrc out for a project with a version file of its own', () => {
    // Node.js 22.11.0 comes with npm 10.9.0, which has no allow-list: nothing to write strict-allow-scripts for.
    const directory = projectRepo({ 'frontend/.node-version': '22.11.0\n' });
    const plan = planRepository(directory, loadPolicyIfPresent(directory) as never);
    expect(plan.changes.find((change) => change.file === 'frontend/.npmrc')?.after).not.toContain('strict-allow-scripts');
    expect(rule(runDoctor(directory), 'lockfile-install-scripts').map((finding) => finding.message)).toEqual([
      'core-js has install scripts and npm 10.9.0 (with Node.js 22.11.0 in frontend/.node-version) runs them, but depcurfew.json does not allow it',
    ]);
  });

  it('counts a root Dockerfile for the project whose files it copies, and only then', () => {
    const copies = projectRepo({ 'frontend/.node-version': '22.11.0\n', Dockerfile: 'FROM node:24.18.0\nWORKDIR /app\nCOPY frontend/package.json frontend/package-lock.json ./\nRUN npm ci\n' });
    expect(planRepository(copies, loadPolicyIfPresent(copies) as never).changes.find((change) => change.file === 'frontend/.npmrc')?.after).toContain('strict-allow-scripts=true');
    const before = runDoctor(copies);
    const docker = rule(before, 'manager-version-too-old').filter((finding) => finding.location.file === 'Dockerfile');
    expect(docker.map((finding) => finding.level)).toEqual(['error']);
    expect(docker[0]?.message).toContain('installs packages with it for frontend on line 4');
    expect(docker[0]?.fix).toMatch(/^Set strict-allow-scripts=true in frontend\/\.npmrc, which depcurfew apply writes for this repository, or /u);
    promisesHold(copies);
    // COPY . . builds from the whole repository: not clearly a build of frontend.
    const whole = projectRepo({ 'frontend/.node-version': '22.11.0\n', Dockerfile: 'FROM node:24.18.0\nCOPY . .\nRUN cd frontend && npm ci\n' });
    expect(planRepository(whole, loadPolicyIfPresent(whole) as never).changes.find((change) => change.file === 'frontend/.npmrc')?.after).not.toContain('strict-allow-scripts');
    // Files of two directories: not clearly one project either.
    const both = projectRepo({ 'frontend/.node-version': '22.11.0\n', Dockerfile: 'FROM node:24.18.0\nCOPY frontend/package.json shared/x.json ./\nRUN npm ci\n' });
    expect(planRepository(both, loadPolicyIfPresent(both) as never).changes.find((change) => change.file === 'frontend/.npmrc')?.after).not.toContain('strict-allow-scripts');
  });

  it('names a root Dockerfile from the root also when the project has a Dockerfile of its own', () => {
    const directory = projectRepo({
      'frontend/.node-version': '22.11.0\n',
      'frontend/Dockerfile': 'FROM node:22.11.0\nRUN npm install -g npm@12.2.1\nRUN npm ci\n',
      Dockerfile: 'FROM node:24.18.0 AS web\nCOPY ./frontend/ .\nRUN npm ci\n',
    });
    const warning = planRepository(directory, loadPolicyIfPresent(directory) as never).warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use');
    expect(warning?.message).toContain('npm 11.16.0 (with Node.js 24.18.0 of node:24.18.0 in Dockerfile at the repository root)');
  });

  it('names at most six places in one warning', () => {
    const values = Array.from({ length: 20 }, (_, index) => `"24.${index}.0"`).join(', ');
    const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [${values}]\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node }}\n      - run: npm ci\n`;
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest(), 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow });
    const warning = planRepository(directory, loadPolicyIfPresent(directory) as never).warningDetails.find((item) => item.code === 'scripts-not-enforceable');
    expect(warning?.message).toMatch(/^(?:npm [^,]+, ){4}npm [^,]+ and 13 more places run every dependency install script/u);
  });
});

describe('duplicate findings (item 3)', () => {
  const steps = (count: number, version: string) => Array.from({ length: count }, () => `      - uses: actions/setup-node@v4\n        with:\n          node-version: ${version}\n      - run: npm ci\n`).join('');
  const workflow = (values: string, count: number) => `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [${values}]\n    steps:\n${steps(count, '${{ matrix.node }}')}`;

  it('reports the same finding once', () => {
    const directory = repository({ 'package.json': '{ "name": "app", "private": true }\n', 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n', '.github/workflows/ci.yml': workflow('16, 18', 3) });
    const report = runDoctor(directory, { policy: null });
    const keys = report.findings.map((finding) => JSON.stringify([finding.rule, finding.level, finding.location, finding.message, finding.fix]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(rule(report, 'runtime-end-of-life')).toHaveLength(2);
    const sarif = toSarif(report, RULES, '0.0.0') as { runs: { results: unknown[] }[] };
    expect(sarif.runs[0]?.results).toHaveLength(report.findings.length);
  });

  it('caps findings that differ only in numbers at one place (200 values x 200 setup steps)', () => {
    const values = Array.from({ length: 200 }, (_, index) => `"18.${index}.0"`).join(', ');
    const directory = repository({
      'depcurfew.json': '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": "auto" }\n',
      'package.json': '{ "name": "app", "private": true }\n',
      'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n',
      '.github/workflows/ci.yml': workflow(values, 200),
    });
    const report = runDoctor(directory);
    expect(report.findings.length).toBeLessThan(5000);
    expect(JSON.stringify(report).length).toBeLessThan(4_000_000);
    const atLine = report.findings.filter((finding) => finding.rule === 'manager-version-too-old' && finding.location.line === report.findings[0]?.location.line);
    expect(atLine.at(-1)?.message).toMatch(/^\d+ more manager-version-too-old findings at this place differ from the ones above only in numbers \(line numbers or versions\) and are not shown$/u);
    expect(atLine.at(-1)?.level).toBe('error');
  });
});

describe('runtime-end-of-life for versions it cannot read (item 4)', () => {
  it('gives a note with the file, line and fix instead of passing', async () => {
    const directory = repository({ 'package.json': '{ "name": "app", "private": true }\n', 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n', '.nvmrc': 'lts/-9\n', Dockerfile: 'FROM node:weird-tag\nRUN npm ci\n' });
    const report = runDoctor(directory, { policy: null });
    expect(rule(report, 'runtime-end-of-life')).toEqual([
      {
        rule: 'runtime-end-of-life',
        level: 'note',
        location: { file: '.nvmrc', line: 1 },
        message: 'runtime-end-of-life cannot tell whether Node.js lts/-9 in .nvmrc is past its end of life: it is not a version or a range depcurfew can read',
        fix: 'Write the version in .nvmrc as depcurfew reads it (such as 24, 24.11.0 or lts/krypton), or check by hand that it is a supported Node.js LTS line: 22 (until 2027-04-30), 24 (until 2028-04-30) or 26 (until 2029-04-30)',
      },
      {
        rule: 'runtime-end-of-life',
        level: 'note',
        location: { file: 'Dockerfile', line: 1 },
        message: 'runtime-end-of-life cannot tell whether Node.js (node:weird-tag) in Dockerfile is past its end of life: depcurfew does not know the tag weird-tag',
        fix: 'Use a node image tag that names the Node.js version (such as node:24-alpine), or check by hand that the image has a supported Node.js LTS line: 22 (until 2027-04-30), 24 (until 2028-04-30) or 26 (until 2029-04-30)',
      },
    ]);
    expect(report.notices.filter((notice) => notice.message.startsWith('runtime-end-of-life'))).toEqual([]);
    expect(report.checked?.rules.find((result) => result.rule === 'runtime-end-of-life')?.result).toBe('problems');
    expect(renderText(report, RULES)).not.toMatch(/^No problems found/u);
    // A private package's engines range it cannot read is a note too.
    const engines = repository({ 'package.json': '{ "name": "app", "private": true, "engines": { "node": ">=banana" } }\n', 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n' });
    expect(rule(runDoctor(engines, { policy: null }), 'runtime-end-of-life').map((finding) => [finding.level, finding.location.file])).toEqual([['note', 'package.json']]);
  });
});

describe('wording (items 5 to 7)', () => {
  it('explain spells the level and the location of a directory in projects that cannot be used (item 5)', async () => {
    const directory = repository({ 'depcurfew.json': policy({ projects: ['missing'] }), 'package.json': manifest(), 'package-lock.json': LOCK });
    const { code, stdout } = await exec('explain', directory);
    expect(code).toBe(1);
    expect(stdout).toContain('Project missing: cannot be used\n  error: depcurfew.json (line 16): the project directory missing listed in projects does not exist (project-not-found)\n  fix: ');
    const json = JSON.parse((await exec('explain', directory, '--json')).stdout) as { projects: { error: unknown }[] };
    expect(json.projects[0]?.error).toMatchObject({ code: 'project-not-found', level: 'error', location: { file: 'depcurfew.json', line: 16 } });
  });

  it('doctor --user agrees in number and says "added in" throughout (item 6)', () => {
    const cleanup: string[] = [];
    try {
      const environment = fakeMachine({ npm: { npm: '11.9.0' } }, cleanup);
      const file = userPolicyPath(environment);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '{ "version": 1, "cooldown": { "minimum": "3d" }, "sources": { "git": "deny", "remoteTarball": "deny", "file": "deny", "directory": "deny" } }\n');
      const found = runUserDoctor({ environment }).findings.find((finding) => finding.rule === 'user-config-drift' && finding.message.startsWith('npm 11.9.0'));
      expect(found?.message).not.toContain('(since');
      expect(found?.message).toContain('min-release-age and allow-git (added in 11.10.0), allow-remote, allow-file and allow-directory (added in 11.15.0)');
      expect(found?.message).toContain('allow-git, allow-remote, allow-file and allow-directory are not set');
    } finally {
      for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('apply says which targets leave a project out (item 6)', () => {
    const directory = repository({ 'depcurfew.json': policy({ targets: ['pip'], projects: ['frontend'] }), 'frontend/package.json': manifest(), 'frontend/package-lock.json': LOCK, 'requirements.txt': 'requests==2.32.3\n' });
    const warning = planRepository(directory, loadPolicyIfPresent(directory) as never).warningDetails.find((item) => item.code === 'nothing-to-configure');
    expect(warning?.message).toBe('frontend: no tools to configure: frontend uses npm, but targets in depcurfew.json does not list it');
  });

  it('says that the bot reads no configuration when the root has none (item 7)', () => {
    const directory = repository({ 'depcurfew.json': policy({ projects: ['web'] }), 'web/package.json': manifest(), 'web/package-lock.json': LOCK, 'web/renovate.json': '{ "minimumReleaseAge": "1 day" }\n' });
    const report = runDoctor(directory);
    expect(rule(report, 'bot-cooldown-mismatch')).toEqual([
      {
        rule: 'bot-cooldown-mismatch',
        level: 'note',
        location: { file: 'web/renovate.json' },
        message: 'Renovate reads its configuration only from the repository root, on the default branch, so it does not read web/renovate.json in the project web, and the repository root has no Renovate configuration',
        fix: 'Move web/renovate.json to the repository root, then run depcurfew apply',
      },
    ]);
    expect(report.checked?.tools.find((tool) => tool.id === 'renovate')).toEqual({ id: 'renovate', name: 'Renovate', project: 'web', unread: true });
    expect(renderText(report, RULES)).toContain('Renovate in web (not read by Renovate)');
  });
});
