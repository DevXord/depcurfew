// depcurfew osv update (decision D-150): with a fetch that serves exports built in the test, it asks for nothing but the
// export files, writes the local data, prints what it wrote (also as JSON), and keeps the old data when a download
// fails, is refused or cannot be read; the new data replaces the old in one rename, with no temporary file left.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { LocalOsvData, osvDataFile } from '../../src/osv/data.ts';
import { osvExportUrl, updateOsvData } from '../../src/osv/update.ts';
import { ZIP_LIMITS } from '../../src/osv/zip.ts';
import { exportFetch, standardExports } from '../support/osv-data.ts';
import { buildZip, malRecord } from '../support/zip.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'depcurfew-osv-update-'));
  temporary.push(path);
  return path;
}

async function exec(argv: string[], fetch: FetchLike, data: string | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { fetch, now: () => NOW, stdin: async () => '', osvData: () => data });
  return { code, stdout, stderr };
}

const URLS = {
  npm: 'https://storage.googleapis.com/osv-vulnerabilities/npm/all.zip',
  pypi: 'https://storage.googleapis.com/osv-vulnerabilities/PyPI/all.zip',
  packagist: 'https://storage.googleapis.com/osv-vulnerabilities/Packagist/all.zip',
};

describe('depcurfew osv update', () => {
  it('downloads the export of each ecosystem, from the URLs of the knowledge base, and nothing else', async () => {
    const data = directory();
    const fetch = exportFetch(standardExports());
    const result = await exec(['osv', 'update'], fetch, data);
    expect(result.code).toBe(EXIT_OK);
    expect(fetch.requests).toEqual([URLS.npm, URLS.pypi, URLS.packagist]);
    expect([osvExportUrl('npm'), osvExportUrl('pypi'), osvExportUrl('packagist')]).toEqual([URLS.npm, URLS.pypi, URLS.packagist]);
    expect(result.stdout).toBe(
      [
        `npm: 2 records of known malicious packages from the OSV.dev export of 2026-11-02 06:00 UTC (left out: 1 withdrawn), written to ${osvDataFile(data, 'npm')}`,
        `PyPI: 1 record of known malicious packages from the OSV.dev export of 2026-11-02 06:00 UTC, written to ${osvDataFile(data, 'pypi')}`,
        `Packagist: 1 record of known malicious packages from the OSV.dev export of 2026-11-02 06:00 UTC, written to ${osvDataFile(data, 'packagist')}`,
        '',
      ].join('\n'),
    );
    expect(result.stderr).toBe('');
    expect(readdirSync(data).sort()).toEqual(['npm.jsonl', 'packagist.jsonl', 'pypi.jsonl']);
    const header = JSON.parse(readFileSync(osvDataFile(data, 'npm'), 'utf8').split('\n')[0] as string) as Record<string, unknown>;
    expect(header).toEqual({
      format: 'depcurfew-osv-malicious',
      formatVersion: 1,
      ecosystem: 'npm',
      osvEcosystem: 'npm',
      url: URLS.npm,
      downloadedAt: NOW.toISOString(),
      exportedAt: '2026-11-02T06:00:00.000Z',
      records: 2,
      withdrawn: 1,
      packages: 2,
    });
  });

  it('prints a JSON document with --json, and updates only the ecosystems of --ecosystem', async () => {
    const data = directory();
    const fetch = exportFetch(standardExports());
    const result = await exec(['osv', 'update', '--ecosystem', 'PyPI', '--json'], fetch, data);
    expect(result.code).toBe(EXIT_OK);
    expect(fetch.requests).toEqual([URLS.pypi]);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      directory: data,
      ecosystems: [
        {
          ecosystem: 'pypi',
          status: 'updated',
          file: osvDataFile(data, 'pypi'),
          url: URLS.pypi,
          downloadedAt: NOW.toISOString(),
          exportedAt: '2026-11-02T06:00:00.000Z',
          records: 1,
          withdrawn: 0,
          skipped: 0,
          bytes: standardExports().pypi.length,
        },
      ],
      errors: [],
    });
    expect(result.stderr).toBe('');
  });

  it('keeps the old data when the download fails, and says so with a code and a fix', async () => {
    const data = directory();
    await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch(standardExports()), data);
    const before = readFileSync(osvDataFile(data, 'npm'));
    const failing: FetchLike = async () => new Response('busy', { status: 503 });
    const result = await exec(['osv', 'update', '--ecosystem', 'npm', '--json'], failing, data);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      directory: data,
      ecosystems: [],
      errors: [
        {
          code: 'osv-download-failed',
          level: 'error',
          location: { file: osvDataFile(data, 'npm') },
          ecosystem: 'npm',
          message: `the OSV.dev export for npm cannot be downloaded from ${URLS.npm}: storage.googleapis.com answered HTTP 503; the local data for npm in ${osvDataFile(data, 'npm')} was kept as it was`,
          fix: 'Run depcurfew osv update again when storage.googleapis.com can be reached; it needs HTTPS access to it',
        },
      ],
    });
    expect(readFileSync(osvDataFile(data, 'npm'))).toEqual(before);
    expect(readdirSync(data)).toEqual(['npm.jsonl']);
  });

  it('keeps the old data when the export is not a zip file it reads, and leaves no temporary file', async () => {
    const data = directory();
    await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch(standardExports()), data);
    const before = readFileSync(osvDataFile(data, 'npm'));
    const record = malRecord('MAL-2026-1', 'npm', 'x', { versions: ['1.0.0'] });
    const refused = [
      Buffer.from('<html>not a zip</html>'),
      // An encrypted entry, a zip bomb and a malformed central directory.
      buildZip([{ name: 'MAL-2026-1.json', data: record, flags: 1 }]),
      buildZip([{ name: 'MAL-2026-1.json', data: Buffer.alloc(1024 * 1024, 0x20) }]),
      buildZip([{ name: 'MAL-2026-1.json', data: record }], { offsetShift: 7 }),
    ];
    for (const zip of refused) {
      const result = await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch({ npm: zip }), data);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(new RegExp(`^error: the OSV\\.dev export for npm from ${URLS.npm.replaceAll('.', '\\.')} is not a zip file depcurfew reads: .+; the local data for npm in .+ was kept as it was \\(osv-export-unreadable\\)\\n  fix: Run depcurfew osv update again; if it fails the same way, OSV.dev changed its export and a newer depcurfew may read it\\n$`, 'u'));
      expect(readFileSync(osvDataFile(data, 'npm'))).toEqual(before);
      expect(readdirSync(data)).toEqual(['npm.jsonl']);
    }
  });

  it('refuses a redirect, an export larger than the limit and one that breaks the zip limits', async () => {
    const data = directory();
    const redirect: FetchLike = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/all.zip' } });
    const [redirected] = await updateOsvData({ directory: data, ecosystems: ['npm'], fetch: redirect, now: () => NOW });
    expect(redirected).toMatchObject({ status: 'failed', code: 'osv-download-failed', message: `the OSV.dev export for npm cannot be downloaded from ${URLS.npm}: storage.googleapis.com redirected to https://elsewhere.example, which depcurfew does not follow; there is still no local data for npm` });
    const [large] = await updateOsvData({ directory: data, ecosystems: ['npm'], fetch: exportFetch(standardExports()), now: () => NOW, maxBytes: 100 });
    expect(large).toMatchObject({ status: 'failed', code: 'osv-download-failed', message: expect.stringContaining('it is larger than 100 bytes, more than depcurfew downloads') });
    const [entries] = await updateOsvData({ directory: data, ecosystems: ['npm'], fetch: exportFetch(standardExports()), now: () => NOW, zipLimits: { ...ZIP_LIMITS, entries: 2 } });
    expect(entries).toMatchObject({ status: 'failed', code: 'osv-export-unreadable', message: expect.stringContaining('the zip file has 3 entries, more than the 2 depcurfew reads') });
    expect(readdirSync(data)).toEqual([]);
    // With old data, too many entries keep it.
    await updateOsvData({ directory: data, ecosystems: ['npm'], fetch: exportFetch(standardExports()), now: () => NOW });
    const before = readFileSync(osvDataFile(data, 'npm'));
    const [kept] = await updateOsvData({ directory: data, ecosystems: ['npm'], fetch: exportFetch(standardExports()), now: () => NOW, zipLimits: { ...ZIP_LIMITS, entries: 2 } });
    expect(kept).toMatchObject({ status: 'failed', message: expect.stringContaining(`; the local data for npm in ${osvDataFile(data, 'npm')} was kept as it was`) });
    expect(readFileSync(osvDataFile(data, 'npm'))).toEqual(before);
  });

  it('keeps the old data when the connection ends in the middle of the download', async () => {
    const data = directory();
    await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch(standardExports()), data);
    const before = readFileSync(osvDataFile(data, 'npm'));
    const zip = standardExports().npm;
    const cut: FetchLike = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(zip.subarray(0, 10)));
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(zip.length) } });
    };
    const result = await exec(['osv', 'update', '--ecosystem', 'npm'], cut, data);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('storage.googleapis.com cannot be reached (terminated)');
    expect(readFileSync(osvDataFile(data, 'npm'))).toEqual(before);
    expect(readdirSync(data)).toEqual(['npm.jsonl']);
  });

  it('replaces the old data with the new one, and removes temporary files that a run left a day ago', async () => {
    const data = directory();
    await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch(standardExports()), data);
    expect(new LocalOsvData(data).lookup({ ecosystem: 'npm', name: 'new-malware', version: '1.0.0' })).toEqual([]);
    const abandoned = join(data, '.npm.123.abcdef.zip.part');
    const recent = join(data, '.npm.456.abcdef.zip.part');
    writeFileSync(abandoned, 'partial');
    writeFileSync(recent, 'partial');
    utimesSync(abandoned, new Date('2026-10-31T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
    utimesSync(recent, NOW, NOW);
    const newer = buildZip([{ name: 'MAL-2026-50.json', data: malRecord('MAL-2026-50', 'npm', 'new-malware', { versions: ['1.0.0'] }) }]);
    expect((await exec(['osv', 'update', '--ecosystem', 'npm'], exportFetch({ npm: newer }), data)).code).toBe(EXIT_OK);
    expect(new LocalOsvData(data).lookup({ ecosystem: 'npm', name: 'new-malware', version: '1.0.0' })).toEqual(['MAL-2026-50']);
    expect(new LocalOsvData(data).lookup({ ecosystem: 'npm', name: 'cutekitten-test', version: '1.0.1' })).toEqual([]);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('reports usage errors, also as JSON', async () => {
    const data = directory();
    const fetch = exportFetch(standardExports());
    expect(await exec(['osv'], fetch, data)).toMatchObject({ code: EXIT_USAGE, stderr: "error: 'osv' needs a subcommand: depcurfew osv update (usage)\n  fix: Run 'depcurfew osv --help' for usage\n" });
    expect(await exec(['osv', 'download'], fetch, data)).toMatchObject({ code: EXIT_USAGE, stderr: "error: unknown subcommand 'osv download'; the subcommand is update (usage)\n  fix: Run 'depcurfew osv --help' for usage\n" });
    const json = await exec(['osv', 'update', '--ecosystem', 'cargo', '--json'], fetch, data);
    expect(json.code).toBe(EXIT_USAGE);
    expect(JSON.parse(json.stdout)).toEqual({ schemaVersion: 1, errors: [{ code: 'usage', level: 'error', message: "--ecosystem takes npm, pypi, packagist, not 'cargo'", fix: "Run 'depcurfew osv --help' for usage" }] });
    expect(fetch.requests).toEqual([]);
  });

  it('says when there is no user cache directory', async () => {
    let stdout = '';
    const fetch = exportFetch(standardExports());
    const code = await run(['osv', 'update', '--json'], { stdout: (text) => (stdout += text), stderr: () => {} }, {
      fetch,
      now: () => NOW,
      stdin: async () => '',
      userEnvironment: () => ({ platform: 'linux', home: 'relative/home', env: {} }),
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(JSON.parse(stdout)).toMatchObject({
      directory: null,
      errors: [
        {
          code: 'osv-cache-missing',
          location: { file: 'environment' },
          message: 'depcurfew has no user cache directory for the OSV.dev data: the home directory "relative/home" is not an absolute path, and XDG_CACHE_HOME names none',
        },
      ],
    });
    expect(fetch.requests).toEqual([]);
  });

  it('describes the command and its exit codes in --help', async () => {
    const result = await exec(['osv', '--help'], exportFetch({}), undefined);
    expect(result.stdout).toContain('depcurfew osv update');
    expect(result.stdout).toContain('--ecosystem');
    expect(result.stdout).toContain('no package name and nothing about the project is sent');
  });
});
