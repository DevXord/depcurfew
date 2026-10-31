import { describe, expect, it } from 'vitest';
import { parseSpec } from '../../src/check/spec.ts';

describe('parseSpec', () => {
  it.each([
    ['lodash', { kind: 'registry', name: 'lodash', selector: '' }],
    ['lodash@4.17.21', { kind: 'registry', name: 'lodash', selector: '4.17.21' }],
    ['lodash@^4', { kind: 'registry', name: 'lodash', selector: '^4' }],
    ['lodash@~4.17.0', { kind: 'registry', name: 'lodash', selector: '~4.17.0' }],
    ['~', { kind: 'directory' }],
    ['lodash@~', { kind: 'registry', name: 'lodash', selector: '~' }],
    ['lodash@~/pkg', { kind: 'directory' }],
    ['lodash@latest', { kind: 'registry', name: 'lodash', selector: 'latest' }],
    ['@types/node', { kind: 'registry', name: '@types/node', selector: '' }],
    ['@types/node@22', { kind: 'registry', name: '@types/node', selector: '22' }],
    ['JSONStream', { kind: 'registry', name: 'JSONStream', selector: '' }],
    ['babel-core@npm:@babel/core@8.0.6', { kind: 'registry', name: '@babel/core', selector: '8.0.6' }],
    ['npm:lodash@4', { kind: 'registry', name: 'lodash', selector: '4' }],
    ['github:user/repo', { kind: 'git' }],
    ['user/repo', { kind: 'git' }],
    ['user/repo#v1.0.0', { kind: 'git' }],
    ['git+https://github.com/user/repo.git', { kind: 'git' }],
    ['git+ssh://git@github.com/user/repo.git', { kind: 'git' }],
    ['git://github.com/user/repo.git', { kind: 'git' }],
    ['gitlab:user/repo', { kind: 'git' }],
    // A URL without a tarball extension may be read as a git repository, so both source settings apply.
    ['https://github.com/user/repo', { kind: 'remoteTarball', maybeGit: true }],
    ['https://github.com/user/repo.git#2.0.1', { kind: 'remoteTarball', maybeGit: true }],
    // The npm package called git, not the scp-like form of a git URL.
    ['git@1.0.0', { kind: 'registry', name: 'git', selector: '1.0.0' }],
    ['git@github.com:user/repo.git', { kind: 'git' }],
    ['lodash@git@github.com:lodash/lodash.git', { kind: 'git' }],
    ['lodash@github:lodash/lodash', { kind: 'git' }],
    ['lodash@lodash/lodash', { kind: 'git' }],
    ['https://example.com/pkg.tgz', { kind: 'remoteTarball' }],
    ['lodash@https://example.com/lodash.tgz', { kind: 'remoteTarball' }],
    ['./vendor/logger', { kind: 'directory' }],
    ['../pkg.tgz', { kind: 'file' }],
    ['file:../pkg', { kind: 'directory' }],
    ['local@file:../path/local-0.1.2.tgz', { kind: 'file' }],
    ['link:../pkg', { kind: 'directory' }],
    ['~/pkg', { kind: 'directory' }],
    ['portal:../pkg', { kind: 'directory' }],
    ['jsr:@std/path', { kind: 'other', reason: 'it uses the jsr: protocol, which depcurfew does not look up' }],
    ['pkg:npm/lodash', { kind: 'other' }],
    ['shared@workspace:*', { kind: 'workspace' }],
    ['react@catalog:', { kind: 'other' }],
    ['serde@crate:serde', { kind: 'other' }],
  ])('%s', (raw, expected) => {
    expect(parseSpec(raw)).toMatchObject(expected);
  });

  it('reads a URL with a tarball extension as a tarball only', () => {
    expect(parseSpec('https://example.com/pkg.tgz')).not.toHaveProperty('maybeGit');
  });

  it.each(['', 'two words', '-D', 'a/b/c', '$(curl x)'])('rejects %j', (raw) => {
    expect(parseSpec(raw)).toBeUndefined();
  });
});
