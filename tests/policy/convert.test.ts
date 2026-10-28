import { describe, expect, it } from 'vitest';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import { TOOL_IDS } from '../../src/knowledge/schema.ts';
import type { ToolId, ToolKnowledge } from '../../src/knowledge/types.ts';
import {
  convertCooldown,
  convertMinutes,
  DURATION_STRING_UNITS,
  type DurationStringUnit,
  type NumericDelayUnit,
  toDurationString,
} from '../../src/policy/convert.ts';
import { parseDuration, type Duration } from '../../src/policy/duration.ts';
import { buildTool, setPath, TODAY } from '../knowledge/builders.ts';

const SECONDS_PER: Record<NumericDelayUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
const MINUTES_PER_WORD: Record<DurationStringUnit, number> = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };
const NUMERIC_UNITS = Object.keys(SECONDS_PER) as NumericDelayUnit[];
const MAX_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60);

function duration(text: string): Duration {
  const result = parseDuration(text);
  if (!result.ok) throw new Error(`test setup: ${text} is not a valid duration`);
  return result.duration;
}

function tool(id: ToolId): ToolKnowledge {
  const entry = knowledgeBase.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no knowledge for ${id}`);
  return entry;
}

/** Minutes a duration string such as `36 hours` stands for. */
function minutesOf(text: string): number {
  const match = /^(\d+) (minute|hour|day|week)s?$/.exec(text);
  if (match === null) throw new Error(`unexpected duration string ${text}`);
  return Number(match[1]) * MINUTES_PER_WORD[`${match[2]}s` as DurationStringUnit];
}

const fact = (value: unknown) => ({ status: 'verified', value, source: 'https://docs.npmjs.com/cli/v11/using-npm/config', verifiedAt: TODAY });
const disputed = (...values: unknown[]) => ({
  status: 'disputed',
  note: 'test',
  variants: values.map((value, index) => ({ value, source: `https://docs.npmjs.com/cli/v11/using-npm/config#${index}`, verifiedAt: TODAY })),
});

function syntheticTool(overrides: Record<string, unknown>): ToolKnowledge {
  const entry = buildTool('npm') as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) setPath(entry, path, value);
  return entry as unknown as ToolKnowledge;
}

describe('convertMinutes', () => {
  it.each<[number, NumericDelayUnit, number, boolean]>([
    [1, 'seconds', 60, true],
    [2160, 'seconds', 129600, true],
    [4320, 'seconds', 259200, true],
    [MAX_MINUTES, 'seconds', MAX_MINUTES * 60, true],
    [1, 'minutes', 1, true],
    [2160, 'minutes', 2160, true],
    [1, 'hours', 1, false],
    [59, 'hours', 1, false],
    [60, 'hours', 1, true],
    [61, 'hours', 2, false],
    [2160, 'hours', 36, true],
    [1, 'days', 1, false],
    [1439, 'days', 1, false],
    [1440, 'days', 1, true],
    [1441, 'days', 2, false],
    [2160, 'days', 2, false],
    [4320, 'days', 3, true],
    [10080, 'days', 7, true],
    [MAX_MINUTES, 'days', 104249991375, false],
  ])('%i minutes in %s is %i (exact: %s)', (minutes, unit, value, exact) => {
    expect(convertMinutes(minutes, unit)).toEqual({ value, exact });
  });

  it.each(NUMERIC_UNITS)('never gives a shorter delay than the policy, and rounds up by less than one %s', (unit) => {
    for (let minutes = 1; minutes <= 20000; minutes++) {
      const { value, exact } = convertMinutes(minutes, unit);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value * SECONDS_PER[unit]).toBeGreaterThanOrEqual(minutes * 60);
      expect((value - 1) * SECONDS_PER[unit]).toBeLessThan(minutes * 60);
      expect(exact).toBe(value * SECONDS_PER[unit] === minutes * 60);
    }
  });
});

describe('toDurationString', () => {
  it.each<[number, readonly DurationStringUnit[], string, boolean]>([
    [1, ['hours', 'days'], '1 hour', false],
    [60, ['hours', 'days'], '1 hour', true],
    [90, ['hours', 'days'], '2 hours', false],
    [1500, ['hours', 'days'], '25 hours', true],
    [1501, ['hours', 'days'], '26 hours', false],
    [1440, ['hours', 'days'], '1 day', true],
    [2160, ['hours', 'days'], '36 hours', true],
    [4320, ['hours', 'days'], '3 days', true],
    [10080, ['hours', 'days'], '7 days', true],
    [1, ['minutes', 'hours', 'days', 'weeks'], '1 minute', true],
    [90, ['minutes', 'hours', 'days', 'weeks'], '90 minutes', true],
    [10080, ['weeks', 'minutes'], '1 week', true],
    [20160, ['minutes', 'hours', 'days', 'weeks'], '2 weeks', true],
    [1, ['days'], '1 day', false],
    [2160, ['days'], '2 days', false],
  ])('%i minutes with units %j is %j (exact: %s)', (minutes, units, value, exact) => {
    expect(toDurationString(minutes, units)).toEqual({ value, exact });
  });

  it('rejects an empty unit list', () => {
    expect(() => toDurationString(60, [])).toThrow(/at least one unit/);
  });

  it.each<readonly DurationStringUnit[]>([['hours', 'days'], ['days'], ['minutes'], [...DURATION_STRING_UNITS]])(
    'with units %j never gives a shorter delay than the policy',
    (...units) => {
      for (let minutes = 1; minutes <= 20000; minutes++) {
        const { value, exact } = toDurationString(minutes, units);
        expect(minutesOf(value)).toBeGreaterThanOrEqual(minutes);
        expect(exact).toBe(minutesOf(value) === minutes);
      }
    },
  );
});

describe('convertCooldown with the real knowledge base', () => {
  it.each<[string, ToolId, number | string, boolean]>([
    ['36h', 'npm', 2, false],
    ['36h', 'pnpm', 2160, true],
    ['36h', 'yarn', 2160, true],
    ['36h', 'bun', 129600, true],
    ['36h', 'deno', 2160, true],
    ['36h', 'renovate', '36 hours', true],
    ['36h', 'dependabot', 2, false],
    ['3d', 'npm', 3, true],
    ['3d', 'pnpm', 4320, true],
    ['3d', 'yarn', 4320, true],
    ['3d', 'bun', 259200, true],
    ['3d', 'deno', 4320, true],
    ['3d', 'renovate', '3 days', true],
    ['3d', 'dependabot', 3, true],
    ['1w', 'npm', 7, true],
    ['1w', 'renovate', '7 days', true],
    ['1w', 'dependabot', 7, true],
    ['90m', 'npm', 1, false],
    ['90m', 'bun', 5400, true],
    ['90m', 'renovate', '2 hours', false],
    ['90m', 'dependabot', 1, false],
    ['1m', 'npm', 1, false],
    ['1m', 'renovate', '1 hour', false],
    ['90d', 'dependabot', 90, true],
    ['13w', 'npm', 91, true],
  ])('%s for %s is %j (exact: %s)', (text, id, value, exact) => {
    const unit = tool(id).cooldown.unit;
    expect(unit.status).toBe('verified');
    expect(convertCooldown(tool(id), duration(text))).toEqual({
      ok: true,
      tool: id,
      unit: unit.status === 'disputed' ? undefined : unit.value,
      value,
      exact,
    });
  });

  it.each([
    ['13w', 'Dependabot accepts at most 90 days, but 13w needs 91 days'],
    ['2161h', 'Dependabot accepts at most 90 days, but 2161h needs 91 days'],
    ['1000d', 'Dependabot accepts at most 90 days, but 1000d needs 1000 days'],
  ])('refuses %s for Dependabot instead of shortening the delay', (text, reason) => {
    expect(convertCooldown(tool('dependabot'), duration(text))).toEqual({ ok: false, tool: 'dependabot', reason });
  });

  it.each(TOOL_IDS)('%s never gets 0 (which turns the delay off) and never a shorter delay', (id) => {
    for (const text of ['1m', '59m', '1h', '23h', '1d', '36h', '1w', '90d']) {
      const result = convertCooldown(tool(id), duration(text));
      if (!result.ok) throw new Error(result.reason);
      const minutes = typeof result.value === 'string' ? minutesOf(result.value) : convertBack(result.value, result.unit);
      expect(minutes).toBeGreaterThanOrEqual(duration(text).minutes);
    }
  });
});

function convertBack(value: number, unit: string): number {
  expect(value).toBeGreaterThan(0);
  return (value * SECONDS_PER[unit as NumericDelayUnit]) / 60;
}

describe('convertCooldown with synthetic knowledge', () => {
  it('uses the variant with the smallest unit when the unit is disputed, so every reading is long enough', () => {
    const sample = syntheticTool({ 'cooldown.unit': disputed('minutes', 'seconds') });
    expect(convertCooldown(sample, duration('36h'))).toEqual({ ok: true, tool: 'npm', unit: 'seconds', value: 129600, exact: true });

    const days = syntheticTool({ 'cooldown.unit': disputed('days', 'hours') });
    expect(convertCooldown(days, duration('90m'))).toEqual({ ok: true, tool: 'npm', unit: 'hours', value: 2, exact: false });
  });

  it('reports a tool without a release-age setting', () => {
    const sample = syntheticTool({ 'cooldown.unit': fact(null) });
    expect(convertCooldown(sample, duration('3d'))).toEqual({
      ok: false,
      tool: 'npm',
      reason: 'Sample npm has no release-age setting',
    });
    const maybe = syntheticTool({ 'cooldown.unit': disputed('days', null) });
    expect(convertCooldown(maybe, duration('3d'))).toMatchObject({ ok: false, reason: 'Sample npm has no release-age setting' });
  });

  it('refuses a unit disputed between a number and a duration string', () => {
    const sample = syntheticTool({ 'cooldown.unit': disputed('minutes', 'duration-string') });
    expect(convertCooldown(sample, duration('3d'))).toEqual({
      ok: false,
      tool: 'npm',
      reason: 'the unit of the Sample npm release-age setting is disputed between a number and a duration string',
    });
  });

  it('needs the accepted duration units for a duration-string setting', () => {
    const missing = syntheticTool({ 'cooldown.unit': fact('duration-string') });
    expect(convertCooldown(missing, duration('3d'))).toEqual({
      ok: false,
      tool: 'npm',
      reason: 'the knowledge base does not list which duration units Sample npm accepts (extra.durationUnits)',
    });
    const malformed = syntheticTool({ 'cooldown.unit': fact('duration-string'), 'extra.durationUnits': fact(['fortnights']) });
    expect(convertCooldown(malformed, duration('3d'))).toMatchObject({ ok: false });
  });

  it('keeps only duration units every variant agrees on', () => {
    const sample = syntheticTool({
      'cooldown.unit': fact('duration-string'),
      'extra.durationUnits': disputed(['hours', 'days'], ['days']),
    });
    expect(convertCooldown(sample, duration('36h'))).toEqual({
      ok: true,
      tool: 'npm',
      unit: 'duration-string',
      value: '2 days',
      exact: false,
    });
  });

  it('uses the lowest maximum when the maximum is disputed', () => {
    const sample = syntheticTool({ 'cooldown.unit': fact('days'), 'extra.maximumDays': disputed(90, 30) });
    expect(convertCooldown(sample, duration('30d'))).toMatchObject({ ok: true, value: 30 });
    expect(convertCooldown(sample, duration('721h'))).toEqual({
      ok: false,
      tool: 'npm',
      reason: 'Sample npm accepts at most 30 days, but 721h needs 31 days',
    });
  });

  it('applies a maximum in days to tools that count in other units', () => {
    const sample = syntheticTool({ 'cooldown.unit': fact('minutes'), 'extra.maximumDays': fact(1) });
    expect(convertCooldown(sample, duration('24h'))).toMatchObject({ ok: true, value: 1440 });
    expect(convertCooldown(sample, duration('1441m'))).toEqual({
      ok: false,
      tool: 'npm',
      reason: 'Sample npm accepts at most 1 day, but 1441m needs 1441 minutes',
    });
  });
});
