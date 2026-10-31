// Yarn (Berry): settings in .yarnrc.yml, always written explicitly so that Yarn's upgrade migration does not
// write weaker values; the per-package allow-list is dependenciesMeta in the root package.json.
import { extraOf, firstFile, isRecord, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, sameList, writeDenyList } from './common.ts';
import type { ManagerGenerator } from './context.ts';

interface ScriptsSwitch {
  setting: string;
  allow: unknown;
  deny: unknown;
}

const isScriptsSwitch = (value: unknown): value is ScriptsSwitch =>
  isRecord(value) && typeof value['setting'] === 'string' && 'allow' in value && 'deny' in value;

export const yarn: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const yaml = context.yaml(firstFile(tool.cooldown.configFiles) ?? '.yarnrc.yml');
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'npmMinimalAgeGate';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      yaml.set([setting], cooldown.value);
    }
    const excludeSetting = settingOf(tool.cooldown.exclude.setting);
    const patterns = cooldown === undefined ? undefined : exclusions(context);
    if (excludeSetting !== null && patterns !== undefined && (patterns.length > 0 || yaml.get([excludeSetting]) !== undefined)) {
      if (!sameList(yaml.get([excludeSetting]), patterns)) yaml.set([excludeSetting], patterns);
    }
  }

  if (policy.installScripts !== undefined) {
    const scripts = extraOf(tool, 'scriptsSwitch', isScriptsSwitch);
    const deny = policy.installScripts.default === 'deny';
    yaml.set([scripts.setting], deny ? scripts.deny : scripts.allow);
    const template = settingOf(tool.installScripts.allowList.setting);
    if (deny && template !== null && policy.installScripts.allow.length > 0) {
      if (context.supports(sinceOf(tool.installScripts.allowList.availableSince), template)) {
        const json = context.json(settingOf(tool.installScripts.allowList.file) ?? 'package.json');
        for (const name of allowedNames(context, template.split('.')[0] ?? template)) {
          const path = template.split('.').map((segment) => (segment === '<package>' ? name : segment));
          if (json.get(path) !== true) json.set(path, true);
        }
      }
    }
    if (deny) writeDenyList(context);
  }

  eachSource(context, (_kind, setting, access) => {
    const value = access === 'deny' ? [] : ['**'];
    if (!sameList(yaml.get([setting]), value)) yaml.set([setting], value);
  });
  return minutes;
};
