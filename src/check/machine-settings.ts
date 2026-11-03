// The registry and index settings of the machine that check, the hook and depcurfew mcp run on (decision D-168):
// variables of the environment and configuration files outside the repository that the tools read as well. depcurfew
// reads them as each tool does, in its order (facts in src/knowledge: npm's environmentNames, registryConfig,
// registryOverrides and globalConfig, and the machineSettings of pip and uv), and treats each like a setting of a file
// it does not take: one that points the install at another registry or index than the one depcurfew asks makes the
// package unverified with the setting named, and the package is not looked up there at all, so that its name does not
// reach a registry the install does not use. npm's are read with its .npmrc files (npmrcSettings, which takes ~/.npmrc
// and the policy's .npmrc as before), the others here for the packages each tool installs.
import { posix, win32 } from 'node:path';
import { values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { EnvironmentNameRule, MachineSettingsKnowledge, RegistryOverridesKnowledge, RegistrySettingKnowledge, ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { shownPath, userFileFor, userFilePath } from '../user/locate.ts';

/** The environment of the process, its platform and its Node.js executable, below whose prefix npm keeps its global npmrc. */
export interface MachineEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  execPath: string;
}

export function currentMachine(): MachineEnvironment {
  return { env: process.env, platform: process.platform, execPath: process.execPath };
}

function tool(id: ToolId): ToolKnowledge | undefined {
  return knowledgeBase.find((entry) => entry.id === id);
}

function factOf<T>(entry: ToolKnowledge | undefined, key: string): T | undefined {
  const fact = entry?.extra?.[key];
  return fact === undefined ? undefined : (values(fact)[0] as T | undefined);
}

/**
 * Whether a tool reads the variable `listed` under the name `written` (extra.environmentNames, decision D-143): on
 * Windows every case counts; elsewhere the rule of the longest prefix the name starts with, and any case without one.
 */
function readsName(entry: ToolKnowledge | undefined, listed: string, written: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return written.toLowerCase() === listed.toLowerCase();
  const rules = factOf<EnvironmentNameRule[]>(entry, 'environmentNames') ?? [];
  const rule = rules.filter((candidate) => listed.toLowerCase().startsWith(candidate.prefix.toLowerCase())).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (rule === undefined || rule.match === 'any-case') return written.toLowerCase() === listed.toLowerCase();
  if (rule.match === 'exact') return written === listed;
  if (rule.match === 'lower-or-upper') return written === listed.toLowerCase() || written === listed.toUpperCase();
  return written.startsWith(listed.slice(0, rule.prefix.length)) && written.toLowerCase() === listed.toLowerCase();
}

/** The variables of the environment a tool reads as `listed`, as written, with their values; empty ones set nothing. */
export function variablesNamed(entry: ToolKnowledge | undefined, listed: string, machine: MachineEnvironment): { name: string; value: string }[] {
  return Object.entries(machine.env).flatMap(([name, value]) => (value !== undefined && value.trim() !== '' && readsName(entry, listed, name, machine.platform) ? [{ name, value }] : []));
}

/**
 * npm's settings from the environment, by key (extra.environmentNames of npm: npm_config_ in any case; loadEnv cuts the
 * prefix and writes the rest in lower case with _ as -, but for a leading _ and a key that starts with //), with the
 * variable as written; of two spellings the later wins, and an empty value sets nothing.
 */
export function npmEnvironment(machine: MachineEnvironment): Map<string, { variable: string; value: string }> {
  const prefix = factOf<EnvironmentNameRule[]>(tool('npm'), 'environmentNames')?.[0]?.prefix ?? 'npm_config_';
  const settings = new Map<string, { variable: string; value: string }>();
  for (const [name, value] of Object.entries(machine.env)) {
    if (value === undefined || value === '' || name.length <= prefix.length || name.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
    const rest = name.slice(prefix.length);
    const key = rest.startsWith('//') ? rest : rest.replace(/(?!^)_/gu, '-').toLowerCase();
    settings.delete(key);
    settings.set(key, { variable: name, value });
  }
  return settings;
}

/** ${NAME} and ${NAME?} in a value of npm, as env-replace.js of npm 12.2.1 expands them (a backslash escapes). */
function npmEnvReplace(value: string, env: MachineEnvironment['env']): string {
  return value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/gu, (whole: string, escapes: string, name: string, modifier: string | undefined) => {
    if (escapes.length % 2 === 1) return whole.slice((escapes.length + 1) / 2);
    const found = env[name];
    return escapes.slice(escapes.length / 2) + (found !== undefined ? found : modifier === '?' ? '' : `\${${name}}`);
  });
}

/**
 * A path setting of npm (userconfig, globalconfig, prefix) as npm reads it (parseField, extra.globalConfig): trimmed,
 * with ${NAME} expanded, ~/ (also ~\ on Windows) against the home directory and anything else against `cwd`.
 */
export function npmPath(value: string, machine: MachineEnvironment, home: string, cwd: string): string {
  const path = machine.platform === 'win32' ? win32 : posix;
  const text = npmEnvReplace(value.trim(), machine.env);
  return (machine.platform === 'win32' ? /^~[/\\]/u : /^~\//u).test(text) ? path.resolve(home, text.slice(2)) : path.resolve(cwd, text);
}

/** A variable of the environment, as the platform finds it: in any case on Windows. */
function environmentValue(machine: MachineEnvironment, name: string): string | undefined {
  if (machine.platform !== 'win32') return machine.env[name];
  const found = Object.keys(machine.env).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : machine.env[found];
}

/**
 * npm's default global prefix (loadGlobalPrefix, extra.globalConfig): PREFIX of the environment, else the directory of
 * the Node.js executable on Windows and the one above it elsewhere, with DESTDIR in front on POSIX. depcurfew takes the
 * Node.js that runs it for the one that runs npm.
 */
export function npmDefaultPrefix(machine: MachineEnvironment, levels: { win32: number; other: number }, variables: { prefix: string; destDir: string }): string {
  const given = environmentValue(machine, variables.prefix);
  if (given !== undefined && given !== '') return given;
  const path = machine.platform === 'win32' ? win32 : posix;
  let prefix = machine.execPath;
  for (let level = 0; level < (machine.platform === 'win32' ? levels.win32 : levels.other); level++) prefix = path.dirname(prefix);
  const destDir = machine.platform === 'win32' ? undefined : environmentValue(machine, variables.destDir);
  return destDir === undefined || destDir === '' ? prefix : path.join(destDir, prefix);
}

/** A path for messages: under the home directory with ~/, otherwise as it is. */
export function machinePath(path: string, machine: MachineEnvironment, home: string): string {
  return shownPath(path, { platform: machine.platform, home, env: machine.env });
}

/** One registry or index setting of the machine for a tool, before it becomes an UnreadSetting. */
export interface MachineSetting {
  /** The variable as written, or the file as messages show it with the line. */
  variable?: string;
  file?: string;
  line?: number;
  effect: 'replaces' | 'adds';
  /** The URL without credentials; undefined when it is not one URL depcurfew reads. */
  value?: string;
}

/** A configuration file that was not read, and why. */
export interface MachineSkip {
  file: string;
  reason: string;
}

/** The registry overrides of a tool (registryOverrides): the variables of tools without machineSettings replace the registry. */
function registryVariables(entry: ToolKnowledge | undefined): MachineSettingsKnowledge['variables'] {
  const own = factOf<MachineSettingsKnowledge>(entry, 'machineSettings');
  if (own !== undefined) return own.variables;
  return (factOf<RegistryOverridesKnowledge>(entry, 'registryOverrides')?.registryVariables ?? []).map((name) => ({ name, effect: 'replaces' as const }));
}

/** The one URL of a value, when it is one (a list of one entry too); `url` is registryKey's reading of a URL. */
function oneUrl(value: string, list: 'spaces' | 'commas' | undefined, url: (text: string) => string | undefined): string | undefined {
  const entries = list === undefined ? [value.trim()] : value.split(list === 'commas' ? ',' : /\s+/u).map((part) => part.trim()).filter((part) => part !== '');
  return entries.length === 1 ? url(entries[0] as string) : undefined;
}

/**
 * The lines of an INI file as Python's configparser.RawConfigParser reads them (pip, extra.machineSettings): [section]
 * headers, key = value or key: value with the key in lower case, full-line comments with # or ;, and indented lines
 * that continue the value before them; a key before any section is an error pip stops at, so it is left out.
 */
export function configParserEntries(text: string): { section: string; key: string; value: string; line: number }[] {
  const entries: { section: string; key: string; value: string; line: number }[] = [];
  let section: string | undefined;
  let current: { section: string; key: string; value: string; line: number } | undefined;
  let indent = 0;
  text.split(/\r\n|\r|\n/u).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return;
    const level = raw.length - raw.trimStart().length;
    if (current !== undefined && level > indent) {
      current.value += `\n${trimmed}`;
      return;
    }
    indent = level;
    const header = /^\[(.+)\]$/u.exec(trimmed);
    if (header !== null) {
      section = header[1];
      current = undefined;
      return;
    }
    const option = /^(.*?)\s*[=:]\s*(.*)$/u.exec(trimmed);
    if (section === undefined || option === null || (option[1] ?? '') === '') {
      current = undefined;
      return;
    }
    current = { section, key: (option[1] ?? '').toLowerCase(), value: option[2] ?? '', line: index + 1 };
    entries.push(current);
  });
  return entries;
}

/** What a tool reads from a configuration file, by its format: undefined when the text cannot be parsed. */
type FileReader = (text: string, file: string) => MachineSetting[] | undefined;

/**
 * The settings of the machine for the packages `id` installs: its variables of the environment, and the user file or
 * the file the configuration-file variable names (pip: index-url, extra-index-url, find-links in [global] and
 * [install]; uv: the uv.toml keys of registrySettings). `read` gives the text of a file, undefined when there is none,
 * or why it was not read; `url` reads a URL as registryKey does, without credentials; `toml` reads the places of the
 * registry settings of a uv.toml, undefined when it cannot be parsed.
 */
export function machineSettings(
  id: ToolId,
  context: {
    machine: MachineEnvironment;
    home: string;
    cwd: string;
    read: (path: string) => { text: string } | { skipped: string } | undefined;
    url: (text: string) => string | undefined;
    toml: (text: string, settings: readonly RegistrySettingKnowledge[]) => { line: number; effect: 'replaces' | 'adds'; value?: string }[] | undefined;
  },
): { settings: MachineSetting[]; skipped: MachineSkip[] } {
  const entry = tool(id);
  const { machine, home } = context;
  const settings: MachineSetting[] = [];
  const skipped: MachineSkip[] = [];
  for (const variable of registryVariables(entry)) {
    for (const found of variablesNamed(entry, variable.name, machine)) {
      const value = oneUrl(found.value, variable.list, context.url);
      settings.push({ variable: found.name, effect: variable.effect, ...(value === undefined ? {} : { value }) });
    }
  }
  const facts = factOf<MachineSettingsKnowledge>(entry, 'machineSettings');
  if (facts === undefined || entry === undefined) return { settings, skipped };
  const reader: FileReader | undefined =
    facts.configFile?.format === 'ini'
      ? (text, file) => iniSettings(text, file, facts, context.url)
      : facts.configFile?.format === 'toml'
        ? (text, file) => {
            const registry = factOf<readonly RegistrySettingKnowledge[]>(entry, 'registrySettings')?.filter((setting) => setting.file === 'uv.toml') ?? [];
            return context.toml(text, registry)?.map((place) => ({ file, line: place.line, effect: place.effect, ...(place.value === undefined ? {} : { value: place.value }) }));
          }
        : undefined;
  if (reader === undefined) return { settings, skipped };
  const readFile = (path: string): 'missing' | 'read' => {
    const file = machinePath(path, machine, home);
    const result = context.read(path);
    if (result === undefined) return 'missing';
    if (!('text' in result)) {
      skipped.push({ file, reason: result.skipped });
      return 'read';
    }
    const found = reader(result.text, file);
    if (found === undefined) skipped.push({ file, reason: 'it cannot be parsed' });
    else settings.push(...found);
    return 'read';
  };
  // The file the variable names is read in place of the user file (pip: when it exists; uv: always).
  const named = facts.configFile === undefined ? undefined : variablesNamed(entry, facts.configFile.variable, machine).at(-1);
  if (named !== undefined) {
    const path = (machine.platform === 'win32' ? win32 : posix).resolve(context.cwd, named.value.trim());
    if (readFile(path) === 'read' || facts.configFile?.whenMissing === 'nothing') return { settings, skipped };
  }
  const legacy = machine.platform === 'win32' ? facts.legacyUserFiles?.win32 : facts.legacyUserFiles?.posix;
  if (legacy !== undefined) readFile((machine.platform === 'win32' ? win32 : posix).join(home, legacy));
  const userFile = userFileFor(entry, undefined);
  const userPath = userFile === null ? undefined : userFilePath(userFile, { platform: machine.platform, home, env: machine.env, cwd: context.cwd });
  if (userPath !== undefined) readFile(userPath);
  return { settings, skipped };
}

/** The index settings of a pip configuration file: the keys of machineSettings in its sections, names as pip normalizes them. */
function iniSettings(text: string, file: string, facts: MachineSettingsKnowledge, url: (text: string) => string | undefined): MachineSetting[] {
  const sections = facts.sections ?? [];
  const keys = facts.keys ?? [];
  return configParserEntries(text).flatMap((entry) => {
    const key = keys.find((candidate) => candidate.key === entry.key.replaceAll('_', '-'));
    if (key === undefined || !sections.includes(entry.section)) return [];
    const value = oneUrl(entry.value, key.effect === 'adds' ? 'spaces' : undefined, url);
    return [{ file, line: entry.line, effect: key.effect, ...(value === undefined ? {} : { value }) }];
  });
}
