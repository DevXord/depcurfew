// Fixes after the last verification of 1.3.0 (decision D-121): limits of the command reader for CI steps and RUN
// instructions, the PDM group table, the npm a fix offers for the Node.js of a place, the number of the verb after a
// list of npm places, and unreadable-config without a valid policy.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPolicyIfPresent, planRepository } from '../src/apply/index.ts';
import { findToolCommands, MAX_ASSIGNMENTS, MAX_DIRECTORY_CHANGES, MAX_DIRECTORY_LENGTH } from '../src/detect/commands.ts';
import { readDockerStages } from '../src/detect/dockerfiles.ts';
import { detectProject } from '../src/detect/index.ts';
import { detectionFacts } from '../src/detect/knowledge.ts';
import { parseToml } from '../src/detect/toml.ts';
import { jobSummary, renderText, RULES, runDoctor } from '../src/doctor/index.ts';
import { pdmHash } from '../src/doctor/locked-settings.ts';
import { environment, knowledgeBase } from '../src/knowledge/index.ts';

const facts = detectionFacts(knowledgeBase, environment);
const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-verification-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

const DENY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, targets: 'auto' };
const policy = (base: Record<string, unknown>, extra: Record<string, unknown> = {}) => `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`;
const manifest = `${JSON.stringify({ name: 'app', version: '1.0.0', private: true, dependencies: { 'core-js': '3.38.1' } }, null, 2)}\n`;
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
const commands = (script: string) => findToolCommands(script, facts.commands).commands.map(({ offset: _offset, ...command }) => command);
/** A run step of block lines, indented for workflow(). */
const runStep = (lines: readonly string[]) => `      - run: |\n${lines.map((line) => `          ${line}\n`).join('')}`;

describe('the command reader follows a script up to its limits (M4)', () => {
  it(`follows ${MAX_DIRECTORY_CHANGES} cd commands and no more`, () => {
    const within = findToolCommands(`${'cd a\n'.repeat(MAX_DIRECTORY_CHANGES)}npm ci\n`, facts.commands);
    expect(within.commands.map((command) => command.cd)).toEqual([Array.from({ length: MAX_DIRECTORY_CHANGES }, () => 'a').join('/')]);
    expect(within.overLimit).toBeUndefined();
    const over = findToolCommands(`${'cd a\n'.repeat(MAX_DIRECTORY_CHANGES + 1)}npm ci\n`, facts.commands);
    expect(over.commands.map((command) => command.cd)).toEqual(['<unknown>']);
    expect(over.overLimit).toEqual({ directory: 'changes' });
    // A cd in a subshell counts too; the directory outside it stays known.
    const sub = findToolCommands(`cd web\n${'(cd a)\n'.repeat(MAX_DIRECTORY_CHANGES)}npm ci\n(cd b && npm ci)\n`, facts.commands);
    expect(sub.commands.map((command) => command.cd)).toEqual(['web', '<unknown>']);
  });

  it(`follows a directory of up to ${MAX_DIRECTORY_LENGTH} characters`, () => {
    const name = 'x'.repeat(MAX_DIRECTORY_LENGTH);
    expect(commands(`cd ${name} && npm ci`)).toEqual([{ kind: 'install', tool: 'npm', lockfile: true, cd: name }]);
    const over = findToolCommands(`cd ${name} && cd y && npm ci && cd .. && npm ci`, facts.commands);
    expect(over.commands.map((command) => command.cd)).toEqual(['<unknown>', '<unknown>']);
    expect(over.overLimit).toEqual({ directory: 'length' });
  });

  it('keeps an unknown directory of sh -c unknown inside a known one', () => {
    expect(commands(`cd web && sh -c 'cd "$X" && npm ci' && sh -c 'cd a && npm ci'`).map((command) => command.cd)).toEqual(['<unknown>', 'web/a']);
  });

  it(`reads ${MAX_ASSIGNMENTS} variables of a script and no more`, () => {
    const exports = (count: number) => Array.from({ length: count }, (_, index) => `export V${index}=1\n`).join('');
    const off = 'export npm_config_ignore_scripts=true\nnpm ci\npip install -r requirements.txt\n';
    const within = findToolCommands(`${exports(MAX_ASSIGNMENTS - 1)}${off}`, facts.commands);
    expect(within.commands.map(({ offset: _offset, ...command }) => command)).toEqual([
      { kind: 'install', tool: 'npm', lockfile: true, scriptsOff: true },
      { kind: 'install', tool: 'pip' },
    ]);
    expect(within.overLimit).toBeUndefined();
    // Past the limit, a later export may turn scripts on again or set PIP_CONFIG_FILE: npm counts as running them, and
    // the delay of pip is unknown. --ignore-scripts on the command line still counts.
    const over = findToolCommands(`${exports(MAX_ASSIGNMENTS)}${off}npm ci --ignore-scripts\n`, facts.commands);
    expect(over.commands.map(({ offset: _offset, ...command }) => command)).toEqual([
      { kind: 'install', tool: 'npm', lockfile: true },
      { kind: 'install', tool: 'pip', delayUnknown: true },
      { kind: 'install', tool: 'npm', lockfile: true, scriptsOff: true },
    ]);
    expect(over.overLimit).toEqual({ variables: true });
    // Variables before commands count as well.
    expect(findToolCommands('A=1 npm ci\n'.repeat(MAX_ASSIGNMENTS + 1), facts.commands).overLimit).toEqual({ variables: true });
  });

  it('reads the variables commands use among thousands in env, in any case for npm', () => {
    const env = Array.from({ length: 5000 }, (_, index) => `      V${index}: x\n`).join('');
    const directory = repository({
      'package.json': manifest,
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': workflow(`${setupNode('22')}      - run: npm ci\n      - run: NPM_CONFIG_IGNORE_SCRIPTS=false npm ci\n`, `    env:\n${env}      Npm_Config_Ignore_Scripts: true\n`),
    });
    expect(detectProject(directory).jobs[0]?.commands).toEqual([
      { kind: 'install', tool: 'npm', lockfile: true, scriptsOff: true, line: 5011 },
      { kind: 'install', tool: 'npm', lockfile: true, line: 5012 },
    ]);
    const dockerfile = ['FROM node:22 AS base', ...Array.from({ length: 3000 }, (_, index) => `ENV V${index}=1`), 'ENV NPM_CONFIG_IGNORE_SCRIPTS=true', 'FROM base', 'RUN npm ci', 'ENV npm_config_ignore_scripts=false', 'RUN npm ci'];
    expect(readDockerStages('Dockerfile', dockerfile.join('\n'), facts.docker).info.stages.map((stage) => stage.commands)).toEqual([
      [],
      [
        { kind: 'install', tool: 'npm', lockfile: true, scriptsOff: true, line: 3004 },
        { kind: 'install', tool: 'npm', lockfile: true, line: 3006 },
      ],
    ]);
  });

  it('gives doctor and explain a notice with the step and a fix', () => {
    const directory = repository({
      'depcurfew.json': policy(DENY),
      'package.json': manifest,
      'package-lock.json': LOCK,
      '.github/workflows/ci.yml': workflow(`${setupNode('24')}${runStep([...Array.from({ length: 300 }, () => 'cd a'), 'npm install'])}`),
      Dockerfile: `FROM node:24\nRUN ${Array.from({ length: MAX_ASSIGNMENTS + 1 }, (_, index) => `export V${index}=1`).join(' && ')} && npm ci\n`,
    });
    const notices = runDoctor(directory).notices.filter((notice) => notice.code === 'script-not-followed');
    expect(notices).toEqual([
      {
        level: 'note',
        code: 'script-not-followed',
        location: { file: '.github/workflows/ci.yml', line: 9 },
        message:
          'the run step of job test in .github/workflows/ci.yml (line 9) changes the directory more than 256 times, so depcurfew cannot tell which directory the installs after that run in and checks them with the settings of the repository root',
        file: '.github/workflows/ci.yml',
        fix: 'Split the script into shorter run steps or RUN instructions, or check by hand where the installs after that point run and with which variables',
      },
      {
        level: 'note',
        code: 'script-not-followed',
        location: { file: 'Dockerfile', line: 2 },
        message:
          'the RUN instruction in Dockerfile (line 2) sets more than 1024 variables, so depcurfew does not read the later ones: npm installs after that count as ones that run dependency install scripts, and the release-age delay of pip installs after that is not checked',
        file: 'Dockerfile',
        fix: 'Split the script into shorter run steps or RUN instructions, or check by hand where the installs after that point run and with which variables',
      },
    ]);
    expect(detectProject(directory).warnings.filter((warning) => warning.code === 'script-not-followed')).toHaveLength(2);
    // apply writes for what it can tell; the notice is doctor's and explain's.
    expect(plan(directory).warningDetails.map((warning) => warning.code)).not.toContain('script-not-followed');
  });
});

describe('the content hash of pdm.lock with groups of any name (M5)', () => {
  const pdm = knowledgeBase.find((tool) => tool.id === 'pdm');
  const hashed = (pyproject: string, hash: string) => {
    if (pdm === undefined) throw new Error('PDM is not in the knowledge base');
    return pdmHash(pdm, parseToml(`[metadata]\ncontent_hash = "sha256:${hash}"\n`), parseToml(`[project]\nname = "x"\nversion = "1"\n\n${pyproject}`));
  };
  // The hashes were computed with Python's json.dumps(sort_keys=True) and hashlib of the dump PDM builds.
  const CONSTRUCTOR = 'dc1f042e96046d86ee4a48af7d8b0d8e6857223b8c95218894693268401668ec';
  const DEV = 'b15e769df78654e48e78a9ed59547bd3665f0cb0ce90cef6af8b814db466adb7';

  it('takes a group named constructor as data, in both tables', () => {
    expect(hashed('[tool.pdm.dev-dependencies]\nconstructor = ["a"]\ntoString = ["b"]\n', CONSTRUCTOR)).toEqual({ matches: true, line: 2 });
    expect(hashed('[dependency-groups]\nconstructor = ["a"]\n\n[tool.pdm.dev-dependencies]\ntoString = ["b"]\n', CONSTRUCTOR)).toEqual({ matches: true, line: 2 });
    expect(hashed('[tool.pdm.dev-dependencies]\nconstructor = ["a"]\ntoString = ["c"]\n', CONSTRUCTOR)).toEqual({ matches: false, line: 2 });
  });

  it('appends the lists of names that normalize to one group, in order', () => {
    expect(hashed('[tool.pdm.dev-dependencies]\nDev = ["a"]\nDEV = ["b"]\n"d.e.v" = []\ndev = ["c"]\n', DEV)).toEqual({ matches: false, line: 2 });
    expect(hashed('[tool.pdm.dev-dependencies]\nDev = ["a"]\nDEV = ["b"]\ndev = ["c"]\n', DEV)).toEqual({ matches: true, line: 2 });
    // A name twice in [dependency-groups] is an error of PDM: no answer.
    expect(hashed('[dependency-groups]\nDev = ["a"]\ndev = ["b"]\n', DEV)).toBeUndefined();
  });

  it('runs doctor on a pyproject.toml with such a group', () => {
    const directory = repository({
      'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n\n[tool.pdm.dev-dependencies]\nconstructor = ["a"]\ntoString = ["b"]\n',
      'pdm.lock': `[metadata]\ncontent_hash = "sha256:${CONSTRUCTOR}"\n`,
    });
    expect(runDoctor(directory).findings.filter((finding) => finding.rule === 'lockfile-out-of-date')).toEqual([]);
  });
});

describe('the npm a fix offers runs on the Node.js of the place (V4)', () => {
  const npmRepo = (files: Record<string, string>) => repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest, 'package-lock.json': LOCK, ...files });
  const warning = (directory: string, code: string) => plan(directory).warningDetails.find((item) => item.code === code);
  const finding = (directory: string, rule: string) => runDoctor(directory).findings.find((item) => item.rule === rule);

  it('moves to a Node.js that npm 11.16.0 runs on first, for Node.js 18', () => {
    const directory = npmRepo({ '.nvmrc': '18\n' });
    expect(warning(directory, 'scripts-not-enforceable')).toMatchObject({
      message: 'npm 8.6.0 to 10.8.2 (with Node.js 18 in .nvmrc) run every dependency install script and have no allow-list, so "deny" cannot be enforced there',
      fix: 'Move to a Node.js release that npm 11.16.0 runs on (^20.17.0 || >=22.9.0), then install npm 11.16.0 or later before packages are installed there (npm install -g npm@11.16.0), or move to a Node.js release that comes with it; npm 12 blocks dependency scripts by default',
    });
    // doctor says the same for a developer's version file, as it does for CI jobs and Dockerfiles.
    expect(finding(directory, 'manager-version-too-old')?.fix).toMatch(
      /^Move to a Node\.js release that npm 12\.0\.0 runs on \(\^22\.22\.2 \|\| \^24\.15\.0 \|\| >=26\.0\.0\), then install npm 12\.0\.0 where this Node\.js is used \(npm install -g npm@12\.0\.0\), or move to a Node\.js release that npm 11\.16\.0 runs on \(\^20\.17\.0 \|\| >=22\.9\.0\), then install npm 11\.16\.0 where this Node\.js is used/u,
    );
  });

  it('says which Node.js releases npm 11.16.0 runs on, for Node.js 20', () => {
    const directory = npmRepo({ '.nvmrc': '20\n' });
    expect(warning(directory, 'scripts-not-enforceable')?.fix).toBe(
      'Install npm 11.16.0 or later before packages are installed there (npm install -g npm@11.16.0; npm 11.16.0 runs on Node.js ^20.17.0 || >=22.9.0 only), or move to a Node.js release that comes with it; npm 12 blocks dependency scripts by default',
    );
    expect(finding(directory, 'manager-version-too-old')?.fix).toContain(
      'or install npm 11.16.0 where this Node.js is used (npm install -g npm@11.16.0; npm 11.16.0 runs on Node.js ^20.17.0 || >=22.9.0 only) and add strict-allow-scripts=true to .npmrc by hand',
    );
  });

  it('checks the Node.js of the job for npm install -g npm@X there, also for strict-allow-scripts', () => {
    const directory = npmRepo({ '.github/workflows/ci.yml': workflow(`${setupNode('20')}      - run: npm install -g npm@11 && npm install\n`) });
    expect(warning(directory, 'scripts-not-enforceable')?.fix).toBe(
      'Install npm 11.16.0 or later before packages are installed there (npm install -g npm@11.16.0; npm 11.16.0 runs on Node.js ^20.17.0 || >=22.9.0 only), or move to a Node.js release that comes with it; npm 12 blocks dependency scripts by default',
    );
    expect(warning(directory, 'strict-allow-scripts-for-npm-in-use')?.fix).toMatch(
      /^Move every place listed here to a Node\.js release that npm 12\.0\.0 runs on \(\^22\.22\.2 \|\| \^24\.15\.0 \|\| >=26\.0\.0\) and make them run npm 12\.0\.0 or later \(npm install -g npm@12\.0\.0 before it installs packages; a pin in packageManager or devEngines does not change the npm they run\), and depcurfew apply leaves strict-allow-scripts out\./u,
    );
    // A pin alone has no Node.js of its own: the fix stays as it was.
    const pinned = npmRepo({ 'package.json': JSON.stringify({ ...JSON.parse(manifest), packageManager: 'npm@10.9.0' }) });
    expect(warning(pinned, 'scripts-not-enforceable')?.fix).toBe('Require npm 11.16.0 or later in packageManager in package.json (npm 12 blocks dependency scripts by default)');
  });
});

describe('the verb agrees with the list of npm places (V8)', () => {
  const ciRepo = (spec: string) =>
    repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest, 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow(`${setupNode('24')}      - run: npm install -g npm@${spec} && npm install\n`) });

  // npm@11.15 allows no npm 11.16 to 11.x, so apply writes no strict-allow-scripts for it.
  it.each([
    ['11', true],
    ['^11.10.0', true],
    ['11.15', false],
  ])('npm@%s is one place with one npm', (spec, strict) => {
    const directory = ciRepo(spec);
    const where = `npm@${spec} (installed in job test of .github/workflows/ci.yml, line 9)`;
    const warnings = plan(directory).warningDetails;
    expect(warnings.find((item) => item.code === 'scripts-not-enforceable')?.message).toBe(`${where} runs every dependency install script and has no allow-list, so "deny" cannot be enforced there`);
    expect(warnings.find((item) => item.code === 'strict-allow-scripts-for-npm-in-use')?.message?.includes(`, and ${where} runs dependency install scripts that allowScripts does not cover`) ?? false).toBe(strict);
    expect(runDoctor(directory).findings.find((item) => item.rule === 'lockfile-install-scripts')?.message).toBe(`core-js has install scripts and ${where} runs them, but depcurfew.json does not allow it`);
  });

  it('keeps the plural for a range of versions and for several places', () => {
    const directory = repository({ 'depcurfew.json': policy(DENY), 'package.json': manifest, 'package-lock.json': LOCK, '.nvmrc': '20\n' });
    expect(runDoctor(directory).findings.find((item) => item.rule === 'lockfile-install-scripts')?.message).toBe(
      'core-js has install scripts and npm 9.6.4 to 10.8.2 (with Node.js 20 in .nvmrc) run them, but depcurfew.json does not allow it',
    );
  });
});

describe('doctor without a valid policy (V10)', () => {
  const BROKEN = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n    schedule: { interval: weekly\n';
  const files = { 'package.json': manifest, 'package-lock.json': LOCK, '.github/dependabot.yml': BROKEN };
  const DEPENDABOT = {
    rule: 'unreadable-config',
    level: 'error',
    location: { file: '.github/dependabot.yml', line: 6, column: 1 },
    message: 'cannot parse .github/dependabot.yml: Flow map in block collection must be sufficiently indented and end with a } at line 6, column 1; depcurfew cannot check it',
    fix: 'Fix the syntax error, so that depcurfew can check the file',
  };

  it.each([
    ['an invalid policy', { 'depcurfew.json': '{ "cooldown": 5 }\n' }],
    ['no policy', {}],
  ])('reports a YAML error in .github/dependabot.yml with %s', (_name, policyFiles) => {
    const report = runDoctor(repository({ ...files, ...policyFiles }), { invalidPolicy: 'report' });
    expect(report.findings.filter((finding) => finding.rule === 'unreadable-config')).toEqual([DEPENDABOT]);
    expect(report.checked?.rules.find((result) => result.rule === 'unreadable-config')).toMatchObject({ result: 'problems', errors: 1 });
  });

  it('keeps what apply says about a file it cannot edit with a valid policy', () => {
    const report = runDoctor(repository({ ...files, 'depcurfew.json': policy(DENY) }));
    expect(report.findings.filter((finding) => finding.rule === 'unreadable-config').map((finding) => finding.message)).toEqual([
      'depcurfew apply cannot edit .github/dependabot.yml for Dependabot (Flow map in block collection must be sufficiently indented and end with a } at line 6, column 1), so it cannot be checked against depcurfew.json',
    ]);
  });

  it.each([
    ['.yarnrc.yml', { 'package.json': JSON.stringify({ packageManager: 'yarn@4.9.0' }), 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'npmMinimalAgeGate: [\n' }],
    ['renovate.json', { 'package.json': manifest, 'package-lock.json': LOCK, 'renovate.json': '{ "extends": [\n' }],
    ['bunfig.toml', { 'package.json': manifest, 'bun.lock': '{"lockfileVersion":1}', 'bunfig.toml': '[install\n' }],
  ])('reports %s that does not parse, with a valid policy or none, also where apply edits nothing', (file, repo) => {
    for (const extra of [{}, { 'depcurfew.json': policy(DENY) }]) {
      const report = runDoctor(repository({ ...repo, ...extra }));
      expect(report.findings.filter((finding) => finding.rule === 'unreadable-config').map((finding) => finding.location.file)).toEqual([file]);
    }
  });

  it('says that a skipped check needs a valid depcurfew.json when it is invalid', () => {
    const invalid = runDoctor(repository({ ...files, 'depcurfew.json': '{ "cooldown": 5 }\n' }), { invalidPolicy: 'report' });
    const text = renderText(invalid, RULES);
    expect(text).toContain('skipped         Configuration files match what depcurfew apply writes for depcurfew.json (needs a valid depcurfew.json) [config-drift]');
    expect(text).not.toContain('(needs depcurfew.json)');
    expect(jobSummary(invalid, RULES, '', 1 << 20)).toContain('| skipped (needs a valid `depcurfew.json`) | Configuration files match what depcurfew apply writes for depcurfew.json | `config-drift` |');
    const missing = runDoctor(repository(files));
    expect(renderText(missing, RULES)).toContain('(needs depcurfew.json) [config-drift]');
    expect(jobSummary(missing, RULES, '', 1 << 20)).toContain('| skipped (needs `depcurfew.json`) |');
  });
});
