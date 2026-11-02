// A fetch that answers the batch queries of OSV.dev from tests/fixtures/osv/querybatch.json and passes every other
// request on (to the recorded npm registry and PyPI by default), so the tests of --osv run without network access.
// A query the fixture does not hold gets {}, the answer of the API for a version without records. Every batch request
// is kept, so that a test can see what was sent.
import { readFileSync } from 'node:fs';
import type { FetchLike } from '../../src/check/registry.ts';
import { recordedFetch } from '../check/support.ts';

export const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';

interface Query {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/osv/querybatch.json', import.meta.url), 'utf8')) as { queries: Query[]; response: { results: unknown[] } };

/** PyPI names are matched after PEP 503 normalization, npm names exactly (the API's rule). */
function sameName(ecosystem: string, a: string, b: string): boolean {
  const normalize = (name: string) => (ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/gu, '-') : name);
  return normalize(a) === normalize(b);
}

/** The recorded result for one query, or {} for a version without records. */
export function recordedResult(query: Query): unknown {
  const index = RECORDED.queries.findIndex(
    (entry) => entry.package.ecosystem === query.package.ecosystem && sameName(entry.package.ecosystem, entry.package.name, query.package.name) && entry.version === query.version,
  );
  return index === -1 ? {} : RECORDED.response.results[index];
}

export interface OsvFetch extends FetchLike {
  /** The queries of every batch request, in the order they were sent. */
  requests: Query[][];
}

/** The recorded OSV.dev answers in front of `fallback`. */
export function osvFetch(fallback: FetchLike = recordedFetch): OsvFetch {
  const requests: Query[][] = [];
  const fetch = (async (url, init) => {
    if (url !== OSV_BATCH_URL) return fallback(url, init);
    if (init.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const { queries } = JSON.parse(init.body ?? '{}') as { queries: Query[] };
    requests.push(queries);
    return new Response(JSON.stringify({ results: queries.map(recordedResult) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as OsvFetch;
  fetch.requests = requests;
  return fetch;
}

/** OSV.dev cannot be reached, while the registry answers from the recordings: fetch fails as it does without a network. */
export function unreachableOsv(fallback: FetchLike = recordedFetch): OsvFetch {
  const requests: Query[][] = [];
  const fetch = (async (url, init) => {
    if (url !== OSV_BATCH_URL) return fallback(url, init);
    requests.push((JSON.parse(init.body ?? '{}') as { queries: Query[] }).queries);
    throw new TypeError('fetch failed');
  }) as OsvFetch;
  fetch.requests = requests;
  return fetch;
}

/** A registry document of one npm package with versions published long before the tests' clock, without scripts. */
export function packument(name: string, versions: readonly string[]): unknown {
  const latest = versions.at(-1) ?? '1.0.0';
  return {
    name,
    'dist-tags': { latest },
    time: Object.fromEntries(versions.map((version) => [version, '2026-01-01T00:00:00.000Z'])),
    versions: Object.fromEntries(versions.map((version) => [version, { name, version }])),
  };
}

/** The JSON page of a Python project with one wheel per version, uploaded long before the tests' clock. */
export function pypiPage(name: string, versions: readonly string[]): unknown {
  const file = name.replaceAll('-', '_');
  return {
    name,
    meta: { 'api-version': '1.4' },
    versions,
    files: versions.map((version) => ({ filename: `${file}-${version}-py3-none-any.whl`, 'upload-time': '2026-01-01T00:00:00.000000Z', yanked: false })),
  };
}

/** The recorded registry and PyPI, with the documents of `extra` (by URL) in front. */
export function withDocuments(extra: Readonly<Record<string, unknown>>, fallback: FetchLike = recordedFetch): FetchLike {
  return async (url, init) => (Object.hasOwn(extra, url) ? new Response(JSON.stringify(extra[url]), { status: 200 }) : fallback(url, init));
}
