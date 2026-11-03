// `depcurfew doctor` through the CLI: the three output formats, exit codes and policy errors.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { RULES } from '../../src/doctor/index.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const FAILING = join(DOCTOR, 'bot-cooldown-mismatch/fires-dependabot-shorter/repo');
const WARNING_ONLY = join(DOCTOR, 'bot-cooldown-mismatch/fires-security-recheck/repo');
const CLEAN = join(DOCTOR, 'bot-cooldown-mismatch/passes-consistent/repo');
// Without depcurfew.json, a repository is clean only when it already does what the default policy asks (D-149).
const MEETS_DEFAULT = fileURLToPath(new URL('../fixtures/doctor-default/meets-default/repo', import.meta.url));

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

describe('depcurfew doctor', () => {
  it('prints findings grouped by file and fails on errors', async () => {
    const result = await exec('doctor', FAILING);
    expect(result.code).toBe(EXIT_FAILURE);
    // The notes below count in the line of counts (decision D-116). The fixture has no depcurfew.json, so two of them
    // compare it with the policy depcurfew init would write, in a block after the findings (decision D-149), one says
    // how to get the local OSV.dev data (decision D-150), and two are notices: the missing policy and what
    // lockfile-install-scripts cannot check in pnpm-lock.yaml.
    expect(result.stdout).toMatch(/^1 error, 0 warnings, 5 notes\n\n\.github\/dependabot\.yml\n {2}7: error Dependabot proposes npm updates after 3 days/u);
    expect(result.stdout).toContain('(bot-cooldown-mismatch)\n    fix: Make the Dependabot delay at least 1 week, or run depcurfew apply\n');
    expect(result.stdout).toContain('\n\nCompared with the default policy (no depcurfew.json):\n\n.github/dependabot.yml\n  8: note .github/dependabot.yml: with the default policy of depcurfew init');
    expect(result.stdout).toContain(
      '\nNotes:\n  note no depcurfew.json: the rules that need a policy compared the repository with the default policy of depcurfew init (with cooldown.minimum "7d", the longest release-age delay the repository already sets); what they find is a note and does not fail doctor (policy-missing)\n    fix: Run depcurfew init to write depcurfew.json with this policy, then depcurfew apply (depcurfew apply --dry-run shows the changes first)\n',
    );
    expect(result.stderr).toBe('');
  });

  it('exits with 0 when there are only warnings', async () => {
    const result = await exec('doctor', WARNING_ONLY);
    expect(result.code).toBe(EXIT_OK);
    // Besides the notice of the missing policy: a note against the default policy and a notice of what
    // lockfile-install-scripts cannot check there (decision D-149), and the note on the local OSV.dev data (decision D-150).
    expect(result.stdout.startsWith('0 errors, 1 warning, 4 notes\n')).toBe(true);
  });

  it('says so when nothing is found', async () => {
    // Without depcurfew.json the rules that need a policy compare the repository with the default policy (decision
    // D-149), so the clean fixture is one that already does what that policy asks: CLEAN would get a note for renovate.json.
    const result = await exec('doctor', MEETS_DEFAULT);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.startsWith('No problems found.\n')).toBe(true);
    // A clean report says what it covered, so it cannot be mistaken for a run that checked nothing.
    // This fixture has no depcurfew.json, so the rules that compare with one say that they ran against the default
    // policy, and invalid-policy is named as not run.
    expect(result.stdout).toContain('\n\nWhat was checked:\n  Tools: ');
    expect(result.stdout).toMatch(/^  Files read: .*\.github\/dependabot\.yml/mu);
    expect(result.stdout).toMatch(/^  \d+ checks: \d+ passed, \d+ not applicable, \d+ skipped$/mu);
    expect(result.stdout).toContain('    passed          Update bots wait at least as long as the package manager, and for the actions of workflows as long as the policy, before proposing a new version [bot-cooldown-mismatch]\n');
    expect(result.stdout).toContain('    passed          Configuration files match what depcurfew apply writes for depcurfew.json (compared with the default policy) [config-drift]\n');
    expect(result.stdout).toContain('    skipped         depcurfew.json follows the schema and can be read (needs depcurfew.json) [invalid-policy]\n');
    expect(result.stdout).toContain('    not applicable  Python tools read their settings where they are written [python-config-ignored]\n');
    const json = JSON.parse((await exec('doctor', '--json', MEETS_DEFAULT)).stdout) as { checked: { files: string[]; rules: { rule: string; result: string; check: string }[]; policyFile: string } };
    expect(json.checked.files).toContain('.github/dependabot.yml');
    expect(json.checked.rules.find((entry) => entry.rule === 'config-drift')).toMatchObject({ result: 'passed', check: 'Configuration files match what depcurfew apply writes for depcurfew.json', policy: 'default' });
    expect(json.checked.rules.find((entry) => entry.rule === 'invalid-policy')?.result).toBe('skipped');
    expect(json.checked.policyFile).toBe('depcurfew.json');
  });

  it('--json prints the report with a summary', async () => {
    const result = await exec('doctor', '--json', FAILING);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    // The two notes compare the repository, which has no depcurfew.json, with the default policy (decision D-149).
    expect(report).toMatchObject({ schemaVersion: 1, policy: 'missing', policySource: 'default', summary: { error: 1, warning: 0, note: 2 } });
    expect(report['findings']).toEqual([
      expect.objectContaining({ rule: 'bot-cooldown-mismatch', level: 'error', location: { file: '.github/dependabot.yml', line: 7 } }),
      expect.objectContaining({ rule: 'config-drift', level: 'note', location: { file: '.github/dependabot.yml', line: 8 }, policy: 'default' }),
      expect.objectContaining({ rule: 'config-drift', level: 'note', location: { file: 'pnpm-workspace.yaml', line: 1 }, policy: 'default' }),
    ]);
  });

  it('--sarif prints SARIF with every rule and a location for every result', async () => {
    const result = await exec('doctor', '--sarif', FAILING);
    expect(result.code).toBe(EXIT_FAILURE);
    const sarif = JSON.parse(result.stdout) as { version: string; runs: { tool: { driver: { rules: { id: string }[] } }; results: unknown[] }[] };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toEqual(RULES.map((rule) => rule.id));
    expect(sarif.runs[0]?.results).toEqual([
      expect.objectContaining({
        ruleId: 'bot-cooldown-mismatch',
        level: 'error',
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: '.github/dependabot.yml', uriBaseId: '%SRCROOT%' },
              region: { startLine: 7, startColumn: 1, endLine: 7, endColumn: 14 },
            },
          },
        ],
      }),
      // Notes against the default policy, as the fixture has no depcurfew.json (decision D-149).
      expect.objectContaining({ ruleId: 'config-drift', level: 'note', properties: { policy: 'default' } }),
      expect.objectContaining({ ruleId: 'config-drift', level: 'note', properties: { policy: 'default' } }),
    ]);
  });

  it('rejects --json together with --sarif', async () => {
    const result = await exec('doctor', '--json', '--sarif', CLEAN);
    expect(result.code).toBe(EXIT_USAGE);
    // With --json the error is a JSON document on stdout (D-107).
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: [{ code: 'usage', message: "'--json' and '--sarif' cannot be used together; pick one" }] });
  });

  describe('with an invalid policy file', () => {
    const invalid = () => {
      const directory = mkdtempSync(join(tmpdir(), 'depcurfew-doctor-cli-'));
      temporary.push(directory);
      cpSync(CLEAN, directory, { recursive: true });
      writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 2 }');
      return directory;
    };
    const message = 'depcurfew.json is invalid: version: must be 1, got 2';

    it('reports it as an error finding in the text report and runs the rules that need no policy', async () => {
      const result = await exec('doctor', invalid());
      expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
      expect(result.stdout).toContain(`depcurfew.json\n  1: error ${message} (invalid-policy)\n    fix: Fix these problems in depcurfew.json`);
      expect(result.stdout).toContain('depcurfew.json is invalid: only the rules that do not need a policy ran');
    });

    it('prints the same finding as JSON, with policy "invalid", and nothing on stderr', async () => {
      const result = await exec('doctor', '--json', invalid());
      expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
      const report = JSON.parse(result.stdout) as { policy: string; summary: { error: number }; findings: { rule: string; message: string; location: unknown }[] };
      expect(report).toMatchObject({ schemaVersion: 1, policy: 'invalid', summary: { error: 1 } });
      expect(report.findings).toEqual([expect.objectContaining({ rule: 'invalid-policy', level: 'error', location: { file: 'depcurfew.json', line: 1 }, message })]);
    });

    it('prints it as a SARIF result', async () => {
      const result = await exec('doctor', '--sarif', invalid());
      expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
      const sarif = JSON.parse(result.stdout) as { runs: { results: { ruleId: string; message: { text: string } }[] }[] };
      expect(sarif.runs[0]?.results).toEqual([expect.objectContaining({ ruleId: 'invalid-policy', message: expect.objectContaining({ text: expect.stringContaining(message) }) })]);
    });
  });

  it('fails for a directory that does not exist', async () => {
    const result = await exec('doctor', join(tmpdir(), 'depcurfew-does-not-exist'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('directory not found');
  });
});
