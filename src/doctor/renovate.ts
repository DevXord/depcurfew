// Renovate configuration as doctor reads it: the delay Renovate applies to the packages of one registry, from the
// top-level minimumReleaseAge, the presets in extends and the packageRules that cover every package of that registry
// (extra.packageRuleMatching, extra.packageRulesOrder). A rule that narrows the packages by anything else (names,
// files, dependency types, managers...) is an exception for some packages and does not count.
import { extraOf, isRecord } from '../apply/facts.ts';
import { wildcardMatch } from '../detect/wildcard.ts';
import type { Ecosystem, ToolKnowledge } from '../knowledge/types.ts';
import { jsonElementLines, jsonSetting } from './settings.ts';

export type UpdateType = string;

export interface RenovateRule {
  index: number;
  line: number;
  rule: Record<string, unknown>;
}

export interface RenovateConfig {
  file: string;
  /** Path of the configuration inside the file: ["renovate"] in package.json, [] elsewhere. */
  base: readonly string[];
  top: { value: unknown; line: number } | undefined;
  extends: { presets: string[]; line: number };
  rules: RenovateRule[];
}

/** Where the delay of one update type comes from. */
export interface DelaySource {
  value: unknown;
  /** For messages, e.g. `minimumReleaseAge: "3 days" in renovate.json`. */
  origin: string;
  line: number;
  /** The packageRules entry of the repository that set it, if one did. */
  rule?: number;
}

export type RenovateDelay =
  | { known: true; byType: Map<UpdateType, DelaySource> }
  /** A preset depcurfew cannot read may set the delay, and the repository itself sets none. */
  | { known: false; preset: string; line: number };

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isMatching = (value: unknown): value is { negation: string; allPatterns: string; packageMatchers: string[]; datasourceMatcher: string; updateTypeMatcher: string } =>
  isRecord(value) && typeof value['negation'] === 'string' && isStrings(value['packageMatchers']) && typeof value['datasourceMatcher'] === 'string';
const isPresetFact = (value: unknown): value is { presets: string[]; value: string; datasource: string } =>
  isRecord(value) && isStrings(value['presets']) && typeof value['value'] === 'string' && typeof value['datasource'] === 'string';
const isInternal = (value: unknown): value is { prefixes: string[]; settingDelay: string[] } =>
  isRecord(value) && isStrings(value['prefixes']) && isStrings(value['settingDelay']);

export function readRenovateConfig(text: string, file: string, base: readonly string[]): RenovateConfig {
  const top = jsonSetting(text, [...base, 'minimumReleaseAge']);
  const extendsList = jsonSetting(text, [...base, 'extends']);
  const list = jsonSetting(text, [...base, 'packageRules']);
  // The lines of all rules from one parse: a file with thousands of rules is not parsed again for each.
  const lines = Array.isArray(list?.value) ? jsonElementLines(text, [...base, 'packageRules']) : undefined;
  const rules = Array.isArray(list?.value)
    ? (list.value as unknown[]).flatMap((rule, index): RenovateRule[] => (isRecord(rule) ? [{ index, rule, line: lines?.[index] ?? list.line }] : []))
    : [];
  return {
    file,
    base,
    top,
    extends: { presets: isStrings(extendsList?.value) ? extendsList.value : [], line: extendsList?.line ?? 1 },
    rules,
  };
}

/**
 * Whether one Renovate pattern matches `input`, as matchRegexOrGlob does: "*", a /regex/ (with ! for "not"), or a
 * case-insensitive glob. undefined for glob syntax beyond * (braces, classes...), which depcurfew does not evaluate.
 */
function matchesPattern(input: string, pattern: string, negation: string): boolean | undefined {
  const negative = pattern.startsWith(negation);
  const body = negative ? pattern.slice(negation.length) : pattern;
  if (!negative && body === '*') return true;
  const regex = /^\/(.+)\/(i?)$/u.exec(body);
  if (regex !== null) {
    let result: boolean;
    try {
      result = new RegExp(regex[1] ?? '', regex[2] === 'i' ? 'iu' : 'u').test(input);
    } catch {
      return undefined;
    }
    return negative ? !result : result;
  }
  if (/[?[\]{}()!+@]/u.test(body.replace(/^@/u, ''))) return undefined;
  const result = wildcardMatch(input.toLowerCase(), body.toLowerCase().replaceAll('**', '*'));
  return negative ? !result : result;
}

/** matchRegexOrGlobList: some positive pattern matches (when there are any) and every negative pattern does too. */
function matchesList(input: string, patterns: readonly string[], negation: string): boolean | undefined {
  if (patterns.length === 0) return false;
  const positive = patterns.filter((pattern) => !pattern.startsWith(negation));
  const negative = patterns.filter((pattern) => pattern.startsWith(negation));
  const results = positive.map((pattern) => matchesPattern(input, pattern, negation));
  if (positive.length > 0 && !results.includes(true)) return results.includes(undefined) ? undefined : false;
  const excluded = negative.map((pattern) => matchesPattern(input, pattern, negation));
  if (excluded.includes(false)) return false;
  return excluded.includes(undefined) ? undefined : true;
}

/** Patterns that match every package name: *, **, @*\/*, npm:*, and regexes like /.*\/. */
export function matchesEveryName(pattern: string): boolean {
  const name = pattern.replace(/^(npm|jsr):/u, '');
  return /^(@\*+\/)?\*+$/u.test(name) || /^\/\^?\.[*+]\$?\/[a-z]*$/u.test(name);
}

export interface RuleScope {
  /** The delayed update types the rule applies to for every package of the registry. */
  updateTypes: UpdateType[];
  /** How the rule covers the packages, for messages. */
  names: { kind: 'all' } | { kind: 'pattern'; pattern: string } | { kind: 'except'; patterns: string[] };
  /** The matchers the rule has (none: it applies to everything). */
  matchers: string[];
}

/**
 * The update types for which a rule applies to every package of `ecosystem`, or undefined when it narrows the
 * packages (or depcurfew cannot tell).
 */
export function ruleScope(bot: ToolKnowledge, rule: Record<string, unknown>, ecosystem: Ecosystem): RuleScope | undefined {
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', isStrings);
  const datasources = extraOf(bot, 'datasources', isRecord);
  const matchers = Object.keys(rule).filter((key) => /^(match|exclude)[A-Z]/u.test(key));
  const known = new Set([...matching.packageMatchers, matching.datasourceMatcher, matching.updateTypeMatcher]);
  if (matchers.some((key) => !known.has(key))) return undefined;
  let names: RuleScope['names'] = { kind: 'all' };
  for (const key of matching.packageMatchers) {
    if (!(key in rule)) continue;
    const patterns = rule[key];
    if (!isStrings(patterns) || patterns.length === 0) return undefined;
    const positive = patterns.filter((pattern) => !pattern.startsWith(matching.negation));
    const broad = positive.find(matchesEveryName);
    if (positive.length > 0 && broad === undefined) return undefined;
    if (broad !== undefined && names.kind === 'all') names = { kind: 'pattern', pattern: broad };
    else if (positive.length === 0) names = { kind: 'except', patterns: [...(names.kind === 'except' ? names.patterns : []), ...patterns] };
  }
  if (matching.datasourceMatcher in rule) {
    const patterns = rule[matching.datasourceMatcher];
    const datasource = datasources[ecosystem];
    if (!isStrings(patterns) || typeof datasource !== 'string' || matchesList(datasource, patterns, matching.negation) !== true) return undefined;
  }
  let types = updateTypes;
  if (matching.updateTypeMatcher in rule) {
    const patterns = rule[matching.updateTypeMatcher];
    if (!isStrings(patterns)) return undefined;
    types = updateTypes.filter((type) => matchesList(type, patterns, matching.negation) === true);
  }
  return types.length === 0 ? undefined : { updateTypes: types, names, matchers };
}

function presetName(preset: string): string {
  return preset.replace(/\(.*\)$/u, '');
}

/**
 * The delay Renovate applies to every package of `ecosystem`, for each delayed update type. Without a top-level value
 * or a rule, an update type has no entry: Renovate does not wait.
 */
export function renovateDelay(bot: ToolKnowledge, config: RenovateConfig, ecosystem: Ecosystem): RenovateDelay {
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', isStrings);
  const internal = extraOf(bot, 'internalPresets', isInternal);
  const datasources = extraOf(bot, 'datasources', isRecord);
  const byType = new Map<UpdateType, DelaySource>();
  const set = (types: readonly UpdateType[], source: DelaySource) => {
    for (const type of types) byType.set(type, source);
  };
  const path = [...config.base, 'minimumReleaseAge'].join('.');
  if (config.top !== undefined) set(updateTypes, { value: config.top.value, origin: `${path}: ${JSON.stringify(config.top.value)} in ${config.file}`, line: config.top.line });

  // The rules of presets come before the repository's rules (extra.packageRulesOrder).
  for (const key of ['minimumReleaseAgePresets', 'pypiPresets']) {
    const fact = bot.extra?.[key] === undefined ? undefined : extraOf(bot, key, isPresetFact);
    const preset = fact === undefined ? undefined : config.extends.presets.find((item) => fact.presets.includes(presetName(item)));
    if (fact === undefined || preset === undefined || datasources[ecosystem] !== fact.datasource) continue;
    set(updateTypes, { value: fact.value, origin: `the preset ${preset} in ${config.file} (${fact.value})`, line: config.extends.line });
  }
  let repositorySets = config.top !== undefined;
  for (const { index, line, rule } of config.rules) {
    if (!('minimumReleaseAge' in rule)) continue;
    const scope = ruleScope(bot, rule, ecosystem);
    if (scope === undefined) continue;
    repositorySets = true;
    set(scope.updateTypes, { value: rule['minimumReleaseAge'], origin: `minimumReleaseAge: ${JSON.stringify(rule['minimumReleaseAge'])} in packageRules[${index}] of ${config.file}`, line, rule: index });
  }
  const unreadable = config.extends.presets.find((preset) => !internal.prefixes.some((prefix) => preset.startsWith(prefix)));
  const fromKnownPreset = config.extends.presets.some((preset) => internal.settingDelay.includes(presetName(preset)));
  if (unreadable !== undefined && !repositorySets && !(fromKnownPreset && byType.size > 0)) return { known: false, preset: unreadable, line: config.extends.line };
  return { known: true, byType };
}
