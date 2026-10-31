// depcurfew check on pypi: packages, with recorded index pages (tests/fixtures/pypi/) and a fixed clock: existence, age
// against the cooldown, packages without wheels (built from source), yanked versions, project status, look-alike
// names and sources other than the index.
import { describe, expect, it } from 'vitest';
import { checkSpec, type CheckOptions } from '../../src/check/index.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { policy, recordedFetch } from './support.ts';

const NOW = new Date('2026-10-30T12:00:00Z');
const STRICT = policy({
  cooldown: { minimum: '14d' },
  installScripts: { default: 'deny', allow: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
});

function options(overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    policy: STRICT,
    fetch: recordedFetch,
    now: NOW,
    registry: 'https://registry.npmjs.org/',
    popular: new PopularNames(['lodash']),
    popularPython: new PopularNames(['requests', 'python-dateutil', 'pycrypto']),
    ...overrides,
  };
}

const codes = (findings: { code: string; level: string }[]) => findings.map((finding) => `${finding.level}:${finding.code}`);

/** A fetch that answers one index page for every project. */
function page(body: object): FetchLike {
  return async () => new Response(JSON.stringify({ name: 'demo', meta: { 'api-version': '1.4' }, ...body }), { status: 200 });
}

/** An old final release with a wheel and a source distribution, and a newer pre-release. */
const WITH_PRERELEASE = {
  versions: ['1.0', '2.0rc1'],
  files: [
    { filename: 'demo-1.0-py3-none-any.whl', 'upload-time': '2024-01-01T00:00:00Z', yanked: false },
    { filename: 'demo-1.0.tar.gz', 'upload-time': '2024-01-01T00:00:00Z', yanked: false },
    { filename: 'demo-2.0rc1-py3-none-any.whl', 'upload-time': '2024-06-01T00:00:00Z', yanked: false },
  ],
};

describe('depcurfew check on pypi: packages', () => {
  it('passes an old package with wheels', async () => {
    const report = await checkSpec('pypi:requests', options());
    expect(report).toMatchObject({ spec: 'pypi:requests', kind: 'registry', name: 'pypi:requests', version: '2.34.2', findings: [] });
    expect(report.latest).toEqual({ version: '2.34.2', publishedAt: '2026-05-14T19:25:26.443000Z' });
    expect(report.publishedAt).toBe('2026-05-14T19:25:26.443000Z');
  });

  it('normalizes the name and reads version specifiers and name@latest', async () => {
    expect(await checkSpec('pypi:Requests[socks]>=2.33,<2.34', options())).toMatchObject({ name: 'pypi:requests', version: '2.33.1', findings: [] });
    expect(await checkSpec('pypi:requests@latest', options())).toMatchObject({ version: '2.34.2', findings: [] });
    expect(await checkSpec('pypi:requests@^2.33.0', options())).toMatchObject({ version: '2.34.2', findings: [] });
  });

  it('reports a name the index does not know', async () => {
    const report = await checkSpec('pypi:this-package-does-not-exist-xyz-123', options());
    expect(codes(report.findings)).toEqual(['error:not-found']);
    expect(report.findings[0]?.message).toBe('pypi:this-package-does-not-exist-xyz-123 does not exist in https://pypi.org/simple/; the name may be mistyped or made up');
  });

  it('reports a package without wheels, which is built from source', async () => {
    const report = await checkSpec('pypi:pycrypto', options());
    expect(codes(report.findings)).toEqual(['error:install-scripts']);
    expect(report.findings[0]).toMatchObject({
      message: 'pypi:pycrypto 2.6.1 has no wheel, only a source distribution, so installing it builds it from source and runs its build code, which depcurfew.json does not allow (installScripts)',
      fix: 'Pick a version or package with wheels, or add pypi:pycrypto to installScripts.allow in depcurfew.json if you trust its build',
    });
  });

  it('warns, without an error, that a package denied on purpose and without wheels cannot be installed while building is blocked', async () => {
    const denied = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', deny: ['pypi:PyCrypto'] } });
    const report = await checkSpec('pypi:pycrypto', options({ policy: denied }));
    expect(report.findings).toEqual([
      {
        level: 'warning',
        code: 'install-scripts',
        message:
          'pypi:pycrypto 2.6.1 has no wheel, only a source distribution, and depcurfew.json denies building it (installScripts.deny), so installing it fails where building from source is blocked',
        fix: 'Pick a version or package with wheels, or move pypi:pycrypto from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its build',
      },
    ]);
    expect((await checkSpec('pypi:demo', options({ policy: denied, fetch: page(WITH_PRERELEASE) }))).findings).toEqual([]);
    const forced = await checkSpec({ spec: 'pypi:demo', buildFromSource: true }, options({ policy: policy({ installScripts: { default: 'deny', deny: ['pypi:demo'] } }), fetch: page(WITH_PRERELEASE) }));
    expect(forced.findings).toEqual([
      {
        level: 'error',
        code: 'install-scripts',
        message:
          'pypi:demo 1.0 is built from its source distribution, because the command refuses wheels (no-binary), and runs its build code, which depcurfew.json denies (installScripts.deny)',
        fix: 'Install it from a wheel (leave out --no-binary), or move pypi:demo from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its build',
      },
    ]);
  });

  it('passes a build the policy allows', async () => {
    const allowed = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', allow: ['pypi:pycrypto'] } });
    expect((await checkSpec('pypi:pycrypto', options({ policy: allowed }))).findings).toEqual([]);
  });

  it('reports a version younger than the cooldown and names one that is old enough', async () => {
    const report = await checkSpec('pypi:python-dateutil', options());
    expect(codes(report.findings)).toEqual(['error:too-young']);
    expect(report.findings[0]).toMatchObject({
      message: 'pypi:python-dateutil 3.0.0 was published 8 days ago; depcurfew.json requires 2 weeks (pypi:python-dateutil 2.9.0.post0 is old enough)',
      fix: 'Install pypi:python-dateutil==2.9.0.post0 instead, or wait until pypi:python-dateutil 3.0.0 is 2 weeks old',
    });
  });

  it('respects cooldown exclusions, of Python names only', async () => {
    const excluded = policy({ cooldown: { minimum: '14d', exclude: ['pypi:python-dateutil'] } });
    expect((await checkSpec('pypi:python-dateutil', options({ policy: excluded }))).findings).toEqual([]);
    const npmName = policy({ cooldown: { minimum: '14d', exclude: ['python-dateutil'] } });
    expect(codes((await checkSpec('pypi:python-dateutil', options({ policy: npmName }))).findings)).toEqual(['error:too-young']);
  });

  it('compares the names of the policy after normalization, as doctor does', async () => {
    const excluded = policy({ cooldown: { minimum: '14d', exclude: ['pypi:Python_DateUtil'] } });
    expect((await checkSpec('pypi:python-dateutil', options({ policy: excluded }))).findings).toEqual([]);
    const allowed = policy({ installScripts: { default: 'deny', allow: ['pypi:PyCrypto'] } });
    expect((await checkSpec('pypi:pycrypto', options({ policy: allowed }))).findings).toEqual([]);
    const glob = policy({ installScripts: { default: 'deny', allow: ['pypi:Py_Crypto*'] } });
    expect((await checkSpec('pypi:py.crypto-extra', options({ policy: glob, fetch: page(WITH_PRERELEASE) }))).findings).toEqual([]);
  });

  it('picks a pre-release when the command allows them, and never one when it forbids them', async () => {
    const lenient = policy({});
    expect((await checkSpec('pypi:demo', options({ policy: lenient, fetch: page(WITH_PRERELEASE) }))).version).toBe('1.0');
    const allowed = await checkSpec({ spec: 'pypi:demo', prereleases: 'allow' }, options({ policy: lenient, fetch: page(WITH_PRERELEASE) }));
    expect(allowed).toMatchObject({ version: '2.0rc1', prereleases: 'allow' });
    const denied = await checkSpec({ spec: 'pypi:demo==2.0rc1', prereleases: 'deny' }, options({ policy: lenient, fetch: page(WITH_PRERELEASE) }));
    expect(codes(denied.findings)).toEqual(['error:no-version']);
  });

  it('treats a package the command builds from source like one without wheels', async () => {
    const strict = policy({ installScripts: { default: 'deny' } });
    expect((await checkSpec('pypi:demo', options({ policy: strict, fetch: page(WITH_PRERELEASE) }))).findings).toEqual([]);
    const built = await checkSpec({ spec: 'pypi:demo', buildFromSource: true }, options({ policy: strict, fetch: page(WITH_PRERELEASE) }));
    expect(codes(built.findings)).toEqual(['error:install-scripts']);
    expect(built.findings[0]?.message).toBe(
      'pypi:demo 1.0 is built from its source distribution, because the command refuses wheels (no-binary), and runs its build code, which depcurfew.json does not allow (installScripts)',
    );
    expect(built.buildFromSource).toBe(true);
  });

  it('does not follow an index that redirects to another host', async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/simple/requests/' } });
    const report = await checkSpec('pypi:requests', options({ fetch }));
    expect(report.findings.at(-1)?.message).toBe('it cannot be checked: the index redirected to https://evil.example, another host, which depcurfew does not follow: that host could answer for any package');
  });

  it('warns about a pinned yanked version, and leaves yanked versions out otherwise', async () => {
    const pinned = await checkSpec('pypi:requests==2.32.0', options());
    expect(codes(pinned.findings)).toEqual(['warning:yanked']);
    expect(pinned.findings[0]?.message).toBe('pypi:requests 2.32.0 is yanked: Yanked due to conflicts with CVE-2024-35195 mitigation');
    const range = await checkSpec('pypi:requests>=2.32.0,<2.32.2', options());
    expect(codes(range.findings)).toEqual(['error:no-version']);
    expect(range.findings[0]?.message).toBe('no version of pypi:requests matches ">=2.32.0,<2.32.2" (only yanked versions do)');
  });

  it('reports a specifier no version matches', async () => {
    const report = await checkSpec('pypi:requests>=3', options());
    expect(codes(report.findings)).toEqual(['error:no-version']);
    expect(report.findings[0]?.fix).toBe('Pick a version of pypi:requests that exists, such as pypi:requests==2.34.2');
  });

  it('flags names close to a popular project', async () => {
    const typo = await checkSpec('pypi:reqeusts', options());
    expect(codes(typo.findings)).toEqual(['error:similar-name', 'error:not-found']);
    expect(typo.findings[0]?.message).toBe('the name differs by a letter or two from the popular package pypi:requests; make sure it is the package you want');
    const separators = await checkSpec('pypi:pythondateutil', options());
    expect(codes(separators.findings)).toEqual(['error:similar-name', 'error:not-found']);
    // Names that normalize to the same project are the same package.
    expect((await checkSpec('pypi:Python_DateUtil==2.9.0.post0', options())).findings).toEqual([]);
  });

  it('checks sources other than the index against the policy', async () => {
    const git = await checkSpec('pypi:git+https://github.com/psf/requests', options());
    expect(codes(git.findings)).toEqual(['error:forbidden-source']);
    expect(git.findings[0]?.message).toBe('it installs from a git repository, which depcurfew.json denies (sources.git)');
    const url = await checkSpec('pypi:https://example.com/demo-1.0-py3-none-any.whl', options());
    expect(url.findings[0]?.message).toBe('it installs from an archive URL, which depcurfew.json denies (sources.remoteTarball)');
    expect(codes((await checkSpec('pypi:./lib', options())).findings)).toEqual(['warning:unchecked-source']);
    expect(codes((await checkSpec('pypi:.', options())).findings)).toEqual(['warning:unchecked-source']);
    expect(codes((await checkSpec('pypi:hg+https://hg.example.com/demo', options())).findings)).toEqual(['error:unverified']);
  });

  it('rejects text that is not a Python package spec', async () => {
    const report = await checkSpec('pypi:>=2', options());
    expect(report).toMatchObject({ kind: 'invalid', findings: [{ level: 'error', code: 'invalid-spec' }] });
    expect(report.findings[0]?.fix).toBe('Write it as pypi:name, pypi:name==version or pypi:name>=version');
  });

  it('reports the project status', async () => {
    const quarantined = await checkSpec('pypi:demo', options({ fetch: page({ versions: [], files: [], 'project-status': { status: 'quarantined', reason: 'malware' } }) }));
    expect(codes(quarantined.findings)).toEqual(['error:quarantined']);
    expect(quarantined.findings[0]?.message).toBe('pypi:demo is quarantined by the index, which considers it unsafe: malware');
    const files = { versions: ['1.0'], files: [{ filename: 'demo-1.0-py3-none-any.whl', 'upload-time': '2020-01-01T00:00:00Z' }] };
    const archived = await checkSpec('pypi:demo', options({ fetch: page({ ...files, 'project-status': { status: 'archived' } }) }));
    expect(codes(archived.findings)).toEqual(['warning:archived']);
    const deprecated = await checkSpec('pypi:demo', options({ fetch: page({ ...files, 'project-status': { status: 'deprecated', reason: 'use demo2' } }) }));
    expect(codes(deprecated.findings)).toEqual(['warning:deprecated']);
    expect(deprecated.findings[0]?.message).toBe('pypi:demo is deprecated: use demo2');
  });

  it('measures the age by the newest file of the version', async () => {
    const files = [
      { filename: 'demo-1.0.tar.gz', 'upload-time': '2020-01-01T00:00:00Z' },
      { filename: 'demo-1.0-cp313-cp313-manylinux_2_17_x86_64.whl', 'upload-time': '2026-10-29T12:00:00Z' },
    ];
    const report = await checkSpec('pypi:demo', options({ fetch: page({ versions: ['1.0'], files }) }));
    expect(codes(report.findings)).toEqual(['error:too-young']);
    expect(report.findings[0]?.message).toBe(
      'pypi:demo 1.0 was published 2494 days ago, but its file demo-1.0-cp313-cp313-manylinux_2_17_x86_64.whl was uploaded 1 day ago; depcurfew.json requires 2 weeks',
    );
    expect(report.publishedAt).toBe('2020-01-01T00:00:00Z');
  });

  it('cannot vouch for a version without upload times', async () => {
    const report = await checkSpec('pypi:demo', options({ fetch: page({ versions: ['1.0'], files: [{ filename: 'demo-1.0-py3-none-any.whl' }] }) }));
    expect(codes(report.findings)).toEqual(['error:unverified']);
    expect(report.findings[0]?.message).toBe('the index gives no upload time for a file of pypi:demo 1.0, so its age cannot be checked');
  });

  it('cannot vouch for a package when the index fails', async () => {
    const failing: FetchLike = async () => new Response('down', { status: 503 });
    const report = await checkSpec('pypi:requests', options({ fetch: failing }));
    expect(codes(report.findings)).toEqual(['error:unverified']);
    expect(report.findings[0]?.message).toBe('it cannot be checked: the index answered HTTP 503');
  });
});
