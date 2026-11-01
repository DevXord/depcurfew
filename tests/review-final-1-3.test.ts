// Fixes after the final review before 1.3.0 (decision D-115): npm install -g npm@X in root CI jobs and Dockerfiles is
// checked for the project it installs in, a range or an unreadable version there is no longer dropped, git submodules
// are no projects, installs with scripts off and npm ci-only places need less, npm 11 is not offered for a Node.js it
// does not run on, lts/-n in .nvmrc, cd before an install, job containers, secrets in the diff and the wording.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { redactSecrets } from '../src/apply/diff.ts';
import { loadPolicyIfPresent, planRepository } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { nodeBundledNpm, nodeReleasesIn, runtimeFacts } from '../src/doctor/runtime-versions.ts';
import { detectProject } from '../src/detect/index.ts';
import { evidenceOf } from '../src/knowledge/facts.ts';
import { environment } from '../src/knowledge/environment.ts';
import { npm } from '../src/knowledge/npm.ts';

const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-final-'));
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

const DENY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, targets: 'auto' };
const COOLDOWN = { version: 1, cooldown: { minimum: '3d' }, targets: 'auto' };
const policy = (base: Record<string, unknown>, extra: Record<string, unknown> = {}) => `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`;
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
const workflow = (steps: string, extra = '') => `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const setupNode = (version: string) => `      - uses: actions/setup-node@v4\n        with:\n          node-version: ${version}\n`;
const plan = (directory: string) => planRepository(directory, loadPolicyIfPresent(directory) as NonNullable<ReturnType<typeof loadPolicyIfPresent>>);
const rule = (report: ReturnType<typeof runDoctor>, id: string) => report.findings.filter((finding) => finding.rule === id);
const npmrcOf = (directory: string, file = '.npmrc') => plan(directory).changes.find((change) => change.file === file)?.after ?? '';
const codes = (directory: string) => plan(directory).warningDetails.map((warning) => warning.code);

describe('npm install -g npm@X in root CI jobs and Dockerfiles for projects (B1)', () => {
  const projectRepo = (files: Record<string, string>) =>
    repository({ 'depcurfew.json': policy(DENY, { projects: ['frontend'] }), 'frontend/package.json': manifest(), 'frontend/package-lock.json': LOCK, ...files });

  it('checks the npm a root job installs in frontend with the settings of frontend', () => {
    const directory = projectRepo({
      '.github/workflows/ci.yml': workflow(`${setupNode('24')}      - run: npm install -g npm@10.9.0\n      - run: npm ci\n`, '    defaults:\n      run:\n        working-directory: frontend\n'),
    });
    expect(codes(directory)).toContain('scripts-not-enforceable');
    const found = rule(runDoctor(directory), 'manager-version-too-old');
    expect(found).toEqual([
      {
        rule: 'manager-version-too-old',
        level: 'error',
        location: { file: '.github/workflows/ci.yml', line: 12 },
        message:
          'npm 10.9.0 in GitHub Actions (.github/workflows/ci.yml) does not support blocking dependency install scripts without strict-allow-scripts (added in 12.0.0), and job test installs packages with it in frontend on line 13',
        fix: 'Require npm 12.0.0 or later in GitHub Actions (npm 12.0.0 runs on Node.js ^22.22.2 || ^24.15.0 || >=26.0.0 only), or npm 11.16.0 or later with strict-allow-scripts=true in frontend/.npmrc, which depcurfew apply then writes',
      },
    ]);
  });

  it('checks the npm a root Dockerfile stage installs for frontend', () => {
    const directory = projectRepo({ Dockerfile: 'FROM node:24.18.0\nCOPY frontend/ .\nRUN npm install -g npm@10.9.0 && npm ci\n' });
    const found = rule(runDoctor(directory), 'manager-version-too-old');
    expect(found.map((finding) => [finding.level, finding.location, finding.message])).toEqual([
      [
        'error',
        { file: 'Dockerfile', line: 3 },
        'npm 10.9.0 in Dockerfile does not support blocking dependency install scripts without strict-allow-scripts (added in 12.0.0), and the stage at line 1 installs packages with it for frontend on line 3',
      ],
    ]);
  });

  it('leaves a root job that only upgrades npm and installs nothing alone', () => {
    const directory = projectRepo({ '.github/workflows/ci.yml': workflow(`${setupNode('24')}      - run: npm install -g npm@10.9.0\n      - run: npm test\n`) });
    expect(rule(runDoctor(directory), 'manager-version-too-old')).toEqual([]);
  });
});

describe('npm install -g npm with a range or a version depcurfew cannot read (B2)', () => {
  const ciRepo = (spec: string) =>
    repository({
      'depcurfew.json': policy(DENY),
      'package.json': manifest(),
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': workflow(`${setupNode('24.18.0')}      - run: npm install -g npm@${spec}\n      - run: npm ci\n`),
    });

  it('counts npm@^11.10.0 from its lowest version and as the 11.16 to 11.x it allows, in doctor and apply', () => {
    const directory = ciRepo('^11.10.0');
    const report = runDoctor(directory);
    expect(rule(report, 'lockfile-install-scripts').map((finding) => [finding.level, finding.message])).toEqual([
      ['error', 'core-js has install scripts and npm@^11.10.0 (installed in job test of .github/workflows/ci.yml, line 9) run them, but depcurfew.json does not allow it'],
    ]);
    expect(npmrcOf(directory)).toContain('strict-allow-scripts=true');
    expect(codes(directory)).toEqual(expect.arrayContaining(['scripts-not-enforceable', 'strict-allow-scripts-for-npm-in-use']));
    const manager = rule(report, 'manager-version-too-old');
    expect(manager.map((finding) => [finding.level, finding.message])).toEqual([
      [
        'warning',
        'GitHub Actions (.github/workflows/ci.yml) allows npm 11.10.0 ("^11.10.0"), which does not support blocking dependency install scripts without strict-allow-scripts (added in 12.0.0)',
      ],
    ]);
  });

  it('counts npm@11 and npm@11.16 as ranges, not as no npm at all', () => {
    expect(npmrcOf(ciRepo('11'))).toContain('strict-allow-scripts=true');
    expect(npmrcOf(ciRepo('11.16'))).toContain('strict-allow-scripts=true');
    expect(codes(ciRepo('11.15'))).toContain('scripts-not-enforceable');
  });

  for (const spec of ['latest', '${NPM_VERSION}']) {
    it(`counts npm@${spec} as an npm that may run every dependency install script`, () => {
      const directory = ciRepo(spec);
      const report = runDoctor(directory);
      expect(rule(report, 'lockfile-install-scripts').map((finding) => finding.message)).toEqual([
        `core-js has install scripts and npm@${spec} (installed in job test of .github/workflows/ci.yml, line 9; depcurfew cannot tell which version that is) may run them, but depcurfew.json does not allow it`,
      ]);
      const warning = plan(directory).warningDetails.find((item) => item.code === 'scripts-not-enforceable');
      expect(warning?.message).toContain(`npm@${spec} (installed in job test of .github/workflows/ci.yml, line 9; depcurfew cannot tell which version that is) may run every dependency install script`);
      expect(npmrcOf(directory)).not.toContain('strict-allow-scripts');
      // doctor promises strict-allow-scripts from apply only where apply writes it.
      expect(report.findings.filter((finding) => (finding.fix ?? '').includes('which depcurfew apply writes for this repository'))).toEqual([]);
    });
  }
});

describe('git submodules are no projects (B3)', () => {
  it('init leaves a directory with a .git file out, with a warning', async () => {
    const directory = repository({
      'frontend/package.json': '{ "name": "frontend", "private": true }\n',
      'vendor/package.json': '{ "name": "vendor", "private": true }\n',
      'vendor/.git': 'gitdir: ../.git/modules/vendor\n',
    });
    const result = await exec('init', directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('projects lists frontend:');
    expect(result.stdout).toContain('warning: vendor is not in projects: it is a separate git repository (it has a .git of its own, as a git submodule does), whose files belong to that repository; run depcurfew init in vendor for it.\n');
  });

  it('apply and doctor refuse a listed project that is a repository of its own, at the line of its entry', async () => {
    const directory = repository({
      'depcurfew.json': policy(COOLDOWN, { projects: ['vendor/lib'] }),
      'vendor/.git': 'gitdir: ../.git/modules/vendor\n',
      'vendor/lib/package.json': '{ "name": "lib", "private": true }\n',
    });
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.stdout) as { written: boolean; errors: unknown[] };
    expect(document.written).toBe(false);
    const line = 8;
    expect(document.errors).toEqual([
      {
        code: 'project-is-repository',
        level: 'error',
        location: { file: 'depcurfew.json', line },
        message: 'the project directory vendor/lib listed in projects lies in vendor, which is a separate git repository (vendor/.git is there, as in a git submodule), so the files depcurfew would write there belong to that repository',
        fix: 'Remove "vendor/lib" from projects in depcurfew.json, and run depcurfew in vendor on its own, with a depcurfew.json of that repository',
      },
    ]);
    expect(rule(runDoctor(directory), 'invalid-project').map((finding) => [finding.location, finding.message])).toEqual([[{ file: 'depcurfew.json', line }, (document.errors[0] as { message: string }).message]]);
  });
});

describe('installs with dependency install scripts off (B5)', () => {
  const scriptsRepo = (files: Record<string, string>) => repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest(), 'package-lock.json': LOCK, ...files });
  const cases: [string, Record<string, string>][] = [
    ['npm ci --ignore-scripts', { '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci --ignore-scripts\n`) }],
    ['npm ci --ignore-scripts=true', { '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci --ignore-scripts=true\n`) }],
    ['npm_config_ignore_scripts in the job env', { '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci\n`, '    env:\n      npm_config_ignore_scripts: true\n') }],
    ['NPM_CONFIG_IGNORE_SCRIPTS on the command', { '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: NPM_CONFIG_IGNORE_SCRIPTS=true npm ci\n`) }],
    ['ENV in the Dockerfile', { Dockerfile: 'FROM node:22 AS base\nENV npm_config_ignore_scripts=true\nFROM base\nRUN npm ci\n' }],
  ];
  for (const [name, files] of cases) {
    it(`counts no script runner for ${name}`, () => {
      const directory = scriptsRepo(files);
      const report = runDoctor(directory);
      expect(rule(report, 'lockfile-install-scripts').map((finding) => finding.level)).toEqual(['warning']);
      expect(rule(report, 'manager-version-too-old')).toEqual([]);
      expect(npmrcOf(directory)).not.toContain('strict-allow-scripts');
      expect(codes(directory)).not.toContain('scripts-not-enforceable');
    });
  }

  it('still counts --ignore-scripts=false, a later --no-ignore-scripts and a value other than true', () => {
    for (const command of ['npm ci --ignore-scripts=false', 'npm ci --ignore-scripts --no-ignore-scripts', 'npm_config_ignore_scripts=1 npm ci']) {
      const directory = scriptsRepo({ '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: ${command}\n`) });
      expect(rule(runDoctor(directory), 'lockfile-install-scripts').map((finding) => finding.level), command).toEqual(['error']);
    }
  });

  it('records it on the command, from the step env over the job env', () => {
    const directory = repository({
      'package.json': manifest(),
      '.github/workflows/ci.yml': workflow(`      - run: npm ci\n        env:\n          npm_config_ignore_scripts: "false"\n      - run: npm install\n`, '    env:\n      npm_config_ignore_scripts: true\n'),
    });
    expect(detectProject(directory).jobs[0]?.commands).toEqual([
      { kind: 'install', tool: 'npm', lockfile: true, line: 8 },
      { kind: 'install', tool: 'npm', scriptsOff: true, line: 11 },
    ]);
  });
});

describe('npm that cannot run on the Node.js of the place (B6)', () => {
  it('knows the engines of npm 11 and 12', () => {
    expect(evidenceOf(npm.extra?.['nodeEngines'] as never)[0]?.value).toEqual([
      { since: '11.0.0', node: '^20.17.0 || >=22.9.0' },
      { since: '12.0.0', node: '^22.22.2 || ^24.15.0 || >=26.0.0' },
    ]);
    const facts = runtimeFacts(environment);
    expect(nodeReleasesIn('18', 'setup-node', '^20.17.0 || >=22.9.0', facts)).toBe('none');
    expect(nodeReleasesIn('20', 'setup-node', '^20.17.0 || >=22.9.0', facts)).toBe('some');
    expect(nodeReleasesIn('20.10.0', 'setup-node', '^20.17.0 || >=22.9.0', facts)).toBe('none');
    expect(nodeReleasesIn('24', 'setup-node', '^20.17.0 || >=22.9.0', facts)).toBe('all');
  });

  it('says to move to a Node.js release npm runs on before installing it on Node.js 18', () => {
    const directory = repository({
      'depcurfew.json': policy(COOLDOWN),
      'package.json': manifest({ packageManager: 'npm@11.19.1' }),
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': workflow(`${setupNode('18')}      - run: npm install\n`),
    });
    const [finding] = rule(runDoctor(directory), 'manager-version-too-old');
    expect(finding?.fix).toMatch(/^Move to a Node\.js release that npm 11\.19\.1 runs on \(\^20\.17\.0 \|\| >=22\.9\.0\), then run npm install -g npm@11\.19\.1 in job test before it installs packages, or set up a Node\.js release that comes with npm 11\.10\.0 or later/u);
  });
});

describe('lts/-n in .nvmrc (B7)', () => {
  it('reads lts/-1 as the LTS line before the newest one, as nvm does', () => {
    const facts = runtimeFacts(environment);
    expect(nodeBundledNpm('lts/-1', 'nvm', facts)).toMatchObject({ kind: 'range', lines: ['24'] });
    expect(nodeBundledNpm('lts/-99', 'nvm', facts).kind).toBe('unknown');
  });
});

describe('npm ci installs the locked versions (R1)', () => {
  it('needs no release-age delay where every install is npm ci', () => {
    for (const files of [
      { '.github/workflows/ci.yml': workflow(`${setupNode('20')}      - run: npm ci\n`) },
      { Dockerfile: 'FROM node:22\nRUN npm ci --omit=dev\n' },
      { '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm install -g npm@10.9.0\n      - run: npm ci\n`) },
    ]) {
      const directory = repository({ 'depcurfew.json': policy(COOLDOWN), 'package.json': manifest(), 'package-lock.json': LOCK, ...files });
      expect(rule(runDoctor(directory), 'manager-version-too-old')).toEqual([]);
    }
  });

  it('still needs it where a job also runs npm install, and still needs script blocking for npm ci', () => {
    const both = repository({ 'depcurfew.json': policy(COOLDOWN), 'package.json': manifest(), 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci\n      - run: npm install left-pad\n`) });
    expect(rule(runDoctor(both), 'manager-version-too-old').map((finding) => finding.level)).toEqual(['error']);
    const scripts = repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest(), 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci\n`) });
    const [finding] = rule(runDoctor(scripts), 'manager-version-too-old');
    expect(finding?.message).toContain('none of which supports blocking dependency install scripts without strict-allow-scripts (added in 12.0.0)');
    expect(finding?.message).not.toContain('min-release-age');
  });

  it('is a verified fact next to lockfileInstalls', () => {
    const fact = npm.extra?.['cleanInstall'];
    expect(fact?.status).toBe('verified');
    expect(evidenceOf(fact as never)[0]?.value).toMatchObject({ installsLockedVersions: true, failsWhenOutOfSync: true });
  });
});

describe('wording of strict-allow-scripts-for-npm-in-use (R3, T20)', () => {
  it('says what pins npm when a Dockerfile installs one', () => {
    const directory = repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest(), 'package-lock.json': LOCK, Dockerfile: 'FROM node:24.18.0\nRUN npm install -g npm@11.17.0\nRUN npm ci\n' });
    const warning = plan(directory).warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use');
    expect(warning?.message).toMatch(/^nothing pins one npm for the repository \(packageManager, devEngines, Volta or \.tool-versions\), and npm 11\.17\.0 \(installed in Dockerfile, line 2\) runs /u);
  });

  it('tells to raise the pin where the pin is the place listed', () => {
    const directory = repository({
      'depcurfew.json': policy(DENY),
      'package.json': manifest({ packageManager: 'npm@11.19.1' }),
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': workflow(`${setupNode('24')}      - run: npm install -g npm@12.2.1\n      - run: npm ci\n`),
    });
    const warning = plan(directory).warningDetails.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use');
    expect(warning?.message).toMatch(/^npm 11\.19\.1 \(packageManager in package\.json\) runs /u);
    expect(warning?.fix).toBe(
      'Require npm 12.0.0 or later in packageManager in package.json, and depcurfew apply leaves strict-allow-scripts out. Until then, review the packages an install stops at and add them to installScripts.allow or installScripts.deny in depcurfew.json',
    );
  });
});

describe('cd before an install (T20)', () => {
  const projectRepo = (files: Record<string, string>) =>
    repository({ 'depcurfew.json': policy(DENY, { projects: ['frontend'] }), 'frontend/package.json': manifest(), 'frontend/package-lock.json': LOCK, ...files });

  it('counts cd frontend && npm ci in a Containerfile that copies the whole context for frontend', () => {
    const directory = projectRepo({ Containerfile: 'FROM node:18\nCOPY frontend/../ .\nRUN cd frontend && npm ci\n' });
    const found = rule(runDoctor(directory), 'manager-version-too-old');
    expect(found.map((finding) => [finding.location, finding.message])).toEqual([
      [
        { file: 'Containerfile', line: 1 },
        'Node.js 18 (node:18) in Containerfile can come with npm 8.6.0 to 10.8.2, none of which supports blocking dependency install scripts without strict-allow-scripts (added in 12.0.0), and the stage at line 1 installs packages with it for frontend on line 3; npm before 11.2.0 ignores settings it does not know without a warning',
      ],
    ]);
  });

  it('counts cd frontend in a CI step for frontend, but not after the ( ) it is in', () => {
    const directory = repository({ 'package.json': manifest(), '.github/workflows/ci.yml': workflow('      - run: cd frontend && npm ci\n      - run: (cd frontend && npm ci) && npm ci && cd $APP && npm ci\n') });
    expect(detectProject(directory).jobs[0]?.commands.map((command) => command.directory)).toEqual(['frontend', 'frontend', undefined, '<unknown>']);
  });
});

describe('the image of jobs.<id>.container (T8)', () => {
  for (const [container, install] of [
    ['    container: node:20\n', 7],
    ['    container:\n      image: node:20\n', 8],
  ] as const) {
    it(`reads ${container.trim().replace(/\n\s*/u, ' ')} like a FROM`, () => {
      const directory = repository({ 'depcurfew.json': policy(COOLDOWN), 'package.json': manifest(), 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow('      - run: npm install\n', container) });
      const report = runDoctor(directory);
      expect(rule(report, 'manager-version-too-old').map((finding) => [finding.level, finding.message])).toEqual([
        [
          'error',
          `Node.js 20 of the job container node:20 in GitHub Actions (.github/workflows/ci.yml, job test) can come with npm 9.6.4 to 10.8.2, none of which supports min-release-age (added in 11.10.0), and job test installs packages with it on line ${install}; npm before 11.2.0 ignores settings it does not know without a warning`,
        ],
      ]);
      expect(rule(report, 'runtime-end-of-life').map((finding) => finding.message)).toEqual([
        'Node.js 20 of the job container node:20 in GitHub Actions (.github/workflows/ci.yml, job test) is past its end of life (Node.js 20 ended on 2026-04-30) and gets no more releases, security fixes included',
      ]);
    });
  }

  it('lets a setup step after it set up another Node.js', () => {
    const directory = repository({ 'depcurfew.json': policy(COOLDOWN), 'package.json': manifest(), 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow(`${setupNode('26')}      - run: npm install\n`, '    container: node:20\n') });
    expect(rule(runDoctor(directory), 'manager-version-too-old')).toEqual([]);
  });
});

describe('secrets in the diff (P8)', () => {
  it('hides the client key of .npmrc, also under a //host/: prefix, and keeps the paths of certfile and keyfile', () => {
    expect(redactSecrets('key="-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"')).toBe('key=<redacted>');
    expect(redactSecrets('//npm.example.com/:key=-----BEGIN PRIVATE KEY-----')).toBe('//npm.example.com/:key=<redacted>');
    expect(redactSecrets('//npm.example.com/:keyfile=/etc/npm/client.key')).toBe('//npm.example.com/:keyfile=/etc/npm/client.key');
    expect(redactSecrets('//npm.example.com/:certfile=/etc/npm/client.crt')).toBe('//npm.example.com/:certfile=/etc/npm/client.crt');
  });
});

describe('checked rules with an invalid policy (T5)', () => {
  it('shows the rules that need a policy as skipped, as without one', () => {
    const directory = repository({ 'depcurfew.json': '{ "version": 1, "cooldown": { "minimum": "soon" } }\n', 'package.json': manifest(), 'package-lock.json': LOCK });
    const report = runDoctor(directory, { invalidPolicy: 'report' });
    const result = (id: string) => report.checked?.rules.find((entry) => entry.rule === id)?.result;
    expect(result('config-drift')).toBe('skipped');
    expect(result('lockfile-install-scripts')).toBe('skipped');
    expect(result('invalid-policy')).toBe('problems');
  });
});

describe('config-drift names every changed line (T3)', () => {
  it('lists each changed setting of the block, and reports changes further apart separately', async () => {
    const directory = repository({ 'depcurfew.json': policy(COOLDOWN, { sources: { git: 'deny', remoteTarball: 'deny' } }), 'package.json': manifest(), 'package-lock.json': LOCK });
    expect((await exec('apply', directory)).code).toBe(0);
    const npmrc = join(directory, '.npmrc');
    const written = readFileSync(npmrc, 'utf8');
    writeFileSync(npmrc, written.replace('min-release-age=3', 'min-release-age=1').replace('allow-git=none', 'allow-git=all').replace('allow-remote=none', 'allow-remote=all'));
    expect(rule(runDoctor(directory), 'config-drift').map((finding) => finding.message)).toEqual([
      '.npmrc does not match depcurfew.json: `min-release-age=1` should be `min-release-age=3`, `allow-git=all` should be `allow-git=none`, `allow-remote=all` should be `allow-remote=none`',
    ]);
    writeFileSync(npmrc, written.replace('min-release-age=3', 'min-release-age=1').replace('allow-remote=none', 'allow-remote=all'));
    expect(rule(runDoctor(directory), 'config-drift').map((finding) => [finding.location.line, finding.message])).toEqual([
      [2, '.npmrc does not match depcurfew.json: `min-release-age=1` should be `min-release-age=3`'],
      [4, '.npmrc does not match depcurfew.json: `allow-remote=all` should be `allow-remote=none`'],
    ]);
  });
});

describe('fixes that run apply while projects has an entry apply refuses (T13)', () => {
  it('says to fix projects first', () => {
    const directory = repository({ 'depcurfew.json': policy(COOLDOWN, { projects: ['missing'] }), 'package.json': manifest(), 'package-lock.json': LOCK });
    const drift = rule(runDoctor(directory), 'config-drift');
    expect(drift.length).toBeGreaterThan(0);
    for (const finding of drift) expect(finding.fix).toMatch(/^First fix the entry of projects in depcurfew\.json that invalid-project reports, because depcurfew apply writes nothing until then; then run depcurfew apply/u);
  });
});

describe('a directory listed in projects given on the command line or to the Action (T2)', () => {
  const repo = () => {
    const directory = repository({
      'depcurfew.json': policy(DENY, { projects: ['frontend'] }),
      '.nvmrc': '22.11.0\n',
      'frontend/package.json': manifest(),
      'frontend/package-lock.json': LOCK,
    });
    mkdirSync(join(directory, '.git'));
    return directory;
  };

  it('doctor, explain and apply use the policy of the root, as they do when run in that directory', async () => {
    const directory = repo();
    const fromRoot = runDoctor(directory);
    expect(fromRoot.findings.length).toBeGreaterThan(0);
    const doctor = await exec('doctor', '--json', join(directory, 'frontend'));
    const document = JSON.parse(doctor.stdout) as { findings: unknown[]; notices: { message: string }[] };
    expect(doctor.code).toBe(1);
    expect(document.findings).toEqual(fromRoot.findings);
    expect(document.notices[0]?.message).toMatch(/frontend is listed in projects in .*depcurfew\.json, so depcurfew doctor works on .*, which covers it with that policy; paths are relative to it$/u);
    const explain = JSON.parse((await exec('explain', '--json', join(directory, 'frontend'))).stdout) as { projects: { directory: string }[] };
    expect(explain.projects.map((entry) => entry.directory)).toEqual(['frontend']);
    const apply = await exec('apply', '--dry-run', '--json', join(directory, 'frontend'));
    expect((JSON.parse(apply.stdout) as { changes: { file: string }[] }).changes.map((change) => change.file)).toContain('frontend/.npmrc');
  });

  it('the Action checks the root with its projects for directory: frontend', async () => {
    const { runAction } = await import('../src/action.ts');
    const directory = repo();
    let log = '';
    const outputs = runAction({ GITHUB_WORKSPACE: directory, INPUT_DIRECTORY: 'frontend', INPUT_JOB_SUMMARY: 'false' }, { log: (text) => (log += text), summary: () => undefined });
    expect(log).toContain('depcurfew: frontend is listed in projects in depcurfew.json, so depcurfew doctor checks the repository root with its projects\n');
    expect(outputs.errors).toBe(runDoctor(directory).findings.filter((finding) => finding.level === 'error').length);
    expect(outputs.errors).toBeGreaterThan(0);
  });
});

describe('Poetry installed with pipx or pip in CI (T12)', () => {
  for (const command of ['pipx install poetry==2.3.0', 'pip install poetry==2.3.0', 'python -m pip install "poetry==2.3.0"']) {
    it(`reads ${command} as the Poetry the job runs`, () => {
      const directory = repository({
        'depcurfew.json': policy(COOLDOWN),
        'pyproject.toml': '[project]\nname = "demo"\nversion = "0.1.0"\n\n[tool.poetry]\npackage-mode = false\nrequires-poetry = ">=2.3"\n',
        'poetry.lock': '# This file is automatically @generated by Poetry 2.5.1 and should not be changed by hand.\npackage = []\n\n[metadata]\nlock-version = "2.1"\n',
        '.github/workflows/ci.yml': workflow(`      - run: ${command}\n      - run: poetry install\n`),
      });
      const found = rule(runDoctor(directory), 'manager-version-too-old').filter((finding) => finding.location.file === '.github/workflows/ci.yml');
      expect(found.map((finding) => [finding.level, finding.location.line, finding.message])).toEqual([
        ['error', 6, 'Poetry 2.3.0 in GitHub Actions (.github/workflows/ci.yml) does not support solver.min-release-age (added in 2.4.0)'],
      ]);
    });
  }
});

describe('the release-age delay of pip in Dockerfiles (T4)', () => {
  const pipRepo = (dockerfile: string, extra: Record<string, string> = {}) => repository({ 'depcurfew.json': policy(COOLDOWN), 'requirements.txt': 'idna==3.10\n', Dockerfile: dockerfile, ...extra });
  const found = (directory: string) => rule(runDoctor(directory), 'python-config-ignored').map((finding) => [finding.level, finding.location, finding.message, finding.fix]);

  it('reports a shorter PIP_UPLOADED_PRIOR_TO in ENV', () => {
    expect(found(pipRepo('FROM python:3.12-slim\nENV PIP_UPLOADED_PRIOR_TO=P1D\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\n'))).toEqual([
      [
        'error',
        { file: 'Dockerfile', line: 4 },
        'the stage at line 1 in Dockerfile installs packages with pip on line 4 with the release-age delay P1D (1 day), shorter than the 3d of depcurfew.json (3 days for pip)',
        'Set PIP_UPLOADED_PRIOR_TO=P3D instead, with ENV in the stage at line 1 before line 4 or as --uploaded-prior-to=P3D on that pip install',
      ],
    ]);
  });

  it('reports an install without any delay, also after doctor\'s own pip install pip==26.1.0', () => {
    expect(found(pipRepo('FROM python:3.12-slim AS app\nRUN pip install pip==26.1.0\nRUN pip install -r requirements.txt\n'))).toEqual([
      [
        'error',
        { file: 'Dockerfile', line: 3 },
        'stage app in Dockerfile installs packages with pip on line 3 without a release-age delay: pip reads no configuration from the project, and nothing sets PIP_UPLOADED_PRIOR_TO or --uploaded-prior-to there, so the 3d of depcurfew.json does not hold for it',
        'Add ENV PIP_UPLOADED_PRIOR_TO=P3D to stage app before line 3, or pass --uploaded-prior-to=P3D to that pip install (pip 26.1.0 or later reads a number of days)',
      ],
    ]);
  });

  it('passes with the delay from ENV of an earlier stage, the command line or the line itself, and leaves a pip.conf or PIP_CONFIG_FILE alone', () => {
    for (const dockerfile of [
      'FROM python:3.13 AS base\nENV PIP_UPLOADED_PRIOR_TO=P3D\nFROM base\nRUN pip install -r requirements.txt\n',
      'FROM python:3.13\nRUN pip install --uploaded-prior-to P7D -r requirements.txt\n',
      'FROM python:3.13\nRUN PIP_UPLOADED_PRIOR_TO=P3D pip install -r requirements.txt\n',
      'FROM python:3.13\nCOPY pip.conf /etc/pip.conf\nRUN pip install -r requirements.txt\n',
      'FROM python:3.13\nENV PIP_CONFIG_FILE=/etc/pip-ci.conf\nRUN pip install -r requirements.txt\n',
    ]) {
      expect(found(pipRepo(dockerfile, { 'pip.conf': '[global]\nuploaded-prior-to = P3D\n' })).filter((item) => (item[2] as string).includes('installs packages with pip')), dockerfile).toEqual([]);
    }
  });
});
