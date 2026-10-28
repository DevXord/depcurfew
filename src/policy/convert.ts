// Converts a policy duration into the value a tool expects. Units, accepted duration words and limits come from
// the knowledge base. Every conversion rounds towards the longer delay; when that is impossible (the tool's
// maximum is too low), the conversion fails instead of shortening the delay.
import { evidenceOf } from '../knowledge/facts.ts';
import type { DelayUnit, Fact, ToolId, ToolKnowledge } from '../knowledge/types.ts';
import type { Duration } from './duration.ts';

export type NumericDelayUnit = Exclude<DelayUnit, 'duration-string'>;

export const DURATION_STRING_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export type DurationStringUnit = (typeof DURATION_STRING_UNITS)[number];

type TimeUnit = NumericDelayUnit | DurationStringUnit;

const SECONDS_PER: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };

const SINGULAR: Record<TimeUnit, string> = { seconds: 'second', minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week' };

export interface Converted<T> {
  value: T;
  /** False when the value was rounded up. */
  exact: boolean;
}

export type CooldownConversion =
  | { ok: true; tool: ToolId; unit: DelayUnit; value: number | string; exact: boolean }
  | { ok: false; tool: ToolId; reason: string };

/** The smallest whole number of `unit` that lasts at least `minutes`. Integer arithmetic, exact for safe integers. */
function countIn(minutes: number, unit: TimeUnit): Converted<number> {
  if (unit === 'seconds') return { value: minutes * 60, exact: true };
  const size = SECONDS_PER[unit] / 60;
  const remainder = minutes % size;
  return { value: (minutes - remainder) / size + (remainder === 0 ? 0 : 1), exact: remainder === 0 };
}

function amount(count: number, unit: TimeUnit): string {
  return `${count} ${count === 1 ? SINGULAR[unit] : unit}`;
}

/** The largest unit that represents `minutes` exactly, otherwise the smallest unit, rounded up. */
function pickUnit(minutes: number, units: readonly DurationStringUnit[]): DurationStringUnit {
  const bySize = [...units].sort((a, b) => SECONDS_PER[b] - SECONDS_PER[a]);
  const unit = bySize.find((candidate) => countIn(minutes, candidate).exact) ?? bySize[bySize.length - 1];
  if (unit === undefined) throw new Error('toDurationString needs at least one unit');
  return unit;
}

export function convertMinutes(minutes: number, unit: NumericDelayUnit): Converted<number> {
  return countIn(minutes, unit);
}

/** Writes minutes as a duration string such as `36 hours` or `3 days`. */
export function toDurationString(minutes: number, units: readonly DurationStringUnit[]): Converted<string> {
  const unit = pickUnit(minutes, units);
  const { value, exact } = countIn(minutes, unit);
  return { value: amount(value, unit), exact };
}

function valuesOf<T>(fact: Fact<T>): T[] {
  return evidenceOf(fact).map((evidence) => evidence.value);
}

function extraValues(tool: ToolKnowledge, key: string): unknown[] | undefined {
  const fact = tool.extra?.[key];
  return fact === undefined ? undefined : valuesOf(fact);
}

function isDurationStringUnit(value: unknown): value is DurationStringUnit {
  return (DURATION_STRING_UNITS as readonly unknown[]).includes(value);
}

/** Units every variant of `extra.durationUnits` agrees on; undefined when missing or malformed. */
function durationUnits(tool: ToolKnowledge): DurationStringUnit[] | undefined {
  const variants = extraValues(tool, 'durationUnits');
  if (variants === undefined) return undefined;
  const lists: DurationStringUnit[][] = [];
  for (const variant of variants) {
    if (!Array.isArray(variant) || !variant.every(isDurationStringUnit)) return undefined;
    lists.push(variant);
  }
  const [first = [], ...rest] = lists;
  return first.filter((unit) => rest.every((list) => list.includes(unit)));
}

/** The lowest maximum among the variants of `extra.maximumDays`, if any. */
function maximumDays(tool: ToolKnowledge): number | undefined {
  const values = (extraValues(tool, 'maximumDays') ?? []).filter(
    (value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0,
  );
  return values.length === 0 ? undefined : Math.min(...values);
}

/**
 * Converts the policy's minimum release age into the value for one tool. When official sources disagree on the
 * unit, the smallest unit wins: its larger number is long enough under every reading.
 */
export function convertCooldown(tool: ToolKnowledge, duration: Duration): CooldownConversion {
  const fail = (reason: string): CooldownConversion => ({ ok: false, tool: tool.id, reason });
  const units = valuesOf(tool.cooldown.unit);
  if (units.includes(null)) return fail(`${tool.name} has no release-age setting`);

  let unit: TimeUnit;
  let delayUnit: DelayUnit;
  if (units.includes('duration-string')) {
    if (units.some((candidate) => candidate !== 'duration-string')) {
      return fail(`the unit of the ${tool.name} release-age setting is disputed between a number and a duration string`);
    }
    const words = durationUnits(tool);
    if (words === undefined || words.length === 0) {
      return fail(`the knowledge base does not list which duration units ${tool.name} accepts (extra.durationUnits)`);
    }
    unit = pickUnit(duration.minutes, words);
    delayUnit = 'duration-string';
  } else {
    unit = (units as NumericDelayUnit[]).reduce((a, b) => (SECONDS_PER[b] < SECONDS_PER[a] ? b : a));
    delayUnit = unit;
  }

  const { value: count, exact } = countIn(duration.minutes, unit);
  const value = delayUnit === 'duration-string' ? amount(count, unit) : count;

  const maximum = maximumDays(tool);
  if (maximum !== undefined && count * SECONDS_PER[unit] > maximum * SECONDS_PER.days) {
    return fail(`${tool.name} accepts at most ${amount(maximum, 'days')}, but ${duration.text} needs ${amount(count, unit)}`);
  }
  return { ok: true, tool: tool.id, unit: delayUnit, value, exact };
}
