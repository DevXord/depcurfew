import { describe, expect, it } from 'vitest';
import { editDistance, PopularNames } from '../../src/check/similar.ts';

describe('editDistance', () => {
  it.each([
    ['lodash', 'lodash', 0],
    ['lodahs', 'lodash', 1],
    ['lodas', 'lodash', 1],
    ['loodash', 'lodash', 1],
    ['ladash', 'lodash', 1],
    ['expresss', 'express', 1],
    ['electorn', 'electron', 1],
    ['typescirpt', 'typescript', 1],
    ['tyepscirpt', 'typescript', 2],
  ])('%s → %s', (a, b, expected) => {
    expect(editDistance(a, b, 2)).toBe(expected);
  });

  it('stops above the limit', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});

describe('PopularNames', () => {
  const popular = new PopularNames(['cross-env', 'electron', 'express', 'lodash', 'react', 'typescript', '@types/node', 'ms', 'ws']);

  it.each([
    ['lodahs', { match: 'lodash', reason: 'edit' }],
    ['expresss', { match: 'express', reason: 'edit' }],
    ['electorn', { match: 'electron', reason: 'edit' }],
    ['typescirpt', { match: 'typescript', reason: 'edit' }],
    ['crossenv', { match: 'cross-env', reason: 'separators' }],
    ['cross_env', { match: 'cross-env', reason: 'separators' }],
    ['@typos/node', { match: '@types/node', reason: 'edit' }],
    ['@types/nodee', { match: '@types/node', reason: 'edit' }],
  ])('%s looks like a popular package', (name, expected) => {
    expect(popular.similar(name)).toEqual(expected);
  });

  it.each(['lodash', 'react', 'left-pad', 'mz', 'reakt-native-tools', '@evil/lodash', '@firma/node'])('%s does not', (name) => {
    expect(popular.similar(name)).toBeUndefined();
  });
});
