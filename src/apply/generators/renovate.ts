// Renovate: minimumReleaseAge, packageRules entries for exclusions (recognized by their descriptions) and the delay
// for security updates. Each registry's names get a rule limited to its datasource: npm names to npm, pypi: names to
// pypi, composer: names to packagist, so an exception never reaches a package of the same name in another registry, a
// crate or a Go module included (decision D-171). JSON5 files and the deprecated package.json key are not edited; a
// snippet is printed. The top-level minimumReleaseAge covers every Renovate manager, the github-actions manager of the
// workflows' actions (decision D-130) and the managers of the ecosystems updated by bots only (cargo, gomod, maven,
// gradle, nuget; decision D-151) included, so they need no rule of their own. A built-in preset of extends whose rule
// gives a datasource in use a shorter delay (config:best-practices for npm) wins over the top level; a rule for that
// datasource at the front of packageRules gives it the policy's delay again (decision D-171).
import { delayMinutes, formatMinutes } from '../../doctor/durations.ts';
import { latestVersion } from '../../doctor/effective.ts';
import {
  actionsTarget,
  botEcosystemTargets,
  countedRegex,
  countedRegexFix,
  managerTargets,
  presetDelays,
  presetIn,
  readRenovateConfig,
  renovateDelay,
  type RefusedRegex,
  type RenovateConfig,
  type RenovateTarget,
} from '../../doctor/renovate.ts';
import { botEcosystemFacts } from '../../detect/bot-ecosystems.ts';
import type { Ecosystem } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { listing } from '../requirements.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { patternsFor } from '../../policy/package-pattern.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions } from './common.ts';
import { jsonSetting } from '../../doctor/settings.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import type { BotGenerator, BotRepository, Context, JsonFile } from './context.ts';

export const RULE_DESCRIPTION = 'depcurfew: packages excluded from minimumReleaseAge';
export const PYTHON_RULE_DESCRIPTION = 'depcurfew: Python packages excluded from minimumReleaseAge';
export const COMPOSER_RULE_DESCRIPTION = 'depcurfew: Composer packages excluded from minimumReleaseAge';

/** The description of the rule that gives a datasource the policy's delay over a preset's shorter one (decision D-171). */
export const presetRuleDescription = (datasource: string): string => `depcurfew: minimumReleaseAge for the ${datasource} datasource over a preset's shorter delay`;
const PRESET_RULE = /^depcurfew: minimumReleaseAge for the \S+ datasource over a preset's shorter delay$/u;

/** Whether a packageRules description is one of the rules depcurfew apply writes. */
export function isOwnRule(description: unknown): boolean {
  return typeof description === 'string' && ([RULE_DESCRIPTION, PYTHON_RULE_DESCRIPTION, COMPOSER_RULE_DESCRIPTION].includes(description) || PRESET_RULE.test(description));
}

interface ExcludeRule {
  list: string;
  match: string;
  value: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isRule = (value: unknown): value is ExcludeRule => isRecord(value) && typeof value['list'] === 'string' && typeof value['match'] === 'string';
const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isMatchers = (value: unknown): value is { datasourceMatcher: string; updateTypeMatcher: string } =>
  isRecord(value) && typeof value['datasourceMatcher'] === 'string' && typeof value['updateTypeMatcher'] === 'string';

export const renovate: BotGenerator = (context, duration, repository) => {
  const { tool, policy } = context;
  if (policy.cooldown === undefined || duration === undefined) return;
  const result = convertCooldown(tool, duration);
  if (!result.ok) {
    context.warn({ code: 'cooldown-not-written', message: `${context.name}: cooldown not written: ${result.reason}`, fix: result.fix });
    return;
  }
  const setting = settingOf(tool.cooldown.setting) ?? 'minimumReleaseAge';
  const rule = extraOf(tool, 'excludeRule', isRule);
  const descriptionKey = extraOf(tool, 'ruleDescription', isString);
  const securityPath = extraOf(tool, 'securityUpdatesSetting', isPath);
  const datasources = extraOf(tool, 'datasources', isRecord);
  const excluded = policy.cooldown.exclude;
  const patterns = exclusions(context, patternsFor(excluded, 'npm')) ?? [];
  const pythonPatterns = exclusions(context, patternsFor(excluded, 'pypi')) ?? [];
  const composerPatterns = exclusions(context, patternsFor(excluded, 'packagist')) ?? [];
  const matchers = extraOf(tool, 'packageRuleMatching', isMatchers);
  // Each rule is limited to the datasource of its registry, so that the npm names of the policy never reach a crate, a
  // Go module or a gem of the same name (decisions D-065 and D-171).
  const exclusionRule = { [descriptionKey]: RULE_DESCRIPTION, [matchers.datasourceMatcher]: [datasources['npm']], [rule.match]: patterns, [setting]: rule.value };
  const pythonRule = { [descriptionKey]: PYTHON_RULE_DESCRIPTION, [matchers.datasourceMatcher]: [datasources['pypi']], [rule.match]: pythonPatterns, [setting]: rule.value };
  const composerRule = { [descriptionKey]: COMPOSER_RULE_DESCRIPTION, [matchers.datasourceMatcher]: [datasources['packagist']], [rule.match]: composerPatterns, [setting]: rule.value };
  const managedRules = [
    { description: RULE_DESCRIPTION, rule: exclusionRule, wanted: patterns.length > 0 },
    { description: PYTHON_RULE_DESCRIPTION, rule: pythonRule, wanted: pythonPatterns.length > 0 },
    { description: COMPOSER_RULE_DESCRIPTION, rule: composerRule, wanted: composerPatterns.length > 0 },
  ];
  const security = policy.cooldown.securityUpdates === 'delay' ? result.value : null;
  const targets = delayTargets(context, repository);
  // The rules that give the datasources a built-in preset of extends shortens the policy's delay again (decision D-171).
  const presetRules = (config: RenovateConfig | undefined): Record<string, unknown>[] => {
    const wanted = delayMinutes(tool, result.value, latestVersion(tool));
    if (config === undefined || !wanted.ok) return [];
    const updateTypes = extraOf(tool, 'delayedUpdateTypes', (value): value is string[] => Array.isArray(value) && value.every(isString));
    return presetDelays(tool).flatMap((fact) => {
      const preset = delayMinutes(tool, fact.value, latestVersion(tool));
      if (presetIn(config.extends.presets, fact) === undefined || !targets.some(({ target }) => target.datasource === fact.datasource)) return [];
      if (!preset.ok || preset.minutes >= wanted.minutes) return [];
      return [{ [descriptionKey]: presetRuleDescription(fact.datasource), [matchers.datasourceMatcher]: [fact.datasource], [matchers.updateTypeMatcher]: updateTypes, [setting]: result.value }];
    });
  };

  const candidates = values(tool.cooldown.configFiles)[0] ?? [];
  const file = candidates.find((name) => context.exists(name));
  const snippet = (config: RenovateConfig | undefined) => {
    const rules = [...presetRules(config), ...managedRules.filter((entry) => entry.wanted).map((entry) => entry.rule)];
    return JSON.stringify(
      {
        [setting]: result.value,
        ...(rules.length > 0 ? { [rule.list]: rules } : {}),
        ...(securityPath.reduceRight<unknown>((inner, key) => ({ [key]: inner }), security) as Record<string, unknown>),
      },
      null,
      2,
    );
  };

  if (file === undefined || !/\.jsonc?$/u.test(file)) {
    const packageJson = extraOf(tool, 'packageJsonConfig', isRecord);
    const where = file ?? (context.exists('package.json') && context.json('package.json').get([String(packageJson['key'])]) !== undefined ? 'package.json' : undefined);
    if (where === undefined) {
      context.warn({
        code: 'bot-config-missing',
        message: `${context.name}: no configuration file found; depcurfew does not create one`,
        fix: 'Add renovate.json if you use Renovate, then run depcurfew apply again',
      });
      return;
    }
    context.warn(
      where === 'package.json'
        ? {
            code: 'bot-config-not-edited',
            location: { file: where },
            message: `${context.name}: configuration in package.json is deprecated and depcurfew does not edit it`,
            fix: 'Move it to renovate.json, or add the snippet by hand',
          }
        : { code: 'bot-config-not-edited', location: { file: where }, message: `${context.name}: ${where} is not plain JSON or JSONC, so depcurfew does not edit it`, fix: 'Add the snippet by hand' },
    );
    // The presets the snippet answers are read where depcurfew reads them: the package.json key and .renovaterc.
    const base = where === 'package.json' ? [String(packageJson['key'])] : [];
    const readable = where === 'package.json' || where.endsWith('.renovaterc');
    context.snippet(where, snippet(readable ? readRenovateConfig(context.read(where), where, base) : undefined));
    return;
  }

  const json = context.json(file);
  const presets = presetRules(readRenovateConfig(context.read(file), file, []));
  json.set([setting], result.value);
  placePresetRules(json, rule.list, descriptionKey, presets);
  for (const managed of managedRules) {
    const rules = json.get([rule.list]);
    const index = Array.isArray(rules) ? rules.findIndex((entry) => isRecord(entry) && entry[descriptionKey] === managed.description) : -1;
    if (managed.wanted) {
      if (index >= 0) {
        if (JSON.stringify((rules as unknown[])[index]) !== JSON.stringify(managed.rule)) json.replace([rule.list], index, managed.rule);
      } else if (Array.isArray(rules)) {
        json.append([rule.list], managed.rule);
      } else {
        json.set([rule.list], [managed.rule]);
      }
    } else if (index >= 0) {
      json.remove([rule.list], index);
    }
  }
  // On the file as apply leaves it, so that indices and lines are those the user sees.
  shorterRules(context, file, result.value, rule.list, descriptionKey, targets);
  // A delay of security updates set by hand goes when the policy lets them through at once (decision D-167).
  const current = json.get(securityPath);
  const delay = current === undefined || security !== null ? undefined : delayMinutes(tool, current, undefined);
  if (delay?.ok === true && delay.minutes > 0) {
    const line = jsonSetting(context.read(file), securityPath)?.line;
    context.warn({
      code: 'security-delay-removed',
      location: line === undefined ? { file } : { file, line },
      message: `${context.name}: ${securityPath.join('.')} ${JSON.stringify(current)} in ${file}${line === undefined ? '' : ` (line ${line})`} delays security updates by ${formatMinutes(delay.minutes)}; because cooldown.securityUpdates is "bypass" in ${POLICY_FILE}, depcurfew apply sets it to null, so ${context.name} proposes security updates at once`,
      fix: `To keep a delay, set cooldown.securityUpdates to "delay" in ${POLICY_FILE} (security updates then wait as long as cooldown.minimum) and run depcurfew apply again; if an earlier depcurfew apply wrote this value and you changed cooldown.securityUpdates on purpose, nothing to do`,
    });
  }
  json.set(securityPath, security);
};

/**
 * Puts the rules that give datasources the policy's delay over a preset first in packageRules, in their order, and
 * removes the ones no longer wanted (the preset left extends, or no longer waits less than the policy). Renovate
 * applies the rules of the presets before the repository's own and a later rule wins (extra.packageRulesOrder), so
 * at the front such a rule wins over the preset, and every rule of the repository after it, the exclusion rules
 * included, still wins over it; a rule moved further down would undo the exceptions before it, so it is moved back.
 */
function placePresetRules(json: JsonFile, list: string, key: string, wanted: readonly Record<string, unknown>[]): void {
  const current = (): unknown[] | undefined => {
    const rules = json.get([list]);
    return Array.isArray(rules) ? rules : undefined;
  };
  const description = (entry: unknown): unknown => (isRecord(entry) ? entry[key] : undefined);
  const descriptions = new Set(wanted.map(description));
  // Rules no longer wanted, and a second copy of a wanted one.
  for (;;) {
    const rules = current() ?? [];
    const index = rules.findIndex((entry, position) => {
      const text = description(entry);
      return typeof text === 'string' && PRESET_RULE.test(text) && (!descriptions.has(text) || rules.findIndex((other) => description(other) === text) !== position);
    });
    if (index < 0) break;
    json.remove([list], index);
  }
  wanted.forEach((entry, position) => {
    const rules = current();
    if (rules === undefined) {
      json.set([list], [entry]);
      return;
    }
    const index = rules.findIndex((item) => description(item) === description(entry));
    if (index === position) {
      if (JSON.stringify(rules[index]) !== JSON.stringify(entry)) json.replace([list], index, entry);
      return;
    }
    if (index >= 0) json.remove([list], index);
    json.insert([list], position, entry);
  });
}

const ECOSYSTEM_LABELS: Readonly<Record<Ecosystem, string>> = { npm: 'npm', pypi: 'Python', packagist: 'Composer', rubygems: 'Ruby' };

/**
 * What the delay apply writes covers, as doctor's bot-cooldown-mismatch compares it: the packages of each package
 * manager in use (by registry, Renovate manager or category, decision D-131), the dependencies of each ecosystem
 * updated by bots only that the repository has (decision D-151) and the actions of the workflows (decision D-130),
 * each with the label messages name it by.
 */
function delayTargets(context: Context, repository: BotRepository): { target: RenovateTarget; label: string }[] {
  const { tool } = context;
  const inUse = context.tools.filter((entry) => entry.kind === 'package-manager' && context.targets.has(entry.id));
  const actions = repository.workflows.length > 0 ? actionsTarget(tool, repository.workflows) : undefined;
  // The ecosystems updated by bots only that the repository has (decision D-151), named by their package manager.
  const botOnly = botEcosystemTargets(tool, (repository.botEcosystems ?? []).map((entry) => entry.id));
  const botLabels = new Map(botEcosystemFacts().map((entry) => [entry.id, entry.client]));
  return [
    ...managerTargets(tool, inUse).map(({ target, tools }) => ({ target, label: ECOSYSTEM_LABELS[ecosystemOfTool(tools[0] ?? tool)] })),
    ...botOnly.flatMap((target) => (target.ecosystem === undefined ? [] : [{ target, label: botLabels.get(target.ecosystem) ?? target.ecosystem }])),
    ...(actions === undefined ? [] : [{ target: actions, label: ACTIONS_LABEL }]),
  ];
}

/**
 * packageRules entries that apply does not manage and that give every package of a package manager in use (by
 * registry, Renovate manager or category, decision D-131), the actions of the workflows (decision D-130) or the
 * dependencies of an ecosystem updated by bots only that the repository has (decision D-151), or some
 * update types of them, a shorter delay than the one apply writes: Renovate uses them, and apply never changes entries
 * it did not write, so it warns (decision D-116). They are found as doctor's bot-cooldown-mismatch finds them
 * (renovateDelay), on the file as apply leaves it and without depcurfew's own rules; the shorter delay of a built-in
 * preset is not one of them, since the rule apply writes after it gives the policy's delay again (decision D-171).
 */
function shorterRules(context: Context, file: string, written: unknown, list: string, descriptionKey: string, targets: readonly { target: RenovateTarget; label: string }[]): void {
  const { tool } = context;
  const config = readRenovateConfig(context.read(file), file, []);
  const planned = { ...config, top: { value: written, line: config.top?.line ?? 1 }, rules: config.rules.filter((entry) => !isOwnRule(entry.rule[descriptionKey])) };
  const wanted = delayMinutes(tool, written, latestVersion(tool));
  if (!wanted.ok) return;
  const botLabels = new Map(botEcosystemFacts().map((entry) => [entry.id, entry.client]));
  const found = new Map<number, { line: number; value: unknown; types: Set<string>; labels: Set<string>; regex?: RefusedRegex }>();
  for (const { target, label } of targets) {
    const delay = renovateDelay(tool, planned, target);
    if (!delay.known) continue;
    for (const [type, source] of delay.byType) {
      if (source.rule === undefined) continue;
      const minutes = delayMinutes(tool, source.value, latestVersion(tool));
      if (!minutes.ok || minutes.minutes >= wanted.minutes) continue;
      const entry = found.get(source.rule) ?? { line: source.line, value: source.value, types: new Set<string>(), labels: new Set<string>() };
      entry.types.add(type);
      entry.labels.add(label);
      // A /regex/ depcurfew does not run, counted as matching (decision D-200).
      if (source.regex !== undefined) entry.regex ??= source.regex;
      found.set(source.rule, entry);
    }
  }
  const updateTypes = extraOf(tool, 'delayedUpdateTypes', (value): value is string[] => Array.isArray(value) && value.every(isString));
  const describe = (minutes: number) => (minutes === 0 ? 'no delay' : formatMinutes(minutes));
  const order = [...Object.values(ECOSYSTEM_LABELS), ...botLabels.values(), ACTIONS_LABEL];
  for (const [index, entry] of [...found].sort(([a], [b]) => a - b)) {
    const types = updateTypes.filter((type) => entry.types.has(type));
    const scope = types.length === updateTypes.length ? 'updates' : `${listing(types)} updates`;
    const packages = order.filter((label) => label !== ACTIONS_LABEL && entry.labels.has(label));
    const covered = [...(packages.length === 0 ? [] : [`${listing(packages)} packages`]), ...(entry.labels.has(ACTIONS_LABEL) ? [ACTIONS_LABEL] : [])];
    const what = packages.length === 0 ? 'actions' : entry.labels.has(ACTIONS_LABEL) ? 'packages and actions' : 'packages';
    context.warn({
      code: 'bot-rule-shortens-delay',
      location: { file, line: entry.line },
      message: `${context.name}: ${list}[${index}] in ${file} (line ${entry.line}) sets minimumReleaseAge: ${JSON.stringify(entry.value)} for ${scope} of ${listing(covered)}, shorter than the ${describe(wanted.minutes)} depcurfew apply writes for ${context.name}${entry.regex === undefined ? '' : ` (${countedRegex(entry.regex)})`}; ${context.name} uses the rule, and depcurfew apply does not change entries it did not write`,
      fix: `Make minimumReleaseAge in ${list}[${index}] of ${file} at least ${describe(wanted.minutes)}, or limit the rule to the ${what} that need a shorter delay${entry.regex === undefined ? '' : `; ${countedRegexFix(entry.regex)}`}`,
    });
  }
}

/** The actions the workflows run, as messages name them. */
const ACTIONS_LABEL = 'GitHub Actions';
