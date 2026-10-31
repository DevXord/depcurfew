// Release-age delays a repository already configures, read with doctor's readers: init keeps the longest one in the
// policy, and apply warns when it replaces a longer delay someone set by hand with the policy's shorter one
// (decision D-075). Only values apply would replace count: the file each tool reads first, at the root.
import { delayMinutes, formatMinutes } from '../doctor/durations.ts';
import { latestVersion } from '../doctor/effective.ts';
import { readPythonSetting } from '../doctor/python.ts';
import { jsonSetting, readSetting, yamlKeyLine, yamlSetting, type Setting } from '../doctor/settings.ts';
import { Repository } from '../detect/repository.ts';
import type { Detection, PackageManagerInfo } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { BLOCK_END, isBlockStart } from './block.ts';
import { extraOf, isRecord, settingOf, values } from './facts.ts';
import { compareVersions, parseVersion, pinnedVersion, type Version } from './version.ts';
import type { ApplyWarning } from './warnings.ts';
import type { FileChange } from './workspace.ts';
import { YAML_MARKER } from './yaml-edit.ts';

export interface ConfiguredDelay {
  tool: ToolId;
  /** Which value of the tool: '' for one per tool, the updates entry (updates[2]) for Dependabot. */
  scope: string;
  /** What the value covers, for messages, e.g. "pip updates". */
  label?: string;
  /** The setting as the file names it, e.g. min-release-age or default-days. */
  setting: string;
  /** The value as written. */
  value: unknown;
  minutes: number;
  location: { file: string; line: number };
  /** Written by depcurfew: inside its managed block or under its YAML marker. */
  managed: boolean;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNpmrcKey = (value: unknown): value is { key: string; until: string } => isRecord(value) && isString(value['key']) && isString(value['until']);
const isCooldownKeys = (value: unknown): value is { days: string } => isRecord(value) && isString(value['days']);
const isPackageJsonConfig = (value: unknown): value is { file: string; key: string } => isRecord(value) && isString(value['file']) && isString(value['key']);

function lines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/** Whether a line of an INI or TOML file lies inside depcurfew's managed block. */
function insideBlock(text: string, line: number): boolean {
  let inside = false;
  for (const [index, current] of lines(text).entries()) {
    if (index >= line - 1) break;
    if (isBlockStart(current)) inside = true;
    else if (current.trim() === BLOCK_END) inside = false;
  }
  return inside;
}

/** Whether a YAML key, or a map it sits in, carries depcurfew's marker on the line above. */
/** Whether a key on `path` has depcurfew's marker above it; `all` are the lines of `text`. */
function markedInYaml(text: string, path: readonly string[], all: readonly string[] = lines(text)): boolean {
  for (let length = 1; length <= path.length; length++) {
    if (/^\d+$/u.test(path[length - 1] ?? '')) continue;
    const line = yamlKeyLine(text, path.slice(0, length));
    if (line !== undefined && all[line - 2]?.trim() === YAML_MARKER) return true;
  }
  return false;
}

function managed(text: string | undefined, file: string, path: readonly string[], line: number): boolean {
  if (text === undefined) return false;
  const name = file.split('/').at(-1) ?? file;
  if (/\.ya?ml$/u.test(name)) return markedInYaml(text, path);
  // JSON has no markers: a value there counts as written by hand.
  if (/\.jsonc?$/u.test(name)) return false;
  return insideBlock(text, line);
}

function atLeast(version: Version | undefined, since: string): boolean {
  const required = parseVersion(since);
  return version === undefined || required === undefined || compareVersions(version, required) >= 0;
}

/** The files and settings a package manager reads its delay from at the root, the one it reads first first. */
function managerSources(repository: Repository, manager: PackageManagerInfo, tool: ToolKnowledge, version: Version | undefined): { file: string; setting: string }[] {
  const setting = settingOf(tool.cooldown.setting);
  if (setting === null) return [];
  if (tool.id === 'deno') {
    // deno.json or deno.jsonc, as the generator picks it.
    const manifests = tool.project === undefined ? [] : (values(tool.project.manifests)[0] ?? []);
    const file = manifests.find((name) => repository.isFile(name));
    return file === undefined ? [] : [{ file, setting }];
  }
  const own = (values(tool.cooldown.configFiles)[0] ?? []).filter((file) => file !== '.npmrc' || tool.id === 'npm').slice(0, 1);
  const sources = own.map((file) => ({ file, setting }));
  // pnpm 10 also reads the delay from .npmrc, after pnpm-workspace.yaml.
  const npmrc = tool.extra?.['npmrcCooldownKey'] === undefined ? undefined : extraOf(tool, 'npmrcCooldownKey', isNpmrcKey);
  if (npmrc !== undefined && !atLeast(version, npmrc.until)) sources.push({ file: '.npmrc', setting: npmrc.key });
  return sources;
}

function managerDelay(repository: Repository, manager: PackageManagerInfo, tool: ToolKnowledge): ConfiguredDelay | undefined {
  const version = pinnedVersion(manager) ?? latestVersion(tool);
  let found: (Setting & { setting: string }) | undefined;
  if (ecosystemOfTool(tool) === 'pypi') {
    const setting = settingOf(tool.cooldown.setting);
    const python = setting === null ? undefined : readPythonSetting(repository, tool, setting);
    if (python !== undefined && setting !== null) found = { ...python, setting };
  } else {
    for (const source of managerSources(repository, manager, tool, version)) {
      const setting = readSetting(repository, source.file, source.setting);
      if (setting !== undefined) {
        found = { ...setting, setting: source.setting };
        break;
      }
    }
  }
  if (found === undefined) return undefined;
  const ageKey = tool.extra?.['ageObjectKey'] === undefined ? undefined : extraOf(tool, 'ageObjectKey', isString);
  const value = isRecord(found.value) && ageKey !== undefined ? found.value[ageKey] : found.value;
  // A TOML integer beyond the safe range is no delay any tool reads.
  if (typeof value === 'bigint') return undefined;
  const delay = delayMinutes(tool, value, version);
  if (!delay.ok || delay.minutes <= 0) return undefined;
  const path = found.setting.split('.');
  return {
    tool: tool.id,
    scope: '',
    setting: found.setting,
    value,
    minutes: delay.minutes,
    location: { file: found.file, line: found.line },
    managed: managed(repository.readText(found.file), found.file, path, found.line),
  };
}

function dependabotDelays(repository: Repository, bot: ToolKnowledge, file: string): ConfiguredDelay[] {
  const text = repository.readText(file);
  if (text === undefined) return [];
  const updates = yamlSetting(text, ['updates']);
  if (updates === undefined || !Array.isArray(updates.value)) return [];
  const keys = extraOf(bot, 'cooldownKeys', isCooldownKeys);
  const ecosystems = Object.keys(extraOf(bot, 'ecosystems', isRecord));
  const setting = settingOf(bot.cooldown.setting) ?? 'cooldown';
  const all = lines(text);
  return (updates.value as unknown[]).flatMap((entry, index): ConfiguredDelay[] => {
    if (!isRecord(entry) || !ecosystems.includes(String(entry['package-ecosystem']))) return [];
    const cooldown = entry[setting];
    const days = isRecord(cooldown) ? cooldown[keys.days] : undefined;
    if (typeof days !== 'number' || days <= 0) return [];
    const path = ['updates', String(index), setting, keys.days];
    const line = yamlSetting(text, path)?.line ?? updates.line;
    return [
      {
        tool: bot.id,
        scope: `updates[${index}]`,
        label: `${String(entry['package-ecosystem'])} updates`,
        setting: keys.days,
        value: days,
        minutes: days * 1440,
        location: { file, line },
        managed: markedInYaml(text, path, all),
      },
    ];
  });
}

function renovateDelay(repository: Repository, bot: ToolKnowledge, file: string): ConfiguredDelay | undefined {
  // JSON5 is not read, as in doctor; the deprecated package.json configuration sits under its own key.
  if (!/\.jsonc?$/u.test(file) && !file.endsWith('.renovaterc')) return undefined;
  const packageJson = extraOf(bot, 'packageJsonConfig', isPackageJsonConfig);
  const setting = settingOf(bot.cooldown.setting) ?? 'minimumReleaseAge';
  const path = file === packageJson.file ? [packageJson.key, setting] : [setting];
  const text = repository.readText(file);
  const found = text === undefined ? undefined : jsonSetting(text, path);
  if (found === undefined) return undefined;
  const delay = delayMinutes(bot, found.value, latestVersion(bot));
  if (!delay.ok || delay.minutes <= 0) return undefined;
  return { tool: bot.id, scope: '', setting, value: found.value, minutes: delay.minutes, location: { file, line: found.line }, managed: false };
}

/** What `read` finds, or nothing when a file cannot be read: the edit of that file reports it (cannot-edit). */
function readable<T>(read: () => T, none: T): T {
  try {
    return read();
  } catch {
    return none;
  }
}

/** The delays the repository configures for the detected tools (only those in `only`, when given). */
export function configuredDelays(repository: Repository, detection: Detection, tools: readonly ToolKnowledge[], only?: ReadonlySet<ToolId>): ConfiguredDelay[] {
  const delays: ConfiguredDelay[] = [];
  for (const manager of detection.packageManagers) {
    const tool = tools.find((entry) => entry.id === manager.id);
    if (!manager.supported || tool === undefined || (only !== undefined && !only.has(tool.id))) continue;
    const delay = readable(() => managerDelay(repository, manager, tool), undefined);
    if (delay !== undefined) delays.push(delay);
  }
  for (const detected of detection.bots) {
    const bot = tools.find((entry) => entry.id === detected.id);
    const file = detected.configFiles[0];
    if (bot === undefined || file === undefined || (only !== undefined && !only.has(bot.id))) continue;
    if (bot.id === 'dependabot') delays.push(...readable(() => dependabotDelays(repository, bot, file), []));
    else {
      const delay = readable(() => renovateDelay(repository, bot, file), undefined);
      if (delay !== undefined) delays.push(delay);
    }
  }
  return delays;
}

/** The longest delay the repository configures, when it is longer than `minutes` and depcurfew.json can hold it. */
export function longestDelay(root: string, detection: Detection, minutes: number, tools: readonly ToolKnowledge[] = knowledgeBase): ConfiguredDelay | undefined {
  let longest: ConfiguredDelay | undefined;
  for (const delay of configuredDelays(new Repository(root), detection, tools)) {
    if (delay.minutes > (longest?.minutes ?? minutes) && parseDuration(policyDuration(delay.minutes)).ok) longest = delay;
  }
  return longest;
}

/** A delay in the syntax of depcurfew.json, rounded up to whole minutes: days, hours or minutes, whichever is exact. */
export function policyDuration(minutes: number): string {
  const whole = Math.ceil(minutes);
  if (whole % 1440 === 0) return `${whole / 1440}d`;
  if (whole % 60 === 0) return `${whole / 60}h`;
  return `${whole}m`;
}

/** A value and where it is set, for messages: `min-release-age: 14 in .npmrc (line 2)`. */
export function describeDelay(delay: ConfiguredDelay): string {
  return `${delay.setting}: ${JSON.stringify(delay.value)} in ${delay.location.file} (line ${delay.location.line})`;
}

/** Files read as lines, where apply comments out a setting it takes over instead of replacing its value. */
function lineBased(file: string): boolean {
  const name = file.split('/').at(-1) ?? file;
  return name === '.npmrc' || name.endsWith('.toml') || name === 'Pipfile';
}

/** A repository whose files read as apply would leave them. */
export class PlannedRepository extends Repository {
  readonly #planned: ReadonlyMap<string, string>;

  constructor(root: string, changes: readonly FileChange[]) {
    super(root);
    this.#planned = new Map(changes.map((change) => [change.file, change.after.startsWith('﻿') ? change.after.slice(1) : change.after]));
  }

  override isFile(path: string): boolean {
    return this.#planned.has(path) || super.isFile(path);
  }

  override readText(path: string, limit?: number): string | undefined {
    return this.#planned.get(path) ?? super.readText(path, limit);
  }
}

/**
 * cooldown-shortened: a delay someone set by hand (not inside depcurfew's markers) that is longer than what apply
 * leaves in its place. The fix names the cooldown.minimum that keeps it.
 */
export function shortenedDelays(root: string, changes: readonly FileChange[], detection: Detection, tools: readonly ToolKnowledge[], targets: ReadonlySet<ToolId>, policyMinimum: string): ApplyWarning[] {
  if (changes.length === 0) return [];
  const before = configuredDelays(new Repository(root), detection, tools, targets).filter((delay) => !delay.managed);
  if (before.length === 0) return [];
  const after = configuredDelays(new PlannedRepository(root, changes), detection, tools, targets);
  return before.flatMap((old): ApplyWarning[] => {
    const now = after.find((delay) => delay.tool === old.tool && delay.scope === old.scope);
    if (now === undefined || now.minutes >= old.minutes) return [];
    const name = tools.find((tool) => tool.id === old.tool)?.name ?? old.tool;
    const scope = old.label === undefined ? '' : ` for ${old.label}`;
    const same = now.location.file === old.location.file && now.setting === old.setting;
    const action = !same
      ? `writes ${now.setting}: ${JSON.stringify(now.value)} to ${now.location.file}, which ${name} reads first`
      : lineBased(old.location.file)
        ? `comments it out and writes ${now.setting}: ${JSON.stringify(now.value)} in its managed block`
        : `replaces it with ${JSON.stringify(now.value)}`;
    return [
      {
        code: 'cooldown-shortened',
        tool: old.tool,
        location: { ...old.location },
        message: `${name}: ${describeDelay(old)} waits ${formatMinutes(old.minutes)}${scope}, longer than cooldown.minimum "${policyMinimum}" in ${POLICY_FILE}; depcurfew apply ${action}, so ${name} waits only ${formatMinutes(now.minutes)}`,
        // JSON has no comments to mark what apply wrote, so a value an earlier apply wrote there counts as set by hand.
        fix: `To keep the longer delay, set cooldown.minimum to "${policyDuration(old.minutes)}" in ${POLICY_FILE} and run depcurfew apply again${old.location.file.endsWith('.json') || old.location.file.endsWith('.jsonc') ? `; if an earlier depcurfew apply wrote this value to ${old.location.file} and you lowered cooldown.minimum on purpose, nothing to do` : ''}`,
      },
    ];
  });
}
