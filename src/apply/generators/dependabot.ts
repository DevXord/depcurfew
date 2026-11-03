// Dependabot: cooldown in every updates entry of a JavaScript, Python or Composer ecosystem in dependabot.yml, in
// the github-actions entries when the repository has workflows (decision D-130), and in the entries of the ecosystems
// updated by bots only: cargo, gomod, maven, gradle and nuget (decision D-151). semver-*-days keys that are already
// there are raised to the policy's delay (never lowered, never added) where the ecosystem reads them; other keys
// (include) stay. Each package entry gets the exclusions of its registry: npm names for npm, bun and deno, pypi: names
// for pip and uv, composer: names for composer. The policy's exclusions name none of the actions or of the dependencies
// of the ecosystems updated by bots only, so their entries get none, and keep their own.
import { convertCooldown } from '../../policy/convert.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { patternsFor } from '../../policy/package-pattern.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions, sameList } from './common.ts';
import type { BotGenerator } from './context.ts';
import { rejectsYamlAliases, yamlAliasLine } from '../../doctor/settings.ts';
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
  const patternsOf = (ecosystem: string): string[] => {
    const covered = Array.isArray(managers[ecosystem]) ? (managers[ecosystem] as unknown[]) : [];
    const tool = context.tools.find((entry) => covered.includes(entry.id));
    return exclusions(context, patternsFor(policy.cooldown?.exclude ?? [], tool === undefined ? 'npm' : ecosystemOfTool(tool))) ?? [];
  };
  let configured = 0;
  // The other entries that get the cooldown: github-actions and the ecosystems updated by bots only.
  const others = new Set<string>();
  // A dependabot.yml may have an entry for every directory of a monorepo: the edits are made together.
  const edits: [(string | number)[], unknown][] = [];
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
    }
  });
  if (edits.length > 0) yaml.setMany(edits);
  // Without package managers to update, entries for the actions and the ecosystems updated by bots only are what there
  // is to configure.
  const managersInUse = context.tools.some((entry) => entry.kind === 'package-manager' && context.targets.has(entry.id));
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
