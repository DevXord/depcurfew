// bot-cooldown-mismatch: a bot that waits less than the package manager proposes versions the manager would not
// pick yet. Depending on the manager, the pull request fails to install or slips a too-young version past the
// manager's delay through the lockfile. A bot that skips the delay for security updates breaks CI where the
// manager re-checks the lockfile. Renovate's delay comes from the top level, the presets it extends and the
// packageRules that cover every package of a registry; a preset depcurfew cannot read gives a note.
import { extraOf, isRecord, values } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import { pinnedVersion } from '../../apply/version.ts';
import type { PackageManagerId, PackageManagerInfo } from '../../detect/types.ts';
import type { Ecosystem, ToolKnowledge } from '../../knowledge/types.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion, managerDelay, versionedValue, type Delay } from '../effective.ts';
import { readRenovateConfig, renovateDelay } from '../renovate.ts';
import { jsonSetting, yamlSetting } from '../settings.ts';
import { inProject } from '../../apply/projects.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { managerSources } from '../projects.ts';
import type { ProjectView, Rule, RuleContext } from '../types.ts';
import { usesBot, usesManager } from '../applies.ts';
import { configParses } from './unreadable-config.ts';

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
  /** The configuration file is in a format depcurfew does not read (Renovate's JSON5), so the delay is not known. */
  unreadableFile?: string;
  /**
   * Why: the file could not be read (too large, a symlink out of the repository, no permission) or parsed; left out for
   * a format depcurfew does not read. unreadable-config reports the file (decision D-124).
   */
  unreadableReason?: 'read' | 'parse';
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
  const managersOf = (ecosystem: Ecosystem): PackageManagerId[] =>
    context.tools.filter((tool) => tool.kind === 'package-manager' && ecosystemOfTool(tool) === ecosystem).map((tool) => tool.id as PackageManagerId);
  // A file in a format depcurfew does not read gives a note at the file for each manager that waits, as a preset it
  // cannot read does, so the check does not pass as if the delay were known (decision D-116).
  if (!/\.jsonc?$/u.test(file) && !/\.renovaterc$/u.test(file)) {
    return (['npm', 'pypi'] as const).map((ecosystem) => ({ bot, managers: managersOf(ecosystem), minutes: 0, origin: file, location: { file, line: 1 }, securityBypass: false, scope: 'updates', applies: false, unreadableFile: file }));
  }
  const text = context.repository.readText(file);
  if (text === undefined) return [];
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

function rechecksLockfile(tool: ToolKnowledge, manager: PackageManagerInfo): boolean {
  const fact = tool.extra?.['lockfileRecheck'];
  if (fact === undefined) return false;
  const list = values(fact)[0];
  return Array.isArray(list) && versionedValue(list as { since: string; value: unknown }[], pinnedVersion(manager) ?? latestVersion(tool)) === true;
}

/**
 * Whether the bot exempts its security fixes from the manager's delay itself: Renovate adds each one to pnpm's
 * minimumReleaseAgeExclude when the delay is set in pnpm-workspace.yaml (extra.pnpmSecurityExclusions).
 */
function exemptsSecurityFixes(bot: ToolKnowledge, manager: string, file: string | undefined): boolean {
  const fact = bot.extra?.['pnpmSecurityExclusions'] === undefined ? undefined : extraOf(bot, 'pnpmSecurityExclusions', isRecord);
  return fact !== undefined && Array.isArray(fact['managers']) && fact['managers'].includes(manager) && fact['file'] === file;
}

/**
 * A bot configuration file that depcurfew cannot read or parse, the way detection and apply read it: its delay is not
 * known, so the rule gives a note at the file for every package manager that waits, instead of a delay the file may not
 * have (decision D-124). unreadable-config reports the file itself.
 */
function unreadableBotFile(context: RuleContext, bot: ToolKnowledge, file: string): BotDelay[] | undefined {
  const text = context.repository.readText(file);
  const reason = text === undefined ? 'read' : configParses(file, text) ? undefined : 'parse';
  if (reason === undefined) return undefined;
  const managers = context.tools.filter((tool) => tool.kind === 'package-manager').map((tool) => tool.id as PackageManagerId);
  return [{ bot, managers, minutes: 0, origin: file, location: { file, line: 1 }, securityBypass: false, scope: 'updates', applies: false, unreadableFile: file, unreadableReason: reason }];
}

const isConfigLocation = (value: unknown): value is { from: string; branch: string } => isRecord(value) && typeof value['from'] === 'string';
const isDirectories = (value: unknown): value is { keys: string[]; globsIn: string } =>
  isRecord(value) && Array.isArray(value['keys']) && value['keys'].every((key) => typeof key === 'string') && typeof value['globsIn'] === 'string';

/**
 * A bot configuration file inside a directory listed in projects: the bot reads its configuration only from the
 * repository root (extra.configLocation), and depcurfew apply configures bots only there (decision D-100), so what the
 * file says is never used. A note at the file instead of the findings its delay would give, reported by the root run,
 * which names the files from the root.
 */
function projectBotNotes(context: RuleContext, views: readonly ProjectView[]): void {
  for (const view of views) {
    for (const detected of view.detection.bots) {
      const bot = context.tools.find((entry) => entry.id === detected.id);
      if (bot === undefined) continue;
      const fact = bot.extra?.['configLocation'];
      const location = fact === undefined ? undefined : values(fact)[0];
      const fromRoot = isConfigLocation(location) && location.from === 'repository-root';
      const atRoot = context.detection.bots.some((entry) => entry.id === detected.id && entry.configFiles.length > 0);
      for (const own of detected.configFiles) {
        const file = inProject(view.directory, own);
        const where = fromRoot
          ? `${bot.name} reads its configuration only from the repository root${isConfigLocation(location) && location.branch === 'default' ? ', on the default branch' : ''}, so it does not read ${file} in the project ${view.directory}`
          : `${file} is the ${bot.name} configuration of the project ${view.directory}`;
        // Without a configuration at the root, the bot reads none at all, and apply has nothing to give a delay to (D-109).
        if (!atRoot) {
          context.report({
            level: 'note',
            location: { file },
            message: `${where}, and the repository root has no ${bot.name} configuration`,
            fix:
              detected.id === 'dependabot'
                ? `Move ${file} to the .github directory at the repository root, with directory: /${view.directory} in its updates entries, then run depcurfew apply`
                : `Move ${file} to the repository root, then run depcurfew apply`,
          });
          continue;
        }
        context.report({
          level: 'note',
          location: { file },
          message: `${where}; depcurfew apply configures ${bot.name} only at the repository root, and its delay there covers ${view.directory} too`,
          fix:
            detected.id === 'dependabot'
              ? `Move the updates entries of ${file} into the Dependabot configuration in the .github directory at the repository root, with directory: /${view.directory}, then remove ${file}`
              : `Move what ${file} sets into the Renovate configuration file at the repository root, then remove ${file}`,
        });
      }
    }
  }
}

/** Whether a directory of a Dependabot updates entry names the project: the same path, or a glob of directories that matches it. */
function namesDirectory(entry: string, project: string, globs: boolean): boolean {
  const trimmed = entry.replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (!globs || !trimmed.includes('*')) return trimmed === project;
  // How Dependabot matches a glob is not documented: ** for any depth, * within one directory (a guess that errs
  // towards a match, so that no warning is given for a directory Dependabot may well update).
  const pattern = trimmed
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'u').test(project);
}

/**
 * A project of a repository whose root Dependabot configuration has updates entries for other projects, but none for
 * this one and its ecosystem: Dependabot does not update it, and so does not wait for it either. Run at the root.
 */
function missingDependabotEntries(context: RuleContext, views: readonly ProjectView[]): void {
  const detected = context.detection.bots.find((bot) => bot.id === 'dependabot');
  const bot = context.tools.find((entry) => entry.id === 'dependabot');
  const file = detected?.configFiles[0];
  if (bot === undefined || file === undefined || views.length < 2) return;
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const updates = yamlSetting(text, ['updates']);
  if (updates === undefined || !Array.isArray(updates.value)) return;
  const ecosystems = extraOf(bot, 'ecosystems', isEcosystems);
  const keys = extraOf(bot, 'directories', isDirectories);
  const entries = (updates.value as unknown[]).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry['package-ecosystem'] !== 'string') return [];
    const directories = keys.keys.flatMap((key) => {
      const value = entry[key];
      const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      return list.map((directory) => ({ directory, globs: key === keys.globsIn }));
    });
    return [{ ecosystem: entry['package-ecosystem'], directories }];
  });
  const needed = views.map((view) => ({
    view,
    ecosystems: [...new Set(view.detection.packageManagers.filter((manager) => manager.supported).flatMap((manager) => Object.keys(ecosystems).filter((name) => ecosystems[name]?.includes(manager.id) === true)))],
  }));
  const covers = (ecosystem: string, project: string) =>
    entries.some((entry) => entry.ecosystem === ecosystem && entry.directories.some((item) => namesDirectory(item.directory, project, item.globs)));
  const missing = needed.flatMap(({ view, ecosystems: names }) => names.filter((name) => !covers(name, view.directory)).map((ecosystem) => ({ view, ecosystem })));
  const updated = needed.filter(({ view, ecosystems: names }) => names.some((name) => covers(name, view.directory))).map(({ view }) => view.directory);
  // Only when Dependabot updates some projects: a configuration for the GitHub Actions of the root alone says nothing about them.
  if (updated.length === 0) return;
  for (const { view, ecosystem } of missing) {
    context.report({
      level: 'warning',
      location: { file, line: updates.line },
      message: `${file} has no updates entry with package-ecosystem: ${ecosystem} for ${view.directory}, which projects in ${POLICY_FILE} lists, so Dependabot does not update the ${ecosystem} dependencies of ${view.directory}, while it updates ${listing(updated)}`,
      fix: `If Dependabot should update ${view.directory}, add an updates entry with package-ecosystem: ${ecosystem} and directory: /${view.directory} to ${file}, then run depcurfew apply to give it the cooldown`,
    });
  }
}

export const botCooldownMismatch: Rule = {
  id: 'bot-cooldown-mismatch',
  checks: 'Update bots wait at least as long as the package manager before proposing a new version',
  summary: 'An update bot waits less than the package manager before proposing a new version.',
  description:
    'The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile. A Dependabot cooldown with an include list delays only the dependencies it names, and a Renovate packageRules entry can shorten the delay for a whole registry or update type. A bot configuration file that depcurfew cannot read or parse, or a Renovate file in JSON5, gets a note for each package manager that waits, instead of a delay the file may not have. With projects in depcurfew.json, a bot configuration file inside a project gets a note, because the bot reads its configuration only from the repository root, and a project that the Dependabot configuration of the root leaves out while it updates other projects gets a warning.',
  help: 'Give the bot a delay at least as long as the package manager\'s (depcurfew apply does this).',
  level: 'error',
  requiresPolicy: false,
  applies: (scope) => usesBot(scope) && usesManager(scope),
  check(context) {
    // A project's own bot files are never read by the bot (decision D-107): the root run gives a note at each one.
    if (context.project !== undefined) return;
    if (context.projects !== undefined) {
      projectBotNotes(context, context.projects);
      missingDependabotEntries(context, context.projects);
    }
    // Bots are configured from the root for every project in projects (decision D-100), so they wait for all of them.
    const sources = managerSources(context);
    if (sources.every((source) => source.managers.length === 0)) return;
    const delays: BotDelay[] = [];
    for (const detected of context.detection.bots) {
      const bot = context.tools.find((entry) => entry.id === detected.id);
      const file = detected.configFiles[0];
      if (bot === undefined || file === undefined) continue;
      delays.push(...(unreadableBotFile(context, bot, file) ?? (detected.id === 'dependabot' ? dependabotDelays(context, bot, file) : renovateDelays(context, bot, file))));
    }
    for (const delay of delays) {
      for (const { manager, source } of sources.flatMap((item) => item.managers.filter((entry) => delay.managers.includes(entry.id)).map((manager) => ({ manager, source: item })))) {
        const knowledge = context.tools.find((entry) => entry.id === manager.id);
        if (knowledge === undefined) continue;
        const found = managerDelay(source.context, manager, knowledge);
        if (found === undefined || delay.location === undefined) continue;
        // A project's manager is named with its directory, and the file of its delay relative to the root.
        const tool = source.project === undefined ? knowledge : { ...knowledge, name: `${knowledge.name} in ${source.project}` };
        const own = { ...found, origin: source.relocate(found.origin) };
        if (delay.unreadableFile !== undefined) {
          if (own.minutes > 0) {
            const file = delay.unreadableFile;
            const reason = delay.unreadableReason;
            const cannot = reason === 'parse' ? 'cannot parse' : reason === 'read' ? 'cannot read' : 'cannot read (it reads only JSON and JSONC Renovate files)';
            context.report({
              level: 'note',
              location: delay.location,
              message: `${delay.bot.name} reads ${file}, which depcurfew ${cannot}, so it cannot tell whether ${delay.bot.name} waits as long as ${tool.name} (${describe(own.minutes)}, ${own.origin})`,
              fix:
                reason === 'parse'
                  ? `Fix the syntax error in ${file} (unreadable-config says what it is), then run depcurfew doctor again`
                  : reason === 'read'
                    ? `Make ${file} a file depcurfew can read (unreadable-config says what is wrong), then run depcurfew doctor again`
                    : `Make sure minimumReleaseAge in ${file} is at least ${describe(own.minutes)}, or move the configuration to renovate.json, which depcurfew reads`,
            });
          }
          continue;
        }
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
        } else if (delay.securityBypass && own.minutes > 0 && rechecksLockfile(tool, manager) && !exemptsSecurityFixes(delay.bot, tool.id, found.location?.file)) {
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
