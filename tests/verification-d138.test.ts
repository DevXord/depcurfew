// doctor and init after the last check of 1.4.0 (decision D-138): composer.lock packages that config.preferred-install
// makes Composer check out are one lockfile-forbidden-source error per entry of that setting, at its line in
// composer.json, with a fix there, and init notes them; hosts of composer.lock sources are compared as URLs compare
// them, with www.github.com as github.com (Composer's GitHub driver); and init quotes a dependabot.yml number as the
// file writes it and as Dependabot reads it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { runDoctor, type DoctorReport } from '../src/doctor/index.ts';

const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d138-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d138-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const own = (report: DoctorReport, rule: string) => report.findings.filter((finding) => finding.rule === rule).map(({ rule: _rule, ...finding }) => finding);

type Notice = { code: string; level: string; message: string; fix: string; location: { file: string; line?: number } };

async function init(root: string): Promise<Notice[]> {
  let stdout = '';
  await run(['init', '--json', root], { stdout: (text) => (stdout += text), stderr: () => undefined }, { fetch: async () => new Response('{}', { status: 404 }), now: () => new Date('2026-11-02T12:00:00Z'), stdin: async () => '', home: () => HOME });
  return (JSON.parse(stdout) as { notices: Notice[] }).notices;
}

/** A registry package of composer.lock, as Packagist.org writes it: an archive from api.github.com and its source. */
function locked(name: string, version = '7.3.0', source = `https://github.com/${name}.git`, dist = `https://api.github.com/repos/${name}/zipball/abc`) {
  return { name, version, source: { type: 'git', url: source, reference: 'abc' }, dist: { type: 'zip', url: dist, reference: 'abc', shasum: '' }, type: 'library' };
}
const lock = (entries: object[]) => `${JSON.stringify({ 'content-hash': '0', packages: entries, 'packages-dev': [], 'plugin-api-version': '2.11.0' }, null, 4)}\n`;
const manifest = (config?: object) => `${JSON.stringify({ require: { 'symfony/console': '^7.3' }, ...(config === undefined ? {} : { config }) }, null, 2)}\n`;
/** The line of a package in a composer.lock text. */
const lineOf = (text: string, name: string) => text.split('\n').findIndex((line) => line.includes(`"name": "${name}"`)) + 1;
const POLICY = '{"version":1,"sources":{"git":"deny"}}\n';

describe('lockfile-forbidden-source: one error per entry of config.preferred-install (R3)', () => {
  const SYMFONY = ['symfony/console', 'symfony/string', 'symfony/polyfill-mbstring'];

  it('reports the entry that checks the packages out, at its line in composer.json, with the packages and a fix there', () => {
    const text = lock([...SYMFONY.map((name) => locked(name)), locked('psr/log', '3.0.2')]);
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest({ 'preferred-install': { 'symfony/*': 'source', '*': 'dist' } }), 'composer.lock': text });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([
      {
        level: 'error',
        location: { file: 'composer.json', line: 7 },
        message: `config.preferred-install in composer.json gives "source" for symfony/*, so Composer installs 3 packages of composer.lock from their VCS repositories instead of their archives, which depcurfew.json denies: ${SYMFONY.map((name) => `${name} (line ${lineOf(text, name)})`).join(', ')}`,
        fix: 'Remove "symfony/*" from config.preferred-install in composer.json, or set it to "dist", so Composer installs these packages from their archives; or set sources.git to "allow" in depcurfew.json',
      },
    ]);
  });

  it('names at most 10 packages and counts the rest', () => {
    const names = Array.from({ length: 16 }, (_, index) => `symfony/p${index}`);
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest({ 'preferred-install': { 'symfony/*': 'source' } }), 'composer.lock': lock(names.map((name) => locked(name))) });
    const findings = own(runDoctor(root), 'lockfile-forbidden-source');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('so Composer installs 16 packages of composer.lock');
    expect(findings[0]?.message).toMatch(/symfony\/p9 \(line \d+\) and 6 more$/u);
  });

  it('reports the string "source" and "auto" for dev versions at the setting', () => {
    const text = lock([locked('symfony/console')]);
    const source = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest({ 'preferred-install': 'source' }), 'composer.lock': text });
    expect(own(runDoctor(source), 'lockfile-forbidden-source')).toEqual([
      {
        level: 'error',
        location: { file: 'composer.json', line: 6 },
        message: `config.preferred-install in composer.json is "source", so Composer installs 1 package of composer.lock from its VCS repository instead of its archive, which depcurfew.json denies: symfony/console (line ${lineOf(text, 'symfony/console')})`,
        fix: 'Set config.preferred-install in composer.json to "dist", or remove it, so Composer installs packages from their archives; or set sources.git to "allow" in depcurfew.json',
      },
    ]);
    const dev = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest({ 'preferred-install': 'auto' }), 'composer.lock': lock([locked('symfony/console', '7.4.x-dev'), locked('psr/log', '3.0.2')]) });
    const findings = own(runDoctor(dev), 'lockfile-forbidden-source');
    expect(findings.map((finding) => finding.message)).toEqual([
      'config.preferred-install in composer.json is "auto", which installs dev versions from their source, so Composer installs 1 package of composer.lock from its VCS repository instead of its archive, which depcurfew.json denies: symfony/console (line 5)',
    ]);
  });

  it('allows them when sources.git allows git', () => {
    const root = repository({ 'depcurfew.json': '{"version":1,"sources":{"git":"allow"}}\n', 'composer.json': manifest({ 'preferred-install': 'source' }), 'composer.lock': lock([locked('symfony/console')]) });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([]);
  });

  it('init notes them, as the sources.git "deny" it writes reports them', async () => {
    const text = lock([...SYMFONY.map((name) => locked(name)), locked('psr/log', '3.0.2')]);
    const root = repository({ 'composer.json': manifest({ 'preferred-install': { 'symfony/*': 'source' } }), 'composer.lock': text });
    const notes = (await init(root)).filter((note) => note.code === 'composer-source-checkouts');
    expect(notes).toEqual([
      {
        code: 'composer-source-checkouts',
        level: 'note',
        location: { file: 'composer.json', line: 7 },
        message: `config.preferred-install in composer.json gives "source" for symfony/*, so Composer installs 3 packages of composer.lock from their VCS repositories instead of their archives, which sources.git "deny" in depcurfew.json does not allow, and depcurfew doctor reports it (lockfile-forbidden-source): ${SYMFONY.map((name) => `${name} (line ${lineOf(text, name)})`).join(', ')}`,
        fix: 'Remove "symfony/*" from config.preferred-install in composer.json, or set it to "dist", so Composer installs these packages from their archives; or, if the project installs them from source on purpose, set sources.git to "allow" in depcurfew.json before you run depcurfew apply',
      },
    ]);
    // Without preferred-install there is nothing to note.
    const plain = repository({ 'composer.json': manifest(), 'composer.lock': text });
    expect((await init(plain)).filter((note) => note.code === 'composer-source-checkouts')).toEqual([]);
  });
});

describe('hosts of composer.lock sources compared as URLs compare them (R5)', () => {
  const warnings = (source: string, dist?: string) =>
    own(runDoctor(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock([locked('acme/lib', '1.2.0', source, dist)]) })), 'lockfile-forbidden-source');

  it.each([
    'https://github.com/acme/lib.git',
    'https://www.github.com/acme/lib.git',
    'https://WWW.GitHub.com/acme/lib.git',
    'https://github.com:443/acme/lib.git',
    'http://github.com:80/acme/lib.git',
    'git@github.com:acme/lib.git',
  ])('takes %s for the host of an archive from api.github.com', (source) => {
    expect(warnings(source)).toEqual([]);
  });

  it('takes an archive from api.github.com:443 for one from api.github.com', () => {
    expect(warnings('https://github.com/acme/lib.git', 'https://api.github.com:443/repos/acme/lib/zipball/abc')).toEqual([]);
  });

  it.each(['https://github.com:8443/acme/lib.git', 'https://www.github.com.evil.example/acme/lib.git', 'https://github.com:443.evil.example/acme/lib.git'])('still warns about %s', (source) => {
    const found = warnings(source);
    expect(found.map((finding) => finding.level)).toEqual(['warning']);
    expect(found[0]?.message).toContain(`but a VCS source on another host (git ${source})`);
  });

  it('reads www. as the same host only for GitHub, as Composer does', () => {
    const gitlab = (source: string) =>
      own(runDoctor(repository({ 'depcurfew.json': POLICY, 'composer.json': manifest(), 'composer.lock': lock([locked('acme/lib', '1.2.0', source, 'https://gitlab.com/api/v4/projects/acme%2Flib/repository/archive.zip?sha=abc')]) })), 'lockfile-forbidden-source');
    expect(gitlab('https://gitlab.com:443/acme/lib.git')).toEqual([]);
    expect(gitlab('https://www.gitlab.com/acme/lib.git').map((finding) => finding.level)).toEqual(['warning']);
  });
});

describe('init quotes a dependabot.yml number as written and as Dependabot reads it (R5)', () => {
  it('says default-days: 016, which Dependabot reads as 14', async () => {
    const root = repository({
      'package.json': '{"name":"app"}\n',
      'package-lock.json': '{"name":"app","lockfileVersion":3,"packages":{"":{"name":"app"}}}\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 016\n',
    });
    const kept = (await init(root)).filter((note) => note.code === 'cooldown-kept');
    expect(kept.map((note) => note.message)).toEqual([
      'cooldown.minimum is 14d instead of 3d, to keep the longest release-age delay already set: default-days: 016 in .github/dependabot.yml (line 8), which Dependabot reads as 14',
    ]);
    // A number written as Dependabot reads it is quoted once.
    const plain = repository({
      'package.json': '{"name":"app"}\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 14\n',
    });
    expect((await init(plain)).filter((note) => note.code === 'cooldown-kept').map((note) => note.message)).toEqual([
      'cooldown.minimum is 14d instead of 3d, to keep the longest release-age delay already set: default-days: 14 in .github/dependabot.yml (line 8)',
    ]);
    // apply writes the policy's number in its place.
    const result = applyProject(root, { write: false });
    expect(result.changes.find((entry) => entry.file === '.github/dependabot.yml')?.after ?? '').not.toContain('016');
  });

  it('separates the number Dependabot reads from the rest of the cooldown-shortened warning with a comma', () => {
    const root = repository({
      'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }),
      'package.json': '{"name":"app"}\n',
      'package-lock.json': '{"name":"app","lockfileVersion":3,"packages":{"":{"name":"app"}}}\n',
      '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 016\n',
    });
    const warning = applyProject(root, { write: false }).warningDetails.find((item) => item.code === 'cooldown-shortened');
    expect(warning?.message).toContain('default-days: 016 in .github/dependabot.yml (line 8), which Dependabot reads as 14, waits 2 weeks');
  });
});
