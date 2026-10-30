// Policy rules shared by the Python generators (decision D-065): installScripts "deny" forbids building
// from source, and the packages in installScripts.allow are exceptions that the tools always build from source.
import { normalizePythonName } from '../../policy/python-names.ts';
import { allowedNames } from './common.ts';
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
  context.warn({
    code: 'forced-source-build',
    message: `${context.name}: ${setting} lets ${names.join(', ')} be built from source while building is forbidden for everything else; ${context.name} then always builds ${names.length === 1 ? 'it' : 'them'} from source, even where a wheel exists, because it has no setting that only allows building`,
  });
}

/** Says when the tool's switch does not stop git, local and URL dependencies from being built. */
export function buildSwitchScopeWarning(context: Context, setting: string, covers: unknown): void {
  if (Array.isArray(covers) && covers.includes('git') && covers.includes('directory')) return;
  context.warn({
    code: 'build-switch-scope',
    message: `${context.name}: ${setting} forbids building only packages from an index; ${context.name} still builds git, local directory and source archive dependencies`,
    fix: 'Run depcurfew doctor to find them in the lockfile',
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
