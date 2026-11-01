// Renovate: minimumReleaseAge, packageRules entries for exclusions (recognized by their descriptions) and the delay
// for security updates. pypi: names get their own rule limited to the pypi datasource; when the repository also has
// Python packages, the rule for npm names leaves out that datasource, so an npm exception never reaches a Python
// package of the same name. JSON5 files and the deprecated package.json key are not edited; a snippet is printed.
import { delayMinutes, formatMinutes } from '../../doctor/durations.ts';
import { latestVersion } from '../../doctor/effective.ts';
import { readRenovateConfig, renovateDelay } from '../../doctor/renovate.ts';
import type { Ecosystem } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { listing } from '../requirements.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { patternsFor } from '../../policy/package-pattern.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions } from './common.ts';
import type { BotGenerator } from './context.ts';

export const RULE_DESCRIPTION = 'depcurfew: packages excluded from minimumReleaseAge';
export const PYTHON_RULE_DESCRIPTION = 'depcurfew: Python packages excluded from minimumReleaseAge';

interface ExcludeRule {
  list: string;
  match: string;
  value: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isRule = (value: unknown): value is ExcludeRule => isRecord(value) && typeof value['list'] === 'string' && typeof value['match'] === 'string';
const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

export const renovate: BotGenerator = (context, duration) => {
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
  const negative = extraOf(tool, 'negativeMatch', isString);
  const python = context.tools.some((entry) => entry.kind === 'package-manager' && ecosystemOfTool(entry) === 'pypi' && context.targets.has(entry.id));
  const exclusionRule = {
    [descriptionKey]: RULE_DESCRIPTION,
    ...(python ? { matchDatasources: [`${negative}${String(datasources['pypi'])}`] } : {}),
    [rule.match]: patterns,
    [setting]: rule.value,
  };
  const pythonRule = { [descriptionKey]: PYTHON_RULE_DESCRIPTION, matchDatasources: [datasources['pypi']], [rule.match]: pythonPatterns, [setting]: rule.value };
  const managedRules = [
    { description: RULE_DESCRIPTION, rule: exclusionRule, wanted: patterns.length > 0 },
    { description: PYTHON_RULE_DESCRIPTION, rule: pythonRule, wanted: pythonPatterns.length > 0 },
  ];
  const security = policy.cooldown.securityUpdates === 'delay' ? result.value : null;

  const candidates = values(tool.cooldown.configFiles)[0] ?? [];
  const file = candidates.find((name) => context.exists(name));
  const snippet = () =>
    JSON.stringify(
      {
        [setting]: result.value,
        ...(managedRules.some((entry) => entry.wanted) ? { [rule.list]: managedRules.filter((entry) => entry.wanted).map((entry) => entry.rule) } : {}),
        ...(securityPath.reduceRight<unknown>((inner, key) => ({ [key]: inner }), security) as Record<string, unknown>),
      },
      null,
      2,
    );

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
    context.snippet(where, snippet());
    return;
  }

  shorterRules(context, file, result.value, rule.list, descriptionKey);
  const json = context.json(file);
  json.set([setting], result.value);
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
  json.set(securityPath, security);
};

const ECOSYSTEM_LABELS: Readonly<Record<Ecosystem, string>> = { npm: 'npm', pypi: 'Python' };

/**
 * packageRules entries that apply does not manage and that give every package of a registry, or some update types, a
 * shorter delay than the one apply writes: Renovate uses them, and apply never changes entries it did not write, so it
 * warns (decision D-116). They are found as doctor's bot-cooldown-mismatch finds them (renovateDelay), on the file as
 * it is, with the top-level delay apply writes and without depcurfew's own exclusion rules.
 */
function shorterRules(context: Parameters<BotGenerator>[0], file: string, written: unknown, list: string, descriptionKey: string): void {
  const { tool } = context;
  const config = readRenovateConfig(context.read(file), file, []);
  const own = new Set<unknown>([RULE_DESCRIPTION, PYTHON_RULE_DESCRIPTION]);
  const planned = { ...config, top: { value: written, line: config.top?.line ?? 1 }, rules: config.rules.filter((entry) => !own.has(entry.rule[descriptionKey])) };
  const wanted = delayMinutes(tool, written, latestVersion(tool));
  if (!wanted.ok) return;
  const ecosystems = (['npm', 'pypi'] as const).filter((ecosystem) =>
    context.tools.some((entry) => entry.kind === 'package-manager' && context.targets.has(entry.id) && ecosystemOfTool(entry) === ecosystem),
  );
  const found = new Map<number, { line: number; value: unknown; types: Set<string>; ecosystems: Set<Ecosystem> }>();
  for (const ecosystem of ecosystems) {
    const delay = renovateDelay(tool, planned, ecosystem);
    if (!delay.known) continue;
    for (const [type, source] of delay.byType) {
      if (source.rule === undefined) continue;
      const minutes = delayMinutes(tool, source.value, latestVersion(tool));
      if (!minutes.ok || minutes.minutes >= wanted.minutes) continue;
      const entry = found.get(source.rule) ?? { line: source.line, value: source.value, types: new Set<string>(), ecosystems: new Set<Ecosystem>() };
      entry.types.add(type);
      entry.ecosystems.add(ecosystem);
      found.set(source.rule, entry);
    }
  }
  const updateTypes = extraOf(tool, 'delayedUpdateTypes', (value): value is string[] => Array.isArray(value) && value.every(isString));
  const describe = (minutes: number) => (minutes === 0 ? 'no delay' : formatMinutes(minutes));
  for (const [index, entry] of [...found].sort(([a], [b]) => a - b)) {
    const types = updateTypes.filter((type) => entry.types.has(type));
    const scope = types.length === updateTypes.length ? 'updates' : `${listing(types)} updates`;
    context.warn({
      code: 'bot-rule-shortens-delay',
      location: { file, line: entry.line },
      message: `${context.name}: ${list}[${index}] in ${file} (line ${entry.line}) sets minimumReleaseAge: ${JSON.stringify(entry.value)} for ${scope} of ${listing([...entry.ecosystems].map((ecosystem) => ECOSYSTEM_LABELS[ecosystem]))} packages, shorter than the ${describe(wanted.minutes)} depcurfew apply writes for ${context.name}; ${context.name} uses the rule, and depcurfew apply does not change entries it did not write`,
      fix: `Make minimumReleaseAge in ${list}[${index}] of ${file} at least ${describe(wanted.minutes)}, or limit the rule to the packages that need a shorter delay`,
    });
  }
}
