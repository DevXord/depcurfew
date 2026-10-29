// bot-cooldown-mismatch: a bot that waits less than the package manager proposes versions the manager would not
// pick yet. Depending on the manager, the pull request fails to install or slips a too-young version past the
// manager's delay through the lockfile. A bot that skips the delay for security updates breaks CI where the
// manager re-checks the lockfile.
import { extraOf, isRecord, values } from '../../apply/facts.ts';
import { pinnedVersion } from '../../apply/version.ts';
import type { PackageManagerId, PackageManagerInfo } from '../../detect/types.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion, managerDelay, versionedValue, type Delay } from '../effective.ts';
import { jsonSetting, yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

interface BotDelay extends Delay {
  bot: ToolKnowledge;
  managers: readonly PackageManagerId[];
  /** Security updates skip this delay. */
  securityBypass: boolean;
  /** For messages, e.g. "npm updates" for one Dependabot entry. */
  scope: string;
  /** Whether depgate apply edits the file (it prints a snippet for .renovaterc and the deprecated package.json key). */
  applies?: boolean;
}

const isEcosystems = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string'));
const isPresets = (value: unknown): value is { presets: string[]; value: string } =>
  isRecord(value) && Array.isArray(value['presets']) && typeof value['value'] === 'string';
const isCooldownKeys = (value: unknown): value is { days: string; semverDays: string[] } =>
  isRecord(value) && typeof value['days'] === 'string' && Array.isArray(value['semverDays']);
const isPackageJsonConfig = (value: unknown): value is { file: string; key: string } =>
  isRecord(value) && typeof value['file'] === 'string' && typeof value['key'] === 'string';

function describe(minutes: number): string {
  return minutes === 0 ? 'no delay' : formatMinutes(minutes);
}

function dependabotDelays(context: RuleContext, bot: ToolKnowledge, file: string): BotDelay[] {
  const text = context.repository.readText(file);
  if (text === undefined) return [];
  const updates = yamlSetting(text, ['updates']);
  if (updates === undefined || !Array.isArray(updates.value)) return [];
  const ecosystems = extraOf(bot, 'ecosystems', isEcosystems);
  const keys = extraOf(bot, 'cooldownKeys', isCooldownKeys);
  const fallback = versionedValue(values(bot.cooldown.default)[0] ?? [], undefined);
  const securityBypass = values(bot.cooldown.securityUpdates).includes('bypass');
  return (updates.value as unknown[]).flatMap((entry, index): BotDelay[] => {
    if (!isRecord(entry) || typeof entry['package-ecosystem'] !== 'string') return [];
    const managers = (ecosystems[entry['package-ecosystem']] ?? []) as PackageManagerId[];
    if (managers.length === 0) return [];
    const cooldown = isRecord(entry['cooldown']) ? entry['cooldown'] : undefined;
    const configuredDays = cooldown?.[keys.days];
    const base = typeof configuredDays === 'number' ? configuredDays : typeof fallback === 'number' ? fallback : 0;
    const semver = keys.semverDays.filter((key) => typeof cooldown?.[key] === 'number');
    const days = Math.min(base, ...semver.map((key) => cooldown?.[key] as number));
    const shortest = semver.find((key) => cooldown?.[key] === days);
    const origin =
      cooldown === undefined
        ? `Dependabot's default (${describe(days * 1440)})`
        : shortest !== undefined && days < base
          ? `${shortest}: ${days} in ${file}`
          : typeof cooldown[keys.days] === 'number'
            ? `${keys.days}: ${days} in ${file}`
            : `Dependabot's default (${describe(days * 1440)})`;
    const line = yamlSetting(text, ['updates', String(index), cooldown === undefined ? 'package-ecosystem' : 'cooldown'])?.line ?? updates.line;
    return [{ bot, managers, minutes: days * 1440, origin, location: { file, line }, securityBypass, scope: `${entry['package-ecosystem']} updates` }];
  });
}

function renovateDelays(context: RuleContext, bot: ToolKnowledge, file: string): BotDelay[] {
  if (!/\.jsonc?$/u.test(file) && !/\.renovaterc$/u.test(file)) {
    context.notice(`bot-cooldown-mismatch cannot read ${file}; only JSON and JSONC Renovate files are read`, file);
    return [];
  }
  const text = context.repository.readText(file);
  if (text === undefined) return [];
  const all: PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno'];
  // The deprecated configuration in package.json sits under its own key.
  const packageJson = extraOf(bot, 'packageJsonConfig', isPackageJsonConfig);
  const base = file === packageJson.file ? [packageJson.key] : [];
  const configured = jsonSetting(text, [...base, 'minimumReleaseAge']);
  const security = jsonSetting(text, [...base, 'vulnerabilityAlerts', 'minimumReleaseAge']);
  const securityBypass = security === undefined ? values(bot.cooldown.securityUpdates).includes('bypass') : security.value === null;
  let value: unknown = null;
  let origin = 'Renovate has no delay by default';
  let line = 1;
  if (configured !== undefined) {
    value = configured.value;
    origin = `${[...base, 'minimumReleaseAge'].join('.')}: ${JSON.stringify(configured.value)} in ${file}`;
    line = configured.line;
  } else {
    const presets = extraOf(bot, 'minimumReleaseAgePresets', isPresets);
    const extendsList = jsonSetting(text, [...base, 'extends']);
    const preset = Array.isArray(extendsList?.value) ? (extendsList.value as unknown[]).find((item) => typeof item === 'string' && presets.presets.includes(item)) : undefined;
    if (typeof preset === 'string') {
      value = presets.value;
      origin = `the preset ${preset} in ${file} (${presets.value})`;
      line = extendsList?.line ?? 1;
    }
  }
  const delay = delayMinutes(bot, value, latestVersion(bot));
  if (!delay.ok) {
    context.notice(`Renovate: cannot read minimumReleaseAge in ${file}: ${delay.reason}`, file);
    return [];
  }
  return [{ bot, managers: all, minutes: delay.minutes, origin, location: { file, line }, securityBypass, scope: 'updates', applies: base.length === 0 && /\.jsonc?$/u.test(file) }];
}

function rechecksLockfile(tool: ToolKnowledge, manager: PackageManagerInfo): boolean {
  const fact = tool.extra?.['lockfileRecheck'];
  if (fact === undefined) return false;
  const list = values(fact)[0];
  return Array.isArray(list) && versionedValue(list as { since: string; value: unknown }[], pinnedVersion(manager) ?? latestVersion(tool)) === true;
}

export const botCooldownMismatch: Rule = {
  id: 'bot-cooldown-mismatch',
  summary: 'An update bot waits less than the package manager before proposing a new version.',
  description:
    'The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile.',
  help: 'Give the bot a delay at least as long as the package manager\'s (depgate apply does this).',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    const managers = context.detection.packageManagers.filter((entry) => entry.supported);
    if (managers.length === 0) return;
    const delays: BotDelay[] = [];
    for (const detected of context.detection.bots) {
      const bot = context.tools.find((entry) => entry.id === detected.id);
      const file = detected.configFiles[0];
      if (bot === undefined || file === undefined) continue;
      delays.push(...(detected.id === 'dependabot' ? dependabotDelays(context, bot, file) : renovateDelays(context, bot, file)));
    }
    for (const delay of delays) {
      for (const manager of managers.filter((entry) => delay.managers.includes(entry.id))) {
        const tool = context.tools.find((entry) => entry.id === manager.id);
        if (tool === undefined) continue;
        const own = managerDelay(context, manager, tool);
        if (own === undefined || delay.location === undefined) continue;
        if (delay.minutes < own.minutes) {
          context.report({
            location: delay.location,
            message: `${delay.bot.name} proposes ${delay.scope} ${delay.minutes === 0 ? 'without waiting' : `after ${describe(delay.minutes)}`} (${delay.origin}), but ${tool.name} waits ${describe(own.minutes)} (${own.origin}); its pull requests bring in versions younger than ${tool.name} accepts, or fail where the lockfile is re-checked`,
            fix:
              delay.applies === false
                ? `Make the ${delay.bot.name} delay at least ${describe(own.minutes)} in ${delay.location.file} (depgate apply does not edit it)`
                : `Make the ${delay.bot.name} delay at least ${describe(own.minutes)}, or run depgate apply`,
          });
        } else if (delay.securityBypass && own.minutes > 0 && rechecksLockfile(tool, manager)) {
          context.report({
            level: 'warning',
            location: delay.location,
            message: `${delay.bot.name} security updates skip its delay, but ${tool.name} re-checks the lockfile and waits ${describe(own.minutes)} (${own.origin}); a security fix younger than that fails to install`,
            fix: `When a security update fails, exempt the fixed package in the ${tool.name} exclusion list until the delay has passed`,
          });
        }
      }
    }
  },
};
