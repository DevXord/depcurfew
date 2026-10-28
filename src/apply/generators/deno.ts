// Deno: minimumDependencyAge (a number, or { age, exclude } with npm: specifiers) and allowScripts in deno.json.
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, cooldownValue, eachSource, exclusions } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';

const isString = (value: unknown): value is string => typeof value === 'string';

function configFile(context: Context): string {
  const manifests = context.tool.project?.manifests;
  const names = manifests !== undefined && manifests.status !== 'disputed' ? [...manifests.value] : ['deno.json'];
  return names.find((name) => context.workspace.exists(name)) ?? names[0] ?? 'deno.json';
}

export const deno: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const json = context.json(configFile(context));
  const prefix = extraOf(tool, 'npmSpecifierPrefix', isString);
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'minimumDependencyAge';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      const patterns = exclusions(context) ?? [];
      const excludeKey = (settingOf(tool.cooldown.exclude.setting) ?? 'minimumDependencyAge.exclude').split('.').at(-1) ?? 'exclude';
      const value =
        patterns.length > 0
          ? { [extraOf(tool, 'ageObjectKey', isString)]: cooldown.value, [excludeKey]: patterns.map((pattern) => `${prefix}${pattern}`) }
          : cooldown.value;
      json.set([setting], value);
    }
  }

  if (policy.installScripts !== undefined) {
    const allowAll = extraOf(tool, 'allowAllScripts', isSwitch);
    if (policy.installScripts.default === 'allow') {
      if (context.supports(allowAll.since, allowAll.setting)) json.set([allowAll.setting], allowAll.value);
    } else {
      const setting = settingOf(tool.installScripts.allowList.setting) ?? allowAll.setting;
      const since = sinceOf(tool.installScripts.allowList.availableSince);
      const wanted = policy.installScripts.allow.length > 0;
      const names = wanted && context.supports(since, setting) ? allowedNames(context, setting) : [];
      const specifiers = names.map((name) => `${prefix}${name}`);
      const current = json.get([setting]);
      // The object form { allow, deny } keeps its deny list; only its allow part is managed.
      const path = isRecord(current) ? [setting, 'allow'] : [setting];
      const allowed = isRecord(current) ? current['allow'] : current;
      if (allowed === allowAll.value && context.atLeast(since)) {
        context.warn(`${context.name}: ${setting} allowed every install script; replaced with the policy's allow-list`);
        json.set(path, specifiers);
      } else if (specifiers.length > 0) {
        if (Array.isArray(allowed)) {
          for (const specifier of specifiers) if (!allowed.includes(specifier)) json.append(path, specifier);
        } else {
          json.set(path, specifiers);
        }
      }
    }
  }

  eachSource(context, () => undefined);
  return minutes;
};
