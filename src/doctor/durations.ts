// Release-age values as the tools write them, turned into minutes: numbers in the tool's unit, and duration strings
// in the syntax the knowledge base records for that tool (extra.durationStrings).
import { isRecord, values } from '../apply/facts.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
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

const SYNTAX: Record<string, (text: string) => number | undefined> = {
  compact: (text) => {
    const match = /^(\d+)(ms|s|m|h|d|w)$/u.exec(text);
    return match === null ? undefined : Number(match[1]) * (MINUTES[match[2] ?? ''] ?? Number.NaN);
  },
  'compact-or-words': (text) => SYNTAX['compact']?.(text) ?? SYNTAX['words']?.(text),
  words: (text) => {
    const parts = [...text.matchAll(/(\d+)\s*([a-z]+)/giu)];
    if (parts.length === 0 || parts.map((part) => part[0]).join(' ').replaceAll(/\s+/gu, '') !== text.replaceAll(/\s+/gu, '')) return undefined;
    let total = 0;
    for (const part of parts) {
      const unit = word(part[2] ?? '');
      if (unit === undefined) return undefined;
      total += Number(part[1]) * unit;
    }
    return total;
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
    const factor = unit === null || unit === undefined ? undefined : UNIT_MINUTES[unit];
    return factor === undefined ? { ok: false, reason: `${tool.name} takes no number here` } : { ok: true, minutes: value * factor };
  }
  if (typeof value !== 'string') return { ok: false, reason: `${JSON.stringify(value) ?? String(value)} is not a delay` };
  const text = value.trim();
  if (/^\d+$/u.test(text)) return delayMinutes(tool, Number(text), version);
  const fact = tool.extra?.['durationStrings'];
  const format = fact === undefined ? undefined : values(fact)[0];
  if (!isRecord(format) || typeof format['syntax'] !== 'string') return { ok: false, reason: `${tool.name} takes no duration strings` };
  const since = typeof format['since'] === 'string' ? parseVersion(format['since']) : undefined;
  if (since !== undefined && version !== undefined && compareVersions(version, since) < 0) {
    return { ok: false, reason: `${tool.name} accepts duration strings only since ${format['since'] as string}` };
  }
  const minutes = SYNTAX[format['syntax']]?.(text);
  return minutes === undefined ? { ok: false, reason: `"${text}" is not a duration ${tool.name} understands` } : { ok: true, minutes };
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
