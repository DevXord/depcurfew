// apply on Composer projects (decision D-126): config.policy.cooldown and config.allow-plugins in composer.json, with
// the hand-written values a JSON file without markers can hold, and composer update --lock after a change of the policy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { warningText, type ApplyWarning } from '../../src/apply/warnings.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const LOCK = '{\n    "content-hash": "0",\n    "packages": [],\n    "packages-dev": [],\n    "plugin-api-version": "2.11.0"\n}\n';

function project(composer: unknown, policy: object, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-composer-'));
  temporary.push(root);
  if (composer !== undefined) writeFileSync(join(root, 'composer.json'), `${JSON.stringify(composer, null, 4)}\n`);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, targets: ['composer'], ...policy }));
  return root;
}

const manifest = (root: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, 'composer.json'), 'utf8')) as Record<string, unknown>;
const config = (root: string): Record<string, unknown> => (manifest(root)['config'] ?? {}) as Record<string, unknown>;
const codes = (warnings: readonly ApplyWarning[]) => warnings.map((warning) => warning.code).filter((code) => code !== 'version-not-pinned');

describe('apply on Composer projects', () => {
  it('writes the cooldown in whole days, rounded up, and the composer: exceptions as a list', () => {
    const root = project({ require: { 'psr/log': '^3.0' } }, { cooldown: { minimum: '36h', exclude: ['composer:acme/*', '@acme/*', 'pypi:acme'] } });
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(config(root)).toEqual({ policy: { cooldown: { period: '2 days', ignore: ['acme/*'] } } });
    expect(applyProject(root).changes).toEqual([]);
  });

  it('adds names to an ignore object with a reason, keeps every entry written by hand and replaces a longer period with a warning', () => {
    const root = project(
      { config: { policy: { cooldown: { period: '14 days', ignore: { 'acme/legacy': { constraint: '^1.0', reason: 'pinned' } } }, malware: { 'block-scope': 'all' } } } },
      { cooldown: { minimum: '3d', exclude: ['composer:acme/tools', 'composer:acme/legacy'] } },
    );
    const report = applyProject(root);
    expect(config(root)).toEqual({
      policy: {
        cooldown: { period: '3 days', ignore: { 'acme/legacy': { constraint: '^1.0', reason: 'pinned' }, 'acme/tools': 'cooldown.exclude in depcurfew.json' } },
        malware: { 'block-scope': 'all' },
      },
    });
    expect(codes(report.warningDetails)).toEqual(['cooldown-shortened']);
  });

  it('writes nothing below "policy": false or an ignore that is neither a list nor an object, and says why', () => {
    const off = project({ config: { policy: false } }, { cooldown: { minimum: '3d' } });
    const report = applyProject(off);
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.filter((warning) => warning.code === 'unexpected-value').map(warningText)).toEqual([
      'Composer: config.policy in composer.json is false, not an object, so depcurfew apply does not write config.policy.cooldown.period below it. config.policy: false turns that part of the policy off; remove it from composer.json (depcurfew doctor reports it), then run depcurfew apply again',
    ]);
    const odd = project({ config: { policy: { cooldown: { ignore: 'acme/x' } } } }, { cooldown: { minimum: '3d', exclude: ['composer:acme/y'] } });
    const second = applyProject(odd);
    expect(config(odd)).toEqual({ policy: { cooldown: { ignore: 'acme/x', period: '3 days' } } });
    expect(codes(second.warningDetails)).toEqual(['unexpected-value']);
  });

  it('lists allowed plugins as true and denied ones as false, after the entries written by hand', () => {
    const root = project(
      { config: { 'allow-plugins': { 'symfony/flex': true } } },
      { installScripts: { default: 'deny', allow: ['composer:php-http/discovery', 'composer:acme/*-plugin', 'composer:symfony/flex'], deny: ['composer:phpstan/extension-installer'] } },
    );
    expect(applyProject(root).errors).toEqual([]);
    expect(Object.entries(config(root)['allow-plugins'] as object)).toEqual([
      ['symfony/flex', true],
      ['php-http/discovery', true],
      ['acme/*-plugin', true],
      ['phpstan/extension-installer', false],
    ]);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('replaces "allow-plugins": true when the policy denies plugins, and leaves false alone', () => {
    const all = project({ config: { 'allow-plugins': true } }, { installScripts: { default: 'deny', allow: ['composer:php-http/discovery'] } });
    expect(codes(applyProject(all).warningDetails)).toEqual(['allow-all-replaced']);
    expect(config(all)['allow-plugins']).toEqual({ 'php-http/discovery': true });
    const none = project({ config: { 'allow-plugins': false } }, { installScripts: { default: 'deny', allow: ['composer:php-http/discovery'], deny: ['composer:acme/x'] } });
    const report = applyProject(none);
    expect(report.changes).toEqual([]);
    expect(codes(report.warningDetails)).toEqual(['deny-conflicts-with-file']);
  });

  it('says when an earlier pattern written by hand decides a plugin, because Composer takes the first key that matches', () => {
    const root = project(
      { config: { 'allow-plugins': { 'acme/*': false, 'tools/*': true } } },
      { installScripts: { default: 'deny', allow: ['composer:acme/plugin'], deny: ['composer:tools/bad'] } },
    );
    const report = applyProject(root);
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file').map((warning) => warning.message)).toEqual([
      'Composer: config.allow-plugins in composer.json blocks the plugin acme/plugin with "acme/*": false, but installScripts.allow in depcurfew.json allows it; depcurfew apply does not change entries it did not write',
      'Composer: config.allow-plugins in composer.json lets the plugin tools/bad run with "tools/*": true, although installScripts.deny in depcurfew.json says it must not run; depcurfew apply does not change entries it did not write',
    ]);
  });

  it('sets "allow-plugins": true for installScripts "allow" only where nothing is set', () => {
    const root = project({ require: {} }, { installScripts: { default: 'allow' } });
    applyProject(root);
    expect(config(root)['allow-plugins']).toBe(true);
    const listed = project({ config: { 'allow-plugins': { 'a/b': true } } }, { installScripts: { default: 'allow' } });
    expect(applyProject(listed).changes).toEqual([]);
  });

  it('says to run composer update --lock when config.policy changes and composer.lock exists, and only then', () => {
    const relock = (root: string) => applyProject(root).warningDetails.filter((warning) => warning.code === 'lockfile-out-of-date').map(warningText);
    const root = project({ require: {} }, { cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['composer:a/b'] } }, { 'composer.lock': LOCK });
    expect(relock(root)).toEqual([
      'Composer: composer.lock records a hash of config.policy in composer.json, which this change alters, so composer.lock is out of date: composer install warns about it and composer validate fails. Run composer update --lock, which writes the new hash without updating packages, and commit composer.lock',
    ]);
    expect(relock(root)).toEqual([]);
    // allow-plugins is not part of the hash.
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, targets: ['composer'], cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: ['composer:a/b', 'composer:c/d'] } }));
    expect(relock(root)).toEqual([]);
    expect(relock(project({ require: {} }, { cooldown: { minimum: '3d' } }))).toEqual([]);
  });

  it('does not create composer.json when only composer.lock is there', () => {
    const root = project(undefined, { cooldown: { minimum: '3d' } }, { 'composer.lock': LOCK });
    const report = applyProject(root);
    expect(report.changes).toEqual([]);
    expect(codes(report.warningDetails)).toEqual(['manifest-missing']);
  });

  it('keeps the formatting of composer.json', () => {
    const text = '{\n  "name": "acme/app",\n  // not valid for Composer, but kept as it is\n  "config": {\n    "sort-packages": true\n  }\n}\n';
    const root = project(undefined, { cooldown: { minimum: '1w' } }, { 'composer.json': text });
    applyProject(root);
    expect(readFileSync(join(root, 'composer.json'), 'utf8')).toBe(
      '{\n  "name": "acme/app",\n  // not valid for Composer, but kept as it is\n  "config": {\n    "sort-packages": true,\n    "policy": {\n      "cooldown": {\n        "period": "7 days"\n      }\n    }\n  }\n}\n',
    );
  });
});
