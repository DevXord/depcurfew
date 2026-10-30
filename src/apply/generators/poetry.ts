// Poetry: solver.min-release-age and the installer build settings in poetry.toml, the only project file Poetry reads
// them from: one managed block in [solver] and one in [installer], each marked with its table.
import { hasManagedLines } from '../block.ts';
import { extraOf, firstFile, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { cooldownValue, eachSource, exclusions, splitDotted } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { buildAllowList, buildSwitchScopeWarning, forcedBuildWarning, pythonNames, tomlValue } from './python.ts';

function writeTable(context: Context, file: string, table: string, entries: readonly string[], managed: readonly string[]): void {
  if (entries.length > 0 || (context.exists(file) && hasManagedLines(context.read(file)))) context.toml(file, table, entries, managed, table);
}

export const poetry: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? 'poetry.toml';
  let minutes: number | undefined;

  const solver = { table: 'solver', entries: [] as string[], managed: [] as string[] };
  if (policy.cooldown !== undefined) {
    const setting = splitDotted(settingOf(tool.cooldown.setting) ?? 'solver.min-release-age');
    solver.table = setting.table;
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      solver.entries.push(`${setting.key} = ${tomlValue(cooldown.value)}`);
      solver.managed.push(setting.key);
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined) {
        const { key } = splitDotted(excludeSetting);
        solver.managed.push(key);
        // The 2.5.1 code reads the list as it is, so it is written as a TOML array (see extra.excludeFormat).
        const names = pythonNames(patterns);
        if (names.length > 0) solver.entries.push(`${key} = ${tomlValue(names)}`);
      }
    }
  }
  writeTable(context, file, solver.table, solver.entries, solver.managed);

  const installer = { table: 'installer', entries: [] as string[], managed: [] as string[] };
  if (policy.installScripts?.default === 'deny') {
    const build = extraOf(tool, 'buildSwitch', isSwitch);
    const { table, key } = splitDotted(build.setting);
    installer.table = table;
    if (context.supports(build.since, build.setting)) {
      installer.entries.push(`${key} = ${tomlValue(build.value)}`);
      installer.managed.push(key);
      context.warn({ code: 'build-switch-install-only', message: `${context.name}: ${build.setting} applies when packages are installed; poetry lock may still build source distributions to read their dependencies` });
      buildSwitchScopeWarning(context, build.setting, build.covers);
      const setting = settingOf(tool.installScripts.allowList.setting);
      if (setting !== null) {
        installer.managed.push(splitDotted(setting).key);
        const wanted = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting);
        const names = wanted ? buildAllowList(context, setting) : [];
        if (names.length > 0) installer.entries.push(`${splitDotted(setting).key} = ${tomlValue(names)}`);
        forcedBuildWarning(context, setting, names);
      }
    }
  }
  writeTable(context, file, installer.table, installer.entries, installer.managed);

  eachSource(context, () => undefined);
  return minutes;
};
