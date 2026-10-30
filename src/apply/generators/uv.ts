// uv: exclude-newer and the build settings in a managed block: in uv.toml when the project has one (uv then ignores
// [tool.uv] in pyproject.toml), otherwise in [tool.uv] of pyproject.toml. Only the root is configured, because in a
// workspace uv reads the configuration of the root alone. A change to what uv.lock records means locking again.
import { parseToml, TomlDateTime, tomlValueAt, type TomlDocument } from '../../detect/toml.ts';
import { BLOCK_START } from '../block.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf, values } from '../facts.ts';
import { listing } from '../requirements.ts';
import { writeTomlBlock } from '../toml.ts';
import { cooldownValue, eachSource, exclusions } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { buildAllowList, forcedBuildWarning, pythonNames, tomlValue } from './python.ts';

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

  if (entries.length > 0 || (context.exists(file) && context.read(file).includes(BLOCK_START))) {
    // Before the edit: the context reads a file as edited once its change is planned.
    relockWarning(context, file, table, (body) => writeTomlBlock(body, table, entries, managed));
    context.toml(file, table, entries, managed);
  }
  return minutes;
};

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** A TOML value for comparison: a date-time as written. */
function comparable(value: unknown): string {
  return JSON.stringify(value instanceof TomlDateTime ? value.text : (value ?? null));
}

/**
 * uv records some settings in uv.lock (extra.lockedSettings); when the edit changes one, uv lock --check and
 * uv sync --locked fail until the lockfile is locked again, so apply says so.
 */
function relockWarning(context: Context, file: string, table: string, edit: (body: string) => string): void {
  const { tool } = context;
  const locked = tool.extra?.['lockedSettings'] === undefined ? [] : extraOf(tool, 'lockedSettings', isStringList);
  const lockfile = (tool.project === undefined ? [] : values(tool.project.lockfiles))
    .flatMap((versions) => versions.flatMap((entry) => entry.value))
    .find((name) => context.exists(name));
  if (lockfile === undefined || locked.length === 0) return;
  const body = context.exists(file) ? context.read(file) : '';
  let before: TomlDocument;
  let after: TomlDocument;
  try {
    before = parseToml(body);
    after = parseToml(edit(body));
  } catch {
    return;
  }
  const path = table === '' ? [] : table.split('.');
  const changed = locked.filter((setting) => comparable(tomlValueAt(before, [...path, setting])) !== comparable(tomlValueAt(after, [...path, setting])));
  if (changed.length === 0) return;
  context.warn({
    code: 'lockfile-out-of-date',
    location: { file: lockfile },
    message: `${context.name}: ${lockfile} records ${listing(changed)}, so it is out of date after this change`,
    fix: `Run ${context.name} lock and commit ${lockfile}; until then ${context.name} sync --locked and ${context.name} lock --check fail`,
  });
}
