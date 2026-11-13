// Dependabot: cooldown in every updates entry of a JavaScript, Python, Composer or Bundler ecosystem in dependabot.yml, in
// the github-actions entries when the repository has workflows (decision D-130), and in the entries of the ecosystems
// updated by bots only: cargo, gomod, maven, gradle and nuget (decision D-151). semver-*-days keys that are already
// there are raised to the policy's delay (never lowered, never added) where the ecosystem reads them; other keys
// (include) stay. Each package entry gets the exclusions of its registry: npm names for npm, bun and deno, pypi: names
// for pip and uv, composer: names for composer. The policy's exclusions name none of the actions, of the dependencies
// of the ecosystems updated by bots only or of the Ruby gems of bundler entries, so their entries get none, and keep
// their own (decision D-152). An include list, which limits the cooldown to the dependencies it names, and an exclude
// list such an entry keeps that matches every dependency stay too, with a warning: the cooldown apply writes covers
// only some dependencies there, or none (decision D-171). Names Psych would not read as text when written plain (yes,
// off, 1_0) are written in quotes (yaml-edit.ts, decision D-171).
import { convertCooldown } from '../../policy/convert.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { patternsFor } from '../../policy/package-pattern.ts';
import { extraOf, isRecord, settingOf, values, yamlOptionsFor } from '../facts.ts';
import { commentReplacedList, droppedYamlList, exclusions, sameList } from './common.ts';
import type { BotGenerator } from './context.ts';
import { rejectsYamlAliases, yamlAliasLine, yamlSetting } from '../../doctor/settings.ts';
import { matchesEveryName } from '../../doctor/renovate.ts';
import { botEcosystemFact } from '../../detect/bot-ecosystems.ts';
import type { BotOnlyEcosystemId, ToolKnowledge } from '../../knowledge/types.ts';
import { listing } from '../requirements.ts';

interface CooldownKeys {
  days: string;
  exclude: string;
  semverDays: string[];
}

const isKeys = (value: unknown): value is CooldownKeys =>
  isRecord(value) &&
  typeof value['days'] === 'string' &&
  typeof value['exclude'] === 'string' &&
  Array.isArray(value['semverDays']) &&
  value['semverDays'].every((key) => typeof key === 'string');

/** The github-actions ecosystem (extra.githubActions): whether it reads the semver-*-days keys. */
export interface ActionsEcosystem {
  ecosystem: string;
  semverDays: boolean;
}

export const isActionsEcosystem = (value: unknown): value is ActionsEcosystem =>
  isRecord(value) && typeof value['ecosystem'] === 'string' && typeof value['semverDays'] === 'boolean';

/** An ecosystem updated by bots only (extra.botOnlyEcosystems, decision D-151): its package-ecosystem and semver-*-days. */
export interface BotOnlyEntry extends ActionsEcosystem {
  id: BotOnlyEcosystemId;
}

/** The ecosystems updated by bots only, by their package-ecosystem; empty without the fact. */
export function botOnlyEntries(tool: ToolKnowledge): Map<string, BotOnlyEntry> {
  if (tool.extra?.['botOnlyEcosystems'] === undefined) return new Map();
  const fact = extraOf(tool, 'botOnlyEcosystems', (value): value is Record<string, unknown> => isRecord(value) && Object.values(value).every(isActionsEcosystem));
  return new Map(Object.entries(fact).map(([id, entry]) => [(entry as ActionsEcosystem).ecosystem, { id: id as BotOnlyEcosystemId, ...(entry as ActionsEcosystem) }]));
}

/**
 * bot-rule-shortens-delay for the updates entries that keep a list of their own that limits the cooldown apply writes
 * (decision D-171): an include list, which gives a cooldown only to the dependencies it names (extra.cooldownInclude),
 * and an exclude list that matches every dependency, which apply keeps where the policy names none of the entry's
 * dependencies (the actions, the ecosystems updated by bots only and Ruby gems, decision D-152). doctor reports both
 * as well (bot-cooldown-mismatch, broad-exclusion). The lines are those of the file as apply leaves it.
 */
function limitedCooldowns(
  context: Parameters<BotGenerator>[0],
  file: string,
  setting: string,
  excludeKey: string,
  entries: readonly { index: number; ecosystem: string; cooldown: Record<string, unknown>; kept: boolean; other?: ActionsEcosystem | BotOnlyEntry }[],
): void {
  if (entries.length === 0) return;
  const { tool } = context;
  const include = extraOf(tool, 'cooldownInclude', (value): value is { key: string } => isRecord(value) && typeof value['key'] === 'string');
  const text = context.read(file);
  const yaml = yamlOptionsFor(file, [tool]);
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  for (const { index, ecosystem, cooldown, kept, other } of entries) {
    const where = (key: string) => {
      const line = yamlSetting(text, ['updates', String(index), setting, key], yaml)?.line;
      return { location: line === undefined ? { file } : { file, line }, at: `cooldown.${key} in updates[${index}] (${ecosystem}) of ${file}${line === undefined ? '' : ` (line ${line})`}` };
    };
    // As doctor reads it: a list without "*" (bot-cooldown-mismatch).
    const included = strings(cooldown[include.key]);
    if (included.length > 0 && !included.some((pattern) => /^\*+$/u.test(pattern))) {
      const { location, at } = where(include.key);
      context.warn({
        code: 'bot-rule-shortens-delay',
        location,
        message: `${context.name}: ${at} names only ${listing(included)}, so the cooldown depcurfew apply writes there covers only these dependencies, and ${context.name} proposes updates of every other dependency of the entry without waiting`,
        fix: `Remove ${include.key} from the cooldown of updates[${index}] in ${file}, so that the cooldown covers every dependency, and list the dependencies that need no delay ${kept ? `under cooldown.${excludeKey} there` : `in cooldown.exclude in ${POLICY_FILE}`}`,
      });
    }
    // The exclude list apply replaced with the policy's names is not the entry's own any more.
    const broad = kept ? strings(cooldown[excludeKey]).find(matchesEveryName) : undefined;
    if (broad !== undefined) {
      const { location, at } = where(excludeKey);
      const names = other === undefined ? 'Ruby gems' : 'id' in other ? `${botEcosystemFact(other.id)?.client ?? other.ecosystem} dependencies` : 'actions';
      context.warn({
        code: 'bot-rule-shortens-delay',
        location,
        message: `${context.name}: ${at} contains ${JSON.stringify(broad)}, so ${context.name} applies no cooldown to these updates, the one depcurfew apply writes included; depcurfew apply keeps this list, because cooldown.exclude in ${POLICY_FILE} names no ${names}`,
        fix: `Remove ${JSON.stringify(broad)} from cooldown.${excludeKey} in updates[${index}] of ${file} and list only the dependencies that need the exception`,
      });
    }
  }
}

export const dependabot: BotGenerator = (context, duration, repository) => {
  const { tool, policy } = context;
  if (policy.cooldown === undefined || duration === undefined) return;
  const file = (values(tool.cooldown.configFiles)[0] ?? []).find((name) => context.exists(name));
  if (file === undefined) {
    context.warn({
      code: 'bot-config-missing',
      message: `${context.name}: no configuration file found; depcurfew does not create one`,
      fix: 'Add .github/dependabot.yml if you use Dependabot, then run depcurfew apply again',
    });
    return;
  }
  if (policy.cooldown.securityUpdates === 'delay') {
    context.warn({
      code: 'security-delay-unsupported',
      message: `${context.name} cannot delay security updates (cooldown applies to version updates only); securityUpdates "delay" not applied`,
      fix: `Review ${context.name} security pull requests before merging them, or set cooldown.securityUpdates to "bypass" in ${POLICY_FILE}, which is what ${context.name} does`,
    });
  }
  const result = convertCooldown(tool, duration);
  if (!result.ok) {
    context.warn({ code: 'cooldown-not-written', message: `${context.name}: cooldown not written: ${result.reason}`, fix: result.fix });
    return;
  }
  // Dependabot reads no configuration from a file with a YAML alias (extra.yamlAliases), and depcurfew does not read
  // the delays of such a file (decision D-135), so apply says so where doctor gives a note (decision D-141).
  const alias = rejectsYamlAliases(tool) ? yamlAliasLine(context.read(file)) : undefined;
  if (alias !== undefined) {
    context.warn({
      code: 'bot-config-unreadable',
      location: { file, line: alias },
      message: `${context.name}: ${file} uses a YAML alias (line ${alias}), which ${context.name} does not accept, so it reads no configuration from the file, the cooldown depcurfew apply writes included; depcurfew does not read the delays such a file sets either, so it cannot tell whether this change shortens one`,
      fix: `Write the value out in place of the alias on line ${alias} of ${file}, then run depcurfew apply again`,
    });
  }
  const keys = extraOf(tool, 'cooldownKeys', isKeys);
  const managers = extraOf(tool, 'ecosystems', isRecord);
  const ecosystems = Object.keys(managers);
  // The actions of the workflows wait as long as the packages, when there are workflows (decision D-130).
  const actions = tool.extra?.['githubActions'] === undefined || repository.workflows.length === 0 ? undefined : extraOf(tool, 'githubActions', isActionsEcosystem);
  // So do the dependencies of the ecosystems updated by bots only, wherever an entry names one (decision D-151).
  const botOnly = botOnlyEntries(tool);
  const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
  const yaml = context.yaml(file);
  const updates = yaml.get(['updates']);
  // undefined for a registry the policy has no names for (Ruby gems, decision D-152): such an entry keeps its own exclude.
  const patternsOf = (ecosystem: string): string[] | undefined => {
    const covered = Array.isArray(managers[ecosystem]) ? (managers[ecosystem] as unknown[]) : [];
    const tool = context.tools.find((entry) => covered.includes(entry.id));
    const registry = tool === undefined ? 'npm' : ecosystemOfTool(tool);
    if (registry === 'rubygems') return undefined;
    return exclusions(context, patternsFor(policy.cooldown?.exclude ?? [], registry)) ?? [];
  };
  let configured = 0;
  // The other entries that get the cooldown: github-actions and the ecosystems updated by bots only.
  const others = new Set<string>();
  // A dependabot.yml may have an entry for every directory of a monorepo: the edits are made together.
  const edits: [(string | number)[], unknown][] = [];
  const dropped: { path: string[]; old: unknown[] }[] = [];
  // Entries whose own lists limit the cooldown apply writes (decision D-171), checked on the file as apply leaves it.
  const limited: { index: number; ecosystem: string; cooldown: Record<string, unknown>; kept: boolean; other?: ActionsEcosystem | BotOnlyEntry }[] = [];
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry)) return;
    const ecosystem = String(entry['package-ecosystem']);
    const other = actions !== undefined && ecosystem === actions.ecosystem ? actions : botOnly.get(ecosystem);
    if (other === undefined && !ecosystems.includes(ecosystem)) return;
    if (other !== undefined) others.add(other.ecosystem);
    else configured += 1;
    // The exclusions of the policy name npm, Python and Composer packages, never actions or the dependencies of the
    // ecosystems updated by bots only: such an entry keeps its own.
    const patterns = other !== undefined ? undefined : patternsOf(ecosystem);
    const semverDays = other !== undefined && !other.semverDays ? [] : keys.semverDays;
    const current = entry[setting];
    if (isRecord(current)) limited.push({ index, ecosystem, cooldown: current, kept: patterns === undefined, ...(other === undefined ? {} : { other }) });
    if (!isRecord(current)) {
      edits.push([['updates', index, setting], { [keys.days]: result.value, ...(patterns !== undefined && patterns.length > 0 ? { [keys.exclude]: patterns } : {}) }]);
      return;
    }
    edits.push([['updates', index, setting, keys.days], result.value]);
    for (const key of semverDays) {
      const days = current[key];
      if (typeof days === 'number' && typeof result.value === 'number' && days < result.value) edits.push([['updates', index, setting, key], result.value]);
    }
    if (patterns !== undefined && (patterns.length > 0 || keys.exclude in current) && !sameList(current[keys.exclude], patterns)) {
      edits.push([['updates', index, setting, keys.exclude], patterns]);
      // Entries written by hand that the policy does not name stay as a comment (decision D-167).
      const path = ['updates', String(index), setting, keys.exclude];
      const old = droppedYamlList(context, file, path, patterns);
      if (old !== undefined) dropped.push({ path, old });
    }
  });
  if (edits.length > 0) yaml.setMany(edits);
  for (const { path, old } of dropped) commentReplacedList(context, file, path, old);
  limitedCooldowns(context, file, setting, keys.exclude, limited);
  // Without package managers to update, entries for the actions and the ecosystems updated by bots only are what there
  // is to configure.
  // A package manager whose dependencies only the entries of the ecosystems updated by bots only cover (Cargo, until
  // apply writes its delay, E06) needs no entry of the ecosystems above.
  const covered = new Set(Object.values(managers).flatMap((ids) => (Array.isArray(ids) ? ids : [])));
  const managersInUse = context.tools.some((entry) => entry.kind === 'package-manager' && context.targets.has(entry.id) && covered.has(entry.id));
  if (configured === 0 && (others.size === 0 || managersInUse)) {
    context.warn({
      code: 'bot-entries-missing',
      location: { file },
      message:
        others.size === 0
          ? `${context.name}: no ${ecosystems.join(', ')} entries in ${file}; nothing to configure`
          : `${context.name}: no ${ecosystems.join(', ')} entries in ${file}; only the ${listing([...others])} entries get the cooldown`,
      fix: `Add an updates entry for each package manager Dependabot should update to ${file}, then run depcurfew apply again`,
    });
  }
};
