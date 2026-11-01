// Release-age delays the user files of the installed tools already set (decision D-101): init --user keeps the
// longest one in the user policy, as init keeps the longest delay of a repository (decision D-075), so that apply
// --user does not shorten it. The files and keys are those apply --user writes, read with doctor --user's readers.
import { longestOf, type ConfiguredDelay } from '../apply/delays.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
import { userDelayMinutes } from '../doctor/durations.ts';
import { iniValue } from '../doctor/settings.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolKnowledge, UserSetting } from '../knowledge/types.ts';
import { readLimited } from '../read-limited.ts';
import { parseUserFile, readsSection, type Entry } from './doctor.ts';
import { shownPath, userFilePath, type UserEnvironment } from './locate.ts';
import { installedUserFile } from './user-file.ts';
import { findExecutable, toolVersion } from './versions.ts';

const MAX_FILE = 1024 * 1024;

/** Whether the version reads the setting from the user file; with an unknown version, whether the latest one does. */
function reads(setting: UserSetting, version: Version | undefined): boolean {
  const since = parseVersion(setting.since);
  const until = setting.until === undefined ? undefined : parseVersion(setting.until);
  if (version === undefined) return setting.until === undefined;
  return (since === undefined || compareVersions(since, version) <= 0) && (until === undefined || compareVersions(version, until) < 0);
}

/** The delay a tool's user file sets, in the file and keys apply --user writes for the installed version. */
function userDelay(tool: ToolKnowledge, environment: UserEnvironment): ConfiguredDelay | undefined {
  if (tool.user === undefined) return undefined;
  const version = toolVersion(tool, environment)?.version;
  const file = installedUserFile(tool, version, environment);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (file === null || path === undefined) return undefined;
  const read = readLimited(path, MAX_FILE);
  if (!read.ok) return undefined;
  const parsed = parseUserFile(file, read.bytes.toString('utf8'));
  // A file doctor --user cannot read is reported there and by apply --user; it holds no delay to keep.
  if (!parsed.ok) return undefined;
  const keys = (evidenceOf(tool.user.settings)[0]?.value ?? []).filter((setting) => setting.purpose === 'cooldown' && reads(setting, version)).map((setting) => setting.key);
  for (const key of keys) {
    const parts = key.split('.');
    const matching = parsed.entries.filter((entry: Entry) =>
      file.format === 'ini' ? entry.path.length === 1 && entry.path[0] === key && readsSection(file, entry) : entry.path.join('\0') === parts.join('\0'),
    );
    // npm and pnpm read the last line of a key in an INI file.
    const entry = matching.at(-1);
    if (entry?.line === undefined) continue;
    const value = file.format === 'ini' && typeof entry.value === 'string' ? iniValue(entry.value.trim()) : entry.value;
    if (typeof value === 'bigint') continue;
    const delay = userDelayMinutes(tool, value, version);
    if (!delay.ok || delay.minutes <= 0) continue;
    return { tool: tool.id, scope: '', setting: key, value, minutes: delay.minutes, location: { file: shownPath(path, environment), line: entry.line }, managed: entry.managed };
  }
  return undefined;
}

/** The delays the user files of the package managers in PATH set. */
export function userDelays(environment: UserEnvironment, tools: readonly ToolKnowledge[] = knowledgeBase): ConfiguredDelay[] {
  return tools
    .filter((tool) => tool.kind === 'package-manager' && tool.user !== undefined && findExecutable(tool.id, environment) !== undefined)
    .flatMap((tool) => {
      const delay = userDelay(tool, environment);
      return delay === undefined ? [] : [delay];
    });
}

/** The longest delay the user files set, when it is longer than `minutes` and depcurfew.json can hold it. */
export function longestUserDelay(environment: UserEnvironment, minutes: number, tools: readonly ToolKnowledge[] = knowledgeBase): ConfiguredDelay | undefined {
  return longestOf(userDelays(environment, tools), minutes);
}
