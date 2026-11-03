// bundler-config-weakens (decision D-152): places that give Bundler a shorter cooldown than depcurfew.json, or none,
// while the Gemfile still looks configured. The cooldown setting (BUNDLE_COOLDOWN, .bundle/config) and --cooldown
// take the place of the cooldown: of every Gemfile source, so a 0 there turns the delay off: in .bundle/config of the
// project, in the env of a CI workflow, and on a bundle command or before it in a run step or a Dockerfile RUN.
import { extraOf, isRecord } from '../../apply/facts.ts';
import { programName } from '../../detect/commands.ts';
import { jobLabel } from '../../detect/workflows.ts';
import type { ToolCommand } from '../../detect/types.ts';
import { environment } from '../../knowledge/environment.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { YamlOptions } from '../../yaml-parse.ts';
import { usesManager } from '../applies.ts';
import { yamlAliasProblem, yamlSetting } from '../settings.ts';
import { bundleConfigValue, rubyToI } from '../bundle-config.ts';
import { ciSettings } from '../ci-settings.ts';
import type { Rule, RuleContext } from '../types.ts';

const RULE = 'bundler-config-weakens';

/** Workflows as GitHub reads them: with their aliases expanded (environment.githubActions.yamlAliases, decision D-141). */
const WORKFLOW_YAML: YamlOptions = evidenceOf(environment.githubActions.yamlAliases)[0]?.value.accepted === true ? { aliases: true } : {};

interface SettingFacts {
  key: string;
  variable: string;
  localFile: string;
}

const isSettingFacts = (value: unknown): value is SettingFacts =>
  isRecord(value) && typeof value['key'] === 'string' && typeof value['variable'] === 'string' && typeof value['localFile'] === 'string';

/** What the cooldown setting reads from a text (extra.cooldownSettingValues): days as String#to_i gives them, or unset for "false". */
function settingDays(value: string): number | 'unset' {
  return value === 'false' ? 'unset' : rubyToI(value);
}

/** ", which Bundler reads with to_i as 0," for a value that is not just digits; empty otherwise. */
function readAs(value: string, days: number): string {
  return /^[0-9]+$/u.test(value) ? '' : `, which Bundler reads with to_i as ${days},`;
}

/** The policy's delay in Bundler's whole days, rounded up; undefined without a cooldown. */
function policyDays(context: RuleContext, tool: ToolKnowledge): number | undefined {
  const minimum = context.policy?.cooldown?.minimum;
  if (minimum === undefined) return undefined;
  const converted = convertCooldown(tool, minimum);
  return converted.ok && typeof converted.value === 'number' ? converted.value : undefined;
}

const plural = (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`;

/**
 * What a value does, after "which" or "and": turns the cooldown off, or sets a shorter one, `scope` (for every source,
 * for that command) in place of the cooldown: of the Gemfile; undefined when it is long enough.
 */
function effect(context: RuleContext, days: number | 'unset', wanted: number, scope: string): string | undefined {
  if (days === 'unset' || days >= wanted) return undefined;
  if (days <= 0) return `turns off the cooldown of Bundler ${scope}, in place of the cooldown: of the Gemfile`;
  return `sets the cooldown of Bundler to ${plural(days)} ${scope} in place of the cooldown: of the Gemfile, shorter than the ${context.policy?.cooldown?.minimum.text ?? ''} of ${POLICY_FILE}`;
}

/**
 * .bundle/config of the project: the local config, which Bundler reads before the environment and the Gemfile, read
 * as Bundler reads it (decision D-159, bundle-config.ts). A file Bundler cannot read stops every bundle command, and a
 * map or a list as the value stops the commands that resolve, so neither weakens the cooldown.
 */
function checkLocalConfig(context: RuleContext, facts: SettingFacts, wanted: number): void {
  const file = facts.localFile;
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const found = bundleConfigValue(text, facts.variable);
  if (found === undefined || found === 'error' || found.kind !== 'text') return;
  const { value } = found;
  const days = settingDays(value);
  const what = effect(context, days, wanted, 'for every source');
  if (what === undefined || days === 'unset') return;
  const written = found.written.trim();
  const plain = [`${facts.variable}: ${value}`, `${facts.variable}: "${value}"`, `${facts.variable}: '${value}'`].includes(written);
  const shown = plain
    ? `${facts.variable}: ${JSON.stringify(value)} in ${file}${readAs(value, days)} ${what}`
    : `\`${written}\` in ${file} sets ${facts.variable} to the text ${JSON.stringify(value)} (Bundler reads the file line by line, not as YAML)${/^[0-9]+$/u.test(value) ? '' : `, which to_i reads as ${days}`}, so it ${what}`;
  context.report({
    location: { file, line: found.line },
    message: `${shown}; Bundler reads ${file} before the environment`,
    fix: `Remove ${facts.variable} from ${file} (bundle config unset --local ${facts.key}), so that the cooldown: of the Gemfile applies, or set it to at least ${wanted} (bundle config set --local ${facts.key} ${wanted})`,
  });
}

interface EnvMap {
  path: string[];
  /** How messages name the map's place; the job is named once a variable is found there (jobLabel needs its line). */
  where: (label: (id: string) => string) => string;
  job?: string;
  env: unknown;
}

/**
 * The env maps of a workflow that set the variable: the workflow's, each job's and its container's, and each step's,
 * read from the workflow once, so that thousands of steps cost one reading of the file (decision D-121).
 */
function environments(text: string, variable: string): EnvMap[] {
  const workflow = yamlSetting(text, [], WORKFLOW_YAML)?.value;
  if (!isRecord(workflow)) return [];
  const found: EnvMap[] = [{ path: ['env'], where: () => 'the workflow', env: workflow['env'] }];
  const jobs = workflow['jobs'];
  if (isRecord(jobs)) {
    for (const [id, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const container = job['container'];
      found.push(
        { path: ['jobs', id, 'env'], where: (label) => label(id), job: id, env: job['env'] },
        { path: ['jobs', id, 'container', 'env'], where: (label) => `the container of ${label(id)}`, job: id, env: isRecord(container) ? container['env'] : undefined },
      );
      const steps = job['steps'];
      if (!Array.isArray(steps)) continue;
      steps.forEach((step: unknown, index) => found.push({ path: ['jobs', id, 'steps', String(index), 'env'], where: (label) => `step ${index + 1} of ${label(id)}`, job: id, env: isRecord(step) ? step['env'] : undefined }));
    }
  }
  return found.filter((entry) => isRecord(entry.env) && Object.hasOwn(entry.env, variable));
}

/** BUNDLE_COOLDOWN in the env maps of the workflows; returns the values it reported, per workflow file and job. */
function checkWorkflowEnv(context: RuleContext, facts: SettingFacts, wanted: number): Map<string, Set<string>> {
  const reported = new Map<string, Set<string>>();
  for (const file of context.detection.workflows) {
    const text = context.repository.readText(file);
    if (text === undefined) continue;
    const aliases = WORKFLOW_YAML.aliases === true ? yamlAliasProblem(text) : undefined;
    if (aliases !== undefined) {
      context.notice(`${RULE} could not read the env of ${file}: its YAML aliases cannot be expanded (${aliases})`, file, `Write the values out in place of the aliases in ${file}, then run depcurfew doctor again`);
      continue;
    }
    // A key that is not a GitHub job id is named by its line, never quoted (decision D-135).
    const label = (id: string) => jobLabel(id, yamlSetting(text, ['jobs', id], WORKFLOW_YAML)?.line);
    for (const { path, where: placeOf, job, env } of environments(text, facts.variable)) {
      if (!isRecord(env)) continue;
      const where = placeOf(label);
      const raw = env[facts.variable];
      const setting = yamlSetting(text, [...path, facts.variable], WORKFLOW_YAML);
      // A plain scalar counts as written (1e400 is "1e400", which to_i reads as 1, not Infinity; decision D-159).
      const value = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' || raw === null ? (setting?.written ?? String(raw)) : undefined;
      if (value === undefined) continue;
      const line = setting?.line;
      const location = line === undefined ? { file } : { file, line };
      const key = `${file}\u0000${job ?? ''}`;
      if (value.includes('${{')) {
        reported.set(key, new Set([...(reported.get(key) ?? []), value]));
        context.report({
          level: 'warning',
          location,
          message: `${facts.variable}=${value} in the env of ${where} in ${file} reaches every Bundler command there and may turn off the cooldown of Bundler or shorten it, for every source`,
          fix: `Remove ${facts.variable} from that env in ${file}, or make sure it is never shorter than ${wanted} days`,
        });
        continue;
      }
      const days = settingDays(value);
      const what = effect(context, days, wanted, 'for every source');
      if (what === undefined || days === 'unset') continue;
      reported.set(key, new Set([...(reported.get(key) ?? []), value]));
      context.report({
        location,
        message: `${facts.variable}=${value} in the env of ${where} in ${file} reaches every Bundler command there${readAs(value, days)} and ${what}`,
        fix: `Remove ${facts.variable} from that env in ${file}; for a gem that cannot wait, run bundle update GEM --cooldown 0 by hand after reviewing it`,
      });
    }
  }
  return reported;
}

/** The finding for a bundle command whose delay is shorter, when there is one. */
function reportCommand(context: RuleContext, facts: SettingFacts, wanted: number, command: ToolCommand, file: string, where: string): void {
  if (command.delay === undefined || command.delayUnknown === true) return;
  // The option takes whole days only (a command with another value stops with an error, which protects).
  if (command.delayOption === true && !/^\d+$/u.test(command.delay)) return;
  const days = command.delayOption === true ? Number(command.delay) : settingDays(command.delay);
  const what = effect(context, days, wanted, 'for that command');
  if (what === undefined || days === 'unset') return;
  const how = command.delayOption === true ? `--cooldown ${command.delay}` : `${facts.variable}=${command.delay}`;
  context.report({
    location: { file, line: command.line },
    message: `${where} runs a bundle command with ${how}, which ${what}`,
    fix:
      command.delayOption === true
        ? `Remove --cooldown ${command.delay} from that command in ${file}; for a gem that cannot wait, run bundle update GEM --cooldown 0 by hand after reviewing it`
        : `Remove ${facts.variable} from that command or the place that sets it in ${file}; for a gem that cannot wait, run bundle update GEM --cooldown 0 by hand after reviewing it`,
  });
}

const isBundle = (command: ToolCommand) => command.tool === 'bundler' && command.kind === 'install';

interface ConfigCommandFacts {
  command: string[];
  set: string;
  scopes: string[];
  legacyArguments: number;
}

const isConfigCommandFacts = (value: unknown): value is ConfigCommandFacts =>
  isRecord(value) && Array.isArray(value['command']) && typeof value['set'] === 'string' && Array.isArray(value['scopes']) && typeof value['legacyArguments'] === 'number';

/**
 * The setting and value of a bundle config command that sets one (bundle config set [--local|--global] NAME VALUE, and
 * the older bundle config NAME VALUE; extra.configCommand), with the scope option given; undefined for another command.
 */
function configSetting(words: readonly string[], facts: ConfigCommandFacts, executables: readonly string[]): { name: string; value: string; scope?: string } | undefined {
  const [program, subcommand, ...rest] = words;
  if (program === undefined || !executables.includes(programName(program)) || subcommand !== facts.command[1]) return undefined;
  const scope = rest.find((word) => facts.scopes.includes(word));
  const args = rest.filter((word) => !word.startsWith('-'));
  if (rest.includes('--delete')) return undefined;
  const [first, ...more] = args;
  if (first === facts.set) {
    const [name, ...value] = more;
    return name === undefined || value.length === 0 ? undefined : { name, value: value.join(' '), ...(scope === undefined ? {} : { scope }) };
  }
  // bundle config NAME VALUE: the Bundler 1 interface, which sets with two arguments, or with --local or --global.
  if (first === undefined || ['get', 'unset', 'list'].includes(first) || (args.length !== facts.legacyArguments && scope === undefined) || more.length === 0) return undefined;
  return { name: first, value: more.join(' '), ...(scope === undefined ? {} : { scope }) };
}

/** bundle config set cooldown N in run steps and RUN instructions: it writes the setting for the later bundle commands (decision D-166). */
function checkConfigCommands(context: RuleContext, tool: ToolKnowledge, facts: SettingFacts, wanted: number): void {
  if (tool.extra?.['configCommand'] === undefined) return;
  const config = extraOf(tool, 'configCommand', isConfigCommandFacts);
  const resolve = tool.extra['resolveCommands'] === undefined ? undefined : extraOf(tool, 'resolveCommands', isRecord);
  const executables = Array.isArray(resolve?.['executables']) ? resolve['executables'].filter((item): item is string => typeof item === 'string') : ['bundle'];
  for (const command of ciSettings(context.repository, context.detection).commands) {
    const setting = configSetting(command.words, config, executables);
    if (setting === undefined || setting.name.toLowerCase() !== facts.key) continue;
    const days = settingDays(setting.value);
    const what = effect(context, days, wanted, 'for the later bundle commands');
    if (what === undefined || days === 'unset') continue;
    const target = setting.scope === '--global' ? '~/.bundle/config' : setting.scope === '--local' ? facts.localFile : `${facts.localFile} (or ~/.bundle/config outside a project)`;
    context.report({
      location: { file: command.file, line: command.line },
      message: `${command.where} in ${command.file} (line ${command.line}) runs ${command.words.join(' ')}, which writes ${facts.key} ${setting.value} into ${target}${readAs(setting.value, days)} and ${what}`,
      fix: `Remove that bundle config command from ${command.file}, so that the cooldown: of the Gemfile applies; for a gem that cannot wait, run bundle update GEM --cooldown 0 by hand after reviewing it`,
    });
  }
}

export const bundlerConfigWeakens: Rule = {
  id: RULE,
  checks: '.bundle/config, the env of CI workflows and the bundle commands and bundle config of CI jobs and Dockerfiles keep the cooldown of Bundler',
  summary: '.bundle/config, the env of a CI workflow or a bundle command in a CI job or a Dockerfile turns the cooldown of Bundler off or makes it shorter than the policy.',
  description:
    'Bundler 4.0.13 and later hold back gem versions younger than the cooldown: of the Gemfile source, but the cooldown setting and the --cooldown option take its place for every source. BUNDLE_COOLDOWN with fewer days than depcurfew.json, or 0, in .bundle/config (read line by line as Bundler reads it, not as YAML: quotes stay unless they enclose the whole value, and # starts a comment), in a CI workflow (env, $GITHUB_ENV, before a bundle command) or a Dockerfile (ENV, ARG), bundle config set cooldown N in a run step or a RUN instruction, and a shorter --cooldown on bundle install, update, lock, add or cache (also bundle i, bundle package and bundle _VERSION_ install) turn the delay off or shorten it while the Gemfile still looks configured. Bundler reads the value with to_i: one that does not start with a digit counts as 0, and 1e3 as 1. A value with a ${{ }} expression gives a warning.',
  help: 'Remove the setting, the variable or the option, or give it at least the days of the policy; take a newer version of one gem by hand with bundle update GEM --cooldown 0 after reviewing it.',
  level: 'error',
  requiresPolicy: true,
  applies: (scope) => usesManager(scope, ['bundler']) || scope.detection.jobs.some((job) => job.commands.some(isBundle)),
  check(context) {
    const tool = context.tools.find((entry) => entry.id === 'bundler');
    if (tool === undefined || tool.extra?.['cooldownSetting'] === undefined) return;
    const policy = context.policy;
    if (policy === undefined || (policy.targets !== 'auto' && !policy.targets.includes('bundler'))) return;
    const wanted = policyDays(context, tool);
    if (wanted === undefined) return;
    const facts = extraOf(tool, 'cooldownSetting', isSettingFacts);
    const used = context.detection.packageManagers.some((manager) => manager.id === 'bundler' && manager.supported);
    // Without Bundler and without bundle commands there is nothing whose cooldown the variables could change.
    const commands = context.detection.jobs.some((job) => job.commands.some(isBundle)) || context.detection.dockerfiles.some((file) => file.stages.some((stage) => stage.commands.some(isBundle)));
    if (!used && !commands) return;
    if (used) checkLocalConfig(context, facts, wanted);
    checkConfigCommands(context, tool, facts, wanted);
    const reported = checkWorkflowEnv(context, facts, wanted);
    for (const job of context.detection.jobs) {
      const fromEnv = reported.get(`${job.file}\u0000${job.id}`) ?? new Set<string>();
      const workflowEnv = reported.get(`${job.file}\u0000`) ?? new Set<string>();
      for (const command of job.commands.filter(isBundle)) {
        // A value that an env map of the workflow sets is reported there.
        if (command.delayOption !== true && command.delay !== undefined && (fromEnv.has(command.delay) || workflowEnv.has(command.delay))) continue;
        reportCommand(context, facts, wanted, command, job.file, `${jobLabel(job.id, job.line)} in ${job.file} (line ${command.line})`);
      }
    }
    for (const dockerfile of context.detection.dockerfiles) {
      for (const stage of dockerfile.stages) {
        const name = stage.name === undefined ? `the stage at line ${stage.line}` : `stage ${stage.name}`;
        for (const command of stage.commands.filter(isBundle)) reportCommand(context, facts, wanted, command, dockerfile.file, `${name} in ${dockerfile.file} (line ${command.line})`);
      }
    }
  },
};
