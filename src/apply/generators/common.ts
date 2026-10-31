// Policy rules shared by the generators: converting the cooldown, filtering exclusions and allow-lists by what a
// tool accepts, and mapping dependency sources to settings. Anything a tool cannot express becomes a warning;
// dropping it always errs on the safe side (a longer delay, fewer install scripts).
import { evidenceOf } from '../../knowledge/facts.ts';
import { convertCooldown } from '../../policy/convert.ts';
import type { Duration } from '../../policy/duration.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { SOURCE_KINDS } from '../../knowledge/schema.ts';
import type { Ecosystem } from '../../knowledge/types.ts';
import { extraOf, isRecord, isWildcards, settingOf, sinceOf, values } from '../facts.ts';
import type { Context } from './context.ts';

const MINUTES: Record<string, number> = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440, weeks: 10080 };

export type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_LABELS: Record<Ecosystem, Record<SourceKind, string>> = {
  npm: { git: 'git', remoteTarball: 'remote tarball', file: 'local tarball', directory: 'local directory' },
  pypi: { git: 'git', remoteTarball: 'URL', file: 'local archive', directory: 'local directory' },
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
    context.warn({ code: 'cooldown-not-written', message: `${context.name}: cooldown not written: ${result.reason}`, fix: result.fix });
    return undefined;
  }
  if (!context.supports(sinceOf(context.tool.cooldown.availableSince), setting)) return undefined;
  if (typeof result.value === 'string') {
    const [count = '0', unit = ''] = result.value.split(' ');
    return { value: result.value, minutes: Number(count) * (MINUTES[unit.endsWith('s') ? unit : `${unit}s`] ?? 0) };
  }
  return { value: result.value, minutes: result.value * (MINUTES[result.unit] ?? 0) };
}

/** The exclusions (the policy's by default) that the tool's exclusion setting accepts; undefined when the setting cannot be used. */
export function exclusions(context: Context, patterns: readonly string[] = context.policy.cooldown?.exclude ?? []): string[] | undefined {
  const setting = settingOf(context.tool.cooldown.exclude.setting);
  if (setting === null) return undefined;
  if (patterns.length > 0 && !context.supports(sinceOf(context.tool.cooldown.exclude.availableSince), setting)) return undefined;
  const wildcards = extraOf(context.tool, 'excludeWildcards', isWildcards);
  const wildcardsWork = wildcards.since !== null && context.atLeast(wildcards.since);
  return patterns.filter((pattern) => {
    if (!pattern.includes('*')) return true;
    const accepted = wildcardsWork && (!wildcards.trailingOnly || pattern.indexOf('*') === pattern.length - 1);
    if (!accepted) {
      context.warn({
        code: 'exclude-pattern-unsupported',
        message: `${context.name}: ${setting} does not support the pattern "${pattern}"; not written`,
        fix: 'List the exact package names in cooldown.exclude',
      });
    }
    return accepted;
  });
}

/** How a tool records a package whose install scripts stay blocked on purpose (extra.denyList), if it can. */
export interface DenyList {
  file: string;
  setting: string;
  value: unknown;
  since: string;
}

export function denyList(context: Context): DenyList | undefined {
  const fact = context.tool.extra?.['denyList'];
  if (fact === undefined) return undefined;
  const value = evidenceOf(fact)[0]?.value;
  return isRecord(value) && typeof value['file'] === 'string' && typeof value['setting'] === 'string' && typeof value['since'] === 'string'
    ? (value as unknown as DenyList)
    : undefined;
}

/** The packages of installScripts.deny the tool can record: names only, patterns are dropped with a warning. */
export function deniedNames(context: Context, setting: string): string[] {
  return (context.policy.installScripts?.deny ?? []).filter((pattern) => {
    if (!pattern.includes('*')) return true;
    context.warn({ code: 'deny-pattern-unsupported', message: `${context.name}: ${setting} takes package names only; "${pattern}" not written`, fix: 'List the package names in installScripts.deny' });
    return false;
  });
}

/**
 * Records installScripts.deny where the tool has an explicit denial (npm allowScripts, pnpm allowBuilds, Yarn
 * dependenciesMeta): the tool then keeps those scripts blocked without warning about them on every install.
 */
export function writeDenyList(context: Context): void {
  const deny = denyList(context);
  if (deny === undefined || (context.policy.installScripts?.deny.length ?? 0) === 0) return;
  if (!context.supports(deny.since, deny.setting)) return;
  const file = deny.file.endsWith('.yaml') ? context.yaml(deny.file) : context.json(deny.file);
  for (const name of deniedNames(context, deny.setting)) {
    const path = deny.setting.includes('<package>') ? deny.setting.split('.').map((segment) => (segment === '<package>' ? name : segment)) : [...deny.setting.split('.'), name];
    if (file.get(path) !== deny.value) file.set(path, deny.value);
  }
}

/** Allow-lists take package names only; patterns are dropped with a warning. */
export function allowedNames(context: Context, setting: string): string[] {
  return (context.policy.installScripts?.allow ?? []).filter((pattern) => {
    if (!pattern.includes('*')) return true;
    context.warn({ code: 'allow-pattern-unsupported', message: `${context.name}: ${setting} takes package names only; "${pattern}" not written`, fix: 'List the package names in installScripts.allow' });
    return false;
  });
}

/**
 * What the pinned version does with dependency install scripts by default (installScripts.defaultPolicy), and the
 * first later version that does something else.
 */
export function scriptsDefault(context: Context): { value: unknown; changesIn: string | undefined } {
  let value: unknown;
  let changesIn: string | undefined;
  for (const entry of values(context.tool.installScripts.defaultPolicy)[0] ?? []) {
    if (context.atLeast(entry.since)) {
      value = entry.value;
      changesIn = undefined;
    } else {
      changesIn ??= entry.since;
    }
  }
  return { value, changesIn };
}

/** Where depcurfew doctor finds a tool's dependencies: the lockfile, or pip's requirements files. */
export function dependencyFiles(context: Context): string {
  return context.tool.extra?.['requirementsFormat'] === undefined ? 'the lockfile' : 'the requirements files';
}

/** Whether depcurfew doctor can tell dependency sources apart in the tool's lockfile. */
function lockfileShowsSources(tool: Context['tool']): boolean {
  const fact = tool.extra?.['lockfileFormat'];
  const format = fact === undefined ? undefined : values(fact)[0];
  return isRecord(format) && format['sources'] !== null;
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
      if (access === 'deny') {
        context.warn({
          code: 'source-not-enforceable',
          message: `${context.name} has no setting for ${SOURCE_LABELS[ecosystemOfTool(context.tool)][kind]} dependencies, so "deny" cannot be enforced`,
          fix: lockfileShowsSources(context.tool)
            ? `Run depcurfew doctor, which reports such dependencies in ${dependencyFiles(context)}`
            : 'Review new dependencies by hand; depcurfew doctor cannot see them in the lockfile either',
        });
      }
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
