// apply on Composer projects (decision D-126): config.policy.cooldown and config.allow-plugins in composer.json, with
// the hand-written values a JSON file without markers can hold, and composer update --lock after a change of the policy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { warningText, type ApplyWarning } from '../../src/apply/warnings.ts';
import { buildReport, renderReport } from '../../src/cli/explain.ts';
import { runDoctor } from '../../src/doctor/index.ts';

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

  it('writes nothing below "policy": false or an ignore that is neither a list nor an object, and says why, with the line', () => {
    const off = project({ config: { policy: false } }, { cooldown: { minimum: '3d' } });
    const report = applyProject(off);
    expect(report.changes).toEqual([]);
    // The cooldown is not written: cooldown-not-written, which explain shows with the cooldown, not with installScripts.
    expect(report.warningDetails.filter((warning) => warning.code === 'cooldown-not-written').map((warning) => [warning.location, warningText(warning)])).toEqual([
      [
        { file: 'composer.json', line: 3 },
        'Composer: cooldown not written: config.policy in composer.json (line 3) is false, not an object, so depcurfew apply does not write config.policy.cooldown.period below it. config.policy: false turns that Composer protection off; remove it from composer.json (depcurfew doctor reports it), then run depcurfew apply again',
      ],
    ]);
    const odd = project({ config: { policy: { cooldown: { ignore: 'acme/x' } } } }, { cooldown: { minimum: '3d', exclude: ['composer:acme/y'] } });
    const second = applyProject(odd);
    expect(config(odd)).toEqual({ policy: { cooldown: { ignore: 'acme/x', period: '3 days' } } });
    expect(second.warningDetails.filter((warning) => warning.code !== 'version-not-pinned').map((warning) => [warning.code, warning.location])).toEqual([['exclude-not-written', { file: 'composer.json', line: 5 }]]);
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
      'Composer: config.allow-plugins in composer.json (line 4) blocks the plugin acme/plugin with "acme/*": false, but installScripts.allow in depcurfew.json allows it; depcurfew apply does not change entries it did not write',
      'Composer: config.allow-plugins in composer.json (line 5) lets the plugin tools/bad run with "tools/*": true, although installScripts.deny in depcurfew.json says it must not run; depcurfew apply does not change entries it did not write',
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

/** The policy file with Composer as the only target. */
function setPolicy(root: string, policy: object): void {
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, targets: ['composer'], ...policy }));
}

const findings = (root: string, rule: string) => runDoctor(root).findings.filter((finding) => finding.rule === rule);

describe('apply on Composer projects: its own entries, the case of keys and values Composer reads like the policy (decision D-134)', () => {
  it('says when an ignore entry exempts a package that cooldown.exclude no longer lists, in apply and doctor', () => {
    const root = project({ require: { 'acme/x': '^1.0' } }, { cooldown: { minimum: '3d', exclude: ['composer:acme/x'] } });
    applyProject(root);
    expect(config(root)).toEqual({ policy: { cooldown: { period: '3 days', ignore: ['acme/x'] } } });
    setPolicy(root, { cooldown: { minimum: '3d' } });
    const report = applyProject(root);
    // The list form carries no mark of apply, so the entry stays.
    expect(report.changes).toEqual([]);
    const outside = report.warningDetails.filter((warning) => warning.code === 'exclude-entry-outside-policy');
    expect(outside.map((warning) => [warning.location, warningText(warning)])).toEqual([
      [
        { file: 'composer.json', line: 10 },
        'Composer: config.policy.cooldown.ignore in composer.json (line 10) lists acme/x, which Composer exempts from the release-age delay, but cooldown.exclude in depcurfew.json does not exclude it; depcurfew apply removes only the entries it wrote, with the reason "cooldown.exclude in depcurfew.json". Remove "acme/x" from config.policy.cooldown.ignore in composer.json and run composer update --lock, or add composer:acme/x to cooldown.exclude in depcurfew.json',
      ],
    ]);
    expect(findings(root, 'config-drift').map(({ level, location, message }) => ({ level, location, message }))).toEqual([
      {
        level: 'warning',
        location: { file: 'composer.json', line: 10 },
        message: 'config.policy.cooldown.ignore in composer.json lists acme/x, which Composer exempts from the release-age delay, but cooldown.exclude in depcurfew.json does not exclude it',
      },
    ]);
  });

  it('removes from an ignore object the entries it wrote with its reason once the policy drops them, and keeps the others with a warning', () => {
    const root = project(
      { config: { policy: { cooldown: { period: '3 days', ignore: { 'acme/legacy': { constraint: '^1.0', reason: 'pinned' } } } } } },
      { cooldown: { minimum: '3d', exclude: ['composer:acme/legacy', 'composer:acme/tools'] } },
      { 'composer.lock': LOCK },
    );
    applyProject(root);
    expect((config(root)['policy'] as { cooldown: unknown }).cooldown).toEqual({
      period: '3 days',
      ignore: { 'acme/legacy': { constraint: '^1.0', reason: 'pinned' }, 'acme/tools': 'cooldown.exclude in depcurfew.json' },
    });
    setPolicy(root, { cooldown: { minimum: '3d' } });
    const report = applyProject(root);
    expect((config(root)['policy'] as { cooldown: unknown }).cooldown).toEqual({ period: '3 days', ignore: { 'acme/legacy': { constraint: '^1.0', reason: 'pinned' } } });
    expect(codes(report.warningDetails)).toEqual(['exclude-entry-outside-policy', 'lockfile-out-of-date']);
    expect(report.warningDetails.find((warning) => warning.code === 'exclude-entry-outside-policy')?.message).toContain('lists acme/legacy');
    expect(applyProject(root).changes).toEqual([]);
  });

  it('reads allow-plugins keys as Composer does: in any case, and never offers a pattern for every plugin as a policy name', () => {
    const upper = project({ config: { 'allow-plugins': { 'Symfony/Flex': true } } }, { installScripts: { default: 'deny', allow: ['composer:symfony/flex'] } });
    const report = applyProject(upper);
    expect(report.changes).toEqual([]);
    expect(codes(report.warningDetails)).toEqual([]);
    expect(findings(upper, 'config-drift')).toEqual([]);

    // A denial in another case: one warning, with the policy name in lower case.
    const blocked = project({ config: { 'allow-plugins': { 'Symfony/Flex': false } } }, { installScripts: { default: 'deny', allow: ['composer:symfony/flex'] } });
    const conflicts = applyProject(blocked).warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file');
    expect(conflicts.map((warning) => warning.fix)).toEqual([
      'Remove Symfony/Flex from allow-plugins in composer.json, or move composer:symfony/flex from installScripts.allow to installScripts.deny in depcurfew.json if it works without its scripts',
    ]);

    for (const key of ['*', '*/*']) {
      const every = project({ config: { 'allow-plugins': { [key]: true } } }, { installScripts: { default: 'deny', allow: ['composer:symfony/flex'] } });
      const warnings = applyProject(every).warningDetails.filter((warning) => warning.code === 'allow-list-entry-outside-policy');
      expect(warnings.map(warningText)).toEqual([
        `allow-plugins in composer.json (line 4) has "${key}": true, which lets every plugin that no earlier key names run, but depcurfew.json does not allow them; depcurfew apply does not remove entries it did not write. Remove "${key}" from allow-plugins in composer.json by hand and list the plugins that may run in installScripts.allow in depcurfew.json (with the prefix composer:), then run depcurfew apply`,
      ]);
      const fixes = [...warnings, ...runDoctor(every).findings].map((item) => item.fix ?? '');
      expect(fixes.filter((fix) => fix.includes(`composer:${key}`))).toEqual([]);
      expect(findings(every, 'composer-config-weakens').map((finding) => finding.message)).toEqual([
        `config.allow-plugins in composer.json has "${key}": true, which lets every Composer plugin run its code, but installScripts in depcurfew.json denies dependency code by default`,
      ]);
    }
  });

  it('says to put an allowed plugin before a catch-all that blocks it, never to allow every plugin', () => {
    const root = project(
      { config: { 'allow-plugins': { 'composer/installers': true, '*': false } } },
      { installScripts: { default: 'deny', allow: ['composer:composer/installers', 'composer:symfony/flex'] } },
    );
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file').map((warning) => [warning.location, warning.fix])).toEqual([
      [
        { file: 'composer.json', line: 5 },
        'Put "symfony/flex": true before "*" in config.allow-plugins of composer.json, because Composer takes the first key that matches, or move composer:symfony/flex from installScripts.allow to installScripts.deny in depcurfew.json',
      ],
    ]);
  });

  it.each([259200, '259200', '72 hours', '3 days', '3days'])('leaves %j alone when cooldown.minimum is 3d, so composer.lock stays up to date', (period) => {
    const root = project({ config: { policy: { cooldown: { period } } } }, { cooldown: { minimum: '3d' } }, { 'composer.lock': LOCK });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(codes(report.warningDetails)).toEqual([]);
  });

  it('writes the delay into "policy": true and "cooldown": true, which Composer reads as {}', () => {
    const policyTrue = project({ config: { policy: true } }, { cooldown: { minimum: '3d' } });
    expect(codes(applyProject(policyTrue).warningDetails)).toEqual([]);
    expect(config(policyTrue)).toEqual({ policy: { cooldown: { period: '3 days' } } });
    const cooldownTrue = project({ config: { policy: { cooldown: true, malware: { block: true } } } }, { cooldown: { minimum: '3d' } });
    expect(codes(applyProject(cooldownTrue).warningDetails)).toEqual([]);
    expect(config(cooldownTrue)).toEqual({ policy: { cooldown: { period: '3 days' }, malware: { block: true } } });
    expect(applyProject(cooldownTrue).changes).toEqual([]);
  });

  it('names the line of allow-plugins in its warnings', () => {
    const all = project({ config: { 'allow-plugins': true } }, { installScripts: { default: 'deny' } });
    const replaced = applyProject(all).warningDetails.filter((warning) => warning.code === 'allow-all-replaced');
    expect(replaced.map((warning) => warning.location)).toEqual([{ file: 'composer.json', line: 3 }]);
    expect(config(all)['allow-plugins']).toEqual({});
    const none = project({ config: { 'allow-plugins': false } }, { installScripts: { default: 'deny', allow: ['composer:a/b'] } });
    expect(applyProject(none).warningDetails.filter((warning) => warning.code === 'deny-conflicts-with-file').map((warning) => warning.message)).toEqual([
      'Composer: config.allow-plugins in composer.json (line 3) is false, which blocks every plugin, also composer:a/b that installScripts.allow in depcurfew.json allows; depcurfew apply does not change entries it did not write',
    ]);
  });
});

describe('explain on Composer projects shows what apply does (decision D-134)', () => {
  it('shows no Composer delay when config.policy is false, and the reason, not under installScripts', () => {
    const root = project({ config: { policy: false } }, { cooldown: { minimum: '3d' }, installScripts: { default: 'deny' } });
    const report = buildReport(root);
    if (report.policy === null || !report.policy.valid) throw new Error('policy');
    expect(report.policy.cooldown?.tools).toEqual([
      { tool: 'composer', ok: false, reason: 'config.policy in composer.json (line 3) is false, not an object, so depcurfew apply does not write config.policy.cooldown.period below it' },
    ]);
    expect(report.policy.installScripts?.tools.flatMap((tool) => tool.warnings.map((warning) => warning.code))).not.toContain('cooldown-not-written');
    expect(renderReport(report)).toContain('    Composer: cannot apply: config.policy in composer.json (line 3) is false');
  });

  it('names config.allow-plugins when apply replaces "allow-plugins": true', () => {
    const root = project({ config: { 'allow-plugins': true } }, { installScripts: { default: 'deny' } });
    const report = buildReport(root);
    if (report.policy === null || !report.policy.valid) throw new Error('policy');
    expect(report.policy.installScripts?.tools.map((tool) => tool.settings)).toEqual([[{ setting: 'config.allow-plugins', file: 'composer.json' }]]);
  });
});
