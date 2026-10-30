// Dependabot: cooldown in every updates entry of a JavaScript or Python ecosystem in dependabot.yml. semver-*-days
// keys that are already there are raised to the policy's delay (never lowered, never added); other keys (include)
// stay. Each entry gets the exclusions of its registry: npm names for npm, bun and deno, pypi: names for pip and uv.
import { convertCooldown } from '../../policy/convert.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
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

export const dependabot: BotGenerator = (context, duration) => {
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
    context.warn({ code: 'security-delay-unsupported', message: `${context.name} cannot delay security updates (cooldown applies to version updates only); securityUpdates "delay" not applied` });
  }
  const result = convertCooldown(tool, duration);
  if (!result.ok) {
    context.warn({ code: 'cooldown-not-written', message: `${context.name}: cooldown not written: ${result.reason}`, ...(result.fix === undefined ? {} : { fix: result.fix }) });
    return;
  }
  const keys = extraOf(tool, 'cooldownKeys', isKeys);
  const managers = extraOf(tool, 'ecosystems', isRecord);
  const ecosystems = Object.keys(managers);
  const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
  const yaml = context.yaml(file);
  const updates = yaml.get(['updates']);
  const patternsOf = (ecosystem: string): string[] => {
    const covered = Array.isArray(managers[ecosystem]) ? (managers[ecosystem] as unknown[]) : [];
    const python = context.tools.some((entry) => covered.includes(entry.id) && ecosystemOfTool(entry) === 'pypi');
    return exclusions(context, patternsFor(policy.cooldown?.exclude ?? [], python ? 'pypi' : 'npm')) ?? [];
  };
  let configured = 0;
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry) || !ecosystems.includes(String(entry['package-ecosystem']))) return;
    configured += 1;
    const patterns = patternsOf(String(entry['package-ecosystem']));
    const current = entry[setting];
    if (!isRecord(current)) {
      yaml.set(['updates', index, setting], { [keys.days]: result.value, ...(patterns.length > 0 ? { [keys.exclude]: patterns } : {}) });
      return;
    }
    yaml.set(['updates', index, setting, keys.days], result.value);
    for (const key of keys.semverDays) {
      const days = current[key];
      if (typeof days === 'number' && typeof result.value === 'number' && days < result.value) yaml.set(['updates', index, setting, key], result.value);
    }
    if ((patterns.length > 0 || keys.exclude in current) && !sameList(current[keys.exclude], patterns)) {
      yaml.set(['updates', index, setting, keys.exclude], patterns);
    }
  });
  if (configured === 0) {
    context.warn({
      code: 'bot-entries-missing',
      location: { file },
      message: `${context.name}: no ${ecosystems.join(', ')} entries in ${file}; nothing to configure`,
      fix: `Add an updates entry for each package manager Dependabot should update to ${file}, then run depcurfew apply again`,
    });
  }
};
