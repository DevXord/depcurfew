import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../../src/policy/duration.ts';

const HINT = 'use a whole number followed by m (minutes), h (hours), d (days) or w (weeks), e.g. "36h", "3d" or "1w"';
const ZERO = 'must be longer than zero; to leave release-age settings unmanaged, remove the cooldown section';
const MONTHS = 'months and years are not supported because their length varies; use days or weeks, e.g. "30d"';
const SECONDS = 'seconds are not supported; the smallest unit is m (minutes)';

// Durations are kept in minutes; converting to seconds (Bun) must stay a safe integer.
const MAX_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60);

describe('parseDuration', () => {
  it.each([
    ['1m', 1],
    ['90m', 90],
    ['1440m', 1440],
    ['1h', 60],
    ['36h', 2160],
    ['1d', 1440],
    ['3d', 4320],
    ['7d', 10080],
    ['1w', 10080],
    ['2w', 20160],
    ['2160h', 129600],
    [`${MAX_MINUTES}m`, MAX_MINUTES],
    [`${Math.floor(MAX_MINUTES / 10080)}w`, Math.floor(MAX_MINUTES / 10080) * 10080],
  ])('accepts %s as %i minutes and keeps the text as written', (text, minutes) => {
    expect(parseDuration(text)).toEqual({ ok: true, duration: { text, minutes } });
  });

  it.each([
    // Empty or unparseable
    ['', HINT],
    ['   ', HINT],
    ['abc', HINT],
    ['d', HINT],
    ['+3d', HINT],
    // Zero and negative
    ['0d', ZERO],
    ['0m', ZERO],
    ['00d', ZERO],
    ['0.0d', ZERO],
    ['0', ZERO],
    ['-3d', ZERO],
    // Missing or unsupported units
    ['36', `a unit is missing; ${HINT}`],
    ['3d3', `a unit is missing; ${HINT}`],
    ['3x', `unknown unit "x"; ${HINT}`],
    ['3dd', `unknown unit "dd"; ${HINT}`],
    ['1M', MONTHS],
    ['1mo', MONTHS],
    ['1month', MONTHS],
    ['2 months', MONTHS],
    ['1y', MONTHS],
    ['2 years', MONTHS],
    ['3s', SECONDS],
    ['500ms', SECONDS],
    ['90 seconds', SECONDS],
    // Fractions
    ['1.5d', 'fractions are not supported; write "36h"'],
    ['0.5h', 'fractions are not supported; write "30m"'],
    ['1.25w', 'fractions are not supported; write "210h"'],
    ['1.0d', 'fractions are not supported; write "1d"'],
    ['0.5m', `fractions are not supported; ${HINT}`],
    // Recognisable, but not in the canonical form
    ['3 days', 'spaces are not allowed; write "3d"'],
    [' 3d', 'spaces are not allowed; write "3d"'],
    ['3d ', 'spaces are not allowed; write "3d"'],
    ['3 Days', 'spaces are not allowed; write "3d"'],
    ['3D', 'units are lowercase; write "3d"'],
    ['36H', 'units are lowercase; write "36h"'],
    ['1W', 'units are lowercase; write "1w"'],
    ['3days', 'use the short unit; write "3d"'],
    ['14days', 'use the short unit; write "14d"'],
    ['36hours', 'use the short unit; write "36h"'],
    ['1hr', 'use the short unit; write "1h"'],
    ['90min', 'use the short unit; write "90m"'],
    ['2weeks', 'use the short unit; write "2w"'],
    ['1d12h', 'use a single unit; write "36h"'],
    ['1h30m', 'use a single unit; write "90m"'],
    ['1w1d', 'use a single unit; write "8d"'],
    ['03d', 'leading zeros are not allowed; write "3d"'],
    // Too large to convert safely
    [`${MAX_MINUTES + 1}m`, 'too large'],
    [`${Math.floor(MAX_MINUTES / 10080) + 1}w`, 'too large'],
    ['999999999999999w', 'too large'],
    ['99999999999999999999999d', 'too large'],
  ])('rejects %j: %s', (text, message) => {
    expect(parseDuration(text)).toEqual({ ok: false, message });
  });
});

describe('formatDuration', () => {
  it.each([
    [1, '1m'],
    [59, '59m'],
    [60, '1h'],
    [90, '90m'],
    [1440, '1d'],
    [2160, '36h'],
    [4320, '3d'],
    [10080, '1w'],
    [11520, '8d'],
    [20160, '2w'],
  ])('writes %i minutes as %s, using the largest exact unit', (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });

  it('round-trips through parseDuration', () => {
    for (let minutes = 1; minutes <= 30000; minutes++) {
      expect(parseDuration(formatDuration(minutes))).toEqual({
        ok: true,
        duration: { text: formatDuration(minutes), minutes },
      });
    }
  });
});
