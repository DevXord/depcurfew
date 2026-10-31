// python-config-ignored: Python settings written where the tool does not read them, or that another setting turns
// off, which look effective but are not: [tool.uv] next to a uv.toml, uv settings in workspace members, pip.conf in
// the project, options pip rejects in requirements files, an exclude-newer date that never moves (uv, PDM), PDM's uv
// mode, which installs without the build settings, and Pipenv's pure-Python resolver, which ignores cool-down-period.
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../../apply/facts.ts';
import { joinPath } from '../../detect/repository.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { requirementsFormatOf } from '../python-lockfiles.ts';
import { readPythonSetting, requirementsLongOptions, requirementsOptions, tomlSettingAt } from '../python.ts';
import type { Rule, RuleContext } from '../types.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The settings depcurfew manages for a Python tool, as keys of its configuration table. */
function managedKeys(tool: ToolKnowledge): string[] {
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  const required = tool.extra?.['requiredVersion'] === undefined ? undefined : extraOf(tool, 'requiredVersion', isRecord);
  return [settingOf(tool.cooldown.setting), settingOf(tool.cooldown.exclude.setting), build?.setting ?? null, settingOf(tool.installScripts.allowList.setting), typeof required?.['key'] === 'string' ? required['key'] : null].filter(
    (key): key is string => key !== null,
  );
}

/** The keys of a TOML table in a file that set one of `keys`, with their lines. */
function keysIn(context: RuleContext, file: string, table: readonly string[], keys: readonly string[]): { key: string; line: number }[] {
  return keys.flatMap((key) => {
    const found = tomlSettingAt(context.repository, file, [...table, key]);
    return found === undefined ? [] : [{ key, line: found.line }];
  });
}

function checkUv(context: RuleContext, tool: ToolKnowledge): void {
  const tables = extraOf(tool, 'configTables', isRecord);
  const order = extraOf(tool, 'configFileOrder', isStrings);
  const [winner, loser] = order;
  if (winner === undefined || loser === undefined) return;
  const keys = managedKeys(tool);
  const table = (file: string) => (String(tables[file] ?? '') === '' ? [] : String(tables[file]).split('.'));
  if (context.repository.isFile(winner)) {
    for (const { key, line } of keysIn(context, loser, table(loser), keys)) {
      context.report({
        location: { file: loser, line },
        message: `uv reads ${winner} and ignores [${String(tables[loser])}] in ${loser}, so ${key} here has no effect`,
        fix: `Move ${key} to ${winner}, or remove it from ${loser}`,
      });
    }
  }
  if (extraOf(tool, 'workspaceRootOnly', (value): value is boolean => typeof value === 'boolean')) {
    for (const member of context.detection.workspaces?.packages ?? []) {
      for (const file of order) {
        const path = joinPath(member, file);
        for (const { key, line } of keysIn(context, path, table(file), keys)) {
          context.report({
            location: { file: path, line },
            message: `uv reads settings only from the workspace root, so ${key} in ${path} has no effect`,
            fix: `Set ${key} in the root ${winner} or [${String(tables['pyproject.toml'])}] of the root pyproject.toml, and remove it from ${path}`,
          });
        }
      }
    }
  }
  fixedDate(context, tool);
}

/** An exclude-newer date, which never moves, where a duration was meant (uv, PDM). */
function fixedDate(context: RuleContext, tool: ToolKnowledge): void {
  const setting = settingOf(tool.cooldown.setting);
  const found = setting === null ? undefined : readPythonSetting(context.repository, tool, setting);
  if (found === undefined || !(typeof found.value === 'string' || typeof found.value === 'object') || !/^\d{4}-\d{2}-\d{2}/u.test(String(found.value))) return;
  const syntax = tool.extra?.['durationStrings'] === undefined ? undefined : extraOf(tool, 'durationStrings', isRecord)['syntax'];
  context.report({
    level: 'warning',
    location: { file: found.file, line: found.line },
    message: `${setting} is the fixed date ${String(found.value)}, so ${tool.name} never uses versions uploaded after it; that is a freeze, not a delay that moves with time`,
    fix: `Write a duration such as "${syntax === 'compact' ? '3d' : '3 days'}" (${tool.name} ${sinceOf(tool.cooldown.availableSince) ?? ''} or later), or let depcurfew apply write it from cooldown.minimum`,
  });
}

/** PDM in uv mode (use_uv in pdm.toml) installs with uv sync, without its build settings. */
function checkPdm(context: RuleContext, tool: ToolKnowledge): void {
  fixedDate(context, tool);
  const mode = tool.extra?.['uvMode'] === undefined ? undefined : extraOf(tool, 'uvMode', isRecord);
  if (typeof mode?.['file'] !== 'string' || typeof mode['key'] !== 'string') return;
  const found = tomlSettingAt(context.repository, mode['file'], [mode['key']]);
  if (found?.value !== true) return;
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  if (build === undefined || readPythonSetting(context.repository, tool, build.setting) === undefined) return;
  context.report({
    level: 'warning',
    location: { file: found.file, line: found.line },
    message: `${mode['key']} in ${found.file} makes ${tool.name} install with uv sync, which it runs without ${build.setting}, so packages may still be built from source when installing`,
    fix: `Remove ${mode['key']} from ${found.file}, or forbid building in uv too ([tool.uv] no-build = true in pyproject.toml)`,
  });
}

/** Pipenv's pure-Python resolver (resolver_backend = "pure-python") locks without cool-down-period. */
function checkPipenv(context: RuleContext, tool: ToolKnowledge): void {
  const bypass = tool.extra?.['resolverBypass'] === undefined ? undefined : extraOf(tool, 'resolverBypass', isRecord);
  const setting = settingOf(tool.cooldown.setting);
  if (bypass === undefined || setting === null || !isStrings(bypass['keys']) || typeof bypass['table'] !== 'string') return;
  const delay = readPythonSetting(context.repository, tool, setting);
  if (delay === undefined) return;
  for (const key of bypass['keys']) {
    const found = tomlSettingAt(context.repository, delay.file, [bypass['table'], key]);
    if (found === undefined || found.value !== bypass['value']) continue;
    context.report({
      location: { file: found.file, line: found.line },
      message: `${key} = ${JSON.stringify(found.value)} makes ${tool.name} lock without ${setting}, so the release-age delay in ${delay.file} has no effect`,
      fix: `Remove ${key} from [${bypass['table']}] in ${delay.file}, so that ${tool.name} locks with pip and applies ${setting}`,
    });
  }
}

function checkPip(context: RuleContext, tool: ToolKnowledge, configFiles: readonly string[]): void {
  const names = extraOf(tool, 'configFileNames', isStrings);
  const configVariable = extraOf(tool, 'configFileVariable', (value): value is string => typeof value === 'string');
  for (const directory of ['.', ...(context.detection.workspaces?.packages ?? [])]) {
    for (const name of names) {
      const file = joinPath(directory, name);
      if (!context.repository.isFile(file)) continue;
      context.report({
        level: 'warning',
        location: { file },
        message: `pip reads no configuration from the project, so ${file} has no effect unless ${configVariable} points to it`,
        fix: `Set ${configVariable}=${file} where pip runs, or put the options in the requirements file pip installs from`,
      });
    }
  }
  const format = requirementsFormatOf(tool);
  // Options of the requirements parser are accepted; --hash and --config-settings on a line of their own are ignored.
  const allowed = new Set([...extraOf(tool, 'requirementsOptions', isStrings), ...requirementsLongOptions(format)]);
  const cooldownFlag = `--${settingOf(tool.cooldown.setting) ?? ''}`;
  const variable = extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string');
  for (const file of configFiles) {
    for (const { option, line } of requirementsOptions(context.repository, file, format)) {
      if (allowed.has(option)) continue;
      context.report({
        location: { file, line },
        message: `pip does not accept ${option} in requirements files, so installing from ${file} fails`,
        fix: option === cooldownFlag ? `Remove the line and set ${variable} where pip runs instead` : `Remove the line, and pass ${option} on the pip command line instead`,
      });
    }
  }
}

export const pythonConfigIgnored: Rule = {
  id: 'python-config-ignored',
  summary: 'A Python tool ignores a setting where it is written.',
  description:
    'uv reads uv.toml instead of [tool.uv] when both exist, and in a workspace only the root; pip reads no configuration from the project and rejects options it does not know in requirements files; PDM in uv mode installs without only-binary; Pipenv with resolver_backend = "pure-python" locks without cool-down-period. A setting in such a place looks effective but is not, and an exclude-newer date freezes dependencies instead of delaying new versions.',
  help: 'Move the setting to the file the tool reads.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    for (const manager of context.detection.packageManagers) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      if (tool.id === 'uv') checkUv(context, tool);
      if (tool.id === 'pip') checkPip(context, tool, manager.configFiles);
      if (tool.id === 'pdm') checkPdm(context, tool);
      if (tool.id === 'pipenv') checkPipenv(context, tool);
    }
  },
};
