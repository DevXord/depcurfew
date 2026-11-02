// A fetch that answers from the recorded responses of the npm registry (tests/fixtures/registry/), of PyPI
// (tests/fixtures/pypi/) and of Packagist (tests/fixtures/packagist/), and policies for the tests.
import { existsSync, readFileSync } from 'node:fs';
import type { FetchLike } from '../../src/check/registry.ts';
import { parsePolicy } from '../../src/policy/validate.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';

const RECORDED = new URL('../fixtures/registry/', import.meta.url);
const RECORDED_PYPI = new URL('../fixtures/pypi/', import.meta.url);
const RECORDED_PACKAGIST = new URL('../fixtures/packagist/', import.meta.url);

export const recordedFetch: FetchLike = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname === 'pypi.org') {
    const project = /^\/simple\/([^/]+)\/$/u.exec(parsed.pathname)?.[1] ?? '';
    const page = new URL(`${project}.json`, RECORDED_PYPI);
    if (project === '' || !existsSync(page)) return new Response('Not Found', { status: 404 });
    const body = JSON.parse(readFileSync(page, 'utf8')) as { status?: number };
    return typeof body.status === 'number' ? new Response('Not Found', { status: body.status }) : new Response(JSON.stringify(body), { status: 200 });
  }
  if (parsed.hostname === 'repo.packagist.org') {
    const name = /^\/p2\/([^/]+\/[^/]+)\.json$/u.exec(parsed.pathname)?.[1] ?? '';
    const file = new URL(`${decodeURIComponent(name).replace('/', '__')}.json`, RECORDED_PACKAGIST);
    if (name === '' || !existsSync(file)) return new Response('"404 not found, no packages here"', { status: 404 });
    const body = JSON.parse(readFileSync(file, 'utf8')) as { status?: number };
    return typeof body.status === 'number' ? new Response('"404 not found, no packages here"', { status: body.status }) : new Response(JSON.stringify(body), { status: 200 });
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  const file = new URL(`${name.replace('/', '__')}.json`, RECORDED);
  if (!existsSync(file)) return new Response('{"error":"Not found"}', { status: 404 });
  const body = JSON.parse(readFileSync(file, 'utf8')) as { status?: number };
  return typeof body.status === 'number' ? new Response('{"error":"Not found"}', { status: body.status }) : new Response(JSON.stringify(body), { status: 200 });
};

export function policy(document: object): ResolvedPolicy {
  const result = parsePolicy(JSON.stringify({ version: 1, ...document }));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}
