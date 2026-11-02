// composer-config-weakens: settings of composer.json and variables in the env of CI workflows that turn a Composer
// protection off while the cooldown and allow-plugins still look configured: the whole policy, the cooldown or its
// blocking, malware blocking, a repository that lets the author-set time count or skips the malware list,
// allow-plugins that allows every plugin, plain HTTP and no TLS. The settings and values come from the knowledge base.
import { extraOf, isRecord } from '../../apply/facts.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { usesManager } from '../applies.ts';
import { COMPOSER_MANIFEST, composerManifest, declaredRepositories } from '../composer.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import { jsonSetting, yamlSetting } from '../settings.ts';
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
  const broad = isRecord(found?.value) ? Object.keys(found.value).filter((key) => /^\*+$/u.test(key) && (found?.value as Record<string, unknown>)[key] === true) : [];
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
  const jobs = yamlSetting(text, ['jobs'])?.value;
  if (!isRecord(jobs)) return found;
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    found.push({ path: ['jobs', id, 'env'], where: `job ${id}` }, { path: ['jobs', id, 'container', 'env'], where: `the container of job ${id}` });
    const steps = job['steps'];
    if (!Array.isArray(steps)) continue;
    steps.forEach((_, index) => found.push({ path: ['jobs', id, 'steps', String(index), 'env'], where: `step ${index + 1} of job ${id}` }));
  }
  return found;
}

function checkWorkflows(context: RuleContext, tool: ToolKnowledge): void {
  const variables = extraOf(tool, 'environmentOverrides', isList<Variable>((item) => isRecord(item) && typeof item['name'] === 'string'));
  for (const file of context.detection.workflows) {
    const text = context.repository.readText(file);
    if (text === undefined) continue;
    for (const { path, where } of environments(text)) {
      const env = yamlSetting(text, path)?.value;
      if (!isRecord(env)) continue;
      for (const variable of variables) {
        if (!Object.hasOwn(env, variable.name)) continue;
        const value = variableText(env[variable.name]);
        if (value === undefined) continue;
        if (variable.name.includes('COOLDOWN') && !cooldownInPolicy(context)) continue;
        const effect = variableEffect(context, tool, variable, value);
        if (effect === undefined) continue;
        const line = yamlSetting(text, [...path, variable.name])?.line;
        const verb =
          effect.detail === 'may'
            ? `may ${variable.effect.replace(/^(\w+)s\b/u, '$1')}`
            : effect.detail === undefined
              ? variable.effect
              : `${variable.effect} with ${effect.detail}, shorter than the ${context.policy?.cooldown?.minimum.text ?? ''} of ${POLICY_FILE}`;
        // Composer reads these switches with (bool) getenv(), so false and off turn them on too.
        const reading = Array.isArray(variable.values) || variable.values === 'delay' || ['1', 'true', 'on'].includes(value) ? '' : ' (Composer takes every value but "" and "0" for yes)';
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

export const composerConfigWeakens: Rule = {
  id: RULE,
  checks: 'composer.json and the env of CI workflows keep Composer protections on',
  summary: 'composer.json or the env of a CI workflow turns a Composer protection off: the cooldown, malware blocking, allow-plugins, secure-http or TLS.',
  description:
    'Composer 2.11 withholds new versions with config.policy.cooldown and runs only the plugins config.allow-plugins allows. "policy": false, "cooldown": false or "block": false under it, a repository with "require-published-time": false (the cooldown then counts from the time the package author wrote) or "filter": false (no malware list), "allow-plugins": true (or a "*" key) and "secure-http": false or "disable-tls": true turn such a protection off while the configuration still looks right; so do COMPOSER_POLICY=0, COMPOSER_NO_BLOCKING, COMPOSER_POLICY_COOLDOWN_PERIOD with a shorter period and COMPOSER_POLICY_COOLDOWN_BLOCK=0 in the env of a CI workflow. Settings of the cooldown are reported when depcurfew.json sets one, allow-plugins when it denies dependency code; malware blocking and filter give warnings, because depcurfew.json does not manage them. COMPOSER_HOME/config.json on a machine is not read.',
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
  },
};
