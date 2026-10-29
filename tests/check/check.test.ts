// depgate check on recorded registry responses, with a fixed clock: existence, age against the cooldown, install
// scripts, deprecation, look-alike names, sources and registry errors.
import { describe, expect, it } from 'vitest';
import { checkSpec, checkSpecs, describeAge, pickVersion, type CheckOptions } from '../../src/check/index.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { policy, recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const STRICT = policy({
  cooldown: { minimum: '3d' },
  installScripts: { default: 'deny', allow: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
});

function options(overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    policy: STRICT,
    fetch: recordedFetch,
    now: NOW,
    registry: 'https://registry.npmjs.org/',
    popular: new PopularNames(['cross-env', 'esbuild', 'lodash', 'request', '@types/node']),
    ...overrides,
  };
}

const codes = (findings: { code: string; level: string }[]) => findings.map((finding) => `${finding.level}:${finding.code}`);

describe('depgate check on registry packages', () => {
  it('passes an old package without install scripts', async () => {
    const report = await checkSpec('lodash', options());
    expect(report).toMatchObject({ kind: 'registry', name: 'lodash', findings: [] });
    expect(report.version).toBe(report.latest?.version);
    expect(report.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('reports a name the registry does not know', async () => {
    const report = await checkSpec('this-package-does-not-exist-xyz-123', options());
    expect(codes(report.findings)).toEqual(['error:not-found']);
    expect(report.findings[0]?.message).toContain('may be mistyped or made up');
  });

  it('reports install scripts the policy does not allow', async () => {
    const report = await checkSpec('esbuild@0.28.1', options());
    expect(codes(report.findings)).toEqual(['error:install-scripts']);
    expect(report.findings[0]?.message).toBe('esbuild@0.28.1 runs install scripts (postinstall: node install.js) that depgate.json does not allow');
  });

  it('passes install scripts of an allowed package', async () => {
    const allowed = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } });
    expect((await checkSpec('esbuild', options({ policy: allowed }))).findings).toEqual([]);
  });

  it('reports a version younger than the cooldown and names one that is old enough', async () => {
    const allowed = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } });
    const report = await checkSpec('esbuild', options({ policy: allowed, now: new Date('2026-08-09T20:01:00Z') }));
    expect(codes(report.findings)).toEqual(['error:too-young']);
    expect(report.findings[0]?.message).toBe('esbuild@0.28.2 was published 1 day ago; depgate.json requires 3 days (esbuild@0.28.1 is old enough)');
  });

  it('respects cooldown exclusions', async () => {
    const excluded = policy({ cooldown: { minimum: '3d', exclude: ['esbuild'] }, installScripts: { default: 'allow' } });
    expect((await checkSpec('esbuild', options({ policy: excluded, now: new Date('2026-08-09T20:00:55Z') }))).findings).toEqual([]);
  });

  it('picks versions like npm: tags, ranges and exact versions', async () => {
    const lenient = policy({});
    expect((await checkSpec('esbuild@latest', options({ policy: lenient }))).version).toBe('0.28.2');
    expect((await checkSpec('esbuild@~0.27.0', options({ policy: lenient }))).version).toBe('0.27.7');
    expect((await checkSpec('esbuild@0.27.5', options({ policy: lenient }))).version).toBe('0.27.5');
    expect(codes((await checkSpec('esbuild@^9', options({ policy: lenient }))).findings)).toEqual(['error:no-version']);
    expect(codes((await checkSpec('esbuild@nonexistent-tag', options({ policy: lenient }))).findings)).toEqual(['error:no-version']);
  });

  it('warns about a deprecated version', async () => {
    const report = await checkSpec('request', options());
    expect(codes(report.findings)).toEqual(['warning:deprecated']);
    expect(report.findings[0]?.message).toContain('request has been deprecated');
  });

  it('reports a name that imitates a popular package', async () => {
    const report = await checkSpec('crossenv', options());
    expect(codes(report.findings)).toEqual(['error:similar-name']);
    expect(report.findings[0]?.message).toBe('the name differs only in separators from the popular package cross-env; make sure it is the package you want');
  });

  it('looks up scoped packages', async () => {
    const report = await checkSpec('@types/node', options({ policy: policy({}) }));
    expect(report).toMatchObject({ name: '@types/node', findings: [] });
  });

  it('does not look up packages of a scope that uses another registry', async () => {
    const report = await checkSpec('@corp/tool', options({ scopeRegistries: new Map([['@corp', 'https://npm.corp.example/']]) }));
    expect(codes(report.findings)).toEqual(['error:unverified']);
  });

  it('fails closed when the registry cannot be reached', async () => {
    const report = await checkSpec('lodash', options({ fetch: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) }));
    expect(codes(report.findings)).toEqual(['error:unverified']);
    expect(report.findings[0]?.message).toBe('it cannot be checked: the registry cannot be reached (getaddrinfo ENOTFOUND)');
    const failing = await checkSpec('lodash', options({ fetch: async () => new Response('', { status: 503 }) }));
    expect(failing.findings[0]?.message).toBe('it cannot be checked: the registry answered HTTP 503');
  });

  it('refuses a document over the size limit', async () => {
    const huge = async () => new Response('x', { status: 200, headers: { 'content-length': String(65 * 1024 * 1024) } });
    expect((await checkSpec('lodash', options({ fetch: huge }))).findings[0]?.message).toBe('it cannot be checked: the document is larger than 64 MiB');
  });
});

describe('depgate check on other sources', () => {
  it.each([
    ['github:user/repo', 'error:forbidden-source'],
    ['https://example.com/pkg.tgz', 'error:forbidden-source'],
    ['./vendor/logger', 'warning:unchecked-source'],
    ['shared@workspace:*', 'warning:unchecked-source'],
    ['jsr:@std/path', 'error:unverified'],
    ['two words', 'error:invalid-spec'],
  ])('%s', async (spec, expected) => {
    expect(codes((await checkSpec(spec, options())).findings)).toEqual([expected]);
  });

  it('checks a URL without a tarball extension against the git setting too', async () => {
    const tarballsOnly = policy({ sources: { git: 'deny', remoteTarball: 'allow' } });
    const report = await checkSpec('https://github.com/user/repo', options({ policy: tarballsOnly }));
    expect(report.findings).toEqual([
      { level: 'error', code: 'forbidden-source', message: 'it installs from a URL that may be read as a tarball or a git repository, which depgate.json denies (sources.git)' },
    ]);
    expect(codes((await checkSpec('https://example.com/pkg.tgz', options({ policy: tarballsOnly }))).findings)).toEqual(['warning:unchecked-source']);
  });
});

describe('pickVersion', () => {
  it('reads v1.2.3 and 1.2.3+build as 1.2.3, like npm', () => {
    const packument = { name: 'x', distTags: { latest: '2.0.0' }, time: {}, versions: { '1.2.3': { version: '1.2.3' }, '2.0.0': { version: '2.0.0' } } };
    expect(pickVersion(packument, 'v1.2.3')).toBe('1.2.3');
    expect(pickVersion(packument, '1.2.3+build.5')).toBe('1.2.3');
    expect(pickVersion(packument, '1.2.4')).toBeUndefined();
  });
});

describe('checkSpecs', () => {
  it('looks packages up a few at a time and keeps their order', async () => {
    let running = 0;
    let most = 0;
    const slow: CheckOptions['fetch'] = async (url, init) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return recordedFetch(url, init);
    };
    const specs = ['lodash', 'esbuild', 'request', 'cross-env', 'crossenv', '@types/node', 'lodash@4', 'esbuild@0.28.1'];
    const reports = await checkSpecs(specs, options({ fetch: slow }));
    expect(reports.map((report) => report.spec)).toEqual(specs);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
  });
});

describe('describeAge', () => {
  it.each([
    [0.5, '0 minutes'],
    [59, '59 minutes'],
    [60, '1 hour'],
    [1439, '23 hours'],
    [2880, '2 days'],
  ])('%d minutes', (minutes, expected) => {
    expect(describeAge(minutes)).toBe(expected);
  });
});
