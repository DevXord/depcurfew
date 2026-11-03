// Policy rules shared by the generators: converting the cooldown, filtering exclusions and allow-lists by what a
// tool accepts, and mapping dependency sources to settings. Anything a tool cannot express becomes a warning;
// dropping it always errs on the safe side (a longer delay, fewer install scripts).
import type { PackageManagerId } from '../../detect/types.ts';
import { allowEntries, type TextSource } from '../../doctor/allow-lists.ts';
import { cutoffAge, delayMinutes } from '../../doctor/durations.ts';
import { jsonSetting, yamlSetting } from '../../doctor/settings.ts';
import { TomlDateTime } from '../../detect/toml.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { listing } from '../requirements.ts';
import { SUPERSEDED } from '../block.ts';
import { YAML_MARKER } from '../yaml-edit.ts';
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
  packagist: { git: 'VCS repository', remoteTarball: 'package repository', file: 'artifact repository', directory: 'path repository' },
  rubygems: { git: 'git', remoteTarball: 'archive URL', file: 'local archive', directory: 'path' },
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

/**
 * Whether a release-age value in the tool's file is one depcurfew cannot read: neither a delay it understands nor a
 * fixed date the tool reads (decision D-167). apply leaves such a value as it is, with cooldown-not-written, instead of
 * replacing what may be a longer delay than the policy's; a value depcurfew wrote is always one it reads.
 */
export function unreadableDelay(context: Context, file: string, setting: string, value: unknown, line: number | undefined, written: CooldownValue): boolean {
  if (value === undefined) return false;
  const delay = delayMinutes(context.tool, value, context.version);
  if (delay.ok || cutoffAge(context.tool, value, Date.now()) !== undefined) return false;
  const shown = value instanceof TomlDateTime ? value.text : JSON.stringify(value);
  const where = line === undefined ? '' : ` (line ${line})`;
  context.warn({
    code: 'cooldown-not-written',
    location: line === undefined ? { file } : { file, line },
    message: `${context.name}: cooldown not written: ${setting} in ${file}${where} is ${shown}, which depcurfew cannot read (${delay.reason}), so depcurfew apply leaves it as it is instead of replacing a delay that may be longer than cooldown.minimum`,
    fix: `Write the delay in a form ${context.name} documents, such as ${JSON.stringify(written.value)}, or remove ${setting} so that depcurfew apply writes ${JSON.stringify(written.value)}, then run depcurfew apply again`,
  });
  return true;
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
 * The files as this run has edited them so far, for reading the tools' own lists. A file the workspace cannot read
 * counts as missing: reading a list must not stop apply, and an edit of that file reports the problem itself.
 */
export function workspaceText(workspace: Context['workspace']): TextSource {
  return {
    readText(file) {
      try {
        return workspace.exists(file) ? workspace.read(file) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The packages that an entry of the tool's own allow-list lets run their scripts, in any version. apply records no
 * denial for them, because that would change what the entry does, and apply never changes an entry it did not write
 * (decision D-088); the warning deny-conflicts-with-file names the entry instead.
 */
export function allowedInFiles(context: Context, configFiles: readonly string[] = []): Set<string> {
  const id = context.tool.id as PackageManagerId;
  const options = { tool: context.tool, ...(context.version === undefined ? {} : { version: context.version }) };
  return new Set(allowEntries(workspaceText(context.workspace), id, configFiles, options).map((entry) => entry.package));
}

/** The setting for messages: dependenciesMeta for the template dependenciesMeta.<package>.built. */
function settingName(setting: string): string {
  const at = setting.indexOf('.<package>');
  return at === -1 ? setting : setting.slice(0, at);
}

/**
 * Records installScripts.deny where the tool has an explicit denial (npm allowScripts, pnpm allowBuilds, Yarn
 * dependenciesMeta): the tool then keeps those scripts blocked without warning about them on every install. `fileFor`
 * gives the file that holds the setting when it is not always the same (pnpm include, decision D-164), undefined when
 * apply cannot write it.
 */
export function writeDenyList(context: Context, fileFor?: (setting: string) => string | undefined): void {
  const deny = denyList(context);
  if (deny === undefined || (context.policy.installScripts?.deny.length ?? 0) === 0) return;
  if (!context.supports(deny.since, deny.setting)) return;
  const allowed = allowedInFiles(context);
  const names = deniedNames(context, settingName(deny.setting)).filter((name) => !allowed.has(name));
  if (names.length === 0) return;
  // pnpm 12.15 and later: the file include gives the list to (decision D-164).
  const target = fileFor === undefined ? deny.file : fileFor(settingName(deny.setting));
  if (target === undefined) return;
  const file = target.endsWith('.yaml') || target.endsWith('.yml') ? context.yaml(target) : context.json(target);
  // The list is an object of package names (npm's allowScripts, pnpm's allowBuilds, Yarn's dependenciesMeta); one of
  // another type is left as it is (decision D-167).
  const list = settingName(deny.setting).split('.');
  if (wrongListType(context, target, list, file.get(list), 'object', names, `{${JSON.stringify(names[0])}: ${JSON.stringify(deny.setting.includes('<package>') ? { [deny.setting.split('.').at(-1) ?? '']: deny.value } : deny.value)}}`)) return;
  context.writes('installScripts', deny.setting, target);
  for (const name of names) {
    const path = deny.setting.includes('<package>') ? deny.setting.split('.').map((segment) => (segment === '<package>' ? name : segment)) : [...deny.setting.split('.'), name];
    if (deny.setting.includes('<package>') && wrongListType(context, target, path.slice(0, -1), file.get(path.slice(0, -1)), 'object', [name], `{${JSON.stringify(path.at(-1))}: ${JSON.stringify(deny.value)}}`)) continue;
    if (file.get(path) !== deny.value) file.set(path, deny.value);
  }
}

/** A value for a message about its type: "a list", "an object", "the string \"x\"", "true". */
function typeText(value: unknown): string {
  if (Array.isArray(value)) return 'a list';
  if (isRecord(value)) return 'an object';
  return typeof value === 'string' ? `the string ${JSON.stringify(value)}` : String(JSON.stringify(value));
}

/**
 * Whether the allow-list or deny-list at `path` of a JSON or YAML file has a value of another type than the tool reads
 * there (npm's allowScripts as a list, Bun's trustedDependencies as an object, Yarn's dependenciesMeta as a list):
 * unexpected-value, and nothing is written into it, since replacing it would drop the packages it names (decision
 * D-167). A value that is not there is of no wrong type.
 */
export function wrongListType(context: Context, file: string, path: readonly string[], current: unknown, expected: 'object' | 'list', names: readonly string[], example: string): boolean {
  if (current === undefined || (expected === 'list' ? Array.isArray(current) : isRecord(current))) return false;
  const text = context.exists(file) ? context.read(file) : '';
  const found = /\.ya?ml$/u.test(file) ? yamlSetting(text, path) : jsonSetting(text, path);
  const setting = path.join('.');
  const kind = expected === 'object' ? 'an object' : 'a list';
  context.warn({
    code: 'unexpected-value',
    location: found === undefined ? { file } : { file, line: found.line },
    message: `${context.name}: ${setting} in ${file}${found === undefined ? '' : ` (line ${found.line})`} is ${typeText(current)}, not ${kind}, so depcurfew apply does not write ${names.length > 0 ? listing([...names]) : `the allow-list of ${POLICY_FILE}`} into it`,
    fix: `Write ${setting} in ${file} as ${kind} such as ${example}, keeping the packages it names, then run depcurfew apply again`,
  });
  return true;
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

/**
 * A YAML list apply is about to replace with `wanted`, when depcurfew did not write it (no marker above it) and the
 * replacement drops entries from it: the entries it drops; undefined otherwise (decision D-167).
 */
export function droppedYamlList(context: Context, file: string, path: readonly string[], wanted: readonly unknown[]): unknown[] | undefined {
  if (!context.exists(file)) return undefined;
  const text = context.read(file);
  const found = yamlSetting(text, path);
  if (found === undefined || !Array.isArray(found.value) || text.split('\n')[found.line - 2]?.trim() === YAML_MARKER) return undefined;
  const old = found.value as unknown[];
  const dropped = old.filter((item) => !wanted.includes(item));
  return dropped.length > 0 ? dropped : undefined;
}

/**
 * Keeps the entries apply dropped from a YAML list as a comment above it, with the marker of the lines apply comments
 * out, so that they are not lost: `# depcurfew: superseded by the managed block: exclude: ["foo"]` (decision D-167).
 */
export function commentReplacedList(context: Context, file: string, path: readonly string[], old: readonly unknown[]): void {
  context.text(file, (body) => {
    const found = yamlSetting(body, path);
    if (found === undefined) return body;
    const lines = body.split('\n');
    let at = found.line - 1;
    if (lines[at - 1]?.trim() === YAML_MARKER) at -= 1;
    const indent = /^\s*/u.exec(lines[at] ?? '')?.[0] ?? '';
    lines.splice(at, 0, `${indent}${SUPERSEDED}${path.at(-1) ?? ''}: ${JSON.stringify(old)}`);
    return lines.join('\n');
  });
}

/** A dependency source in words for the tool's registry: "local tarball", "git". */
export function sourceLabel(context: Context, kind: SourceKind): string {
  return SOURCE_LABELS[ecosystemOfTool(context.tool)][kind];
}

/**
 * source-loosened (decision D-167): a source setting depcurfew did not write is stricter than what the policy's "allow"
 * makes apply write in its place. `current` is the setting as written, `does` what it does now, `change` what apply
 * does to it.
 */
export function sourceLoosened(context: Context, kinds: readonly SourceKind[], location: { file: string; line?: number }, current: string, does: string, change: string, fix?: string): void {
  const fields = kinds.map((kind) => `sources.${kind}`);
  const where = location.line === undefined ? '' : ` (line ${location.line})`;
  context.warn({
    code: 'source-loosened',
    location,
    message: `${context.name}: ${current} in ${location.file}${where} ${does}; because ${listing(fields)} ${kinds.length === 1 ? 'is' : 'are'} "allow" in ${POLICY_FILE}, depcurfew apply ${change}`,
    fix: fix ?? `To keep it, set ${listing(fields)} to "deny" in ${POLICY_FILE} and run depcurfew apply again`,
  });
}

/** `install.minimumReleaseAge` → table `install`, key `minimumReleaseAge`. */
export function splitDotted(setting: string): { table: string; key: string } {
  const dot = setting.indexOf('.');
  return dot === -1 ? { table: '', key: setting } : { table: setting.slice(0, dot), key: setting.slice(dot + 1) };
}

export function sameList(a: unknown, b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
