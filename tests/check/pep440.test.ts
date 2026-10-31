// Cases from the version specifiers specification (PEP 440):
// https://packaging.python.org/en/latest/specifications/version-specifiers/
import { describe, expect, it } from 'vitest';
import { compareVersions, matchesSpecifiers, normalizeVersion, parseSpecifiers, parseVersion, pickVersion } from '../../src/check/pep440.ts';

const order = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
const matches = (version: string, specifiers: string) => matchesSpecifiers(version, parseSpecifiers(specifiers)!);

describe('normalizeVersion', () => {
  it.each([
    ['1.1RC1', '1.1rc1'],
    ['00', '0'],
    ['09000', '9000'],
    ['1.1.a1', '1.1a1'],
    ['1.1-a1', '1.1a1'],
    ['1.0a.1', '1.0a1'],
    ['1.1alpha1', '1.1a1'],
    ['1.1beta2', '1.1b2'],
    ['1.1c3', '1.1rc3'],
    ['1.0pre1', '1.0rc1'],
    ['1.0preview1', '1.0rc1'],
    ['1.2a', '1.2a0'],
    ['1.2-post2', '1.2.post2'],
    ['1.2post2', '1.2.post2'],
    ['1.2.post-2', '1.2.post2'],
    ['1.0-r4', '1.0.post4'],
    ['1.0rev4', '1.0.post4'],
    ['1.2.post', '1.2.post0'],
    ['1.0-1', '1.0.post1'],
    ['1.2-dev2', '1.2.dev2'],
    ['1.2dev2', '1.2.dev2'],
    ['1.2.dev', '1.2.dev0'],
    ['1.0+ubuntu-1', '1.0+ubuntu.1'],
    ['1.0+foo0100', '1.0+foo0100'],
    ['v1.0', '1.0'],
    [' 1.0\n', '1.0'],
    ['1!2.0', '1!2.0'],
    ['0!1.0', '1.0'],
  ])('%j → %s', (raw, normal) => {
    expect(normalizeVersion(raw)).toBe(normal);
  });

  it.each(['1.0-', 'foo', '1..0', '', '1.0+', 'latest'])('rejects %j', (raw) => {
    expect(parseVersion(raw)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  // The ordering example of the specification, from lowest to highest.
  const sorted = [
    '1.dev0',
    '1.0.dev456',
    '1.0a1',
    '1.0a2.dev456',
    '1.0a12.dev456',
    '1.0a12',
    '1.0b1.dev456',
    '1.0b2',
    '1.0b2.post345.dev456',
    '1.0b2.post345',
    '1.0rc1.dev456',
    '1.0rc1',
    '1.0',
    '1.0+abc.5',
    '1.0+abc.7',
    '1.0+5',
    '1.0.post456.dev34',
    '1.0.post456',
    '1.1.dev1',
  ];
  it('follows the ordering of the specification', () => {
    const shuffled = [...sorted].reverse();
    shuffled.sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(shuffled).toEqual(sorted);
  });

  it.each([
    ['1.0', '1.0.0', 0],
    ['1.0c1', '1.0rc1', 0],
    ['1!1.0', '2.0', 1],
    ['2.0', '10.0', -1],
  ])('%s vs %s', (a, b, expected) => {
    expect(order(a, b)).toBe(expected);
  });
});

describe('parseSpecifiers', () => {
  it('reads clauses separated by commas, with optional whitespace', () => {
    expect(parseSpecifiers('~= 0.9, >= 1.0, != 1.3.4.*, < 2.0')).toEqual([
      { operator: '~=', version: '0.9', wildcard: false },
      { operator: '>=', version: '1.0', wildcard: false },
      { operator: '!=', version: '1.3.4', wildcard: true },
      { operator: '<', version: '2.0', wildcard: false },
    ]);
    expect(parseSpecifiers('')).toEqual([]);
  });

  it.each(['~=1', '>=1.0+local', '==1.0.dev1.*', '==1.0+foo1.*', '=>1.0', '1.0', '>=', '==1.0,'])('rejects %j', (text) => {
    expect(parseSpecifiers(text)).toBeUndefined();
  });

  it('keeps any text after ===', () => {
    expect(parseSpecifiers('===foobar')).toEqual([{ operator: '===', version: 'foobar', wildcard: false }]);
  });
});

describe('matchesSpecifiers', () => {
  it.each([
    // Compatible release.
    ['2.2', '~=2.2', true],
    ['2.9', '~=2.2', true],
    ['3.0', '~=2.2', false],
    ['1.4.9', '~=1.4.5', true],
    ['1.5.0', '~=1.4.5', false],
    ['2.3', '~=2.2.post3', true],
    ['2.2', '~=2.2.post3', false],
    ['1.4.6', '~=1.4.5a4', true],
    ['1.5', '~=1.4.5a4', false],
    ['2.2.9', '~=2.2.0', true],
    ['2.3.0', '~=2.2.0', false],
    ['1.4.5.9', '~=1.4.5.0', true],
    ['1.4.6', '~=1.4.5.0', false],
    // Version matching, for the versions 1.1.post1, 1.1a1 and 1.1.
    ['1.1.post1', '==1.1', false],
    ['1.1.post1', '==1.1.post1', true],
    ['1.1.post1', '==1.1.*', true],
    ['1.1a1', '==1.1', false],
    ['1.1a1', '==1.1a1', true],
    ['1.1a1', '==1.1.*', true],
    ['1.1', '==1.1', true],
    ['1.1', '==1.1.0', true],
    ['1.1', '==1.1.dev1', false],
    ['1.1', '==1.1a1', false],
    ['1.1', '==1.1.post1', false],
    ['1.1', '==1.1.*', true],
    ['1.1.5', '==1.1.*', true],
    ['1.10', '==1.1.*', false],
    ['1.0+local.1', '==1.0', true],
    ['1.0+local.1', '==1.0+local.1', true],
    ['1.0+local.2', '==1.0+local.1', false],
    // Exclusion.
    ['1.1.post1', '!=1.1', true],
    ['1.1.post1', '!=1.1.post1', false],
    ['1.1.post1', '!=1.1.*', false],
    // Inclusive and exclusive ordered comparison.
    ['1.0', '>=1.0', true],
    ['1.0+local', '<=1.0', true],
    ['1.7.1', '>1.7', true],
    ['1.7.0.post1', '>1.7', false],
    ['1.7.1', '>1.7.post2', true],
    ['1.7.0.post3', '>1.7.post2', true],
    ['1.7.0', '>1.7.post2', false],
    ['1.7+local', '>1.7', false],
    ['2.0rc1', '<2.0', false],
    ['1.9', '<2.0', true],
    ['2.0b1', '<2.0rc1', true],
    // Arbitrary equality.
    ['foobar', '===foobar', true],
    ['1.0+downstream1', '===1.0', false],
    ['1.0', '===1.0', true],
    // Several clauses.
    ['3.1.2', '~=3.1.0, != 3.1.3', true],
    ['3.1.3', '~=3.1.0, != 3.1.3', false],
    ['3.2.0', '~=3.1.0, != 3.1.3', false],
    // No clause matches every version.
    ['0.0.1', '', true],
  ])('%s %s → %s', (version, specifiers, expected) => {
    expect(matches(version, specifiers)).toBe(expected);
  });
});

describe('pickVersion', () => {
  const versions = ['1.0', '1.1', '2.0rc1', '2.0', '2.1.dev1', 'not-a-version'];

  it('picks the highest final release that matches', () => {
    expect(pickVersion(versions, parseSpecifiers('')!)).toBe('2.0');
    expect(pickVersion(versions, parseSpecifiers('<2')!)).toBe('1.1');
  });

  it('takes pre-releases only when asked for or when nothing else matches', () => {
    expect(pickVersion(versions, parseSpecifiers('>=2.0rc1')!)).toBe('2.1.dev1');
    expect(pickVersion(versions, parseSpecifiers('>2.0')!)).toBe('2.1.dev1');
    expect(pickVersion(['1.0', '2.0b1'], parseSpecifiers('>=1.5')!)).toBe('2.0b1');
    expect(pickVersion(['1.0', '2.0b1'], parseSpecifiers('!=1.0b1')!)).toBe('1.0');
  });

  it('returns undefined when no version matches', () => {
    expect(pickVersion(versions, parseSpecifiers('>=3')!)).toBeUndefined();
  });
});
