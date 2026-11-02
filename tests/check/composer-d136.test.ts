// Composer in check, the Claude Code hook and depcurfew mcp after the second security test of 1.4.0 (decision D-136):
// names in linear time, the command name as Composer finds it (getFirstArgument, scripts of composer.json), -d as
// Composer reads it, COMPOSER_HOME and composer global update, minimum-stability and prefer-stable, no lookup on
// Packagist for a package another repository may serve, versions written as composer require takes them, limits for
// Packagist answers and Composer in the PowerShell tool. Packagist answers are recorded (tests/fixtures/packagist/) or
// written here for a package acme/x.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseComposerSpec } from '../../src/check/composer.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { values } from '../../src/apply/facts.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d136-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}, policy: object = { cooldown: { minimum: '14d' }, installScripts: { default: 'deny' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d136-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries({ 'depcurfew.json': JSON.stringify({ version: 1, ...policy }), ...files })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const ACME = {
  minified: 'composer/2.0',
  packages: {
    'acme/x': [
      { name: 'acme/x', version: '2.0.0-beta1', version_normalized: '2.0.0.0-beta1', 'published-time': '2026-11-01T00:00:00+00:00', type: 'library' },
      { version: '1.0.0', version_normalized: '1.0.0.0', 'published-time': '2024-01-01T00:00:00+00:00' },
    ],
  },
};

/** The recorded answers, acme/x from above, and every URL asked for. */
function recording(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    if (url === 'https://repo.packagist.org/p2/acme/x.json') return new Response(JSON.stringify(ACME), { status: 200 });
    return recordedFetch(url, init);
  };
  return Object.assign(fetch, { urls });
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string };

async function hook(command: string, root: string, options: { fetch?: FetchLike; tool?: string } = {}): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: options.tool ?? 'Bash', tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => root,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

async function check(argv: string[], fetch: FetchLike = recordedFetch): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => undefined }, { fetch, now: () => NOW, stdin: async () => '', home: () => HOME, projectDir: () => undefined });
  return { code, stdout };
}

const decision = async (command: string, root: string, options: { fetch?: FetchLike; tool?: string } = {}) => (await hook(command, root, options)).permissionDecision ?? 'none';

describe('Composer names in linear time (R1)', () => {
  const fact = knowledgeBase.find((tool) => tool.id === 'composer')?.extra?.['commandArguments'];
  const arguments_ = (fact === undefined ? {} : values(fact)[0]) as { namePattern: string; platformPackages: string };

  it('reads a long name that fails at its end at once', () => {
    for (const text of [`${'a'.repeat(5000)}!`, `ext-${'a'.repeat(5000)}!`, `a/${'a'.repeat(5000)}!`, `${'a-'.repeat(2500)}/x!`]) {
      const start = performance.now();
      expect(parseComposerSpec(text)).toBeUndefined();
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it('accepts exactly the names and platform packages that the patterns of Composer 2.11.1 accept', () => {
    // The forms of ValidatingArrayLoader::hasPackageNamingError and PlatformRepository::PLATFORM_PACKAGE_REGEX.
    const name = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/u;
    const platform = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|(?:ext|lib)-[a-z0-9](?:[_.-]?[a-z0-9]+)*|composer(?:-(?:plugin|runtime)-api)?)$/iu;
    const ours = new RegExp(arguments_.namePattern, 'u');
    const oursPlatform = new RegExp(arguments_.platformPackages, 'iu');
    const alphabet = ['a', '1', '-', '_', '.', '/'];
    const words = [''];
    for (let length = 1; length <= 6; length++) for (const word of words.filter((entry) => entry.length === length - 1)) for (const letter of alphabet) words.push(`${word}${letter}`);
    for (const word of words) {
      expect(ours.test(word)).toBe(name.test(word));
      expect(oursPlatform.test(`ext-${word}`)).toBe(platform.test(`ext-${word}`));
    }
  });

  it('gives check and the hook an answer at once for such a name', async () => {
    const root = project();
    let start = performance.now();
    const result = await check(['check', '--json', '--dir', root, `composer:${'a'.repeat(30)}!`]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stdout).packages[0].findings[0].code).toBe('invalid-spec');
    expect(performance.now() - start).toBeLessThan(2000);
    start = performance.now();
    await hook(`composer require ext-${'a'.repeat(30)}! ; composer require monolog/monolog`, root);
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it('does not read a name longer than 1000 characters', () => {
    expect(parseComposerSpec(`a/${'b'.repeat(1000)}`)).toBeUndefined();
    expect(parseComposerSpec(`a/${'b'.repeat(990)}`)?.name).toBe(`a/${'b'.repeat(990)}`);
  });
});

describe('the command name as Composer finds it (finding 2)', () => {
  it('gives a value before the command name only to the options of the application', async () => {
    const root = project();
    for (const command of [
      'composer --ignore-platform-req require update guzzlehttp/guzzle',
      'composer --apcu-autoloader-prefix require update guzzlehttp/guzzle',
      'composer --dev require guzzlehttp/guzzle',
      'composer -d . require guzzlehttp/guzzle',
      'composer --working-dir . -n require guzzlehttp/guzzle',
      'composer -- require guzzlehttp/guzzle',
      'composer global --ignore-platform-req require update guzzlehttp/guzzle',
    ]) {
      expect([command, await decision(command, root)]).toEqual([command, 'deny']);
    }
    // -d given twice: getFirstArgument skips a word only when it equals the value bound last, so with two different
    // directories Composer takes the first one for the command name, which it does not know, and runs nothing.
    expect(await decision('composer -d . -d . require guzzlehttp/guzzle', root)).toBe('deny');
    expect(await decision('composer -d . -d .. require guzzlehttp/guzzle', root)).toBe('none');
  });
});

describe('-d and --working-dir as Composer reads them (finding 4)', () => {
  const VCS = '{"repositories":[{"type":"vcs","url":"https://git.example/acme/x"}]}\n';

  it('moves only for a word that starts with -d or --working-dir, the first one', async () => {
    const root = project({ 'composer.json': VCS, 'sub/composer.json': '{}\n' });
    expect(await decision('composer require guzzlehttp/guzzle:8.3.0', root)).toBe('ask');
    expect(await decision('composer -nd sub require guzzlehttp/guzzle:8.3.0', root)).toBe('ask');
    expect(await decision('composer -n -d sub require guzzlehttp/guzzle:8.3.0', root)).toBe('none');
    expect(await decision('composer -dsub require guzzlehttp/guzzle:8.3.0', root)).toBe('none');
    expect(await decision('composer --working-dir=sub require guzzlehttp/guzzle:8.3.0', root)).toBe('none');
    expect(await decision('composer require -d sub guzzlehttp/guzzle:8.3.0', root)).toBe('none');
    expect(await decision('composer require -d sub -d . guzzlehttp/guzzle:8.3.0', root)).toBe('none');
    expect(await decision('composer require -d . -d sub guzzlehttp/guzzle:8.3.0', root)).toBe('ask');
    // After --, Composer looks no further: the words are packages, and the install stays in the root.
    expect(await decision('composer require guzzlehttp/guzzle:8.3.0 -- -d sub', root)).not.toBe('none');
  });
});

describe('COMPOSER_HOME and composer global update (finding 6)', () => {
  it('asks when COMPOSER_HOME is set on the command line, as for COMPOSER', async () => {
    const root = project({ 'home/composer.json': '{"repositories":[{"type":"vcs","url":"https://git.example/acme/x"}]}\n' });
    const result = await hook('COMPOSER_HOME=./home composer global require guzzlehttp/guzzle:8.3.0', root);
    expect(result.permissionDecision).toBe('ask');
    expect(result.permissionDecisionReason).toContain('COMPOSER_HOME');
    expect(await decision('COMPOSER_HOME=./home composer require guzzlehttp/guzzle:8.3.0', root)).toBe('ask');
    expect(await decision('COMPOSER=other.json composer require guzzlehttp/guzzle:8.3.0', root)).toBe('ask');
  });

  it('asks about composer global update of a name without a constraint, whose constraint it cannot read', async () => {
    const root = project({ 'composer.json': '{"require":{"guzzlehttp/guzzle":"^8.3"}}\n' });
    expect(await decision('composer update guzzlehttp/guzzle', root)).toBe('deny');
    const global = await hook('composer global update guzzlehttp/guzzle', root);
    expect(global.permissionDecision).toBe('ask');
    expect(global.permissionDecisionReason).toContain('COMPOSER_HOME/composer.json');
    expect(await decision('composer global update guzzlehttp/guzzle:8.3.0', root)).toBe('none');
  });
});

describe('scripts of composer.json as commands (finding 8)', () => {
  const scripts = (value: object) => JSON.stringify({ scripts: value, 'scripts-aliases': { tool: ['r'] } });

  it('reads a word that names a script, or that a script makes ambiguous, as Composer does', async () => {
    const root = project({ 'composer.json': scripts({ inst: '@composer require', required: 'echo', tool: 'echo', 'a::b': 'echo' }) });
    // An exact command name: Composer does not register the scripts at all.
    expect(await decision('composer require guzzlehttp/guzzle', root)).toBe('deny');
    // A script name with an invalid name keeps the reading of Composer's own commands (Composer stops on it).
    expect(await decision('composer req guzzlehttp/guzzle', root)).toBe('deny');
    const clean = project({ 'composer.json': scripts({ inst: '@composer require', required: 'echo', tool: 'echo' }) });
    // req stands for require and the script required: ambiguous, Composer runs nothing.
    expect(await decision('composer req guzzlehttp/guzzle', clean)).toBe('none');
    // The alias r of the script tool replaces Composer's alias r from Composer 2.7.0; before, r is require, which is
    // checked (decision D-138).
    expect(await decision('composer r guzzlehttp/guzzle', clean)).toBe('deny');
    // inst is the script, run as composer run-script inst runs it.
    expect(await decision('composer inst guzzlehttp/guzzle', clean)).toBe('none');
    expect(await decision('composer run-script inst guzzlehttp/guzzle', clean)).toBe('none');
  });

  it('does not count a script named after a Composer command or an event', async () => {
    const root = project({ 'composer.json': JSON.stringify({ scripts: { require: 'echo', 'post-install-cmd': 'echo', 'pre_update_cmd': 'echo' } }) });
    expect(await decision('composer req guzzlehttp/guzzle', root)).toBe('deny');
    expect(await decision('composer r guzzlehttp/guzzle', root)).toBe('deny');
  });
});

describe('minimum-stability and prefer-stable of the root composer.json (R2)', () => {
  it('picks a beta where minimum-stability allows it, and the stable release with prefer-stable', async () => {
    const beta = project({ 'composer.json': JSON.stringify({ name: 'me/app', 'minimum-stability': 'beta' }) });
    const denied = await hook('composer require acme/x', beta, { fetch: recording() });
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('composer:acme/x:2.0.0-beta1 was published on Packagist');
    const stable = project({ 'composer.json': JSON.stringify({ name: 'me/app', 'minimum-stability': 'beta', 'prefer-stable': true }) });
    expect(await decision('composer require acme/x', stable, { fetch: recording() })).toBe('none');
    expect(await decision('composer require acme/x:^2.0', stable, { fetch: recording() })).toBe('deny');
  });

  it('does not vouch for a constraint when minimum-stability is dev without prefer-stable, as for @dev', async () => {
    const dev = project({ 'composer.json': JSON.stringify({ name: 'me/app', 'minimum-stability': 'dev' }) });
    const asked = await hook('composer require monolog/monolog:^3.0', dev);
    expect(asked.permissionDecision).toBe('ask');
    expect(asked.permissionDecisionReason).toContain('minimum-stability');
    const preferred = project({ 'composer.json': JSON.stringify({ name: 'me/app', 'minimum-stability': 'dev', 'prefer-stable': true }) });
    expect(await decision('composer require monolog/monolog:^3.0', preferred)).toBe('none');
  });
});

describe('no lookup on Packagist for a package another repository may serve (R3)', () => {
  it('sends nothing to Packagist when composer.json declares another repository, and says why it did not check', async () => {
    const root = project({ 'composer.json': '{\n  "repositories": [\n    { "type": "composer", "url": "https://packages.corp.example" }\n  ]\n}\n' });
    const fetch = recording();
    const result = await check(['check', '--json', '--dir', root, 'composer:corp/secret-thing'], fetch);
    expect(fetch.urls).toEqual([]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stdout).packages[0].findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message:
          'the install may take it from the composer repository https://packages.corp.example that composer.json (line 3) declares, which Composer asks before Packagist; depcurfew checks only Packagist (https://repo.packagist.org), so it did not look the package up',
        fix: 'Before installing it, check the package in the repositories that composer.json declares: depcurfew checks only Packagist (https://repo.packagist.org), so it cannot vouch for a package from another repository',
      },
    ]);
  });
});

describe('versions written as composer require takes them (R4)', () => {
  it('writes vendor/name:version in every message', async () => {
    const root = project();
    const result = await check(['check', '--json', '--dir', root, 'composer:guzzlehttp/guzzle']);
    const [finding] = JSON.parse(result.stdout).packages[0].findings as { message: string; fix: string }[];
    expect(finding?.message).toBe('composer:guzzlehttp/guzzle:8.3.1 was published on Packagist 7 days ago; depcurfew.json requires 2 weeks (composer:guzzlehttp/guzzle:8.3.0 is old enough)');
    expect(finding?.fix).toBe('Install composer:guzzlehttp/guzzle:8.3.0 instead, or wait until composer:guzzlehttp/guzzle:8.3.1 is 2 weeks old');
  });
});

describe('limits for Packagist answers (finding 7)', () => {
  const answer = (count: number, tail: string) => {
    const entries: object[] = [];
    for (let index = 0; index < count; index++) {
      entries.push(index === 0 ? { name: 'big/p', version: `${index}.0.0-beta${tail}`, 'published-time': '2026-01-01T00:00:00+00:00' } : { version: `${index}.0.0-beta${tail}` });
    }
    return JSON.stringify({ minified: 'composer/2.0', packages: { 'big/p': entries } });
  };
  const serving = (body: string): FetchLike => async () => new Response(body, { status: 200 });

  it('does not read more than 10,000 versions of a package', async () => {
    const root = project();
    const result = await check(['check', '--json', '--dir', root, 'composer:big/p:@beta'], serving(answer(10_001, '')));
    expect(JSON.parse(result.stdout).packages[0].findings).toEqual([
      expect.objectContaining({ code: 'unverified', message: 'it cannot be checked: the repository lists more than 10000 versions of big/p, more than depcurfew reads of one package, so its versions were not checked' }),
    ]);
  });

  it('does not read an answer larger than 16 MiB', async () => {
    const root = project();
    const big = JSON.stringify({ minified: 'composer/2.0', packages: { 'big/p': [{ name: 'big/p', version: '1.0.0', 'published-time': '2026-01-01T00:00:00+00:00', description: 'x'.repeat(17 * 1024 * 1024) }] } });
    const result = await check(['check', '--json', '--dir', root, 'composer:big/p:@beta'], serving(big));
    expect(JSON.parse(result.stdout).packages[0].findings[0].code).toBe('unverified');
  });

  it('does not read a version longer than 255 characters, which Composer may pick', async () => {
    const root = project();
    const result = await check(['check', '--json', '--dir', root, 'composer:big/p:@beta'], serving(answer(10, '.1'.repeat(130))));
    expect(JSON.parse(result.stdout).packages[0].findings).toEqual([
      expect.objectContaining({ code: 'unverified', message: 'it cannot be checked: Packagist lists a version of big/p longer than 255 characters, more than depcurfew reads, so its versions were not checked' }),
    ]);
  });

  it('reads the largest answer it accepts in time', { timeout: 60_000 }, async () => {
    const root = project();
    const body = answer(10_000, '.1'.repeat(118));
    expect(body.length).toBeLessThan(16 * 1024 * 1024);
    const start = performance.now();
    const result = await check(['check', '--json', '--dir', root, 'composer:big/p:@beta'], serving(body));
    expect(result.code).toBe(EXIT_OK);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('Composer in the PowerShell tool (TB1)', () => {
  it('decides as in Bash: the word composer is no assignment of the variable COMPOSER', async () => {
    const root = project();
    for (const command of ['composer require guzzlehttp/guzzle', 'composer.cmd require guzzlehttp/guzzle', 'php composer.phar require guzzlehttp/guzzle']) {
      expect([command, await decision(command, root, { tool: 'PowerShell' })]).toEqual([command, 'deny']);
    }
    expect(await decision('composer require guzzlehttp/guzzle:8.3.0', root, { tool: 'PowerShell' })).toBe('none');
    expect(await decision('composer update guzzlehttp/guzzle:8.3.0', root, { tool: 'PowerShell' })).toBe('none');
  });

  it('still asks about COMPOSER set through the environment provider or .NET', async () => {
    const root = project();
    for (const command of [
      "$env:COMPOSER = 'other.json'; composer require guzzlehttp/guzzle:8.3.0",
      'Set-Item env:COMPOSER other.json; composer require guzzlehttp/guzzle:8.3.0',
      "[Environment]::SetEnvironmentVariable('COMPOSER', 'other.json'); composer require guzzlehttp/guzzle:8.3.0",
      'New-Item -Path Env: -Name COMPOSER -Value other.json; composer require guzzlehttp/guzzle:8.3.0',
    ]) {
      expect([command, await decision(command, root, { tool: 'PowerShell' })]).toEqual([command, 'ask']);
    }
  });
});
