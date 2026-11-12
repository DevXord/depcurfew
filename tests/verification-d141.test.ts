// The full check before 1.4.0 (decision D-141): doctor --osv looks up every release of composer.lock, Composer sources
// are matched as Composer's drivers match them and unknown archive hosts give one warning per host, init leaves
// packages a project's own allow-list allows out of installScripts.deny, apply does not edit a composer.json that
// Composer cannot parse, corepack-unavailable compares positions in the line, and the smaller fixes of explain,
// bot-cooldown-mismatch, broad-exclusion, config-drift, the policy hints, YAML aliases in workflows and the notes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli/run.ts';
import { runDoctor, type DoctorReport } from '../src/doctor/index.ts';
import { runDoctorWithOsv } from '../src/doctor/osv.ts';
import type { FetchLike } from '../src/check/registry.ts';

const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z'), toFake: ['Date'] });
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d141-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d141-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const own = (report: DoctorReport, rule: string) => report.findings.filter((finding) => finding.rule === rule).map(({ rule: _rule, ...finding }) => finding);

type Message = { code: string; level: string; message: string; fix: string; location: { file: string; line?: number } };

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = '';
  let stderr = '';
  const code = await run(args, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch: async () => new Response('{}', { status: 404 }),
    now: () => new Date('2026-11-02T12:00:00Z'),
    stdin: async () => '',
    home: () => HOME,
  });
  return { stdout, stderr, code };
}

async function initNotes(root: string): Promise<Message[]> {
  const { stdout } = await cli(['init', '--json', root]);
  const document = JSON.parse(stdout) as { notices: Message[]; warnings: Message[] };
  return [...document.warnings, ...document.notices];
}

/** A composer.lock entry with an archive and a source. */
function locked(name: string, version: string, dist: string, source: string, type = 'library') {
  return { name, version, source: { type: 'git', url: source, reference: 'r' }, dist: { type: 'zip', url: dist, reference: 'r', shasum: '' }, type };
}
const lock = (entries: object[]) => `${JSON.stringify({ 'content-hash': '0', packages: entries, 'packages-dev': [], 'plugin-api-version': '2.11.0' }, null, 4)}\n`;
/** The line of a package in a composer.lock text. */
const lineOf = (text: string, name: string) => text.split('\n').findIndex((line) => line.includes(`"name": "${name}"`)) + 1;

const DRUPAL_MANIFEST = '{\n    "require": { "drupal/token": "^1.15", "drupal/pathauto": "^1.13" },\n    "repositories": [ { "type": "composer", "url": "https://packages.drupal.org/8" } ]\n}\n';
const DRUPAL_LOCK = lock([
  locked('drupal/token', '1.15.0', 'https://ftp.drupal.org/files/projects/token-8.x-1.15.zip', 'https://git.drupalcode.org/project/token.git', 'drupal-module'),
  locked('drupal/pathauto', '1.13.0', 'https://ftp.drupal.org/files/projects/pathauto-8.x-1.13.zip', 'https://git.drupalcode.org/project/pathauto.git', 'drupal-module'),
]);

/** A fetch that answers every OSV.dev batch query with a MAL- record, and keeps what was asked. */
function maliciousOsv(): FetchLike & { asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (_url: string, init: { body?: string }): Promise<Response> => {
    const body = JSON.parse(init.body ?? '{}') as { queries: { package: { name: string; ecosystem: string }; version: string }[] };
    asked.push(...body.queries.map((query) => `${query.package.ecosystem}:${query.package.name}@${query.version}`));
    return new Response(JSON.stringify({ results: body.queries.map(() => ({ vulns: [{ id: 'MAL-2026-1', modified: '2026-10-01T00:00:00Z' }] })) }), { status: 200 });
  }) as unknown as FetchLike & { asked: string[] };
  fetch.asked = asked;
  return fetch;
}

describe('known-malicious: every release of composer.lock (A1)', () => {
  it('looks up packages from an archive host depcurfew does not recognize', async () => {
    const root = repository({ 'composer.json': DRUPAL_MANIFEST, 'composer.lock': DRUPAL_LOCK });
    const fetch = maliciousOsv();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(fetch.asked).toEqual(['Packagist:drupal/token@1.15.0', 'Packagist:drupal/pathauto@1.13.0']);
    expect(own(report, 'known-malicious').map((finding) => [finding.level, finding.location])).toEqual([
      ['error', { file: 'composer.lock', line: lineOf(DRUPAL_LOCK, 'drupal/token') }],
      ['error', { file: 'composer.lock', line: lineOf(DRUPAL_LOCK, 'drupal/pathauto') }],
    ]);
  });

  it('looks up registry releases that config.preferred-install makes Composer check out of their source', async () => {
    const text = lock([locked('symfony/console', 'v7.3.4', 'https://api.github.com/repos/symfony/console/zipball/r', 'https://github.com/symfony/console.git')]);
    const root = repository({ 'composer.json': '{\n    "require": { "symfony/console": "7.3.*" },\n    "config": { "preferred-install": "source" }\n}\n', 'composer.lock': text });
    const fetch = maliciousOsv();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(fetch.asked).toEqual(['Packagist:symfony/console@v7.3.4']);
    expect(own(report, 'known-malicious')).toHaveLength(1);
  });

  it('looks up a registry release without a usable archive, which Composer checks out', async () => {
    const entry = { name: 'psr/log', version: '3.0.2', source: { type: 'git', url: 'https://github.com/php-fig/log.git', reference: 'r' }, type: 'library' };
    const root = repository({ 'composer.json': '{\n    "require": { "psr/log": "^3" }\n}\n', 'composer.lock': lock([entry]) });
    const fetch = maliciousOsv();
    await runDoctorWithOsv(root, {}, { fetch });
    expect(fetch.asked).toEqual(['Packagist:psr/log@3.0.2']);
  });

  it('does not look up a package of a declared VCS repository, whose code is not the registry release', async () => {
    const text = lock([locked('monolog/monolog', '3.9.0', 'https://api.github.com/repos/acme/monolog-fork/zipball/r', 'https://github.com/acme/monolog-fork.git')]);
    const root = repository({ 'composer.json': '{\n    "require": { "monolog/monolog": "^3.9" },\n    "repositories": [ { "type": "vcs", "url": "https://github.com/acme/monolog-fork" } ]\n}\n', 'composer.lock': text });
    const fetch = maliciousOsv();
    await runDoctorWithOsv(root, {}, { fetch });
    expect(fetch.asked).toEqual([]);
  });
});

describe('lockfile-forbidden-source: Composer sources (F2, A3)', () => {
  const POLICY = JSON.stringify({ version: 1, sources: { git: 'deny', remoteTarball: 'deny', file: 'deny', directory: 'deny' } });

  it('matches a VCS repository written as https://www.github.com/... with the entry Composer installs from it', () => {
    const text = lock([locked('monolog/monolog', '3.9.0', 'https://api.github.com/repos/acme/monolog-fork/zipball/1f2e', 'https://github.com/acme/monolog-fork.git')]);
    const root = repository({
      'depcurfew.json': POLICY,
      'composer.json': `${JSON.stringify({ name: 'acme/app', repositories: [{ type: 'vcs', url: 'https://www.github.com/acme/monolog-fork' }], require: { 'monolog/monolog': '^3.9' } }, null, 4)}\n`,
      'composer.lock': text,
    });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([
      {
        level: 'error',
        location: { file: 'composer.lock', line: lineOf(text, 'monolog/monolog') },
        message: 'composer.lock installs monolog/monolog from a VCS repository (git https://github.com/acme/monolog-fork.git), which depcurfew.json denies',
        fix: 'Use a registry version of monolog/monolog, or set sources.git to "allow" in depcurfew.json',
      },
    ]);
  });

  it('gives one warning per unknown archive host, names the declared Composer repository and says how to check it', () => {
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': DRUPAL_MANIFEST, 'composer.lock': DRUPAL_LOCK });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([
      {
        level: 'warning',
        location: { file: 'composer.lock', line: lineOf(DRUPAL_LOCK, 'drupal/token') },
        message: `composer.lock installs 2 packages from archives on ftp.drupal.org, a host depcurfew does not recognize, so they may come from a source depcurfew.json denies: drupal/token (line ${lineOf(DRUPAL_LOCK, 'drupal/token')}), drupal/pathauto (line ${lineOf(DRUPAL_LOCK, 'drupal/pathauto')}); composer.json declares the Composer repository https://packages.drupal.org/8 (line 3), which may keep its archives there, but composer.lock does not say which repository a package comes from`,
        fix: 'Check that this repository serves these packages with archives on ftp.drupal.org (composer show --all <package> names the dist URL Composer gets); depcurfew cannot tie ftp.drupal.org to a repository, so this warning stays while composer.lock installs from it. If the archives come from elsewhere, lock the packages again with composer update',
      },
    ]);
  });

  it('accepts the archive host of WPackagist when composer.json declares it', () => {
    const text = lock([
      locked('wpackagist-plugin/akismet', '5.3', 'https://downloads.wordpress.org/plugin/akismet.5.3.zip', 'https://plugins.svn.wordpress.org/akismet/', 'wordpress-plugin'),
      locked('wpackagist-theme/hueman', '3.7.25', 'https://downloads.wordpress.org/theme/hueman.3.7.25.zip', 'https://themes.svn.wordpress.org/hueman/', 'wordpress-theme'),
    ]);
    const manifest = '{\n    "require": { "wpackagist-plugin/akismet": "^5", "wpackagist-theme/hueman": "*" },\n    "repositories": [ { "name": "wpackagist", "type": "composer", "url": "https://wpackagist.org", "only": ["wpackagist-plugin/*", "wpackagist-theme/*"] } ]\n}\n';
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': manifest, 'composer.lock': text });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([]);
    // Without the repository, downloads.wordpress.org is a host depcurfew does not recognize.
    const without = repository({ 'depcurfew.json': POLICY, 'composer.json': '{\n    "require": { "wpackagist-plugin/akismet": "^5" }\n}\n', 'composer.lock': text });
    expect(own(runDoctor(without), 'lockfile-forbidden-source').map((finding) => finding.message)).toEqual([
      expect.stringMatching(/^composer\.lock installs 2 packages from archives on downloads\.wordpress\.org, a host depcurfew does not recognize/u),
    ]);
  });

  it('keeps one warning with the earlier fix for one package and no declared repository', () => {
    const text = lock([locked('acme/tool', '1.0.0', 'https://cdn.example.com/acme-tool-1.0.0.zip', 'https://github.com/acme/tool.git')]);
    const root = repository({ 'depcurfew.json': POLICY, 'composer.json': '{\n    "require": { "acme/tool": "^1" }\n}\n', 'composer.lock': text });
    expect(own(runDoctor(root), 'lockfile-forbidden-source')).toEqual([
      {
        level: 'warning',
        location: { file: 'composer.lock', line: lineOf(text, 'acme/tool') },
        message: 'composer.lock installs acme/tool from an archive on cdn.example.com (zip https://cdn.example.com/acme-tool-1.0.0.zip), a host depcurfew does not recognize, so it may come from a source depcurfew.json denies',
        fix: 'Check where acme/tool comes from: if a Composer repository serves it, declare that repository in composer.json; otherwise lock it again from Packagist with composer update',
      },
    ]);
  });
});

const PNPM_LOCK =
  "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      vite:\n        specifier: ^7.1.0\n        version: 7.1.0\n\npackages:\n\n  esbuild@0.28.2:\n    resolution: {integrity: sha512-cccc}\n\n  vite@7.1.0:\n    resolution: {integrity: sha512-ffff}\n\nsnapshots:\n\n  esbuild@0.28.2: {}\n\n  vite@7.1.0:\n    dependencies:\n      esbuild: 0.28.2\n";

function npmLock(packages: Record<string, { version: string; script?: boolean }>): string {
  const entries = Object.fromEntries(
    Object.entries(packages).map(([name, item]) => [
      `node_modules/${name}`,
      { version: item.version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${item.version}.tgz`, integrity: 'sha512-x', ...(item.script === true ? { hasInstallScript: true } : {}) },
    ]),
  );
  return `${JSON.stringify({ name: 'a', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'a', version: '1.0.0' }, ...entries } }, null, 2)}\n`;
}

describe("init: packages a package manager's own allow-list allows stay out of installScripts.deny (A2)", () => {
  it('pnpm: onlyBuiltDependencies as pnpm approve-builds writes it', async () => {
    const root = repository({
      'package.json': '{ "name": "pv", "private": true, "packageManager": "pnpm@10.28.0", "devDependencies": { "vite": "^7.1.0" } }\n',
      'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n',
      'pnpm-lock.yaml': PNPM_LOCK,
    });
    const notes = await initNotes(root);
    const policy = JSON.parse(readFileSync(join(root, 'depcurfew.json'), 'utf8')) as { installScripts: { allow: string[]; deny: string[] } };
    expect(policy.installScripts.deny).toEqual([]);
    expect(notes.filter((note) => note.code === 'install-script-denied')).toEqual([]);
    // The project's own approval goes into installScripts.allow (decision D-167).
    expect(policy.installScripts.allow).toEqual(['esbuild']);
    expect(notes.filter((note) => note.code === 'install-scripts-kept')).toEqual([
      {
        code: 'install-scripts-kept',
        level: 'note',
        location: { file: 'pnpm-workspace.yaml', line: 2 },
        message:
          "installScripts.allow lists the packages that the package managers' own allow-lists already let run install scripts, so that depcurfew apply and depcurfew doctor keep them allowed: esbuild (onlyBuiltDependencies in pnpm-workspace.yaml, line 2; depcurfew knows it works without its install script, so installScripts.deny may suit it better)",
        fix: "Review each one before you run depcurfew apply: installScripts.allow lets it run its install scripts in every tool depcurfew configures, so remove the ones that do not need them from depcurfew.json and from the package manager's allow-list",
      },
    ]);
  });

  it('npm: allowScripts entries set to true; a package the list does not name is still denied', async () => {
    const root = repository({
      'package.json': `${JSON.stringify({ name: 'a', version: '1.0.0', packageManager: 'npm@12.2.1', allowScripts: { esbuild: true, lefthook: true } }, null, 2)}\n`,
      'package-lock.json': npmLock({ esbuild: { version: '0.28.2', script: true }, lefthook: { version: '2.0.4', script: true }, fsevents: { version: '2.3.3', script: true } }),
    });
    const notes = await initNotes(root);
    const policy = JSON.parse(readFileSync(join(root, 'depcurfew.json'), 'utf8')) as { installScripts: { deny: string[] } };
    expect(policy.installScripts.deny).toEqual(['fsevents']);
    expect(notes.find((note) => note.code === 'install-scripts-kept')?.message).toMatch(/: esbuild \(allowScripts in package\.json, line 6; [^)]*\) and lefthook \(allowScripts in package\.json, line 7; [^)]*\)$/u);
  });
});

describe('init: notes name the file of a project and the line (A4, A9)', () => {
  it('names api/composer.json in install-scripts-to-review and composer-source-checkouts, with the line in the message', async () => {
    const text = lock([locked('symfony/flex', 'v2.8.2', 'https://api.github.com/repos/symfony/flex/zipball/r', 'https://github.com/symfony/flex.git', 'composer-plugin')]);
    const root = repository({
      'api/composer.json': '{\n    "require": { "symfony/flex": "^2" },\n    "config": { "allow-plugins": { "symfony/flex": true }, "preferred-install": { "symfony/*": "source" } }\n}\n',
      'api/composer.lock': text,
    });
    const notes = await initNotes(root);
    expect(notes.find((note) => note.code === 'install-scripts-to-review')?.message).toBe(
      'api/composer.lock has a Composer plugin, whose code runs during Composer commands, that installScripts.default "deny" blocks: composer:symfony/flex (config.allow-plugins in api/composer.json allows it)',
    );
    expect(notes.find((note) => note.code === 'composer-source-checkouts')).toEqual({
      code: 'composer-source-checkouts',
      level: 'note',
      location: { file: 'api/composer.json', line: 3 },
      message: `config.preferred-install in api/composer.json (line 3) gives "source" for symfony/*, so Composer installs 1 package of api/composer.lock from its VCS repository instead of its archive, which sources.git "deny" in depcurfew.json does not allow, and depcurfew doctor reports it (lockfile-forbidden-source): symfony/flex (line ${lineOf(text, 'symfony/flex')})`,
      fix: 'Remove "symfony/*" from config.preferred-install in api/composer.json, or set it to "dist", so Composer installs these packages from their archives; or, if the project installs them from source on purpose, set sources.git to "allow" in depcurfew.json before you run depcurfew apply',
    });
  });

  it('puts the line of the lockfile into install-script-denied, which the text of init shows', async () => {
    const lockText = npmLock({ esbuild: { version: '0.28.2', script: true } });
    const root = repository({ 'package.json': '{ "name": "a", "version": "1.0.0", "packageManager": "npm@12.2.1" }\n', 'package-lock.json': lockText });
    const { stdout } = await cli(['init', root]);
    const line = lockText.split('\n').findIndex((item) => item.includes('"node_modules/esbuild"')) + 1;
    expect(stdout).toContain(`note: esbuild in package-lock.json (line ${line}) has an install script (postinstall: node install.js) that it does not need`);
  });
});

describe('apply: a composer.json Composer cannot parse is not edited (A5)', () => {
  it.each([
    ['a trailing comma', '{\n    "require": {\n        "a/b": "^1",\n    }\n}\n', 4, 5, 'Expected double-quoted property name'],
    ['a comment', '{\n    // the packages\n    "require": { "a/b": "^1" }\n}\n', 2, 5, "Expected property name or '}'"],
  ])('%s gives cannot-edit with the line and writes nothing', async (_name, text, line, column, reason) => {
    const root = repository({ 'composer.json': text, 'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"},"targets":"auto"}\n' });
    const { stdout, code } = await cli(['apply', '--json', root]);
    const document = JSON.parse(stdout) as { written: boolean; errors: Message[] };
    expect(code).not.toBe(0);
    expect(document.written).toBe(false);
    expect(document.errors).toEqual([
      expect.objectContaining({
        code: 'cannot-edit',
        level: 'error',
        location: { file: 'composer.json', line },
        message: `Composer: cannot edit composer.json: invalid JSON at line ${line}, column ${column}: ${reason}; Composer reads composer.json with json_decode, which takes no comments or trailing commas, so every Composer command stops on it`,
        fix: 'Remove the comment or trailing comma from composer.json (composer validate shows where), then run depcurfew apply again',
      }),
    ]);
    expect(readFileSync(join(root, 'composer.json'), 'utf8')).toBe(text);
  });
});

describe('apply and doctor: Composer allow-list conflicts say config.allow-plugins and plugin (A9)', () => {
  it('names the setting as the other Composer messages do, with the tool first in apply', async () => {
    const text = lock([locked('acme/plugin', '1.0.0', 'https://api.github.com/repos/acme/plugin/zipball/r', 'https://github.com/acme/plugin.git', 'composer-plugin')]);
    const root = repository({
      'composer.json': '{\n    "require": { "acme/plugin": "^1" },\n    "config": { "allow-plugins": { "acme/plugin": true, "acme/other": true } }\n}\n',
      'composer.lock': text,
      'depcurfew.json': '{"version":1,"installScripts":{"default":"deny","deny":["composer:acme/plugin"]},"targets":["composer"]}\n',
    });
    const { stdout } = await cli(['apply', '--dry-run', '--json', root]);
    const warnings = (JSON.parse(stdout) as { warnings: Message[] }).warnings.filter((warning) => ['deny-conflicts-with-file', 'allow-list-entry-outside-policy'].includes(warning.code));
    expect(warnings.map(({ code, message, fix }) => ({ code, message, fix }))).toEqual([
      {
        code: 'deny-conflicts-with-file',
        message: 'Composer: config.allow-plugins in composer.json (line 3) lets the Composer plugin acme/plugin run, although installScripts.deny in depcurfew.json denies it; depcurfew apply does not change entries it did not write',
        fix: 'Remove "acme/plugin" from config.allow-plugins in composer.json, or move composer:acme/plugin from installScripts.deny to installScripts.allow in depcurfew.json after reviewing the plugin',
      },
      {
        code: 'allow-list-entry-outside-policy',
        message: 'Composer: config.allow-plugins in composer.json (line 3) lets the Composer plugin acme/other run, but depcurfew.json does not allow it; depcurfew apply does not remove entries it did not write',
        fix: 'Remove "acme/other" from config.allow-plugins in composer.json by hand, or add composer:acme/other to installScripts.allow in depcurfew.json',
      },
    ]);
  });
});

describe('corepack-unavailable: the order of commands on one line (A6)', () => {
  const YARN = { 'package.json': '{ "name": "y", "private": true, "packageManager": "yarn@4.18.1" }\n', 'yarn.lock': '__metadata:\n  version: 8\n  cacheKey: 10c0\n' };
  const job = (id: string, run: string) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with: { node-version: 26 }\n      - run: ${run}\n`;

  it('a job that enables Corepack before yarn on the same line passes; one that enables it after is reported', () => {
    const root = repository({ ...YARN, '.github/workflows/ci.yml': `on: push\njobs:\n${job('a', 'corepack enable && yarn install --immutable')}${job('b', 'yarn install --immutable && corepack enable')}` });
    expect(own(runDoctor(root), 'corepack-unavailable').map((finding) => finding.message)).toEqual([expect.stringMatching(/^packageManager in package\.json \(line 1\) pins yarn@4\.18\.1, but Node\.js 26 in GitHub Actions \(\.github\/workflows\/ci\.yml, job b\)/u)]);
  });

  it('RUN corepack enable && yarn install passes; RUN yarn install && corepack enable is reported', () => {
    const passes = repository({ ...YARN, Dockerfile: 'FROM node:26-alpine\nRUN corepack enable && yarn install --immutable\n' });
    expect(own(runDoctor(passes), 'corepack-unavailable')).toEqual([]);
    const fires = repository({ ...YARN, Dockerfile: 'FROM node:26-alpine\nRUN yarn install --immutable && corepack enable\n' });
    expect(own(runDoctor(fires), 'corepack-unavailable')).toHaveLength(1);
    // Continuation lines keep their columns: corepack on the line before yarn counts.
    const continued = repository({ ...YARN, Dockerfile: 'FROM node:26-alpine\nRUN corepack enable \\\n    && yarn install --immutable\n' });
    expect(own(runDoctor(continued), 'corepack-unavailable')).toEqual([]);
    const heredoc = repository({ ...YARN, Dockerfile: 'FROM node:26-alpine\nRUN <<EOF\nyarn install --immutable; corepack enable\nEOF\n' });
    expect(own(runDoctor(heredoc), 'corepack-unavailable')).toHaveLength(1);
  });
});

describe('broad-exclusion and config-drift: Dependabot exclude of every Composer package (A7)', () => {
  it('reports exclude: ["*/*"] in a composer entry, and config-drift names the value it replaces', () => {
    const dependabot = 'version: 2\nupdates:\n  - package-ecosystem: composer\n    directory: /\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 3\n      exclude:\n        - "*/*"\n';
    const root = repository({
      'composer.json': '{\n    "require": { "a/b": "^1" },\n    "config": { "policy": { "cooldown": { "period": "3 days" } } }\n}\n',
      '.github/dependabot.yml': dependabot,
      'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"},"targets":"auto"}\n',
    });
    const report = runDoctor(root);
    expect(own(report, 'broad-exclusion')).toEqual([
      {
        level: 'error',
        location: { file: '.github/dependabot.yml', line: 9 },
        message: 'cooldown.exclude in updates[0] (composer) contains "*/*", so Dependabot applies no cooldown',
        fix: 'Remove "*/*" and list only the dependencies that need the exception',
      },
    ]);
    expect(own(report, 'config-drift').map((finding) => finding.message)).toEqual(['.github/dependabot.yml does not match depcurfew.json: `exclude: ["*/*"]` should be `exclude: []`']);
  });
});

describe('policy patterns: the hint for an unknown prefix (A8, changed by E33)', () => {
  it('suggests composer: for php:, an npm name only for an npm prefix, and nothing else for another prefix', async () => {
    const { validatePackagePattern } = await import('../src/policy/package-pattern.ts');
    expect(validatePackagePattern('php:monolog/monolog')).toBe('the ecosystem prefixes are pypi: and composer:, and npm packages have none; write Composer packages as "composer:monolog/monolog"');
    expect(validatePackagePattern('node:left-pad')).toBe('the ecosystem prefixes are pypi: and composer:, and npm packages have none; write npm packages without a prefix, e.g. "left-pad"');
    expect(validatePackagePattern('x:Not A Name')).toBe('must not contain spaces');
    expect(validatePackagePattern('npm:@@bad')).toBe('the ecosystem prefixes are pypi: and composer:, and npm packages have none; write npm packages without a prefix, e.g. "esbuild" or "@scope/name"');
    // E33: a vendor/name after another prefix (github:owner/repo) is not taken for a Composer package.
    expect(validatePackagePattern('x:monolog/monolog')).toBe('the ecosystem prefixes are pypi: and composer:, and npm packages have none; remove the entry or fix the spelling of its prefix');
  });
});

describe('explain and bot-cooldown-mismatch: the delay of bots (A10)', () => {
  it('explain shows the Renovate delay apply writes, after a manager rounded up', async () => {
    const root = repository({ 'depcurfew.json': '{"version":1,"cooldown":{"minimum":"36h"}}\n', 'package.json': '{"name":"a","packageManager":"npm@11.10.0"}\n', 'renovate.json': '{}\n' });
    const { stdout } = await cli(['explain', root]);
    expect(stdout).toContain('    npm: 2 days (rounded up)\n    Renovate: 2 days (rounded up)\n');
  });

  it('reports every Renovate rule with a shorter delay, not only the shortest', () => {
    const renovate = {
      minimumReleaseAge: '3 days',
      vulnerabilityAlerts: { minimumReleaseAge: null },
      packageRules: [
        { matchManagers: ['composer'], minimumReleaseAge: '1 day' },
        { matchCategories: ['php'], matchUpdateTypes: ['major'], minimumReleaseAge: null },
      ],
    };
    const root = repository({
      'composer.json': '{\n    "require": { "a/b": "^1" },\n    "config": { "policy": { "cooldown": { "period": "3 days" } } }\n}\n',
      'renovate.json': `${JSON.stringify(renovate, null, 2)}\n`,
      'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"},"targets":"auto"}\n',
    });
    const findings = own(runDoctor(root), 'bot-cooldown-mismatch');
    expect(findings.map((finding) => [finding.level, finding.location.line, finding.message.split(' (')[0]])).toEqual([['error', 7, 'Renovate proposes minor and patch updates after 1 day']]);
  });
});

describe('bot-cooldown-mismatch: a Renovate rule with a matcher depcurfew does not model (F1)', () => {
  const NPM = {
    'package.json': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    'package-lock.json': npmLock({ 'left-pad': { version: '1.3.0' } }),
    '.npmrc': 'min-release-age=3\n',
    'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }),
  };
  it.each([
    [{ matchBaseBranches: ['/.*/'], minimumReleaseAge: '1 hour' }, 'matchBaseBranches'],
    [{ matchJsonata: ['true'], minimumReleaseAge: '1 hour' }, 'matchJsonata'],
    [{ matchRepositories: ['**'], minimumReleaseAge: '1 hour' }, 'matchRepositories'],
    [{ matchCurrentAge: '> 0 days', minimumReleaseAge: '1 hour' }, 'matchCurrentAge'],
  ])('%j gets a note', (rule, matcher) => {
    const root = repository({ ...NPM, 'renovate.json': JSON.stringify({ minimumReleaseAge: '3 days', vulnerabilityAlerts: { minimumReleaseAge: null }, packageRules: [rule] }) });
    const findings = own(runDoctor(root), 'bot-cooldown-mismatch');
    expect(findings.map((finding) => finding.level)).toEqual(['note']);
    expect(findings[0]?.message).toContain(`packageRules[0] in renovate.json sets minimumReleaseAge: "1 hour" for ${matcher} `);
    expect(findings[0]?.fix).toBe(`Make sure packageRules[0] of renovate.json gives these packages a minimumReleaseAge of at least 3 days; depcurfew does not evaluate ${matcher}, so this note stays while the rule sets a shorter delay`);
  });

  it('a rule that a known matcher limits to some packages stays an exception', () => {
    const root = repository({ ...NPM, 'renovate.json': JSON.stringify({ minimumReleaseAge: '3 days', packageRules: [{ matchPackageNames: ['left-pad'], matchBaseBranches: ['main'], minimumReleaseAge: '1 hour' }] }) });
    expect(own(runDoctor(root), 'bot-cooldown-mismatch')).toEqual([]);
  });
});

describe('composer-config-weakens: YAML aliases in the env of a workflow (F3)', () => {
  const composer = {
    'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '14d' }, installScripts: { default: 'deny' } }),
    'composer.json': JSON.stringify({ require: { 'monolog/monolog': '^3.9' }, config: { policy: { cooldown: { period: '14 days' } }, 'allow-plugins': {} } }, null, 2),
  };
  it.each([
    ['an aliased env map', 'on: push\nx-env: &e\n  COMPOSER_NO_BLOCKING: 1\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env: *e\n    steps:\n      - run: composer install\n', 'job a', 3],
    ['an aliased value', 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      X: &v 1\n      COMPOSER_NO_BLOCKING: *v\n    steps:\n      - run: composer install\n', 'job a', 7],
  ])('reads %s, as GitHub Actions does', (_name, workflow, where, line) => {
    const findings = own(runDoctor(repository({ ...composer, '.github/workflows/ci.yml': workflow })), 'composer-config-weakens');
    expect(findings.map((finding) => [finding.level, finding.location, finding.message.split(' reaches')[0]])).toEqual([['error', { file: '.github/workflows/ci.yml', line }, `COMPOSER_NO_BLOCKING=1 in the env of ${where} in .github/workflows/ci.yml`]]);
  });
});

describe('apply and explain: the policy-from-parent note shows control characters as text (F4)', () => {
  // Windows allows no control characters in file names, so such a directory exists only on other systems.
  it.skipIf(process.platform === 'win32').each([['explain'], ['apply', '--dry-run']])('%s', async (...args) => {
    // A repository root above the policy, as doctor and apply look for one.
    const root = repository({ '.git/HEAD': 'ref: refs/heads/main\n' });
    const name = 'x\u001b]0;PWNED\u0007y';
    mkdirSync(join(root, name, 'app'), { recursive: true });
    writeFileSync(join(root, name, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '7d' }, projects: ['app'] }));
    writeFileSync(join(root, name, 'app', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
    const { stderr } = await cli([...(args as string[]), join(root, name, 'app')]);
    expect(stderr).toContain('policy-from-parent');
    expect(stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/u);
  });
});

describe('a dependabot.yml with a YAML alias in init and apply (T5)', () => {
  const DEPENDABOT = 'version: 2\nx-schedule: &weekly\n  interval: weekly\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: *weekly\n    cooldown:\n      default-days: 16\n';
  const NPM_PROJECT = { 'package.json': '{ "name": "a", "version": "1.0.0", "packageManager": "npm@12.2.1" }\n', 'package-lock.json': npmLock({}) };

  it('init notes that Dependabot does not read the file and that its delays are not kept', async () => {
    const root = repository({ ...NPM_PROJECT, '.github/dependabot.yml': DEPENDABOT });
    const notes = await initNotes(root);
    expect(notes.find((note) => note.code === 'bot-config-unreadable')).toEqual({
      code: 'bot-config-unreadable',
      level: 'note',
      location: { file: '.github/dependabot.yml', line: 7 },
      message: '.github/dependabot.yml uses a YAML alias (line 7), which Dependabot does not accept, so it reads no configuration from the file; init does not read the delays it sets either, so cooldown.minimum does not keep a longer one from it',
      fix: 'Write the value out in place of the alias on line 7 of .github/dependabot.yml; if the file sets a longer cooldown than cooldown.minimum in depcurfew.json, raise cooldown.minimum before you run depcurfew apply',
    });
  });

  it('apply warns that Dependabot reads nothing from the file it edits', async () => {
    const root = repository({ ...NPM_PROJECT, '.github/dependabot.yml': DEPENDABOT, 'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"},"targets":"auto"}\n' });
    const { stdout } = await cli(['apply', '--dry-run', '--json', root]);
    const warnings = (JSON.parse(stdout) as { warnings: Message[] }).warnings.filter((warning) => warning.code === 'bot-config-unreadable');
    expect(warnings.map(({ code, location, message, fix }) => ({ code, location, message, fix }))).toEqual([
      {
        code: 'bot-config-unreadable',
        location: { file: '.github/dependabot.yml', line: 7 },
        message:
          'Dependabot: .github/dependabot.yml uses a YAML alias (line 7), which Dependabot does not accept, so it reads no configuration from the file, the cooldown depcurfew apply writes included; depcurfew does not read the delays such a file sets either, so it cannot tell whether this change shortens one',
        fix: 'Write the value out in place of the alias on line 7 of .github/dependabot.yml, then run depcurfew apply again',
      },
    ]);
  });
});

describe('doctor: the Tools line names a package manager set up in CI for the projects (T8)', () => {
  it('lists the pnpm of a CI step with its version', () => {
    const root = repository({
      'depcurfew.json': '{"version":1,"cooldown":{"minimum":"3d"},"projects":["app"]}\n',
      'app/package.json': '{ "name": "app", "version": "1.0.0" }\n',
      'app/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.github/workflows/ci.yml': 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 9.15.0\n      - run: pnpm install\n        working-directory: app\n',
    });
    const report = runDoctor(root);
    expect(report.checked?.tools).toContainEqual({ id: 'pnpm', name: 'pnpm', version: '9.15.0', versionFrom: '.github/workflows/ci.yml', setUpInCi: true });
  });
});

describe('the knowledge base and the site (S3, S4, S6)', () => {
  it('escapes fact text for Markdown, so backslashes and markup characters stay as they are', async () => {
    const { escapeMarkdown } = await import('../src/knowledge/render.ts');
    const { renderMarkdown } = await import('../scripts/site/markdown.ts');
    const cases = [
      '^pylock\\.([^.]+)\\.toml$',
      'such as spaces, slashes /, backslashes \\, parentheses',
      'ENV <key>=<value> [<key>=<value>...]',
      'keys "*" and "*/*" match every plugin, __metadata and `code`',
      'a [link](https://example.com) and &amp; stay text',
    ];
    for (const text of cases) {
      const html = renderMarkdown(escapeMarkdown(text)).html;
      expect(html, text).toContain(text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'));
    }
    // Names with underscores between letters and web addresses are left alone.
    expect(escapeMarkdown('PIP_CONFIG_FILE, see https://github.com/a/b_c')).toBe('PIP_CONFIG_FILE, see https://github.com/a/b_c');
    const knowledge = readFileSync(new URL('../docs/knowledge.md', import.meta.url), 'utf8');
    expect(knowledge).toContain('^pylock\\\\.([^.]+)\\\\.toml$');
  });

  it('names the source arrows of the knowledge page, and lets tall tables scroll in their own box with the header in sight', async () => {
    const { renderMarkdown } = await import('../scripts/site/markdown.ts');
    expect(renderMarkdown('`x` [↗](https://example.com/doc)').html).toContain('<a href="https://example.com/doc" aria-label="source">↗</a>');
    const css = readFileSync(new URL('../site/style.css', import.meta.url), 'utf8');
    const table = /\n\.table \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(table).toContain('max-height: 80vh;');
    expect(table).toContain('overflow: auto;');
  });
});
