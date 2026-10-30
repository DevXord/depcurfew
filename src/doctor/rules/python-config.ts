// python-config-ignored: Python settings written where the tool does not read them, which look effective but are
// not: [tool.uv] next to a uv.toml, uv settings in workspace members, pip.conf in the project, options pip rejects in
// requirements files, and an exclude-newer date that never moves.
import { extraOf, isRecord, isSwitch, settingOf } from '../../apply/facts.ts';
import { joinPath } from '../../detect/repository.ts';
import { parseToml, type TomlValue } from '../../detect/toml.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { readPythonSetting, requirementsOptions } from '../python.ts';
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
  const text = context.repository.isFile(file) ? context.repository.readText(file) : undefined;
  if (text === undefined) return [];
  let document;
  try {
    document = parseToml(text);
  } catch {
    return [];
  }
  let node: TomlValue | undefined = document.root;
  for (const key of table) node = isRecord(node) ? (node as Record<string, TomlValue>)[key] : undefined;
  if (!isRecord(node)) return [];
  return keys.filter((key) => key in node).map((key) => ({ key, line: document.lineOf([...table, key]) ?? 1 }));
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
  const setting = settingOf(tool.cooldown.setting);
  const found = setting === null ? undefined : readPythonSetting(context.repository, tool, setting);
  if (found !== undefined && (typeof found.value === 'string' || typeof found.value === 'object') && /^\d{4}-\d{2}-\d{2}/u.test(String(found.value))) {
    context.report({
      level: 'warning',
      location: { file: found.file, line: found.line },
      message: `${setting} is the fixed date ${String(found.value)}, so uv never uses versions uploaded after it; that is a freeze, not a delay that moves with time`,
      fix: `Write a duration such as "3 days" (uv 0.9.17 or later), or let depcurfew apply write it from cooldown.minimum`,
    });
  }
}

function checkPip(context: RuleContext, tool: ToolKnowledge, configFiles: readonly string[]): void {
  const names = extraOf(tool, 'configFileNames', isStrings);
  for (const directory of ['.', ...(context.detection.workspaces?.packages ?? [])]) {
    for (const name of names) {
      const file = joinPath(directory, name);
      if (!context.repository.isFile(file)) continue;
      context.report({
        level: 'warning',
        location: { file },
        message: `pip reads no configuration from the project, so ${file} has no effect unless PIP_CONFIG_FILE points to it`,
        fix: `Set PIP_CONFIG_FILE=${file} where pip runs, or put the options in the requirements file pip installs from`,
      });
    }
  }
  const allowed = new Set(extraOf(tool, 'requirementsOptions', isStrings));
  const cooldownFlag = `--${settingOf(tool.cooldown.setting) ?? ''}`;
  const variable = extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string');
  for (const file of configFiles) {
    for (const { option, line } of requirementsOptions(context.repository, file)) {
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
    'uv reads uv.toml instead of [tool.uv] when both exist, and in a workspace only the root; pip reads no configuration from the project and rejects options it does not know in requirements files. A setting in such a place looks effective but is not, and an exclude-newer date freezes dependencies instead of delaying new versions.',
  help: 'Move the setting to the file the tool reads.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    for (const manager of context.detection.packageManagers) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      if (tool.id === 'uv') checkUv(context, tool);
      if (tool.id === 'pip') checkPip(context, tool, manager.configFiles);
    }
  },
};
