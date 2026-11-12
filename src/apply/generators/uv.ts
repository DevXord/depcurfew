// uv: exclude-newer and the build settings in a managed block: in uv.toml when the project has one (uv then ignores
// [tool.uv] in pyproject.toml), otherwise in [tool.uv] of pyproject.toml. Only the root is configured, because in a
// workspace uv reads the configuration of the root alone. A change to what uv.lock records means locking again.
import { cutoffTime, delayMinutes, formatMinutes } from '../../doctor/durations.ts';
import { parseToml, TomlDateTime, tomlValueAt } from '../../detect/toml.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { normalizePythonName } from '../../policy/python-names.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { hasManagedTomlLines, writeTomlBlock } from '../toml.ts';
import { cooldownValue, eachSource, exclusions, unreadableDelay } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { buildAllowList, forcedBuildWarning, pythonNames, relockWarning, tomlCurrent, tomlValue } from './python.ts';

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
      // A value depcurfew cannot read stays as it is (decision D-167).
      const current = tomlCurrent(context, file, table, setting);
      if (!unreadableDelay(context, file, setting, current?.value, current?.line, cooldown)) {
        minutes = cooldown.minutes;
        entries.push(`${setting} = ${tomlValue(cooldown.value)}`);
        managed.push(setting);
      }
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined) {
        managed.push(excludeSetting);
        const exempt = extraOf(tool, 'excludeValue', (value): value is boolean => typeof value === 'boolean');
        const names = pythonNames(patterns);
        const kept = longerPackageDelays(context, file, table, excludeSetting, cooldown.minutes, new Set(names));
        const written = [...names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`), ...kept.map((entry) => `${JSON.stringify(entry.name)} = ${entry.text}`)];
        if (written.length > 0) entries.push(`${excludeSetting} = { ${written.join(', ')} }`);
      }
    }
  }

  if (policy.installScripts?.default === 'deny') {
    const build = extraOf(tool, 'buildSwitch', isSwitch);
    if (context.supports(build.since, build.setting)) {
      entries.push(`${build.setting} = ${tomlValue(build.value)}`);
      managed.push(build.setting);
      context.writes('installScripts', build.setting, file, table);
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

  // In pyproject.toml the marker names the table, because PDM may keep a block of its own in the same file.
  const label = table === '' ? undefined : table;
  if (entries.length > 0 || (context.exists(file) && hasManagedTomlLines(context.read(file)))) {
    // Before the edit: the context reads a file as edited once its change is planned.
    relockWarning(context, file, table, (body) => writeTomlBlock(body, table, entries, managed, label));
    context.toml(file, table, entries, managed, label);
  }
  return minutes;
};

/**
 * The entries of exclude-newer-package that the project sets to a date or a duration and that hold the package back
 * longer than cooldown.minimum (an earlier date, a longer duration), as written, for the managed block: uv takes the
 * value of a package over exclude-newer ("Package-specific values will take precedence over both global and
 * index-specific values"), so they keep what the project had (decision D-195). A shorter one exempts the package in
 * part: apply comments it out with exclusion-dropped, and the package waits as long as the others. A value depcurfew
 * cannot read stays as written; false and the packages of cooldown.exclude are the exceptions, which apply writes.
 */
function longerPackageDelays(context: Context, file: string, table: string, setting: string, minutes: number, exempt: ReadonlySet<string>): { name: string; text: string }[] {
  if (!context.exists(file)) return [];
  let document;
  try {
    document = parseToml(context.read(file));
  } catch {
    // The edit of the file reports it (cannot-edit).
    return [];
  }
  const path = [...(table === '' ? [] : table.split('.')), setting];
  const value = tomlValueAt(document, path);
  if (!isRecord(value)) return [];
  const minimum = context.policy.cooldown?.minimum.text ?? '';
  const now = Date.now();
  return Object.entries(value).flatMap(([name, entry]): { name: string; text: string }[] => {
    if (entry === false || exempt.has(normalizePythonName(name))) return [];
    const text = entry instanceof TomlDateTime ? entry.text : typeof entry === 'string' ? JSON.stringify(entry) : undefined;
    if (text === undefined) return [];
    const cutoff = cutoffTime(context.tool, entry);
    const delay = cutoff === undefined ? delayMinutes(context.tool, entry, context.version) : undefined;
    // Not a date and no duration uv reads: it stays as the project wrote it.
    if (cutoff === undefined && delay?.ok !== true) return [{ name, text }];
    const age = cutoff === undefined ? (delay?.ok === true ? delay.minutes : 0) : (now - cutoff.time) / 60000;
    if (age > minutes) return [{ name, text }];
    if (age < minutes) {
      const line = document.lineOf([...path, name]) ?? document.lineOf(path);
      const shown = cutoff === undefined ? `${text}, a delay of ${formatMinutes(age)}` : age <= 0 ? `${text}, a date to come, which holds back nothing` : `${text}, which holds back only what was uploaded in the last ${formatMinutes(age >= 60 ? Math.floor(age / 60) * 60 : Math.floor(age))}`;
      context.warn({
        code: 'exclusion-dropped',
        location: { file, ...(line === undefined ? {} : { line }) },
        message: `${context.name}: ${setting} in ${file}${line === undefined ? '' : ` (line ${line})`} gives ${name} ${shown}, shorter than cooldown.minimum "${minimum}" in ${POLICY_FILE}, and uv takes the value of a package over exclude-newer; depcurfew apply comments it out, so uv delays ${name} like every other package`,
        fix: `To exempt ${name} from the delay, add ${JSON.stringify(`pypi:${normalizePythonName(name)}`)} to cooldown.exclude in ${POLICY_FILE} and run depcurfew apply again; otherwise nothing to do`,
      });
    }
    return [];
  });
}
