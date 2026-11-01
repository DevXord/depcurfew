// "not applicable" in the list of what doctor checked (decision D-098): a rule that does not concern the project, such
// as the Python rules without a Python tool, says so instead of "passed". Findings never change: a rule that reports
// one counts as having problems, whatever its applies says.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanNotice, jobSummary, renderText, RULES, runDoctor } from '../../src/doctor/index.ts';
import { checkedLines, resultCounts, ruleResults } from '../../src/doctor/render.ts';
import type { Checked, DoctorReport, Finding, Rule } from '../../src/doctor/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { canSymlink } from '../support/platform.ts';
import { platform } from '../support/user.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const results = (report: DoctorReport) => Object.fromEntries((report.checked?.rules ?? []).map((entry) => [entry.rule, entry.result]));

describe('rules that do not concern the project', () => {
  it('are not applicable in a pnpm project with bots: the Python rules and depcurfew-outdated', () => {
    const report = runDoctor(join(DOCTOR, 'bot-cooldown-mismatch/passes-consistent/repo'));
    expect(results(report)).toEqual({
      'invalid-policy': 'skipped',
      'invalid-project': 'not-applicable',
      'depcurfew-outdated': 'not-applicable',
      'manager-version-too-old': 'passed',
      'setting-ignored-by-version': 'passed',
      'npmrc-overrides-policy': 'passed',
      'pnpm-shared-workspace-lockfile': 'passed',
      'python-config-ignored': 'not-applicable',
      'runtime-end-of-life': 'not-applicable',
      'config-drift': 'skipped',
      'bot-cooldown-mismatch': 'passed',
      'broad-exclusion': 'passed',
      'lockfile-forbidden-source': 'skipped',
      'lockfile-install-scripts': 'skipped',
      'unreadable-config': 'passed',
    });
    expect(resultCounts(report.checked?.rules ?? [])).toBe('15 checks: 7 passed, 4 not applicable, 4 skipped');
  });

  it('are not applicable in a PDM project without bots: the npm, pnpm and bot rules', () => {
    const report = runDoctor(join(REPOS, 'pdm-basic'));
    expect(results(report)).toMatchObject({
      'npmrc-overrides-policy': 'not-applicable',
      'pnpm-shared-workspace-lockfile': 'not-applicable',
      'bot-cooldown-mismatch': 'not-applicable',
      'python-config-ignored': 'passed',
      'manager-version-too-old': 'passed',
    });
  });

  it('are not applicable without any package manager, also when they would need depcurfew.json', () => {
    const report = runDoctor(join(REPOS, 'empty'));
    expect(results(report)).toEqual({
      'invalid-policy': 'skipped',
      'invalid-project': 'not-applicable',
      'depcurfew-outdated': 'not-applicable',
      'manager-version-too-old': 'not-applicable',
      'setting-ignored-by-version': 'not-applicable',
      'npmrc-overrides-policy': 'not-applicable',
      'pnpm-shared-workspace-lockfile': 'not-applicable',
      'python-config-ignored': 'not-applicable',
      'runtime-end-of-life': 'not-applicable',
      'config-drift': 'skipped',
      'bot-cooldown-mismatch': 'not-applicable',
      'broad-exclusion': 'not-applicable',
      'lockfile-forbidden-source': 'not-applicable',
      'lockfile-install-scripts': 'not-applicable',
      'unreadable-config': 'passed',
    });
  });

  it('apply to depcurfew-outdated when the project pins depcurfew', () => {
    expect(results(runDoctor(join(DOCTOR, 'depcurfew-outdated/passes-older-copy/repo')))['depcurfew-outdated']).toBe('passed');
  });

  // A rule must never call itself not applicable where it can find something: every fires-* fixture concerns its rule.
  // The rule runs without its check here, so the result shows what applies says.
  const fires = RULES.flatMap((rule) =>
    readdirSync(join(DOCTOR, rule.id), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('fires'))
      .map((entry) => [rule, entry.name] as const),
  );
  it.each(fires.map(([rule, name]) => [rule.id, name, rule] as const))('%s applies to %s', (_id, name, rule) => {
    const silent: Rule = { ...rule, check: () => undefined };
    const report = runDoctor(join(DOCTOR, rule.id, name, 'repo'), { rules: [silent], invalidPolicy: 'report' });
    expect(report.checked?.rules[0]?.result).not.toBe('not-applicable');
  });

  it('count as problems when they report a finding anyway, so findings never depend on applies', () => {
    const rule: Rule = {
      id: 'always-finds',
      summary: 's',
      description: 'd',
      help: 'h',
      level: 'warning',
      requiresPolicy: false,
      applies: () => false,
      check: (context) => context.report({ location: { file: 'README.md' }, message: 'found' }),
    };
    const report = runDoctor(join(REPOS, 'empty'), { rules: [rule] });
    expect(report.findings).toHaveLength(1);
    expect(report.checked?.rules[0]).toMatchObject({ rule: 'always-finds', result: 'problems', warnings: 1 });
    expect(ruleResults([rule], [], () => false, () => false)[0]?.result).toBe('not-applicable');
  });
});

describe('not applicable in the output', () => {
  const checked: Checked = {
    tools: [{ id: 'npm', name: 'npm' }],
    files: ['package.json'],
    rules: [
      { rule: 'config-drift', check: 'Configuration files match', result: 'passed', errors: 0, warnings: 0, notes: 0 },
      { rule: 'python-config-ignored', check: 'Python tools read their settings where they are written', result: 'not-applicable', errors: 0, warnings: 0, notes: 0 },
    ],
    policyFile: 'depcurfew.json',
  };
  const report: DoctorReport = { schemaVersion: 1, policy: 'valid', findings: [], notices: [], checked };

  it('is written as two words in the text', () => {
    expect(checkedLines(checked)).toEqual([
      'What was checked:',
      '  Tools: npm',
      '  Files read: package.json',
      '  2 checks: 1 passed, 1 not applicable',
      '    passed          Configuration files match [config-drift]',
      '    not applicable  Python tools read their settings where they are written [python-config-ignored]',
    ]);
    expect(renderText(report, RULES)).toContain('\n    not applicable  Python tools read');
  });

  it('is in the job summary table and in the notice of a clean run', () => {
    expect(jobSummary(report, RULES, '', 1024 * 1024)).toContain('| not applicable | Python tools read their settings where they are written | `python-config-ignored` |');
    expect(cleanNotice(report)).toContain('1 passed, 1 not applicable.%0Apassed: Configuration files match%0Anot applicable: Python tools read');
  });

  it('keeps the value not-applicable in JSON', () => {
    const finding: Finding[] = [];
    expect(JSON.parse(JSON.stringify(ruleResults(RULES.slice(0, 1), finding, () => false, () => false)))[0]).toMatchObject({ result: 'not-applicable' });
  });
});

describe.skipIf(!canSymlink())('doctor --user', () => {
  it('calls the checks of installed tools not applicable when none is installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-na-'));
    temporary.push(root);
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const policy = userPolicyPath({ platform, home, env: {} });
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, renderPolicy(DEFAULT_POLICY));
    const report = runUserDoctor({ environment: { platform, home, env: { PATH: bin } } });
    expect(report.findings).toEqual([]);
    expect(report.checked?.rules.map((entry) => `${entry.result} ${entry.rule}`)).toEqual([
      'passed user-policy-invalid',
      'passed user-config-unreadable',
      'not-applicable user-config-drift',
      'not-applicable user-config-weakens',
      'not-applicable user-environment-overrides',
    ]);
    // With npm in PATH they apply again.
    const pkg = join(root, 'lib', 'node_modules', 'npm');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'npm', version: '11.21.1', bin: { npm: 'bin/npm-cli.js' } }));
    writeFileSync(join(pkg, 'bin', 'npm-cli.js'), '');
    symlinkSync(join(pkg, 'bin', 'npm-cli.js'), join(bin, 'npm'));
    expect(existsSync(join(bin, 'npm'))).toBe(true);
    expect(runUserDoctor({ environment: { platform, home, env: { PATH: bin } } }).checked?.rules.find((entry) => entry.rule === 'user-config-drift')?.result).toBe('problems');
  });
});
