// Decision D-182: the popular names that depcurfew check, the hook and depcurfew mcp compare look-alike names with are
// exported as defaultPopularNames(), so that a program that calls checkSpecs without the network (agentcurfew's rule
// mcp-package) reports names that imitate a popular npm package or PyPI project without copying the lists.
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { checkSpecs, defaultPopularNames, PopularNames } from '../../src/index.ts';
import { policy } from './support.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

/** A fetch that refuses every request, as a program does that checks offline. */
function refusing(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    throw new Error('offline');
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

describe('defaultPopularNames (decision D-182)', () => {
  it('gives the popular npm packages and PyPI projects, with the field names of CheckOptions', () => {
    const names = defaultPopularNames();
    expect(Object.keys(names).sort()).toEqual(['popular', 'popularPython']);
    expect(names.popular).toBeInstanceOf(PopularNames);
    expect(names.popularPython).toBeInstanceOf(PopularNames);
    expect(names.popular.has('lodash')).toBe(true);
    expect(names.popularPython.has('requests')).toBe(true);
  });

  it('finds look-alike names in both registries', () => {
    const { popular, popularPython } = defaultPopularNames();
    expect(popular.similar('lodahs')).toEqual({ match: 'lodash', reason: 'edit' });
    expect(popularPython.similar('reqeusts')).toEqual({ match: 'requests', reason: 'edit' });
    // Python names are compared normalized, as the CLI compares them.
    expect(popularPython.similar('typing-extensions')).toBeUndefined();
    expect(popularPython.has('typing-extensions')).toBe(true);
  });

  it('builds the lists once', () => {
    const first = defaultPopularNames();
    const second = defaultPopularNames();
    expect(second.popular).toBe(first.popular);
    expect(second.popularPython).toBe(first.popularPython);
  });

  it('lets checkSpecs report look-alike names offline, before any registry is asked', async () => {
    const fetch = refusing();
    const reports = await checkSpecs(['lodahs', 'pypi:reqeusts'], { ...defaultPopularNames(), policy: policy({ cooldown: { minimum: '3d' } }), fetch, now: NOW, registry: 'https://registry.npmjs.org/' });
    expect(reports.map((report) => report.findings.find((finding) => finding.code === 'similar-name')?.message)).toEqual([
      'the name differs by a letter or two from the popular package lodash; make sure it is the package you want',
      'the name differs by a letter or two from the popular package pypi:requests; make sure it is the package you want',
    ]);
  });
});
