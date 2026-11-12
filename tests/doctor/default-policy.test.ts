// depcurfew doctor without depcurfew.json (decision D-149): the rules that need a policy compare the repository with
// the policy depcurfew init would write, and what they find is a note in a block of its own, with "policy": "default"
// in JSON and SARIF, that never fails doctor. doctor --user, an invalid depcurfew.json, the library default and the
// GitHub Action stay as they were.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runAction } from '../../src/action.ts';
import { initialResolvedPolicy } from '../../src/cli/init-policy.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { runDoctor, type DoctorReport } from '../../src/doctor/index.ts';
import { settingChanges } from '../../src/doctor/setting-changes.ts';
import { JsonSchemaValidator } from '../support/json-schema.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/doctor-default/', import.meta.url));
const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const repo = (name: string) => join(FIXTURES, name, 'repo');
const sarifSchema = new JsonSchemaValidator(JSON.parse(readFileSync(new URL('../fixtures/sarif/sarif-schema-2.1.0.json', import.meta.url), 'utf8')) as Record<string, unknown>);

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/** A repository with these files in a new temporary directory, removed after the tests. */
function scratch(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-default-policy-'));
  temporary.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
}

const LOCKFILE = `${JSON.stringify({
  name: 'app',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'app', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }, 'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' } },
})}\n`;

type Json = DoctorReport & { summary: Record<string, number>; failOn: string; failOnFrom: string };

async function json(directory: string, ...options: string[]): Promise<{ code: number; report: Json }> {
  const result = await exec('doctor', '--json', ...options, directory);
  expect(result.stderr).toBe('');
  return { code: result.code, report: JSON.parse(result.stdout) as Json };
}

/** The text of doctor up to the list of what was checked. */
function head(text: string): string {
  return text.slice(0, text.indexOf('What was checked:'));
}

const FIX = 'Run depcurfew init to write depcurfew.json with the default policy, then depcurfew apply (depcurfew apply --dry-run shows the changes first)';
const NOTICE = {
  level: 'note',
  code: 'policy-missing',
  message: 'no depcurfew.json: the rules that need a policy compared the repository with the default policy of depcurfew init; what they find is a note and does not fail doctor',
  fix: 'Run depcurfew init to write depcurfew.json with this policy, then depcurfew apply (depcurfew apply --dry-run shows the changes first)',
};

// The tests see no local OSV.dev data (tests/setup/no-user-cache.ts), so known-malicious says how to get it (decision D-150).
const OSV_NOTICE = {
  level: 'note',
  code: 'known-malicious',
  message: 'known-malicious did not check the locked package versions: there is no local OSV.dev data, and --osv was not given',
  fix: 'Run depcurfew osv update to download the OSV.dev data of known malicious packages (it requests only the public export files and sends no package names), then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev',
  location: expect.anything(),
};

describe('doctor without depcurfew.json', () => {
  it('shows a plain npm repository what the default policy would change, in a block of notes, and exits with 0', async () => {
    const result = await exec('doctor', repo('npm-plain'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    expect(head(result.stdout)).toBe(readFileSync(join(FIXTURES, 'npm-plain', 'expected.txt'), 'utf8'));
    // The checks that need a policy ran against the default policy instead of being skipped.
    expect(result.stdout).toMatch(/^ {4}1 note {10}Configuration files match what depcurfew apply writes for depcurfew\.json \(compared with the default policy\) \[config-drift\]$/mu);
    expect(result.stdout).toMatch(/^ {4}passed {10}The lockfile installs no package from a source depcurfew\.json denies \(compared with the default policy\) \[lockfile-forbidden-source\]$/mu);
    expect(result.stdout).toMatch(/^ {4}skipped {9}depcurfew\.json follows the schema and can be read \(needs depcurfew\.json\) \[invalid-policy\]$/mu);
    expect(result.stdout).not.toContain('(needs depcurfew.json) [config-drift]');
    // 23 checks since pnpm-config-unverifiable (decision D-164), ci-weakens-policy (decision D-166) and
    // lockfile-tampered (decision D-204), which do not concern an npm project without CI.
    expect(result.stdout).toMatch(/^ {2}23 checks: 6 passed, 2 found problems, 14 not applicable, 1 skipped$/mu);
  });

  it('--json marks every such finding and says which policy the rules that need one used', async () => {
    const { code, report } = await json(repo('npm-plain'));
    expect(code).toBe(EXIT_OK);
    expect(report).toMatchObject({ schemaVersion: 1, policy: 'missing', policySource: 'default', summary: { error: 0, warning: 0, note: 2 }, failOn: 'error', failOnFrom: 'default', strict: false });
    expect(report.findings).toEqual(JSON.parse(readFileSync(join(FIXTURES, 'npm-plain', 'expected.json'), 'utf8')));
    expect(report.notices).toEqual([NOTICE, expect.objectContaining(OSV_NOTICE)]);
    const results = report.checked?.rules ?? [];
    expect(results.find((entry) => entry.rule === 'config-drift')).toEqual({
      rule: 'config-drift',
      check: 'Configuration files match what depcurfew apply writes for depcurfew.json',
      result: 'problems',
      errors: 0,
      warnings: 0,
      notes: 1,
      policy: 'default',
    });
    expect(results.find((entry) => entry.rule === 'lockfile-forbidden-source')).toMatchObject({ result: 'passed', policy: 'default' });
    // The rules that need no policy ran as before, without the field.
    expect(results.find((entry) => entry.rule === 'invalid-policy')).toEqual(expect.not.objectContaining({ policy: expect.anything() }));
    expect(results.find((entry) => entry.rule === 'broad-exclusion')).toEqual(expect.not.objectContaining({ policy: expect.anything() }));
  });

  it('--sarif gives notes with the same message and the property policy', async () => {
    const result = await exec('doctor', '--sarif', repo('npm-plain'));
    expect(result.code).toBe(EXIT_OK);
    const sarif = JSON.parse(result.stdout) as { runs: { results: { ruleId: string; level: string; message: { text: string }; properties?: Record<string, unknown> }[] }[] };
    expect(sarifSchema.validate(sarif)).toEqual([]);
    const { report } = await json(repo('npm-plain'));
    expect(sarif.runs[0]?.results).toEqual(
      report.findings.map((finding) => expect.objectContaining({ ruleId: finding.rule, level: 'note', message: { text: `${finding.message}. Fix: ${finding.fix ?? ''}` }, properties: { policy: 'default' } })),
    );
  });

  it('never fails doctor, also with --fail-on warning or --strict', async () => {
    expect((await exec('doctor', '--fail-on', 'warning', repo('npm-plain'))).code).toBe(EXIT_OK);
    expect((await exec('doctor', '--strict', repo('npm-plain'))).code).toBe(EXIT_OK);
    // doctor.failOn "warning" of the default policy is not the repository's: warnings of the other rules fail on errors only.
    const warning = await json(join(DOCTOR, 'bot-cooldown-mismatch', 'fires-security-recheck', 'repo'));
    expect(warning.code).toBe(EXIT_OK);
    expect(warning.report).toMatchObject({ policySource: 'default', failOn: 'error', failOnFrom: 'default' });
    expect(warning.report.findings.filter((finding) => finding.policy === undefined).map((finding) => finding.level)).toEqual(['warning']);
    // An error of a rule that needs no policy still fails, as before.
    expect((await exec('doctor', join(DOCTOR, 'bot-cooldown-mismatch', 'fires-dependabot-shorter', 'repo'))).code).toBe(EXIT_FAILURE);
  });

  it('pnpm 11: its default delay of 1 day is shorter than 3 days', async () => {
    const { code, report } = await json(repo('pnpm11'));
    expect(code).toBe(EXIT_OK);
    expect(report.findings).toEqual([
      {
        rule: 'config-drift',
        level: 'note',
        location: { file: 'pnpm-workspace.yaml' },
        message:
          'pnpm-workspace.yaml does not exist; pnpm waits only 1 day before installing a new version (the default of pnpm 11.2.0); with the default policy of depcurfew init, depcurfew apply would create it and set `minimumReleaseAge: 4320`, `minimumReleaseAgeStrict: true` and `blockExoticSubdeps: true`',
        fix: FIX,
        policy: 'default',
      },
    ]);
    // What a rule could not check against the default policy is a note too.
    expect(report.notices).toEqual([
      NOTICE,
      expect.objectContaining(OSV_NOTICE),
      expect.objectContaining({ code: 'lockfile-install-scripts', message: 'lockfile-install-scripts could not check pnpm-lock.yaml: pnpm does not record install scripts in it' }),
    ]);
  });

  it('Dependabot without a cooldown: one note for the file, not one per entry', async () => {
    const { report } = await json(repo('dependabot'));
    expect(report.findings.map((finding) => [finding.location, finding.message])).toEqual([
      [{ file: '.github/dependabot.yml', line: 7 }, '.github/dependabot.yml: with the default policy of depcurfew init, depcurfew apply would set `updates[].cooldown.default-days: 3`'],
      [
        { file: '.npmrc' },
        '.npmrc does not exist; npm installs new versions without a release-age delay; with the default policy of depcurfew init, depcurfew apply would create it and set `min-release-age=3`, `strict-allow-scripts=true`, `allow-git=none`, `allow-remote=none`, `allow-file=all` and `allow-directory=all`',
      ],
    ]);
    expect(new Set(report.findings.map((finding) => `${finding.rule} ${finding.level} ${finding.policy ?? ''} ${finding.fix ?? ''}`))).toEqual(new Set([`config-drift note default ${FIX}`]));
  });

  it.each(['meets-default', 'meets-default-by-hand'])('%s: a repository that already does what the default policy asks gets no notes', async (name) => {
    const result = await exec('doctor', repo(name));
    expect(result.code).toBe(EXIT_OK);
    expect(head(result.stdout)).toBe(
      `No problems found.\n\nNotes:\n  note ${NOTICE.message} (policy-missing)\n    fix: ${NOTICE.fix}\n  note ${OSV_NOTICE.message} (known-malicious)\n    fix: ${OSV_NOTICE.fix}\n\n`,
    );
    expect(result.stdout).toMatch(/^ {4}passed {10}Configuration files match what depcurfew apply writes for depcurfew\.json \(compared with the default policy\) \[config-drift\]$/mu);
    const { report } = await json(repo(name));
    expect(report).toMatchObject({ policySource: 'default', findings: [], summary: { error: 0, warning: 0, note: 0 } });
  });

  it('compares with what init would write: a longer delay the repository sets', async () => {
    const { report } = await json(join(REPOS, 'npm-longer-cooldown'));
    expect(report.notices[0]).toEqual({
      ...NOTICE,
      message:
        'no depcurfew.json: the rules that need a policy compared the repository with the default policy of depcurfew init (with cooldown.minimum "14d", the longest release-age delay the repository already sets); what they find is a note and does not fail doctor',
    });
    // min-release-age=14 in .npmrc already holds, so apply would not change it.
    const compared = report.findings.filter((finding) => finding.policy === 'default');
    expect(compared.find((finding) => finding.location.file === '.npmrc')?.message).not.toContain('min-release-age');
    expect(compared.find((finding) => finding.location.file === 'renovate.json')?.message).toContain('`minimumReleaseAge: "14 days"`');
    // The bots that wait less than npm stay errors of bot-cooldown-mismatch, which needs no policy.
    expect(report.findings.filter((finding) => finding.policy === undefined).map((finding) => [finding.rule, finding.level])).toEqual([
      ['bot-cooldown-mismatch', 'error'],
      ['bot-cooldown-mismatch', 'error'],
    ]);
  });

  it('compares with what init would write: the projects of a repository without a root manifest', async () => {
    const { report } = await json(join(REPOS, 'multi-project'));
    expect(report.notices[0]?.message).toContain('(with projects "backend" and "frontend")');
    expect(report.findings.map((finding) => finding.location.file)).toEqual(['.github/dependabot.yml', 'backend/pyproject.toml', 'frontend/.npmrc']);
    expect(report.checked?.tools.map((tool) => [tool.id, tool.project])).toEqual(expect.arrayContaining([['npm', 'frontend'], ['uv', 'backend']]));
  });

  it('shows at most 5 notes of a rule in one file, and counts the rest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-default-many-'));
    temporary.push(directory);
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
    const packages = Object.fromEntries(names.map((name) => [`node_modules/${name}`, { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, hasInstallScript: true }]));
    writeFileSync(join(directory, 'package.json'), '{ "name": "many", "private": true, "packageManager": "npm@11.17.0" }\n');
    writeFileSync(join(directory, 'package-lock.json'), `${JSON.stringify({ name: 'many', lockfileVersion: 3, requires: true, packages: { '': { name: 'many' }, ...packages } }, null, 2)}\n`);
    const { code, report } = await json(directory);
    expect(code).toBe(EXIT_OK);
    const scripts = report.findings.filter((finding) => finding.rule === 'lockfile-install-scripts');
    expect(scripts.map((finding) => finding.message.split(' ')[0])).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', '2']);
    expect(scripts.at(-1)).toEqual({
      rule: 'lockfile-install-scripts',
      level: 'note',
      location: { file: 'package-lock.json' },
      message: '2 more lockfile-install-scripts findings in package-lock.json against the default policy of depcurfew init are not shown',
      fix: 'Run depcurfew init to write depcurfew.json with the default policy, then run depcurfew doctor again to see them all',
      policy: 'default',
    });
    expect(report.checked?.rules.find((entry) => entry.rule === 'lockfile-install-scripts')).toMatchObject({ result: 'problems', notes: 6, policy: 'default' });
  });

  it('an invalid depcurfew.json is reported as before, without the default policy', async () => {
    const { code, report } = await json(join(DOCTOR, 'invalid-policy', 'fires-schema', 'repo'));
    expect(code).toBe(EXIT_FAILURE);
    expect(report).toMatchObject({ policy: 'invalid', policySource: null });
    expect(report.findings.every((finding) => finding.policy === undefined)).toBe(true);
    expect(report.findings.map((finding) => finding.rule)).toContain('invalid-policy');
    expect(report.notices.map((notice) => notice.code)).toContain('policy-invalid');
    expect(report.checked?.rules.find((entry) => entry.rule === 'config-drift')).toMatchObject({ result: 'skipped' });
    expect(report.checked?.rules.every((entry) => entry.policy === undefined)).toBe(true);
  });

  it('a pinned npm too old for the default policy is a note, which manager-version-too-old adds to its own result', async () => {
    const directory = scratch({ 'package.json': '{"name":"app","version":"1.0.0","packageManager":"npm@10.9.2"}\n', 'package-lock.json': LOCKFILE });
    const { code, report } = await json(directory);
    expect(code).toBe(EXIT_OK);
    const notes = report.findings.filter((finding) => finding.rule === 'manager-version-too-old');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((finding) => finding.level === 'note' && finding.policy === 'default')).toBe(true);
    expect(notes[0]?.message).toContain('npm 10.9.2');
    expect(notes[0]?.message).toContain('the default policy of depcurfew init');
    expect(notes[0]?.fix).toMatch(/^Run depcurfew init to write depcurfew.json with the default policy; then /u);
    expect(report.checked?.rules.find((entry) => entry.rule === 'manager-version-too-old')).toMatchObject({ result: 'problems', errors: 0, notes: notes.length, policy: 'default' });
  });

  it('a finding the rule makes without a policy too is not repeated as a note', async () => {
    // npm 10.9.2 reads no min-release-age from .npmrc: an error of its own, which the default policy needs as well.
    const directory = scratch({ 'package.json': '{"name":"app","version":"1.0.0","packageManager":"npm@10.9.2"}\n', 'package-lock.json': LOCKFILE, '.npmrc': 'min-release-age=3\n' });
    const { code, report } = await json(directory);
    expect(code).toBe(EXIT_FAILURE);
    const findings = report.findings.filter((finding) => finding.rule === 'manager-version-too-old');
    const errors = findings.filter((finding) => finding.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(findings.filter((finding) => finding.location.line === error.location.line && finding.location.file === error.location.file && finding.message.startsWith(error.message))).toHaveLength(1);
    }
    const result = report.checked?.rules.find((entry) => entry.rule === 'manager-version-too-old');
    expect(result).toMatchObject({ result: 'problems', errors: errors.length, notes: findings.length - errors.length });
    expect(result?.policy).toBeUndefined();
  });

  it('a lockfile that only the rules that need a policy read is reported when it cannot be parsed', async () => {
    const directory = scratch({ 'package.json': '{"name":"app","version":"1.0.0","packageManager":"npm@11.17.0"}\n', 'package-lock.json': '{ broken' });
    const { code, report } = await json(directory);
    expect(code).toBe(EXIT_OK);
    const note = report.findings.find((finding) => finding.rule === 'unreadable-config' && finding.location.file === 'package-lock.json');
    expect(note).toMatchObject({ level: 'note', policy: 'default' });
    expect(report.checked?.rules.find((entry) => entry.rule === 'unreadable-config')).toMatchObject({ result: 'problems', policy: 'default' });
  });

  it('a valid depcurfew.json is the policy, as before', async () => {
    const { report } = await json(join(DOCTOR, 'config-drift', 'fires-hand-edited', 'repo'));
    expect(report).toMatchObject({ policy: 'valid', policySource: 'file' });
    expect(report.findings.every((finding) => finding.policy === undefined)).toBe(true);
  });
});

describe('runDoctor without depcurfew.json', () => {
  it('runs only the rules that need no policy unless it is given the default policy, as the library did', () => {
    const report = runDoctor(repo('npm-plain'));
    expect(report).toMatchObject({ policy: 'missing', policySource: null, findings: [] });
    expect(report.checked?.rules.find((entry) => entry.rule === 'config-drift')?.result).toBe('skipped');
    expect(report.notices[0]?.message).toBe('no depcurfew.json: only the rules that do not need a policy ran');
    const compared = runDoctor(repo('npm-plain'), { defaultPolicy: initialResolvedPolicy(repo('npm-plain')) });
    expect(compared.policySource).toBe('default');
    expect(compared.findings.map((finding) => [finding.rule, finding.level, finding.policy])).toEqual([
      ['config-drift', 'note', 'default'],
      ['lockfile-install-scripts', 'note', 'default'],
    ]);
  });

  it('ignores the default policy when the repository has one', () => {
    const directory = join(DOCTOR, 'config-drift', 'fires-hand-edited', 'repo');
    const report = runDoctor(directory, { defaultPolicy: initialResolvedPolicy(directory) });
    expect(report.policySource).toBe('file');
    expect(report.findings.some((finding) => finding.policy === 'default')).toBe(false);
  });
});

describe('the GitHub Action without depcurfew.json', () => {
  it('stays as it was: no comparison with the default policy, no notes, no failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-default-action-'));
    temporary.push(root);
    cpSync(repo('npm-plain'), root, { recursive: true });
    let log = '';
    const outputs = runAction({ GITHUB_WORKSPACE: root }, { log: (text) => (log += text), summary: () => undefined });
    expect(outputs).toMatchObject({ errors: 0, warnings: 0, notes: 0, failure: '', 'fail-reason': '' });
    expect(log).toContain('No problems found.\n');
    expect(log).toContain('no depcurfew.json: only the rules that do not need a policy ran (policy-missing)');
    expect(log).not.toContain('Compared with the default policy');
  });
});

describe('settingChanges', () => {
  it('reads .npmrc as npm does: a line moved into the managed block with the same value is no change', () => {
    const before = 'save-exact=true\nmin-release-age=3\n';
    const after = 'save-exact=true\n# depcurfew: superseded by the managed block: min-release-age=3\n# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nmin-release-age=3\nignore-scripts=true\n# <<< depcurfew managed block\n';
    expect(settingChanges('.npmrc', before, after)).toEqual({ set: ['ignore-scripts=true'], removed: [] });
    expect(settingChanges('.npmrc', 'ignore-scripts=false\n', '# depcurfew: turned off\nignore-scripts=true\n')).toEqual({ set: ['ignore-scripts=true'], removed: [] });
  });

  it('names a YAML setting by its path, once for every entry of a list of tables', () => {
    const before = 'updates:\n  - package-ecosystem: npm\n  - package-ecosystem: pip\n';
    const after = 'updates:\n  - package-ecosystem: npm\n    # managed by depcurfew\n    cooldown:\n      default-days: 3\n  - package-ecosystem: pip\n    cooldown:\n      default-days: 3\n';
    expect(settingChanges('.github/dependabot.yml', before, after)).toEqual({ set: ['updates[].cooldown.default-days: 3'], removed: [] });
    expect(settingChanges('pnpm-workspace.yaml', 'minimumReleaseAge: 1440\n', '# managed by depcurfew\nminimumReleaseAge: 4320\n')).toEqual({ set: ['minimumReleaseAge: 4320'], removed: [] });
  });

  it('reads JSON and TOML values, and a file it cannot read line by line', () => {
    expect(settingChanges('renovate.json', '{ "extends": [] }\n', '{ "extends": [], "minimumReleaseAge": "3 days", "vulnerabilityAlerts": { "minimumReleaseAge": null } }\n')).toEqual({
      set: ['minimumReleaseAge: "3 days"', 'vulnerabilityAlerts.minimumReleaseAge: null'],
      removed: [],
    });
    expect(settingChanges('pyproject.toml', '[project]\nname = "a"\n', '[project]\nname = "a"\n\n[tool.uv]\nexclude-newer = "3 days"\n')).toEqual({ set: ['tool.uv.exclude-newer = "3 days"'], removed: [] });
    expect(settingChanges('requirements.txt', 'requests==2.32.3\n', '# managed by depcurfew\n--only-binary :all:\nrequests==2.32.3\n')).toEqual({ set: ['--only-binary :all:'], removed: [] });
    expect(settingChanges('package.json', '{ "name": "a", "x": 1 }\n', '{ "name": "a" }\n')).toEqual({ set: [], removed: ['x'] });
  });

  it('a file apply creates sets every setting it writes', () => {
    expect(settingChanges('bunfig.toml', null, '[install]\nminimumReleaseAge = 259200\n')).toEqual({ set: ['install.minimumReleaseAge = 259200'], removed: [] });
  });
});
