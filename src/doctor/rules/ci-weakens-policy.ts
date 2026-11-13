// ci-weakens-policy (decision D-166): CI workflows and Dockerfiles that turn off or weaken, for the commands they run,
// what depcurfew apply wrote into the configuration of npm, pnpm, Yarn, Bun, Deno, uv, Poetry and PDM. Read
// where the variables are set (ci-settings.ts: the env of the workflow, a job, its container and a step; export,
// NAME=value before a command and $GITHUB_ENV in run steps; ENV, ARG and RUN of Dockerfile stages) and on the commands
// of the tool: the options and variables of installOverrides, the cooldown option, and for npm the settings of
// installScripts and sources (extra.settingOverrides). Cargo's --config takes TOML or a file (extra.configOverride, E10),
// read with cargo-config.ts. pip has python-config-ignored, Composer composer-config-weakens and Bundler
// bundler-config-weakens.
import { isRecord, values } from '../../apply/facts.ts';
import { programName } from '../../detect/commands.ts';
import type { PackageManagerId } from '../../detect/types.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { EnvironmentNameRule, InstallOverridesKnowledge, OverrideValues, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { SourceKind } from '../../apply/generators/common.ts';
import { usesManager } from '../applies.ts';
import { delayKeys, readConfigArgument, readConfigFiles, type DelayKey, type DelaySetting, type ReadConfigFile } from '../cargo-config.ts';
import { ciSettings, variablePlace, type CiCommand } from '../ci-settings.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { plannedApply } from '../plan.ts';
import { iniEntries } from '../settings.ts';
import type { Level, Rule, RuleContext } from '../types.ts';

const RULE = 'ci-weakens-policy';

/** The tools this rule covers; pip, Composer and Bundler have rules of their own. */
const TOOLS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'poetry', 'pdm', 'cargo'];

type Weakens = 'delay' | 'scripts' | 'sources';

interface Switch {
  /** The option (--min-release-age) or the variable (npm_config_min_release_age) as the knowledge base lists it. */
  name: string;
  weakens: Weakens;
  values: OverrideValues;
  /** sources: the kind of source of the policy it allows. */
  source?: SourceKind;
  /** Only where the tool's configuration file sets the setting (npm strict-allow-scripts=true). */
  setting?: string;
}

interface ToolSwitches {
  tool: ToolKnowledge;
  executables: ReadonlySet<string>;
  options: Map<string, Switch>;
  variables: Switch[];
  /** The variables by their names in lower case, each with how the tool tells the names apart (environmentNames). */
  byName: ReadonlyMap<string, readonly { entry: Switch; match: EnvironmentNameRule['match']; prefix: number }[]>;
  settingPrefix?: string;
  negation?: string;
  /** Cargo: the option that takes configuration in TOML or a file (--config), and the keys of the delay it may set. */
  config?: { option: string; keys: DelayKey[] };
}

const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = { git: 'git', remoteTarball: 'remote tarball', file: 'local tarball', directory: 'local directory' };

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** A tool's extra fact, or undefined when it has none. */
function extra(tool: ToolKnowledge, key: string): unknown {
  const fact = tool.extra?.[key];
  return fact === undefined ? undefined : values(fact)[0];
}

/** The switch turns the tool's own switch that turns every install script off back on; apply never writes that one. */
function reEnablesAll(tool: ToolKnowledge, entry: Switch): boolean {
  const disable = evidenceOf(tool.installScripts.disableAll)[0]?.value;
  if (typeof disable !== 'string' || entry.weakens !== 'scripts' || typeof entry.values !== 'object' || !('except' in entry.values) || !entry.values.except.includes('true')) return false;
  const bare = (name: string) => name.replace(/^--/u, '').replace(/^(?:npm|pnpm)_config_/iu, '').replace(/[-_]/gu, '').toLowerCase();
  return bare(entry.name) === bare(disable.split(/[:=]/u)[0] ?? '');
}

/** The options and variables of one tool that weaken the policy, from the knowledge base. */
function switchesOf(tool: ToolKnowledge): ToolSwitches {
  const overrides = extra(tool, 'installOverrides') as InstallOverridesKnowledge | undefined;
  const options = new Map<string, Switch>();
  const variables: Switch[] = [];
  for (const entry of overrides?.options ?? []) {
    if (entry.weakens === 'protection') continue;
    const item: Switch = { name: entry.name, weakens: entry.weakens, values: entry.values };
    if (!reEnablesAll(tool, item)) options.set(entry.name, item);
  }
  for (const entry of overrides?.variables ?? []) {
    if (entry.weakens === 'protection') continue;
    const item: Switch = { name: entry.name, weakens: entry.weakens, values: entry.values };
    if (!reEnablesAll(tool, item)) variables.push(item);
  }
  // The option of the release-age delay (pdm lock --exclude-newer), when installOverrides does not list it.
  const flag = tool.cooldown.cliFlag === undefined ? undefined : evidenceOf(tool.cooldown.cliFlag)[0]?.value;
  if (typeof flag === 'string' && flag.startsWith('--') && !options.has(flag)) options.set(flag, { name: flag, weakens: 'delay', values: 'delay' });
  // npm: the settings of installScripts and sources apply writes into .npmrc (extra.settingOverrides).
  const settings = extra(tool, 'settingOverrides');
  if (isRecord(settings) && isList(settings['settings']) && typeof settings['optionPrefix'] === 'string' && typeof settings['variablePrefix'] === 'string') {
    for (const entry of settings['settings']) {
      if (!isRecord(entry) || typeof entry['setting'] !== 'string') continue;
      const weakens = entry['weakens'] === 'sources' ? 'sources' : 'scripts';
      const base: Omit<Switch, 'name'> = {
        weakens,
        values: entry['values'] as OverrideValues,
        ...(typeof entry['source'] === 'string' ? { source: entry['source'] as SourceKind } : {}),
        ...(entry['when'] === 'written' ? { setting: entry['setting'] } : {}),
      };
      options.set(`${settings['optionPrefix']}${entry['setting']}`, { name: `${settings['optionPrefix']}${entry['setting']}`, ...base });
      variables.push({ name: `${settings['variablePrefix']}${entry['setting'].replaceAll('-', '_')}`, ...base });
    }
  }
  const line = extra(tool, 'commandLine');
  const commands = isRecord(line) ? [...(isList(line['add']) ? line['add'] : []), ...(isList(line['run']) ? line['run'].map((entry) => (isRecord(entry) ? entry['command'] : undefined)) : [])] : [];
  const executables = new Set(commands.flatMap((command) => (isList(command) && typeof command[0] === 'string' ? [command[0]] : [])));
  // Cargo: --config and the programs that take it (extra.configOverride).
  const override = extra(tool, 'configOverride');
  const config = isRecord(override) && typeof override['option'] === 'string' ? { option: override['option'], keys: delayKeys(tool) } : undefined;
  if (isRecord(override) && isList(override['executables'])) for (const name of override['executables']) if (typeof name === 'string') executables.add(name);
  const parsing = extra(tool, 'parsing');
  const negationFact = isRecord(settings) && typeof settings['negation'] === 'string' ? settings['negation'] : isRecord(parsing) && typeof parsing['negation'] === 'string' ? parsing['negation'] : undefined;
  return {
    tool,
    executables,
    options,
    variables,
    byName: namesOf(variables, (extra(tool, 'environmentNames') as EnvironmentNameRule[] | undefined) ?? []),
    ...(isRecord(parsing) && typeof parsing['settingPrefix'] === 'string' ? { settingPrefix: parsing['settingPrefix'] } : {}),
    ...(negationFact === undefined ? {} : { negation: negationFact }),
    ...(config === undefined ? {} : { config }),
  };
}

/** The variables by their names in lower case, each with the rule of the longest prefix it starts with (decision D-143). */
function namesOf(variables: readonly Switch[], rules: readonly EnvironmentNameRule[]): Map<string, { entry: Switch; match: EnvironmentNameRule['match']; prefix: number }[]> {
  const names = new Map<string, { entry: Switch; match: EnvironmentNameRule['match']; prefix: number }[]>();
  for (const entry of variables) {
    const lower = entry.name.toLowerCase();
    const rule = rules.filter((item) => lower.startsWith(item.prefix.toLowerCase())).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    names.set(lower, [...(names.get(lower) ?? []), { entry, match: rule?.match ?? 'exact', prefix: rule?.prefix.length ?? 0 }]);
  }
  return names;
}

/** The switch a variable set under the name `written` is, as the tool tells names apart (extra.environmentNames). */
function variableSwitch(tools: ToolSwitches, written: string): Switch | undefined {
  const lower = written.toLowerCase();
  return tools.byName.get(lower)?.find(({ entry, match, prefix }) => {
    if (match === 'exact') return written === entry.name;
    if (match === 'lower-or-upper') return written === lower || written === entry.name.toUpperCase();
    if (match === 'prefix-then-any-case') return written.startsWith(entry.name.slice(0, prefix));
    return true;
  })?.entry;
}

/** Whether a value is one of those that weaken: any, the listed ones (without regard to case), or all but those. */
function matches(values: OverrideValues, value: string): boolean {
  if (values === 'any' || values === 'delay') return true;
  if ('except' in values) return !values.except.includes(value.trim());
  return values.some((wanted) => wanted.toLowerCase() === value.trim().toLowerCase());
}

interface Effect {
  level: Level;
  /** After "which" or "and": what it does. */
  text: string;
  weakens: Weakens;
  source?: SourceKind;
}

/** What a value of a switch does against the policy, or undefined when it does not weaken it. */
function effectOf(context: RuleContext, tools: ToolSwitches, entry: Switch, value: string | undefined, written: (setting: string) => boolean): Effect | undefined {
  const { policy } = context;
  const { tool } = tools;
  if (policy === undefined) return undefined;
  if (entry.weakens === 'delay' && policy.cooldown === undefined) return undefined;
  if (entry.weakens === 'scripts' && policy.installScripts?.default !== 'deny') return undefined;
  if (entry.weakens === 'sources' && (entry.source === undefined || policy.sources?.[entry.source] !== 'deny')) return undefined;
  if (entry.setting !== undefined && !written(entry.setting)) return undefined;
  const minimum = policy.cooldown?.minimum;
  const what =
    entry.weakens === 'delay'
      ? `the release-age delay of ${tool.name} (${minimum?.text ?? ''} in ${POLICY_FILE})`
      : entry.weakens === 'scripts'
        ? `the rule of ${POLICY_FILE} on dependency install scripts for ${tool.name}`
        : `the ban of ${POLICY_FILE} on ${SOURCE_LABELS[entry.source ?? 'git']} dependencies for ${tool.name}`;
  const base = { weakens: entry.weakens, ...(entry.source === undefined ? {} : { source: entry.source }) };
  if (value !== undefined && value.includes('$')) return { ...base, level: 'warning', text: `may weaken ${what}: depcurfew does not expand the value` };
  if (entry.values === 'delay') {
    if (value === undefined || value.trim() === '') return undefined;
    const delay = delayMinutes(tool, value.trim(), undefined);
    // Cargo: a span whose product of seconds Cargo may wrap (cargoTimeSpan), with that reason.
    if (!delay.ok && tool.id === 'cargo') return { ...base, level: 'warning', text: `may weaken the release-age delay of ${tool.name} (${minimum?.text ?? ''} in ${POLICY_FILE}): ${delay.reason}` };
    if (!delay.ok) return { ...base, level: 'warning', text: `sets the release-age delay of ${tool.name} to a value depcurfew cannot compare with the ${minimum?.text ?? ''} of ${POLICY_FILE} (a date, false or another form), and may weaken it` };
    if (minimum === undefined || delay.minutes >= minimum.minutes) return undefined;
    return {
      ...base,
      level: 'error',
      text: delay.minutes === 0 ? `turns off the release-age delay of ${tool.name} (${minimum.text} in ${POLICY_FILE})` : `sets the release-age delay of ${tool.name} to ${formatMinutes(delay.minutes)}, shorter than the ${minimum.text} of ${POLICY_FILE}`,
    };
  }
  if (!matches(entry.values, value ?? 'true')) return undefined;
  if (entry.weakens === 'delay') return { ...base, level: 'error', text: `weakens ${what}` };
  if (entry.weakens === 'scripts') return { ...base, level: 'error', text: `lets dependency install scripts run that ${POLICY_FILE} denies for ${tool.name}` };
  return { ...base, level: 'error', text: `allows ${SOURCE_LABELS[entry.source ?? 'git']} dependencies, although ${POLICY_FILE} denies them for ${tool.name}` };
}

/** What to do instead, after the removal: the part of the policy that lets one package through. */
function instead(effect: Effect): string {
  if (effect.level === 'warning') return `, or make sure its value never weakens what ${POLICY_FILE} requires`;
  if (effect.weakens === 'delay') return `; for a package that cannot wait, add it to cooldown.exclude in ${POLICY_FILE} and run depcurfew apply`;
  if (effect.weakens === 'scripts') return `; to let a package run its install scripts, add it to installScripts.allow in ${POLICY_FILE} and run depcurfew apply`;
  return `; if such dependencies are wanted, set sources.${effect.source ?? 'git'} to "allow" in ${POLICY_FILE} and run depcurfew apply`;
}

/** The value of a setting in the .npmrc of the project after apply: the planned .npmrc, else the one there. */
function npmrcSetting(context: RuleContext, setting: string): string | undefined {
  const planned = plannedApply(context)?.changes.find((change) => change.file === '.npmrc')?.after;
  const text = planned ?? context.repository.readText('.npmrc');
  return text === undefined ? undefined : iniEntries(text).filter((entry) => entry.key === setting).at(-1)?.value;
}

/** The value of an option on a command line, and how it is written: --name=value, --name value, --no-name, a flag. */
function optionValue(entry: Switch, words: readonly string[], index: number, attached: string | undefined, negated: boolean): { value: string | undefined; written: string } {
  const word = words[index] ?? '';
  if (negated) return { value: 'false', written: word };
  if (attached !== undefined) return { value: attached, written: word };
  const next = words[index + 1];
  // A delay takes the next word; another switch only true or false (booleanWords), else it stands alone (true).
  if (next !== undefined && !next.startsWith('-') && (entry.values === 'delay' || next === 'true' || next === 'false')) return { value: next, written: `${word} ${next}` };
  return { value: entry.values === 'any' ? undefined : 'true', written: word };
}

function checkTool(context: RuleContext, tools: ToolSwitches): void {
  const { tool } = tools;
  const settings = ciSettings(context.repository, context.detection);
  // Whether .npmrc sets a setting to true, read only for a switch that needs it.
  const known = new Map<string, boolean>();
  const strict = (setting: string): boolean => {
    let value = known.get(setting);
    if (value === undefined) {
      value = npmrcSetting(context, setting) === 'true';
      known.set(setting, value);
    }
    return value;
  };
  for (const variable of settings.variables) {
    const entry = variableSwitch(tools, variable.name);
    if (entry === undefined) continue;
    const effect = effectOf(context, tools, entry, variable.value, strict);
    if (effect === undefined) continue;
    const text = variablePlace(variable, tool.name);
    context.report({
      level: effect.level,
      location: variable.line === undefined ? { file: variable.file } : { file: variable.file, line: variable.line },
      message: `${variable.name}=${variable.value} ${text.place}, ${text.reach}, and ${effect.text}`,
      fix: `${text.remove}${instead(effect)}`,
    });
  }
  for (const command of settings.commands) {
    if (!tools.executables.has(programName(command.words[0] ?? ''))) continue;
    for (let index = 1; index < command.words.length; index++) {
      const word = command.words[index] ?? '';
      if (word === '--') break;
      if (!word.startsWith('--')) continue;
      const equals = word.indexOf('=');
      let name = equals < 0 ? word : word.slice(0, equals);
      const attached = equals < 0 ? undefined : word.slice(equals + 1);
      if (tools.settingPrefix !== undefined && name.startsWith(tools.settingPrefix) && name.length > tools.settingPrefix.length) name = `--${name.slice(tools.settingPrefix.length)}`;
      let entry = tools.options.get(name);
      let negated = false;
      if (entry === undefined && tools.negation !== undefined && name.startsWith(tools.negation)) {
        entry = tools.options.get(`--${name.slice(tools.negation.length)}`);
        negated = entry !== undefined && entry.values !== 'delay' && entry.values !== 'any';
        if (!negated) entry = undefined;
      }
      if (entry === undefined && tools.config !== undefined && name === tools.config.option) {
        const argument = attached ?? command.words[index + 1];
        if (argument === undefined) continue;
        checkConfigArgument(context, tools, command, attached === undefined ? `${word} ${argument}` : word, argument, strict);
        if (attached === undefined) index++;
        continue;
      }
      if (entry === undefined) continue;
      const { value, written } = optionValue(entry, command.words, index, attached, negated);
      const effect = effectOf(context, tools, entry, value, strict);
      if (effect === undefined) continue;
      context.report({
        level: effect.level,
        location: { file: command.file, line: command.line },
        message: `${command.where} in ${command.file} (line ${command.line}) runs ${tool.name} with ${written}, which ${effect.text}`,
        fix: `Remove ${written} from that command in ${command.file}${instead(effect)}`,
      });
    }
  }
}

/**
 * cargo --config (E10): each delay key the argument sets, as the variable of that key would (an error for zero, a
 * shorter delay or "allow"), and a warning for an include, a file depcurfew cannot read or an argument too long or too
 * deep to read, as those may set the delay.
 */
function checkConfigArgument(context: RuleContext, tools: ToolSwitches, command: CiCommand, written: string, argument: string, strict: (setting: string) => boolean): void {
  const { tool, config } = tools;
  if (config === undefined || context.policy?.cooldown === undefined) return;
  const shown = written.length > 120 ? `${written.slice(0, 117)}...` : written;
  const head = `${command.where} in ${command.file} (line ${command.line}) runs ${tool.name} with ${shown}`;
  const location = { file: command.file, line: command.line };
  const what = `the release-age delay of ${tool.name} (${context.policy.cooldown.minimum.text} in ${POLICY_FILE})`;
  const read = readConfigArgument(context.repository, argument, config.keys);
  const remove = `Remove ${shown} from that command in ${command.file}`;
  if (read.kind === 'unreadable') {
    context.report({ level: 'warning', location, message: `${head}, ${read.reason}, which may weaken ${what}`, fix: `${remove}, or make sure it never weakens what ${POLICY_FILE} requires` });
    return;
  }
  for (const setting of read.settings) {
    const value = typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value);
    const effect = effectOf(context, tools, { name: setting.key.key, weakens: 'delay', values: setting.key.values }, value, strict);
    if (effect === undefined) continue;
    const pair = `${setting.key.key} = ${JSON.stringify(setting.value)}`;
    context.report({
      level: effect.level,
      location,
      message: read.file === undefined ? `${head}, which ${effect.text}` : `${head}, and ${pair} in ${read.file}${setting.line === undefined ? '' : ` (line ${setting.line})`} ${effect.text}`,
      fix: read.file === undefined ? `${remove}${instead(effect)}` : `Remove ${setting.key.key} from ${read.file}, or ${shown} from that command in ${command.file}${instead(effect)}`,
    });
  }
  if (read.include) {
    context.report({
      level: 'warning',
      location,
      message: `${head}, which loads more configuration with include, which depcurfew does not read and which may weaken ${what}`,
      fix: `${remove}, or make sure the files it includes never weaken what ${POLICY_FILE} requires`,
    });
  }
}

/** The Cargo configuration file Cargo uses in a directory's .cargo: the older name when both are there (extra.legacyConfig). */
function cargoConfigIn(context: RuleContext, tool: ToolKnowledge, directory: string): string | undefined {
  const file = values(tool.cooldown.configFiles)[0]?.[0] ?? '.cargo/config.toml';
  const legacy = extra(tool, 'legacyConfig');
  const older = isRecord(legacy) && typeof legacy['file'] === 'string' ? legacy['file'] : undefined;
  const at = (name: string) => (directory === '' ? name : `${directory}/${name}`);
  if (older !== undefined && context.repository.isFile(at(older))) return at(older);
  return context.repository.isFile(at(file)) ? at(file) : undefined;
}

/**
 * Cargo configuration files depcurfew apply does not write (E10): the one of each workspace member, which Cargo reads
 * before the root's when it runs there, with what it includes; what the root's .cargo/config.toml includes, for the keys
 * the root does not set itself (its own values win, extra.configInclude); and in each, the CARGO_ variables of the delay
 * in [env], which reach only a cargo that a build script or cargo run starts (extra.envTable). The root file itself is
 * config-drift's (E07).
 */
function checkCargoFiles(context: RuleContext, tools: ToolSwitches): void {
  const { tool, config } = tools;
  const minimum = context.policy?.cooldown?.minimum;
  if (config === undefined || minimum === undefined) return;
  const variables = new Set(tools.variables.map((entry) => entry.name));
  const what = `the release-age delay of ${tool.name} (${minimum.text} in ${POLICY_FILE})`;
  const rootFile = values(tool.cooldown.configFiles)[0]?.[0] ?? '.cargo/config.toml';
  const report = (read: ReadConfigFile, setting: DelaySetting, directory: string | undefined): void => {
    const value = typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value);
    const effect = effectOf(context, tools, { name: setting.key.key, weakens: 'delay', values: setting.key.values }, value, () => false);
    if (effect === undefined) return;
    const where = `${read.file}${setting.line === undefined ? '' : ` (line ${setting.line})`}${read.includedBy === undefined ? '' : `, included by ${read.includedBy},`}`;
    const reach = directory === undefined ? 'for every cargo command that reads it' : `for cargo commands run in ${directory}: Cargo reads the configuration of the directory it runs in before that of its parents`;
    context.report({
      level: effect.level,
      location: setting.line === undefined ? { file: read.file } : { file: read.file, line: setting.line },
      message: `${where} sets ${setting.key.key} = ${JSON.stringify(setting.value)}, which ${effect.text} ${reach}`,
      fix:
        directory === undefined
          ? `Remove ${setting.key.key} from ${read.file}${instead(effect)}`
          : `Remove ${setting.key.key} from ${read.file}: Cargo also reads the delay depcurfew apply writes into ${rootFile} at the root when it runs in ${directory}${instead(effect)}`,
    });
  };
  const others = (read: ReadConfigFile): void => {
    for (const entry of read.env) {
      const raw = isRecord(entry.value) ? entry.value['value'] : entry.value;
      const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const effect = effectOf(context, tools, variableSwitch(tools, entry.name) ?? { name: entry.name, weakens: 'delay', values: 'delay' }, value, () => false);
      if (effect === undefined) continue;
      context.report({
        level: 'warning',
        location: entry.line === undefined ? { file: read.file } : { file: read.file, line: entry.line },
        message: `${read.file}${entry.line === undefined ? '' : ` (line ${entry.line})`} sets ${entry.name} = ${JSON.stringify(raw)} in [env], which does not change the Cargo that reads the file but reaches build scripts and the programs cargo run starts, so a cargo they run in turn (an xtask, for example) takes it, and it ${effect.text}`,
        fix: `Remove ${entry.name} from [env] in ${read.file}${instead({ ...effect, level: 'error' })}`,
      });
    }
    for (const include of read.unreadable) {
      context.report({
        level: 'warning',
        location: include.line === undefined ? { file: read.file } : { file: read.file, line: include.line },
        message: `${read.file}${include.line === undefined ? '' : ` (line ${include.line})`} includes ${include.path}, which depcurfew cannot read (outside the repository or included too deep) and which may weaken ${what}`,
        fix: `Make sure ${include.path} never weakens what ${POLICY_FILE} requires, or move its settings into the repository`,
      });
    }
  };
  // The root: its includes, for the keys the root does not set; and its [env].
  const root = cargoConfigIn(context, tool, '');
  if (root !== undefined) {
    const files = readConfigFiles(context.repository, root, config.keys, variables);
    const own = new Set((files[0]?.settings ?? []).map((setting) => setting.key.key));
    for (const read of files) {
      if (read.includedBy !== undefined) for (const setting of read.settings) if (!own.has(setting.key.key)) report(read, setting, undefined);
      others(read);
    }
  }
  // The workspace members.
  const members = (context.detection.workspaces?.packages ?? []).filter((directory) => context.repository.isFile(`${directory}/Cargo.toml`));
  for (const directory of members) {
    const file = cargoConfigIn(context, tool, directory);
    if (file === undefined) continue;
    const files = readConfigFiles(context.repository, file, config.keys, variables);
    const own = new Set((files[0]?.settings ?? []).map((setting) => setting.key.key));
    for (const read of files) {
      for (const setting of read.settings) if (read.includedBy === undefined || !own.has(setting.key.key)) report(read, setting, directory);
      others(read);
    }
  }
}

let cached: ToolSwitches[] | undefined;
let cachedFor: readonly ToolKnowledge[] | undefined;

function allSwitches(tools: readonly ToolKnowledge[]): ToolSwitches[] {
  if (cached === undefined || cachedFor !== tools) {
    cached = tools.filter((tool) => (TOOLS as readonly string[]).includes(tool.id)).map(switchesOf);
    cachedFor = tools;
  }
  return cached;
}

/** The tools of this rule the repository (or a project listed in projects) uses and the policy configures. */
function usedTools(context: RuleContext): ToolSwitches[] {
  const policy = context.policy;
  const detections = [context.detection, ...(context.projects ?? []).map((project) => project.detection)];
  return allSwitches(context.tools).filter(
    ({ tool }) =>
      detections.some((detection) => detection.packageManagers.some((manager) => manager.supported && manager.id === tool.id)) &&
      (policy?.targets === 'auto' || policy?.targets.includes(tool.id as PackageManagerId) === true),
  );
}

export const ciWeakensPolicy: Rule = {
  id: RULE,
  checks: 'CI workflows and Dockerfiles keep the release-age delay, the rule on install scripts and the source bans of npm, pnpm, Yarn, Bun, Deno, uv, Poetry, PDM and Cargo, and so do the Cargo configuration files depcurfew apply does not write',
  summary: 'A CI workflow, a Dockerfile or a Cargo configuration file depcurfew apply does not write turns off or weakens a protection depcurfew apply wrote for npm, pnpm, Yarn, Bun, Deno, uv, Poetry, PDM or Cargo.',
  description:
    'Package managers take settings from the command line and the environment over their configuration files, so a workflow or a Dockerfile can undo what depcurfew apply wrote: NPM_CONFIG_MIN_RELEASE_AGE=0, npm_config_allow_git=all, pnpm_config_minimum_release_age=0, YARN_ENABLE_SCRIPTS=true, UV_EXCLUDE_NEWER or CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE=0 in an env, exported, set before a command, written to $GITHUB_ENV or set with ENV or ARG; npm --min-release-age=0, uv lock --exclude-newer or cargo --config (TOML or a file) on a command. Cargo also reads the .cargo/config.toml of a workspace member before the root\'s and the files include names; a CARGO_ variable in [env] reaches only a cargo that a build script or cargo run starts (a warning). A shorter delay and install scripts or sources the policy denies are errors; a value with $, a delay depcurfew cannot compare or a file it cannot read gives a warning. pip has python-config-ignored, Composer composer-config-weakens and Bundler bundler-config-weakens.',
  help: 'Remove the variable or the option, or give it a value that keeps what depcurfew.json requires; let a single package through with cooldown.exclude, installScripts.allow or sources in depcurfew.json and depcurfew apply instead.',
  level: 'error',
  requiresPolicy: true,
  // Cargo: also its configuration files depcurfew apply does not write, without a workflow or a Dockerfile (E10).
  applies: (scope) => (usesManager(scope, TOOLS) && (scope.detection.workflows.length > 0 || scope.detection.dockerfiles.length > 0)) || usesManager(scope, ['cargo']),
  check(context) {
    const ci = context.detection.workflows.length > 0 || context.detection.dockerfiles.length > 0;
    for (const tools of usedTools(context)) {
      if (ci) checkTool(context, tools);
      if (tools.config !== undefined) checkCargoFiles(context, tools);
    }
  },
};

/** For tests: the switches of a tool as the rule reads them. */
export function ciSwitchNames(tool: ToolKnowledge): { options: string[]; variables: string[] } {
  const switches = switchesOf(tool);
  return { options: [...switches.options.keys()], variables: switches.variables.map((entry) => entry.name) };
}
