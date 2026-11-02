// Dependabot: cooldown in every updates entry of a JavaScript or Python ecosystem in dependabot.yml, and in the
// github-actions entries when the repository has workflows (decision D-130). semver-*-days keys that are already there
// are raised to the policy's delay (never lowered, never added) where the ecosystem reads them; other keys (include)
// stay. Each package entry gets the exclusions of its registry: npm names for npm, bun and deno, pypi: names for pip
// and uv. The policy's exclusions are package names, so a github-actions entry gets none, and keeps its own.
import { convertCooldown } from '../../policy/convert.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { patternsFor } from '../../policy/package-pattern.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions, sameList } from './common.ts';
import type { BotGenerator } from './context.ts';

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
  const keys = extraOf(tool, 'cooldownKeys', isKeys);
  const managers = extraOf(tool, 'ecosystems', isRecord);
  const ecosystems = Object.keys(managers);
  // The actions of the workflows wait as long as the packages, when there are workflows (decision D-130).
  const actions = tool.extra?.['githubActions'] === undefined || repository.workflows.length === 0 ? undefined : extraOf(tool, 'githubActions', isActionsEcosystem);
  const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
  const yaml = context.yaml(file);
  const updates = yaml.get(['updates']);
  const patternsOf = (ecosystem: string): string[] => {
    const covered = Array.isArray(managers[ecosystem]) ? (managers[ecosystem] as unknown[]) : [];
    const python = context.tools.some((entry) => covered.includes(entry.id) && ecosystemOfTool(entry) === 'pypi');
    return exclusions(context, patternsFor(policy.cooldown?.exclude ?? [], python ? 'pypi' : 'npm')) ?? [];
  };
  let configured = 0;
  let configuredActions = 0;
  // A dependabot.yml may have an entry for every directory of a monorepo: the edits are made together.
  const edits: [(string | number)[], unknown][] = [];
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry)) return;
    const ecosystem = String(entry['package-ecosystem']);
    const forActions = actions !== undefined && ecosystem === actions.ecosystem;
    if (!forActions && !ecosystems.includes(ecosystem)) return;
    if (forActions) configuredActions += 1;
    else configured += 1;
    // The exclusions of the policy name packages, never actions: a github-actions entry keeps its own.
    const patterns = forActions ? undefined : patternsOf(ecosystem);
    const semverDays = forActions && !actions.semverDays ? [] : keys.semverDays;
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
  // Without package managers to update, entries for the actions alone are what there is to configure.
  const managersInUse = context.tools.some((entry) => entry.kind === 'package-manager' && context.targets.has(entry.id));
  if (configured === 0 && (configuredActions === 0 || managersInUse)) {
    context.warn({
      code: 'bot-entries-missing',
      location: { file },
      message:
        configuredActions === 0
          ? `${context.name}: no ${ecosystems.join(', ')} entries in ${file}; nothing to configure`
          : `${context.name}: no ${ecosystems.join(', ')} entries in ${file}; only the ${actions?.ecosystem ?? ''} entries get the cooldown`,
      fix: `Add an updates entry for each package manager Dependabot should update to ${file}, then run depcurfew apply again`,
    });
  }
};
