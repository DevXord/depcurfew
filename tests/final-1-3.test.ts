// Fixes after the final pre-release tests of 1.3.0 (decision D-116): stale uv.lock and pdm.lock, Renovate rules that
// shorten the delay, unreadable bot files, notices with a level, code and fix, positions in locations, --user details,
// Yarn's enableScripts, the Action's API URL, an empty doctor section, the tools directory of the README and Poetry's
// [installer] table.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import type { CheckDependencies } from '../src/cli/check.ts';
import { parseToml } from '../src/detect/toml.ts';
import { parseSpan, parseTimestamp, pdmHash, pythonJson, sameSpan } from '../src/doctor/locked-settings.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';
import { run } from '../src/cli/run.ts';
import type { UserEnvironment } from '../src/user/locate.ts';
import { windows } from './support/platform.ts';
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
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-final-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

async function exec(argv: string[], environment?: UserEnvironment): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-01T12:00:00Z'),
    stdin: () => Promise.resolve(''),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

const HOME_VARIABLE = windows ? 'USERPROFILE' : 'HOME';

const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, targets: 'auto' };
const policy = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ ...POLICY, ...extra }, null, 2)}\n`;

describe('Yarn enableScripts: true (T17)', () => {
  it('is set to false with the allow-all-replaced warning that pnpm and Deno give', () => {
    const root = repository({
      'depcurfew.json': policy(),
      'package.json': `${JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'yarn@4.10.3' }, null, 2)}\n`,
      'yarn.lock': '__metadata:\n  version: 8\n',
      '.yarnrc.yml': 'nodeLinker: node-modules\nenableScripts: true\n',
    });
    const report = applyProject(root);
    expect(report.warningDetails.filter((warning) => warning.code === 'allow-all-replaced')).toEqual([
      {
        code: 'allow-all-replaced',
        tool: 'yarn',
        location: { file: '.yarnrc.yml', line: 2 },
        message: 'Yarn (Berry): enableScripts: true in .yarnrc.yml (line 2) allowed every install script; set to false because the policy denies install scripts',
        fix: 'Add the packages whose install scripts must run to installScripts.allow in depcurfew.json, then run depcurfew apply again',
      },
    ]);
    expect(readFileSync(join(root, '.yarnrc.yml'), 'utf8')).toContain('enableScripts: false');
    // Once it is false, nothing is replaced again.
    expect(applyProject(root).warningDetails.filter((warning) => warning.code === 'allow-all-replaced')).toEqual([]);
  });
});

describe('apply --user without a home directory (T14)', () => {
  it('reports home-missing, not policy-missing with a fix that init --user then refuses', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const home = join(machine.root, 'nonexistent');
    const environment: UserEnvironment = { ...machine, home };
    const text = await exec(['apply', '--user'], environment);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(
      `error: the home directory ${home} does not exist, so depcurfew apply --user has nowhere to write the user configuration (home-missing)\n  fix: Set ${HOME_VARIABLE} to an existing directory, or run depcurfew apply --user as a user who has a home directory\n`,
    );
    const json = JSON.parse((await exec(['apply', '--user', '--json'], environment)).stdout) as { errors: { code: string }[] };
    expect(json.errors.map((error) => error.code)).toEqual(['home-missing']);
  });

  it('says that a relative home directory has to be an absolute path', async () => {
    const machine = fakeMachine({}, temporary);
    const environment: UserEnvironment = { ...machine, home: 'relhome' };
    for (const command of ['apply', 'init', 'doctor'] as const) {
      const result = await exec([command, '--user'], environment);
      expect(result.code, command).toBe(1);
      expect(result.stdout + result.stderr, command).toContain(`fix: Set ${HOME_VARIABLE} to the absolute path of an existing directory, or run depcurfew ${command} --user as a user who has a home directory`);
    }
  });
});

describe('doctor --user and Yarn Classic (T15)', () => {
  it('names Yarn 1.x Yarn Classic in what was checked, as apply --user does', async () => {
    const machine = fakeMachine({ npm: { yarn: '1.22.22' } }, temporary);
    const document = JSON.parse((await exec(['doctor', '--user', '--json'], machine)).stdout) as { checked: { tools: { id: string; name: string; version?: string }[] } };
    expect(document.checked.tools.find((tool) => tool.id === 'yarn')).toMatchObject({ name: 'Yarn Classic', version: '1.22.22' });
    const text = await exec(['doctor', '--user'], machine);
    expect(text.stdout).toContain('Yarn Classic 1.22.22 (PATH)');
    expect(text.stdout).not.toContain('Yarn (Berry) 1.22.22');
    const berry = fakeMachine({ npm: { yarn: '4.10.3' } }, temporary);
    expect((await exec(['doctor', '--user'], berry)).stdout).toContain('Yarn (Berry) 4.10.3 (PATH)');
  });
});

describe('apply and a Renovate packageRules entry that shortens the delay (T7)', () => {
  const files = (rules: unknown[]) => ({
    'depcurfew.json': policy({ targets: ['npm', 'renovate'] }),
    'package.json': `${JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'npm@12.2.1' }, null, 2)}\n`,
    'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n',
    'renovate.json': `${JSON.stringify({ extends: ['config:recommended'], packageRules: rules }, null, 2)}\n`,
  });

  it('warns with the place and what to do, keeps the entry, and agrees with doctor', async () => {
    const root = repository(files([{ matchUpdateTypes: ['patch'], minimumReleaseAge: '1 hour' }]));
    const report = applyProject(root);
    expect(report.warningDetails.filter((warning) => warning.code === 'bot-rule-shortens-delay')).toEqual([
      {
        code: 'bot-rule-shortens-delay',
        tool: 'renovate',
        location: { file: 'renovate.json', line: 6 },
        message:
          'Renovate: packageRules[0] in renovate.json (line 6) sets minimumReleaseAge: "1 hour" for patch updates of npm packages, shorter than the 3 days depcurfew apply writes for Renovate; Renovate uses the rule, and depcurfew apply does not change entries it did not write',
        fix: 'Make minimumReleaseAge in packageRules[0] of renovate.json at least 3 days, or limit the rule to the packages that need a shorter delay',
      },
    ]);
    // The entry stays as it was.
    expect(JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')).packageRules[0]).toEqual({ matchUpdateTypes: ['patch'], minimumReleaseAge: '1 hour' });
    // doctor says the same about the same entry.
    const doctor = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { findings: { rule: string; location: { file: string; line?: number } }[] };
    expect(doctor.findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch').map((finding) => finding.location)).toEqual([{ file: 'renovate.json', line: 6 }]);
    // The second run warns the same way and changes nothing.
    const again = applyProject(root);
    expect(again.changes).toEqual([]);
    expect(again.warningDetails.map((warning) => warning.code)).toContain('bot-rule-shortens-delay');
  });

  it('says nothing about a rule for some packages only, or one that waits at least as long', () => {
    const report = applyProject(
      repository(
        files([
          { matchPackageNames: ['@acme/*'], minimumReleaseAge: '1 hour' },
          { matchUpdateTypes: ['major'], minimumReleaseAge: '14 days' },
        ]),
      ),
    );
    expect(report.warningDetails.filter((warning) => warning.code === 'bot-rule-shortens-delay')).toEqual([]);
  });
});

describe('positions in locations (T11)', () => {
  it('puts the line and column of a YAML syntax error into the location, so that SARIF points there', async () => {
    const root = repository({
      'package.json': `${JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@10.28.0' }, null, 2)}\n`,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'packages:\n  - a\ncatalog:\n  react: ^19.0.0\n  react: ^18.0.0\n',
    });
    const json = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { findings: { rule: string; location: object }[] };
    const finding = json.findings.find((entry) => entry.rule === 'unreadable-config');
    expect(finding?.location).toEqual({ file: 'pnpm-workspace.yaml', line: 5, column: 3 });
    const sarif = JSON.parse((await exec(['doctor', '--sarif', root])).stdout) as { runs: { results: { ruleId: string; locations: { physicalLocation: { region: object } }[] }[] }[] };
    const result = sarif.runs[0]?.results.find((entry) => entry.ruleId === 'unreadable-config');
    expect(result?.locations[0]?.physicalLocation.region).toEqual({ startLine: 5, startColumn: 3, endLine: 5, endColumn: 17 });
  });

  it('gives a schema problem of depcurfew.json the line of the field it names', async () => {
    const text = '{\n  "version": 1,\n  "cooldown": {\n    "minimum": "3 days"\n  }\n}\n';
    const root = repository({ 'depcurfew.json': text, 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n' });
    const doctor = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { findings: { rule: string; location: object }[] };
    expect(doctor.findings.find((entry) => entry.rule === 'invalid-policy')?.location).toEqual({ file: 'depcurfew.json', line: 4 });
    const apply = JSON.parse((await exec(['apply', '--json', root])).stdout) as { errors: { code: string; location: object }[] };
    expect(apply.errors).toMatchObject([{ code: 'policy-invalid', location: { file: 'depcurfew.json', line: 4 } }]);
    // A problem of the whole file has no line of its own; a JSON syntax error has the one the parser names.
    const broken = repository({ 'depcurfew.json': '{\n  "version": 1,\n  "cooldown": { "minimum": "3d" \n}\n', 'package.json': '{ "name": "app" }\n' });
    const syntax = JSON.parse((await exec(['doctor', '--json', broken])).stdout) as { findings: { rule: string; location: { line?: number } }[] };
    expect(syntax.findings.find((entry) => entry.rule === 'invalid-policy')?.location.line).toBe(5);
  });
});

describe('doctor --user and a user file that does not match (T11)', () => {
  it('names the line and what should be there, as config-drift does in a project', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    expect((await exec(['init', '--user'], machine)).code).toBe(0);
    expect((await exec(['apply', '--user'], machine)).code).toBe(0);
    const npmrc = join(machine.home, '.npmrc');
    writeFileSync(npmrc, readFileSync(npmrc, 'utf8').replace('min-release-age=3', 'min-release-age=1'));
    const json = JSON.parse((await exec(['doctor', '--user', '--json'], machine)).stdout) as { findings: { rule: string; location: object; message: string }[] };
    const drift = json.findings.filter((finding) => finding.rule === 'user-config-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.location).toEqual({ file: '~/.npmrc', line: 2 });
    expect(drift[0]?.message).toMatch(/^~\/\.npmrc does not match the user policy \(.+\): `min-release-age=1` should be `min-release-age=3`$/u);
  });
});

describe('notices follow the message contract (T10)', () => {
  const pnpm = () =>
    repository({
      'depcurfew.json': policy({ sources: { git: 'deny' } }),
      'package.json': `${JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@10.28.0' }, null, 2)}\n`,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'minimumReleaseAge: 10\n',
    });

  it('have a level, a code, a location and a fix in JSON, next to message and file', async () => {
    const json = JSON.parse((await exec(['doctor', '--json', pnpm()])).stdout) as { notices: unknown[]; summary: { note: number } };
    expect(json.notices).toContainEqual({
      level: 'note',
      code: 'lockfile-install-scripts',
      location: { file: 'pnpm-lock.yaml' },
      message: 'lockfile-install-scripts could not check pnpm-lock.yaml: pnpm does not record install scripts in it',
      file: 'pnpm-lock.yaml',
    });
    // summary counts findings, as before.
    expect(json.summary.note).toBe(0);
  });

  it('carry the level word and the code in the text, and count in the line of counts', async () => {
    const text = (await exec(['doctor', pnpm()])).stdout;
    expect(text).toMatch(/^1 error, 0 warnings, 1 note\n/u);
    expect(text).toContain('\nNotes:\n  note lockfile-install-scripts could not check pnpm-lock.yaml: pnpm does not record install scripts in it (lockfile-install-scripts)\n');
  });

  it('are notifications with the code and the fix in SARIF', async () => {
    const root = repository({ 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n', 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n' });
    const sarif = JSON.parse((await exec(['doctor', '--sarif', root])).stdout) as { runs: { invocations: { toolExecutionNotifications: unknown[] }[] }[] };
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications).toContainEqual({
      level: 'note',
      message: { text: 'no depcurfew.json: only the rules that do not need a policy ran. Fix: Run depcurfew init to write depcurfew.json, so that the rules that compare the repository with it run too' },
      descriptor: { id: 'policy-missing' },
    });
  });
});

describe('depcurfew-outdated and the tools directory of the README (T20)', () => {
  it('reads the copy installed in .claude/depcurfew, and takes the newest copy of the repository', async () => {
    const root = repository({
      'package.json': '{ "name": "app", "devDependencies": { "depcurfew": "1.0.0" } }\n',
      'node_modules/depcurfew/package.json': '{ "name": "depcurfew", "version": "1.0.0" }\n',
      '.claude/depcurfew/package.json': '{ "private": true, "devDependencies": { "depcurfew": "99.1.0" } }\n',
      '.claude/depcurfew/node_modules/depcurfew/package.json': '{\n  "name": "depcurfew",\n  "version": "99.1.0"\n}\n',
    });
    const json = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { findings: { rule: string; location: object; message: string; fix?: string }[]; checked: { files: string[] } };
    expect(json.findings.filter((finding) => finding.rule === 'depcurfew-outdated')).toEqual([
      {
        rule: 'depcurfew-outdated',
        level: 'warning',
        location: { file: '.claude/depcurfew/node_modules/depcurfew/package.json', line: 3 },
        message: 'depcurfew 99.1.0 is installed in .claude/depcurfew (.claude/depcurfew/node_modules/depcurfew/package.json), but the depcurfew running this check is older, so it may not know settings that version writes or checks',
        fix: 'Run that copy (node .claude/depcurfew/node_modules/depcurfew/dist/cli.js doctor), or update the depcurfew you run to 99.1.0 or later',
      },
    ]);
    expect(json.checked.files).toContain('.claude/depcurfew/node_modules/depcurfew/package.json');
  });
});

describe('Poetry: the [installer] table apply created (T20)', () => {
  const poetry = (toml: string) =>
    repository({
      'depcurfew.json': policy(),
      'pyproject.toml': '[project]\nname = "app"\nversion = "0.1.0"\n\n[tool.poetry]\npackage-mode = false\n',
      'poetry.lock': '# This file is automatically @generated by Poetry 2.4.3 and should not be changed by hand.\n\n[metadata]\nlock-version = "2.1"\n',
      'poetry.toml': toml,
    });
  // Poetry is no longer managed at all: no delay and no install-script rules.
  const without = (root: string) => writeFileSync(join(root, 'depcurfew.json'), policy({ installScripts: undefined, cooldown: undefined }));

  it('goes away with the block once the policy no longer needs it, so the file is as it was', () => {
    const original = '[virtualenvs]\nin-project = true\n\n[solver]\n# one day is enough\nmin-release-age = 1\n';
    const root = poetry(original);
    applyProject(root);
    expect(readFileSync(join(root, 'poetry.toml'), 'utf8')).toContain('\n[installer]\n# >>> depcurfew managed block [installer]');
    without(root);
    applyProject(root);
    expect(readFileSync(join(root, 'poetry.toml'), 'utf8')).toBe(original);
    // A second run changes nothing.
    expect(applyProject(root).changes).toEqual([]);
  });

  it('stays when the user wrote it, also when it is empty, and so does a table after it', () => {
    for (const original of ['[installer]\nparallel = true\n', '[installer]\n', '[installer]\n\n[virtualenvs]\nin-project = true\n']) {
      const root = poetry(original);
      applyProject(root);
      without(root);
      applyProject(root);
      expect(readFileSync(join(root, 'poetry.toml'), 'utf8'), original).toBe(original);
    }
  });
});

describe('a uv.lock or pdm.lock locked with other settings (T6)', () => {
  const FIXTURES = fileURLToPath(new URL('fixtures/doctor/lockfile-out-of-date/', import.meta.url));
  const pdm = knowledgeBase.find((tool) => tool.id === 'pdm');
  const uv = knowledgeBase.find((tool) => tool.id === 'uv');
  const toml = (path: string) => parseToml(readFileSync(join(FIXTURES, path), 'utf8'));

  it('computes the content_hash of pdm.lock as PDM does (the fixture hash comes from Python json and hashlib)', () => {
    if (pdm === undefined) throw new Error('no PDM');
    expect(pdmHash(pdm, toml('passes-pdm-same-hash/repo/pdm.lock'), toml('passes-pdm-same-hash/repo/pyproject.toml'))).toEqual({ matches: true, line: 10 });
    expect(pdmHash(pdm, toml('fires-pdm-resolution-changed/repo/pdm.lock'), toml('fires-pdm-resolution-changed/repo/pyproject.toml'))).toEqual({ matches: false, line: 9 });
    // Canonical lock inputs: PDM does not compare the hash, so depcurfew does not either.
    expect(pdmHash(pdm, toml('passes-pdm-lock-inputs/repo/pdm.lock'), toml('passes-pdm-lock-inputs/repo/pyproject.toml'))).toBeUndefined();
  });

  it('writes JSON as Python json.dumps with sort_keys, and gives up on what it cannot write the same way', () => {
    expect(pythonJson({ b: ['x', true], a: { 'ž': 'é\t"😀' } })).toBe('{"a": {"\\u017e": "\\u00e9\\t\\"\\ud83d\\ude00"}, "b": ["x", true]}');
    expect(pythonJson({ a: 1 })).toBeUndefined();
    expect(pythonJson({ a: 'x\r\ny' })).toBeUndefined();
  });

  it('compares spans unit by unit, as uv does', () => {
    if (uv === undefined) throw new Error('no uv');
    const syntax = (uv.extra?.['spanSyntax'] as { value: Parameters<typeof parseSpan>[1] }).value;
    const span = (text: string) => parseSpan(text, syntax);
    const same = (a: string, b: string) => {
      const left = span(a);
      const right = span(b);
      if (left === undefined || right === undefined) throw new Error(`${a} or ${b} not read`);
      return sameSpan(left, right);
    };
    expect(same('3 days', 'P3D')).toBe(true);
    expect(same('1 week', 'P1W')).toBe(true);
    expect(same('1w', 'P1W')).toBe(true);
    expect(same('36 hours', 'PT36H')).toBe(true);
    expect(same('2 weeks, 3 days', 'P2W3D')).toBe(true);
    expect(same('7 days', 'P1W')).toBe(false);
    expect(same('72h', 'P3D')).toBe(false);
    // Months and years are rejected by uv, a unit twice or out of order by jiff, and HH:MM:SS is not read here.
    for (const text of ['1 month', 'P1Y', '1 day 2 days', '1 hour 1 day', '01:00:00', '1.5 days', 'soon']) expect(span(text), text).toBeUndefined();
  });

  it('reads RFC 3339 timestamps, and no date without a time', () => {
    expect(parseTimestamp('2026-01-01T00:00:00Z')).toBe(1_767_225_600_000_000_000n);
    expect(parseTimestamp('2026-01-01T02:00:00+02:00')).toBe(1_767_225_600_000_000_000n);
    expect(parseTimestamp('2026-01-01T00:00:00.5Z')).toBe(1_767_225_600_500_000_000n);
    expect(parseTimestamp('2026-01-01')).toBeUndefined();
    expect(parseTimestamp('2026-02-30T00:00:00Z')).toBeUndefined();
  });

  it('reports the stale uv.lock of the final tests, and nothing once it is locked again', async () => {
    const lock = (span: string) =>
      `version = 1\nrevision = 3\nrequires-python = ">=3.12"\n\n[options]\nexclude-newer = "0001-01-01T00:00:00Z"\nexclude-newer-span = "${span}"\n\n[[package]]\nname = "uvc"\nversion = "0.1.0"\nsource = { virtual = "." }\n`;
    const root = repository({
      'depcurfew.json': policy({ cooldown: { minimum: '7d' } }),
      'pyproject.toml': '[project]\nname = "uvc"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n',
      'uv.lock': lock('P3D'),
    });
    applyProject(root);
    const text = (await exec(['doctor', root])).stdout;
    expect(text).toContain('uv.lock was locked with exclude-newer-span = "P3D", but exclude-newer in pyproject.toml');
    expect(text).toContain('is "1 week" now, so uv sync --locked and uv lock --check fail until uv lock runs again (lockfile-out-of-date)');
    writeFileSync(join(root, 'uv.lock'), lock('P1W'));
    const json = JSON.parse((await exec(['doctor', '--json', root])).stdout) as { findings: { rule: string }[]; checked: { rules: { rule: string; result: string }[] } };
    expect(json.findings.filter((finding) => finding.rule === 'lockfile-out-of-date')).toEqual([]);
    expect(json.checked.rules.find((rule) => rule.rule === 'lockfile-out-of-date')?.result).toBe('passed');
  });
});
