// The Claude Code hook and Composer commands (decision D-133): composer require (and its alias and abbreviations),
// composer global require, create-project, composer update with packages or --with, php composer.phar, the root
// composer.json that declares other repositories, and the options, variables and configuration changes that weaken
// Composer's own protections for one command. The Packagist answers are recorded (tests/fixtures/packagist/).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNREAD_REGISTRY_IS_THE_USERS } from '../../src/check/hook.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { osvFetch } from '../support/osv.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A project with a policy of two weeks that denies install scripts, and the files given. */
function project(files: Record<string, string> = {}, policy: object = { cooldown: { minimum: '14d' }, installScripts: { default: 'deny' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d133-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  const all = { 'depcurfew.json': JSON.stringify({ version: 1, ...policy }), ...files };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, root: string, options: { fetch?: FetchLike; osv?: boolean; cwd?: string } = {}): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: options.cwd ?? root });
  const code = await run(['check', '--hook', 'claude-code', ...(options.osv === true ? ['--osv'] : [])], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => root,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const YOUNG = 'composer:guzzlehttp/guzzle:8.3.1 was published on Packagist 7 days ago; depcurfew.json requires 2 weeks (composer:guzzlehttp/guzzle:8.3.0 is old enough)';

describe('the hook reads Composer commands', () => {
  it('denies composer require of a release younger than the cooldown, and passes an old enough one', async () => {
    const root = project();
    const denied = await hook('composer require guzzlehttp/guzzle', root);
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain(`- composer:guzzlehttp/guzzle: ${YOUNG}. Fix: Install composer:guzzlehttp/guzzle:8.3.0 instead, or wait until composer:guzzlehttp/guzzle:8.3.1 is 2 weeks old`);
    // Platform packages are not looked up.
    expect(await hook('composer require "monolog/monolog:^3.9" php:^8.2 ext-json', root, { fetch: answerOnly(['monolog/monolog']) })).toEqual({});
  });

  it('reads the alias r, abbreviations as Composer resolves them, and the name and constraint as two words', async () => {
    const root = project();
    for (const command of ['composer r guzzlehttp/guzzle', 'composer req guzzlehttp/guzzle', 'composer REQUIRE guzzlehttp/guzzle', 'composer require guzzlehttp/guzzle ^8.3']) {
      expect((await hook(command, root)).permissionDecision).toBe('deny');
    }
    // re is ambiguous (reinstall, remove, repository, require), so Composer runs nothing.
    expect(await hook('composer re guzzlehttp/guzzle', root)).toEqual({});
    expect(await hook('composer require guzzlehttp/guzzle:8.3.0', root)).toEqual({});
  });

  it('reads php composer.phar, a path to composer and ./composer.phar', async () => {
    const root = project();
    for (const command of ['php composer.phar require guzzlehttp/guzzle', 'php -d memory_limit=-1 /usr/local/bin/composer require guzzlehttp/guzzle', './composer.phar require guzzlehttp/guzzle']) {
      expect((await hook(command, root)).permissionDecision).toBe('deny');
    }
  });

  it('denies a plugin the policy does not allow, and asks about a branch', async () => {
    const root = project();
    const plugin = await hook('composer require php-http/discovery', root);
    expect(plugin.permissionDecision).toBe('deny');
    expect(plugin.permissionDecisionReason).toContain('composer:php-http/discovery:1.20.0 is a Composer plugin (type composer-plugin)');
    const branch = await hook('composer require monolog/monolog:dev-main', root);
    expect(branch.permissionDecision).toBe('ask');
    expect(branch.permissionDecisionReason).toContain('"dev-main" names a branch of composer:monolog/monolog, not a release');
  });

  it('checks composer global require and create-project, without the composer.json of the directory', async () => {
    const root = project({ 'composer.json': JSON.stringify({ repositories: [{ type: 'vcs', url: 'https://git.example/acme/tool' }] }) });
    expect((await hook('composer global require guzzlehttp/guzzle', root)).permissionDecision).toBe('deny');
    expect(await hook('composer global require monolog/monolog', root)).toEqual({});
    expect((await hook('composer create-project guzzlehttp/guzzle app', root)).permissionDecision).toBe('deny');
    expect(await hook('composer create-project guzzlehttp/guzzle app 8.3.0', root)).toEqual({});
    expect((await hook('composer create-project monolog/monolog app --require=guzzlehttp/guzzle', root)).permissionDecision).toBe('deny');
    // composer require in the directory reads its composer.json.
    expect((await hook('composer require monolog/monolog', root)).permissionDecision).toBe('ask');
  });

  it('checks composer update of packages with the constraint of the root composer.json, a temporary one or --with', async () => {
    const root = project({ 'composer.json': JSON.stringify({ require: { 'guzzlehttp/guzzle': '^8.0', 'monolog/monolog': '^3.9' }, 'require-dev': { 'symfony/console': '8.1.9' } }) });
    expect((await hook('composer update guzzlehttp/guzzle', root)).permissionDecision).toBe('deny');
    expect(await hook('composer update monolog/monolog symfony/console', root)).toEqual({});
    expect((await hook('composer u monolog/monolog guzzlehttp/guzzle:8.3.1', root)).permissionDecision).toBe('deny');
    expect((await hook('composer update --with guzzlehttp/guzzle:8.3.1', root)).permissionDecision).toBe('deny');
    expect(await hook('composer update guzzlehttp/guzzle:8.3.0', root)).toEqual({});
    // A package the root composer.json does not require, patterns, the lock words and a full update are not checked.
    expect(await hook('composer update psr/log "guzzlehttp/*" lock', root)).toEqual({});
    expect(await hook('composer update', root)).toEqual({});
    expect(await hook('composer install', root)).toEqual({});
  });

  it('asks when the root composer.json declares another repository or turns Packagist off', async () => {
    const vcs = project({ 'composer.json': '{\n  "repositories": [\n    {"type": "vcs", "url": "https://git.example/acme/tool"}\n  ]\n}\n' });
    const asked = await hook('composer require monolog/monolog', vcs);
    expect(asked.permissionDecision).toBe('ask');
    expect(asked.permissionDecisionReason).toContain(
      '- composer:monolog/monolog: the install may take it from the vcs repository https://git.example/acme/tool that composer.json (line 3) declares, which Composer asks before Packagist; depcurfew checks only Packagist (https://repo.packagist.org), so it did not look the package up',
    );
    expect(asked.permissionDecisionReason).toContain(`Fix: ${UNREAD_REGISTRY_IS_THE_USERS}`);
    const off = project({ 'composer.json': '{"repositories": [{"packagist.org": false}]}' });
    expect((await hook('composer require monolog/monolog', off)).permissionDecisionReason).toContain(
      'the install would not use Packagist: composer.json (line 1) turns packagist.org off, so the package comes from the other repositories it declares; depcurfew checks only Packagist (https://repo.packagist.org), so it did not look the package up',
    );
    // A package that may come from that repository is not looked up on Packagist at all (decision D-136): the hook asks,
    // and never denies it as made up.
    const missing = await hook('composer require this-vendor-does-not-exist-xyz/nothing-123', vcs, { fetch: async (url) => Promise.reject(new Error(`unexpected request ${url}`)) });
    expect(missing.permissionDecision).toBe('ask');
    expect(missing.permissionDecisionReason).toContain(
      'composer:this-vendor-does-not-exist-xyz/nothing-123: the install may take it from the vcs repository https://git.example/acme/tool that composer.json (line 3) declares, which Composer asks before Packagist; depcurfew checks only Packagist (https://repo.packagist.org), so it did not look the package up',
    );
    // Packagist itself as a repository changes nothing; the composer.json of a subdirectory counts there.
    const same = project({ 'composer.json': '{"repositories": {"packagist.org": {"type": "composer", "url": "https://repo.packagist.org"}}}', 'app/composer.json': '{"repositories": [{"type": "path", "url": "../lib"}]}' });
    expect(await hook('composer require monolog/monolog', same)).toEqual({});
    expect((await hook('cd app && composer require monolog/monolog', same)).permissionDecision).toBe('ask');
    expect((await hook('composer -d app require monolog/monolog', same)).permissionDecision).toBe('ask');
    expect((await hook('composer --working-dir=app require monolog/monolog', same)).permissionDecisionReason).toContain('the path repository that app/composer.json (line 1) declares');
  });

  it('asks about options and variables that turn off Composer protections, as D-114 does for other tools', async () => {
    const root = project();
    const blocking = await hook('composer install --no-blocking', root);
    expect(blocking.permissionDecision).toBe('ask');
    expect(blocking.permissionDecisionReason).toBe(
      "depcurfew cannot vouch for what this command installs:\n- composer install --no-blocking: --no-blocking turns off all of Composer's policy blocking for the command, the cooldown and the blocking of versions flagged as malware included, which protects every package the command fetches, also those depcurfew does not check. Fix: Run the command without that option or variable, so the package manager keeps that protection; if the change is intended, the user decides",
    );
    for (const command of [
      'composer require monolog/monolog --no-cooldown',
      'composer require monolog/monolog --no-security-blocking',
      'COMPOSER_NO_BLOCKING=1 composer install',
      'COMPOSER_NO_BLOCKING=false composer install',
      'COMPOSER_NO_SECURITY_BLOCKING=on composer update',
      'COMPOSER_POLICY=0 composer update',
      'COMPOSER_POLICY_COOLDOWN_PERIOD="1 day" composer update',
      'COMPOSER_POLICY_COOLDOWN_PERIOD=3600 composer update',
      'COMPOSER_POLICY_COOLDOWN_BLOCK=off composer update',
      'COMPOSER_POLICY_MALWARE_BLOCK=0 composer install',
      'composer create-project monolog/monolog app --no-secure-http',
      'COMPOSER_NO_BLOCKING=$X composer install',
    ]) {
      expect((await hook(command, root)).permissionDecision, command).toBe('ask');
    }
    for (const command of ['COMPOSER_NO_BLOCKING=0 composer install', 'COMPOSER_NO_BLOCKING= composer install', 'COMPOSER_POLICY=1 composer update', 'COMPOSER_POLICY_COOLDOWN_PERIOD="30 days" composer update', 'composer install --no-plugins --no-scripts']) {
      expect(await hook(command, root), command).toEqual({});
    }
    // Without a cooldown in the policy, only what turns off more than the cooldown asks.
    const relaxed = project({}, {});
    expect(await hook('composer update --no-cooldown', relaxed)).toEqual({});
    expect((await hook('COMPOSER_POLICY_MALWARE_BLOCK=0 composer update', relaxed)).permissionDecision).toBe('ask');
  });

  it('asks when the same command changes Composer configuration or repositories, or names another manifest or repository', async () => {
    const root = project();
    for (const command of [
      'composer config repositories.acme vcs https://git.example/acme && composer require monolog/monolog',
      'composer config --global secure-http false && composer install',
      'composer conf allow-plugins.acme/plugin true && composer require monolog/monolog',
      'composer config --unset policy && composer update',
      'composer repo add acme vcs https://git.example/acme && composer require monolog/monolog',
      'composer repository disable packagist.org; composer install',
      'composer global config disable-tls true && composer global require monolog/monolog',
      'COMPOSER=other.json composer require monolog/monolog',
      'composer create-project --repository=https://repo.example monolog/monolog app',
    ]) {
      expect((await hook(command, root)).permissionDecision, command).toBe('ask');
    }
    for (const command of ['composer config --list && composer require monolog/monolog', 'composer config secure-http && composer install', 'composer repo list && composer install']) {
      expect(await hook(command, root), command).toEqual({});
    }
  });

  it('with --osv, denies a known malicious version that the cooldown lets through', async () => {
    const root = project({}, { cooldown: { minimum: '7d' } });
    expect(await hook('composer require intercom/intercom-php:5.0.2', root)).toEqual({});
    const fetch = osvFetch();
    const denied = await hook('composer require intercom/intercom-php:5.0.2', root, { fetch, osv: true });
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain(
      '- composer:intercom/intercom-php:5.0.2: composer:intercom/intercom-php:5.0.2 is a known malicious version: OSV.dev lists it as MAL-2026-3637 (https://osv.dev/vulnerability/MAL-2026-3637)',
    );
    expect(fetch.requests).toEqual([[{ package: { name: 'intercom/intercom-php', ecosystem: 'Packagist' }, version: '5.0.2' }]]);
  });
});

/** The recorded answers for these packages only; any other request fails, so that a test shows what was asked. */
function answerOnly(names: readonly string[]): FetchLike {
  return async (url, init) => {
    const name = /\/p2\/(.+)\.json$/u.exec(new URL(url).pathname)?.[1] ?? '';
    if (!names.includes(name)) throw new Error(`unexpected request ${url}`);
    return recordedFetch(url, init);
  };
}
