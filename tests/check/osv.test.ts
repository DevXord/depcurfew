// The OSV.dev client of --osv (decision D-129): one batch query per 1000 package versions, the pages of a paged result,
// only MAL- records count, and every way the lookup can fail leaves the version unchecked with the reason, never clean.
import { describe, expect, it } from 'vitest';
import { linkedIds, MAX_OSV_PAGES, osvKey, osvRecordPage, queryOsv, type OsvPackage } from '../../src/check/osv.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { OSV_BATCH_URL, osvFetch, unreachableOsv } from '../support/osv.ts';

const MALICIOUS: OsvPackage = { ecosystem: 'npm', name: 'cutekitten-test', version: '1.0.1' };
const VULNERABLE: OsvPackage = { ecosystem: 'npm', name: 'lodash', version: '4.17.21' };
const CLEAN: OsvPackage = { ecosystem: 'npm', name: 'lodash', version: '4.18.1' };
const PYTHON: OsvPackage = { ecosystem: 'pypi', name: 'wallet-tracking', version: '1.0.0' };

type Query = { package: { name: string; ecosystem: string }; version: string; page_token?: string };

/** A fetch that answers each batch request with `answer` of its queries and keeps the requests. */
function answering(answer: (queries: Query[], round: number) => Response | Promise<Response>): FetchLike & { requests: { url: string; init: Parameters<FetchLike>[1]; queries: Query[] }[] } {
  const requests: { url: string; init: Parameters<FetchLike>[1]; queries: Query[] }[] = [];
  const fetch = (async (url: string, init: Parameters<FetchLike>[1]) => {
    const queries = (JSON.parse(init.body ?? '{}') as { queries: Query[] }).queries;
    requests.push({ url, init, queries });
    return answer(queries, requests.length);
  }) as FetchLike & { requests: typeof requests };
  fetch.requests = requests;
  return fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('queryOsv', () => {
  it('sends one batch query by name, ecosystem and version and counts only MAL- records', async () => {
    const fetch = osvFetch();
    const verdicts = await queryOsv([MALICIOUS, VULNERABLE, CLEAN, PYTHON], { fetch });
    expect(verdicts).toEqual([
      { status: 'checked', malicious: ['MAL-2026-18458'] },
      // GHSA-xxjr-mmjv-4gpg is a vulnerability, not a malware record.
      { status: 'checked', malicious: [] },
      { status: 'checked', malicious: [] },
      { status: 'checked', malicious: ['MAL-2026-18443'] },
    ]);
    expect(fetch.requests).toEqual([
      [
        { package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' },
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' },
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.18.1' },
        { package: { name: 'wallet-tracking', ecosystem: 'PyPI' }, version: '1.0.0' },
      ],
    ]);
  });

  it('posts JSON to the batch endpoint and does not follow redirects', async () => {
    const fetch = answering((queries) => json({ results: queries.map(() => ({})) }));
    await queryOsv([CLEAN], { fetch });
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.url).toBe(OSV_BATCH_URL);
    expect(fetch.requests[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' } });
  });

  it('asks once for a version listed twice and answers both', async () => {
    const fetch = osvFetch();
    const verdicts = await queryOsv([MALICIOUS, CLEAN, MALICIOUS], { fetch });
    expect(fetch.requests[0]).toHaveLength(2);
    expect(verdicts[0]).toEqual(verdicts[2]);
  });

  it('asks nothing for no packages', async () => {
    const fetch = osvFetch();
    expect(await queryOsv([], { fetch })).toEqual([]);
    expect(fetch.requests).toEqual([]);
  });

  it('splits more than 1000 versions into batches of at most 1000 queries', async () => {
    const fetch = answering((queries) => json({ results: queries.map(() => ({})) }));
    const packages = Array.from({ length: 2500 }, (_, index) => ({ ecosystem: 'npm', name: `p${index}`, version: '1.0.0' }));
    const verdicts = await queryOsv(packages, { fetch });
    expect(fetch.requests.map((request) => request.queries.length)).toEqual([1000, 1000, 500]);
    expect(verdicts.every((verdict) => verdict.status === 'checked')).toBe(true);
  });

  it('follows next_page_token for the queries that have one, and finds a MAL- record on a later page', async () => {
    const fetch = answering((queries, round) => {
      if (round === 1) return json({ results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', modified: '2026-01-01T00:00:00Z' }], next_page_token: 'token-1' }, {}] });
      return json({ results: queries.map(() => ({ vulns: [{ id: 'MAL-2026-1', modified: '2026-01-01T00:00:00Z' }] })) });
    });
    const verdicts = await queryOsv([MALICIOUS, CLEAN], { fetch });
    expect(fetch.requests[1]?.queries).toEqual([{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1', page_token: 'token-1' }]);
    expect(verdicts).toEqual([
      { status: 'checked', malicious: ['MAL-2026-1'] },
      { status: 'checked', malicious: [] },
    ]);
  });

  it('keeps asking when a page holds only a token, as the API documents for slow queries', async () => {
    const fetch = answering((_queries, round) => json({ results: [round < 3 ? { next_page_token: `t${round}` } : { vulns: [{ id: 'MAL-2026-2', modified: '2026-01-01T00:00:00Z' }] }] }));
    expect(await queryOsv([MALICIOUS], { fetch })).toEqual([{ status: 'checked', malicious: ['MAL-2026-2'] }]);
    expect(fetch.requests).toHaveLength(3);
  });

  it('leaves a version unchecked when its pages do not end', async () => {
    const fetch = answering((queries) => json({ results: queries.map(() => ({ next_page_token: 'again' })) }));
    const [verdict] = await queryOsv([MALICIOUS], { fetch });
    expect(fetch.requests).toHaveLength(MAX_OSV_PAGES);
    expect(verdict).toEqual({ status: 'unchecked', reason: `OSV.dev answered more than ${MAX_OSV_PAGES} pages for it` });
  });

  it('skips a withdrawn record, which the API leaves out of query answers anyway', async () => {
    const fetch = answering(() => json({ results: [{ vulns: [{ id: 'MAL-2026-3', modified: '2026-01-01T00:00:00Z', withdrawn: '2026-02-01T00:00:00Z' }] }] }));
    expect(await queryOsv([MALICIOUS], { fetch })).toEqual([{ status: 'checked', malicious: [] }]);
  });

  it('leaves every version unchecked when OSV.dev cannot be reached, and stops after the first batch', async () => {
    const fetch = unreachableOsv();
    const packages = Array.from({ length: 1500 }, (_, index) => ({ ecosystem: 'npm', name: `p${index}`, version: '1.0.0' }));
    const verdicts = await queryOsv(packages, { fetch });
    expect(fetch.requests).toHaveLength(1);
    expect(new Set(verdicts.map((verdict) => JSON.stringify(verdict)))).toEqual(new Set([JSON.stringify({ status: 'unchecked', reason: 'api.osv.dev cannot be reached (fetch failed)' })]));
  });

  it.each([
    ['an HTTP error', () => new Response('unavailable', { status: 503 }), 'api.osv.dev answered HTTP 503'],
    ['a redirect, which is not followed', () => new Response(null, { status: 302, headers: { location: 'https://example.com/x' } }), 'api.osv.dev redirected to https://example.com, which depcurfew does not follow'],
    ['text that is not JSON', () => new Response('<html>', { status: 200 }), 'api.osv.dev answered something that is not a batch result'],
    ['another number of results', () => json({ results: [] }), 'api.osv.dev answered something that is not a batch result'],
    ['a result that is not an object', () => json({ results: ['x'] }), 'api.osv.dev answered something that is not a batch result'],
  ])('leaves the version unchecked on %s', async (_name, answer, reason) => {
    expect(await queryOsv([MALICIOUS], { fetch: answering(answer) })).toEqual([{ status: 'unchecked', reason }]);
  });

  it('leaves the version unchecked when the answer is larger than the limit', async () => {
    const fetch = answering(() => json({ results: [{ vulns: [{ id: 'GHSA-x', modified: 'x'.repeat(1024 * 1024) }] }] }));
    expect(await queryOsv([MALICIOUS], { fetch, maxBytes: 1024 * 1024 })).toEqual([{ status: 'unchecked', reason: 'the answer of api.osv.dev is larger than 1 MiB' }]);
  });

  it('leaves the version unchecked when OSV.dev does not answer in time', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason as Error)));
    expect(await queryOsv([MALICIOUS], { fetch, timeoutMs: 10 })).toEqual([{ status: 'unchecked', reason: 'api.osv.dev did not answer in time' }]);
  });

  it('rejects when the caller cancels, as a cancelled call of depcurfew mcp does', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason as Error));
        controller.abort(new Error('cancelled'));
      });
    await expect(queryOsv([MALICIOUS], { fetch, signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('checks at most `limit` versions and says why the others were not checked', async () => {
    const fetch = osvFetch();
    const verdicts = await queryOsv([MALICIOUS, CLEAN, PYTHON], { fetch, limit: 2 });
    expect(verdicts[2]).toEqual({ status: 'unchecked', reason: 'there are more than 2 package versions to check, and depcurfew asks OSV.dev about at most 2 in one run' });
    expect(fetch.requests[0]).toHaveLength(2);
  });

  it('leaves a version of an ecosystem without an OSV name unchecked, and asks nothing for it', async () => {
    const fetch = osvFetch();
    const [verdict] = await queryOsv([{ ecosystem: 'cargo', name: 'x', version: '1.0.0' }], { fetch });
    expect(verdict).toEqual({ status: 'unchecked', reason: 'depcurfew does not know the name OSV.dev gives the ecosystem cargo' });
    expect(fetch.requests).toEqual([]);
  });

  it('cuts a long record id and names at most five records', async () => {
    const vulns = Array.from({ length: 7 }, (_, index) => ({ id: `MAL-2026-${index}`, modified: '2026-01-01T00:00:00Z' }));
    const fetch = answering(() => json({ results: [{ vulns: [{ id: `MAL-${'9'.repeat(500)}`, modified: '2026-01-01T00:00:00Z' }, ...vulns] }] }));
    const [verdict] = await queryOsv([MALICIOUS], { fetch });
    expect(verdict?.status === 'checked' ? verdict.malicious[0] : undefined).toHaveLength(100);
    expect(linkedIds(['MAL-1', 'MAL-2', 'MAL-3', 'MAL-4', 'MAL-5', 'MAL-6', 'MAL-7'])).toBe(
      'MAL-1 (https://osv.dev/vulnerability/MAL-1), MAL-2 (https://osv.dev/vulnerability/MAL-2), MAL-3 (https://osv.dev/vulnerability/MAL-3), MAL-4 (https://osv.dev/vulnerability/MAL-4), MAL-5 (https://osv.dev/vulnerability/MAL-5) and 2 more records',
    );
  });

  it('links a record to its page on osv.dev and keys a package by ecosystem, name and version', () => {
    expect(osvRecordPage('MAL-2026-18458')).toBe('https://osv.dev/vulnerability/MAL-2026-18458');
    expect(osvRecordPage('a/b')).toBe('https://osv.dev/vulnerability/a%2Fb');
    expect(osvKey(MALICIOUS)).not.toBe(osvKey({ ...MALICIOUS, version: '1.0.0' }));
    expect(osvKey(PYTHON)).toBe(osvKey({ ...PYTHON, name: 'Wallet_Tracking' }));
  });
});
