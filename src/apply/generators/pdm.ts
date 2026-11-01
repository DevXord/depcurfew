// PDM: exclude-newer, its per-package overrides and the build settings in one managed block in [tool.pdm.resolution]
// of pyproject.toml, the only project file PDM reads them from. Durations are written as PDM's N{h|d|w}. pdm.lock
// is checked against that whole table, so a change to it means locking again.
import { hasManagedLines } from '../block.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { writeTomlBlock } from '../toml.ts';
import { cooldownValue, eachSource, exclusions } from './common.ts';
import type { ManagerGenerator } from './context.ts';
import { buildAllowList, buildSwitchScopeWarning, compactDuration, forcedBuildWarning, pythonNames, relockWarning, tomlValue } from './python.ts';

export const pdm: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const tables = extraOf(tool, 'configTables', isRecord);
  const file = 'pyproject.toml';
  const table = typeof tables[file] === 'string' ? tables[file] : 'tool.pdm.resolution';
  const entries: string[] = [];
  const managed: string[] = [];
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'exclude-newer';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting} = ${tomlValue(compactDuration(String(cooldown.value)))}`);
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
      context.writes('installScripts', build.setting, file, table);
      buildSwitchScopeWarning(context, build.setting, build.covers);
      const setting = settingOf(tool.installScripts.allowList.setting);
      if (setting !== null) {
        managed.push(setting);
        const wanted = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting);
        const names = wanted ? buildAllowList(context, setting) : [];
        if (names.length > 0) {
          entries.push(`${setting} = ${tomlValue(names)}`);
          context.writes('installScripts', setting, file, table);
        }
        forcedBuildWarning(context, setting, names);
      }
    }
  }

  eachSource(context, () => undefined);

  // The marker names the table, because uv may keep a block of its own in the same pyproject.toml.
  if (entries.length > 0 || (context.exists(file) && hasManagedLines(context.read(file)))) {
    // Before the edit: the context reads a file as edited once its change is planned.
    relockWarning(context, file, table, (body) => writeTomlBlock(body, table, entries, managed, table));
    context.toml(file, table, entries, managed, table);
  }
  return minutes;
};
