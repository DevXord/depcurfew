// The local OSV.dev data of depcurfew osv update in tests (decision D-150): a fetch that serves exports built in the
// test (tests/support/zip.ts) at the URLs of the knowledge base, and a helper that writes the local data of an
// ecosystem through updateOsvData, as depcurfew osv update does. Every request is kept, so that a test can see that
// nothing else was asked.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../../src/check/registry.ts';
import type { OsvDataEcosystem } from '../../src/osv/data.ts';
import { osvExportUrl, updateOsvData } from '../../src/osv/update.ts';
import { buildZip, malRecord } from './zip.ts';

export const EXPORT_DATE = 'Mon, 02 Nov 2026 06:00:00 GMT';

export interface ExportFetch extends FetchLike {
  /** The URLs asked for, in order. */
  requests: string[];
}

/** Serves the zip of each ecosystem at its export URL (with Last-Modified), and 404 for any other URL. */
export function exportFetch(zips: Partial<Record<OsvDataEcosystem, Buffer>>, headers: Record<string, string> = { 'last-modified': EXPORT_DATE }): ExportFetch {
  const requests: string[] = [];
  const fetch = (async (url: string) => {
    requests.push(url);
    for (const [ecosystem, zip] of Object.entries(zips)) {
      if (url === osvExportUrl(ecosystem)) return new Response(new Uint8Array(zip), { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(zip.length), ...headers } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as ExportFetch;
  fetch.requests = requests;
  return fetch;
}

/** The records the tests of check, the hook, mcp and doctor find in the local data. */
export const NPM_RECORDS = [
  malRecord('MAL-2026-18458', 'npm', 'cutekitten-test', { ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.1' }] }] }),
  malRecord('MAL-2026-90001', 'npm', 'left-pad', { versions: ['9.9.9'] }),
  // Withdrawn: a false positive, which is never reported.
  malRecord('MAL-2026-90002', 'npm', 'lodash', { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }, { withdrawn: '2026-10-02T00:00:00Z' }),
];
export const PYPI_RECORDS = [malRecord('MAL-2026-18443', 'PyPI', 'wallet-tracking', { versions: ['1.0.0'] })];
export const PACKAGIST_RECORDS = [malRecord('MAL-2026-3637', 'Packagist', 'intercom/intercom-php', { versions: ['5.0.2'] })];

/** The exports of the three ecosystems with the records above. */
export function standardExports(): Record<OsvDataEcosystem, Buffer> {
  const zip = (records: readonly string[]) => buildZip(records.map((record) => ({ name: `${(JSON.parse(record) as { id: string }).id}.json`, data: record })));
  return { npm: zip(NPM_RECORDS), pypi: zip(PYPI_RECORDS), packagist: zip(PACKAGIST_RECORDS) };
}

/**
 * A new directory with the local data of the ecosystems, written by updateOsvData from `exports` (the standard ones by
 * default) as if downloaded at `now`; `temporary` collects it for removal.
 */
export async function localData(temporary: string[], now: Date, exports: Partial<Record<OsvDataEcosystem, Buffer>> = standardExports(), headers?: Record<string, string>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-osv-data-'));
  temporary.push(directory);
  const results = await updateOsvData({ directory, ecosystems: Object.keys(exports) as OsvDataEcosystem[], fetch: exportFetch(exports, headers), now: () => now });
  const failed = results.find((result) => result.status === 'failed');
  if (failed !== undefined) throw new Error(`the test data was not written: ${JSON.stringify(failed)}`);
  return directory;
}
