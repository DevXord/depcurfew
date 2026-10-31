import { describe, expect, it } from 'vitest';
import { compareSemver, maxSatisfying, parseRange, parseSemver, satisfies } from '../../src/check/semver.ts';

const order = (a: string, b: string) => Math.sign(compareSemver(parseSemver(a) ?? parseSemver('0.0.0')!, parseSemver(b) ?? parseSemver('0.0.0')!));

describe('compareSemver', () => {
  it.each([
    ['1.0.0', '2.0.0', -1],
    ['1.2.3', '1.2.3', 0],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0+build', '1.0.0', 0],
  ])('%s vs %s', (a, b, expected) => {
    expect(order(a, b)).toBe(expected);
  });
});

describe('satisfies', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.9.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.2.7', '1.2', true],
    ['3.0.0', '*', true],
    ['3.0.0', '', true],
    ['1.5.0', '>=1.2.0 <2.0.0', true],
    ['1.5.0', '>= 1.2.0 < 2.0.0', true],
    ['2.0.0', '>1.2', true],
    ['1.2.9', '>1.2', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.5.0', '1.2.3 - 2.3.4', true],
    ['2.3.5', '1.2.3 - 2.3.4', false],
    ['2.3.9', '1.2.3 - 2.3', true],
    ['5.0.0', '^4.0.0 || ^5.0.0', true],
    ['2.0.0-rc.1', '^1.0.0', false],
    ['2.0.0-rc.1', '>=2.0.0-rc.0', true],
    ['2.0.1-rc.1', '>=2.0.0-rc.0', false],
    ['1.0.0-rc.1', '*', false],
  ])('%s in %s', (candidate, range, expected) => {
    expect(satisfies(candidate, range)).toBe(expected);
  });

  it('does not take a tag for a range', () => {
    expect(parseRange('latest')).toBeUndefined();
    expect(parseRange('next')).toBeUndefined();
    expect(parseRange('beta')).toBeUndefined();
  });
});

describe('maxSatisfying', () => {
  const versions = ['1.0.0', '1.2.0', '1.10.1', '2.0.0-rc.1', '2.0.0', '2.1.0'];
  it('picks the highest matching version', () => {
    expect(maxSatisfying(versions, '^1.0.0')).toBe('1.10.1');
    expect(maxSatisfying(versions, '*')).toBe('2.1.0');
    expect(maxSatisfying(versions, '~2.0.0')).toBe('2.0.0');
    expect(maxSatisfying(versions, '^3')).toBeUndefined();
  });
});
