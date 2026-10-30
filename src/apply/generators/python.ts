// Policy rules shared by the uv, Poetry and pip generators (decision D-065): installScripts "deny" forbids building
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
  context.warn(
    `${context.name}: ${setting} lets ${names.join(', ')} be built from source while building is forbidden for everything else; ${context.name} then always builds ${names.length === 1 ? 'it' : 'them'} from source, even where a wheel exists, because it has no setting that only allows building`,
  );
}

/** A TOML string or array value. */
export function tomlValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.map((item) => tomlValue(item)).join(', ')}]` : JSON.stringify(value);
}
