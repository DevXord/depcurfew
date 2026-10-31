// uv: exclude-newer and the build settings in a managed block: in uv.toml when the project has one (uv then ignores
// [tool.uv] in pyproject.toml), otherwise in [tool.uv] of pyproject.toml. Only the root is configured, because in a
// workspace uv reads the configuration of the root alone. A change to what uv.lock records means locking again.
import { hasManagedLines } from '../block.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { writeTomlBlock } from '../toml.ts';
import { cooldownValue, eachSource, exclusions } from './common.ts';
import type { ManagerGenerator } from './context.ts';
import { buildAllowList, forcedBuildWarning, pythonNames, relockWarning, tomlValue } from './python.ts';

export const uv: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const tables = extraOf(tool, 'configTables', isRecord);
  const file = context.exists('uv.toml') || !context.exists('pyproject.toml') ? 'uv.toml' : 'pyproject.toml';
  const table = typeof tables[file] === 'string' ? tables[file] : '';
  const entries: string[] = [];
  const managed: string[] = [];
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'exclude-newer';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting} = ${tomlValue(cooldown.value)}`);
      managed.push(setting);
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined) {
        managed.push(excludeSetting);
        const exempt = extraOf(tool, 'excludeValue', (value): value is boolean => typeof value === 'boolean');
        const names = pythonNames(patterns);
        if (names.length > 0) entries.push(`${excludeSetting} = { ${names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`).join(', ')} }`);
      }
    }
  }

  if (policy.installScripts?.default === 'deny') {
    const build = extraOf(tool, 'buildSwitch', isSwitch);
    if (context.supports(build.since, build.setting)) {
      entries.push(`${build.setting} = ${tomlValue(build.value)}`);
      managed.push(build.setting);
      const setting = settingOf(tool.installScripts.allowList.setting);
      if (setting !== null) {
        managed.push(setting);
        const wanted = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting);
        const names = wanted ? buildAllowList(context, setting) : [];
        if (names.length > 0) entries.push(`${setting} = ${tomlValue(names)}`);
        forcedBuildWarning(context, setting, names);
      }
    }
  }

  eachSource(context, () => undefined);

  // In pyproject.toml the marker names the table, because PDM may keep a block of its own in the same file.
  const label = table === '' ? undefined : table;
  if (entries.length > 0 || (context.exists(file) && hasManagedLines(context.read(file)))) {
    // Before the edit: the context reads a file as edited once its change is planned.
    relockWarning(context, file, table, (body) => writeTomlBlock(body, table, entries, managed, label));
    context.toml(file, table, entries, managed, label);
  }
  return minutes;
};
