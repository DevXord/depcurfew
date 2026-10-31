// Environment variables that move, skip or override a tool's user file or its settings (user.variables in the
// knowledge base), for doctor --user and apply --user. Every spelling that is set counts, as the tools read them, and
// the variable is named as it is set. A variable that names the file the tool reads anyway is no override, and neither
// is one that npm passed on from ~/.npmrc to the command it runs (npx, npm run).
import { posix, win32 } from 'node:path';
import { extraOf, isRecord } from '../apply/facts.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
import { iniEntries } from '../doctor/settings.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { npm } from '../knowledge/npm.ts';
import type { ToolId, ToolKnowledge, UserVariable } from '../knowledge/types.ts';
import { readLimitedText } from '../read-limited.ts';
import { userFileFor, userFilePath, type UserEnvironment } from './locate.ts';

export interface EnvironmentOverride {
  /** The variable as it is set in the environment (NPM_CONFIG_USERCONFIG for npm_config_userconfig). */
  name: string;
  value: string;
  tool: ToolId;
  /** What it does, from the knowledge base. */
  effect: string;
  /** Every value counts ('any' in the knowledge base); otherwise the value is one of the values that weaken. */
  anyValue: boolean;
}

const MAX_FILE = 1024 * 1024;

const CHILD = extraOf(npm, 'childEnvironment', isRecord);
const CHILD_MARKER = typeof CHILD['marker'] === 'string' ? CHILD['marker'] : undefined;
const CHILD_PREFIX = typeof CHILD['prefix'] === 'string' ? CHILD['prefix'] : undefined;

function readsVariable(variable: UserVariable, version: Version | undefined): boolean {
  if (version === undefined) return true;
  const since = variable.since === undefined ? undefined : parseVersion(variable.since);
  const until = variable.until === undefined ? undefined : parseVersion(variable.until);
  return (since === undefined || compareVersions(version, since) >= 0) && (until === undefined || compareVersions(version, until) < 0);
}

/**
 * Whether the value matters: any value, one of the listed values (without regard to case), or for a switch that turns a
 * protection off every value but those the tool reads as off (fail closed; compared trimmed, as npm and pnpm read them).
 */
function weakens(variable: UserVariable, value: string): boolean {
  const { values } = variable;
  if (values === 'any') return true;
  if ('except' in values) return !values.except.includes(value.trim());
  return values.some((wanted) => wanted.toLowerCase() === value.trim().toLowerCase());
}

/** The spellings of the variable that are set and not empty, in the order of the environment. */
function spellings(environment: UserEnvironment, variable: UserVariable): [string, string][] {
  // Windows does not tell names apart by case, so every variable is matched without regard to case there.
  const anyCase = variable.anyCase === true || environment.platform === 'win32';
  const wanted = variable.name.toUpperCase();
  return Object.entries(environment.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '' && (anyCase ? entry[0].toUpperCase() === wanted : entry[0] === variable.name),
  );
}

/** Whether the value names the file the tool reads when the variable is unset (npm exports it to what it runs). */
function namesDefault(value: string, variable: UserVariable, environment: UserEnvironment): boolean {
  if (variable.defaultPath === undefined) return false;
  const module = environment.platform === 'win32' ? win32 : posix;
  const home = environment.env['HOME'];
  // npm resolves ~ against HOME, else the home directory of the account.
  const homes = [environment.home, ...(home !== undefined && module.isAbsolute(home) ? [home] : [])];
  const expanded = /^~(?=$|[\\/])/u.test(value) ? homes.map((base) => `${base}${value.slice(1)}`) : [value];
  const same = (a: string, b: string) => (environment.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const defaults = homes.map((base) => module.join(base, ...variable.defaultPath!.split('/')));
  return expanded.some((path) => module.isAbsolute(path) && defaults.some((file) => same(module.resolve(path), file)));
}

/** The top-level values of ~/.npmrc, read once per call: what npm passes on to the commands it runs. */
function userNpmrc(environment: UserEnvironment): Map<string, string[]> {
  const file = userFileFor(npm, undefined);
  const path = file === null ? undefined : userFilePath(file, environment);
  const text = path === undefined ? undefined : readLimitedText(path, MAX_FILE);
  const values = new Map<string, string[]>();
  for (const entry of iniEntries(text ?? '')) {
    const key = entry.key.replace(/\[\]$/u, '').toLowerCase();
    values.set(key, [...(values.get(key) ?? []), entry.value]);
  }
  return values;
}

/**
 * The environment variables that override the user files or settings of these tools (doctor --user passes the
 * package managers found in PATH), for the versions given; a tool without a version gets every variable it has.
 */
export function environmentOverrides(
  environment: UserEnvironment,
  tools: readonly ToolKnowledge[],
  versions: Partial<Record<ToolId, Version | undefined>> = {},
): EnvironmentOverride[] {
  const underNpm = CHILD_MARKER !== undefined && (environment.env[CHILD_MARKER] ?? '') !== '';
  let npmrc: Map<string, string[]> | undefined;
  /** npm passes every setting that is not its default to the commands it runs as npm_config_<key>. */
  const passedOnByNpm = (name: string, value: string): boolean => {
    if (!underNpm || CHILD_PREFIX === undefined || !name.toLowerCase().startsWith(CHILD_PREFIX)) return false;
    // As npm's loadEnv: _ becomes -, except a leading one.
    const key = name.slice(CHILD_PREFIX.length).replace(/(?!^)_/gu, '-').toLowerCase();
    npmrc ??= userNpmrc(environment);
    return npmrc.get(key)?.includes(value) === true;
  };
  const overrides: EnvironmentOverride[] = [];
  for (const tool of tools) {
    if (tool.user === undefined) continue;
    for (const variable of evidenceOf(tool.user.variables)[0]?.value ?? []) {
      if (!readsVariable(variable, versions[tool.id])) continue;
      for (const [name, value] of spellings(environment, variable)) {
        if (!weakens(variable, value)) continue;
        if (namesDefault(value, variable, environment) || passedOnByNpm(name, value)) continue;
        if (overrides.some((known) => known.tool === tool.id && known.name === name)) continue;
        overrides.push({ name, value, tool: tool.id, effect: variable.effect, anyValue: variable.values === 'any' });
      }
    }
  }
  return overrides;
}
