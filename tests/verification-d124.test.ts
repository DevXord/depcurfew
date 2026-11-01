// Fixes after the third verification of 1.3.0 (decision D-124): the line of a script-not-followed note in its location,
// YAML aliases that expand without end without a policy, a bot file that cannot be parsed, the place of an error in
// the Action, init --user and check, and the .npmrc of a workspace package, which npm does not read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runAction } from '../src/action.ts';
import type { FetchLike } from '../src/check/registry.ts';
import { mayTurnWorkspacesOff, npmLocalPrefix } from '../src/check/registry-settings.ts';
import type { CheckDependencies } from '../src/cli/check.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../src/cli/run.ts';
import { RULES, runDoctor } from '../src/doctor/index.ts';
import { lineReader, toSarif } from '../src/doctor/sarif.ts';
import type { UserEnvironment } from '../src/user/locate.ts';
import { recordedFetch } from './check/support.ts';
import { fakeMachine } from './support/user.ts';

const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d124-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d124-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function exec(argv: string[], options: { stdin?: string; projectDir?: string; environment?: UserEnvironment; fetch?: FetchLike } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: options.fetch ?? (() => Promise.reject(new Error('no network in tests'))),
    now: () => new Date('2026-10-29T12:00:00Z'),
    stdin: () => Promise.resolve(options.stdin ?? ''),
    home: () => HOME,
    projectDir: () => options.projectDir,
    ...(options.environment === undefined ? {} : { userEnvironment: () => options.environment as UserEnvironment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

const manifest = `${JSON.stringify({ name: 'app', version: '1.0.0', private: true }, null, 2)}\n`;
const LOCK = `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0' } } }, null, 2)}\n`;
const CD_FIX = 'Split the script into shorter run steps or RUN instructions, or check by hand where the installs after that point run and with which variables';

describe('the line of a script-not-followed note is in its location (N9)', () => {
  const steps = Array.from({ length: 300 }, () => '          cd a\n').join('');
  const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: |\n${steps}          npm install\n`;
  const files = { 'package.json': manifest, 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow, Dockerfile: 'FROM node:24\n\nRUN cd a && cd a && npm ci\n' };

  it('doctor --json, explain --json and SARIF point at the line the message names', async () => {
    const root = repository(files);
    const notice = runDoctor(root).notices.find((entry) => entry.code === 'script-not-followed');
    expect(notice).toEqual({
      level: 'note',
      code: 'script-not-followed',
      location: { file: '.github/workflows/ci.yml', line: 9 },
      message:
        'the run step of job test in .github/workflows/ci.yml (line 9) changes the directory more than 256 times, so depcurfew cannot tell which directory the installs after that run in and checks them with the settings of the repository root',
      file: '.github/workflows/ci.yml',
      fix: CD_FIX,
    });
    const json = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { notices: { code: string; location?: object }[] };
    expect(json.notices.find((entry) => entry.code === 'script-not-followed')?.location).toEqual({ file: '.github/workflows/ci.yml', line: 9 });
    const explained = JSON.parse((await exec(['explain', '--json', root])).stdout) as { project: { warnings: { code: string; location?: object }[] } };
    expect(explained.project.warnings.find((entry) => entry.code === 'script-not-followed')?.location).toEqual({ file: '.github/workflows/ci.yml', line: 9 });
    const sarif = toSarif(runDoctor(root), RULES, '1.3.0', lineReader(root)) as {
      runs: { invocations: { toolExecutionNotifications: { descriptor: { id: string }; locations?: { physicalLocation: { region: { startLine: number; endColumn: number } } }[] }[] }[] }[];
    };
    const notification = sarif.runs[0]?.invocations[0]?.toolExecutionNotifications.find((entry) => entry.descriptor.id === 'script-not-followed');
    expect(notification?.locations?.[0]?.physicalLocation.region).toMatchObject({ startLine: 9, endColumn: '      - run: |'.length + 1 });
  });

  it('keeps the line for a RUN instruction and for a project of the policy', () => {
    const dockerfile = `FROM node:24\n\nRUN ${Array.from({ length: 1025 }, (_, index) => `export V${index}=1`).join(' && ')} && npm ci\n`;
    const root = repository({ ...files, '.github/workflows/ci.yml': 'on: push\n', Dockerfile: dockerfile });
    expect(runDoctor(root).notices.find((entry) => entry.code === 'script-not-followed')?.location).toEqual({ file: 'Dockerfile', line: 3 });
    const listed = repository({
      'depcurfew.json': `${JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, projects: ['web'] })}\n`,
      'web/package.json': manifest,
      'web/package-lock.json': LOCK,
      'web/Dockerfile': dockerfile,
    });
    expect(runDoctor(listed).notices.find((entry) => entry.code === 'script-not-followed')?.location).toEqual({ file: 'web/Dockerfile', line: 3 });
  });
});

// The last list expands to 9^6 strings, which the yaml package refuses to build ("Excessive alias count").
const ALIAS_BOMB = [
  'version: 2',
  'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
  'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
  'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
  'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
  'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
  'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
  'updates:',
  '  - package-ecosystem: npm',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '',
].join('\n');

describe('YAML aliases that expand without end, without a valid policy (N11)', () => {
  const unreadable = (root: string) => runDoctor(root, { invalidPolicy: 'report' }).findings.filter((finding) => finding.rule === 'unreadable-config');

  it('is an error of unreadable-config with the limit apply and detection use, with or without depcurfew.json', () => {
    const files = { 'package.json': manifest, 'package-lock.json': LOCK, '.npmrc': 'min-release-age=3\n', '.github/dependabot.yml': ALIAS_BOMB };
    const expected = {
      rule: 'unreadable-config',
      level: 'error',
      location: { file: '.github/dependabot.yml' },
      message: 'cannot parse .github/dependabot.yml: Excessive alias count indicates a resource exhaustion attack; depcurfew cannot check it',
      fix: 'Fix the syntax error, so that depcurfew can check the file',
    };
    expect(unreadable(repository(files))).toEqual([expected]);
    expect(unreadable(repository({ ...files, 'depcurfew.json': '{ "version": 2 }\n' }))).toEqual([expected]);
    // With a valid policy the plan of apply says it, as before.
    const planned = unreadable(repository({ ...files, 'depcurfew.json': `${JSON.stringify({ version: 1, cooldown: { minimum: '3d' } })}\n` }));
    expect(planned.map((finding) => finding.message)).toEqual([
      'depcurfew apply cannot edit .github/dependabot.yml for Dependabot (Excessive alias count indicates a resource exhaustion attack), so it cannot be checked against depcurfew.json',
    ]);
  });

  it('gives bot-cooldown-mismatch a note instead of a delay depcurfew did not read', () => {
    const root = repository({ 'package.json': manifest, 'package-lock.json': LOCK, '.npmrc': 'min-release-age=3\n', '.github/dependabot.yml': ALIAS_BOMB });
    const report = runDoctor(root);
    expect(report.findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([
      {
        rule: 'bot-cooldown-mismatch',
        level: 'note',
        location: { file: '.github/dependabot.yml', line: 1 },
        message: 'Dependabot reads .github/dependabot.yml, which depcurfew cannot parse, so it cannot tell whether Dependabot waits as long as npm (3 days, min-release-age: 3 in .npmrc)',
        fix: 'Fix the syntax error in .github/dependabot.yml (unreadable-config says what it is), then run depcurfew doctor again',
      },
    ]);
  });
});

describe('a Renovate file that cannot be parsed (N12)', () => {
  const broken = '{\n  "extends": ["config:recommended"],\n  "minimumReleaseAge": "5 days",\n}\n}\n';

  it('is unreadable, and the bot check claims no default delay for it', () => {
    const root = repository({ 'package.json': manifest, 'package-lock.json': LOCK, '.npmrc': 'min-release-age=3\n', '.renovaterc': broken });
    const findings = runDoctor(root).findings;
    expect(findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([
      {
        rule: 'bot-cooldown-mismatch',
        level: 'note',
        location: { file: '.renovaterc', line: 1 },
        message: 'Renovate reads .renovaterc, which depcurfew cannot parse, so it cannot tell whether Renovate waits as long as npm (3 days, min-release-age: 3 in .npmrc)',
        fix: 'Fix the syntax error in .renovaterc (unreadable-config says what it is), then run depcurfew doctor again',
      },
    ]);
    expect(findings.filter((finding) => finding.rule === 'unreadable-config').map((finding) => finding.location)).toEqual([{ file: '.renovaterc', line: 5, column: 1 }]);
    expect(JSON.stringify(findings)).not.toContain('Renovate has no delay by default');
  });

  it('says so for a file depcurfew does not read too', () => {
    // Larger than depcurfew reads (1 MiB).
    const root = repository({ 'package.json': manifest, 'package-lock.json': LOCK, '.npmrc': 'min-release-age=3\n', 'renovate.json': `{ "minimumReleaseAge": "5 days" }${' '.repeat(1024 * 1024)}\n` });
    const findings = runDoctor(root).findings;
    expect(findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch').map((finding) => [finding.level, finding.message])).toEqual([
      ['note', 'Renovate reads renovate.json, which depcurfew cannot read, so it cannot tell whether Renovate waits as long as npm (3 days, min-release-age: 3 in .npmrc)'],
    ]);
    expect(findings.filter((finding) => finding.rule === 'unreadable-config').map((finding) => finding.location.file)).toEqual(['renovate.json']);
  });
});

describe('where an error is (N13)', () => {
  // installScripts.default at line 6 is the problem.
  const INVALID = '{\n  "version": 1,\n  "cooldown": {\n    "minimum": "3d"\n  },\n  "installScripts": { "default": "maybe" }\n}\n';

  it('the Action names the line of an invalid depcurfew.json, in the log and in the failure', () => {
    const root = repository({ 'depcurfew.json': INVALID, 'package.json': manifest });
    let log = '';
    const outputs = runAction({ GITHUB_WORKSPACE: root }, { log: (text) => (log += text), summary: () => undefined });
    expect(log).toMatch(/\ndepcurfew: error: depcurfew\.json \(line 6\) is invalid\n {2}installScripts\.default: must be one of "allow", "deny", got "maybe"\n {2}fix: Fix these problems in depcurfew\.json; /u);
    expect(outputs.failure).toMatch(/^depcurfew\.json \(line 6\) is invalid; installScripts\.default: /u);
    // A policy in a directory of the workspace is named by its path, in the fix too.
    const nested = repository({ 'app/depcurfew.json': INVALID, 'app/package.json': manifest });
    let nestedLog = '';
    runAction({ GITHUB_WORKSPACE: nested, INPUT_DIRECTORY: 'app' }, { log: (text) => (nestedLog += text), summary: () => undefined });
    expect(nestedLog).toContain('\ndepcurfew: error: app/depcurfew.json (line 6): depcurfew.json is invalid\n');
    expect(nestedLog).toContain('  fix: Fix these problems in app/depcurfew.json; ');
  });

  it('init --user, apply --user and doctor --user name the HOME variable when the home directory is not an absolute path', async () => {
    const machine = fakeMachine({}, temporary);
    const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    for (const home of ['', 'relhome']) {
      const environment: UserEnvironment = { ...machine, home };
      const init = JSON.parse((await exec(['init', '--user', '--json'], { environment })).stdout) as { errors: { code: string; location: object }[] };
      expect(init.errors, JSON.stringify(home)).toEqual([expect.objectContaining({ code: 'home-missing', location: { file: 'environment', variable } })]);
      const apply = JSON.parse((await exec(['apply', '--user', '--json'], { environment })).stdout) as { errors: { code: string; location: object }[] };
      expect(apply.errors, JSON.stringify(home)).toEqual([expect.objectContaining({ code: 'home-missing', location: { file: 'environment', variable } })]);
      const doctor = JSON.parse((await exec(['doctor', '--user', '--json'], { environment })).stdout) as { findings: { rule: string; location: object }[] };
      expect(doctor.findings.find((finding) => finding.rule === 'user-config-unreadable')?.location, JSON.stringify(home)).toEqual({ file: 'environment', variable });
    }
    // A home directory that does not exist is still named by its path.
    const missing = join(machine.root, 'nowhere');
    const init = JSON.parse((await exec(['init', '--user', '--json'], { environment: { ...machine, home: missing } })).stdout) as { errors: { location: object }[] };
    expect(init.errors[0]?.location).toEqual({ file: missing });
  });

  it('check run in a directory below the policy names the policy by the same path in the message and the fix', async () => {
    const root = repository({ 'depcurfew.json': INVALID, 'package.json': manifest, 'sub/notes.txt': '' });
    mkdirSync(join(root, '.git'));
    const text = await exec(['check', '--dir', join(root, 'sub'), 'pypi:requests']);
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stderr).toContain('error: ../depcurfew.json (line 6): depcurfew.json is invalid (policy-invalid)\n');
    expect(text.stderr).toContain('  fix: Fix these problems in ../depcurfew.json; an editor that reads its $schema shows them as you type\n');
    const json = JSON.parse((await exec(['check', '--json', '--dir', join(root, 'sub'), 'pypi:requests'])).stdout) as { errors: { location: object; fix: string }[] };
    expect(json.errors[0]).toMatchObject({ location: { file: '../depcurfew.json', line: 6 }, fix: 'Fix these problems in ../depcurfew.json; an editor that reads its $schema shows them as you type' });
  });
});

describe('the .npmrc of a workspace package, which npm does not read (N15)', () => {
  const POLICY = `${JSON.stringify({ version: 1, cooldown: { minimum: '3d' } })}\n`;
  /** A repository whose root lists packages/app as a workspace, which has an .npmrc of its own with another registry. */
  const monorepo = (workspaces: unknown, root: Record<string, unknown> = {}) => {
    const directory = repository({
      'depcurfew.json': POLICY,
      'package.json': `${JSON.stringify({ name: 'root', private: true, workspaces, ...root })}\n`,
      'packages/app/package.json': '{ "name": "app" }\n',
      'packages/app/.npmrc': 'registry=https://evil.example/\n',
    });
    mkdirSync(join(directory, '.git'));
    return directory;
  };
  const event = (command: string, cwd: string) => JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const hook = async (command: string, cwd: string, projectDir: string) => {
    const result = await exec(['check', '--hook', 'claude-code'], { stdin: event(command, cwd), projectDir, fetch: recordedFetch });
    expect(result.code).toBe(EXIT_OK);
    return result.stdout === '' ? {} : (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  };
  const checked = async (directory: string) => exec(['check', '--json', '--dir', directory, 'lodash'], { fetch: recordedFetch });

  it('is not reported when depcurfew matches the workspace exactly as npm does', async () => {
    for (const workspaces of [['packages/*'], ['packages/**'], { packages: ['./packages/app'] }, ['packages/*', '!packages/legacy'], ['/packages/a*']]) {
      const root = monorepo(workspaces);
      const app = join(root, 'packages', 'app');
      if (process.platform === 'win32') {
        // On Windows depcurfew never claims npm's exact match (path case and separators), so the .npmrc still counts.
        expect(npmLocalPrefix(app), JSON.stringify(workspaces)).toMatchObject({ workspace: expect.stringMatching(/app$/u) });
        expect(npmLocalPrefix(app).exact, JSON.stringify(workspaces)).not.toBe(true);
        expect((await hook('npm install lodash', app, root)).permissionDecisionReason, JSON.stringify(workspaces)).toContain('- lodash: the install would use the registry https://evil.example/ from packages/app/.npmrc (line 1)');
        continue;
      }
      expect(npmLocalPrefix(app), JSON.stringify(workspaces)).toMatchObject({ workspace: expect.stringMatching(/app$/u), exact: true });
      const result = await checked(app);
      expect(result.stdout, JSON.stringify(workspaces)).not.toContain('evil.example');
      expect(result.code, JSON.stringify(workspaces)).toBe(EXIT_OK);
      expect(await hook('npm install lodash', app, root), JSON.stringify(workspaces)).toEqual({});
      expect(await hook('npx --yes lodash', app, root), JSON.stringify(workspaces)).toEqual({});
    }
  });

  it('is reported when the command line may turn workspaces off, for pnpm and Bun, and when the match is not certain', async () => {
    const root = monorepo(['packages/*']);
    const app = join(root, 'packages', 'app');
    // --workspaces=false on npm's command line keeps the workspace as npm's local prefix.
    for (const command of ['npm install --no-workspaces lodash', 'npm i --workspaces=false lodash', 'npm --no-ws i lodash', 'npm i --workspaces false lodash', 'npm i --NO-works lodash', "alias n='npm --no-workspaces'; n i lodash"]) {
      expect((await hook(command, app, root)).permissionDecisionReason, command).toContain('- lodash: the install would use the registry https://evil.example/ from packages/app/.npmrc (line 1)');
    }
    // Words that cannot set workspaces leave it out; --workspace (-w) may abbreviate it in npm 11, so it counts.
    expect(['npm i -D --save-exact lodash', 'npm i lodash --registry=https://registry.npmjs.org/', 'npm i -- --x'].map(mayTurnWorkspacesOff)).toEqual([false, false, false]);
    expect(['npm i -w app lodash', 'npm i ---Workspaces lodash', 'npm i -ws=false lodash', 'npm i --workspaces-update=false lodash'].map(mayTurnWorkspacesOff)).toEqual([true, true, true, true]);
    // pnpm and Bun read .npmrc by rules of their own.
    expect((await hook('pnpm add lodash', app, root)).permissionDecision).toBe('ask');
    expect((await hook('bun add lodash', app, root)).permissionDecision).toBe('ask');
    // Patterns, names and package.json files that depcurfew does not read exactly as npm does.
    const uncertain: [unknown, Record<string, unknown>][] = [
      [['packages/*', '!packages/legacy-*'], {}],
      [['packages/*/'], {}],
      [['packages/./app'], {}],
      [['packages/*'], { bin: [1] }],
      [['packages/*'], { directories: { bin: 5 } }],
      [['packages/*', 3], {}],
    ];
    for (const [workspaces, extra] of uncertain) {
      const directory = monorepo(workspaces, extra);
      const own = join(directory, 'packages', 'app');
      const label = JSON.stringify([workspaces, extra]);
      expect(npmLocalPrefix(own).exact, label).toBeUndefined();
      expect((await checked(own)).stdout, label).toContain('the install would use the registry https://evil.example/ from .npmrc (line 1)');
      expect((await hook('npm install lodash', own, directory)).permissionDecision, label).toBe('ask');
    }
  });

  it('is reported for a workspace in a directory whose name starts with a dot, which npm matches only by name', async () => {
    const directory = repository({
      'depcurfew.json': POLICY,
      'package.json': `${JSON.stringify({ name: 'root', private: true, workspaces: ['.tools/*'] })}\n`,
      '.tools/app/package.json': '{ "name": "app" }\n',
      '.tools/app/.npmrc': 'registry=https://evil.example/\n',
    });
    mkdirSync(join(directory, '.git'));
    const own = join(directory, '.tools', 'app');
    expect(npmLocalPrefix(own)).toMatchObject({ workspace: expect.stringMatching(/app$/u) });
    expect(npmLocalPrefix(own).exact).toBeUndefined();
    expect((await hook('npm install lodash', own, directory)).permissionDecision).toBe('ask');
  });
});
