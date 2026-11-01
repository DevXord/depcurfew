// depcurfew check on recorded registry responses, with a fixed clock: existence, age against the cooldown, install
// scripts, deprecation, look-alike names, sources and registry errors.
import { describe, expect, it } from 'vitest';
import { checkSpec, checkSpecs, describeAge, pickVersion, type CheckOptions } from '../../src/check/index.ts';
import { decide } from '../../src/check/hook.ts';
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

describe('depcurfew check on registry packages', () => {
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
    expect(report.findings[0]?.message).toBe('esbuild@0.28.1 runs install scripts (postinstall: "node install.js") that depcurfew.json does not allow');
  });

  it('does not report install scripts the policy denies on purpose (installScripts.deny), and fixes never suggest allowing them', async () => {
    const denied = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [], deny: ['esbuild'] } });
    const report = await checkSpec('esbuild@0.28.1', options({ policy: denied }));
    expect(report.findings).toEqual([]);
    const patterned = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', deny: ['esbu*'] } });
    expect((await checkSpec('esbuild@0.28.1', options({ policy: patterned }))).findings).toEqual([]);
    const pythonName = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', deny: ['pypi:esbuild'] } });
    expect(codes((await checkSpec('esbuild@0.28.1', options({ policy: pythonName }))).findings)).toEqual(['error:install-scripts']);
    // The Claude Code hook lets the install through: blocking its scripts is the package manager's job (doctor checks it).
    expect(decide([report], undefined)).toEqual({ decision: 'none' });
  });

  it('passes install scripts of an allowed package', async () => {
    const allowed = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } });
    expect((await checkSpec('esbuild', options({ policy: allowed }))).findings).toEqual([]);
  });

  it('reports a version younger than the cooldown and names one that is old enough', async () => {
    const allowed = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } });
    const report = await checkSpec('esbuild', options({ policy: allowed, now: new Date('2026-08-09T20:01:00Z') }));
    expect(codes(report.findings)).toEqual(['error:too-young']);
    expect(report.findings[0]?.message).toBe('esbuild@0.28.2 was published 1 day ago; depcurfew.json requires 3 days (esbuild@0.28.1 is old enough)');
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

describe('depcurfew check on other sources', () => {
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
      {
        level: 'error',
        code: 'forbidden-source',
        message: 'it installs from a URL that may be read as a tarball or a git repository, which depcurfew.json denies (sources.git)',
        fix: 'Install the package from the registry instead, or set sources.git to "allow" in depcurfew.json if this source is intended',
      },
    ]);
    expect(codes((await checkSpec('https://example.com/pkg.tgz', options({ policy: tarballsOnly }))).findings)).toEqual(['warning:unchecked-source']);
  });
});

describe('what to do about a finding', () => {
  it('names the version to install instead of a version that is too young', async () => {
    const allowed = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] } });
    const report = await checkSpec('esbuild', options({ policy: allowed, now: new Date('2026-08-09T20:01:00Z') }));
    expect(report.findings[0]?.fix).toBe('Install esbuild@0.28.1 instead, or wait until esbuild@0.28.2 is 3 days old');
  });

  it('points to installScripts.allow for install scripts', async () => {
    const report = await checkSpec('esbuild@0.28.1', options());
    expect(report.findings[0]?.fix).toBe('Pick a package without install scripts, or add esbuild to installScripts.allow in depcurfew.json if you trust them');
  });

  it('points to the sources setting for a denied source', async () => {
    const report = await checkSpec('github:user/repo', options());
    expect(report.findings[0]?.fix).toBe('Install the package from the registry instead, or set sources.git to "allow" in depcurfew.json if this source is intended');
  });

  it.each([
    'this-package-does-not-exist-xyz-123',
    'esbuild@^9',
    'lodahs',
    'github:user/repo',
    'https://example.com/pkg.tgz',
    './vendor/logger',
    'jsr:@std/path',
    'two words',
  ])('every finding for %s says what to do', async (spec) => {
    const lenient = policy({ cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['esbuild'] }, sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' } });
    const report = await checkSpec(spec, options({ policy: lenient }));
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) expect(finding.fix ?? '').toMatch(/^[A-Z].{10,}[^.]$/u);
  });

  it('says what to do when the registry cannot be reached', async () => {
    const report = await checkSpec('lodash', options({ fetch: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) }));
    expect(report.findings[0]?.fix).toBe('Run depcurfew check again when the registry is reachable, or pass --registry with a registry you can reach');
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

describe('pickVersion picks like npm-pick-manifest', () => {
  const packument = {
    name: 'x',
    distTags: { latest: '1.1.0', next: '2.0.0-rc.1', old: '1.0.0' },
    time: {},
    versions: { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' }, '1.2.0': { version: '1.2.0', deprecated: 'use 1.1.0' }, '2.0.0-rc.1': { version: '2.0.0-rc.1' } },
  };

  it('prefers the dist-tag npm is told to prefer for a name without a version and for ranges', () => {
    expect(pickVersion(packument, '')).toBe('1.1.0');
    expect(pickVersion(packument, '', 'next')).toBe('2.0.0-rc.1');
    expect(pickVersion(packument, '*', 'next')).toBe('2.0.0-rc.1');
    expect(pickVersion(packument, '^1', 'old')).toBe('1.0.0');
    // The preferred version must satisfy a range other than *; a prerelease satisfies only a range that names one.
    expect(pickVersion(packument, '^1', 'next')).toBe('1.1.0');
    // A dist-tag the package does not have leaves the highest version that is not deprecated.
    expect(pickVersion(packument, '', 'canary')).toBe('1.1.0');
  });

  it('takes the latest tag for * even when it is a prerelease, as npm does', async () => {
    expect((await checkSpec('crossenv@*', options({ policy: policy({}) }))).version).toBe('0.0.2-security');
    expect((await checkSpec('crossenv@>=0', options({ policy: policy({}) }))).version).toBe('1.0.1');
  });

  it('skips a deprecated tagged version', () => {
    const deprecatedLatest = { ...packument, distTags: { latest: '1.2.0' } };
    expect(pickVersion(deprecatedLatest, '')).toBe('1.1.0');
    expect(pickVersion(deprecatedLatest, 'latest')).toBe('1.2.0');
  });

  it('checks the version of the dist-tag the request names, and says so in the report', async () => {
    const report = await checkSpec({ spec: 'cross-env', tag: 'beta' }, options({ policy: policy({}) }));
    expect(report).toMatchObject({ version: '5.0.0-beta.0', tag: 'beta' });
    const fromNpmrc = await checkSpec('cross-env', options({ policy: policy({}), defaultTag: 'beta' }));
    expect(fromNpmrc).toMatchObject({ version: '5.0.0-beta.0', tag: 'beta' });
    expect((await checkSpec('cross-env', options({ policy: policy({}) }))).tag).toBeUndefined();
  });
});

describe('the registry depcurfew asks', () => {
  const lenient = policy({});
  const answer = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it('follows a redirect within the same registry', async () => {
    const urls: string[] = [];
    const fetch: CheckOptions['fetch'] = async (url, init) => {
      urls.push(url);
      expect(init.redirect).toBe('manual');
      return url === 'https://registry.npmjs.org/lodash' ? answer('/mirror/lodash', 301) : recordedFetch('https://registry.npmjs.org/lodash', init);
    };
    expect((await checkSpec('lodash', options({ policy: lenient, fetch }))).findings).toEqual([]);
    expect(urls).toEqual(['https://registry.npmjs.org/lodash', 'https://registry.npmjs.org/mirror/lodash']);
  });

  it('does not follow a redirect to another host, which could answer for any name', async () => {
    const urls: string[] = [];
    const fetch: CheckOptions['fetch'] = async (url) => {
      urls.push(url);
      return answer('https://evil.example/made-up-name');
    };
    const report = await checkSpec('made-up-name', options({ policy: lenient, fetch }));
    expect(codes(report.findings)).toEqual(['error:unverified']);
    expect(report.findings[0]?.message).toBe(
      'it cannot be checked: the registry redirected to https://evil.example, another host, which depcurfew does not follow: that host could answer for any package',
    );
    expect(report.findings[0]?.fix).toBe('Set the registry URL to the host that serves the packages if you trust it, or check the package there yourself before installing it');
    expect(urls).toEqual(['https://registry.npmjs.org/made-up-name']);
  });

  it('gives up after a few redirects', async () => {
    let count = 0;
    const fetch: CheckOptions['fetch'] = async () => answer(`/again-${count++}`);
    expect((await checkSpec('lodash', options({ policy: lenient, fetch }))).findings[0]?.message).toBe('it cannot be checked: the registry redirected more than 5 times');
  });

  it('never asks a link-local address, where cloud metadata services answer', async () => {
    const urls: string[] = [];
    const fetch: CheckOptions['fetch'] = async (url, init) => {
      urls.push(url);
      return recordedFetch(url, init);
    };
    for (const registry of ['http://169.254.169.254/latest/', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/']) {
      const report = await checkSpec('lodash', options({ policy: lenient, fetch, registry }));
      expect(codes(report.findings)).toEqual(['warning:insecure-registry', 'error:unverified']);
      expect(report.findings[1]?.message).toContain('is a link-local address, where cloud metadata services answer and no registry lives, so depcurfew does not ask it');
    }
    expect(urls).toEqual([]);
  });

  it('warns about a registry reached over plain HTTP', async () => {
    const report = await checkSpec('lodash', options({ policy: lenient, registry: 'http://npm.internal.example/', fetch: async (_url, init) => recordedFetch('https://registry.npmjs.org/lodash', init) }));
    expect(codes(report.findings)).toEqual(['warning:insecure-registry']);
    expect(report.findings[0]).toEqual({
      level: 'warning',
      code: 'insecure-registry',
      message: 'the registry http://npm.internal.example/ is reached over plain HTTP, so anyone on the network path can change what it answers and the package it serves',
      fix: 'Use an https:// URL for the registry',
    });
  });

  it('does not warn about plain HTTP to a registry on this machine, such as a local Verdaccio', async () => {
    for (const registry of ['http://127.0.0.1:4873/', 'http://localhost:4873/', 'http://[::1]:4873/']) {
      const report = await checkSpec('lodash', options({ policy: lenient, registry, fetch: async (_url, init) => recordedFetch('https://registry.npmjs.org/lodash', init) }));
      expect(codes(report.findings)).toEqual([]);
    }
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
