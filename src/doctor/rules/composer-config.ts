// composer-config-weakens: settings of composer.json and variables in the env of CI workflows that turn a Composer
// protection off while the cooldown and allow-plugins still look configured: the whole policy, the cooldown or its
// blocking, malware blocking, a repository that lets the author-set time count or skips the malware list,
// allow-plugins that allows every plugin, plain HTTP and no TLS. The settings and values come from the knowledge base.
import { programName } from '../../detect/commands.ts';
import { jobLabel } from '../../detect/workflows.ts';
import { ciSettings, variablePlace } from '../ci-settings.ts';
import { extraOf, isRecord } from '../../apply/facts.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { usesManager } from '../applies.ts';
import { COMPOSER_MANIFEST, composerManifest, declaredRepositories, matchesEveryComposerName } from '../composer.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import { jsonSetting, yamlAliasProblem, yamlSetting } from '../settings.ts';
import { environment } from '../../knowledge/environment.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { YamlOptions } from '../../yaml-parse.ts';

/** Workflows as GitHub reads them: with their aliases expanded (environment.githubActions.yamlAliases, decision D-141). */
const WORKFLOW_YAML: YamlOptions = evidenceOf(environment.githubActions.yamlAliases)[0]?.value.accepted === true ? { aliases: true } : {};
import type { Level, Rule, RuleContext } from '../types.ts';

const RULE = 'composer-config-weakens';

interface Weakening {
  path: string[];
  when: 'false' | 'php-false' | 'update';
  effect: string;
}

interface Transport {
  path: string[];
  weakensWhen: boolean;
  effect: string;
}

interface RepositoryOption {
  key: string;
  when: 'false';
  list?: string;
  effect: string;
}

interface Variable {
  name: string;
  values: 'delay' | readonly string[] | { except: readonly string[] };
  effect: string;
}

const isList = <T>(check: (item: unknown) => boolean) => (value: unknown): value is T[] => Array.isArray(value) && value.every(check);
const isPath = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** PHP's (bool) cast of a JSON value. */
function phpBool(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !(value === false || value === null || value === 0 || value === '' || value === '0');
}

/** Config::get for secure-http and disable-tls: $value !== 'false' && (bool) $value. */
function composerBool(value: unknown): boolean {
  return value !== 'false' && phpBool(value);
}

function weakens(when: Weakening['when'], value: unknown): boolean {
  if (when === 'false') return value === false;
  // A null block keeps the default (?? true).
  if (when === 'php-false') return value !== null && value !== undefined && !phpBool(value);
  return value === when;
}

/** Whether the cooldown part of the policy is in use, which some settings only matter for. */
function cooldownInPolicy(context: RuleContext): boolean {
  return context.policy?.cooldown !== undefined;
}

function checkManifest(context: RuleContext, tool: ToolKnowledge, text: string): void {
  const settings = extraOf(tool, 'weakeningSettings', isList<Weakening>((item) => isRecord(item) && isPath(item['path']) && typeof item['when'] === 'string'));
  for (const setting of settings) {
    const found = jsonSetting(text, setting.path);
    if (found === undefined || !weakens(setting.when, found.value)) continue;
    const cooldown = setting.path.includes('cooldown');
    // The cooldown settings matter when depcurfew.json asks for a delay; the rest always.
    if (cooldown && !cooldownInPolicy(context)) continue;
    context.report({
      level: setting.path.includes('malware') ? 'warning' : 'error',
      location: { file: COMPOSER_MANIFEST, line: found.line },
      message: `${setting.path.join('.')} in ${COMPOSER_MANIFEST} is ${JSON.stringify(found.value)}, which ${setting.effect}`,
      fix: `Remove ${setting.path.at(-1) ?? ''} from ${setting.path.slice(0, -1).join('.')} in ${COMPOSER_MANIFEST}${cooldown || setting.path.length === 2 ? ', then run depcurfew apply' : ''}`,
    });
  }
  const transport = extraOf(tool, 'transportSettings', isList<Transport>((item) => isRecord(item) && isPath(item['path']) && typeof item['weakensWhen'] === 'boolean'));
  for (const setting of transport) {
    const found = jsonSetting(text, setting.path);
    if (found === undefined || composerBool(found.value) !== setting.weakensWhen) continue;
    context.report({
      level: 'error',
      location: { file: COMPOSER_MANIFEST, line: found.line },
      message: `${setting.path.join('.')} in ${COMPOSER_MANIFEST} is ${JSON.stringify(found.value)}, which ${setting.effect}: a package or its metadata can be changed on the way`,
      fix: `Remove ${setting.path.at(-1) ?? ''} from config in ${COMPOSER_MANIFEST}, and serve the repository that needs it over HTTPS`,
    });
  }
  // allow-plugins that lets every plugin run, while the policy denies dependency code by default.
  if (context.policy?.installScripts?.default !== 'deny') return;
  const all = extraOf(tool, 'allowAllPlugins', (value): value is { setting: string; patterns: string[] } => isRecord(value) && typeof value['setting'] === 'string' && Array.isArray(value['patterns']));
  const path = all.setting.split('.');
  const found = jsonSetting(text, path);
  // A key such as "*" or "*/*" matches every vendor/name plugin (extra.allowAllPlugins).
  const broad = isRecord(found?.value) ? Object.keys(found.value).filter((key) => matchesEveryComposerName(key) && (found?.value as Record<string, unknown>)[key] === true) : [];
  if (found?.value === true || broad.length > 0) {
    const at = broad.length > 0 ? jsonSetting(text, [...path, broad[0] ?? ''])?.line : found?.line;
    context.report({
      level: 'error',
      location: { file: COMPOSER_MANIFEST, line: at ?? found?.line ?? 1 },
      message: `${all.setting} in ${COMPOSER_MANIFEST} ${found?.value === true ? 'is true' : `has "${broad[0] ?? ''}": true`}, which lets every Composer plugin run its code, but installScripts in ${POLICY_FILE} denies dependency code by default`,
      fix: `List the plugins that may run in installScripts.allow in ${POLICY_FILE} (with the prefix composer:) and run depcurfew apply, ${found?.value === true ? 'which replaces true with them' : `then remove "${broad[0] ?? ''}" from ${all.setting}`}`,
    });
  }
}

function checkRepositories(context: RuleContext, tool: ToolKnowledge): void {
  const options = extraOf(tool, 'repositoryWeakening', isList<RepositoryOption>((item) => isRecord(item) && typeof item['key'] === 'string'));
  const manifest = composerManifest(context.repository);
  const list = manifest?.['repositories'];
  const entries = Array.isArray(list) ? list.map((item, index): [string | number, unknown] => [index, item]) : isRecord(list) ? Object.entries(list) : [];
  const lines = new Map(declaredRepositories(context.repository, tool).map((entry) => [String(entry.key), entry.line]));
  for (const [key, entry] of entries) {
    if (!isRecord(entry)) continue;
    for (const option of options) {
      const value = entry[option.key];
      const off = value === false || (option.list !== undefined && isRecord(value) && value[option.list] === false);
      if (!off) continue;
      if (option.key !== 'filter' && !cooldownInPolicy(context)) continue;
      const url = typeof entry['url'] === 'string' ? ` (${entry['url']})` : '';
      context.report({
        level: 'warning',
        location: { file: COMPOSER_MANIFEST, line: lines.get(String(key)) ?? 1 },
        message: `repositories[${String(key)}]${url} in ${COMPOSER_MANIFEST} sets ${option.key} to ${JSON.stringify(value)}, which ${option.effect}`,
        fix: `Remove ${option.key} from repositories[${String(key)}] in ${COMPOSER_MANIFEST}, or move the packages that need it to a repository that does not`,
      });
    }
  }
}

/** The text of a variable as the runner passes it (a YAML true is "true"). */
function variableText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** What a value of a variable does: weakens, may weaken (an expression), or nothing. */
function variableEffect(context: RuleContext, tool: ToolKnowledge, variable: Variable, value: string): { level: Level; detail?: string } | undefined {
  if (value.includes('${{')) return { level: 'warning', detail: 'may' };
  if (variable.values === 'delay') {
    if (value === '') return undefined;
    const minutes = delayMinutes(tool, value, latestVersion(tool));
    const wanted = context.policy?.cooldown?.minimum.minutes;
    // A value Composer cannot read makes the command fail, which protects.
    if (!minutes.ok || wanted === undefined) return undefined;
    return minutes.minutes < wanted ? { level: 'error', detail: minutes.minutes === 0 ? 'no delay' : formatMinutes(minutes.minutes) } : undefined;
  }
  const values = variable.values;
  const off = Array.isArray(values) ? values.includes(value) : !(values as { except: readonly string[] }).except.includes(value);
  return off ? { level: variable.name.includes('MALWARE') ? 'warning' : 'error' } : undefined;
}

/** The env maps of a workflow: the workflow's, each job's and its container's, and each step's. */
function environments(text: string): { path: string[]; where: string }[] {
  const found: { path: string[]; where: string }[] = [{ path: ['env'], where: 'the workflow' }];
  const jobs = yamlSetting(text, ['jobs'], WORKFLOW_YAML)?.value;
  if (!isRecord(jobs)) return found;
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    // A key that is not a GitHub job id is named by its line, never quoted (decision D-135).
    const label = jobLabel(id, yamlSetting(text, ['jobs', id], WORKFLOW_YAML)?.line);
    found.push({ path: ['jobs', id, 'env'], where: label }, { path: ['jobs', id, 'container', 'env'], where: `the container of ${label}` });
    const steps = job['steps'];
    if (!Array.isArray(steps)) continue;
    steps.forEach((_, index) => found.push({ path: ['jobs', id, 'steps', String(index), 'env'], where: `step ${index + 1} of ${label}` }));
  }
  return found;
}

function checkWorkflows(context: RuleContext, tool: ToolKnowledge): void {
  const variables = extraOf(tool, 'environmentOverrides', isList<Variable>((item) => isRecord(item) && typeof item['name'] === 'string'));
  for (const file of context.detection.workflows) {
    const text = context.repository.readText(file);
    if (text === undefined) continue;
    // GitHub expands the aliases of a workflow; aliases depcurfew cannot expand leave its env unread (fail closed).
    const aliases = WORKFLOW_YAML.aliases === true ? yamlAliasProblem(text) : undefined;
    if (aliases !== undefined) {
      context.notice(`${RULE} could not read the env of ${file}: its YAML aliases cannot be expanded (${aliases})`, file, `Write the values out in place of the aliases in ${file}, then run depcurfew doctor again`);
      continue;
    }
    for (const { path, where } of environments(text)) {
      const env = yamlSetting(text, path, WORKFLOW_YAML)?.value;
      if (!isRecord(env)) continue;
      for (const variable of variables) {
        if (!Object.hasOwn(env, variable.name)) continue;
        const value = variableText(env[variable.name]);
        if (value === undefined) continue;
        if (variable.name.includes('COOLDOWN') && !cooldownInPolicy(context)) continue;
        const effect = variableEffect(context, tool, variable, value);
        if (effect === undefined) continue;
        const line = yamlSetting(text, [...path, variable.name], WORKFLOW_YAML)?.line;
        const verb =
          effect.detail === 'may'
            ? `may ${variable.effect.replace(/^(\w+)s\b/u, '$1')}`
            : effect.detail === undefined
              ? variable.effect
              : `${variable.effect} with ${effect.detail}, shorter than the ${context.policy?.cooldown?.minimum.text ?? ''} of ${POLICY_FILE}`;
        // COMPOSER_NO_BLOCKING also sets --no-blocking through (bool) getenv(), so false and off turn it on (environmentOverrides).
        const both = Array.isArray(variable.values) && variable.values.includes('true') && variable.values.includes('false');
        const reading = both && ['false', 'off'].includes(value) ? ' (Composer reads false and off as yes for this variable)' : '';
        context.report({
          level: effect.level,
          location: line === undefined ? { file } : { file, line },
          message: `${variable.name}=${value} in the env of ${where} in ${file} reaches every Composer command there and ${verb}${reading}`,
          fix: `Remove ${variable.name} from that env in ${file}, or set it only for a run that needs it after reviewing the packages`,
        });
      }
    }
  }
}

interface ConfigValues {
  command: string[];
  section: string;
  accepted: string[];
  falseValues: string[];
  period: string;
  otherFile: string[];
}

const isConfigValues = (value: unknown): value is ConfigValues =>
  isRecord(value) && Array.isArray(value['command']) && typeof value['section'] === 'string' && Array.isArray(value['accepted']) && Array.isArray(value['falseValues']) && typeof value['period'] === 'string' && Array.isArray(value['otherFile']);

/** The variables of environmentOverrides set outside the env maps of workflows: run steps, $GITHUB_ENV and Dockerfiles (decision D-166). */
function checkCiVariables(context: RuleContext, tool: ToolKnowledge): void {
  const variables = extraOf(tool, 'environmentOverrides', isList<Variable>((item) => isRecord(item) && typeof item['name'] === 'string'));
  for (const place of ciSettings(context.repository, context.detection).variables) {
    if (place.kind === 'env') continue;
    const variable = variables.find((entry) => entry.name === place.name);
    if (variable === undefined || (variable.name.includes('COOLDOWN') && !cooldownInPolicy(context))) continue;
    // A value the shell expands may be anything, like an expression of the workflow.
    const effect = variableEffect(context, tool, variable, place.value.includes('$') ? '${{' : place.value);
    if (effect === undefined) continue;
    const verb =
      effect.detail === 'may'
        ? `may ${variable.effect.replace(/^(\w+)s\b/u, '$1')}`
        : effect.detail === undefined
          ? variable.effect
          : `${variable.effect} with ${effect.detail}, shorter than the ${context.policy?.cooldown?.minimum.text ?? ''} of ${POLICY_FILE}`;
    const text = variablePlace(place, 'Composer');
    context.report({
      level: effect.level,
      location: place.line === undefined ? { file: place.file } : { file: place.file, line: place.line },
      message: `${place.name}=${place.value} ${text.place}, ${text.reach}, and ${verb}`,
      fix: `${text.remove}, or set it only for a run that needs it after reviewing the packages`,
    });
  }
}

/**
 * What composer config KEY VALUE writes (extra.configCommandValues): the path under config and the value as Composer
 * stores it; undefined for a command that writes another file, removes a setting or does not set one.
 */
function configWrite(words: readonly string[], facts: ConfigValues): { key: string; path: string[]; written: string; value: unknown } | undefined {
  const [program, subcommand, ...rest] = words;
  if (program === undefined || programName(program) !== facts.command[0] || subcommand !== facts.command[1]) return undefined;
  const otherFile = (word: string) => facts.otherFile.includes(word) || facts.otherFile.some((option) => option.startsWith('--') && word.startsWith(`${option}=`));
  if (rest.some((word) => otherFile(word) || word === '--unset' || word === '--editor' || word === '-e')) return undefined;
  const [key, written] = rest.filter((word) => !word.startsWith('-'));
  if (key === undefined || written === undefined) return undefined;
  const path = [facts.section, ...(key.startsWith('policy.') ? key.split('.') : [key])];
  if (key === facts.period) return { key, path, written, value: written === '' || written === 'null' ? null : /^\d+$/u.test(written) ? Number(written) : written };
  if (!facts.accepted.includes(written)) return { key, path, written, value: written };
  return { key, path, written, value: !facts.falseValues.includes(written) };
}

/** composer config commands in run steps and RUN instructions that write a setting turning a protection off (decision D-166). */
function checkConfigCommands(context: RuleContext, tool: ToolKnowledge): void {
  if (tool.extra?.['configCommandValues'] === undefined) return;
  const facts = extraOf(tool, 'configCommandValues', isConfigValues);
  const settings = extraOf(tool, 'weakeningSettings', isList<Weakening>((item) => isRecord(item) && isPath(item['path']) && typeof item['when'] === 'string'));
  const transport = extraOf(tool, 'transportSettings', isList<Transport>((item) => isRecord(item) && isPath(item['path']) && typeof item['weakensWhen'] === 'boolean'));
  const all = extraOf(tool, 'allowAllPlugins', (value): value is { setting: string } => isRecord(value) && typeof value['setting'] === 'string');
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((part, index) => part === b[index]);
  for (const command of ciSettings(context.repository, context.detection).commands) {
    const write = configWrite(command.words, facts);
    if (write === undefined) continue;
    let found: { level: Level; effect: string } | undefined;
    const weakening = settings.find((entry) => same(entry.path, write.path));
    if (weakening !== undefined && weakens(weakening.when, write.value) && (!write.path.includes('cooldown') || cooldownInPolicy(context))) {
      found = { level: write.path.includes('malware') ? 'warning' : 'error', effect: weakening.effect };
    }
    const unsafe = transport.find((entry) => same(entry.path, write.path));
    if (unsafe !== undefined && typeof write.value === 'boolean' && write.value === unsafe.weakensWhen) found = { level: 'error', effect: `${unsafe.effect}: a package or its metadata can be changed on the way` };
    if (same(all.setting.split('.'), write.path) && write.value === true && context.policy?.installScripts?.default === 'deny') {
      found = { level: 'error', effect: `lets every Composer plugin run its code, but installScripts in ${POLICY_FILE} denies dependency code by default` };
    }
    if (write.key === facts.period && cooldownInPolicy(context)) {
      const minutes = delayMinutes(tool, write.value, latestVersion(tool));
      const wanted = context.policy?.cooldown?.minimum.minutes ?? 0;
      if (minutes.ok && minutes.minutes < wanted) {
        found = { level: 'error', effect: minutes.minutes === 0 ? 'turns off the cooldown' : `shortens the cooldown to ${formatMinutes(minutes.minutes)}, shorter than the ${context.policy?.cooldown?.minimum.text ?? ''} of ${POLICY_FILE}` };
      }
    }
    if (found === undefined) continue;
    context.report({
      level: found.level,
      location: { file: command.file, line: command.line },
      message: `${command.where} in ${command.file} (line ${command.line}) runs composer config ${write.key} ${write.written}, which writes ${write.path.join('.')}: ${JSON.stringify(write.value)} into ${COMPOSER_MANIFEST} for the later Composer commands and ${found.effect}`,
      fix: `Remove that composer config command from ${command.file}, so that the settings depcurfew apply wrote into ${COMPOSER_MANIFEST} apply`,
    });
  }
}

/** Options of composer commands in run steps and RUN instructions that turn a protection off (installOverrides, decision D-166). */
function checkCommandOptions(context: RuleContext, tool: ToolKnowledge): void {
  if (tool.extra?.['installOverrides'] === undefined || tool.extra['configCommandValues'] === undefined) return;
  const fact = extraOf(tool, 'installOverrides', isRecord);
  const options = Array.isArray(fact['options']) ? (fact['options'] as { name: string; weakens: string; effect?: string }[]) : [];
  const executable = extraOf(tool, 'configCommandValues', isConfigValues).command[0];
  for (const command of ciSettings(context.repository, context.detection).commands) {
    if (programName(command.words[0] ?? '') !== executable) continue;
    for (const word of command.words.slice(1)) {
      if (word === '--') break;
      const option = options.find((entry) => entry.name === word);
      if (option === undefined || (option.weakens === 'delay' && !cooldownInPolicy(context))) continue;
      const effect = option.weakens === 'delay' ? 'turns off the cooldown for that command' : (option.effect ?? 'turns a protection of Composer off');
      context.report({
        location: { file: command.file, line: command.line },
        message: `${command.where} in ${command.file} (line ${command.line}) runs composer with ${word}, which ${effect}`,
        fix: `Remove ${word} from that command in ${command.file}; for a package that cannot wait, run the command with it by hand after reviewing the package`,
      });
    }
  }
}

export const composerConfigWeakens: Rule = {
  id: RULE,
  checks: 'composer.json, CI workflows and Dockerfiles keep Composer protections on',
  summary: 'composer.json, a CI workflow or a Dockerfile turns a Composer protection off: the cooldown, malware blocking, allow-plugins, secure-http or TLS.',
  description:
    'Composer 2.11 withholds new versions with config.policy.cooldown and runs only the plugins config.allow-plugins allows. "policy", "cooldown" or "block" under it set to false, a repository with "require-published-time": false or "filter": false, "allow-plugins": true (or a "*" or "*/*" key), "secure-http": false and "disable-tls": true turn such a protection off while the configuration looks right; so do COMPOSER_POLICY=0, COMPOSER_NO_BLOCKING or COMPOSER_NO_SECURITY_BLOCKING set to 1, true, on, false or off, a shorter COMPOSER_POLICY_COOLDOWN_PERIOD and COMPOSER_POLICY_COOLDOWN_BLOCK=0 in a CI workflow (env, run step, $GITHUB_ENV) or a Dockerfile (ENV, ARG, RUN), composer config policy.cooldown false and the like run there, and --no-cooldown or --no-blocking on a composer command there. Cooldown settings count when depcurfew.json sets a cooldown, allow-plugins when it denies dependency code; malware blocking and filter give warnings. COMPOSER_HOME/config.json is not read.',
  help: 'Remove the setting or the variable, or limit it to the repository or the run that needs it.',
  level: 'error',
  requiresPolicy: false,
  applies: (scope) => usesManager(scope, ['composer']),
  check(context) {
    const tool = context.tools.find((entry) => entry.id === 'composer');
    if (tool === undefined || !context.detection.packageManagers.some((entry) => entry.id === 'composer' && entry.supported)) return;
    const text = context.repository.readText(COMPOSER_MANIFEST);
    if (text !== undefined) {
      checkManifest(context, tool, text);
      checkRepositories(context, tool);
    }
    checkWorkflows(context, tool);
    checkCiVariables(context, tool);
    checkConfigCommands(context, tool);
    checkCommandOptions(context, tool);
  },
};
