// Bun: [install] keys in a managed block in bunfig.toml; trustedDependencies in package.json.
import { BLOCK_START } from '../block.ts';
import { firstFile, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, sameList, splitDotted } from './common.ts';
import type { ManagerGenerator } from './context.ts';

export const bun: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? 'bunfig.toml';
  const entries: string[] = [];
  const managed: string[] = [];
  let table = 'install';
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = splitDotted(settingOf(tool.cooldown.setting) ?? 'install.minimumReleaseAge');
    table = setting.table;
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting.key} = ${cooldown.value}`);
      managed.push(setting.key);
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined) {
        const { key } = splitDotted(excludeSetting);
        managed.push(key);
        if (patterns.length > 0) entries.push(`${key} = [${patterns.map((pattern) => JSON.stringify(pattern)).join(', ')}]`);
      }
    }
  }

  if (policy.installScripts !== undefined) {
    if (policy.installScripts.default === 'allow') {
      context.warn({
        code: 'allow-all-unsupported',
        message: `${context.name} has no setting that allows every install script; "allow" not written`,
        fix: 'List the packages under installScripts.allow instead',
      });
    } else {
      const setting = settingOf(tool.installScripts.allowList.setting);
      const since = sinceOf(tool.installScripts.allowList.availableSince);
      if (setting !== null && context.supports(since, setting)) {
        const listFile = settingOf(tool.installScripts.allowList.file) ?? 'package.json';
        const names = policy.installScripts.allow.length > 0 ? allowedNames(context, setting) : [];
        const current = context.json(listFile).get([setting]);
        // Without package.json nothing is written (apply does not create manifests), so nothing is replaced either.
        if (current === undefined && context.exists(listFile)) {
          context.warn({
            code: 'built-in-list-replaced',
            message: `${context.name}: ${setting} replaces Bun's built-in list of trusted packages, so packages on that list no longer run install scripts unless listed`,
            fix: 'Add the ones that need their scripts to installScripts.allow',
          });
        }
        // Even an empty list is written: without one, the packages on Bun's built-in list still run their scripts.
        const list = Array.isArray(current) ? [...(current as unknown[])] : [];
        const merged = [...list, ...names.filter((name) => !list.includes(name))];
        if (current === undefined || !sameList(current, merged)) context.json(listFile).set([setting], merged);
      }
    }
  }

  eachSource(context, () => undefined);

  if (entries.length > 0 || context.read(file).includes(BLOCK_START)) context.toml(file, table, entries, managed);
  return minutes;
};
