// Fixes after the second re-check of 1.3.0 (decision D-111): Node.js before 18 has a known npm and an npm depcurfew
// cannot tell counts as one that runs scripts; COPY sources are read as Docker reads them; projects inherit the root's
// Node.js version files per kind; explain shows what a project takes from the root and an invalid policy as apply
// does; --json=x and --sarif=x are usage errors in their format; and the wording points.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPolicyIfPresent, planRepository } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { contextPath } from '../src/doctor/rules/bundled-versions.ts';
import { nodeBundledNpm, runtimeFacts } from '../src/doctor/runtime-versions.ts';
import { evidenceOf } from '../src/knowledge/facts.ts';
import { environment } from '../src/knowledge/environment.ts';

const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-recheck2-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
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
const npmRepo = (files: Record<string, string> = {}) => repository({ 'depcurfew.json': policy(), 'package.json': manifest(), 'package-lock.json': LOCK, ...files });
const plan = (directory: string) => planRepository(directory, loadPolicyIfPresent(directory) as NonNullable<ReturnType<typeof loadPolicyIfPresent>>);
const rule = (report: ReturnType<typeof runDoctor>, id: string) => report.findings.filter((finding) => finding.rule === id);
const npmrcOf = (directory: string, file: string) => plan(directory).changes.find((change) => change.file === file)?.after ?? '';

describe('Node.js before 18 (item C)', () => {
  it('knows the npm of every Node.js line of index.json, all below npm 11 before 18.0.0', () => {
    const lines = evidenceOf(environment.node.bundledNpm)[0]?.value ?? [];
    expect(lines.map((line) => line.line)).toEqual(['0.6', '0.7', '0.8', '0.9', '0.10', '0.11', '0.12', ...Array.from({ length: 23 }, (_, index) => String(index + 4))]);
    const before18 = lines.filter((line) => Number(line.line.split('.')[0]) < 18).flatMap((line) => line.bundles.map(([, npm]) => Number(npm.split('.')[0])));
    expect(before18.length).toBeGreaterThan(100);
    expect(Math.max(...before18)).toBeLessThan(11);
    const facts = runtimeFacts(environment);
    expect(nodeBundledNpm('16.20.2', 'nvm', facts)).toEqual({ kind: 'exact', bundled: [[8, 19, 4]], lines: ['16'] });
    expect(nodeBundledNpm('0.10.48', 'nvm', facts)).toEqual({ kind: 'exact', bundled: [[2, 15, 1]], lines: ['0.10'] });
    // Releases before 0.6.3 came without npm.
    expect(nodeBundledNpm('0.6.1', 'nvm', facts).kind).toBe('unknown');
    expect(nodeBundledNpm('0.4.12', 'nvm', facts).kind).toBe('unknown');
  });

  for (const [version, npm] of [
    ['16', 'npm 7.10.0 to 8.19.4'],
    ['16.20.2', 'npm 8.19.4'],
    ['14', 'npm 6.14.4 to 6.14.18'],
  ] as const) {
    it(`reports .nvmrc ${version} in doctor and apply`, () => {
      const directory = npmRepo({ '.nvmrc': `${version}\n` });
      const report = runDoctor(directory);
      const nvmrc = rule(report, 'manager-version-too-old');
      expect(nvmrc.map((finding) => [finding.level, finding.location.file])).toEqual([['warning', '.nvmrc']]);
      expect(nvmrc[0]?.message).toContain(`Node.js ${version} in .nvmrc ${version.includes('.') ? 'comes' : 'can come'} with ${npm}`);
      expect(report.notices.map((notice) => notice.message).filter((message) => message.includes('cannot tell which npm'))).toEqual([]);
      const several = npm.includes(' to ');
      expect(rule(report, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
        ['error', `core-js has install scripts and ${npm} (with Node.js ${version} in .nvmrc) ${several ? 'run' : 'runs'} them, but depcurfew.json does not allow it`],
      ]);
      const warning = plan(directory).warningDetails.find((item) => item.code === 'scripts-not-enforceable');
      expect(warning?.message).toBe(`${npm} (with Node.js ${version} in .nvmrc) ${several ? 'run' : 'runs'} every dependency install script and ${several ? 'have' : 'has'} no allow-list, so "deny" cannot be enforced there`);
      expect(warning?.location).toEqual({ file: '.nvmrc', line: 1 });
    });
  }

  it('reports a CI matrix with Node.js 16 as an error', () => {
    const workflow = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [16]\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm ci\n';
    const directory = npmRepo({ '.github/workflows/ci.yml': workflow });
    const found = rule(runDoctor(directory), 'manager-version-too-old');
    expect(found.map((finding) => [finding.level, finding.location])).toEqual([['error', { file: '.github/workflows/ci.yml', line: 7 }]]);
    expect(plan(directory).warningDetails.map((item) => item.code)).toContain('scripts-not-enforceable');
  });

  it('counts an npm it cannot tell as one that runs scripts (fail closed)', () => {
    const directory = npmRepo({ '.nvmrc': '24.99.0\n' });
    const report = plan(directory);
    expect(report.changes.find((change) => change.file === '.npmrc')?.after).not.toContain('strict-allow-scripts');
    const warning = report.warningDetails.find((item) => item.code === 'scripts-not-enforceable');
    expect(warning).toMatchObject({
      location: { file: '.nvmrc', line: 1 },
      message:
        'the npm that comes with Node.js 24.99.0 in .nvmrc (depcurfew cannot tell which one: it is newer than the releases depcurfew knows (24 up to 24.22.2)) may run every dependency install script, so depcurfew counts it as one that does, and "deny" may not be enforced there',
    });
    const doctor = runDoctor(directory);
    expect(rule(doctor, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
      ['error', 'core-js has install scripts and the npm that comes with Node.js 24.99.0 in .nvmrc (depcurfew cannot tell which one: it is newer than the releases depcurfew knows (24 up to 24.22.2)) may run them, but depcurfew.json does not allow it'],
    ]);
    // The note that says why stays.
    expect(doctor.notices.map((notice) => notice.message)).toContain('manager-version-too-old cannot tell which npm or pip comes with Node.js 24.99.0 in .nvmrc: it is newer than the releases depcurfew knows (24 up to 24.22.2)');
  });

  it('does not let a pinned npm 12 hide a Dockerfile stage whose npm it cannot tell', () => {
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest({ packageManager: 'npm@12.2.1' }), 'package-lock.json': LOCK, Dockerfile: 'FROM node:weird-tag\nRUN npm ci\n' });
    expect(rule(runDoctor(directory), 'lockfile-install-scripts').map((finding) => finding.level)).toEqual(['error']);
    expect(plan(directory).warningDetails.find((item) => item.code === 'scripts-not-enforceable')?.message).toMatch(/^the npm that comes with Node\.js of node:weird-tag in Dockerfile \(depcurfew cannot tell which one: /u);
  });
});

describe('COPY sources as Docker reads them (item F)', () => {
  it('normalises a source from the root of the build context', () => {
    expect(contextPath('frontend/../')).toBe('.');
    expect(contextPath('frontend/..//')).toBe('.');
    expect(contextPath('./frontend/./x')).toBe('frontend/x');
    expect(contextPath('/frontend/x')).toBe('frontend/x');
    expect(contextPath('../frontend/')).toBe('frontend');
    expect(contextPath('.')).toBe('.');
    expect(contextPath('frontend-old/')).toBe('frontend-old');
  });

  // The root and frontend run no npm 11.16 to 11.x of their own; node:24.18.0 brings npm 11.16.0, so the directory the
  // stage is credited to gets strict-allow-scripts.
  const cases: [string, 'root' | 'frontend'][] = [
    ['COPY frontend/../ .', 'root'],
    ['COPY frontend/..// .', 'root'],
    ['COPY ./frontend/./x .', 'frontend'],
    ['COPY /frontend/package.json ./', 'frontend'],
    ['COPY . .', 'root'],
    ['COPY frontend-old/ .', 'root'],
    ['COPY frontend/package.json shared/x.json ./', 'root'],
    ['COPY ./frontend/ .', 'frontend'],
  ];
  for (const [copy, owner] of cases) {
    it(`credits "${copy}" to the ${owner}`, () => {
      const directory = repository({
        'depcurfew.json': policy({ projects: ['frontend'] }),
        'package.json': manifest(),
        'package-lock.json': LOCK,
        'frontend/package.json': manifest(),
        'frontend/package-lock.json': LOCK,
        'frontend/.nvmrc': '22.11.0\n',
        Dockerfile: `FROM node:24.18.0\n${copy}\nRUN npm ci\n`,
      });
      expect(npmrcOf(directory, '.npmrc').includes('strict-allow-scripts=true')).toBe(owner === 'root');
      expect(npmrcOf(directory, 'frontend/.npmrc').includes('strict-allow-scripts=true')).toBe(owner === 'frontend');
    });
  }
});

describe('root Node.js version files per kind (item G)', () => {
  const projectRepo = (files: Record<string, string>) =>
    repository({ 'depcurfew.json': policy({ projects: ['frontend'] }), 'frontend/package.json': manifest(), 'frontend/package-lock.json': LOCK, ...files });

  it('uses the root .tool-versions for a project with only a .nvmrc of its own', () => {
    const directory = projectRepo({ '.tool-versions': 'nodejs 24.18.0\n', 'frontend/.nvmrc': '22\n' });
    expect(npmrcOf(directory, 'frontend/.npmrc')).toContain('strict-allow-scripts=true');
    const found = rule(runDoctor(directory), 'manager-version-too-old').filter((finding) => finding.location.file === '.tool-versions');
    expect(found.map((finding) => finding.message)).toEqual([
      'Node.js 24.18.0 in .tool-versions comes with npm 11.16.0, which does not support blocking dependency install scripts without strict-allow-scripts (added in 12.0.0), and frontend has no .tool-versions of its own, so it uses this one',
    ]);
  });

  it('hides the root .nvmrc behind the project .nvmrc', () => {
    const directory = projectRepo({ '.nvmrc': '24.18.0\n', 'frontend/.nvmrc': '22\n' });
    expect(npmrcOf(directory, 'frontend/.npmrc')).not.toContain('strict-allow-scripts');
  });
});

describe('explain lists each install of a Dockerfile stage once', () => {
  it('names one RUN that installs many times on one line', async () => {
    const directory = repository({
      'depcurfew.json': policy({}),
      'package.json': manifest(),
      'package-lock.json': LOCK,
      Dockerfile: `FROM node:24.18.0 AS web\nRUN ${Array.from({ length: 50 }, () => 'npm ci').join(' && ')}\n`,
    });
    const { stdout } = await exec('explain', directory);
    expect(stdout).toContain('web: node:24.18.0 (Node.js 24.18.0), npm installs on line 2\n');
    expect(stdout.split('npm installs on line 2').length).toBe(2);
  });
});

describe('explain shows what a project takes from the root (item H)', () => {
  it('lists the inherited version files and the root Dockerfile stages that build the project, with their copies', async () => {
    const directory = repository({
      'depcurfew.json': policy({ projects: ['frontend'] }),
      '.nvmrc': '24.18.0\n',
      'frontend/package.json': manifest(),
      'frontend/package-lock.json': LOCK,
      Dockerfile: 'FROM node:24.18.0 AS web\nCOPY frontend/package.json frontend/package-lock.json ./\nRUN npm ci\n',
    });
    const { stdout } = await exec('explain', directory);
    const project = stdout.slice(stdout.indexOf('Project frontend:'));
    expect(project).toContain('  Node.js versions:\n    24.18.0 (.nvmrc:1, nvmrc, at the repository root)\n');
    expect(project).toContain(
      '  Dockerfiles:\n    Dockerfile (at the repository root; the stage below builds frontend)\n      web: node:24.18.0 (Node.js 24.18.0), copies frontend/package.json and frontend/package-lock.json, npm installs on line 3\n',
    );
    // The root lists the copies too.
    expect(stdout).toContain('Dockerfiles:\n  Dockerfile\n    web: node:24.18.0 (Node.js 24.18.0), copies frontend/package.json and frontend/package-lock.json, npm installs on line 3\n');
    const json = JSON.parse((await exec('explain', directory, '--json')).stdout) as { projects: { fromRoot: unknown }[] };
    expect(json.projects[0]?.fromRoot).toEqual({ versions: [{ version: '24.18.0', source: 'nvmrc', file: '.nvmrc', line: 1 }], dockerfiles: [{ file: 'Dockerfile', stages: [0] }] });
  });
});

describe('an invalid depcurfew.json in explain, as apply says it (item D)', () => {
  it('spells the level, the code and the fix', async () => {
    const directory = repository({ 'depcurfew.json': '{ "version": 1, "projects": [3] }\n', 'package.json': manifest(), 'package-lock.json': LOCK });
    const applied = await exec('apply', directory);
    const explained = await exec('explain', directory);
    expect(explained.code).toBe(1);
    const block = applied.stderr.split('\n').filter((line) => line !== '').map((line) => `  ${line}`);
    // With the line of the entry, as the location in the JSON document (decision D-122).
    expect(block[0]).toBe('  error: depcurfew.json (line 1) is invalid (policy-invalid)');
    expect(explained.stdout).toContain(`Policy (depcurfew.json): invalid\n${block.join('\n')}\n`);
  });
});

describe('a value given to --json or --sarif (item E)', () => {
  for (const argv of [
    ['doctor', '--sarif=x'],
    ['doctor', '--json=x'],
    ['apply', '--json=x'],
    ['explain', '--json=yes'],
  ]) {
    it(`reports ${argv.join(' ')} as a usage error in its format`, async () => {
      const directory = npmRepo();
      const result = await exec(...argv, directory);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      const document = JSON.parse(result.stdout) as Record<string, unknown>;
      const option = (argv[1] ?? '').split('=')[0];
      if (option === '--sarif') {
        expect(document['version']).toBe('2.1.0');
        expect(JSON.stringify(document)).toContain("option '--sarif' takes no value");
      } else {
        expect(document).toMatchObject({ schemaVersion: 1, errors: [{ code: 'usage', level: 'error', message: "option '--json' takes no value" }] });
      }
    });
  }
});

describe('wording', () => {
  it('names a root Dockerfile once', () => {
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest(), 'package-lock.json': LOCK, Dockerfile: 'FROM node:24.18.0\nRUN npm install -g npm@11.15.0\nRUN npm ci\n' });
    const messages = rule(runDoctor(directory), 'manager-version-too-old').map((finding) => finding.message);
    expect(messages.map((message) => message.slice(0, message.indexOf(' does not support')))).toEqual(['npm 11.15.0 in Dockerfile']);
    expect(messages[0]).toMatch(/ \(added in 12\.0\.0\)$/u);
  });

  it('says which project is not pinned, and prefixes every warning of a project', () => {
    const directory = repository({
      'depcurfew.json': policy({ projects: ['frontend'] }),
      'frontend/package.json': manifest(),
      'frontend/package-lock.json': LOCK,
      'frontend/.nvmrc': '24.18.0\n',
      'frontend/Dockerfile': 'FROM node:22.11.0\nRUN npm ci\n',
    });
    const warnings = plan(directory).warningDetails.filter((item) => item.project === 'frontend');
    expect(warnings.length).toBeGreaterThan(2);
    for (const warning of warnings) expect(warning.message).toMatch(/^frontend: /u);
    expect(warnings.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use')?.message).toMatch(/^frontend: nothing pins one npm for frontend \(packageManager, devEngines, Volta or \.tool-versions\), and /u);
    expect(warnings.find((item) => item.code === 'scripts-not-enforceable')?.message).toBe(
      'frontend: npm 10.9.0 (with Node.js 22.11.0 of node:22.11.0 in frontend/Dockerfile) runs every dependency install script and has no allow-list, so "deny" cannot be enforced there',
    );
  });

  it('writes an INI setting as key=value in cooldown-shortened', () => {
    const directory = repository({ 'depcurfew.json': policy(), 'package.json': manifest({ packageManager: 'npm@11.19.1' }), 'package-lock.json': LOCK, '.npmrc': 'min-release-age=7\n' });
    const warning = plan(directory).warningDetails.find((item) => item.code === 'cooldown-shortened');
    expect(warning?.message).toBe(
      'npm: min-release-age=7 in .npmrc (line 1) waits 1 week, longer than cooldown.minimum "3d" in depcurfew.json; depcurfew apply comments it out and writes min-release-age=3 in its managed block, so npm waits only 3 days',
    );
  });
});
