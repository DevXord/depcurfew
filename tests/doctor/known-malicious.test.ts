// doctor --osv and the rule known-malicious (decision D-129): one batch query over every locked package version doctor
// reads, an error per package and lockfile with the line, a warning instead of a pass when OSV.dev cannot be reached,
// and nothing sent and nothing reported without --osv.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor, type DoctorReport } from '../../src/doctor/index.ts';
import { runDoctorWithOsv } from '../../src/doctor/osv.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { osvFetch, unreachableOsv } from '../support/osv.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/doctor/known-malicious/fires-npm-and-python/repo', import.meta.url));
const CLEAN = fileURLToPath(new URL('../fixtures/doctor/known-malicious/passes-clean/repo', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-osv-doctor-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const own = (report: DoctorReport) => report.findings.filter((finding) => finding.rule === 'known-malicious');
const result = (report: DoctorReport) => report.checked?.rules.find((entry) => entry.rule === 'known-malicious');

const MAL_NPM = 'MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const MAL_PYPI = 'MAL-2026-18443 (https://osv.dev/vulnerability/MAL-2026-18443)';
const WHEEL = 'https://files.pythonhosted.org/packages/00/00/wallet_tracking-1.0.0-py3-none-any.whl';

/** One lockfile of each format doctor reads, each locking a version with a MAL- record. */
const FORMATS: [string, Record<string, string>, string][] = [
  [
    'pnpm-lock.yaml',
    {
      'package.json': '{"name":"app","version":"1.0.0"}\n',
      'pnpm-lock.yaml':
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      cutekitten-test:\n        specifier: 1.0.1\n        version: 1.0.1\n\npackages:\n\n  cutekitten-test@1.0.1:\n    resolution: {integrity: sha512-AAAA}\n\nsnapshots:\n\n  cutekitten-test@1.0.1: {}\n",
    },
    `pnpm-lock.yaml locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'yarn.lock',
    {
      'package.json': '{"name":"app","version":"1.0.0","packageManager":"yarn@4.9.1"}\n',
      'yarn.lock':
        '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n\n"cutekitten-test@npm:1.0.1":\n  version: 1.0.1\n  resolution: "cutekitten-test@npm:1.0.1"\n  checksum: 10c0/00\n  languageName: node\n  linkType: hard\n',
    },
    `yarn.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'bun.lock',
    {
      'package.json': '{"name":"app","version":"1.0.0"}\n',
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {\n    "cutekitten-test": ["cutekitten-test@1.0.1", "", {}, "sha512-AAAA"],\n  }\n}\n',
    },
    `bun.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'deno.lock',
    {
      'deno.json': '{}\n',
      'deno.lock': '{\n  "version": "5",\n  "npm": {\n    "cutekitten-test@1.0.1": { "integrity": "sha512-AAAA" }\n  }\n}\n',
    },
    `deno.lock locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
  ],
  [
    'poetry.lock',
    {
      'pyproject.toml': '[tool.poetry]\nname = "app"\n',
      'poetry.lock': `[[package]]\nname = "wallet-tracking"\nversion = "1.0.0"\nfiles = [\n    {file = "wallet_tracking-1.0.0-py3-none-any.whl", hash = "sha256:00"},\n]\n`,
    },
    `poetry.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'pdm.lock',
    {
      'pyproject.toml': '[project]\nname = "app"\n',
      'pdm.lock': `[metadata]\nlock_version = "4.5.1"\n\n[[package]]\nname = "wallet-tracking"\nversion = "1.0.0"\nfiles = [\n    {file = "wallet_tracking-1.0.0-py3-none-any.whl", hash = "sha256:00"},\n]\n`,
    },
    `pdm.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'Pipfile.lock',
    {
      Pipfile: '[packages]\nwallet-tracking = "==1.0.0"\n',
      'Pipfile.lock': '{\n  "_meta": {},\n  "default": {\n    "wallet-tracking": {\n      "hashes": ["sha256:00"],\n      "version": "==1.0.0"\n    }\n  }\n}\n',
    },
    `Pipfile.lock locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'requirements.txt',
    { 'requirements.txt': 'Wallet_Tracking==1.0.0 \\\n    --hash=sha256:00\n' },
    `requirements.txt locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
  [
    'pylock.toml',
    {
      'pylock.toml': `lock-version = "1.0"\ncreated-by = "pip"\n\n[[packages]]\nname = "wallet-tracking"\nversion = "1.0.0"\nindex = "https://pypi.org/simple"\nwheels = [{ url = "${WHEEL}", hashes = { sha256 = "00" } }]\n`,
    },
    `pylock.toml locks wallet-tracking==1.0.0, a known malicious version: OSV.dev lists it as ${MAL_PYPI}`,
  ],
];

describe('doctor --osv: known-malicious', () => {
  it('reports a locked version with a MAL- record, once per package and lockfile, with the line', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch });
    expect(own(report).map((finding) => [finding.level, finding.location.file, finding.location.line])).toEqual([
      ['error', 'package-lock.json', 15],
      ['error', 'uv.lock', 22],
    ]);
    expect(result(report)).toMatchObject({ result: 'problems', errors: 2, warnings: 0 });
    // One batch for every locked version of the repository, each version once; the project itself is not a package.
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]).toEqual(
      expect.arrayContaining([
        { package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' },
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' },
        { package: { name: 'requests', ecosystem: 'PyPI' }, version: '2.34.2' },
        { package: { name: 'wallet-tracking', ecosystem: 'PyPI' }, version: '1.0.0' },
      ]),
    );
    expect(fetch.requests[0]).toHaveLength(4);
  });

  it.each(FORMATS)('reads the locked versions of %s', async (_name, files, message) => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository(files), {}, { fetch });
    expect(own(report).map((finding) => finding.message)).toEqual([message]);
    expect(own(report)[0]?.location.line).toEqual(expect.any(Number));
  });

  it('says which requirements it could not check because they pin no exact version', async () => {
    const report = await runDoctorWithOsv(repository({ 'requirements.txt': 'requests>=2\nwallet-tracking==1.0.*\nidna==3.10\n' }), {}, { fetch: osvFetch() });
    expect(own(report)).toEqual([]);
    expect(report.notices).toContainEqual(
      expect.objectContaining({
        code: 'known-malicious',
        location: { file: 'requirements.txt' },
        message: 'known-malicious did not check 2 packages of requirements.txt, which pins no exact version of them',
        fix: 'Pin exact versions (name==version), for example with a lockfile exported by the tool that resolves them, so that doctor --osv can check them',
      }),
    );
  });

  it('reads the releases of composer.lock as Packagist versions, as Composer wrote them, and says which branches it left out', async () => {
    const dist = (name: string) => `"dist": { "type": "zip", "url": "https://api.github.com/repos/${name}/zipball/0000" }`;
    const root = repository({
      'composer.json': '{ "require": { "monolog/monolog": "^3.9", "intercom/intercom-php": "^5.0", "symfony/console": "^7.3", "acme/tool": "dev-main", "acme/legacy": "1.x-dev" } }\n',
      'composer.lock': `{
    "packages": [
        { "name": "monolog/monolog", "version": "3.9.0", ${dist('Seldaek/monolog')} },
        { "name": "intercom/intercom-php", "version": "5.0.2", ${dist('intercom/intercom-php')} },
        { "name": "symfony/console", "version": "v7.3.4", ${dist('symfony/console')} },
        { "name": "acme/tool", "version": "dev-main", ${dist('acme/tool')} },
        { "name": "acme/legacy", "version": "1.x-dev", ${dist('acme/legacy')} }
    ],
    "packages-dev": [],
    "plugin-api-version": "2.11.0"
}
`,
    });
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(own(report).map((finding) => [finding.level, finding.location, finding.message])).toEqual([
      [
        'error',
        { file: 'composer.lock', line: 4 },
        'composer.lock locks intercom/intercom-php@5.0.2, a known malicious version: OSV.dev lists it as MAL-2026-3637 (https://osv.dev/vulnerability/MAL-2026-3637)',
      ],
    ]);
    expect(fetch.requests).toEqual([
      [
        { package: { name: 'monolog/monolog', ecosystem: 'Packagist' }, version: '3.9.0' },
        { package: { name: 'intercom/intercom-php', ecosystem: 'Packagist' }, version: '5.0.2' },
        { package: { name: 'symfony/console', ecosystem: 'Packagist' }, version: 'v7.3.4' },
      ],
    ]);
    expect(report.notices).toContainEqual(
      expect.objectContaining({
        code: 'known-malicious',
        location: { file: 'composer.lock' },
        message: 'known-malicious did not check 2 packages of composer.lock, which locks a branch of them (a dev- or -dev version), not a release',
        fix: 'Require tagged releases of these packages in composer.json and run composer update, so that doctor --osv can check them',
      }),
    );
  });

  it('reports the same version in two lockfiles in each of them, and asks for it once', async () => {
    const lock = (name: string) => `{"name":"${name}","lockfileVersion":3,"packages":{"":{"name":"${name}"},"node_modules/cutekitten-test":{"version":"1.0.1","resolved":"https://registry.npmjs.org/cutekitten-test/-/cutekitten-test-1.0.1.tgz"}}}\n`;
    const root = repository({
      'depcurfew.json': JSON.stringify({ version: 1, projects: ['frontend'] }),
      'package.json': '{"name":"root"}\n',
      'package-lock.json': lock('root'),
      'frontend/package.json': '{"name":"frontend"}\n',
      'frontend/package-lock.json': lock('frontend'),
    });
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(own(report).map((finding) => finding.location.file)).toEqual(['frontend/package-lock.json', 'package-lock.json']);
    expect(fetch.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]]);
  });

  it('gives a warning per lockfile instead of passing when OSV.dev cannot be reached', async () => {
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch: unreachableOsv() });
    expect(own(report)).toEqual([
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'package-lock.json' },
        message: 'the 2 package versions locked in package-lock.json were not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)',
        fix: 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it',
      },
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'uv.lock' },
        message: 'the 2 package versions locked in uv.lock were not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)',
        fix: 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it',
      },
    ]);
    expect(result(report)?.result).toBe('problems');
  });

  it('says how many versions were left out when the repository locks more than doctor asks about', async () => {
    const report = await runDoctorWithOsv(FIXTURE, {}, { fetch: osvFetch(), limit: 3 });
    const warning = own(report).find((finding) => finding.level === 'warning');
    expect(warning?.message).toBe(
      '1 of the 2 package versions locked in uv.lock was not checked for known malicious versions in OSV.dev: there are more than 3 package versions to check, and depcurfew asks OSV.dev about at most 3 in one run',
    );
  });

  it('passes a repository whose locked versions have no MAL- record', async () => {
    const report = await runDoctorWithOsv(CLEAN, {}, { fetch: osvFetch() });
    expect(own(report)).toEqual([]);
    expect(result(report)?.result).toBe('passed');
  });

  it('does not apply to a repository without a lockfile, and asks nothing', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': '{"name":"app"}\n' }), {}, { fetch });
    expect(result(report)?.result).toBe('not-applicable');
    expect(fetch.requests).toEqual([]);
  });

  it('does not run without --osv: nothing is sent, nothing is reported, and the check is not applicable', () => {
    const report = runDoctor(FIXTURE);
    expect(own(report)).toEqual([]);
    expect(result(report)).toMatchObject({ result: 'not-applicable', check: 'With --osv: no locked package version is a known malicious version in OSV.dev' });
  });
});

// Decision D-135: known-malicious looks up what the tool installs, not the labels of the lockfile. npm installs the
// tarball of resolved (arborist reify.js #extractOrLink), whose name and version npm reads from its path
// (version-from-tgz.js); Yarn fetches the version of the resolution (NpmSemverFetcher.getLocatorUrl).
describe('doctor --osv: what the tool installs, not the labels', () => {
  const TGZ = 'https://registry.npmjs.org/cutekitten-test/-/cutekitten-test-1.0.1.tgz';
  const npmLock = (entry: Record<string, unknown>, key = 'node_modules/cutekitten-test') =>
    `${JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, [key]: { resolved: TGZ, integrity: 'sha512-AAAA', ...entry } } }, null, 2)}\n`;
  const PACKAGE = '{"name":"app","version":"1.0.0"}\n';
  const yarnLock = (version: string, resolution: string) =>
    `__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n\n"cutekitten-test@npm:^1.0.0":\n  version: ${version}\n  resolution: "${resolution}"\n  checksum: 10c0/00\n  languageName: node\n  linkType: hard\n`;
  const YARN_PACKAGE = '{"name":"app","version":"1.0.0","packageManager":"yarn@4.9.1"}\n';
  const ERROR = (file: string, line: number) => ({
    rule: 'known-malicious',
    level: 'error',
    location: { file, line },
    message: `${file} locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM}`,
    fix: 'Remove cutekitten-test@1.0.1 from the project: update or replace the package and lock again. If it was installed anywhere, read the record on OSV.dev for what it does and treat that machine as exposed',
  });
  const SENT = [[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]];

  it.each([
    ['the version field says another version', { version: '1.0.0' }, 'node_modules/cutekitten-test', 'cutekitten-test@1.0.0'],
    ['the version field has a leading v', { version: 'v1.0.1' }, 'node_modules/cutekitten-test', 'cutekitten-test@v1.0.1'],
    ['the entry is labelled as another package', { version: '1.3.0' }, 'node_modules/left-pad', 'left-pad@1.3.0'],
  ])('npm: looks up the registry tarball of resolved when %s, and says that the entry differs from it', async (_name, entry, key, label) => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': npmLock(entry, key) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report)).toEqual([
      ERROR('package-lock.json', 8),
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'package-lock.json', line: 8 },
        message: `package-lock.json has ${key} as ${label}, but its resolved URL is the registry tarball of cutekitten-test@1.0.1, which is what npm installs there; known-malicious checked cutekitten-test@1.0.1`,
        fix: 'Find out who changed this entry of package-lock.json (npm writes the name and version of the tarball it resolves, so an entry that differs from its resolved URL was edited), then lock the package again with npm',
      },
    ]);
  });

  it('npm: looks up the registry tarball of resolved when the entry has no version field', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': npmLock({}) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report)).toEqual([ERROR('package-lock.json', 8)]);
  });

  it('npm: keeps an npm alias, whose name field names the registry package', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': npmLock({ name: 'cutekitten-test', version: '1.0.1' }, 'node_modules/kitten') }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report)).toEqual([ERROR('package-lock.json', 8)]);
  });

  it('npm: reads a scoped tarball, also with %2f, and a registry below the root of its host', async () => {
    const lock = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/@acme/a': { version: '2.0.0', resolved: 'https://registry.npmjs.org/@acme/a/-/a-2.0.0.tgz' },
        'node_modules/@acme/b': { version: '3.1.0-beta.1', resolved: 'https://registry.example/@acme%2fb/-/b-3.1.0-beta.1.tgz' },
        'node_modules/c': { version: '4.0.0', resolved: 'https://repo.example/api/npm/npm-remote/c/-/c-4.0.0.tgz' },
      },
    });
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': lock }), {}, { fetch });
    expect(fetch.requests).toEqual([
      [
        { package: { name: '@acme/a', ecosystem: 'npm' }, version: '2.0.0' },
        { package: { name: '@acme/b', ecosystem: 'npm' }, version: '3.1.0-beta.1' },
        { package: { name: 'c', ecosystem: 'npm' }, version: '4.0.0' },
      ],
    ]);
    expect(own(report)).toEqual([]);
  });

  it('npm: reads the tarball of a resolved URL with a query after the file name, which npm fetches (decision D-136)', async () => {
    // versionFromTgz reads no name or version from such a URL, but npm fetches the path, which the registry serves.
    const lock = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/@acme/d': { version: '1.0.0', resolved: 'https://repo.example/npm/@acme/d/-/d-1.0.0.tgz?token=1' } } });
    const fetch = osvFetch();
    await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': lock }), {}, { fetch });
    expect(fetch.requests).toEqual([[{ package: { name: '@acme/d', ecosystem: 'npm' }, version: '1.0.0' }]]);
  });

  it('Yarn: looks up the version of the resolution, which Yarn fetches, and says that the version field differs', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': YARN_PACKAGE, 'yarn.lock': yarnLock('1.0.0', 'cutekitten-test@npm:1.0.1') }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report)).toEqual([
      ERROR('yarn.lock', 13),
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'yarn.lock', line: 13 },
        message: 'yarn.lock has version: 1.0.0 for the resolution cutekitten-test@npm:1.0.1, but Yarn fetches the version of the resolution; known-malicious checked cutekitten-test@1.0.1',
        fix: 'Find out who changed this entry of yarn.lock (Yarn writes the version of the resolution it fetches, so an entry where the two differ was edited), then lock the package again with Yarn',
      },
    ]);
  });

  it('pnpm: looks up the registry tarball of resolution.tarball, which pnpm fetches, and says that the key differs', async () => {
    const lock = (tarball: string) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      cutekitten-test:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  cutekitten-test@1.0.0:\n    resolution: {integrity: sha512-AAAA, tarball: ${tarball}}\n\nsnapshots:\n\n  cutekitten-test@1.0.0: {}\n`;
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'pnpm-lock.yaml': lock(TGZ) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report)).toEqual([
      ERROR('pnpm-lock.yaml', 13),
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'pnpm-lock.yaml', line: 13 },
        message: 'pnpm-lock.yaml has the key cutekitten-test@1.0.0, but its resolution.tarball is the registry tarball of cutekitten-test@1.0.1, which is what pnpm installs; known-malicious checked cutekitten-test@1.0.1',
        fix: 'Find out who changed this entry of pnpm-lock.yaml (pnpm writes the tarball of the package and version of the key, so an entry where the two differ was edited), then lock the package again with pnpm',
      },
    ]);
    // A tarball URL in another layout (as some registries serve them) leaves the key.
    const other = osvFetch();
    await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'pnpm-lock.yaml': lock('https://npm.pkg.example/download/cutekitten-test/1.0.1/abc') }), {}, { fetch: other });
    expect(other.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.0' }]]);
  });

  it('Yarn: reads the version of a patched package from the locator inside the patch', async () => {
    const fetch = osvFetch();
    const resolution = 'cutekitten-test@patch:cutekitten-test@npm%3A1.0.1#~/.yarn/patches/cutekitten-test-npm-1.0.1-0000.patch::version=1.0.1&hash=abc';
    const report = await runDoctorWithOsv(repository({ 'package.json': YARN_PACKAGE, 'yarn.lock': yarnLock('1.0.1', resolution) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report).map((finding) => finding.level)).toEqual(['error']);
  });

  it('gives a warning, not a note, for registry entries of a lockfile without an exact version, named with their lines', async () => {
    const lock = JSON.stringify(
      {
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/a': {},
          'node_modules/b': { resolved: 'https://registry.npmjs.org/b/-/b-1.tgz' },
          'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        },
      },
      null,
      2,
    );
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': `${lock}\n` }), {}, { fetch });
    expect(fetch.requests).toEqual([[{ package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' }]]);
    expect(own(report)).toEqual([
      {
        rule: 'known-malicious',
        level: 'warning',
        location: { file: 'package-lock.json', line: 8 },
        message: 'known-malicious could not check 2 registry packages of package-lock.json, whose entries give no exact version that npm installs: a (line 8) and b (line 9)',
        fix: 'Lock these packages again with npm, so that package-lock.json names the exact version of each, and find out why it does not; then run depcurfew doctor --osv again',
      },
    ]);
    expect(report.notices.filter((notice) => notice.code === 'known-malicious')).toEqual([]);
    expect(result(report)?.result).toBe('problems');
  });

  it('gives a warning for a Python lockfile entry without an exact version too', async () => {
    const report = await runDoctorWithOsv(
      repository({ 'pyproject.toml': '[tool.poetry]\nname = "app"\n', 'poetry.lock': '[[package]]\nname = "wallet-tracking"\nfiles = []\n\n[[package]]\nname = "idna"\nversion = "3.10"\nfiles = []\n' }),
      {},
      { fetch: osvFetch() },
    );
    expect(own(report)).toEqual([
      expect.objectContaining({
        level: 'warning',
        location: { file: 'poetry.lock', line: 1 },
        message: 'known-malicious could not check 1 registry package of poetry.lock, whose entry gives no exact version that Poetry installs: wallet-tracking (line 1)',
        fix: 'Lock this package again with Poetry, so that poetry.lock names its exact version, and find out why it does not; then run depcurfew doctor --osv again',
      }),
    ]);
  });
});

describe('depcurfew doctor --osv', () => {
  async function exec(argv: string[], fetch: FetchLike) {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { fetch, now: () => new Date('2026-11-02T12:00:00Z'), stdin: async () => '' });
    return { code, stdout, stderr };
  }

  it('fails on a known malicious version and reports it in JSON with schemaVersion 1', async () => {
    const fetch = osvFetch();
    const result = await exec(['doctor', '--osv', '--json', FIXTURE], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as DoctorReport & { summary: Record<string, number> };
    expect(document.schemaVersion).toBe(1);
    expect(document.findings.filter((finding) => finding.rule === 'known-malicious')).toHaveLength(2);
    expect(result.stderr).toBe('');
  });

  it('names the rule in SARIF', async () => {
    const result = await exec(['doctor', '--osv', '--sarif', FIXTURE], osvFetch());
    const sarif = JSON.parse(result.stdout) as { runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; message: { text: string } }[] }[] };
    expect(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toContain('known-malicious');
    expect(sarif.runs[0]?.results.filter((entry) => entry.ruleId === 'known-malicious')).toHaveLength(2);
  });

  it('shows the findings in the text with the level word and the fix', async () => {
    const result = await exec(['doctor', '--osv', FIXTURE], osvFetch());
    expect(result.stdout).toContain(`  15: error package-lock.json locks cutekitten-test@1.0.1, a known malicious version: OSV.dev lists it as ${MAL_NPM} (known-malicious)\n    fix: Remove cutekitten-test@1.0.1`);
    expect(result.stdout).toMatch(/ {4}2 errors +With --osv: no locked package version is a known malicious version in OSV\.dev \[known-malicious\]/u);
  });

  it('sends nothing without --osv', async () => {
    const fetch = osvFetch();
    const result = await exec(['doctor', '--json', FIXTURE], fetch);
    expect(result.code).toBe(EXIT_OK);
    expect(fetch.requests).toEqual([]);
  });
});
