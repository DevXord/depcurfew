// The release-age delay each tool really applies: the configured value when the version reads it, otherwise the
// default for that version from the knowledge base. Where official sources disagree on a default, the longest
// value is used, because doctor asks whether a bot could wait less than the package manager.
import { evidenceOf } from '../knowledge/facts.ts';
import { isRecord, settingOf, sinceOf, values } from '../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../apply/version.ts';
import type { PackageManagerInfo } from '../detect/types.ts';
import type { ToolKnowledge, Versioned } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { delayMinutes } from './durations.ts';
import { readPythonSetting } from './python.ts';
import { readSetting, type Setting } from './settings.ts';
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
    if (ecosystemOfTool(tool) === 'pypi') found = readPythonSetting(context.repository, tool, setting);
    else for (const file of managerConfigFiles(tool, manager)) found ??= readSetting(context.repository, file, setting);
    if (found !== undefined) {
      const raw = isRecord(found.value) ? found.value['age'] : found.value;
      const delay = delayMinutes(tool, raw, version);
      if (!delay.ok) {
        context.notice(`${tool.name}: cannot read ${setting} in ${found.file}: ${delay.reason}`, found.file);
        return undefined;
      }
      return { minutes: delay.minutes, origin: `${setting}: ${JSON.stringify(raw)} in ${found.file}`, location: { file: found.file, line: found.line } };
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
