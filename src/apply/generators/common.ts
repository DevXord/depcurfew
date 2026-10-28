// Policy rules shared by the generators: converting the cooldown, filtering exclusions and allow-lists by what a
// tool accepts, and mapping dependency sources to settings. Anything a tool cannot express becomes a warning;
// dropping it always errs on the safe side (a longer delay, fewer install scripts).
import { convertCooldown } from '../../policy/convert.ts';
import type { Duration } from '../../policy/duration.ts';
import { SOURCE_KINDS } from '../../knowledge/schema.ts';
import { extraOf, isWildcards, settingOf, sinceOf } from '../facts.ts';
import type { Context } from './context.ts';

const MINUTES: Record<string, number> = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440, weeks: 10080 };

export type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_LABELS: Record<SourceKind, string> = {
  git: 'git',
  remoteTarball: 'remote tarball',
  file: 'local tarball',
  directory: 'local directory',
};

export interface CooldownValue {
  value: number | string;
  minutes: number;
}

/** The cooldown in the tool's unit, or undefined (with a warning) when it cannot be written. */
export function cooldownValue(context: Context, duration: Duration | undefined = context.policy.cooldown?.minimum): CooldownValue | undefined {
  if (duration === undefined) return undefined;
  const setting = settingOf(context.tool.cooldown.setting);
  if (setting === null) return undefined;
  const result = convertCooldown(context.tool, duration);
  if (!result.ok) {
    context.warn(`${context.name}: cooldown not written: ${result.reason}`);
    return undefined;
  }
  if (!context.supports(sinceOf(context.tool.cooldown.availableSince), setting)) return undefined;
  if (typeof result.value === 'string') {
    const [count = '0', unit = ''] = result.value.split(' ');
    return { value: result.value, minutes: Number(count) * (MINUTES[unit.endsWith('s') ? unit : `${unit}s`] ?? 0) };
  }
  return { value: result.value, minutes: result.value * (MINUTES[result.unit] ?? 0) };
}

/** The policy's exclusions that the tool's exclusion setting accepts; undefined when the setting cannot be used. */
export function exclusions(context: Context): string[] | undefined {
  const patterns = context.policy.cooldown?.exclude ?? [];
  const setting = settingOf(context.tool.cooldown.exclude.setting);
  if (setting === null) return undefined;
  if (patterns.length > 0 && !context.supports(sinceOf(context.tool.cooldown.exclude.availableSince), setting)) return undefined;
  const wildcards = extraOf(context.tool, 'excludeWildcards', isWildcards);
  const wildcardsWork = wildcards.since !== null && context.atLeast(wildcards.since);
  return patterns.filter((pattern) => {
    if (!pattern.includes('*')) return true;
    const accepted = wildcardsWork && (!wildcards.trailingOnly || pattern.indexOf('*') === pattern.length - 1);
    if (!accepted) context.warn(`${context.name}: ${setting} does not support the pattern "${pattern}"; not written`);
    return accepted;
  });
}

/** Allow-lists take package names only; patterns are dropped with a warning. */
export function allowedNames(context: Context, setting: string): string[] {
  return (context.policy.installScripts?.allow ?? []).filter((pattern) => {
    if (!pattern.includes('*')) return true;
    context.warn(`${context.name}: ${setting} takes package names only; "${pattern}" not written`);
    return false;
  });
}

/** Calls `apply` for every dependency source the policy manages and the tool has a setting for. */
export function eachSource(context: Context, apply: (kind: SourceKind, setting: string, access: 'allow' | 'deny') => void): void {
  const sources = context.policy.sources;
  if (sources === undefined) return;
  for (const kind of SOURCE_KINDS) {
    const access = sources[kind];
    if (access === undefined) continue;
    const knowledge = context.tool.sources?.[kind];
    const setting = settingOf(knowledge?.setting);
    if (setting === null) {
      if (access === 'deny') context.warn(`${context.name} has no setting for ${SOURCE_LABELS[kind]} dependencies; "deny" cannot be enforced`);
      continue;
    }
    if (!context.supports(sinceOf(knowledge?.availableSince), setting)) continue;
    apply(kind, setting, access);
  }
}

/** `install.minimumReleaseAge` → table `install`, key `minimumReleaseAge`. */
export function splitDotted(setting: string): { table: string; key: string } {
  const dot = setting.indexOf('.');
  return dot === -1 ? { table: '', key: setting } : { table: setting.slice(0, dot), key: setting.slice(dot + 1) };
}

export function sameList(a: unknown, b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
