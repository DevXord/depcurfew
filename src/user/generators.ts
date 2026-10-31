// What `depcurfew apply --user` writes into each tool's user file: only settings the tool reads from that file
// (user.settings in the knowledge base), for the version in use. Parts of the policy that only a project can hold get
// a warning instead (user-setting-project-only). A key in the user file is handled as apply handles the same key in a
// project file (decision D-090): exclusion lists and build allow-lists the policy manages are superseded also when the
// policy's list is empty, install-script allow-lists are reported instead (allow-list-entry-outside-policy), and a
// longer delay that the policy shortens is reported (cooldown-shortened).
import { extraOf, isRecord, isSwitch, sinceOf } from '../apply/facts.ts';
import { BLOCK_END, blockLines, blockStart, commentedOut, insertBlock, isBlockStart, joinLines, removeBlock, splitLines, SUPERSEDED, TURNED_OFF } from '../apply/block.ts';
import { policyDuration } from '../apply/delays.ts';
import { buildAllowList, buildSwitchScopeWarning, compactDuration, forcedBuildWarning, pythonNames, tomlValue } from '../apply/generators/python.ts';
import { convertCooldown } from '../policy/convert.ts';
import { allowedNames, cooldownValue, denyList, eachSource, exclusions, sameList, scriptsDefault, type SourceKind } from '../apply/generators/common.ts';
import type { Context } from '../apply/generators/context.ts';
import { userFileFor } from './locate.ts';
import { matchesPattern } from '../doctor/allow-lists.ts';
import { delayMinutes, formatMinutes, type DelayValue } from '../doctor/durations.ts';
import { splitSpec } from '../doctor/lockfiles.ts';
import { iniEntries, iniValue, tomlSetting, yamlSetting, type IniEntry } from '../doctor/settings.ts';
import { YAML_MARKER } from '../apply/yaml-edit.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { ToolId, UserSetting, UserSettingPurpose } from '../knowledge/types.ts';
import { compareVersions, parseVersion } from '../apply/version.ts';

export interface UserTarget {
  context: Context;
  /** The user file, relative to the context's workspace root. */
  file: string;
  /** The user file as messages show it (~/.npmrc). */
  shown: string;
  /** The user policy as messages show it (~/.config/depcurfew/depcurfew.json). */
  policyFile?: string;
}

const policyOf = (target: UserTarget): string => target.policyFile ?? 'the user depcurfew.json';

type KeyLookup = { key: string } | { tooOld: UserSetting } | { none: true };

/** The user-file setting for a purpose and the version in use, the oldest one the version is too old for, or none. */
function findUserKey(context: Context, purpose: UserSettingPurpose): KeyLookup {
  const settings = context.tool.user === undefined ? [] : (evidenceOf(context.tool.user.settings)[0]?.value ?? []);
  const usable = settings.filter((setting) => setting.purpose === purpose && before(context, setting));
  const current = usable.find((setting) => context.atLeast(setting.since));
  if (current !== undefined) return { key: current.key };
  const oldest = usable[0];
  return oldest === undefined ? { none: true } : { tooOld: oldest };
}

/**
 * The user-file key for a purpose and the version in use: undefined when the tool has none or the version does not
 * read it. A version too old for every spelling is reported (version-too-old), unless `quiet`: the policy then needs
 * nothing from the key, which is only looked up so that hand-written values of it can be superseded.
 */
export function userKey(context: Context, purpose: UserSettingPurpose, quiet = false): string | undefined {
  const found = findUserKey(context, purpose);
  if ('key' in found) return found.key;
  if ('tooOld' in found && !quiet) context.supports(found.tooOld.since, found.tooOld.key);
  return undefined;
}

function before(context: Context, setting: UserSetting): boolean {
  if (setting.until === undefined || context.version === undefined) return setting.until === undefined || context.version !== undefined;
  const until = parseVersion(setting.until);
  return until === undefined || compareVersions(context.version, until) < 0;
}

function projectOnly(target: UserTarget, part: string, where: string, plural = false): void {
  target.context.warn({
    code: 'user-setting-project-only',
    location: { file: target.shown },
    message: `${target.context.name} reads ${part} only from ${where}, not from ${target.shown}, so depcurfew apply --user does not write ${plural ? 'them' : 'it'}`,
    fix: `Run depcurfew apply in each project to write ${part} there`,
  });
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** A value set by hand in the user file (outside depcurfew's block and markers), with its line. */
interface Found {
  key: string;
  value: unknown;
  line: number;
}

/** The lines of a file with depcurfew's managed blocks blanked out, so that line numbers stay. */
function outsideBlocks(text: string): string {
  let inside = false;
  return text
    .split(/\r?\n/u)
    .map((line) => {
      if (isBlockStart(line)) inside = true;
      else if (!inside) return line;
      else if (line.trim() === BLOCK_END) inside = false;
      return '';
    })
    .join('\n');
}

/** The last hand-written value of an INI key (npm and pnpm 10 read the last one). */
function iniFound(entries: readonly IniEntry[], key: string): Found | undefined {
  const entry = entries.filter((candidate) => !candidate.managed && candidate.key === key).at(-1);
  return entry === undefined ? undefined : { key, value: iniValue(entry.value), line: entry.line };
}

function tomlFound(text: string, table: string, key: string): Found | undefined {
  const found = tomlSetting(outsideBlocks(text), table, key);
  return found === undefined ? undefined : { key, value: found.value, line: found.line };
}

/** A YAML value without depcurfew's marker on the line above it. */
function yamlFound(text: string, key: string): Found | undefined {
  const found = yamlSetting(text, [key]);
  if (found === undefined || text.split(/\r?\n/u)[found.line - 2]?.trim() === YAML_MARKER) return undefined;
  return { key, value: found.value, line: found.line };
}

/**
 * cooldown-shortened: a hand-written delay longer than the one apply --user writes in its place. Line-based files
 * keep it commented out (`block`); YAML gets the policy's value instead (`replace`).
 */
function shortenedWarning(
  target: UserTarget,
  found: Found | undefined,
  written: { key: string; value: unknown; minutes: number },
  how: 'block' | 'replace',
  minutesOf: (value: unknown) => DelayValue = (value) => delayMinutes(target.context.tool, value, target.context.version),
): void {
  const { context } = target;
  const minimum = context.policy.cooldown?.minimum;
  if (found === undefined || minimum === undefined) return;
  const delay = minutesOf(found.value);
  if (!delay.ok || delay.minutes <= written.minutes) return;
  const policyFile = policyOf(target);
  const action = how === 'block' ? `comments it out and writes ${written.key}: ${JSON.stringify(written.value)} in its managed block` : `replaces it with ${JSON.stringify(written.value)}`;
  context.warn({
    code: 'cooldown-shortened',
    location: { file: target.shown, line: found.line },
    message: `${context.name}: ${found.key}: ${JSON.stringify(found.value)} in ${target.shown} (line ${found.line}) waits ${formatMinutes(delay.minutes)}, longer than cooldown.minimum "${minimum.text}" in ${policyFile}; depcurfew apply --user ${action}, so ${context.name} waits only ${formatMinutes(written.minutes)}`,
    fix: `To keep the longer delay, set cooldown.minimum to "${policyDuration(delay.minutes)}" in ${policyFile} and run depcurfew apply --user again`,
  });
}

/**
 * allow-list-entry-outside-policy: names in an install-script allow-list of the user file that the policy does not
 * allow. apply --user writes the policy's own list over it when there is one; an entry it did not write stays.
 */
function outsidePolicy(target: UserTarget, key: string, entries: readonly { name: string; line: number }[]): void {
  const { context } = target;
  if (context.policy.installScripts?.default !== 'deny') return;
  const allow = context.policy.installScripts.allow;
  const policyFile = policyOf(target);
  for (const { name, line } of entries) {
    const pkg = splitSpec(name).name;
    if (allow.some((pattern) => matchesPattern(pkg, pattern))) continue;
    context.warn({
      code: 'allow-list-entry-outside-policy',
      location: { file: target.shown, line },
      message: `${key} in ${target.shown} lets ${name} run install scripts, but ${policyFile} does not allow it; depcurfew apply --user does not remove entries it did not write`,
      fix: `Remove ${name} from ${key} in ${target.shown} by hand, or add ${pkg} to installScripts.allow in ${policyFile}`,
    });
  }
}

/** The names an INI allow-list sets by hand: `key=a,b` (npm allow-scripts) or `key[]=a` lines (pnpm 10). */
function iniListEntries(text: string, key: string): { name: string; line: number }[] {
  return iniEntries(text)
    .filter((entry) => !entry.managed && (entry.key === key || entry.key === `${key}[]`))
    .flatMap((entry) =>
      entry.value
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '' && name !== 'true')
        .map((name) => ({ name, line: entry.line })),
    );
}

const SOURCE_PURPOSES: Record<SourceKind, UserSettingPurpose> = { git: 'sourceGit', remoteTarball: 'sourceRemote', file: 'sourceFile', directory: 'sourceDirectory' };

/**
 * The dependency sources of the policy, as project mode handles them (source-not-enforceable where the tool has no
 * setting), with the user-file key: `write` gets it, and a setting the tool reads only from `where` is reported.
 */
function userSources(target: UserTarget, where: string, write: (kind: SourceKind, key: string, access: 'allow' | 'deny') => void, purposes: Partial<Record<SourceKind, UserSettingPurpose>> = SOURCE_PURPOSES): void {
  const { context } = target;
  eachSource(context, (kind, setting, access) => {
    const purpose = purposes[kind];
    const found = purpose === undefined ? ({ none: true } as const) : findUserKey(context, purpose);
    if ('key' in found) write(kind, found.key, access);
    else if ('tooOld' in found) context.supports(found.tooOld.since, found.tooOld.key);
    else projectOnly(target, setting, where);
  });
}

const isBefore = (value: unknown): value is { setting: string; exclusive: { since: string; until: string }; beforeWinsSince: string } =>
  isRecord(value) && typeof value['setting'] === 'string' && isRecord(value['exclusive']) && typeof value['beforeWinsSince'] === 'string';

/**
 * before= in ~/.npmrc (extra.beforeInteraction): from 11.15.0 it takes the place of min-release-age in the same file;
 * npm 11.10 to 11.14 stop every command when both are set, so min-release-age is not written then. Whether it may be.
 */
function beforeAllows(target: UserTarget, key: string, entries: readonly IniEntry[]): boolean {
  const { context } = target;
  const fact = extraOf(context.tool, 'beforeInteraction', isBefore);
  const date = entries.filter((entry) => entry.key === fact.setting && !entry.managed).at(-1);
  if (date === undefined || !context.atLeast(fact.exclusive.since)) return true;
  const label = `${context.name} ${context.versionLabel}`;
  const wins = context.atLeast(fact.beforeWinsSince);
  context.warn({
    code: 'before-overrides-cooldown',
    location: { file: target.shown, line: date.line },
    message: wins
      ? `${fact.setting}=${date.value} in ${target.shown} (line ${date.line}) takes the place of ${key} (${label} uses ${fact.setting} when both are set in the same file), so the release-age delay depcurfew apply --user writes has no effect`
      : `${label} stops with an error when ${fact.setting} and ${key} are both set, and ${target.shown} sets ${fact.setting}=${date.value} (line ${date.line}), so depcurfew apply --user does not write ${key}, which would make every npm command fail`,
    fix: wins ? `Remove the ${fact.setting} line from ${target.shown}, so that ${key} applies` : `Remove the ${fact.setting} line from ${target.shown}, then run depcurfew apply --user again`,
  });
  return wins;
}

/** installScripts.deny: npm, pnpm and Yarn record denials only in project files (extra.denyList). */
function denialsProjectOnly(target: UserTarget, part: string, where: string, plural = false): void {
  const { context } = target;
  const deny = denyList(context);
  if (deny === undefined || (context.policy.installScripts?.deny.length ?? 0) === 0) return;
  if (context.supports(deny.since, deny.setting)) projectOnly(target, part, where, plural);
}

/** npm and Deno: keys in a managed block at the top of ~/.npmrc; Deno reads only min-release-age, in whole days. */
function npmrc(targets: readonly UserTarget[]): void {
  const first = targets[0];
  if (first === undefined) return;
  // As the file is before this run: hand-written values are compared and checked before the block is planned.
  const entries = iniEntries(first.context.read(first.file));
  const lines: string[] = [];
  const managed: string[] = [];
  const afterWrite: (() => void)[] = [];
  const add = (key: string, written: readonly string[]) => {
    if (managed.includes(key)) return;
    managed.push(key);
    lines.push(...written);
  };
  // npm 11.10 to 11.14 fail next to before=, also when the line is written for Deno.
  const npm = targets.find((target) => target.context.tool.id === 'npm');
  const npmKey = npm?.context.policy.cooldown === undefined ? undefined : userKey(npm.context, 'cooldown', true);
  const blocked = npm !== undefined && npmKey !== undefined && !beforeAllows(npm, npmKey, entries) ? npmKey : undefined;
  for (const target of targets) {
    const { context } = target;
    const { policy } = context;
    if (policy.cooldown !== undefined) {
      const key = userKey(context, 'cooldown');
      if (key !== undefined && key !== blocked) {
        const deno = context.tool.id === 'deno';
        let value: { value: number | string; minutes: number } | undefined;
        if (deno) {
          const days = Math.ceil(policy.cooldown.minimum.minutes / 1440);
          value = { value: days, minutes: days * 1440 };
        } else {
          value = cooldownValue(context);
        }
        if (value !== undefined) {
          add(key, [`${key}=${value.value}`]);
          // Deno reads min-release-age in .npmrc as whole days, not in the unit of its own setting.
          const days = (old: unknown): DelayValue => (typeof old === 'number' && Number.isInteger(old) ? { ok: true, minutes: old * 1440 } : { ok: false, reason: 'not whole days' });
          shortenedWarning(target, iniFound(entries, key), { key, value: value.value, minutes: value.minutes }, 'block', deno ? days : undefined);
        }
      }
      const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
      const patterns = excludeKey === undefined ? undefined : exclusions(context);
      if (excludeKey !== undefined && patterns !== undefined) {
        const suffix = extraOf(context.tool, 'npmrcListSyntax', isString);
        add(excludeKey, patterns.map((pattern) => `${excludeKey}${suffix}=${pattern}`));
      }
    }
    if (context.tool.id !== 'npm') {
      eachSource(context, () => undefined);
      continue;
    }
    if (policy.installScripts?.default === 'deny') {
      const defaults = scriptsDefault(context).value;
      if (defaults === 'run-with-warning') {
        const strict = userKey(context, 'scriptsStrict');
        if (strict !== undefined) add(strict, [`${strict}=true`]);
      } else if (defaults === 'run') {
        context.warn({
          code: 'scripts-not-enforceable',
          message: `${context.name} ${context.versionLabel} runs every dependency install script and has no allow-list, so "deny" cannot be enforced`,
          fix: `Update npm to ${sinceOf(context.tool.installScripts.allowList.availableSince) ?? 'a newer version'} or later (npm 12 blocks dependency scripts by default), then run depcurfew apply --user again`,
        });
      }
      const allow = policy.installScripts.allow;
      const allowKey = userKey(context, 'scriptsAllow', allow.length === 0);
      const names = allowKey === undefined || allow.length === 0 ? [] : allowedNames(context, allowKey);
      if (allowKey !== undefined && names.length > 0) add(allowKey, [`${allowKey}=${names.join(',')}`]);
      else if (allowKey !== undefined) afterWrite.push(() => outsidePolicy(target, allowKey, iniListEntries(context.read(target.file), allowKey)));
      denialsProjectOnly(target, 'the denials of installScripts.deny (allowScripts entries set to false)', 'the root package.json of each project', true);
      // As in a project .npmrc: the switch that runs every script is superseded, whatever value it has.
      const allowAll = extraOf(context.tool, 'allowAllScripts', isSwitch);
      if (context.atLeast(allowAll.since) && !managed.includes(allowAll.setting)) managed.push(allowAll.setting);
    }
    userSources(target, '.npmrc', (_kind, key, access) => add(key, [`${key}=${access === 'deny' ? 'none' : 'all'}`]));
  }
  // Keys this run does not write but an earlier one may have: the block is replaced as a whole.
  first.context.ini(first.file, lines, managed);
  for (const check of afterWrite) check();
}

interface ScriptsSwitch {
  setting: string;
  allow: unknown;
  deny: unknown;
}
const isScriptsSwitch = (value: unknown): value is ScriptsSwitch => isRecord(value) && typeof value['setting'] === 'string' && 'allow' in value && 'deny' in value;

interface AllowAllSwitch {
  setting: string;
  since: string;
  off: readonly unknown[];
}
const isAllowAllSwitch = (value: unknown): value is AllowAllSwitch =>
  isRecord(value) && typeof value['setting'] === 'string' && typeof value['since'] === 'string' && Array.isArray(value['off']);
interface NpmrcBuildSettings {
  allowAll: { key: string; since: string };
}
const isNpmrcBuildSettings = (value: unknown): value is NpmrcBuildSettings =>
  isRecord(value) && isRecord(value['allowAll']) && typeof value['allowAll']['key'] === 'string' && typeof value['allowAll']['since'] === 'string';

/**
 * pnpm: the switch that runs every build (extra.allowAllBuilds, in rc extra.npmrcBuildSettings), as apply turns it off
 * in a project: rc keeps the line commented out; config.yaml gets false where a value pnpm reads as on stands.
 */
function allowAllOff(target: UserTarget, yaml: boolean, text: string, values: [string, unknown][], managed: string[]): void {
  const { context } = target;
  if (!yaml) {
    const settings = context.tool.extra?.['npmrcBuildSettings'] === undefined ? undefined : extraOf(context.tool, 'npmrcBuildSettings', isNpmrcBuildSettings);
    if (settings !== undefined && context.atLeast(settings.allowAll.since)) managed.push(settings.allowAll.key);
    return;
  }
  const allowAll = extraOf(context.tool, 'allowAllBuilds', isAllowAllSwitch);
  if (!context.atLeast(allowAll.since)) return;
  const found = yamlFound(text, allowAll.setting);
  if (found === undefined || allowAll.off.some((off) => off === found.value)) return;
  values.push([allowAll.setting, false]);
  context.warn({
    code: 'allow-all-replaced',
    location: { file: target.shown, line: found.line },
    message: `${allowAll.setting}: ${JSON.stringify(found.value)} in ${target.shown} (line ${found.line}) ran every dependency build script in every project that does not set it itself; depcurfew apply --user sets it to false, because the user policy denies install scripts`,
    fix: `Allow the packages that need their build scripts under installScripts.allow in ${target.policyFile} instead`,
  });
}

/** pnpm: <configDir>/rc (INI, pnpm 10) or <configDir>/config.yaml (pnpm 11 and later); allowBuilds is project-only. */
function pnpm([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const yaml = target.file.endsWith('.yaml');
  const text = context.read(target.file);
  const entries = yaml ? [] : iniEntries(text);
  const found = (key: string) => (yaml ? yamlFound(text, key) : iniFound(entries, key));
  const values: [string, unknown][] = [];
  // INI keys superseded without a value of their own.
  const managed: string[] = [];
  let allowListKey: string | undefined;
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      values.push([key, value.value]);
      shortenedWarning(target, found(key), { key, value: value.value, minutes: value.minutes }, yaml ? 'replace' : 'block');
      const exact = extraOf(context.tool, 'cooldownExactVersions', isString);
      if (!context.atLeast(exact)) {
        context.warn({
          code: 'exact-version-gap',
          message: `${context.name} ${context.versionLabel} skips ${key} for packages requested by exact version`,
          fix: `Update pnpm to ${exact} or later, then run depcurfew apply --user again`,
        });
      }
    }
    const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      if (!yaml) {
        if (patterns.length > 0) values.push([excludeKey, patterns]);
        else managed.push(excludeKey);
      } else {
        // As in pnpm-workspace.yaml: a list in the file gets the policy's, also when that is empty.
        const current = yamlSetting(text, [excludeKey])?.value;
        if ((patterns.length > 0 || current !== undefined) && !sameList(current, patterns)) values.push([excludeKey, patterns]);
      }
    }
    const strict = userKey(context, 'cooldownStrict', true);
    if (strict !== undefined) values.push([strict, true]);
  }
  if (policy.installScripts?.default === 'deny') {
    // pnpm 10 and later block dependency builds by default, so strict mode (unreviewed builds fail the install) is not
    // needed for "deny"; before 10, every script runs and the user file has no allow-list.
    const defaults = scriptsDefault(context);
    if (defaults.value === 'run') {
      context.warn({
        code: 'scripts-not-enforceable',
        message: `${context.name} ${context.versionLabel} runs every dependency install script and reads no allow-list from ${target.shown}, so "deny" cannot be enforced there`,
        fix: `Update pnpm to ${defaults.changesIn ?? 'a newer version'} or later, which blocks dependency install scripts by default, then run depcurfew apply --user again; until then, run depcurfew apply in each project`,
      });
    }
    const strict = userKey(context, 'scriptsStrict', true);
    if (strict !== undefined) values.push([strict, true]);
    const allow = policy.installScripts.allow;
    const allowKey = findUserKey(context, 'buildsAllow');
    if ('key' in allowKey) {
      const names = allow.length === 0 ? [] : allowedNames(context, allowKey.key);
      if (names.length > 0) values.push([allowKey.key, names]);
      else allowListKey = allowKey.key;
    } else if (allow.length > 0) {
      if ('tooOld' in allowKey) context.supports(allowKey.tooOld.since, allowKey.tooOld.key);
      else projectOnly(target, 'allowBuilds', 'pnpm-workspace.yaml');
    }
    denialsProjectOnly(target, 'allowBuilds', 'pnpm-workspace.yaml');
    allowAllOff(target, yaml, text, values, managed);
  }
  // git and remote tarballs share one setting, which covers only indirect dependencies.
  let exotic: string | undefined;
  const access = new Map<SourceKind, 'allow' | 'deny'>();
  userSources(
    target,
    'pnpm-workspace.yaml',
    (kind, key, value) => {
      exotic = key;
      access.set(kind, value);
    },
    { git: 'sourcesExotic', remoteTarball: 'sourcesExotic' },
  );
  const denied = [...access].filter(([, value]) => value === 'deny').map(([kind]) => (kind === 'git' ? 'git' : 'remote tarball'));
  if (exotic !== undefined && denied.length > 0) {
    values.push([exotic, true]);
    context.warn({
      code: 'source-switch-indirect-only',
      message: `pnpm: ${exotic} stops git and tarball sources only for indirect dependencies; direct ones stay allowed`,
      fix: 'Run depcurfew doctor in each project, which reports direct ones in pnpm-lock.yaml',
    });
    if (denied.length < access.size) {
      context.warn({
        code: 'source-switch-combined',
        message: `pnpm: ${exotic} covers git and tarball dependencies together; set to true because the policy denies ${denied.join(' and ')}`,
        fix: `pnpm cannot deny one and allow the other: give sources.git and sources.remoteTarball the same value in ${policyOf(target)}, so that the policy says what pnpm does`,
      });
    }
  }
  if (yaml) {
    if (values.length > 0) context.yaml(target.file).setMany(values.map(([key, value]) => [[key], value] as const));
    return;
  }
  const lines = values.flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => `${key}[]=${String(item)}`) : [`${key}=${String(value)}`]));
  context.ini(target.file, lines, [...values.map(([key]) => key), ...managed]);
  if (allowListKey !== undefined) outsidePolicy(target, allowListKey, iniListEntries(context.read(target.file), allowListKey));
}

interface ClassicUserFile {
  until: string;
  file: string;
}
const isClassic = (value: unknown): value is ClassicUserFile => isRecord(value) && typeof value['until'] === 'string' && typeof value['file'] === 'string';

/** Yarn: ~/.yarnrc.yml with the same keys as a project; dependenciesMeta lives in the root package.json only. */
function yarn([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const classic = extraOf(context.tool, 'classicUserFile', isClassic);
  if (context.version !== undefined && !context.atLeast(classic.until)) {
    const since = sinceOf(context.tool.cooldown.availableSince);
    context.warn({
      code: 'tool-not-supported',
      location: { file: target.shown },
      message: `Yarn Classic ${context.versionLabel} reads ${classic.file}, not ${target.shown}, and is not supported; nothing written for it`,
      fix: `Move to ${context.name}${since === undefined ? '' : ` ${since} or later`}, or to another package manager depcurfew configures`,
    });
    return;
  }
  const text = context.read(target.file);
  const yaml = context.yaml(target.file);
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      shortenedWarning(target, yamlFound(text, key), { key, value: value.value, minutes: value.minutes }, 'replace');
      yaml.set([key], value.value);
    }
    const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      // As in a project .yarnrc.yml: a list in the file gets the policy's, also when that is empty.
      const current = yaml.get([excludeKey]);
      if ((patterns.length > 0 || current !== undefined) && !sameList(current, patterns)) yaml.set([excludeKey], patterns);
    }
  }
  if (policy.installScripts !== undefined) {
    const scripts = extraOf(context.tool, 'scriptsSwitch', isScriptsSwitch);
    const key = userKey(context, 'buildsDeny');
    if (key !== undefined) yaml.set([key], policy.installScripts.default === 'deny' ? scripts.deny : scripts.allow);
    if (policy.installScripts.default === 'deny' && policy.installScripts.allow.length > 0) projectOnly(target, 'dependenciesMeta', 'the root package.json of each project');
    if (policy.installScripts.default === 'deny') denialsProjectOnly(target, 'dependenciesMeta', 'the root package.json of each project');
  }
  userSources(target, '.yarnrc.yml', (_kind, key, access) => {
    const value = access === 'deny' ? [] : ['**'];
    if (!sameList(yaml.get([key]), value)) yaml.set([key], value);
  });
}

/** Bun: [install] keys in a managed block in .bunfig.toml; trustedDependencies is project-only. */
function bun([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const text = context.read(target.file);
  const entries: string[] = [];
  const managed: string[] = [];
  let table = 'install';
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      const split = splitKey(key);
      table = split.table;
      entries.push(`${split.key} = ${String(value.value)}`);
      managed.push(split.key);
      shortenedWarning(target, tomlFound(text, split.table, split.key), { key: split.key, value: value.value, minutes: value.minutes }, 'block');
    }
    const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      const split = splitKey(excludeKey);
      managed.push(split.key);
      if (patterns.length > 0) entries.push(`${split.key} = ${tomlValue(patterns)}`);
    }
  }
  if (policy.installScripts?.default === 'deny' && policy.installScripts.allow.length > 0) projectOnly(target, 'trustedDependencies', 'the package.json of each project');
  if (policy.installScripts?.default === 'allow') {
    context.warn({
      code: 'allow-all-unsupported',
      message: `${context.name} has no setting that allows every install script; "allow" not written`,
      fix: 'List the packages under installScripts.allow instead',
    });
  }
  eachSource(context, () => undefined);
  context.toml(target.file, table, entries, managed);
}

function splitKey(key: string): { table: string; key: string } {
  const at = key.lastIndexOf('.');
  return at < 0 ? { table: '', key } : { table: key.slice(0, at), key: key.slice(at + 1) };
}

interface PipTable {
  table: string;
  keys: Record<string, string>;
}
const isPipTable = (value: unknown): value is PipTable => isRecord(value) && typeof value['table'] === 'string' && isRecord(value['keys']);

/**
 * uv: top-level keys of uv.toml in a managed block; the build allow-list forces those packages to be built. The same
 * keys in the [pip] table win over them for uv pip (extra.pipTable), so those are commented out.
 */
function uv([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const text = context.read(target.file);
  const entries: string[] = [];
  const managed: string[] = [];
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      entries.push(`${key} = ${tomlValue(value.value)}`);
      managed.push(key);
      shortenedWarning(target, tomlFound(text, '', key), { key, value: value.value, minutes: value.minutes }, 'block');
    }
    const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      managed.push(excludeKey);
      const exempt = extraOf(context.tool, 'excludeValue', (value): value is boolean => typeof value === 'boolean');
      const names = pythonNames(patterns);
      if (names.length > 0) entries.push(`${excludeKey} = { ${names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`).join(', ')} }`);
    }
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) {
      const build = extraOf(context.tool, 'buildSwitch', isSwitch);
      entries.push(`${deny} = ${tomlValue(build.value)}`);
      managed.push(deny);
      const allow = policy.installScripts.allow;
      const allowKey = userKey(context, 'buildsAllow', allow.length === 0);
      if (allowKey !== undefined) {
        managed.push(allowKey);
        const names = allow.length > 0 ? buildAllowList(context, allowKey) : [];
        if (names.length > 0) entries.push(`${allowKey} = ${tomlValue(names)}`);
        forcedBuildWarning(context, allowKey, names, policyOf(target));
      }
    }
  }
  eachSource(context, () => undefined);
  context.toml(target.file, '', entries, managed);
  const pip = extraOf(context.tool, 'pipTable', isPipTable);
  const pipManaged = managed.map((key) => pip.keys[key]).filter(isString);
  // Also without managed keys, so that lines commented out by an earlier run come back.
  context.toml(target.file, pip.table, [], pipManaged, pip.table);
}

interface PipSections {
  global: string;
  commandsOverride: boolean;
}
const isPipSections = (value: unknown): value is PipSections => isRecord(value) && typeof value['global'] === 'string' && typeof value['commandsOverride'] === 'boolean';

const SECTION = /^\s*\[([^\]]*)\]\s*$/u;
const keyOfLine = (line: string): string | undefined => /^\s*([^#;=\s][^=:]*?)\s*[=:]/u.exec(line)?.[1]?.trim().toLowerCase();

/**
 * A managed block in an INI section (pip reads [global] for every command). The managed keys are commented out in
 * that section and, when `overriding`, in every other section (pip's command sections win over [global]); lines
 * commented out so come back once their key is no longer managed. An existing block stays where it is in its section.
 */
export function writeSectionBlock(
  body: string,
  section: string,
  entries: readonly string[],
  managedKeys: readonly string[],
  options: { overriding?: boolean; marker?: string; underscoresAsDashes?: boolean } = {},
): string {
  // pip reads only_binary as only-binary: a hand-written spelling with underscores is the same key (UserFile.underscoresAsDashes).
  const keyOf = (line: string): string | undefined => (options.underscoresAsDashes === true ? keyOfLine(line)?.replaceAll('_', '-') : keyOfLine(line));
  const managed = new Set(managedKeys.map((key) => (options.underscoresAsDashes === true ? key.replaceAll('_', '-') : key)));
  const marker = options.marker ?? blockStart();
  const removed = removeBlock(splitLines(body), marker);
  const name = section.toLowerCase();
  let current: string | undefined;
  // The section of each line after the edit, for placing the block.
  const sections: (string | undefined)[] = [];
  const lines = removed.lines.map((line, index) => {
    const header = SECTION.exec(line);
    if (header !== null) current = header[1]?.trim().toLowerCase();
    sections[index] = current;
    if (current === undefined || header !== null || (current !== name && options.overriding !== true)) return line;
    const original = commentedOut(line);
    if (original !== undefined) return managed.has(keyOf(original) ?? '') ? line : original;
    const key = keyOf(line);
    return key !== undefined && managed.has(key) ? `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(lines);
  const at = removed.at;
  if (at !== undefined && at > 0 && sections[at - 1] === name) return joinLines(insertBlock(lines, at, entries, removed.separated, marker));
  const header = lines.findIndex((line) => SECTION.exec(line)?.[1]?.trim().toLowerCase() === name);
  if (header === -1) {
    const trimmed = lines.length > 0 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return joinLines([...trimmed, ...(trimmed.length > 0 ? [''] : []), `[${section}]`, ...blockLines(entries, marker)]);
  }
  return joinLines([...lines.slice(0, header + 1), ...blockLines(entries, marker), ...lines.slice(header + 1)]);
}

/** The hand-written value of a pip.conf key that pip install uses: [install] wins over [global]. */
function pipFound(text: string, key: string, sections: PipSections): Found | undefined {
  // pip reads only_binary as only-binary (UserFile.underscoresAsDashes in the pip knowledge).
  const same = (candidate: string | undefined) => candidate?.replaceAll('_', '-') === key.replaceAll('_', '-');
  let current: string | undefined;
  const found = new Map<string, Found>();
  outsideBlocks(text)
    .split('\n')
    .forEach((line, index) => {
      const header = SECTION.exec(line);
      if (header !== null) {
        current = header[1]?.trim().toLowerCase();
        return;
      }
      const equals = line.search(/[=:]/u);
      if (current === undefined || !same(keyOfLine(line)) || equals === -1) return;
      found.set(current, { key, value: line.slice(equals + 1).trim(), line: index + 1 });
    });
  return (sections.commandsOverride ? found.get('install') : undefined) ?? found.get(sections.global);
}

/** pip: [global] of the user pip.conf: uploaded-prior-to as PnD, only-binary and the build allow-list. */
function pip([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const sections = extraOf(context.tool, 'configSections', isPipSections);
  const entries: string[] = [];
  const managed: string[] = [];
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const result = convertCooldown(context.tool, policy.cooldown.minimum);
    if (key !== undefined && result.ok) {
      const value = `P${String(result.value)}D`;
      entries.push(`${key} = ${value}`);
      managed.push(key);
      shortenedWarning(target, pipFound(context.read(target.file), key, sections), { key, value, minutes: Number(result.value) * 1440 }, 'block');
    }
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) {
      entries.push(`${deny} = :all:`);
      managed.push(deny);
      buildSwitchScopeWarning(context, deny, extraOf(context.tool, 'buildSwitch', isSwitch).covers);
      const allow = policy.installScripts.allow;
      const allowKey = userKey(context, 'buildsAllow', allow.length === 0);
      if (allowKey !== undefined) {
        managed.push(allowKey);
        const names = allow.length > 0 ? buildAllowList(context, allowKey) : [];
        if (names.length > 0) entries.push(`${allowKey} = ${names.join(',')}`);
        forcedBuildWarning(context, allowKey, names, policyOf(target));
      }
    }
  }
  eachSource(context, () => undefined);
  const marker = blockStart(undefined, context.user ? 'user' : 'project');
  const underscoresAsDashes = userFileFor(context.tool, context.version)?.underscoresAsDashes === true;
  context.workspace.edit(target.file, (body) => writeSectionBlock(body, sections.global, entries, managed, { overriding: sections.commandsOverride, marker, underscoresAsDashes }));
}

/** Poetry: config.toml with the keys of poetry.toml ([solver] and [installer] tables). */
function poetry([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const text = context.read(target.file);
  const tables = new Map<string, { entries: string[]; managed: string[] }>();
  const tableOf = (name: string) => {
    const entry = tables.get(name) ?? { entries: [], managed: [] };
    tables.set(name, entry);
    return entry;
  };
  const manage = (dotted: string, value?: unknown) => {
    const { table, key } = splitKey(dotted);
    const entry = tableOf(table);
    entry.managed.push(key);
    if (value !== undefined) entry.entries.push(`${key} = ${tomlValue(value)}`);
  };
  // Both tables are written on every run, so that lines commented out by an earlier run come back.
  for (const purpose of ['cooldown', 'buildsDeny'] as const) {
    const key = userKey(context, purpose, true);
    if (key !== undefined) tableOf(splitKey(key).table);
  }
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      manage(key, value.value);
      const { table, key: name } = splitKey(key);
      shortenedWarning(target, tomlFound(text, table, name), { key: name, value: value.value, minutes: value.minutes }, 'block');
    }
    const excludeKey = userKey(context, 'cooldownExclude', policy.cooldown.exclude.length === 0);
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    // Written as a TOML array, as poetry.toml (extra.excludeFormat).
    if (excludeKey !== undefined && patterns !== undefined) manage(excludeKey, patterns.length > 0 ? pythonNames(patterns) : undefined);
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) {
      const build = extraOf(context.tool, 'buildSwitch', isSwitch);
      manage(deny, build.value);
      buildSwitchScopeWarning(context, deny, build.covers);
      const allow = policy.installScripts.allow;
      const allowKey = userKey(context, 'buildsAllow', allow.length === 0);
      if (allowKey !== undefined) {
        const names = allow.length === 0 ? [] : buildAllowList(context, allowKey);
        manage(allowKey, names.length > 0 ? names : undefined);
        forcedBuildWarning(context, allowKey, names, policyOf(target));
      }
    }
  }
  eachSource(context, () => undefined);
  for (const [table, entry] of tables) context.toml(target.file, table, entry.entries, entry.managed, table);
}

/** PDM: strategy.exclude-newer in the global config.toml; build settings exist only in pyproject.toml. */
function pdm([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const key = userKey(context, 'cooldown', policy.cooldown === undefined);
  if (key !== undefined) {
    const { table, key: name } = splitKey(key);
    const value = policy.cooldown === undefined ? undefined : cooldownValue(context);
    const text = value === undefined ? undefined : typeof value.value === 'string' ? compactDuration(value.value) : `${String(value.value)}d`;
    if (value !== undefined && text !== undefined) shortenedWarning(target, tomlFound(context.read(target.file), table, name), { key: name, value: text, minutes: value.minutes }, 'block');
    // Also without a value, so that a line commented out by an earlier run comes back.
    context.toml(target.file, table, text === undefined ? [] : [`${name} = ${JSON.stringify(text)}`], text === undefined ? [] : [name], table);
  }
  if (policy.installScripts?.default === 'deny') projectOnly(target, 'only-binary and no-binary', 'pyproject.toml', true);
  eachSource(context, () => undefined);
}

/** Tools with a user file that depcurfew writes; tools sharing one file (npm and Deno) are written together. */
export const USER_GENERATORS: Partial<Record<ToolId, (targets: readonly UserTarget[]) => void>> = {
  npm: npmrc,
  deno: npmrc,
  pnpm,
  yarn,
  bun,
  uv,
  pip,
  poetry,
  pdm,
};

/** A tool's policy parts its user file cannot hold, reported once per tool. */
export function reportProjectOnly(target: UserTarget): void {
  const { context } = target;
  const allow = context.policy.installScripts?.allow ?? [];
  if (context.tool.id === 'deno' && allow.length > 0) projectOnly(target, 'allowScripts', 'deno.json');
  if (context.tool.id === 'deno' && (context.policy.cooldown?.exclude.length ?? 0) > 0) projectOnly(target, 'the release-age exceptions', 'deno.json', true);
}
