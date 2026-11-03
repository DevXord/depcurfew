// doctor without depcurfew.json in a repository of independent projects (decision D-161): the lockfiles of the projects
// depcurfew init would list, the ones compared with the default policy (at most MAX_COMPARED_PROJECTS), are looked up
// for known malicious versions too, in the local OSV.dev data and with --osv. A listed version is an error, as one in
// the root lockfile is without depcurfew.json (decision D-150) and as it is with a depcurfew.json that lists the
// projects: it is a fact of the lockfile, not a difference from a policy. The library and the GitHub Action, which do
// not pass the default policy, stay as they were.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { MAX_COMPARED_PROJECTS } from '../../src/cli/init-policy.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import type { DoctorReport, Finding } from '../../src/doctor/index.ts';
import { runDoctorWithLocalOsv } from '../../src/doctor/osv.ts';
import { NO_DATA_FIX, NO_DATA_MESSAGE } from '../../src/doctor/rules/known-malicious.ts';
import { LocalOsvData } from '../../src/osv/data.ts';
import { osvFetch } from '../support/osv.ts';
import { localData } from '../support/osv-data.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const FIXTURE = fileURLToPath(new URL('../fixtures/doctor-default/projects-malicious/repo', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A copy of the fixture: no root manifest, a/package-lock.json locks cutekitten-test 1.0.1, b/package-lock.json left-pad 9.9.9. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-projects-malicious-'));
  temporary.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A fetch that fails the test when doctor asks anything. */
const never: FetchLike = async (url) => {
  throw new Error(`doctor asked ${url}`);
};

async function doctor(argv: string[], data: string | undefined, fetch: FetchLike = never): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(['doctor', ...argv], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch, now: () => NOW, stdin: async () => '', osvData: () => data });
  return { code, stdout };
}

const MESSAGE_A =
  'a/package-lock.json locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const MESSAGE_B = 'b/package-lock.json locks left-pad@9.9.9, a known malicious version: OSV.dev lists it as MAL-2026-90001 (https://osv.dev/vulnerability/MAL-2026-90001)';

const malicious = (report: DoctorReport) => report.findings.filter((finding) => finding.rule === 'known-malicious');

describe('doctor without depcurfew.json looks up the lockfiles of the projects init would list (decision D-161)', () => {
  it('reports a version the local data lists as an error, which fails doctor, as in the root', async () => {
    const data = await localData(temporary, NOW);
    const result = await doctor(['--json', repository()], data);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.policySource).toBe('default');
    expect(malicious(report)).toEqual([
      expect.objectContaining({ level: 'error', location: { file: 'a/package-lock.json', line: 14 }, source: 'osv-local', message: MESSAGE_A }),
      expect.objectContaining({ level: 'error', location: { file: 'b/package-lock.json', line: 14 }, source: 'osv-local', message: MESSAGE_B }),
    ]);
    // A fact of the lockfile, not a difference from the default policy: no "policy": "default", and the fix of the rule.
    for (const finding of malicious(report)) {
      expect(finding).not.toHaveProperty('policy');
      expect(finding.fix).toMatch(/^Remove /u);
    }
    expect(report.checked?.rules.find((entry) => entry.rule === 'known-malicious')).toEqual({
      rule: 'known-malicious',
      check: expect.any(String),
      result: 'problems',
      errors: 2,
      warnings: 0,
      notes: 0,
    });
    expect(report.checked?.files).toEqual(expect.arrayContaining(['a/package-lock.json', 'b/package-lock.json']));
  });

  it('lists the errors with the other findings in the text, not in the block of the default policy, and as errors in SARIF', async () => {
    const data = await localData(temporary, NOW);
    const root = repository();
    const text = (await doctor([root], data)).stdout;
    const block = text.indexOf('Compared with the default policy (no depcurfew.json):');
    expect(block).toBeGreaterThan(-1);
    const line = text.indexOf(`error ${MESSAGE_A} (known-malicious)`);
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(block);
    expect(text).toMatch(/^ {4}2 errors +With --osv or the local OSV\.dev data of depcurfew osv update: no locked package version is a known malicious version in OSV\.dev \[known-malicious\]$/mu);
    const sarif = JSON.parse((await doctor(['--sarif', root], data)).stdout) as { runs: { results: { ruleId: string; level: string; properties?: Record<string, unknown> }[] }[] };
    const results = sarif.runs[0]?.results.filter((entry) => entry.ruleId === 'known-malicious') ?? [];
    expect(results.map((entry) => [entry.level, entry.properties])).toEqual([
      ['error', { source: 'osv-local' }],
      ['error', { source: 'osv-local' }],
    ]);
  });

  it('gives the same findings as a depcurfew.json that lists the projects', async () => {
    const data = await localData(temporary, NOW);
    const without = JSON.parse((await doctor(['--json', repository()], data)).stdout) as DoctorReport;
    const root = repository();
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}, "projects": ["a", "b"]}\n');
    const listed = JSON.parse((await doctor(['--json', root], data)).stdout) as DoctorReport;
    expect(malicious(without)).toEqual(malicious(listed));
  });

  it('with --osv asks api.osv.dev about the versions of the projects, once', async () => {
    const data = await localData(temporary, NOW);
    const api = osvFetch();
    const result = await doctor(['--osv', '--json', repository()], data, api);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.map((query) => `${query.package.name}@${query.version}`).sort()).toEqual(['cutekitten-test@1.0.1', 'left-pad@9.9.9']);
    // The API answers for both (it has no record of left-pad 9.9.9), so the local data does not.
    expect(malicious(JSON.parse(result.stdout) as DoctorReport)).toEqual([expect.objectContaining({ level: 'error', location: { file: 'a/package-lock.json', line: 14 }, source: 'osv-api', message: MESSAGE_A })]);
  });

  it('without local data says once, at the first project lockfile, how to get it, and does not fail', async () => {
    const result = await doctor(['--json', repository()], undefined);
    expect(result.code).toBe(EXIT_OK);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(malicious(report)).toEqual([]);
    expect(report.notices.filter((notice) => notice.code === 'known-malicious')).toEqual([
      { level: 'note', code: 'known-malicious', location: { file: 'a/package-lock.json' }, file: 'a/package-lock.json', message: NO_DATA_MESSAGE, fix: NO_DATA_FIX },
    ]);
    expect(report.checked?.rules.find((entry) => entry.rule === 'known-malicious')?.result).toBe('not-applicable');
  });

  it('notes old local data at each project lockfile it checked', async () => {
    const data = await localData(temporary, NOW);
    let stdout = '';
    await run(['doctor', '--json', repository()], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch: never, now: () => new Date('2026-11-12T06:00:00Z'), stdin: async () => '', osvData: () => data });
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.notices.filter((notice) => notice.code === 'known-malicious').map((notice) => notice.file)).toEqual(['a/package-lock.json', 'b/package-lock.json']);
  });

  it('looks up only the projects doctor compares; projects-not-compared names the others', async () => {
    const data = await localData(temporary, NOW);
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-projects-malicious-many-'));
    temporary.push(root);
    const lockfile = readFileSync(join(FIXTURE, 'a', 'package-lock.json'), 'utf8');
    const names = Array.from({ length: MAX_COMPARED_PROJECTS + 1 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
    for (const name of names) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'package.json'), `{"name": "${name}", "version": "1.0.0"}\n`);
    }
    // Only the first project and the one past the limit lock the malicious version.
    for (const name of [names[0] as string, names.at(-1) as string]) writeFileSync(join(root, name, 'package-lock.json'), lockfile);
    const result = await doctor(['--json', root], data);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(malicious(report).map((finding: Finding) => finding.location.file)).toEqual(['p01/package-lock.json']);
    expect(report.notices.find((notice) => notice.code === 'projects-not-compared')?.message).toContain('did not check the other 1: "p21"');
  });

  it('is not done by runDoctor without the default policy, as the library and the GitHub Action call it', async () => {
    const local = new LocalOsvData(await localData(temporary, NOW));
    const report = runDoctorWithLocalOsv(repository(), { policy: null }, local, NOW);
    expect(malicious(report)).toEqual([]);
    expect(report.checked?.rules.find((entry) => entry.rule === 'known-malicious')?.result).toBe('not-applicable');
  });
});
