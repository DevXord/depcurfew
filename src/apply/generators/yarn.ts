// Yarn (Berry): settings in .yarnrc.yml, always written explicitly so that Yarn's upgrade migration does not
// write weaker values; the per-package allow-list is dependenciesMeta in the root package.json.
import { yamlSetting } from '../../doctor/settings.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
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
  const file = firstFile(tool.cooldown.configFiles) ?? '.yarnrc.yml';
  const yaml = context.yaml(file);
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
    // The switch that allows every install script is turned off with the same warning as pnpm's and Deno's (D-116).
    const current = yaml.get([scripts.setting]);
    if (deny && current === scripts.allow) {
      const found = context.exists(file) ? yamlSetting(context.read(file), [scripts.setting]) : undefined;
      context.warn({
        code: 'allow-all-replaced',
        ...(found === undefined ? {} : { location: { file, line: found.line } }),
        message: `${context.name}: ${scripts.setting}: ${JSON.stringify(current)} in ${file}${found === undefined ? '' : ` (line ${found.line})`} allowed every install script; set to ${JSON.stringify(scripts.deny)} because the policy denies install scripts`,
        fix: `Add the packages whose install scripts must run to installScripts.allow in ${POLICY_FILE}, then run depcurfew apply again`,
      });
    }
    yaml.set([scripts.setting], deny ? scripts.deny : scripts.allow);
    context.writes('installScripts', scripts.setting, file);
    const template = settingOf(tool.installScripts.allowList.setting);
    if (deny && template !== null && policy.installScripts.allow.length > 0) {
      if (context.supports(sinceOf(tool.installScripts.allowList.availableSince), template)) {
        const listFile = settingOf(tool.installScripts.allowList.file) ?? 'package.json';
        const json = context.json(listFile);
        const names = allowedNames(context, template.split('.')[0] ?? template);
        if (names.length > 0) context.writes('installScripts', template, listFile);
        for (const name of names) {
          const path = template.split('.').map((segment) => (segment === '<package>' ? name : segment));
          if (json.get(path) !== true) json.set(path, true);
        }
      }
    }
    if (deny) writeDenyList(context);
  }

  eachSource(context, (_kind, setting, access) => {
    context.writes('sources', setting, file);
    const value = access === 'deny' ? [] : ['**'];
    if (!sameList(yaml.get([setting]), value)) yaml.set([setting], value);
  });
  return minutes;
};
