// Policy rules shared by the Python generators (decision D-065): installScripts "deny" forbids building
// from source, and the packages in installScripts.allow are exceptions that the tools always build from source.
import { parseToml, TomlDateTime, tomlValueAt, type TomlDocument } from '../../detect/toml.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { normalizePythonName } from '../../policy/python-names.ts';
import { extraOf, isRecord, values } from '../facts.ts';
import { listing } from '../requirements.ts';
import { allowedNames, dependencyFiles } from './common.ts';
import type { Context } from './context.ts';

/** The policy's Python allow-list as normalized names; patterns with * are dropped with a warning. */
export function buildAllowList(context: Context, setting: string): string[] {
  return [...new Set(allowedNames(context, setting).map(normalizePythonName))];
}

/** Exclusions as normalized names. */
export function pythonNames(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizePythonName))];
}

export function forcedBuildWarning(context: Context, setting: string, names: readonly string[]): void {
  if (names.length === 0) return;
  const policyNames = names.map((name) => `pypi:${name}`);
  context.warn({
    code: 'forced-source-build',
    message: `${context.name}: ${setting} lets ${names.join(', ')} be built from source while building is forbidden for everything else; ${context.name} then always builds ${names.length === 1 ? 'it' : 'them'} from source, even where a wheel exists, because it has no setting that only allows building`,
    fix:
      names.length === 1
        ? `If ${policyNames.join('')} has a wheel and needs no build, remove it from installScripts.allow in ${POLICY_FILE}`
        : `Remove those of ${listing(policyNames)} that have a wheel and need no build from installScripts.allow in ${POLICY_FILE}`,
  });
}


/** Says when the tool's switch does not stop git, local and URL dependencies from being built. */
export function buildSwitchScopeWarning(context: Context, setting: string, covers: unknown): void {
  if (Array.isArray(covers) && covers.includes('git') && covers.includes('directory')) return;
  context.warn({
    code: 'build-switch-scope',
    message: `${context.name}: ${setting} forbids building only packages from an index; ${context.name} still builds git, local directory and source archive dependencies`,
    fix: `Run depcurfew doctor to find them in ${dependencyFiles(context)}`,
  });
}

/** A TOML string or array value. */
export function tomlValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.map((item) => tomlValue(item)).join(', ')}]` : JSON.stringify(value);
}

const COMPACT_UNITS: Readonly<Record<string, string>> = { hour: 'h', day: 'd', week: 'w' };

/** A duration such as "36 hours" in the compact form PDM and Pipenv read: "36h". */
export function compactDuration(value: string): string {
  const [count = '', unit = ''] = value.split(' ');
  const letter = COMPACT_UNITS[unit.replace(/s$/u, '')];
  if (letter === undefined) throw new Error(`cannot write the duration "${value}" in compact form`);
  return `${count}${letter}`;
}

/** What a lockfile records of the configuration (extra.lockedSettings): some settings, or the whole table. */
interface LockedSettings {
  settings: readonly string[] | 'table';
  /** The command that locks again. */
  lock: string;
  /** Commands that fail until it runs. */
  failing: readonly string[];
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function isLockedSettings(value: unknown): value is LockedSettings {
  return isRecord(value) && (value['settings'] === 'table' || isStringList(value['settings'])) && typeof value['lock'] === 'string' && isStringList(value['failing']);
}

/** A TOML value for comparison: a date-time as written. */
function comparable(value: unknown): string {
  return JSON.stringify(value instanceof TomlDateTime ? value.text : (value ?? null));
}

/**
 * uv records some settings in uv.lock, and PDM checks pdm.lock against its whole [tool.pdm.resolution] table
 * (extra.lockedSettings); when `edit` changes what the lockfile depends on, its check commands fail until it is
 * locked again, so apply says so. Call it before the edit is planned: the context reads a file as edited after that.
 */
export function relockWarning(context: Context, file: string, table: string, edit: (body: string) => string): void {
  const { tool } = context;
  if (tool.extra?.['lockedSettings'] === undefined) return;
  const locked = extraOf(tool, 'lockedSettings', isLockedSettings);
  const lockfile = (tool.project === undefined ? [] : values(tool.project.lockfiles))
    .flatMap((versions) => versions.flatMap((entry) => entry.value))
    .find((name) => context.exists(name));
  if (lockfile === undefined) return;
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
  const keysOf = (document: TomlDocument): string[] => {
    const value = tomlValueAt(document, path);
    return isRecord(value) ? Object.keys(value) : [];
  };
  const settings = locked.settings === 'table' ? [...new Set([...keysOf(after), ...keysOf(before)])] : locked.settings;
  const changed = settings.filter((setting) => comparable(tomlValueAt(before, [...path, setting])) !== comparable(tomlValueAt(after, [...path, setting])));
  if (changed.length === 0) return;
  context.warn({
    code: 'lockfile-out-of-date',
    location: { file: lockfile },
    message:
      locked.settings === 'table'
        ? `${context.name}: ${lockfile} is checked against the whole [${table}] table, and this change alters ${listing(changed)}, so ${lockfile} is out of date`
        : `${context.name}: ${lockfile} records ${listing(changed)}, so it is out of date after this change`,
    fix: `Run ${locked.lock} and commit ${lockfile}; until then ${listing(locked.failing)} fail`,
  });
}
