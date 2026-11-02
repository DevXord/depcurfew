// Fixes after the second security test of 1.4.0 (decision D-136), doctor and init: known-malicious reads the tarball a
// URL with a query or a fragment names, lockfile-forbidden-source counts the composer.lock entries Composer installs
// from their VCS source, dependabot.yml numbers are read as Dependabot's YAML library reads them, the Dependabot
// composer note names the project of a repository with projects, and init names the Composer plugins of composer.lock.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor, type DoctorReport } from '../src/doctor/index.ts';
import { runDoctorWithOsv } from '../src/doctor/osv.ts';
import { psychScalar } from '../src/yaml-parse.ts';
import { osvFetch } from './support/osv.ts';

const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d136-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d136-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const own = (report: DoctorReport, rule: string) => report.findings.filter((finding) => finding.rule === rule).map(({ rule: _rule, ...finding }) => finding);

describe('known-malicious: the tarball of a URL with a query, a fragment or escapes (finding 1)', () => {
  const PACKAGE = '{"name":"app","version":"1.0.0"}\n';
  const BASE = 'https://registry.npmjs.org/cutekitten-test/-/cutekitten-test-1.0.1';
  const npmLock = (resolved: string) =>
    `${JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/cutekitten-test': { version: '1.0.0', resolved, integrity: 'sha512-AAAA' } } }, null, 2)}\n`;
  const pnpmLock = (tarball: string) =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      cutekitten-test:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  cutekitten-test@1.0.0:\n    resolution: {integrity: sha512-AAAA, tarball: '${tarball}'}\n\nsnapshots:\n\n  cutekitten-test@1.0.0: {}\n`;
  const SENT = [[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]];

  it.each([`${BASE}.tgz#x`, `${BASE}.tgz?x=1`, `${BASE}%2Etgz`, `${BASE}.tgz?a=1#b`])('npm: %s is the tarball of 1.0.1, which npm installs', async (resolved) => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': npmLock(resolved) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    const findings = own(report, 'known-malicious');
    expect(findings.map((finding) => finding.level)).toEqual(['error', 'warning']);
    expect(findings[0]?.message).toContain('package-lock.json locks cutekitten-test@1.0.1, a known malicious version');
    expect(findings[1]?.message).toBe(
      'package-lock.json has node_modules/cutekitten-test as cutekitten-test@1.0.0, but its resolved URL is the registry tarball of cutekitten-test@1.0.1, which is what npm installs there; known-malicious checked cutekitten-test@1.0.1',
    );
  });

  it('npm: a registry tarball URL depcurfew cannot read a version from is a registry entry without an exact version, never the version field', async () => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'package-lock.json': npmLock(`${BASE}.TGZ`) }), {}, { fetch });
    expect(fetch.requests).toEqual([]);
    expect(own(report, 'known-malicious')).toEqual([
      {
        level: 'warning',
        location: { file: 'package-lock.json', line: 8 },
        message: 'known-malicious could not check 1 registry package of package-lock.json, whose entry gives no exact version that npm installs: cutekitten-test (line 8)',
        fix: 'Lock this package again with npm, so that package-lock.json names its exact version, and find out why it does not; then run depcurfew doctor --osv again',
      },
    ]);
    expect(report.checked?.rules.find((rule) => rule.rule === 'known-malicious')?.result).toBe('problems');
  });

  it.each([`${BASE}.tgz#x`, `${BASE}.tgz?x=1`, 'cutekitten-test/-/cutekitten-test-1.0.1.tgz'])('pnpm: %s is the tarball of 1.0.1, which pnpm installs', async (tarball) => {
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'pnpm-lock.yaml': pnpmLock(tarball) }), {}, { fetch });
    expect(fetch.requests).toEqual(SENT);
    expect(own(report, 'known-malicious').map((finding) => finding.level)).toEqual(['error', 'warning']);
  });

  it('pnpm: a tarball in the registry layout it cannot read gives the warning, one in a layout of its own keeps the key', async () => {
    const unread = osvFetch();
    const report = await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'pnpm-lock.yaml': pnpmLock(`${BASE}.TGZ`) }), {}, { fetch: unread });
    expect(unread.requests).toEqual([]);
    expect(own(report, 'known-malicious').map((finding) => finding.level)).toEqual(['warning']);
    const other = osvFetch();
    await runDoctorWithOsv(repository({ 'package.json': PACKAGE, 'pnpm-lock.yaml': pnpmLock('https://npm.pkg.example/download/cutekitten-test/1.0.1/abc') }), {}, { fetch: other });
    expect(other.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.0' }]]);
  });
});

describe('lockfile-forbidden-source: composer.lock entries Composer installs from their VCS source (finding 3)', () => {
  const POLICY = '{"version":1,"sources":{"git":"deny"}}\n';
  const ENTRY = {
    name: 'acme/lib',
    version: '1.2.0',
    source: { type: 'git', url: 'https://github.com/acme/lib.git', reference: 'abc' },
    dist: { type: 'zip', url: 'https://api.github.com/repos/acme/lib/zipball/abc', reference: 'abc', shasum: '' },
    type: 'library',
  };
  const lock = (entry: object) => `${JSON.stringify({ 'content-hash': '0', packages: [entry], 'packages-dev': [], 'plugin-api-version': '2.11.0' }, null, 4)}\n`;
  const manifest = (config?: object) => `${JSON.stringify({ require: { 'acme/lib': '^1.2' }, ...(config === undefined ? {} : { config }) }, null, 2)}\n`;
  const errors = (root: string) => own(runDoctor(root), 'lockfile-forbidden-source');

  it('passes an entry Composer installs from its archive: the default preferred-install is dist, also for a dev version', () => {
    expect(errors(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock(ENTRY) }))).toEqual([]);
    expect(errors(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock({ ...ENTRY, version: 'dev-main' }) }))).toEqual([]);
    expect(errors(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest({ 'preferred-install': { 'other/*': 'source' } }), 'composer.lock': lock(ENTRY) }))).toEqual([]);
  });

  // One error per entry of config.preferred-install, at its line in composer.json (decision D-138).
  it.each([
    ['preferred-install "source"', { 'preferred-install': 'source' }, ENTRY, 6, 'config.preferred-install in composer.json is "source"'],
    ['a pattern that selects source', { 'preferred-install': { 'acme/*': 'source', '*': 'dist' } }, ENTRY, 7, 'config.preferred-install in composer.json gives "source" for acme/*'],
    ['"auto" for a dev version', { 'preferred-install': 'auto' }, { ...ENTRY, version: 'dev-main' }, 6, 'config.preferred-install in composer.json is "auto", which installs dev versions from their source'],
    ['a pattern with "auto" for a dev version', { 'preferred-install': { 'ACME/LIB': 'auto' } }, { ...ENTRY, version: '1.x-dev' }, 7, 'config.preferred-install in composer.json gives "auto" for ACME/LIB, which installs dev versions from their source'],
  ])('reports an entry installed from its source because of %s', (_name, config, entry, line, why) => {
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(config), 'composer.lock': lock(entry) });
    expect(errors(root)).toEqual([
      {
        level: 'error',
        location: { file: 'composer.json', line },
        message: `${why}, so Composer installs 1 package of composer.lock from its VCS repository instead of its archive, which depcurfew.json denies: acme/lib (line 5)`,
        fix: expect.stringContaining('or set sources.git to "allow" in depcurfew.json') as unknown as string,
      },
    ]);
  });

  it('reports an entry installed from its source because its archive has no type', () => {
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock({ ...ENTRY, dist: { ...ENTRY.dist, type: '' } }) });
    expect(errors(root)).toEqual([
      {
        level: 'error',
        location: { file: 'composer.lock', line: 5 },
        message: 'composer.lock installs acme/lib from a VCS repository (git https://github.com/acme/lib.git), which depcurfew.json denies: its dist has no type, so Composer cannot download its archive',
        fix: 'Use a registry version of acme/lib, or set sources.git to "allow" in depcurfew.json',
      },
    ]);
  });

  it('warns about an archive of a GitHub repository whose source is another repository host, which Packagist.org never writes', () => {
    const edited = { ...ENTRY, source: { type: 'git', url: 'https://evil.example/lib.git', reference: 'abc' } };
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock(edited) });
    expect(errors(root)).toEqual([
      {
        level: 'warning',
        location: { file: 'composer.lock', line: 5 },
        message:
          'composer.lock gives acme/lib an archive from api.github.com but a VCS source on another host (git https://evil.example/lib.git), which depcurfew.json denies; for an archive from api.github.com the source is on github.com, so the entry was edited, and Composer installs from that source with --prefer-source, with preferred-install "source" in COMPOSER_HOME/config.json, and before Composer 2.10.0 when the archive cannot be downloaded',
        fix: 'Find out who changed this entry of composer.lock, then lock acme/lib again with composer update acme/lib',
      },
    ]);
    // An SSH source on the host of the archive is the same repository host.
    const ssh = { ...ENTRY, source: { type: 'git', url: 'git@github.com:acme/lib.git', reference: 'abc' } };
    expect(errors(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock(ssh) }))).toEqual([]);
  });
});

describe('dependabot.yml numbers as Dependabot reads them (finding 5)', () => {
  it.each([
    ['10', 10],
    ['010', 8],
    ['0o12', '0o12'],
    ['0x0a', 10],
    ['0b1010', 10],
    ['1_0', 10],
    ['1,0', 10],
    ['+10', 10],
    ['-010', -8],
    ['08', '08'],
    ['1:30', 5400],
    ['1:00:10', 3610],
    ['1e3', '1e3'],
    ['10.5', undefined],
  ])('reads %s as psych 5.5.0 does', (text, value) => {
    expect(psychScalar(text)).toEqual(value === undefined ? { kind: 'other' } : typeof value === 'number' ? { kind: 'integer', value } : { kind: 'string', value });
  });

  const POLICY = '{"version":1,"cooldown":{"minimum":"10d"}}\n';
  const NPM = { 'package.json': '{"name":"app"}\n', 'package-lock.json': '{"name":"app","lockfileVersion":3,"packages":{"":{"name":"app"}}}\n', '.npmrc': 'min-release-age=10\n' };
  const dependabot = (days: string) => `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: ${days}\n`;

  it('reports default-days: 010, which Dependabot reads as 8 days, in bot-cooldown-mismatch and config-drift', () => {
    const root = repository({ 'depcurfew.json': POLICY, ...NPM, '.github/dependabot.yml': dependabot('010') });
    const report = runDoctor(root);
    const mismatch = own(report, 'bot-cooldown-mismatch');
    expect(mismatch.map((finding) => finding.level)).toEqual(['error']);
    expect(mismatch[0]?.message).toContain('default-days: 010 in .github/dependabot.yml, which Dependabot reads as 8');
    expect(own(report, 'config-drift').map((finding) => finding.message)).toContain('.github/dependabot.yml does not match depcurfew.json: `default-days: 010` should be `default-days: 10`');
  });

  it('passes 1_0 and 0x0a, which Dependabot reads as 10, and apply leaves them', () => {
    for (const days of ['1_0', '0x0a']) {
      const root = repository({ 'depcurfew.json': POLICY, ...NPM, '.github/dependabot.yml': dependabot(days) });
      const report = runDoctor(root);
      expect(own(report, 'bot-cooldown-mismatch')).toEqual([]);
      expect(own(report, 'config-drift').filter((finding) => finding.message.includes('dependabot.yml'))).toEqual([]);
    }
  });

  it('apply writes 10 in place of 010', () => {
    const root = repository({ 'depcurfew.json': POLICY, ...NPM, '.github/dependabot.yml': dependabot('010') });
    const result = applyProject(root, { write: false });
    const change = result.changes.find((entry) => entry.file === '.github/dependabot.yml');
    expect(change?.after).toContain('default-days: 10\n');
    expect(change?.after).not.toContain('010');
  });
});

describe('the Dependabot composer note in a repository with projects (TB3)', () => {
  it('names the project without putting it into the tool name', () => {
    const lock = `${JSON.stringify({ 'content-hash': '0', packages: [], 'packages-dev': [], 'plugin-api-version': '2.11.0' }, null, 4)}\n`;
    const root = repository({
      'depcurfew.json': '{"version":1,"cooldown":{"minimum":"7d"},"projects":["backend","frontend"]}\n',
      'backend/composer.json': '{"config":{"policy":{"cooldown":{"period":"7 days"}}}}\n',
      'backend/composer.lock': lock,
      'frontend/package.json': '{"name":"frontend"}\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: composer\n    directory: /backend\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 7\n',
    });
    const notes = own(runDoctor(root), 'bot-cooldown-mismatch').filter((finding) => finding.level === 'note');
    expect(notes).toHaveLength(1);
    const message = notes[0]?.message ?? '';
    expect(message).toContain("composer install in backend takes it from composer.lock without Composer's cooldown");
    expect(message).toContain('so Composer 2.11.0 and later read that composer.lock as out of date');
    expect(message).not.toContain('Composer in backend');
  });
});

describe('init names the Composer plugins of composer.lock (TB4)', () => {
  async function init(root: string): Promise<{ notices: { code: string; message: string; fix: string; location: { file: string } }[] }> {
    let stdout = '';
    await run(['init', '--json', root], { stdout: (text) => (stdout += text), stderr: () => undefined }, { fetch: async () => new Response('{}', { status: 404 }), now: () => new Date('2026-11-02T12:00:00Z'), stdin: async () => '', home: () => HOME });
    return JSON.parse(stdout) as { notices: { code: string; message: string; fix: string; location: { file: string } }[] };
  }

  it('lists the plugins installScripts.default "deny" blocks, and says which ones allow-plugins already allows', async () => {
    const plugin = (name: string) => ({ name, version: '2.0.0', type: 'composer-plugin', dist: { type: 'zip', url: `https://api.github.com/repos/${name}/zipball/abc`, reference: 'abc' } });
    const root = repository({
      'composer.json': '{"require":{"symfony/flex":"^2.0","php-http/discovery":"^1.20"},"config":{"allow-plugins":{"symfony/flex":true}}}\n',
      'composer.lock': `${JSON.stringify({ 'content-hash': '0', packages: [plugin('symfony/flex'), plugin('php-http/discovery'), { name: 'psr/log', version: '3.0.2', type: 'library' }], 'packages-dev': [], 'plugin-api-version': '2.11.0' }, null, 4)}\n`,
    });
    const notes = (await init(root)).notices.filter((note) => note.code === 'install-scripts-to-review');
    expect(notes).toEqual([
      {
        code: 'install-scripts-to-review',
        level: 'note',
        location: { file: 'composer.lock' },
        message:
          'composer.lock has Composer plugins, whose code runs during Composer commands, that installScripts.default "deny" blocks: composer:symfony/flex (config.allow-plugins in composer.json allows it) and composer:php-http/discovery',
        fix: 'Review each one before you run depcurfew apply: add it to installScripts.allow in depcurfew.json if the project needs it (as composer:vendor/name), or to installScripts.deny if it works without it; depcurfew apply then writes config.allow-plugins from depcurfew.json',
      },
    ]);
  });
});
