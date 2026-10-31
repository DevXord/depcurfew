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
    expect(result.stdout).toMatch(/^1 error, 0 warnings, 0 notes\n\n\.github\/dependabot\.yml\n {2}7: error Dependabot proposes npm updates after 3 days/u);
    expect(result.stdout).toContain('(bot-cooldown-mismatch)\n    fix: Make the Dependabot delay at least 1 week, or run depcurfew apply\n');
    expect(result.stdout).toContain('\nNotes:\n  no depcurfew.json: only the rules that do not need a policy ran\n');
    expect(result.stderr).toBe('');
  });

  it('exits with 0 when there are only warnings', async () => {
    const result = await exec('doctor', WARNING_ONLY);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.startsWith('0 errors, 1 warning, 0 notes\n')).toBe(true);
  });

  it('says so when nothing is found', async () => {
    const result = await exec('doctor', CLEAN);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.startsWith('No problems found.\n')).toBe(true);
    // A clean report says what it covered, so it cannot be mistaken for a run that checked nothing.
    // This fixture has no depcurfew.json, so the rules that compare with one are named as not run.
    expect(result.stdout).toMatch(/\n\nChecked: .+\nFiles read: .*\.github\/dependabot\.yml.*\nRules: \d+ ran; \d+ more need depcurfew\.json and did not run\n$/u);
    const json = JSON.parse((await exec('doctor', '--json', CLEAN)).stdout) as { checked: { tools: unknown[]; files: string[]; rules: string[]; skippedRules: string[]; policyFile: string } };
    expect(json.checked.files).toContain('.github/dependabot.yml');
    expect(json.checked.rules.length).toBeGreaterThan(0);
    expect(json.checked.skippedRules).toContain('config-drift');
    expect(json.checked.policyFile).toBe('depcurfew.json');
  });

  it('--json prints the report with a summary', async () => {
    const result = await exec('doctor', '--json', FAILING);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ schemaVersion: 1, policy: 'missing', summary: { error: 1, warning: 0, note: 0 } });
    expect(report['findings']).toEqual([
      expect.objectContaining({ rule: 'bot-cooldown-mismatch', level: 'error', location: { file: '.github/dependabot.yml', line: 7 } }),
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
    ]);
  });

  it('rejects --json together with --sarif', async () => {
    const result = await exec('doctor', '--json', '--sarif', CLEAN);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("'--json' and '--sarif' cannot be used together");
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
      expect(result.stdout).toContain(`depcurfew.json\n  error ${message} (invalid-policy)\n    fix: Fix these problems in depcurfew.json`);
      expect(result.stdout).toContain('depcurfew.json is invalid: only the rules that do not need a policy ran');
    });

    it('prints the same finding as JSON, with policy "invalid", and nothing on stderr', async () => {
      const result = await exec('doctor', '--json', invalid());
      expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
      const report = JSON.parse(result.stdout) as { policy: string; summary: { error: number }; findings: { rule: string; message: string; location: unknown }[] };
      expect(report).toMatchObject({ schemaVersion: 1, policy: 'invalid', summary: { error: 1 } });
      expect(report.findings).toEqual([expect.objectContaining({ rule: 'invalid-policy', level: 'error', location: { file: 'depcurfew.json' }, message })]);
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
