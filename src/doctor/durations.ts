// Release-age values as the tools write them, turned into minutes: numbers in the tool's unit, and duration strings
// in the syntax the knowledge base records for that tool (extra.durationStrings).
import { isRecord, values } from '../apply/facts.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
import { TomlDateTime } from '../detect/toml.ts';
import { cargo } from '../knowledge/cargo.ts';
import type { ToolKnowledge, UserCooldownUnit } from '../knowledge/types.ts';

const MINUTES: Record<string, number> = {
  ms: 1 / 60000,
  s: 1 / 60,
  second: 1 / 60,
  m: 1,
  minute: 1,
  h: 60,
  hour: 60,
  d: 1440,
  day: 1440,
  w: 10080,
  week: 10080,
};

const UNIT_MINUTES: Record<string, number> = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440 };

function word(unit: string): number | undefined {
  return MINUTES[unit.toLowerCase().replace(/s$/u, '')];
}

// The characters of one number and one unit word, as \s, \d and [a-z] with the flags i and u read them: case folding
// lets [a-z] match the Kelvin sign and the long s too (decision D-200).
const BLANK = /^\s$/u;
const DIGIT = /^\d$/u;
const LETTER = /^[a-z]$/iu;

/** Where the run of characters that `kind` accepts ends, from `at`. */
function runEnd(text: string, at: number, kind: RegExp): number {
  let end = at;
  while (end < text.length && kind.test(text[end] ?? '')) end++;
  return end;
}

/**
 * The numbers and unit words of a text made only of them and blanks ("1 day 12h", "3days"), in order; undefined for
 * any other text. The text is read once, one character at a time: blanks, digits, blanks, letters, blanks, again and
 * again, as the pattern \s*(\d+)\s*([a-z]+)\s* read from where the last part ended; a search for (\d+)\s*([a-z]+)
 * anywhere in it took seconds on 40,000 digits and "!" (decision D-200).
 */
export function durationWords(text: string): [string, string][] | undefined {
  const parts: [string, string][] = [];
  let at = 0;
  while (at < text.length) {
    const numberStart = runEnd(text, at, BLANK);
    const numberEnd = runEnd(text, numberStart, DIGIT);
    if (numberEnd === numberStart) return undefined;
    const unitStart = runEnd(text, numberEnd, BLANK);
    const unitEnd = runEnd(text, unitStart, LETTER);
    if (unitEnd === unitStart) return undefined;
    parts.push([text.slice(numberStart, numberEnd), text.slice(unitStart, unitEnd)]);
    at = runEnd(text, unitEnd, BLANK);
  }
  return parts.length === 0 ? undefined : parts;
}

/** A delay in the 'words' syntax ("1 day 12h"), in minutes; undefined for any other text. */
export function wordsMinutes(text: string): number | undefined {
  const parts = durationWords(text);
  if (parts === undefined) return undefined;
  let total = 0;
  for (const [number, unit] of parts) {
    const minutes = word(unit);
    if (minutes === undefined) return undefined;
    total += Number(number) * minutes;
  }
  return total;
}

const SYNTAX: Record<string, (text: string) => number | undefined> = {
  compact: (text) => {
    const match = /^(\d+)(ms|s|m|h|d|w)$/u.exec(text);
    return match === null ? undefined : Number(match[1]) * (MINUTES[match[2] ?? ''] ?? Number.NaN);
  },
  'compact-or-words': (text) => SYNTAX['compact']?.(text) ?? SYNTAX['words']?.(text),
  words: (text) => wordsMinutes(text),
  // One number and one lowercase unit word, singular or plural (Composer's policy.cooldown.period).
  'unit-word': (text) => {
    const match = /^(\d+)\s*(second|minute|hour|day|week)s?$/u.exec(text);
    return match === null ? undefined : Number(match[1]) * (MINUTES[match[2] ?? ''] ?? Number.NaN);
  },
  'words-or-iso8601': (text) => SYNTAX['iso8601']?.(text) ?? SYNTAX['words']?.(text),
  iso8601: (text) => {
    const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(text);
    if (match === null || text === 'P' || text.endsWith('T')) return undefined;
    const [weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
    return (weeks ?? 0) * 10080 + (days ?? 0) * 1440 + (hours ?? 0) * 60 + (minutes ?? 0) + (seconds ?? 0) / 60;
  },
};

export type DelayValue = { ok: true; minutes: number } | { ok: false; reason: string };

/** The unit of a plain number where the tool's unit is a duration string (extra.durationStrings.numbers). */
function numberUnit(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['durationStrings'];
  const format = fact === undefined ? undefined : values(fact)[0];
  return isRecord(format) && typeof format['numbers'] === 'string' ? format['numbers'] : undefined;
}

/** A delay as written for `tool` at `version` (undefined: the latest version). null and 0 mean no delay. */
export function delayMinutes(tool: ToolKnowledge, value: unknown, version: Version | undefined): DelayValue {
  if (value === null || value === undefined || value === false) return { ok: true, minutes: 0 };
  if (typeof value === 'number' && Number.isNaN(value)) return { ok: false, reason: 'NaN is not a delay' };
  // TOML integers beyond Number.MAX_SAFE_INTEGER arrive as BigInt, which JSON.stringify cannot write.
  if (typeof value === 'bigint' || (typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: `${String(value)} is too large to be a delay` };
  }
  if (typeof value === 'number') {
    const unit = values(tool.cooldown.unit)[0];
    // A tool whose unit is a duration string may read a plain number in a unit of its own (Composer: seconds).
    const numbers = unit === 'duration-string' ? numberUnit(tool) : undefined;
    const factor = numbers !== undefined ? UNIT_MINUTES[numbers] : unit === null || unit === undefined ? undefined : UNIT_MINUTES[unit];
    return factor === undefined ? { ok: false, reason: `${tool.name} takes no number here` } : { ok: true, minutes: value * factor };
  }
  if (typeof value !== 'string') return { ok: false, reason: `${JSON.stringify(value) ?? String(value)} is not a delay` };
  const fact = tool.extra?.['durationStrings'];
  const format = fact === undefined ? undefined : values(fact)[0];
  // Cargo reads its time span as maybe_parse_time_span does (E07): "0" alone is no delay, and a product above u64 may be
  // wrapped by Cargo to a short delay, so it is no delay depcurfew can read either.
  if (isRecord(format) && format['syntax'] === 'cargo') {
    const span = cargoTimeSpan(value);
    if (span.kind === 'off') return { ok: true, minutes: 0 };
    if (span.kind === 'delay') return { ok: true, minutes: span.seconds / 60 };
    return { ok: false, reason: span.kind === 'overflow' ? `"${value}" is more seconds than Cargo counts, and Cargo may wrap it to a short delay` : `"${value}" is not a time span ${tool.name} reads` };
  }
  // Composer matches the string as it is (durationStrings trim: false); the other tools read it without the spaces around it.
  const text = isRecord(format) && format['trim'] === false ? value : value.trim();
  if (/^\d+$/u.test(text)) return delayMinutes(tool, Number(text), version);
  if (!isRecord(format) || typeof format['syntax'] !== 'string') return { ok: false, reason: `${tool.name} takes no duration strings` };
  const since = typeof format['since'] === 'string' ? parseVersion(format['since']) : undefined;
  if (since !== undefined && version !== undefined && compareVersions(version, since) < 0) {
    return { ok: false, reason: `${tool.name} accepts duration strings only since ${format['since'] as string}` };
  }
  const minutes = SYNTAX[format['syntax']]?.(text);
  return minutes === undefined ? { ok: false, reason: `"${text}" is not a duration ${tool.name} understands` } : { ok: true, minutes };
}

const CUTOFF = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/u;

/**
 * The moment (milliseconds since the epoch) of a fixed date or time that the tool reads in place of a delay
 * (extra.cutoffDates: uv's and PDM's exclude-newer, Deno's minimumDependencyAge), with the text as written. A date
 * without a time is its start in UTC, the earliest moment any time zone gives it; a time without an offset counts only
 * where the tool reads it as UTC. undefined for any other value.
 */
export function cutoffTime(tool: ToolKnowledge, value: unknown): { time: number; text: string } | undefined {
  const fact = tool.extra?.['cutoffDates'];
  const format = fact === undefined ? undefined : values(fact)[0];
  if (!isRecord(format)) return undefined;
  const text = typeof value === 'string' ? value.trim() : value instanceof TomlDateTime ? value.text : undefined;
  const match = text === undefined ? null : CUTOFF.exec(text);
  if (text === undefined || match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  if (hour !== undefined && offset === undefined && format['offsetRequired'] !== false) return undefined;
  const date = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0), Math.round(Number(fraction ?? 0) * 1000));
  const check = new Date(date);
  if (check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)) return undefined;
  const sign = offset === undefined || /^[Zz]$/u.test(offset) ? 0 : offset.startsWith('-') ? -1 : 1;
  const digits = offset?.replace(/[^0-9]/gu, '') ?? '';
  const shift = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
  return { time: date - shift * 60000, text };
}

/**
 * A fixed date or time that the tool reads in place of a delay (cutoffTime): it holds back every version uploaded after
 * it, so it counts as the time since it, in whole days rounded up (decision D-167). undefined for any other value.
 */
export function cutoffAge(tool: ToolKnowledge, value: unknown, now: number): { minutes: number; text: string } | undefined {
  const cutoff = cutoffTime(tool, value);
  if (cutoff === undefined) return undefined;
  const age = (now - cutoff.time) / 60000;
  return { minutes: age <= 0 ? 0 : Math.ceil(age / 1440) * 1440, text: cutoff.text };
}

/** The unit of the release-age setting in the tool's user file, when it is not the unit of its own setting (user.cooldownUnit). */
export function userCooldownUnit(tool: ToolKnowledge): UserCooldownUnit | undefined {
  const fact = tool.user?.cooldownUnit;
  return fact === undefined ? undefined : values(fact)[0];
}

/** A delay as written in the tool's user file: in the unit of user.cooldownUnit where it has one, else as `delayMinutes`. */
export function userDelayMinutes(tool: ToolKnowledge, value: unknown, version: Version | undefined): DelayValue {
  const unit = userCooldownUnit(tool);
  if (unit === undefined) return delayMinutes(tool, value, version);
  if (value === null || value === undefined || value === false) return { ok: true, minutes: 0 };
  const number = typeof value === 'string' && /^\d+(\.\d+)?$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || (unit.wholeNumbers && !Number.isInteger(number))) {
    return { ok: false, reason: `${tool.name} reads ${unit.key} there only as a whole number of ${unit.unit}` };
  }
  return { ok: true, minutes: number * (UNIT_MINUTES[unit.unit] ?? Number.NaN) };
}

/** The value the tool's user file takes for a delay: in the unit of user.cooldownUnit, rounded up to a whole number where only those count. */
export function userCooldownAmount(tool: ToolKnowledge, minutes: number): { value: number; minutes: number } | undefined {
  const unit = userCooldownUnit(tool);
  const factor = unit === undefined ? undefined : UNIT_MINUTES[unit.unit];
  if (unit === undefined || factor === undefined) return undefined;
  // Rounded toward the longer delay.
  const amount = unit.wholeNumbers ? Math.ceil(minutes / factor) : minutes / factor;
  return { value: amount, minutes: amount * factor };
}

export function formatMinutes(minutes: number): string {
  for (const [unit, size] of [
    ['week', 10080],
    ['day', 1440],
    ['hour', 60],
  ] as const) {
    if (minutes >= size && minutes % size === 0) return `${minutes / size} ${unit}${minutes === size ? '' : 's'}`;
  }
  const rounded = Math.round(minutes * 100) / 100;
  return `${rounded} minute${rounded === 1 ? '' : 's'}`;
}

/**
 * A Cargo time span read as Cargo reads it (maybe_parse_time_span, extra.timeSpan of Cargo, E05): "0" or a span of zero
 * is no delay; a whole number in ASCII digits, at most one space and a unit in the singular or plural is a delay in
 * seconds; anything else is invalid, which stops Cargo's resolution with an error. A product of the number and the unit
 * above u64 is a result of its own: Cargo multiplies without a check, and whether its build wraps the product is not
 * established, so it may be a short delay (fail closed). A loop over the characters (decision D-200).
 */
export type CargoTimeSpan = { kind: 'off' } | { kind: 'delay'; seconds: number } | { kind: 'overflow' } | { kind: 'invalid' };

const U64_MAX = (1n << 64n) - 1n;

function cargoUnits(): Readonly<Record<string, number>> {
  const fact = cargo.extra?.['timeSpan'];
  const found = fact === undefined ? undefined : values(fact)[0];
  const units = isRecord(found) && isRecord(found['units']) ? found['units'] : {};
  return Object.fromEntries(Object.entries(units).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

export function cargoTimeSpan(text: string): CargoTimeSpan {
  if (text === '0') return { kind: 'off' };
  let end = 0;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end += 1;
  // A number without a unit (or nothing at all) is not a span.
  if (end === 0 || end === text.length) return { kind: 'invalid' };
  const digits = text.slice(0, end);
  let unit = text.slice(end);
  if (unit.startsWith(' ')) unit = unit.slice(1);
  const units = cargoUnits();
  const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
  const factor = Object.hasOwn(units, singular) ? units[singular] : undefined;
  if (factor === undefined) return { kind: 'invalid' };
  // u64 parse: a number above u64 is an error in Cargo.
  if (digits.replace(/^0+/u, '').length > 20) return { kind: 'invalid' };
  const count = BigInt(digits);
  if (count > U64_MAX) return { kind: 'invalid' };
  const product = count * BigInt(factor);
  if (product > U64_MAX) return { kind: 'overflow' };
  return product === 0n ? { kind: 'off' } : { kind: 'delay', seconds: Number(product) };
}
