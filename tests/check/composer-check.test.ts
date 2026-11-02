// depcurfew check on composer: packages (decision D-133), with the recorded Packagist metadata (tests/fixtures/packagist/)
// and a fixed clock: existence, the version a constraint picks, its age from published-time against the cooldown,
// branches and dev versions, plugins, abandoned packages, platform packages and what Packagist answers otherwise.
import { describe, expect, it } from 'vitest';
import { checkSpec, type CheckOptions } from '../../src/check/index.ts';
import { expandVersions, metadataUrl, packagistApi } from '../../src/check/packagist.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { policy, recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const STRICT = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', allow: [] } });

function options(overrides: Partial<CheckOptions> = {}): CheckOptions {
  return { policy: STRICT, fetch: recordedFetch, now: NOW, registry: 'https://registry.npmjs.org/', popular: new PopularNames([]), ...overrides };
}

const codes = (findings: { code: string; level: string }[]) => findings.map((finding) => `${finding.level}:${finding.code}`);

/** A fetch that answers one list of versions (minified unless told otherwise) for every package. */
function metadata(versions: unknown[], minified = true): FetchLike {
  return async (url) => {
    const name = /\/p2\/(.+)\.json$/u.exec(new URL(url).pathname)?.[1] ?? '';
    return new Response(JSON.stringify({ packages: { [name]: versions }, ...(minified ? { minified: 'composer/2.0' } : {}) }), { status: 200 });
  };
}

describe('depcurfew check on composer: packages', () => {
  it('passes an old enough release and names the highest stable one as the latest', async () => {
    const report = await checkSpec('composer:monolog/monolog', options());
    expect(report).toMatchObject({ spec: 'composer:monolog/monolog', kind: 'registry', name: 'composer:monolog/monolog', version: '3.12.1', publishedAt: '2026-09-29T19:21:44+00:00', findings: [] });
    expect(report.latest).toEqual({ version: '3.12.1', publishedAt: '2026-09-29T19:21:44+00:00' });
  });

  it('asks Packagist only, for the metadata of the tagged releases, in lower case', async () => {
    const asked: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      asked.push(url);
      return recordedFetch(url, init);
    };
    expect(await checkSpec('composer:Monolog/Monolog', options({ fetch }))).toMatchObject({ name: 'composer:monolog/monolog', version: '3.12.1' });
    expect(asked).toEqual(['https://repo.packagist.org/p2/monolog/monolog.json']);
    expect(metadataUrl('acme/tool', true)).toBe('https://repo.packagist.org/p2/acme/tool~dev.json');
  });

  it('reports a release younger than the cooldown, counted from published-time, with the newest one old enough', async () => {
    const report = await checkSpec('composer:guzzlehttp/guzzle', options());
    expect(report.version).toBe('8.3.1');
    expect(report.findings).toEqual([
      {
        level: 'error',
        code: 'too-young',
        message: 'composer:guzzlehttp/guzzle 8.3.1 was published on Packagist 7 days ago; depcurfew.json requires 2 weeks (composer:guzzlehttp/guzzle 8.3.0 is old enough)',
        fix: 'Install composer:guzzlehttp/guzzle:8.3.0 instead, or wait until composer:guzzlehttp/guzzle 8.3.1 is 2 weeks old',
      },
    ]);
    // intercom/intercom-php 5.0.2: its author-set time is 2026-01-30, Packagist published it on 2026-04-30.
    const long = policy({ cooldown: { minimum: '200d' } });
    const counted = await checkSpec('composer:intercom/intercom-php:5.0.2', options({ policy: long }));
    expect(counted.findings[0]?.message).toBe('composer:intercom/intercom-php 5.0.2 was published on Packagist 185 days ago; depcurfew.json requires 200 days');
  });

  it('skips the cooldown for composer: exceptions only', async () => {
    const excepted = policy({ cooldown: { minimum: '14d', exclude: ['composer:guzzlehttp/*'] } });
    expect((await checkSpec('composer:guzzlehttp/guzzle', options({ policy: excepted }))).findings).toEqual([]);
    const npmOnly = policy({ cooldown: { minimum: '14d', exclude: ['@guzzlehttp/*', 'pypi:guzzle'] } });
    expect(codes((await checkSpec('composer:guzzlehttp/guzzle', options({ policy: npmOnly }))).findings)).toEqual(['error:too-young']);
  });

  it('picks the version each constraint form allows, as composer require does', async () => {
    const picked = async (spec: string) => (await checkSpec(spec, options({ policy: policy({}) }))).version;
    expect(await picked('composer:guzzlehttp/guzzle:^7.15')).toBe('7.16.1');
    expect(await picked('composer:guzzlehttp/guzzle=~7.15.0')).toBe('7.15.6');
    expect(await picked('composer:guzzlehttp/guzzle 8.2.0')).toBe('8.2.0');
    expect(await picked('composer:guzzlehttp/guzzle:>=8.2 <8.3')).toBe('8.2.1');
    expect(await picked('composer:guzzlehttp/guzzle:>=8.2,<8.3')).toBe('8.2.1');
    expect(await picked('composer:guzzlehttp/guzzle:8.2.*')).toBe('8.2.1');
    expect(await picked('composer:guzzlehttp/guzzle:7.0 - 7.16.0')).toBe('7.16.0');
    expect(await picked('composer:guzzlehttp/guzzle:^6.0 || ^8.2')).toBe('8.3.1');
    expect(await picked('composer:guzzlehttp/guzzle:!=8.3.1')).toBe('8.3.0');
    expect(await picked('composer:symfony/console:^7.4')).toBe('v7.4.22');
    expect(await picked('composer:symfony/console:v8.1.9')).toBe('v8.1.9');
  });

  it('installs pre-releases only when the constraint asks for them', async () => {
    const report = async (spec: string) => checkSpec(spec, options({ policy: policy({}) }));
    expect((await report('composer:symfony/console:8.1.0-RC1')).version).toBe('v8.1.0-RC1');
    expect((await report('composer:symfony/console:8.1.0-beta3')).version).toBe('v8.1.0-BETA3');
    expect((await report('composer:guzzlehttp/guzzle:7.0.0-rc.1')).version).toBe('7.0.0-rc.1');
    expect((await report('composer:monolog/monolog:>=3.0.0-RC1 <3.0.1')).version).toBe('3.0.0-RC1');
    expect((await report('composer:symfony/console:8.1.0-RC1 || 8.1.0-beta3')).version).toBe('v8.1.0-RC1');
    // With a stability flag, the bound of < is the pre-release of that stability, below 8.1.0-RC1 and 8.1.0-BETA3.
    expect((await report('composer:symfony/console:<8.1.0@beta')).version).toBe('v7.4.22');
    const stable = await report('composer:monolog/monolog:~3.0.0');
    expect(stable.findings).toEqual([
      {
        level: 'error',
        code: 'no-version',
        message: 'no version of composer:monolog/monolog matches "~3.0.0" at the stability stable (only RC versions do, which Composer installs only with a stability flag such as @RC)',
        fix: 'Pick a version of composer:monolog/monolog that exists, such as composer:monolog/monolog:3.12.1',
      },
    ]);
    expect(codes((await report('composer:monolog/monolog:^9.0')).findings)).toEqual(['error:no-version']);
    expect((await report('composer:monolog/monolog:^9.0')).findings[0]?.message).toBe('no version of composer:monolog/monolog matches "^9.0"');
  });

  it('does not vouch for a branch, which has no release, or for a constraint that allows dev versions', async () => {
    const branch = await checkSpec('composer:monolog/monolog:dev-main', options());
    expect(branch.version).toBeUndefined();
    expect(branch.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message:
          '"dev-main" names a branch of composer:monolog/monolog, not a release: Composer installs the commit the branch points to when it runs, which has no publication time to check, and its cooldown never holds back a branch',
        fix: 'Require a tagged release instead, such as composer:monolog/monolog:3.12.1, so that its age can be checked',
      },
    ]);
    expect(codes((await checkSpec('composer:monolog/monolog:2.x-dev', options())).findings)).toEqual(['error:unverified']);
    const dev = await checkSpec('composer:monolog/monolog:^3.0@dev', options());
    expect(dev.version).toBe('3.12.1');
    expect(dev.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message:
          '"^3.0@dev" allows dev versions of composer:monolog/monolog, so Composer may install a branch instead of 3.12.1: a branch is not a release and has no publication time to check, and Composer\'s cooldown never holds it back',
        fix: 'Require tagged releases only (leave out @dev), such as composer:monolog/monolog:3.12.1, so that the age of the version Composer installs can be checked',
      },
    ]);
  });

  it('reports a name Packagist does not know, and a spec that is not one', async () => {
    const missing = await checkSpec('composer:this-vendor-does-not-exist-xyz/nothing-123', options());
    expect(missing.findings).toEqual([
      {
        level: 'error',
        code: 'not-found',
        message: 'composer:this-vendor-does-not-exist-xyz/nothing-123 does not exist in https://repo.packagist.org; the name may be mistyped or made up',
        fix: 'Check the spelling against the documentation of the package you want; do not install a name that was guessed',
      },
    ]);
    for (const spec of ['composer:monolog', 'composer:monolog/monolog@dev', 'composer:', 'composer:monolog/monolog:not a constraint', 'composer:a b/c']) {
      const report = await checkSpec(spec, options());
      expect(report.kind).toBe('invalid');
      expect(report.findings).toEqual([
        {
          level: 'error',
          code: 'invalid-spec',
          message: `"${spec}" is not a Composer package spec`,
          fix: 'Write it as composer:vendor/name or composer:vendor/name:<constraint>, as composer require takes it, such as composer:monolog/monolog:^3.9 or composer:vendor/name:^1.0@beta',
        },
      ]);
    }
  });

  it('does not look up platform packages, which Composer does not install', async () => {
    const asked: string[] = [];
    const fetch: FetchLike = async (url) => {
      asked.push(url);
      return new Response('{}', { status: 500 });
    };
    for (const spec of ['composer:php:^8.2', 'composer:ext-json', 'composer:composer-plugin-api:^2.0', 'composer:lib-curl']) {
      expect(await checkSpec(spec, options({ fetch }))).toMatchObject({ kind: 'other', findings: [{ level: 'warning', code: 'unchecked-source' }] });
    }
    expect(asked).toEqual([]);
  });

  it('reports a Composer plugin where the policy denies install scripts, unless the policy lists it', async () => {
    const report = await checkSpec('composer:php-http/discovery', options());
    expect(report.findings).toEqual([
      {
        level: 'error',
        code: 'install-scripts',
        message: 'composer:php-http/discovery 1.20.0 is a Composer plugin (type composer-plugin), whose code runs during Composer commands, and depcurfew.json does not allow it (installScripts)',
        fix: 'Pick a package that is not a plugin, or add composer:php-http/discovery to installScripts.allow in depcurfew.json if you trust it',
      },
    ]);
    const allowed = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', allow: ['composer:php-http/*'] } });
    expect((await checkSpec('composer:php-http/discovery', options({ policy: allowed }))).findings).toEqual([]);
    const denied = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', deny: ['composer:php-http/discovery'] } });
    expect((await checkSpec('composer:php-http/discovery', options({ policy: denied }))).findings).toEqual([]);
    const npmName = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'deny', allow: ['@php-http/discovery'] } });
    expect(codes((await checkSpec('composer:php-http/discovery', options({ policy: npmName }))).findings)).toEqual(['error:install-scripts']);
    const running = policy({ cooldown: { minimum: '14d' }, installScripts: { default: 'allow' } });
    expect((await checkSpec('composer:php-http/discovery', options({ policy: running }))).findings).toEqual([]);
  });

  it('warns about an abandoned package, with the replacement its author names in quotes', async () => {
    const report = await checkSpec('composer:swiftmailer/swiftmailer', options());
    expect(report.findings).toEqual([
      {
        level: 'warning',
        code: 'deprecated',
        message: 'composer:swiftmailer/swiftmailer is abandoned and no longer maintained; its author suggests "symfony/mailer" instead',
        fix: 'Pick a package that is maintained; check a replacement the author suggests like any other package (as composer:vendor/name) before installing it',
      },
    ]);
  });

  it('expands the minified list as MetadataMinifier::expand does', async () => {
    const versions = [
      { version: '2.0.0', version_normalized: '2.0.0.0', 'published-time': '2026-10-30T00:00:00+00:00', type: 'composer-plugin', abandoned: true },
      { version: '1.1.0', version_normalized: '1.1.0.0', 'published-time': '2025-01-01T00:00:00+00:00', type: '__unset', abandoned: '__unset' },
      { version: '1.0.0', version_normalized: '1.0.0.0', 'published-time': '__unset' },
    ];
    expect(expandVersions(versions, true)).toEqual([
      { version: '2.0.0', version_normalized: '2.0.0.0', 'published-time': '2026-10-30T00:00:00+00:00', type: 'composer-plugin', abandoned: true },
      { version: '1.1.0', version_normalized: '1.1.0.0', 'published-time': '2025-01-01T00:00:00+00:00' },
      { version: '1.0.0', version_normalized: '1.0.0.0' },
    ]);
    // Not minified, each entry is whole; while the version built so far is empty, the next entry starts again.
    expect(expandVersions([{ version: '1.0.0' }, { 'published-time': 'x' }], false)).toEqual([{ version: '1.0.0' }, { 'published-time': 'x' }]);
    expect(expandVersions([{}, { version: '1.0.0', type: '__unset' }], true)).toEqual([{}, { version: '1.0.0', type: '__unset' }]);
    expect(expandVersions([{ version: '1.0.0' }, 'text'], true)).toBeUndefined();
    expect(packagistApi().unsetValue).toBe('__unset');

    const fetch = metadata(versions);
    const old = await checkSpec('composer:acme/tool:^1.0', options({ fetch }));
    expect(old).toMatchObject({ version: '1.1.0', findings: [] });
    const undated = await checkSpec('composer:acme/tool:1.0.0', options({ fetch }));
    expect(undated.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'Packagist gives no publication time (published-time) for composer:acme/tool 1.0.0, so its age cannot be checked, and Composer 2.11 refuses it while a cooldown is set',
        fix: 'Check when composer:acme/tool 1.0.0 was published before installing it, or pick a version that Packagist dates',
      },
    ]);
    expect(codes((await checkSpec('composer:acme/tool', options({ fetch }))).findings)).toEqual(['error:too-young', 'error:install-scripts', 'warning:deprecated']);
  });

  it('normalizes a version without version_normalized, and reads integer times as seconds', async () => {
    const fetch = metadata([{ version: 'v1.2', 'published-time': 1735689600, type: 'Library' }], false);
    expect(await checkSpec('composer:acme/tool', options({ fetch }))).toMatchObject({ version: 'v1.2', publishedAt: '2025-01-01T00:00:00.000Z', findings: [] });
  });

  it('counts a package as not checked when Packagist does not answer with its metadata', async () => {
    const answer = (response: () => Response): FetchLike => async () => response();
    const reason = async (fetch: FetchLike) => {
      const report = await checkSpec('composer:monolog/monolog', options({ fetch }));
      expect(codes(report.findings)).toEqual(['error:unverified']);
      return report.findings[0];
    };
    expect(await reason(answer(() => new Response('oops', { status: 500 })))).toEqual({
      level: 'error',
      code: 'unverified',
      message: 'it cannot be checked: Packagist answered HTTP 500',
      fix: 'Run depcurfew check again when Packagist (repo.packagist.org) can be reached',
    });
    expect((await reason(answer(() => new Response('{"packages": {}}', { status: 200 }))))?.message).toBe('it cannot be checked: Packagist answered something that is not package metadata');
    expect((await reason(answer(() => new Response('not json', { status: 200 }))))?.message).toMatch(/^it cannot be checked: /u);
    expect((await reason(answer(() => new Response('', { status: 302, headers: { location: 'https://evil.example/p2/monolog/monolog.json' } }))))?.message).toBe(
      'it cannot be checked: the repository redirected to https://evil.example, another host, which depcurfew does not follow: that host could answer for any package',
    );
    expect((await reason(async () => Promise.reject(new TypeError('fetch failed'))))?.message).toBe('it cannot be checked: Packagist cannot be reached (fetch failed)');
    const many = { packages: { 'monolog/monolog': Array.from({ length: 100_001 }, () => ({})) }, minified: 'composer/2.0' };
    expect((await reason(answer(() => new Response(JSON.stringify(many), { status: 200 }))))?.message).toBe(
      'it cannot be checked: the repository lists more than 100000 versions of monolog/monolog, more than depcurfew reads of one package, so its versions were not checked',
    );
  });
});
