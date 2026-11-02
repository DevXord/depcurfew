// doctor --osv and the rule known-malicious (decision D-129): one batch query over every locked package version doctor
// reads, an error per package and lockfile with the line, a warning instead of a pass when OSV.dev cannot be reached,
// and nothing sent and nothing reported without --osv.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor, type DoctorReport } from '../../src/doctor/index.ts';
import { runDoctorWithOsv } from '../../src/doctor/osv.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { osvFetch, unreachableOsv } from '../support/osv.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/doctor/known-malicious/fires-npm-and-python/repo', import.meta.url));
const CLEAN = fileURLToPath(new URL('../fixtures/doctor/known-malicious/passes-clean/repo', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-osv-doctor-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const own = (report: DoctorReport) => report.findings.filter((finding) => finding.rule === 'known-malicious');
const result = (report: DoctorReport) => report.checked?.rules.find((entry) => entry.rule === 'known-malicious');

const MAL_NPM = 'MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const MAL_PYPI = 'MAL-2026-18443 (https://osv.dev/vulnerability/MAL-2026-18443)';
const WHEEL = 'https://files.pythonhosted.org/packages/00/00/wallet_tracking-1.0.0-py3-none-any.whl';

/** One lockfile of each format doctor reads, each locking a version with a MAL- record. */
const FORMATS: [string, Record<string, string>, string][] = [
  [
    'pnpm-lock.yaml',
    {
      'package.json': '{"name":"app","version":"1.0.0"}\n',
      'pnpm-lock.yaml':
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      cutekitten-test:\n        specifier: 1.0.1\n        version: 1.0.1\n\npackages:\n\n  cutekitten-test@1.0.1:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  cutekitten-test@1.0.1: {}\n",
    },
    `pnpm-lock.yaml locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'yarn.lock',
    {
      'package.json': '{"name":"app","version":"1.0.0","packageManager":"yarn@4.9.1"}\n',
      'yarn.lock':
        '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n\n"cutekitten-test@npm:1.0.1":\n  version: 1.0.1\n  resolution: "cutekitten-test@npm:1.0.1"\n  checksum: 10c0/00\n  languageName: node\n  linkType: hard\n',
    },
    `yarn.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'bun.lock',
    {
      'package.json': '{"name":"app","version":"1.0.0"}\n',
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {\n    "cutekitten-test": ["cutekitten-test@1.0.1", "", {}, "sha512-AAAA"],\n  }\n}\n',
    },
    `bun.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'deno.lock',
    {
      'deno.json': '{}\n',
      'deno.lock': '{\n  "version": "5",\n  "npm": {\n    "cutekitten-test@1.0.1": { "integrity": "sha512-AAAA" }\n  }\n}\n',
    },
    `deno.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'poetry.lock',
    {
      'pyproject.toml': '[tool.poetry]\nname = "app"\n',
      'poetry.lock': `[[package]]\nname = "wallet-tracking"\nversion = "1.0.0"\nfiles = [\n    {file = "wallet_tracking-1.0.0-py3-none-any.whl", hash = "sha256:00"},\n]\n`,
    },
    `poetry.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'pdm.lock',
    {
      'pyproject.toml': '[project]\nname = "app"\n',
      'pdm.lock': `[metadata]\nlock_version = "4.5.1"\n\n[[package]]\nname = "wallet-tracking"\nversion = "1.0.0"\nfiles = [\n    {file = "wallet_tracking-1.0.0-py3-none-any.whl", hash = "sha256:00"},\n]\n`,
    },
    `pdm.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'Pipfile.lock',
    {
      Pipfile: '[packages]\nwallet-tracking = "==1.0.0"\n',
      'Pipfile.lock': '{\n  "_meta": {},\n  "default": {\n    "wallet-tracking": {\n      "hashes": ["sha256:00"],\n      "version": "==1.0.0"\n    }\n  }\n}\n',
    },
    `Pipfile.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'requirements.txt',
    { 'requirements.txt': 'Wallet_Tracking==1.0.0 \\\n    --hash=sha256:00\n' },
    `requirements.txt locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'pylock.toml',
    {
      'pylock.toml': `lock-version = "1.0"\ncreated-by = "pip"\n\n[[packages]]\nname = "wallet-tracking"\nversion = "1.0.0"\nindex = "https://pypi.org/simple"\nwheels = [{ url = "${WHEEL}", hashes = { sha256 = "00" } }]\n`,
    },
    `pylock.toml locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
];

describe('doctor --osv: known-malicious', () => {
  it('reports a locked version with a MAL- record, once per package and lockfile, with the line', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch });
    expect(own(report).map((finding) => [finding.level, finding.location.file, finding.location.line])).toEqual([
      ['error', 'package-lock.json', 15],
      ['error', 'uv.lock', 22],
    ]);
    expect(result(report)).toMatchObject({ result: 'problems', errors: 2, warnings: 0 });
    // One batch for every locked version of the repository, each version once; the project itself is not a package.
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]).toEqual(
      expect.arrayContaining([
        { package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' },
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' },
        { package: { name: 'requests', ecosystem: 'PyPI' }, version: '2.34.2' },
        { package: { name: 'wallet-tracking', ecosystem: 'PyPI' }, version: '1.0.0' },
      ]),
    );
    expect(fetch.requests[0]).toHaveLength(4);
  });

  it.each(FORMATS)('reads the locked versions of %s', async (_name, files, message) => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository(files), {}, { fetch });
    expect(own(report).map((finding) => finding.message)).toEqual([message]);
    expect(own(report)[0]?.location.line).toEqual(expect.any(Number));
  });

  it('says which requirements it could not check because they pin no exact version', async () => {
    const report = await runDoctorWithOsv(repository({ 'requirements.txt': 'requests>=2\nwallet-tracking==1.0.*\nidna==3.10\n' }), {}, { fetch: osvFetch() });
    expect(own(report)).toEqual([]);
    expect(report.notices).toContainEqual(
      expect.objectContaining({
        code: 'known-malicious',
        location: { file: 'requirements.txt' },
        message: 'known-malicious did not check 2 packages of requirements.txt, which pins no exact version of them',
        fix: 'Pin exact versions (name==version), for example with a lockfile exported by the tool that resolves them, so that doctor --osv can check them',
      }),
    );
  });

  it('reports the same version in two lockfiles in each of them, and asks for it once', async () => {
    const lock = (name: string) => `{"name":"${name}","lockfileVersion":3,"packages":{"":{"name":"${name}"},"node_modules/cutekitten-test":{"version":"1.0.1","resolved":"https://registry.npmjs.org/cutekitten-test/-/cutekitten-test-1.0.1.tgz"}}}\n`;
    const root = repository({
      'depcurfew.json': JSON.stringify({ version: 1, projects: ['frontend'] }),
      'package.json': '{"name":"root"}\n',
      'package-lock.json': lock('root'),
      'frontend/package.json': '{"name":"frontend"}\n',
      'frontend/package-lock.json': lock('frontend'),
    });
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(own(report).map((finding) => finding.location.file)).toEqual(['frontend/package-lock.json', 'package-lock.json']);
    expect(fetch.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]]);
  });

  it('gives a warning per lockfile instead of passing when OSV.dev cannot be reached', async () => {
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch: unreachableOsv() });
    expect(own(report)).toEqual([
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'package-lock.json' },
        message: 'the 2 package versions locked in package-lock.json were not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)',
        fix: 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it',
      },
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'uv.lock' },
        message: 'the 2 package versions locked in uv.lock were not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)',
        fix: 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it',
      },
    ]);
    expect(result(report)?.result).toBe('problems');
  });

  it('says how many versions were left out when the repository locks more than doctor asks about', async () => {
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch: osvFetch(), limit: 3 });
    const warning = own(report).find((finding) => finding.level === 'warning');
    expect(warning?.message).toBe(
      '1 of the 2 package versions locked in uv.lock was not checked for known malicious versions in OSV.dev: there are more than 3 package versions to check, and depcurfew asks OSV.dev about at most 3 in one run',
    );
  });

  it('passes a repository whose locked versions have no MAL- record', async () => {
    const report = await runDoctorWithOsv(CLEAN, {}, { fetch: osvFetch() });
    expect(own(report)).toEqual([]);
    expect(result(report)?.result).toBe('passed');
  });

  it('does not apply to a repository without a lockfile, and asks nothing', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': '{"name":"app"}\n' }), {}, { fetch });
    expect(result(report)?.result).toBe('not-applicable');
    expect(fetch.requests).toEqual([]);
  });

  it('does not run without --osv: nothing is sent, nothing is reported, and the check is not applicable', () => {
    const report = runDoctor(FIXTURE);
    expect(own(report)).toEqual([]);
    expect(result(report)).toMatchObject({ result: 'not-applicable', check: 'With --osv: no locked package version is a known malicious version in OSV.dev' });
  });
});

describe('depcurfew doctor --osv', () => {
  async function exec(argv: string[], fetch: FetchLike) {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { fetch, now: () => new Date('2026-11-02T12:00:00Z'), stdin: async () => '' });
    return { code, stdout, stderr };
  }

  it('fails on a known malicious version and reports it in JSON with schemaVersion 1', async () => {
    const fetch = osvFetch();
    const result = await exec(['doctor', '--osv', '--json', FIXTURE], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as DoctorReport & { summary: Record<string, number> };
    expect(document.schemaVersion).toBe(1);
    expect(document.findings.filter((finding) => finding.rule === 'known-malicious')).toHaveLength(2);
    expect(result.stderr).toBe('');
  });

  it('names the rule in SARIF', async () => {
    const result = await exec(['doctor', '--osv', '--sarif', FIXTURE], osvFetch());
    const sarif = JSON.parse(result.stdout) as { runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; message: { text: string } }[] }[] };
    expect(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toContain('known-malicious');
    expect(sarif.runs[0]?.results.filter((entry) => entry.ruleId === 'known-malicious')).toHaveLength(2);
  });

  it('shows the findings in the text with the level word and the fix', async () => {
    const result = await exec(['doctor', '--osv', FIXTURE], osvFetch());
    expect(result.stdout).toContain(`  15: error package-lock.json locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM} (known-malicious)\n    fix: Remove cutekitten-test@1.0.1`);
    expect(result.stdout).toMatch(/ {4}2 errors +With --osv: no locked package version is a known malicious version in OSV\.dev \[known-malicious\]/u);
  });

  it('sends nothing without --osv', async () => {
    const fetch = osvFetch();
    const result = await exec(['doctor', '--json', FIXTURE], fetch);
    expect(result.code).toBe(EXIT_OK);
    expect(fetch.requests).toEqual([]);
  });
});
