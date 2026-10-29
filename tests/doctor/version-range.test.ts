import { describe, expect, it } from 'vitest';
import { lowestVersion } from '../../src/doctor/version-range.ts';

describe('lowestVersion', () => {
  it.each([
    ['10.16.0', { kind: 'exact', version: [10, 16, 0] }],
    ['v2.9.8', { kind: 'exact', version: [2, 9, 8] }],
    ['=4.12.0', { kind: 'exact', version: [4, 12, 0] }],
    ['^11.6.0', { kind: 'range', version: [11, 6, 0] }],
    ['~1.3', { kind: 'range', version: [1, 3, 0] }],
    ['10.x', { kind: 'range', version: [10, 0, 0] }],
    ['v2.x', { kind: 'range', version: [2, 0, 0] }],
    ['22', { kind: 'range', version: [22, 0, 0] }],
    ['>=4.10 <5', { kind: 'range', version: [4, 10, 0] }],
    ['>10.2.3', { kind: 'range', version: [10, 2, 4] }],
    ['>10.2', { kind: 'range', version: [10, 3, 0] }],
    ['>10', { kind: 'range', version: [11, 0, 0] }],
    ['<12', { kind: 'range', version: [0, 0, 0] }],
    ['*', { kind: 'range', version: [0, 0, 0] }],
    ['1.2.3 - 2.0.0', { kind: 'range', version: [1, 2, 3] }],
    ['^9.0.0 || ^10.16.0', { kind: 'range', version: [9, 0, 0] }],
    ['11.0.0-rc.1', { kind: 'exact', version: [11, 0, 0] }],
    ['latest', { kind: 'unknown' }],
    ['lts/*', { kind: 'unknown' }],
    ['${{ matrix.pnpm }}', { kind: 'unknown' }],
    ['', { kind: 'unknown' }],
  ])('%s', (text, expected) => {
    expect(lowestVersion(text)).toEqual(expected);
  });
});
