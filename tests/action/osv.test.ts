// The input osv of the GitHub Action (decision D-129): off by default, so nothing goes to OSV.dev; with osv: true the
// locked versions are looked up before doctor runs and known-malicious reports them like any finding.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { actionOsv, runAction } from '../../src/action.ts';
import { parseYaml } from '../../src/yaml-parse.ts';
import { osvFetch, unreachableOsv } from '../support/osv.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/doctor/known-malicious/fires-npm-and-python/repo', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-action-osv-'));
  temporary.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function runWith(env: Record<string, string>, osv?: Parameters<typeof runAction>[2]): { outputs: ReturnType<typeof runAction>; log: string } {
  let log = '';
  const outputs = runAction(env, { log: (text) => (log += text), summary: () => {} }, osv);
  return { outputs, log };
}

describe('the input osv of the action', () => {
  it('is declared off by default and passed to the doctor step', () => {
    const action = parseYaml(readFileSync(fileURLToPath(new URL('../../action.yml', import.meta.url)), 'utf8')) as {
      inputs: Record<string, { default: string; description: string }>;
      runs: { steps: { id?: string; env?: Record<string, string> }[] };
    };
    expect(action.inputs['osv']?.default).toBe('false');
    expect(action.inputs['osv']?.description).toContain('api.osv.dev');
    expect(action.runs.steps.find((step) => step.id === 'doctor')?.env?.['INPUT_OSV']).toBe('${{ inputs.osv }}');
  });

  it('asks OSV.dev nothing without osv: true', async () => {
    const fetch = osvFetch();
    expect(await actionOsv({ GITHUB_WORKSPACE: workspace() }, fetch)).toBeUndefined();
    expect(await actionOsv({ GITHUB_WORKSPACE: workspace(), INPUT_OSV: 'false' }, fetch)).toBeUndefined();
    expect(fetch.requests).toEqual([]);
    const { outputs, log } = runWith({ GITHUB_WORKSPACE: workspace() });
    expect(outputs.errors).toBe(0);
    expect(log).toContain('not applicable  With --osv: no locked package version is a known malicious version in OSV.dev [known-malicious]');
  });

  it('reports the known malicious versions with osv: true', async () => {
    const root = workspace();
    const env = { GITHUB_WORKSPACE: root, INPUT_OSV: 'true' };
    const fetch = osvFetch();
    const answers = await actionOsv(env, fetch);
    expect(fetch.requests).toHaveLength(1);
    const { outputs, log } = runWith(env, answers);
    expect(outputs.errors).toBe(2);
    expect(log).toContain('package-lock.json locks cutekitten-test@1.0.1, a known malicious version');
    const sarif = JSON.parse(readFileSync(join(root, 'depcurfew.sarif'), 'utf8')) as { runs: { results: { ruleId: string }[] }[] };
    expect(sarif.runs[0]?.results.filter((entry) => entry.ruleId === 'known-malicious')).toHaveLength(2);
  });

  it('gives warnings, not a pass, when OSV.dev cannot be reached', async () => {
    const env = { GITHUB_WORKSPACE: workspace(), INPUT_OSV: 'true' };
    const { outputs } = runWith(env, await actionOsv(env, unreachableOsv()));
    expect(outputs).toMatchObject({ errors: 0, warnings: 2 });
  });

  it('fails the step on a value other than true or false', () => {
    const { outputs } = runWith({ GITHUB_WORKSPACE: workspace(), INPUT_OSV: 'yes' });
    expect(outputs.failure).toBe('the input osv is "yes"; set it to true to look the locked package versions up in OSV.dev (api.osv.dev), or to false (the default) to send nothing');
  });
});
