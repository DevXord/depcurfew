// The action entry point: SARIF paths relative to the workspace, step outputs and failures, without GitHub.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatOutputs, runAction } from '../../src/action.ts';
import { canSymlink, windows } from '../support/platform.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A workspace with a fixture repository copied into `subdirectory` (or the root). */
function workspace(fixture: string, subdirectory = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-action-'));
  temporary.push(root);
  cpSync(join(DOCTOR, fixture, 'repo'), join(root, subdirectory), { recursive: true });
  return root;
}

function run(env: Record<string, string>): { outputs: ReturnType<typeof runAction>; log: string; summary: string } {
  let log = '';
  let summary = '';
  const outputs = runAction(env, { log: (text) => (log += text), summary: (text) => (summary += text) });
  return { outputs, log, summary };
}

describe('GitHub Action entry point', () => {
  it('prints the report, writes SARIF and counts the findings', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter');
    const { outputs, log } = run({ GITHUB_WORKSPACE: root });
    expect(outputs).toEqual({ 'sarif-file': 'depcurfew.sarif', errors: 1, warnings: 0, notes: 0, failure: '', 'fail-reason': 'depcurfew doctor reported 1 error; the job summary and the log of the Run depcurfew doctor step say how to fix each one' });
    expect(log).toContain('1 error, 0 warnings, 0 notes');
    const sarif = JSON.parse(readFileSync(join(root, 'depcurfew.sarif'), 'utf8')) as { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] };
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('.github/dependabot.yml');
  });

  it('prints the report with workflow commands turned off, with a new token in every run', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter');
    const first = run({ GITHUB_WORKSPACE: root }).log;
    const second = run({ GITHUB_WORKSPACE: root }).log;
    const token = /^::stop-commands::([0-9a-f-]{36})\n/u.exec(first)?.[1];
    expect(token).toBeDefined();
    expect(first).toMatch(new RegExp(`\\n::${token}::\\n::error `, 'u'));
    expect(second).not.toContain(token);
  });

  it('adds an annotation with the fix after the report, unless turned off', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter');
    const { log } = run({ GITHUB_WORKSPACE: root });
    const annotation = log.split('\n').filter((line) => line.startsWith('::error '));
    expect(annotation).toHaveLength(1);
    expect(annotation[0]).toMatch(/^::error file=\.github\/dependabot\.yml,line=\d+,title=depcurfew%3A bot-cooldown-mismatch::.+%0AFix: .+/u);
    expect(run({ GITHUB_WORKSPACE: root, INPUT_ANNOTATIONS: 'false' }).log).not.toMatch(/^::error /mu);
  });

  it('writes a job summary with a row and the fix for every finding, unless turned off', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter', 'packages/app');
    const { summary } = run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'packages/app' });
    expect(summary).toMatch(/^## depcurfew doctor\n\n\*\*1 error\*\*, 0 warnings, 0 notes in `packages\/app`\.\n/u);
    expect(summary).toContain('| Level | Where | Problem | How to fix |');
    expect(summary).toMatch(/^\| \*\*error\*\* \| `packages\/app\/\.github\/dependabot\.yml:\d+` \| .+ \(`bot-cooldown-mismatch`\) \| .+ \|$/mu);
    expect(run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'packages/app', INPUT_JOB_SUMMARY: 'false' }).summary).toBe('');
  });

  it('says in the job summary when doctor could not run', () => {
    const root = workspace('bot-cooldown-mismatch/passes-consistent');
    writeFileSync(join(root, 'depcurfew.json'), '{ "version": 2 }');
    expect(run({ GITHUB_WORKSPACE: root }).summary).toMatch(/^## depcurfew doctor\n\ndepcurfew could not check the repository: depcurfew\.json is invalid; /u);
  });

  it('makes paths relative to the workspace when checking a subdirectory', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter', 'packages/app');
    const { outputs } = run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'packages/app', INPUT_SARIF_FILE: 'out/report.sarif' });
    expect(outputs['sarif-file']).toBe('out/report.sarif');
    const sarif = JSON.parse(readFileSync(join(root, 'out/report.sarif'), 'utf8')) as {
      runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string }; region: { endColumn: number } } }[] }[] }[];
    };
    const location = sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation;
    expect(location?.artifactLocation.uri).toBe('packages/app/.github/dependabot.yml');
    expect(location?.region.endColumn).toBe(14);
  });

  it('reports a clean repository with zero counts, a notice and what was checked', () => {
    const { outputs, log, summary } = run({ GITHUB_WORKSPACE: workspace('bot-cooldown-mismatch/passes-consistent') });
    expect(outputs).toMatchObject({ errors: 0, warnings: 0, failure: '' });
    expect(log).toContain('No problems found.\n');
    expect(log).toMatch(/^What was checked:\n  Tools: .+\n  Files read: .*dependabot\.yml.*\n  \d+ checks: /mu);
    expect(log).toMatch(/^::notice title=depcurfew doctor%3A no problems found::No problems found in \d+ files .*%0Apassed: Update bots wait/mu);
    expect(summary).toContain('| Result | Check | Rule |');
    expect(summary).toContain('**No problems found**.');
    expect(summary).toContain('### What was checked');
  });

  it('refuses a directory outside the workspace', () => {
    const { outputs, log } = run({ GITHUB_WORKSPACE: workspace('bot-cooldown-mismatch/passes-consistent'), INPUT_DIRECTORY: '../elsewhere' });
    expect(outputs).toMatchObject({ 'sarif-file': '', failure: 'directory "../elsewhere" is not a directory inside the workspace' });
    expect(log).toContain('is not a directory inside the workspace');
  });

  it('turns an invalid policy into a failure without a SARIF file', () => {
    const root = workspace('bot-cooldown-mismatch/passes-consistent');
    writeFileSync(join(root, 'depcurfew.json'), '{ "version": 2 }');
    const { outputs, log } = run({ GITHUB_WORKSPACE: root });
    expect(outputs['sarif-file']).toBe('');
    expect(outputs.failure).toMatch(/^depcurfew\.json is invalid; /u);
    expect(log).toMatch(/^::stop-commands::[0-9a-f-]{36}\ndepcurfew: depcurfew\.json is invalid\n/u);
  });

  it.skipIf(!canSymlink())('keeps the counts and adds one line to the job summary when the SARIF file cannot be written', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter');
    writeFileSync(join(root, 'elsewhere.txt'), 'keep\n');
    symlinkSync(join(root, 'elsewhere.txt'), join(root, 'report.sarif'));
    const { outputs, log, summary } = run({ GITHUB_WORKSPACE: root, INPUT_SARIF_FILE: 'report.sarif' });
    const failure = 'cannot write the SARIF file report.sarif: report.sarif is a symlink; depcurfew does not write through symlinks';
    expect(outputs).toEqual({ 'sarif-file': '', errors: 1, warnings: 0, notes: 0, failure, 'fail-reason': 'depcurfew doctor reported 1 error; the job summary and the log of the Run depcurfew doctor step say how to fix each one' });
    expect(log).toContain(`\ndepcurfew: ${failure}\n`);
    expect(summary.match(/^## depcurfew doctor$/gmu)).toHaveLength(1);
    expect(summary).not.toContain('could not check the repository');
    expect(summary).toMatch(/^\| \*\*error\*\* \| `\.github\/dependabot\.yml:\d+` \|/mu);
    expect(summary.endsWith(`\n\n**Error:** depcurfew ${failure}\n`)).toBe(true);
    expect(readFileSync(join(root, 'elsewhere.txt'), 'utf8')).toBe('keep\n');
  });

  // Windows refuses a line break in a file name, so such a path cannot exist there.
  it.skipIf(windows)('keeps every row of the job summary on one line when a path has a line break, and encodes it in SARIF', () => {
    const directory = 'odd dir\n| x |';
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter', directory);
    const { summary } = run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: directory });
    expect(summary).toContain('**1 error**, 0 warnings, 0 notes in `odd dir\\x0a\\| x \\|`.\n');
    // The table of findings; the table of checks follows under "What was checked".
    const rows = (summary.split('### What was checked')[0] ?? '').split('\n').filter((line) => line.startsWith('| '));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatch(/^\| \*\*error\*\* \| `odd dir\\x0a\\\| x \\\|\/\.github\/dependabot\.yml:\d+` \| .+ \| .+ \|$/u);
    const sarif = JSON.parse(readFileSync(join(root, 'depcurfew.sarif'), 'utf8')) as { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] };
    expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('odd%20dir%0A%7C%20x%20%7C/.github/dependabot.yml');
  });

  describe('fail-on', () => {
    const WARNING_ONLY = 'bot-cooldown-mismatch/fires-security-recheck';
    const ERROR = 'bot-cooldown-mismatch/fires-dependabot-shorter';

    it('fails the step on errors only by default, and on warnings too with fail-on: warning', () => {
      expect(run({ GITHUB_WORKSPACE: workspace(WARNING_ONLY) }).outputs).toMatchObject({ warnings: 1, 'fail-reason': '' });
      expect(run({ GITHUB_WORKSPACE: workspace(WARNING_ONLY), INPUT_FAIL_ON: 'error' }).outputs['fail-reason']).toBe('');
      expect(run({ GITHUB_WORKSPACE: workspace(WARNING_ONLY), INPUT_FAIL_ON: 'warning' }).outputs).toMatchObject({
        failure: '',
        'fail-reason': 'depcurfew doctor reported 1 warning (fail-on: warning); the job summary and the log of the Run depcurfew doctor step say how to fix each one',
      });
      expect(run({ GITHUB_WORKSPACE: workspace(ERROR), INPUT_FAIL_ON: 'warning' }).outputs['fail-reason']).toMatch(/^depcurfew doctor reported 1 error \(fail-on: warning\); /u);
    });

    it('never fails the step on findings with fail-on-error: false, whatever fail-on says', () => {
      expect(run({ GITHUB_WORKSPACE: workspace(ERROR), INPUT_FAIL_ON_ERROR: 'false' }).outputs).toMatchObject({ errors: 1, 'fail-reason': '' });
      expect(run({ GITHUB_WORKSPACE: workspace(WARNING_ONLY), INPUT_FAIL_ON: 'warning', INPUT_FAIL_ON_ERROR: 'false' }).outputs['fail-reason']).toBe('');
    });

    it('fails the step with a clear message on any other value, before doctor runs', () => {
      const root = workspace(WARNING_ONLY);
      const { outputs, log, summary } = run({ GITHUB_WORKSPACE: root, INPUT_FAIL_ON: 'warnings' });
      const failure = 'the input fail-on is "warnings"; set it to error (the default: errors fail the step) or warning (warnings fail it too)';
      expect(outputs).toEqual({ 'sarif-file': '', errors: 0, warnings: 0, notes: 0, failure, 'fail-reason': '' });
      expect(log).toContain(`depcurfew: ${failure}\n`);
      expect(summary).toContain('depcurfew could not check the repository: the input fail-on is "warnings"');
    });
  });

  it('formats outputs for GITHUB_OUTPUT on single lines', () => {
    expect(formatOutputs({ 'sarif-file': 'a.sarif', errors: 2, warnings: 0, notes: 1, failure: 'one\ntwo\u001b[2K', 'fail-reason': '' })).toBe(
      'sarif-file=a.sarif\nerrors=2\nwarnings=0\nnotes=1\nfailure=one two\\x1b[2K\nfail-reason=\n',
    );
  });
});
