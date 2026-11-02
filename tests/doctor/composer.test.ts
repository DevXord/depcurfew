// Composer in doctor (decision D-126): the delay as Composer reads it, where composer.lock says a package comes from,
// what allow-plugins decides for a plugin, and that check looks Composer packages up on Packagist (decision D-133).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSpecs } from '../../src/check/index.ts';
import { Repository } from '../../src/detect/repository.ts';
import { composerEntries, declaredRepositories, matchesEveryComposerName, normalizedUrl, pluginDecision } from '../../src/doctor/composer.ts';
import { delayMinutes } from '../../src/doctor/durations.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { DEFAULT_POLICY } from '../../src/policy/defaults.ts';
import { validatePolicy } from '../../src/policy/validate.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';

const composer = knowledgeBase.find((tool) => tool.id === 'composer') as ToolKnowledge;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe('the Composer cooldown as Composer reads it', () => {
  it.each([
    ['7 days', 10080],
    ['1 week', 10080],
    ['24 hours', 1440],
    ['30 minutes', 30],
    ['1day', 1440],
    [259200, 4320],
    ['259200', 4320],
    [null, 0],
  ])('%s', (value, minutes) => {
    expect(delayMinutes(composer, value, undefined)).toEqual({ ok: true, minutes });
  });

  it.each(['7 Days', '1 day 2 hours', '3d', 'P7D', 'next week', ' 14 days', '14 days ', ' 259200'])('does not read %j, which Composer rejects', (value) => {
    expect(delayMinutes(composer, value, undefined).ok).toBe(false);
  });
});

describe('composer.lock as Composer reads it (decision D-134)', () => {
  const lock = (packages: object[]) => JSON.stringify({ packages, 'packages-dev': [] });
  const zip = (url: string) => ({ type: 'zip', url, reference: 'abc', shasum: '' });

  it('reads names and plugin types in lower case, the legacy composer-installer as a plugin, and extra.plugin-optional', () => {
    const entries = composerEntries(
      lock([
        { name: 'Evil/Plugin', version: '1.0.0', type: 'Composer-Plugin', dist: zip('https://api.github.com/repos/evil/plugin/zipball/abc') },
        { name: 'old/installer', version: '1.0.0', type: 'composer-installer', dist: zip('https://api.github.com/repos/old/installer/zipball/abc') },
        { name: 'php-http/discovery', version: '1.20.0', type: 'composer-plugin', extra: { class: 'X', 'plugin-optional': true }, dist: zip('https://api.github.com/repos/php-http/discovery/zipball/abc') },
        { name: 'psr/log', version: '3.0.2', type: 'library', dist: zip('https://api.github.com/repos/php-fig/log/zipball/abc') },
      ]),
      composer,
      [],
    );
    expect(entries.map(({ name, installScript, optional, anchor, version }) => ({ name, installScript, optional, anchor, version }))).toEqual([
      { name: 'evil/plugin', installScript: true, optional: undefined, anchor: '"name": "Evil/Plugin"', version: '1.0.0' },
      { name: 'old/installer', installScript: true, optional: undefined, anchor: '"name": "old/installer"', version: '1.0.0' },
      { name: 'php-http/discovery', installScript: true, optional: true, anchor: '"name": "php-http/discovery"', version: '1.20.0' },
      { name: 'psr/log', installScript: false, optional: undefined, anchor: '"name": "psr/log"', version: '3.0.2' },
    ]);
  });

  it('takes a package without a dist for a VCS checkout, and an archive from a host no registry uses for a source it does not recognize', () => {
    const repositories = [{ key: 0, type: 'composer', url: 'https://repo.example.com/acme', kind: 'registry' as const, names: [], line: 3 }];
    const entries = composerEntries(
      lock([
        { name: 'evil/x', version: '1.0.0', source: { type: 'git', url: 'file:///tmp/x.git', reference: 'abc' } },
        { name: 'evil/y', version: '1.0.0', dist: zip('https://evil.example/y.zip') },
        { name: 'acme/private', version: '2.0.0', dist: zip('https://repo.example.com/acme/dists/acme-private.zip') },
        { name: 'gitlab/lib', version: '1.0.0', dist: zip('https://gitlab.com/api/v4/projects/1/repository/archive.zip?sha=abc') },
        { name: 'bitbucket/lib', version: '1.0.0', dist: zip('https://bitbucket.org/o/r/get/abc.zip') },
      ]),
      composer,
      repositories,
    );
    expect(entries.map(({ name, source, spec, version }) => ({ name, source, spec, version }))).toEqual([
      { name: 'evil/x', source: 'git', spec: 'git file:///tmp/x.git', version: undefined },
      { name: 'evil/y', source: 'unknown', spec: 'zip https://evil.example/y.zip', version: '1.0.0' },
      { name: 'acme/private', source: 'registry', spec: 'zip https://repo.example.com/acme/dists/acme-private.zip', version: '2.0.0' },
      { name: 'gitlab/lib', source: 'registry', spec: 'zip https://gitlab.com/api/v4/projects/1/repository/archive.zip?sha=abc', version: '1.0.0' },
      { name: 'bitbucket/lib', source: 'registry', spec: 'zip https://bitbucket.org/o/r/get/abc.zip', version: '1.0.0' },
    ]);
  });

  it('lets an empty allow-plugins next to a composer.lock from before allow-plugins allow every plugin, as Composer 2.2 to 2.9 do', () => {
    const plugins = (setting: unknown) => (setting === undefined ? {} : { config: { 'allow-plugins': setting } });
    const legacy = { pluginApi: undefined, below: '2.2.0', allowsAllUntil: '2.10.0' };
    expect(pluginDecision(plugins(undefined), 'evil/plugin', { tool: composer, pluginApi: undefined })).toEqual({ allowed: true, legacy });
    expect(pluginDecision(plugins({}), 'evil/plugin', { tool: composer, pluginApi: '2.1.0' })).toEqual({ allowed: true, legacy: { ...legacy, pluginApi: '2.1.0' } });
    expect(pluginDecision(plugins([]), 'evil/plugin', { tool: composer, pluginApi: '1.1.0' })).toEqual({ allowed: true, legacy: { ...legacy, pluginApi: '1.1.0' } });
    expect(pluginDecision(plugins({}), 'evil/plugin', { tool: composer, pluginApi: '2.2.0' })).toEqual({ allowed: undefined });
    expect(pluginDecision(plugins({ 'a/b': true }), 'evil/plugin', { tool: composer, pluginApi: undefined })).toEqual({ allowed: undefined });
    expect(pluginDecision(plugins(undefined), 'evil/plugin')).toEqual({ allowed: undefined });
  });

  it('knows the keys that match every vendor/name package', () => {
    expect(['*', '**', '*/*', '**/*'].filter(matchesEveryComposerName)).toEqual(['*', '**', '*/*', '**/*']);
    expect(['*/*/*', 'acme/*', '*/acme', '*/'].filter(matchesEveryComposerName)).toEqual([]);
  });
});

describe('composer.lock and the repositories of composer.json', () => {
  it('compares repository URLs by host and path', () => {
    expect(normalizedUrl('https://github.com/Acme/Fork.git')).toBe('github.com/acme/fork');
    expect(normalizedUrl('git@github.com:acme/fork.git')).toBe('github.com/acme/fork');
    expect(normalizedUrl('ssh://git@github.com/acme/fork/')).toBe('github.com/acme/fork');
  });

  it('reads the deprecated object form of repositories and a package repository without a dist', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-composer-doctor-'));
    temporary.push(root);
    const manifest = {
      repositories: {
        fork: { type: 'github', url: 'https://github.com/acme/fork' },
        legacy: { type: 'package', package: [{ name: 'Legacy/Lib', version: '1.0.0', source: { type: 'svn', url: 'https://svn.example.com/lib', reference: 'trunk' } }] },
        packagist: { 'packagist.org': false },
      },
    };
    writeFileSync(join(root, 'composer.json'), JSON.stringify(manifest));
    const repositories = declaredRepositories(new Repository(root), composer);
    expect(repositories.map(({ key, kind, names }) => ({ key, kind, names }))).toEqual([
      { key: 'fork', kind: 'git', names: [] },
      { key: 'legacy', kind: 'git', names: ['legacy/lib'] },
      { key: 'packagist', kind: 'disable', names: [] },
    ]);
    const lock = {
      packages: [
        { name: 'acme/fork', source: { type: 'git', url: 'git@github.com:acme/fork.git' } },
        { name: 'legacy/lib', source: { type: 'svn', url: 'https://svn.example.com/lib' } },
        { name: 'acme/archive', dist: { type: 'tar', url: 'C:/artifacts/acme-archive.tar' } },
        { name: 'acme/remote', dist: { type: 'zip', url: 'file:///srv/artifacts/acme-remote.zip' } },
        { name: 'psr/log', dist: { type: 'zip', url: 'https://api.github.com/repos/php-fig/log/zipball/1' } },
      ],
      'packages-dev': [{ name: 'acme/plugin', type: 'composer-plugin', dist: { type: 'path', url: '../plugin' } }],
    };
    expect(composerEntries(JSON.stringify(lock), composer, repositories).map(({ name, source, installScript }) => ({ name, source, installScript }))).toEqual([
      { name: 'acme/fork', source: 'git', installScript: false },
      { name: 'legacy/lib', source: 'git', installScript: false },
      { name: 'acme/archive', source: 'file', installScript: false },
      { name: 'acme/remote', source: 'file', installScript: false },
      { name: 'psr/log', source: 'registry', installScript: false },
      { name: 'acme/plugin', source: 'directory', installScript: true },
    ]);
  });

  it('takes the first key of allow-plugins that matches, in any case, and true or false for every plugin', () => {
    const plugins = (setting: unknown) => ({ config: { 'allow-plugins': setting } });
    expect(pluginDecision(plugins({ 'acme/*': false, 'acme/plugin': true }), 'acme/plugin')).toEqual({ allowed: false, key: 'acme/*' });
    expect(pluginDecision(plugins({ 'Acme/Plugin': true }), 'acme/plugin')).toEqual({ allowed: true, key: 'Acme/Plugin' });
    expect(pluginDecision(plugins({ '*': 1 }), 'acme/plugin')).toEqual({ allowed: false, key: '*' });
    expect(pluginDecision(plugins(true), 'acme/plugin')).toEqual({ allowed: true });
    expect(pluginDecision(plugins({}), 'acme/plugin')).toEqual({ allowed: undefined });
    expect(pluginDecision(undefined, 'acme/plugin')).toEqual({ allowed: undefined });
  });
});

describe('check and Composer packages', () => {
  it('looks a composer: package up on Packagist instead of reading it as an npm spec (decision D-133)', async () => {
    const result = validatePolicy(DEFAULT_POLICY);
    if (!result.ok) throw new Error('default policy');
    const asked: string[] = [];
    const fetch = (url: string) => {
      asked.push(url);
      return Promise.reject(new Error('no network in tests'));
    };
    const [report] = await checkSpecs(['composer:monolog/monolog'], { policy: result.policy, fetch } as unknown as Parameters<typeof checkSpecs>[1]);
    expect(report).toEqual({
      spec: 'composer:monolog/monolog',
      kind: 'registry',
      name: 'composer:monolog/monolog',
      findings: [
        {
          level: 'error',
          code: 'unverified',
          message: 'it cannot be checked: Packagist cannot be reached (no network in tests)',
          fix: 'Run depcurfew check again when Packagist (repo.packagist.org) can be reached',
        },
      ],
    });
    expect(asked).toEqual(['https://repo.packagist.org/p2/monolog/monolog.json']);
  });
});
