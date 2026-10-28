// Dependabot: cooldown in every updates entry of a JavaScript ecosystem in dependabot.yml. Keys inside an
// existing cooldown block that depgate does not manage (semver-*-days, include) stay as they are.
import { convertCooldown } from '../../policy/convert.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions, sameList } from './common.ts';
import type { BotGenerator } from './context.ts';

interface CooldownKeys {
  days: string;
  exclude: string;
}

const isKeys = (value: unknown): value is CooldownKeys =>
  isRecord(value) && typeof value['days'] === 'string' && typeof value['exclude'] === 'string';

export const dependabot: BotGenerator = (context, duration) => {
  const { tool, policy, workspace } = context;
  if (policy.cooldown === undefined || duration === undefined) return;
  const file = (values(tool.cooldown.configFiles)[0] ?? []).find((name) => workspace.exists(name));
  if (file === undefined) {
    context.warn(`${context.name}: no configuration file found; depgate does not create one`);
    return;
  }
  if (policy.cooldown.securityUpdates === 'delay') {
    context.warn(`${context.name} cannot delay security updates (cooldown applies to version updates only); securityUpdates "delay" not applied`);
  }
  const result = convertCooldown(tool, duration);
  if (!result.ok) {
    context.warn(`${context.name}: cooldown not written: ${result.reason}`);
    return;
  }
  const keys = extraOf(tool, 'cooldownKeys', isKeys);
  const ecosystems = Object.keys(extraOf(tool, 'ecosystems', isRecord));
  const setting = settingOf(tool.cooldown.setting) ?? 'cooldown';
  const yaml = context.yaml(file);
  const updates = yaml.get(['updates']);
  const patterns = exclusions(context) ?? [];
  let configured = 0;
  (Array.isArray(updates) ? updates : []).forEach((entry: unknown, index) => {
    if (!isRecord(entry) || !ecosystems.includes(String(entry['package-ecosystem']))) return;
    configured += 1;
    const current = entry[setting];
    if (!isRecord(current)) {
      yaml.set(['updates', index, setting], { [keys.days]: result.value, ...(patterns.length > 0 ? { [keys.exclude]: patterns } : {}) });
      return;
    }
    yaml.set(['updates', index, setting, keys.days], result.value);
    if ((patterns.length > 0 || keys.exclude in current) && !sameList(current[keys.exclude], patterns)) {
      yaml.set(['updates', index, setting, keys.exclude], patterns);
    }
  });
  if (configured === 0) context.warn(`${context.name}: no ${ecosystems.join(', ')} entries in ${file}; nothing to configure`);
};
