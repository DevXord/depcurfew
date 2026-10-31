// The release-age delay each tool really applies: the configured value when the version reads it, otherwise the
// default for that version from the knowledge base. Where official sources disagree on a default, the longest
// value is used, because doctor asks whether a bot could wait less than the package manager.
import { evidenceOf } from '../knowledge/facts.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf, values, yamlOptionsFor } from '../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../apply/version.ts';
import type { PackageManagerInfo } from '../detect/types.ts';
import type { ToolKnowledge, Versioned } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { delayMinutes } from './durations.ts';
import { readPythonSetting } from './python.ts';
import { iniEntries, npmrcKey, readSetting, yamlSetting, type Setting } from './settings.ts';
import type { RuleContext } from './types.ts';

export interface Delay {
  minutes: number;
  /** Where the value comes from, for messages, e.g. "minimumReleaseAge: 4320 in pnpm-workspace.yaml". */
  origin: string;
  location?: { file: string; line: number };
}

export function latestVersion(tool: ToolKnowledge): Version | undefined {
  const fact = tool.extra?.['latestVersion'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'string' ? parseVersion(value) : undefined;
}

/** The value in effect at `version` (or the latest entry when the version is unknown). */
export function versionedValue<T>(list: Versioned<T>, version: Version | undefined): T | undefined {
  let current: T | undefined;
  for (const entry of list) {
    const since = parseVersion(entry.since);
    if (version === undefined || since === undefined || compareVersions(version, since) >= 0) current = entry.value;
  }
  return current;
}

function managerConfigFiles(tool: ToolKnowledge, manager: PackageManagerInfo): string[] {
  if (tool.id === 'deno') return manager.configFiles.filter((file) => /^deno\.jsonc?$/u.test(file));
  return (values(tool.cooldown.configFiles)[0] ?? []).filter((file) => file !== '.npmrc' || tool.id === 'npm').slice(0, 1);
}

/**
 * pnpm before 11 also reads its settings from the root .npmrc, spelled in kebab case, when pnpm-workspace.yaml does not
 * set them (extra.npmrcPrecedence); pnpm 11 reads only auth and registry settings there (extra.ignoredSince).
 */
function pnpmNpmrcSetting(context: RuleContext, tool: ToolKnowledge, version: Version | undefined, setting: string): Setting | undefined {
  if (tool.id !== 'pnpm' || tool.extra?.['npmrcPrecedence'] === undefined || tool.extra['ignoredSince'] === undefined) return undefined;
  const until = parseVersion(String(extraOf(tool, 'ignoredSince', isRecord)['since']));
  const over = extraOf(tool, 'npmrcPrecedence', isRecord)['over'];
  if (until === undefined || version === undefined || compareVersions(version, until) >= 0 || !Array.isArray(over) || !over.includes('.npmrc')) return undefined;
  return readSetting(context.repository, '.npmrc', npmrcKey(setting));
}

interface NpmrcBuildSettings {
  allowAll: { key: string; off: readonly string[]; since: string };
  until: string;
  projectKeys: Versioned<readonly string[]>;
}

const isNpmrcBuildSettings = (value: unknown): value is NpmrcBuildSettings =>
  isRecord(value) && isRecord(value['allowAll']) && Array.isArray(value['allowAll']['off']) && typeof value['until'] === 'string' && Array.isArray(value['projectKeys']);

/** A line of the root .npmrc that allows every build script, with what it says. */
export interface NpmrcAllowAll {
  key: string;
  value: string;
  line: number;
  /** The values pnpm reads as off, for messages. */
  off: readonly string[];
}

/**
 * pnpm 10: the dangerously-allow-all-builds line of the root .npmrc when it is on and takes effect (extra.npmrcBuildSettings):
 * every value but those pnpm reads as off, while pnpm-workspace.yaml does not set dangerouslyAllowAllBuilds and, from
 * 10.13.0, sets no build settings at all. The "pnpm" field of package.json is not consulted, which errs towards
 * reporting. undefined for other versions and for an unknown one (the latest is assumed, which reads no such .npmrc key).
 */
export function pnpmNpmrcAllowsAllBuilds(tool: ToolKnowledge, version: Version | undefined, read: (file: string) => string | undefined): NpmrcAllowAll | undefined {
  const fact = tool.extra?.['npmrcBuildSettings'] === undefined ? undefined : extraOf(tool, 'npmrcBuildSettings', isNpmrcBuildSettings);
  const since = fact === undefined ? undefined : parseVersion(fact.allowAll.since);
  const until = fact === undefined ? undefined : parseVersion(fact.until);
  if (fact === undefined || version === undefined || since === undefined || until === undefined) return undefined;
  if (compareVersions(version, since) < 0 || compareVersions(version, until) >= 0) return undefined;
  const entry = iniEntries(read('.npmrc') ?? '').filter((item) => item.key === fact.allowAll.key).at(-1);
  if (entry === undefined || fact.allowAll.off.includes(entry.value.trim())) return undefined;
  const workspace = read('pnpm-workspace.yaml');
  const sets = (key: string) => {
    const found = workspace === undefined ? undefined : yamlSetting(workspace, [key], yamlOptionsFor('pnpm-workspace.yaml'));
    return found !== undefined && found.value !== null && found.value !== undefined;
  };
  // pnpm-workspace.yaml wins for the same key in every version; from 10.13.0 any build setting there turns the .npmrc ones off.
  const keys = versionedValue(fact.projectKeys, version) ?? [];
  if (sets(extraOf(tool, 'allowAllBuilds', isSwitch).setting) || keys.some(sets)) return undefined;
  return { key: entry.key, value: entry.value, line: entry.line, off: fact.allowAll.off };
}

/** The package manager's delay, or undefined (with a notice) when a configured value cannot be read. */
export function managerDelay(context: RuleContext, manager: PackageManagerInfo, tool: ToolKnowledge): Delay | undefined {
  const pinned = pinnedVersion(manager);
  const version = pinned ?? latestVersion(tool);
  const versionText = version === undefined ? tool.name : `${tool.name} ${formatVersion(version)}`;
  const setting = settingOf(tool.cooldown.setting);
  const since = sinceOf(tool.cooldown.availableSince);
  const supported = since === undefined || version === undefined || compareVersions(version, parseVersion(since) ?? [0, 0, 0]) >= 0;
  if (!supported) return { minutes: 0, origin: `${versionText} has no ${setting ?? 'release-age setting'}` };

  if (setting !== null) {
    let found: Setting | undefined;
    let key = setting;
    if (ecosystemOfTool(tool) === 'pypi') found = readPythonSetting(context.repository, tool, setting);
    else for (const file of managerConfigFiles(tool, manager)) found ??= readSetting(context.repository, file, setting);
    if (found === undefined) {
      found = pnpmNpmrcSetting(context, tool, version, setting);
      if (found !== undefined) key = npmrcKey(setting);
    }
    if (found !== undefined) {
      const raw = isRecord(found.value) ? found.value['age'] : found.value;
      const delay = delayMinutes(tool, raw, version);
      if (!delay.ok) {
        context.notice(`${tool.name}: cannot read ${key} in ${found.file}: ${delay.reason}`, found.file);
        return undefined;
      }
      return { minutes: delay.minutes, origin: `${key}: ${JSON.stringify(raw)} in ${found.file}`, location: { file: found.file, line: found.line } };
    }
  }

  let longest: number | undefined;
  for (const evidence of evidenceOf(tool.cooldown.default)) {
    const value = versionedValue(evidence.value, version);
    const delay = delayMinutes(tool, value, version);
    if (delay.ok && (longest === undefined || delay.minutes > longest)) longest = delay.minutes;
  }
  const minutes = longest ?? 0;
  const disputed = tool.cooldown.default.status === 'disputed' ? '; official sources disagree, the longest is assumed' : '';
  return { minutes, origin: minutes === 0 ? `${versionText} has no delay by default` : `the default of ${versionText}${disputed}` };
}
