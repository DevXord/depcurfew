// bot-cooldown-mismatch: a bot that waits less than the package manager proposes versions the manager would not
// pick yet. Depending on the manager, the pull request fails to install or slips a too-young version past the
// manager's delay through the lockfile. A bot that skips the delay for security updates breaks CI where the
// manager re-checks the lockfile. Renovate's delay comes from the top level, the presets it extends and the
// packageRules that cover every package of a registry, Renovate manager or category (decision D-131); a preset or a
// rule matcher depcurfew cannot read gives a note. When the policy's delay covers the actions the workflows run
// (decision D-130) or the dependencies of the ecosystems updated by bots only (Cargo, Go modules, Maven, Gradle and
// NuGet, decision D-151), the bot's delay for them is compared with cooldown.minimum; such an ecosystem in a
// repository without an update bot gets a note, because nothing delays its new versions there.
import { extraOf, isRecord, values, yamlOptionsFor } from '../../apply/facts.ts';
import { botOnlyEntries, isActionsEcosystem } from '../../apply/generators/dependabot.ts';
import { listing } from '../../apply/requirements.ts';
import { coversActions, coversBotEcosystems } from '../../apply/targets.ts';
import { pinnedVersion } from '../../apply/version.ts';
import { botEcosystemFact, ownDelayText } from '../../detect/bot-ecosystems.ts';
import type { BotEcosystemInfo, PackageManagerId, PackageManagerInfo } from '../../detect/types.ts';
import type { BotOnlyEcosystemId, ToolKnowledge } from '../../knowledge/types.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion, managerDelay, versionedValue, type Delay } from '../effective.ts';
import { actionsTarget, botEcosystemTargets, managerTargets, readRenovateConfig, renovateDelay, type RenovateTarget, type UnreadableRule, type UpdateType } from '../renovate.ts';
import { jsonSetting, rejectsYamlAliases, yamlAliasLine, yamlSetting } from '../settings.ts';
import { inProject } from '../../apply/projects.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { managerSources } from '../projects.ts';
import type { ProjectView, Rule, RuleContext, RuleScope } from '../types.ts';
import { usesBot, usesManager } from '../applies.ts';
import { configParses } from './unreadable-config.ts';

interface BotDelay extends Delay {
  bot: ToolKnowledge;
  managers: readonly PackageManagerId[];
  /** The delay of the actions the workflows run, which the policy's delay covers (decision D-130). */
  actions?: true;
  /** The delay of the dependencies of an ecosystem updated by bots only, which the policy's delay covers (decision D-151). */
  ecosystem?: BotOnlyEcosystemId;
  /** packageRules entries with a matcher depcurfew cannot read that may set a shorter delay (Renovate, decision D-131). */
  unreadableRules?: readonly UnreadableRule[];
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
   * a format depcurfew does not read. unreadable-config reports the file (decision D-124). alias: a Dependabot file
   * with a YAML alias, which Dependabot does not accept and depcurfew does not read for it (decision D-135); the
   * location is the line of the first alias.
   */
  unreadableReason?: 'read' | 'parse' | 'alias';
  /** A fix for this delay in place of the general one. */
  fix?: string;
  /**
   * Another delay of the same target that a Renovate rule gives some update types, longer than the first one (decision
   * D-141): compared on its own, without the notes and the security check of the first.
   */
  secondary?: true;
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
  // Numbers as Dependabot's YAML library reads them (extra.yamlScalars, decision D-136): default-days: 010 is 8.
  const yaml = yamlOptionsFor(file, context.tools);
  const updates = yamlSetting(text, ['updates'], yaml);
  if (updates === undefined || !Array.isArray(updates.value)) return [];
  const ecosystems = extraOf(bot, 'ecosystems', isEcosystems);
  const keys = extraOf(bot, 'cooldownKeys', isCooldownKeys);
  const fallback = versionedValue(values(bot.cooldown.default)[0] ?? [], undefined);
  const securityBypass = values(bot.cooldown.securityUpdates).includes('bypass');
  const include = extraOf(bot, 'cooldownInclude', (value): value is { key: string } => isRecord(value) && typeof value['key'] === 'string');
  // The github-actions entries, when the policy's delay covers the actions of the workflows (decision D-130).
  const actions = bot.extra?.['githubActions'] === undefined || !coversActions(context.policy, bot.id, context.detection) ? undefined : extraOf(bot, 'githubActions', isActionsEcosystem);
  // The entries of the ecosystems updated by bots only, which apply gives the cooldown wherever they are (decision D-151).
  const botOnly = coversBotEcosystems(context.policy, bot.id) ? botOnlyEntries(bot) : new Map<string, never>();
  return (updates.value as unknown[]).flatMap((entry, index): BotDelay[] => {
    if (!isRecord(entry) || typeof entry['package-ecosystem'] !== 'string') return [];
    const forActions = actions !== undefined && entry['package-ecosystem'] === actions.ecosystem;
    const forEcosystem = botOnly.get(entry['package-ecosystem']);
    const managers = (ecosystems[entry['package-ecosystem']] ?? []) as PackageManagerId[];
    if (managers.length === 0 && !forActions && forEcosystem === undefined) return [];
    const cooldown = isRecord(entry['cooldown']) ? entry['cooldown'] : undefined;
    const configuredDays = cooldown?.[keys.days];
    const base = typeof configuredDays === 'number' ? configuredDays : typeof fallback === 'number' ? fallback : 0;
    // github-actions reads default-days only (extra.githubActions).
    const semver = ((forActions && !actions.semverDays) || forEcosystem?.semverDays === false ? [] : keys.semverDays).filter((key) => typeof cooldown?.[key] === 'number');
    const days = Math.min(base, ...semver.map((key) => cooldown?.[key] as number));
    const shortest = semver.find((key) => cooldown?.[key] === days);
    // The number as the file writes it, and how Dependabot reads it when that differs (010, which it reads as 8).
    const written = (key: string) => {
      const asWritten = yamlSetting(text, ['updates', String(index), 'cooldown', key], yaml)?.written;
      return asWritten === undefined || asWritten === String(days) ? `${key}: ${days} in ${file}` : `${key}: ${asWritten} in ${file}, which Dependabot reads as ${days}`;
    };
    const origin =
      cooldown === undefined
        ? `Dependabot's default (${describe(days * 1440)})`
        : shortest !== undefined && days < base
          ? written(shortest)
          : typeof cooldown[keys.days] === 'number'
            ? written(keys.days)
            : `Dependabot's default (${describe(days * 1440)})`;
    const line = yamlSetting(text, ['updates', String(index), cooldown === undefined ? 'package-ecosystem' : 'cooldown'], yaml)?.line ?? updates.line;
    const target = forActions ? { actions: true as const } : forEcosystem !== undefined ? { ecosystem: forEcosystem.id } : {};
    const delays: BotDelay[] = [{ bot, managers, ...target, minutes: days * 1440, origin, location: { file, line }, securityBypass, scope: `${entry['package-ecosystem']} updates` }];
    // With an include list, only the dependencies it names get a cooldown (extra.cooldownInclude).
    const included = cooldown?.[include.key];
    const patterns = Array.isArray(included) ? included.filter((item): item is string => typeof item === 'string') : [];
    if (patterns.length > 0 && !patterns.some((pattern) => /^\*+$/u.test(pattern))) {
      const at = yamlSetting(text, ['updates', String(index), 'cooldown', include.key], yaml)?.line ?? line;
      delays.push({
        bot,
        managers,
        ...target,
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
  // One delay for each Renovate manager of the package managers (decision D-131), and one for the actions of the
  // workflows when the policy's delay covers them (decision D-130).
  const actions = coversActions(context.policy, bot.id, context.detection) ? actionsTarget(bot, context.detection.workflows) : undefined;
  // And one for each ecosystem updated by bots only that the repository has, when the policy's delay covers them (D-151).
  const botOnly = coversBotEcosystems(context.policy, bot.id) ? botEcosystemTargets(bot, botEcosystemsInUse(context).map((entry) => entry.id)) : [];
  const targets = [
    ...managerTargets(bot, context.tools).map(({ target, tools }) => ({ target, managers: tools.map((tool) => tool.id as PackageManagerId) })),
    ...botOnly.map((target) => ({ target, managers: [] as PackageManagerId[] })),
    ...(actions === undefined ? [] : [{ target: actions, managers: [] as PackageManagerId[] }]),
  ];
  const flags = (target: RenovateTarget) => (target.actions === true ? { actions: true as const } : target.ecosystem !== undefined ? { ecosystem: target.ecosystem } : {});
  const scopeOf = (target: RenovateTarget, types: string) =>
    target.actions === true ? `${ACTIONS} ${types}` : target.ecosystem !== undefined ? `${botEcosystemFact(target.ecosystem)?.client ?? target.ecosystem} ${types}` : types;
  // A file in a format depcurfew does not read gives a note at the file for each manager that waits, as a preset it
  // cannot read does, so the check does not pass as if the delay were known (decision D-116).
  if (!/\.jsonc?$/u.test(file) && !/\.renovaterc$/u.test(file)) {
    return targets.map(({ target, managers }) => ({ bot, managers, ...flags(target), minutes: 0, origin: file, location: { file, line: 1 }, securityBypass: false, scope: scopeOf(target, 'updates'), applies: false, unreadableFile: file }));
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
  return targets.flatMap(({ target, managers }): BotDelay[] => {
    const delay = renovateDelay(bot, config, target);
    if (!delay.known) {
      return [{ bot, managers, ...flags(target), minutes: 0, origin: `the preset ${delay.preset}`, location: { file, line: delay.line }, securityBypass, scope: scopeOf(target, 'updates'), applies, unreadablePreset: delay.preset }];
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
    // One delay for each place that sets some update types their delay, the shortest first: a rule that turns the delay
    // off for major updates must not hide another that shortens it for minor and patch updates (decision D-141).
    const groups = new Map<string, UpdateType[]>();
    for (const type of updateTypes) {
      const key = delay.byType.get(type)?.origin ?? '';
      groups.set(key, [...(groups.get(key) ?? []), type]);
    }
    const ordered = [...groups.values()].sort((a, b) => (minutes.get(a[0] ?? '') ?? 0) - (minutes.get(b[0] ?? '') ?? 0));
    return ordered.map((types, index): BotDelay => {
      const source = delay.byType.get(types[0] ?? '');
      return {
        bot,
        managers,
        ...flags(target),
        minutes: minutes.get(types[0] ?? '') ?? 0,
        origin: source?.origin ?? 'Renovate has no delay by default',
        location: { file, line: source?.line ?? 1 },
        securityBypass,
        scope: types.length === updateTypes.length ? scopeOf(target, 'updates') : `${listing(types)} ${scopeOf(target, 'updates')}`,
        applies,
        ...(source?.rule === undefined ? {} : { rule: source.rule }),
        ...(index === 0 && delay.unreadable.length > 0 ? { unreadableRules: delay.unreadable } : {}),
        ...(index === 0 ? {} : { secondary: true as const }),
      };
    });
  });
}

/** The actions the workflows run, as messages name them. */
const ACTIONS = 'GitHub Actions';

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
  // A YAML alias in a file of a bot that rejects them (Dependabot, extra.yamlAliases): its values are not read.
  const alias = reason === undefined && text !== undefined && rejectsYamlAliases(bot) ? yamlAliasLine(text) : undefined;
  if (reason === undefined && alias === undefined) return undefined;
  const managers = context.tools.filter((tool) => tool.kind === 'package-manager').map((tool) => tool.id as PackageManagerId);
  const unreadable: Omit<BotDelay, 'bot' | 'managers' | 'scope'> = {
    minutes: 0,
    origin: file,
    location: { file, line: alias ?? 1 },
    securityBypass: false,
    applies: false,
    unreadableFile: file,
    unreadableReason: reason ?? 'alias',
  };
  const botOnly = coversBotEcosystems(context.policy, bot.id) ? botEcosystemsInUse(context) : [];
  return [
    { bot, managers, ...unreadable, scope: 'updates' },
    ...botOnly.map((entry): BotDelay => ({ bot, managers: [], ecosystem: entry.id, ...unreadable, scope: `${botEcosystemFact(entry.id)?.client ?? entry.id} updates` })),
    ...(coversActions(context.policy, bot.id, context.detection) ? [{ bot, managers: [], actions: true as const, ...unreadable, scope: `${ACTIONS} updates` }] : []),
  ];
}

/** The ecosystems updated by bots only that the repository has (decision D-151): what detection found at the root. */
function botEcosystemsInUse(scope: Pick<RuleScope, 'detection'>): readonly BotEcosystemInfo[] {
  return scope.detection.botEcosystems ?? [];
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
  // Dependabot does not read a file with YAML aliases (extra.yamlAliases); bot-cooldown-mismatch gives a note for it.
  if (text === undefined || (rejectsYamlAliases(bot) && yamlAliasLine(text) !== undefined)) return;
  const updates = yamlSetting(text, ['updates'], yamlOptionsFor(file, context.tools));
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

/**
 * What a bot's delay is compared with, and how messages name it: a package manager's own delay, or cooldown.minimum
 * for the actions the workflows run (decision D-130).
 */
interface Reference {
  minutes: number;
  /** After "waits as long as": `npm (3 days, min-release-age: 3 in .npmrc)`. */
  asLongAs: string;
  /** After "but": what waits longer, and what the bot's pull requests do then. */
  waits: string;
  /** What a rule should be limited to, and what a preset or rule should give the delay to. */
  things: 'packages' | 'actions';
}

function managerReference(tool: ToolKnowledge, own: Delay): Reference {
  return {
    minutes: own.minutes,
    asLongAs: `${tool.name} (${describe(own.minutes)}, ${own.origin})`,
    waits: `${tool.name} waits ${describe(own.minutes)} (${own.origin}); its pull requests bring in versions younger than ${tool.name} accepts, or fail where the lockfile is re-checked`,
    things: 'packages',
  };
}

function actionsReference(context: RuleContext): Reference | undefined {
  const minimum = context.policy?.cooldown?.minimum;
  if (minimum === undefined) return undefined;
  return {
    minutes: minimum.minutes,
    asLongAs: `cooldown.minimum in ${POLICY_FILE} (${describe(minimum.minutes)}) for the actions the workflows run`,
    waits: `cooldown.minimum in ${POLICY_FILE} is ${describe(minimum.minutes)}, which covers the actions the workflows run; its pull requests bring in versions of actions younger than that`,
    things: 'actions',
  };
}

/**
 * cooldown.minimum for the dependencies of an ecosystem updated by bots only, whose package manager has no release-age
 * delay depcurfew configures (decision D-151).
 */
function ecosystemReference(context: RuleContext, id: BotOnlyEcosystemId): Reference | undefined {
  const minimum = context.policy?.cooldown?.minimum;
  const ecosystem = botEcosystemFact(id);
  if (minimum === undefined || ecosystem === undefined) return undefined;
  const dependencies = `${ecosystem.client} dependencies`;
  return {
    minutes: minimum.minutes,
    asLongAs: `cooldown.minimum in ${POLICY_FILE} (${describe(minimum.minutes)}) for ${dependencies}`,
    waits: `cooldown.minimum in ${POLICY_FILE} is ${describe(minimum.minutes)}, which covers ${dependencies}, and ${ownDelayText(ecosystem, false)}; its pull requests bring in versions younger than that`,
    things: 'packages',
  };
}

/**
 * An ecosystem updated by bots only in a repository without an update bot (decision D-151): nothing delays its new
 * versions there, since depcurfew delays them only through Dependabot and Renovate. One note per ecosystem.
 */
function unprotectedEcosystems(context: RuleContext): void {
  if (context.detection.bots.length > 0) return;
  const dependabot = context.tools.find((tool) => tool.id === 'dependabot');
  const renovate = context.tools.find((tool) => tool.id === 'renovate');
  const entries = dependabot === undefined ? new Map<string, never>() : botOnlyEntries(dependabot);
  const configFile = dependabot === undefined ? undefined : values(dependabot.cooldown.configFiles)[0]?.[0];
  for (const found of botEcosystemsInUse(context)) {
    const ecosystem = botEcosystemFact(found.id);
    const file = found.files[0];
    if (ecosystem === undefined || file === undefined) continue;
    const entry = [...entries.values()].find((item) => item.id === found.id);
    const manager = renovate === undefined ? undefined : botEcosystemTargets(renovate, [found.id])[0]?.manager;
    const bots = [
      ...(entry === undefined || configFile === undefined ? [] : [`Dependabot (an updates entry with package-ecosystem: ${entry.ecosystem} in ${configFile})`]),
      ...(manager === undefined ? [] : [`Renovate (its ${manager} manager)`]),
    ];
    const then = context.policy?.cooldown === undefined ? 'then run depcurfew init and depcurfew apply, which give the bot a cooldown' : `then run depcurfew apply, which gives the bot the cooldown of ${POLICY_FILE}`;
    context.report({
      level: 'note',
      location: { file },
      message: `No update bot delays new versions of ${ecosystem.client} dependencies: the repository configures neither Dependabot nor Renovate, and ${ownDelayText(ecosystem, true)}, so nothing holds back the versions the dependencies in ${listing(found.files)} are updated to`,
      fix: `Update these dependencies with ${bots.length === 0 ? 'an update bot' : bots.join(' or ')}, ${then}; depcurfew delays ${ecosystem.client} dependencies only through these bots`,
    });
  }
}

/**
 * The findings for one bot delay and what it is compared with; true when it reported a shorter delay or a note
 * instead (the security check of a package manager comes after).
 */
function compare(context: RuleContext, delay: BotDelay, reference: Reference): boolean {
  if (delay.location === undefined) return true;
  if (delay.unreadableFile !== undefined) {
    if (reference.minutes > 0) {
      const file = delay.unreadableFile;
      const reason = delay.unreadableReason;
      const cannot = reason === 'parse' ? 'cannot parse' : reason === 'read' ? 'cannot read' : 'cannot read (it reads only JSON and JSONC Renovate files)';
      const line = delay.location.line;
      if (reason === 'alias') {
        context.report({
          level: 'note',
          location: delay.location,
          message: `${delay.bot.name} reads ${file}, which uses a YAML alias (line ${line}); ${delay.bot.name} does not accept YAML aliases, and depcurfew does not read them for it, so it cannot tell whether ${delay.bot.name} waits as long as ${reference.asLongAs}`,
          fix: `Write the value out in place of the alias on line ${line} of ${file} (${delay.bot.name} loads the file without aliases), then run depcurfew doctor again`,
        });
        return true;
      }
      context.report({
        level: 'note',
        location: delay.location,
        message: `${delay.bot.name} reads ${file}, which depcurfew ${cannot}, so it cannot tell whether ${delay.bot.name} waits as long as ${reference.asLongAs}`,
        fix:
          reason === 'parse'
            ? `Fix the syntax error in ${file} (unreadable-config says what it is), then run depcurfew doctor again`
            : reason === 'read'
              ? `Make ${file} a file depcurfew can read (unreadable-config says what is wrong), then run depcurfew doctor again`
              : `Make sure minimumReleaseAge in ${file} is at least ${describe(reference.minutes)}, or move the configuration to renovate.json, which depcurfew reads`,
      });
    }
    return true;
  }
  if (delay.unreadablePreset !== undefined) {
    if (reference.minutes > 0) {
      context.report({
        level: 'note',
        location: delay.location,
        message: `${delay.bot.name} extends ${delay.unreadablePreset}, which depcurfew cannot read, so it cannot tell whether ${delay.bot.name} waits as long as ${reference.asLongAs}`,
        fix: `Make sure the preset sets minimumReleaseAge to at least ${describe(reference.minutes)} for these ${reference.things}, or set it in ${delay.location.file}${delay.applies === false ? '' : ' (depcurfew apply does this)'}`,
      });
    }
    return true;
  }
  // A rule whose matcher depcurfew cannot read keeps out of the delay, with a note when it may shorten it (D-131).
  for (const rule of delay.unreadableRules ?? []) {
    const minutes = delayMinutes(delay.bot, rule.value, latestVersion(delay.bot));
    if (!minutes.ok || minutes.minutes >= reference.minutes) continue;
    context.report({
      level: 'note',
      location: { file: delay.location.file, line: rule.line },
      message: `${delay.bot.name} packageRules[${rule.index}] in ${delay.location.file} sets minimumReleaseAge: ${JSON.stringify(rule.value)} for ${rule.matcher} ${JSON.stringify(rule.patterns)}, which depcurfew cannot read, so it cannot tell whether ${delay.bot.name} waits as long as ${reference.asLongAs}`,
      fix:
        rule.unmodelled === true
          ? `Make sure packageRules[${rule.index}] of ${delay.location.file} gives these ${reference.things} a minimumReleaseAge of at least ${describe(reference.minutes)}; depcurfew does not evaluate ${rule.matcher}, so this note stays while the rule sets a shorter delay`
          : `Make sure packageRules[${rule.index}] of ${delay.location.file} gives these ${reference.things} a minimumReleaseAge of at least ${describe(reference.minutes)}, or write its ${rule.matcher} with names, * or /regex/ patterns, which depcurfew reads`,
    });
  }
  // A packageRules entry that turns the delay off for every package is reported by broad-exclusion.
  if (delay.rule !== undefined && delay.minutes === 0) return true;
  if (delay.minutes >= reference.minutes) return false;
  context.report({
    location: delay.location,
    message: `${delay.bot.name} proposes ${delay.scope} ${delay.minutes === 0 ? 'without waiting' : `after ${describe(delay.minutes)}`} (${delay.origin}), but ${reference.waits}`,
    fix:
      delay.fix ??
      (delay.rule !== undefined
        ? `Make minimumReleaseAge in packageRules[${delay.rule}] of ${delay.location.file} at least ${describe(reference.minutes)}, or limit the rule to the ${reference.things} that need a shorter delay`
        : delay.applies === false
          ? `Make the ${delay.bot.name} delay at least ${describe(reference.minutes)} in ${delay.location.file} (depcurfew apply does not edit it)`
          : `Make the ${delay.bot.name} delay at least ${describe(reference.minutes)}, or run depcurfew apply`),
  });
  return true;
}

/**
 * Whether the scope has something a bot's delay is compared with: a package manager, the actions of workflows, or the
 * dependencies of an ecosystem updated by bots only (decision D-151).
 */
function hasReference(scope: RuleScope): boolean {
  const actions = scope.project === undefined && scope.detection.bots.some((bot) => coversActions(scope.policy, bot.id, scope.detection));
  const ecosystems = scope.project === undefined && botEcosystemsInUse(scope).length > 0 && scope.detection.bots.some((bot) => coversBotEcosystems(scope.policy, bot.id));
  return usesManager(scope) || actions || ecosystems;
}

/** An ecosystem updated by bots only in a repository without a bot: the rule gives it a note (decision D-151). */
function hasUnprotected(scope: RuleScope): boolean {
  return scope.project === undefined && scope.detection.bots.length === 0 && botEcosystemsInUse(scope).length > 0;
}

export const botCooldownMismatch: Rule = {
  id: 'bot-cooldown-mismatch',
  checks: 'Update bots wait at least as long as the package manager, and for the actions of workflows and the dependencies of Cargo, Go modules, Maven, Gradle and NuGet as long as the policy, before proposing a new version',
  summary: 'An update bot waits less than the package manager, or for the actions of workflows and the dependencies of the ecosystems updated by bots only less than the policy, before proposing a new version.',
  description:
    'The bot then opens pull requests with versions the package manager would not pick yet: they fail where the manager re-checks the lockfile or bring in younger versions, and security updates that skip the bot delay fail too. A Dependabot cooldown with an include list delays only the dependencies it names; a Renovate packageRules entry can shorten the delay for a registry, manager, category, update type or the files and depType of actions, each is reported, and one with a matcher depcurfew cannot read gets a note. The actions of workflows and the dependencies of Cargo, Go, Maven, Gradle and NuGet must wait cooldown.minimum; without a bot, the latter get a note. An unreadable bot file (JSON5, a YAML alias) gets a note per package manager that waits. With projects, a bot file inside a project gets a note (bots read only the root\'s), and a project the root\'s Dependabot configuration leaves out gets a warning. A Dependabot composer entry gets a note: it counts from the release time the author sets.',
  help: 'Give the bot a delay at least as long as the package manager\'s, and for the actions of workflows and the ecosystems updated by bots only as long as cooldown.minimum (depcurfew apply does this).',
  level: 'error',
  requiresPolicy: false,
  applies: (scope) => (usesBot(scope) && hasReference(scope)) || hasUnprotected(scope),
  check(context) {
    // A project's own bot files are never read by the bot (decision D-107): the root run gives a note at each one.
    if (context.project !== undefined) return;
    unprotectedEcosystems(context);
    if (context.projects !== undefined) {
      projectBotNotes(context, context.projects);
      missingDependabotEntries(context, context.projects);
    }
    // Bots are configured from the root for every project in projects (decision D-100), so they wait for all of them.
    const sources = managerSources(context);
    if (sources.every((source) => source.managers.length === 0) && !hasReference(context)) return;
    const delays: BotDelay[] = [];
    for (const detected of context.detection.bots) {
      const bot = context.tools.find((entry) => entry.id === detected.id);
      const file = detected.configFiles[0];
      if (bot === undefined || file === undefined) continue;
      delays.push(...(unreadableBotFile(context, bot, file) ?? (detected.id === 'dependabot' ? dependabotDelays(context, bot, file) : renovateDelays(context, bot, file))));
    }
    const actions = actionsReference(context);
    for (const delay of delays) {
      // The actions of the workflows wait as long as cooldown.minimum (the delays exist only when the policy covers them).
      if (delay.actions === true) {
        if (actions !== undefined) compare(context, delay, actions);
        continue;
      }
      // So do the dependencies of the ecosystems updated by bots only (decision D-151).
      if (delay.ecosystem !== undefined) {
        const reference = ecosystemReference(context, delay.ecosystem);
        if (reference !== undefined) compare(context, delay, reference);
        continue;
      }
      for (const { manager, source } of sources.flatMap((item) => item.managers.filter((entry) => delay.managers.includes(entry.id)).map((manager) => ({ manager, source: item })))) {
        const knowledge = context.tools.find((entry) => entry.id === manager.id);
        if (knowledge === undefined) continue;
        const found = managerDelay(source.context, manager, knowledge);
        if (found === undefined || delay.location === undefined) continue;
        // A project's manager is named with its directory, and the file of its delay relative to the root.
        const tool = source.project === undefined ? knowledge : { ...knowledge, name: `${knowledge.name} in ${source.project}` };
        const own = { ...found, origin: source.relocate(found.origin) };
        // Dependabot's composer delay counts from the author's time: a note also when the delay is long enough or too short.
        const timeNote = () => {
          if (delay.bot.id === 'dependabot' && manager.id === 'composer' && own.minutes > 0 && delay.unreadableFile === undefined) composerTimeNote(context, delay, knowledge.name, source.project);
        };
        if (compare(context, delay, managerReference(tool, own))) {
          if (delay.secondary !== true) timeNote();
          continue;
        }
        if (delay.secondary === true) continue;
        if (delay.securityBypass && own.minutes > 0 && rechecksLockfile(tool, manager) && !exemptsSecurityFixes(delay.bot, tool.id, found.location?.file)) {
          context.report({
            level: 'warning',
            location: delay.location,
            message: `${delay.bot.name} security updates skip its delay, but ${tool.name} re-checks the lockfile and waits ${describe(own.minutes)} (${own.origin}); a security fix younger than that fails to install`,
            fix: `When a security update fails, exempt the fixed package in ${source.project === undefined ? `the ${tool.name} exclusion list` : `the exclusion list of ${tool.name}`} until the delay has passed`,
          });
        }
        timeNote();
      }
    }
  },
};

const isReleaseTime = (value: unknown): value is { field: string; ignores: string; composerVersion: string } =>
  isRecord(value) && typeof value['field'] === 'string' && typeof value['ignores'] === 'string' && typeof value['composerVersion'] === 'string';

/**
 * Dependabot counts its composer cooldown from the time the package author sets (extra.composerReleaseTime), and
 * updates composer.lock with a Composer that has no cooldown policy; composer install then installs the locked version
 * without Composer's cooldown, which counts from Packagist's published-time. In a repository with projects, the
 * project is named where composer install runs, not in the name of the tool (decision D-136).
 */
function composerTimeNote(context: RuleContext, delay: BotDelay, manager: string, project?: string): void {
  if (delay.bot.extra?.['composerReleaseTime'] === undefined || delay.location === undefined) return;
  const fact = extraOf(delay.bot, 'composerReleaseTime', isReleaseTime);
  // Composer 2.10.3 leaves config.policy out of content-hash (extra.composerContentHash, decision D-134).
  const hash = delay.bot.extra['composerContentHash'] === undefined ? undefined : extraOf(delay.bot, 'composerContentHash', isContentHash);
  const composer = context.tools.find((tool) => tool.id === 'composer');
  const relock = composer?.extra?.['contentHash'] === undefined ? undefined : extraOf(composer, 'contentHash', isRelock);
  const hashText =
    hash === undefined || hash.hashesPolicy || relock === undefined
      ? ''
      : `; the ${hash.key} of each ${hash.file} it writes leaves out config.policy, so ${manager} ${relock.since} and later read that ${hash.file} as out of date (composer install warns, composer validate fails)`;
  const hashFix = hashText === '' ? '' : `, run ${relock?.command ?? ''} on the branch of each such pull request and commit ${hash?.file ?? ''}`;
  context.report({
    level: 'note',
    location: delay.location,
    message: `${delay.bot.name} counts the cooldown of ${delay.scope} from ${fact.field}, the release time the package author writes, not from ${fact.ignores}, when Packagist received the version, and it updates composer.lock with Composer ${fact.composerVersion}, which has no cooldown; a version published with an older ${fact.field} is proposed at once, and composer install${project === undefined ? '' : ` in ${project}`} takes it from composer.lock without ${manager}'s cooldown${hashText}`,
    fix: `Check the publication date on Packagist before merging ${delay.bot.name}'s composer pull requests${hashFix}, or update Composer packages with a bot that counts from ${fact.ignores}`,
  });
}

const isContentHash = (value: unknown): value is { hashesPolicy: boolean; file: string; key: string } =>
  isRecord(value) && typeof value['hashesPolicy'] === 'boolean' && typeof value['file'] === 'string' && typeof value['key'] === 'string';

const isRelock = (value: unknown): value is { since: string; command: string } => isRecord(value) && typeof value['since'] === 'string' && typeof value['command'] === 'string';
