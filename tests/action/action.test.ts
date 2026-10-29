// The action entry point: SARIF paths relative to the workspace, step outputs and failures, without GitHub.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatOutputs, runAction } from '../../src/action.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A workspace with a fixture repository copied into `subdirectory` (or the root). */
function workspace(fixture: string, subdirectory = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'depgate-action-'));
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
    expect(outputs).toEqual({ 'sarif-file': 'depgate.sarif', errors: 1, warnings: 0, notes: 0, failure: '' });
    expect(log).toContain('1 error, 0 warnings, 0 notes');
    const sarif = JSON.parse(readFileSync(join(root, 'depgate.sarif'), 'utf8')) as { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] };
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
    expect(annotation[0]).toMatch(/^::error file=\.github\/dependabot\.yml,line=\d+,title=depgate%3A bot-cooldown-mismatch::.+%0AFix: .+/u);
    expect(run({ GITHUB_WORKSPACE: root, INPUT_ANNOTATIONS: 'false' }).log).not.toMatch(/^::error /mu);
  });

  it('writes a job summary with a row and the fix for every finding, unless turned off', () => {
    const root = workspace('bot-cooldown-mismatch/fires-dependabot-shorter', 'packages/app');
    const { summary } = run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'packages/app' });
    expect(summary).toMatch(/^## depgate doctor\n\n\*\*1 error\*\*, 0 warnings, 0 notes in `packages\/app`\.\n/u);
    expect(summary).toContain('| Level | Where | Problem | How to fix |');
    expect(summary).toMatch(/^\| \*\*error\*\* \| `packages\/app\/\.github\/dependabot\.yml:\d+` \| .+ \(`bot-cooldown-mismatch`\) \| .+ \|$/mu);
    expect(run({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'packages/app', INPUT_JOB_SUMMARY: 'false' }).summary).toBe('');
  });

  it('says in the job summary when doctor could not run', () => {
    const root = workspace('bot-cooldown-mismatch/passes-consistent');
    writeFileSync(join(root, 'depgate.json'), '{ "version": 2 }');
    expect(run({ GITHUB_WORKSPACE: root }).summary).toMatch(/^## depgate doctor\n\ndepgate could not check the repository: depgate\.json is invalid; /u);
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

  it('reports a clean repository with zero counts', () => {
    const { outputs } = run({ GITHUB_WORKSPACE: workspace('bot-cooldown-mismatch/passes-consistent') });
    expect(outputs).toMatchObject({ errors: 0, warnings: 0, failure: '' });
  });

  it('refuses a directory outside the workspace', () => {
    const { outputs, log } = run({ GITHUB_WORKSPACE: workspace('bot-cooldown-mismatch/passes-consistent'), INPUT_DIRECTORY: '../elsewhere' });
    expect(outputs).toMatchObject({ 'sarif-file': '', failure: 'directory "../elsewhere" is not a directory inside the workspace' });
    expect(log).toContain('is not a directory inside the workspace');
  });

  it('turns an invalid policy into a failure without a SARIF file', () => {
    const root = workspace('bot-cooldown-mismatch/passes-consistent');
    writeFileSync(join(root, 'depgate.json'), '{ "version": 2 }');
    const { outputs, log } = run({ GITHUB_WORKSPACE: root });
    expect(outputs['sarif-file']).toBe('');
    expect(outputs.failure).toMatch(/^depgate\.json is invalid; /u);
    expect(log).toMatch(/^::stop-commands::[0-9a-f-]{36}\ndepgate: depgate\.json is invalid\n/u);
  });

  it('formats outputs for GITHUB_OUTPUT on single lines', () => {
    expect(formatOutputs({ 'sarif-file': 'a.sarif', errors: 2, warnings: 0, notes: 1, failure: 'one\ntwo' })).toBe(
      'sarif-file=a.sarif\nerrors=2\nwarnings=0\nnotes=1\nfailure=one two\n',
    );
  });
});
