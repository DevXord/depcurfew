// check, the Claude Code hook, depcurfew mcp and doctor with the local OSV.dev data of depcurfew osv update (decision
// D-150): without --osv they report a known malicious version as known-malicious, with the same message, level and fix
// as from api.osv.dev, with "source": "osv-local", and without any request to OSV.dev; old data gives a note (a warning
// after 30 days); with --osv the API answers, and the local data only for versions the API did not answer for.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { runDoctorWithLocalOsv } from '../../src/doctor/osv.ts';
import { LocalOsvData, osvDataFile } from '../../src/osv/data.ts';
import { call, cleanUp, initialized } from '../mcp/support.ts';
import { OSV_BATCH_URL, osvFetch, packument, pypiPage, unreachableOsv, withDocuments } from '../support/osv.ts';
import { localData } from '../support/osv-data.ts';

/** Exported on 2026-11-02 06:00 UTC (EXPORT_DATE); the clock of the tests is half a day later. */
const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
let HOME = '';
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});
HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
temporary.push(HOME);

const DOCUMENTS = {
  'https://registry.npmjs.org/cutekitten-test': packument('cutekitten-test', ['1.0.0', '1.0.1']),
  'https://registry.npmjs.org/lodash': packument('lodash', ['4.17.21', '4.18.1']),
  'https://pypi.org/simple/wallet-tracking/': pypiPage('wallet-tracking', ['1.0.0']),
};

/** The recorded registry and PyPI; every URL asked for is kept, and OSV.dev or its export would fail the test. */
function offline(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const registry = withDocuments(DOCUMENTS);
  const fetch = (async (url, init) => {
    urls.push(url);
    if (url.includes('osv.dev') || url.includes('osv-vulnerabilities')) throw new Error(`asked ${url}`);
    return registry(url, init);
  }) as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

function project(policy: object = { cooldown: { minimum: '3d' } }): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-osv-local-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return directory;
}

async function exec(argv: string[], fetch: FetchLike, data: string | undefined, options: { stdin?: string; projectDir?: string; now?: Date } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch,
    now: () => options.now ?? NOW,
    stdin: async () => options.stdin ?? '',
    home: () => HOME,
    projectDir: () => options.projectDir,
    osvData: () => data,
  });
  return { code, stdout, stderr };
}

const event = (command: string, cwd: string) => JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

const MALWARE_MESSAGE = 'cutekitten-test@1.0.1 is a known malicious version: OSV.dev lists it as MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const MALWARE_FIX = 'Do not install it; pick another package or version. If it is installed anywhere already, remove it and read the record on OSV.dev for what it does';

interface Finding {
  level: string;
  code: string;
  message: string;
  fix: string;
  source?: string;
}

describe('depcurfew check with the local OSV.dev data', () => {
  it('reports a version the local data lists, as from OSV.dev, without asking OSV.dev', async () => {
    const data = await localData(temporary, NOW);
    const fetch = offline();
    const result = await exec(['check', '--json', '--dir', project(), 'cutekitten-test'], fetch, data);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as { packages: { version: string; findings: Finding[] }[]; notices: unknown[] };
    expect(document.packages[0]).toMatchObject({ version: '1.0.1', findings: [{ level: 'error', code: 'known-malicious', message: MALWARE_MESSAGE, fix: MALWARE_FIX, source: 'osv-local' }] });
    expect(document.notices).toEqual([]);
    expect(fetch.urls).toEqual(['https://registry.npmjs.org/cutekitten-test']);
    expect(result.stderr).toBe('');
  });

  it('shows the same text as with --osv, passes a withdrawn record and a version the record does not list, and checks PyPI names', async () => {
    const data = await localData(temporary, NOW);
    const fetch = offline();
    const text = await exec(['check', '--dir', project(), 'cutekitten-test@1.0.1', 'cutekitten-test@1.0.0', 'lodash@4.17.21'], fetch, data);
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stdout).toBe(`cutekitten-test@1.0.1:\n  error: ${MALWARE_MESSAGE}\n    fix: ${MALWARE_FIX}\ncutekitten-test@1.0.0: ok (published 2026-01-01)\nlodash@4.17.21: ok (published 2026-01-01)\n\n3 packages: 1 with errors, 0 with warnings\n`);
    const python = await exec(['check', '--json', '--dir', project(), 'pypi:Wallet_Tracking==1.0.0'], fetch, data);
    const findings = (JSON.parse(python.stdout) as { packages: { findings: Finding[] }[] }).packages[0]?.findings;
    expect(findings).toEqual([
      expect.objectContaining({ code: 'known-malicious', source: 'osv-local', message: 'pypi:wallet-tracking==1.0.0 is a known malicious version: OSV.dev lists it as MAL-2026-18443 (https://osv.dev/vulnerability/MAL-2026-18443)' }),
    ]);
    expect(fetch.urls.some((url) => url.includes('osv'))).toBe(false);
  });

  it('notes data older than 7 days and warns about data older than 30 days, with what to do', async () => {
    const data = await localData(temporary, NOW);
    const file = osvDataFile(data, 'npm');
    const old = await exec(['check', '--json', '--dir', project(), 'lodash@4.17.21'], offline(), data, { now: new Date('2026-11-12T06:00:00Z') });
    expect(old.code).toBe(EXIT_OK);
    expect((JSON.parse(old.stdout) as { notices: unknown[] }).notices).toEqual([
      {
        level: 'note',
        code: 'osv-data-old',
        location: { file },
        message: 'the local OSV.dev data for npm is from 2026-11-02, 10 days old: malicious versions reported since then are not in it',
        fix: 'Run depcurfew osv update to download the current data',
      },
    ]);
    const older = await exec(['check', '--dir', project(), 'lodash@4.17.21'], offline(), data, { now: new Date('2026-12-12T06:00:00Z') });
    expect(older.code).toBe(EXIT_OK);
    expect(older.stderr).toBe(
      'warning: the local OSV.dev data for npm is from 2026-11-02, 40 days old: malicious versions reported since then are not in it (osv-data-old)\n  fix: Run depcurfew osv update to download the current data\n',
    );
    // Only the ecosystems looked up: a Python package says nothing about the data of npm.
    expect(JSON.parse((await exec(['check', '--json', '--dir', project(), 'pypi:wallet-tracking==1.0.0'], offline(), data)).stdout).notices).toEqual([]);
  });

  it('changes nothing without local data', async () => {
    const fetch = offline();
    const result = await exec(['check', '--json', '--dir', project(), 'cutekitten-test@1.0.1'], fetch, undefined);
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ packages: [{ findings: [] }], notices: [] });
  });

  it('with --osv takes the answer of api.osv.dev, and the local data only where the API gives none', async () => {
    const data = await localData(temporary, NOW);
    const registry = withDocuments(DOCUMENTS);
    const api = osvFetch(registry);
    const answered = await exec(['check', '--osv', '--json', '--dir', project(), 'cutekitten-test@1.0.1'], api, data);
    expect((JSON.parse(answered.stdout) as { packages: { findings: Finding[] }[] }).packages[0]?.findings).toEqual([expect.objectContaining({ code: 'known-malicious', source: 'osv-api' })]);
    expect(api.requests).toHaveLength(1);
    const unreachable = unreachableOsv(registry);
    const fallback = await exec(['check', '--osv', '--json', '--dir', project(), 'cutekitten-test@1.0.1', 'lodash@4.17.21'], unreachable, data);
    const packages = (JSON.parse(fallback.stdout) as { packages: { findings: Finding[] }[] }).packages;
    expect(packages[0]?.findings).toEqual([{ level: 'error', code: 'known-malicious', message: MALWARE_MESSAGE, fix: MALWARE_FIX, source: 'osv-local' }]);
    // A version the local data does not list stays unverified: --osv asked for the answer of the API.
    expect(packages[1]?.findings).toEqual([expect.objectContaining({ code: 'unverified' })]);
  });
});

describe('the Claude Code hook with the local OSV.dev data', () => {
  it('denies an install of a version the local data lists, without --osv and without asking OSV.dev', async () => {
    const data = await localData(temporary, NOW);
    const directory = project();
    const fetch = offline();
    const result = await exec(['check', '--hook', 'claude-code'], fetch, data, { stdin: event('npm install cutekitten-test@1.0.1', directory), projectDir: directory });
    expect(result.code).toBe(EXIT_OK);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
      `depcurfew blocked this command because it installs a known malicious version, which OSV.dev lists:\n- cutekitten-test@1.0.1: ${MALWARE_MESSAGE}. Fix: ${MALWARE_FIX}\nChoose another package or version.`,
    );
    expect(fetch.urls.some((url) => url.includes('osv'))).toBe(false);
  });

  it('tells the agent in the context when the local data is old', async () => {
    const data = await localData(temporary, NOW);
    const directory = project();
    const result = await exec(['check', '--hook', 'claude-code'], offline(), data, { stdin: event('npm install lodash@4.17.21', directory), projectDir: directory, now: new Date('2026-11-20T06:00:00Z') });
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput['permissionDecision']).toBeUndefined();
    expect(output.hookSpecificOutput['additionalContext']).toContain(
      '- the local OSV.dev data for npm is from 2026-11-02, 18 days old: malicious versions reported since then are not in it. Tell the user that the local OSV.dev data is old; they update it with depcurfew osv update',
    );
  });
});

describe('depcurfew mcp with the local OSV.dev data', () => {
  type Message = Record<string, unknown>;
  const structured = (message: Message) => (message['result'] as Record<string, unknown>)['structuredContent'] as Record<string, unknown>;

  it('reports a version the local data lists in check_packages, without --osv', async () => {
    const data = await localData(temporary, NOW);
    const directory = project();
    const fetch = offline();
    const client = await initialized(directory, '2025-11-25', { argv: ['mcp', '--dir', directory], fetch, osvData: data, now: NOW });
    client.send(call(1, 'check_packages', { packages: ['cutekitten-test@1.0.1'] }));
    const packages = structured(await client.next())['packages'] as { findings: Finding[] }[];
    expect(packages[0]?.findings).toEqual([{ level: 'error', code: 'known-malicious', message: MALWARE_MESSAGE, fix: MALWARE_FIX, source: 'osv-local' }]);
    expect(fetch.urls.some((url) => url.includes('osv'))).toBe(false);
    await client.close();
  });
});

const FIXTURE = fileURLToPath(new URL('../fixtures/doctor/known-malicious/fires-npm-and-python/repo', import.meta.url));

/** A copy of the fixture with a lockfile of npm and one of uv, each locking a version with a MAL- record. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-osv-local-doctor-'));
  temporary.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A fetch that fails the test when doctor asks anything. */
const never: FetchLike = async (url) => {
  throw new Error(`doctor asked ${url}`);
};

describe('depcurfew doctor with the local OSV.dev data', () => {
  it('reports each locked version the local data lists, with source osv-local, and asks nothing', async () => {
    const data = await localData(temporary, NOW);
    const result = await exec(['doctor', '--json', repository()], never, data);
    expect(result.code).toBe(EXIT_FAILURE);
    const report = JSON.parse(result.stdout) as { findings: (Finding & { rule: string; location: unknown })[]; notices: unknown[]; checked: { rules: { rule: string; result: string }[] } };
    expect(report.findings.filter((finding) => finding.rule === 'known-malicious')).toEqual([
      expect.objectContaining({ level: 'error', location: { file: 'package-lock.json', line: 15 }, source: 'osv-local', message: expect.stringContaining('MAL-2026-18458') }),
      expect.objectContaining({ level: 'error', location: { file: 'uv.lock', line: 22 }, source: 'osv-local', message: expect.stringContaining('MAL-2026-18443') }),
    ]);
    expect(report.checked.rules.find((entry) => entry.rule === 'known-malicious')?.result).toBe('problems');
  });

  it('puts the source in SARIF too', async () => {
    const data = await localData(temporary, NOW);
    const result = await exec(['doctor', '--sarif', repository()], never, data);
    const sarif = JSON.parse(result.stdout) as { runs: { results: { ruleId: string; properties?: Record<string, unknown> }[] }[] };
    const results = sarif.runs[0]?.results.filter((entry) => entry.ruleId === 'known-malicious') ?? [];
    expect(results.map((entry) => entry.properties)).toEqual([{ source: 'osv-local' }, { source: 'osv-local' }]);
  });

  it('notes old data per lockfile, warns about data older than 30 days, and notes an ecosystem without data', async () => {
    const npmOnly = new LocalOsvData(await localData(temporary, NOW, { npm: (await import('../support/osv-data.ts')).standardExports().npm }));
    const old = runDoctorWithLocalOsv(repository(), { invalidPolicy: 'report' }, npmOnly, new Date('2026-11-12T06:00:00Z'));
    expect(old.notices.filter((notice) => notice.code === 'known-malicious')).toEqual([
      {
        level: 'note',
        code: 'known-malicious',
        location: { file: 'package-lock.json' },
        message: 'known-malicious checked package-lock.json against the local OSV.dev data for npm from 2026-11-02, 10 days old: malicious versions reported since then are not in it',
        file: 'package-lock.json',
        fix: 'Run depcurfew osv update to download the current data, then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev',
      },
      {
        level: 'note',
        code: 'known-malicious',
        location: { file: 'uv.lock' },
        message: 'known-malicious did not check uv.lock: there is no local OSV.dev data for PyPI',
        file: 'uv.lock',
        fix: 'Run depcurfew osv update --ecosystem pypi to download it, then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev',
      },
    ]);
    const older = runDoctorWithLocalOsv(repository(), { invalidPolicy: 'report' }, npmOnly, new Date('2026-12-12T06:00:00Z'));
    expect(older.findings.filter((finding) => finding.rule === 'known-malicious' && finding.level === 'warning')).toEqual([
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'package-lock.json' },
        message: 'known-malicious checked package-lock.json against the local OSV.dev data for npm from 2026-11-02, 40 days old: malicious versions reported since then are not in it',
        fix: 'Run depcurfew osv update to download the current data, then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev',
      },
    ]);
  });

  it('says once how to get the data when there is none, and does not apply', async () => {
    const result = await exec(['doctor', '--json', repository()], never, undefined);
    const report = JSON.parse(result.stdout) as { findings: { rule: string }[]; notices: { code: string; message: string; fix: string; location?: unknown }[]; checked: { rules: { rule: string; result: string }[] } };
    expect(report.findings.filter((finding) => finding.rule === 'known-malicious')).toEqual([]);
    expect(report.notices.filter((notice) => notice.code === 'known-malicious')).toEqual([
      {
        level: 'note',
        code: 'known-malicious',
        location: { file: 'package-lock.json' },
        message: 'known-malicious did not check the locked package versions: there is no local OSV.dev data, and --osv was not given',
        file: 'package-lock.json',
        fix: 'Run depcurfew osv update to download the OSV.dev data of known malicious packages (it requests only the public export files and sends no package names), then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev',
      },
    ]);
    expect(report.checked.rules.find((entry) => entry.rule === 'known-malicious')?.result).toBe('not-applicable');
  });

  it('with --osv asks api.osv.dev, and reports its answer with source osv-api', async () => {
    const data = await localData(temporary, NOW);
    const api = osvFetch();
    const result = await exec(['doctor', '--osv', '--json', repository()], api, data);
    const report = JSON.parse(result.stdout) as { findings: (Finding & { rule: string })[] };
    expect(report.findings.filter((finding) => finding.rule === 'known-malicious').map((finding) => finding.source)).toEqual(['osv-api', 'osv-api']);
    expect(api.requests).toHaveLength(1);
    expect(OSV_BATCH_URL).toBe('https://api.osv.dev/v1/querybatch');
  });
});
