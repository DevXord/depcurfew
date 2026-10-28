// npm: .npmrc keys in a managed block; the allowScripts allow-list in the root package.json.
import { BLOCK_START } from '../block.ts';
import { extraOf, firstFile, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, cooldownValue, eachSource, exclusions } from './common.ts';
import type { ManagerGenerator } from './context.ts';

const isString = (value: unknown): value is string => typeof value === 'string';

export const npm: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? '.npmrc';
  const entries: string[] = [];
  const managed: string[] = [];
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'min-release-age';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting}=${cooldown.value}`);
      managed.push(setting);
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined && context.atLeast(sinceOf(tool.cooldown.exclude.availableSince))) {
        const suffix = extraOf(tool, 'npmrcListSyntax', isString);
        for (const pattern of patterns) entries.push(`${excludeSetting}${suffix}=${pattern}`);
        managed.push(excludeSetting);
      }
    }
  }

  if (policy.installScripts !== undefined) {
    const allowAll = extraOf(tool, 'allowAllScripts', isSwitch);
    if (policy.installScripts.default === 'allow') {
      if (context.supports(allowAll.since, allowAll.setting)) {
        entries.push(`${allowAll.setting}=${String(allowAll.value)}`);
        managed.push(allowAll.setting);
      }
    } else {
      if (context.atLeast(allowAll.since)) managed.push(allowAll.setting);
      const setting = settingOf(tool.installScripts.allowList.setting);
      const listFile = settingOf(tool.installScripts.allowList.file) ?? 'package.json';
      if (setting !== null) {
        const wanted = policy.installScripts.allow.length > 0;
        if (wanted && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting)) {
          const json = context.json(listFile);
          for (const name of allowedNames(context, setting)) if (json.get([setting, name]) !== true) json.set([setting, name], true);
        }
      }
    }
  }

  eachSource(context, (_kind, setting, access) => {
    entries.push(`${setting}=${access === 'deny' ? 'none' : 'all'}`);
    managed.push(setting);
  });

  if (entries.length > 0 || context.workspace.read(file).includes(BLOCK_START)) context.ini(file, entries, managed);
  return minutes;
};
