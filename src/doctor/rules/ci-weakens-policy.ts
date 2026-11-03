// ci-weakens-policy (decision D-166): CI workflows and Dockerfiles that turn off or weaken, for the commands they run,
// what depcurfew apply wrote into the configuration of npm, pnpm, Yarn, Bun, Deno, uv, Poetry and PDM. Read
// where the variables are set (ci-settings.ts: the env of the workflow, a job, its container and a step; export,
// NAME=value before a command and $GITHUB_ENV in run steps; ENV, ARG and RUN of Dockerfile stages) and on the commands
// of the tool: the options and variables of installOverrides, the cooldown option, and for npm the settings of
// installScripts and sources (extra.settingOverrides). pip has python-config-ignored, Composer composer-config-weakens
// and Bundler bundler-config-weakens.
import { isRecord, values } from '../../apply/facts.ts';
import { programName } from '../../detect/commands.ts';
import type { PackageManagerId } from '../../detect/types.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { EnvironmentNameRule, InstallOverridesKnowledge, OverrideValues, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { SourceKind } from '../../apply/generators/common.ts';
import { usesManager } from '../applies.ts';
import { ciSettings, variablePlace } from '../ci-settings.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { plannedApply } from '../plan.ts';
import { iniEntries } from '../settings.ts';
import type { Level, Rule, RuleContext } from '../types.ts';

const RULE = 'ci-weakens-policy';

/** The tools this rule covers; pip, Composer and Bundler have rules of their own. */
const TOOLS: readonly PackageManagerId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'poetry', 'pdm'];

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
  checks: 'CI workflows and Dockerfiles keep the release-age delay, the rule on install scripts and the source bans of npm, pnpm, Yarn, Bun, Deno, uv, Poetry and PDM',
  summary: 'A CI workflow or a Dockerfile turns off or weakens, for the commands it runs, a protection depcurfew apply wrote for npm, pnpm, Yarn, Bun, Deno, uv, Poetry or PDM.',
  description:
    'Package managers take settings from the command line and the environment over their configuration files, so a workflow or a Dockerfile can undo what depcurfew apply wrote for every install it runs: NPM_CONFIG_MIN_RELEASE_AGE=0, npm_config_strict_allow_scripts=false, npm_config_allow_git=all, pnpm_config_minimum_release_age=0, YARN_ENABLE_SCRIPTS=true or UV_EXCLUDE_NEWER in the env of the workflow, a job, its container or a step, exported or set before a command in a run step, written to $GITHUB_ENV, or set with ENV or ARG in a Dockerfile; and npm --min-release-age=0 or --allow-git=all, pnpm --config.dangerously-allow-all-builds=true, uv lock --exclude-newer or pdm lock --exclude-newer on a command there. A shorter delay and install scripts or sources the policy denies are errors; a value with $ or ${{ }}, or a delay depcurfew cannot compare (a date), gives a warning. pip has python-config-ignored, Composer composer-config-weakens and Bundler bundler-config-weakens.',
  help: 'Remove the variable or the option, or give it a value that keeps what depcurfew.json requires; let a single package through with cooldown.exclude, installScripts.allow or sources in depcurfew.json and depcurfew apply instead.',
  level: 'error',
  requiresPolicy: true,
  applies: (scope) => usesManager(scope, TOOLS) && (scope.detection.workflows.length > 0 || scope.detection.dockerfiles.length > 0),
  check(context) {
    if (context.detection.workflows.length === 0 && context.detection.dockerfiles.length === 0) return;
    for (const tools of usedTools(context)) checkTool(context, tools);
  },
};

/** For tests: the switches of a tool as the rule reads them. */
export function ciSwitchNames(tool: ToolKnowledge): { options: string[]; variables: string[] } {
  const switches = switchesOf(tool);
  return { options: [...switches.options.keys()], variables: switches.variables.map((entry) => entry.name) };
}
