// bot-cooldown-mismatch: a bot that waits less than the package manager proposes versions the manager would not
// pick yet. Depending on the manager, the pull request fails to install or slips a too-young version past the
// manager's delay through the lockfile. A bot that skips the delay for security updates breaks CI where the
// manager re-checks the lockfile. Renovate's delay comes from the top level, the presets it extends and the
// packageRules that cover every package of a registry; a preset depcurfew cannot read gives a note.
import { extraOf, isRecord, values } from '../../apply/facts.ts';
import { pinnedVersion } from '../../apply/version.ts';
import type { PackageManagerId, PackageManagerInfo } from '../../detect/types.ts';
import type { Ecosystem, ToolKnowledge } from '../../knowledge/types.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion, managerDelay, versionedValue, type Delay } from '../effective.ts';
import { readRenovateConfig, renovateDelay } from '../renovate.ts';
import { jsonSetting, yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

interface BotDelay extends Delay {
  bot: ToolKnowledge;
  managers: readonly PackageManagerId[];
  /** Security updates skip this delay. */
  securityBypass: boolean;
  /** For messages, e.g. "npm updates" for one Dependabot entry. */
  scope: string;
  /** Whether depcurfew apply edits the file (it prints a snippet for .renovaterc and the deprecated package.json key). */
  applies?: boolean;
  /** The packageRules entry of the repository that sets this delay (Renovate). */
  rule?: number;
  /** A preset depcurfew cannot read may set the delay; the repository itself sets none (Renovate). */
  unreadablePreset?: string;
  /** A fix for this delay in place of the general one. */
  fix?: string;
}

const isEcosystems = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string'));
const isCooldownKeys = (value: unknown): value is { days: string; exclude: string; semverDays: string[] } =>
  isRecord(value) && typeof value['days'] === 'string' && typeof value['exclude'] === 'string' && Array.isArray(value['semverDays']);
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
  const include = extraOf(bot, 'cooldownInclude', (value): value is { key: string } => isRecord(value) && typeof value['key'] === 'string');
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
    const delays: BotDelay[] = [{ bot, managers, minutes: days * 1440, origin, location: { file, line }, securityBypass, scope: `${entry['package-ecosystem']} updates` }];
    // With an include list, only the dependencies it names get a cooldown (extra.cooldownInclude).
    const included = cooldown?.[include.key];
    const patterns = Array.isArray(included) ? included.filter((item): item is string => typeof item === 'string') : [];
    if (patterns.length > 0 && !patterns.some((pattern) => /^\*+$/u.test(pattern))) {
      const at = yamlSetting(text, ['updates', String(index), 'cooldown', include.key])?.line ?? line;
      delays.push({
        bot,
        managers,
        minutes: 0,
        origin: `cooldown.${include.key} in ${file} names only ${listing(patterns)}`,
        location: { file, line: at },
        securityBypass,
        scope: `${entry['package-ecosystem']} updates of dependencies that cooldown.${include.key} does not name`,
        fix: `Remove ${include.key} from the cooldown of updates[${index}] in ${file}, so that the cooldown covers every dependency, and list exceptions under ${keys.exclude} instead`,
      });
    }
    return delays;
  });
}

function renovateDelays(context: RuleContext, bot: ToolKnowledge, file: string): BotDelay[] {
  if (!/\.jsonc?$/u.test(file) && !/\.renovaterc$/u.test(file)) {
    context.notice(`bot-cooldown-mismatch cannot read ${file}; only JSON and JSONC Renovate files are read`, file);
    return [];
  }
  const text = context.repository.readText(file);
  if (text === undefined) return [];
  const managersOf = (ecosystem: Ecosystem): PackageManagerId[] =>
    context.tools.filter((tool) => tool.kind === 'package-manager' && ecosystemOfTool(tool) === ecosystem).map((tool) => tool.id as PackageManagerId);
  // The deprecated configuration in package.json sits under its own key.
  const packageJson = extraOf(bot, 'packageJsonConfig', isPackageJsonConfig);
  const base = file === packageJson.file ? [packageJson.key] : [];
  const security = jsonSetting(text, [...base, 'vulnerabilityAlerts', 'minimumReleaseAge']);
  const securityBypass = security === undefined ? values(bot.cooldown.securityUpdates).includes('bypass') : security.value === null;
  const applies = base.length === 0 && /\.jsonc?$/u.test(file);
  const config = readRenovateConfig(text, file, base);
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
  // The top-level value, the presets and the packageRules that cover every package of a registry give each update
  // type its delay; the shortest one counts.
  return (['npm', 'pypi'] as const).flatMap((ecosystem): BotDelay[] => {
    const managers = managersOf(ecosystem);
    const delay = renovateDelay(bot, config, ecosystem);
    if (!delay.known) {
      return [{ bot, managers, minutes: 0, origin: `the preset ${delay.preset}`, location: { file, line: delay.line }, securityBypass, scope: 'updates', applies, unreadablePreset: delay.preset }];
    }
    const minutes = new Map<string, number>();
    for (const type of updateTypes) {
      const source = delay.byType.get(type);
      const value = delayMinutes(bot, source?.value ?? null, latestVersion(bot));
      if (!value.ok) {
        context.notice(`Renovate: cannot read minimumReleaseAge in ${file}: ${value.reason}`, file);
        return [];
      }
      minutes.set(type, value.minutes);
    }
    const shortest = Math.min(...minutes.values());
    const types = updateTypes.filter((type) => minutes.get(type) === shortest);
    const source = delay.byType.get(types[0] ?? '');
    return [
      {
        bot,
        managers,
        minutes: shortest,
        origin: source?.origin ?? 'Renovate has no delay by default',
        location: { file, line: source?.line ?? 1 },
        securityBypass,
        scope: types.length === updateTypes.length ? 'updates' : `${listing(types)} updates`,
        applies,
        ...(source?.rule === undefined ? {} : { rule: source.rule }),
      },
    ];
  });
}

function listing(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
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
    'The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile. A Dependabot cooldown with an include list delays only the dependencies it names, and a Renovate packageRules entry can shorten the delay for a whole registry or update type.',
  help: 'Give the bot a delay at least as long as the package manager\'s (depcurfew apply does this).',
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
        if (delay.unreadablePreset !== undefined) {
          if (own.minutes > 0) {
            context.report({
              level: 'note',
              location: delay.location,
              message: `${delay.bot.name} extends ${delay.unreadablePreset}, which depcurfew cannot read, so it cannot tell whether ${delay.bot.name} waits as long as ${tool.name} (${describe(own.minutes)}, ${own.origin})`,
              fix: `Make sure the preset sets minimumReleaseAge to at least ${describe(own.minutes)} for these packages, or set it in ${delay.location.file}${delay.applies === false ? '' : ' (depcurfew apply does this)'}`,
            });
          }
          continue;
        }
        // A packageRules entry that turns the delay off for every package is reported by broad-exclusion.
        if (delay.rule !== undefined && delay.minutes === 0) continue;
        if (delay.minutes < own.minutes) {
          context.report({
            location: delay.location,
            message: `${delay.bot.name} proposes ${delay.scope} ${delay.minutes === 0 ? 'without waiting' : `after ${describe(delay.minutes)}`} (${delay.origin}), but ${tool.name} waits ${describe(own.minutes)} (${own.origin}); its pull requests bring in versions younger than ${tool.name} accepts, or fail where the lockfile is re-checked`,
            fix:
              delay.fix ??
              (delay.rule !== undefined
                ? `Make minimumReleaseAge in packageRules[${delay.rule}] of ${delay.location.file} at least ${describe(own.minutes)}, or limit the rule to the packages that need a shorter delay`
                : delay.applies === false
                  ? `Make the ${delay.bot.name} delay at least ${describe(own.minutes)} in ${delay.location.file} (depcurfew apply does not edit it)`
                  : `Make the ${delay.bot.name} delay at least ${describe(own.minutes)}, or run depcurfew apply`),
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
