// Renovate configuration as doctor reads it: the delay Renovate applies to the packages of one package manager, which
// one Renovate manager updates from one datasource, or to the actions the workflows run (decisions D-130 and D-131),
// from the top-level minimumReleaseAge, the presets in extends and the packageRules that cover all of them
// (extra.packageRuleMatching, extra.managerMatching, extra.packageRulesOrder). For the actions, a rule for every
// workflow file (matchFileNames) or for the depType of the actions (matchDepTypes, extra.actionsMatching) covers them
// too (decision D-135). A rule that narrows the packages by anything else (names, files, dependency types...) is an
// exception for some packages and does not count; neither does a rule with a matcher depcurfew cannot read, which is
// listed so that doctor can say so.
import { extraOf, isRecord } from '../apply/facts.ts';
import { matchSegment, wildcardMatch } from '../detect/wildcard.ts';
import type { Ecosystem, ToolKnowledge } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
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

/** A packageRules entry that sets minimumReleaseAge with a matcher depcurfew cannot read (decision D-131). */
export interface UnreadableRule {
  index: number;
  line: number;
  matcher: string;
  /** The matcher's value as written. */
  patterns: unknown;
  /** Its minimumReleaseAge. */
  value: unknown;
}

export type RenovateDelay =
  | { known: true; byType: Map<UpdateType, DelaySource>; unreadable: UnreadableRule[] }
  /** A preset depcurfew cannot read may set the delay, and the repository itself sets none. */
  | { known: false; preset: string; line: number };

/**
 * What a delay is computed for: the packages of a package manager, which Renovate updates with one manager from one
 * datasource (decision D-131), or the actions the workflows run (decision D-130).
 */
export interface RenovateTarget {
  /** The datasource of the packages: npm, pypi, github-tags. */
  datasource?: string;
  /** The Renovate manager; absent when depcurfew does not know it, so a rule with matchManagers does not count. */
  manager?: string;
  /** The categories of that manager. */
  categories: readonly string[];
  /** The actions the workflows run, which the github-actions manager updates. */
  actions?: true;
  /** actions: the workflow files of the repository, from its root (the packageFile matchFileNames sees, D-135). */
  files?: readonly string[];
  /** actions: the depType Renovate gives them (extra.actionsMatching). */
  depTypes?: readonly string[];
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isNames = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
const isLists = (value: unknown): value is Record<string, string[]> => isRecord(value) && Object.values(value).every(isStrings);
const isManagerMatching = (value: unknown): value is { managerMatcher: string; categoryMatcher: string; stringIsList: boolean } =>
  isRecord(value) && typeof value['managerMatcher'] === 'string' && typeof value['categoryMatcher'] === 'string' && typeof value['stringIsList'] === 'boolean';
const isActions = (value: unknown): value is { manager: string; datasource: string } => isRecord(value) && typeof value['manager'] === 'string' && typeof value['datasource'] === 'string';
const isActionsMatching = (value: unknown): value is { fileMatcher: string; fileStringIsList: boolean; depTypeMatcher: string; depTypeStringIsList: boolean; depType: string } =>
  isRecord(value) && typeof value['fileMatcher'] === 'string' && typeof value['depTypeMatcher'] === 'string' && typeof value['depType'] === 'string';
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

/**
 * Whether a path matches a glob as minimatch reads it with { dot: true, nocase: true } (decision D-135): * within one
 * directory, ** for any number of them, letters in any case. undefined for anything else minimatch reads (?, classes,
 * braces, extglobs, escapes) and for empty, . and .. parts, which depcurfew does not evaluate.
 */
function matchesPath(path: string, glob: string): boolean | undefined {
  const parts = glob.toLowerCase().split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[?[\]{}()!+@\\]/u.test(part))) return undefined;
  const pattern = parts.filter((part, index) => part !== '**' || parts[index - 1] !== '**');
  const segments = path.toLowerCase().split('/');
  // row[j]: the path from segment `at` on matches the pattern from part j; below: the same from segment at + 1.
  let row = new Uint8Array(pattern.length + 1);
  let below = new Uint8Array(pattern.length + 1);
  for (let at = segments.length; at >= 0; at--) {
    row.fill(0);
    row[pattern.length] = at === segments.length ? 1 : 0;
    const inside = at < segments.length;
    for (let index = pattern.length - 1; index >= 0; index--) {
      const part = pattern[index] ?? '';
      if (part === '**') row[index] = row[index + 1] === 1 || (inside && below[index] === 1) ? 1 : 0;
      else row[index] = inside && below[index + 1] === 1 && matchSegment(segments[at] ?? '', part.replaceAll(/\*+/gu, '*')) ? 1 : 0;
    }
    [row, below] = [below, row];
  }
  return below[0] === 1;
}

/** One pattern of matchFileNames: "*", a /regex/ (with ! for "not") or a glob of paths (matchesPath). */
function matchesFilePattern(input: string, pattern: string, negation: string): boolean | undefined {
  const negative = pattern.startsWith(negation);
  const body = negative ? pattern.slice(negation.length) : pattern;
  if (!negative && body === '*') return true;
  if (/^\/(.+)\/(i?)$/u.test(body)) return matchesPattern(input, pattern, negation);
  const result = matchesPath(input, body);
  return result === undefined ? undefined : negative ? !result : result;
}

/** matchRegexOrGlobList: some positive pattern matches (when there are any) and every negative pattern does too. */
function matchesList(input: string, patterns: readonly string[], negation: string, matches = matchesPattern): boolean | undefined {
  if (patterns.length === 0) return false;
  const positive = patterns.filter((pattern) => !pattern.startsWith(negation));
  const negative = patterns.filter((pattern) => pattern.startsWith(negation));
  const results = positive.map((pattern) => matches(input, pattern, negation));
  if (positive.length > 0 && !results.includes(true)) return results.includes(undefined) ? undefined : false;
  const excluded = negative.map((pattern) => matches(input, pattern, negation));
  if (excluded.includes(false)) return false;
  return excluded.includes(undefined) ? undefined : true;
}

/** Patterns that match every package name: *, **, @*\/*, npm:*, and regexes like /.*\/. */
export function matchesEveryName(pattern: string): boolean {
  const name = pattern.replace(/^(npm|jsr):/u, '');
  return /^(@\*+\/)?\*+$/u.test(name) || /^\/\^?\.[*+]\$?\/[a-z]*$/u.test(name);
}


export interface RuleScope {
  /** The delayed update types the rule applies to for every package of the target. */
  updateTypes: UpdateType[];
  /** How the rule covers the packages, for messages. */
  names: { kind: 'all' } | { kind: 'pattern'; pattern: string } | { kind: 'except'; patterns: string[] };
  /** The matchers the rule has (none: it applies to everything). */
  matchers: string[];
  /** With matchCategories: the categories of the target it matches, for messages. */
  categories?: string[];
}

/**
 * Whether a rule applies to every package of the target: `covers` with the update types, `narrow` when it does not
 * (or only to some packages), `unknown` when a matcher has patterns depcurfew cannot read (decision D-131).
 */
export type RuleCoverage = { kind: 'covers'; scope: RuleScope } | { kind: 'narrow' } | { kind: 'unknown'; matcher: string };

function categoriesOf(bot: ToolKnowledge, manager: string | undefined): string[] {
  if (manager === undefined || bot.extra?.['managerCategories'] === undefined) return [];
  return extraOf(bot, 'managerCategories', isLists)[manager] ?? [];
}

/** The packages a package manager installs: its datasource, Renovate manager and categories (extra.managers). */
export function managerTarget(bot: ToolKnowledge, tool: string, ecosystem: Ecosystem): RenovateTarget {
  const datasource = extraOf(bot, 'datasources', isRecord)[ecosystem];
  const manager = bot.extra?.['managers'] === undefined ? undefined : extraOf(bot, 'managers', isNames)[tool];
  return { ...(typeof datasource === 'string' ? { datasource } : {}), ...(manager === undefined ? {} : { manager }), categories: categoriesOf(bot, manager) };
}

/**
 * The actions the workflows run (extra.githubActions), when the knowledge base has them; `files` are the workflow
 * files of the repository, which a matchFileNames rule must match all of to cover the actions (decision D-135).
 */
export function actionsTarget(bot: ToolKnowledge, files: readonly string[] = []): RenovateTarget | undefined {
  if (bot.extra?.['githubActions'] === undefined) return undefined;
  const fact = extraOf(bot, 'githubActions', isActions);
  const matching = bot.extra['actionsMatching'] === undefined ? undefined : extraOf(bot, 'actionsMatching', isActionsMatching);
  return {
    datasource: fact.datasource,
    manager: fact.manager,
    categories: categoriesOf(bot, fact.manager),
    actions: true,
    files,
    ...(matching === undefined ? {} : { depTypes: [matching.depType] }),
  };
}

/** The targets of the package managers among `tools`, one for each datasource and manager, with the tools of each. */
export function managerTargets(bot: ToolKnowledge, tools: readonly ToolKnowledge[]): { target: RenovateTarget; tools: ToolKnowledge[] }[] {
  const groups = new Map<string, { target: RenovateTarget; tools: ToolKnowledge[] }>();
  for (const tool of tools) {
    if (tool.kind !== 'package-manager') continue;
    const target = managerTarget(bot, tool.id, ecosystemOfTool(tool));
    // A tool without a known manager is a target of its own.
    const key = `${target.datasource ?? ''}\u0000${target.manager ?? `\u0000${tool.id}`}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { target, tools: [tool] });
    else group.tools.push(tool);
  }
  return [...groups.values()];
}

function targetOf(bot: ToolKnowledge, on: RenovateTarget | Ecosystem): RenovateTarget {
  if (typeof on !== 'string') return on;
  const datasource = extraOf(bot, 'datasources', isRecord)[on];
  return { ...(typeof datasource === 'string' ? { datasource } : {}), categories: [] };
}

/** The patterns of a matcher: a list, or one string when Renovate reads a string as a list of one (extra.managerMatching). */
function patternsOf(value: unknown, stringIsList: boolean): string[] | undefined {
  if (isStrings(value)) return value;
  return stringIsList && typeof value === 'string' ? [value] : undefined;
}

/** anyMatchRegexOrGlobList: some input matches the list. */
function matchesAny(inputs: readonly string[], patterns: readonly string[], negation: string): boolean | undefined {
  const results = inputs.map((input) => matchesList(input, patterns, negation));
  if (results.includes(true)) return true;
  return results.includes(undefined) ? undefined : false;
}

/**
 * How a rule covers the packages of `on` (a target, or the packages of a registry without a known manager): all of
 * them for some update types, some of them only, or depcurfew cannot tell.
 */
export function ruleCoverage(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): RuleCoverage {
  const target = targetOf(bot, on);
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const managerMatching = bot.extra?.['managerMatching'] === undefined ? undefined : extraOf(bot, 'managerMatching', isManagerMatching);
  const stringIsList = managerMatching?.stringIsList === true;
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', isStrings);
  // For the actions, matchFileNames and matchDepTypes can cover all of them (extra.actionsMatching, decision D-135).
  const actionsMatching = target.actions === true && bot.extra?.['actionsMatching'] !== undefined ? extraOf(bot, 'actionsMatching', isActionsMatching) : undefined;
  const matchers = Object.keys(rule).filter((key) => /^(match|exclude)[A-Z]/u.test(key));
  const known = new Set([
    ...matching.packageMatchers,
    matching.datasourceMatcher,
    matching.updateTypeMatcher,
    ...(managerMatching === undefined ? [] : [managerMatching.managerMatcher, managerMatching.categoryMatcher]),
    ...(actionsMatching === undefined ? [] : [actionsMatching.fileMatcher, actionsMatching.depTypeMatcher]),
  ]);
  if (matchers.some((key) => !known.has(key))) return { kind: 'narrow' };
  // Every matcher must match: one that does not makes the rule narrow, even when another cannot be read.
  let unknown: string | undefined;
  const result = (key: string, matches: boolean | undefined): boolean => {
    if (matches === undefined) unknown ??= key;
    return matches !== false;
  };
  let names: RuleScope['names'] = { kind: 'all' };
  for (const key of matching.packageMatchers) {
    if (!(key in rule)) continue;
    const patterns = patternsOf(rule[key], stringIsList);
    if (patterns === undefined) {
      result(key, undefined);
      continue;
    }
    const positive = patterns.filter((pattern) => !pattern.startsWith(matching.negation));
    const broad = positive.find(matchesEveryName);
    if (patterns.length === 0 || (positive.length > 0 && broad === undefined)) return { kind: 'narrow' };
    if (broad !== undefined && names.kind === 'all') names = { kind: 'pattern', pattern: broad };
    else if (positive.length === 0) names = { kind: 'except', patterns: [...(names.kind === 'except' ? names.patterns : []), ...patterns] };
  }
  const lists: [string, readonly string[] | undefined, 'one' | 'any'][] = [[matching.datasourceMatcher, target.datasource === undefined ? undefined : [target.datasource], 'one']];
  if (managerMatching !== undefined) {
    lists.push([managerMatching.managerMatcher, target.manager === undefined ? undefined : [target.manager], 'one']);
    lists.push([managerMatching.categoryMatcher, target.categories.length === 0 ? undefined : target.categories, 'any']);
  }
  for (const [key, inputs] of lists) {
    if (!(key in rule)) continue;
    const patterns = patternsOf(rule[key], stringIsList);
    const matches = patterns === undefined || inputs === undefined ? undefined : matchesAny(inputs, patterns, matching.negation);
    if (!result(key, matches)) return { kind: 'narrow' };
  }
  if (actionsMatching !== undefined) {
    // matchFileNames covers the actions when it matches every workflow file; matchDepTypes when it matches their depType.
    if (actionsMatching.fileMatcher in rule) {
      const patterns = patternsOf(rule[actionsMatching.fileMatcher], actionsMatching.fileStringIsList);
      const files = target.files ?? [];
      const each = patterns === undefined ? [undefined] : files.map((file) => matchesList(file, patterns, matching.negation, matchesFilePattern));
      const matches = files.length === 0 || each.includes(false) ? false : each.includes(undefined) ? undefined : true;
      if (!result(actionsMatching.fileMatcher, matches)) return { kind: 'narrow' };
    }
    if (actionsMatching.depTypeMatcher in rule) {
      const patterns = patternsOf(rule[actionsMatching.depTypeMatcher], actionsMatching.depTypeStringIsList);
      const matches = patterns === undefined || target.depTypes === undefined ? undefined : matchesAny(target.depTypes, patterns, matching.negation);
      if (!result(actionsMatching.depTypeMatcher, matches)) return { kind: 'narrow' };
    }
  }
  let types = updateTypes;
  if (matching.updateTypeMatcher in rule) {
    const patterns = patternsOf(rule[matching.updateTypeMatcher], stringIsList);
    const matched = patterns === undefined ? [] : updateTypes.map((type) => matchesList(type, patterns, matching.negation));
    types = updateTypes.filter((_, index) => matched[index] === true);
    if (types.length === 0 && !result(matching.updateTypeMatcher, patterns === undefined || matched.includes(undefined) ? undefined : false)) return { kind: 'narrow' };
  }
  if (unknown !== undefined) return { kind: 'unknown', matcher: unknown };
  if (types.length === 0) return { kind: 'narrow' };
  const categoryPatterns = managerMatching === undefined ? undefined : patternsOf(rule[managerMatching.categoryMatcher], stringIsList);
  const categories = categoryPatterns === undefined ? undefined : target.categories.filter((category) => matchesList(category, categoryPatterns, matching.negation) === true);
  return { kind: 'covers', scope: { updateTypes: types, names, matchers, ...(categories === undefined ? {} : { categories }) } };
}

/**
 * The update types for which a rule applies to every package of the target (or of a registry), or undefined when it
 * narrows the packages or depcurfew cannot tell.
 */
export function ruleScope(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): RuleScope | undefined {
  const coverage = ruleCoverage(bot, rule, on);
  return coverage.kind === 'covers' ? coverage.scope : undefined;
}

function presetName(preset: string): string {
  return preset.replace(/\(.*\)$/u, '');
}

/**
 * The delay Renovate applies to every package of the target (or of a registry), for each delayed update type. Without
 * a top-level value or a rule, an update type has no entry: Renovate does not wait.
 */
export function renovateDelay(bot: ToolKnowledge, config: RenovateConfig, on: RenovateTarget | Ecosystem): RenovateDelay {
  const target = targetOf(bot, on);
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', isStrings);
  const internal = extraOf(bot, 'internalPresets', isInternal);
  const byType = new Map<UpdateType, DelaySource>();
  const unreadable: UnreadableRule[] = [];
  const set = (types: readonly UpdateType[], source: DelaySource) => {
    for (const type of types) byType.set(type, source);
  };
  const path = [...config.base, 'minimumReleaseAge'].join('.');
  if (config.top !== undefined) set(updateTypes, { value: config.top.value, origin: `${path}: ${JSON.stringify(config.top.value)} in ${config.file}`, line: config.top.line });

  // The rules of presets come before the repository's rules (extra.packageRulesOrder).
  for (const key of ['minimumReleaseAgePresets', 'pypiPresets']) {
    const fact = bot.extra?.[key] === undefined ? undefined : extraOf(bot, key, isPresetFact);
    const preset = fact === undefined ? undefined : config.extends.presets.find((item) => fact.presets.includes(presetName(item)));
    if (fact === undefined || preset === undefined || target.datasource !== fact.datasource) continue;
    set(updateTypes, { value: fact.value, origin: `the preset ${preset} in ${config.file} (${fact.value})`, line: config.extends.line });
  }
  let repositorySets = config.top !== undefined;
  for (const { index, line, rule } of config.rules) {
    if (!('minimumReleaseAge' in rule)) continue;
    const coverage = ruleCoverage(bot, rule, target);
    if (coverage.kind === 'unknown') unreadable.push({ index, line, matcher: coverage.matcher, patterns: rule[coverage.matcher], value: rule['minimumReleaseAge'] });
    if (coverage.kind !== 'covers') continue;
    repositorySets = true;
    set(coverage.scope.updateTypes, { value: rule['minimumReleaseAge'], origin: `minimumReleaseAge: ${JSON.stringify(rule['minimumReleaseAge'])} in packageRules[${index}] of ${config.file}`, line, rule: index });
  }
  const unreadablePreset = config.extends.presets.find((preset) => !internal.prefixes.some((prefix) => preset.startsWith(prefix)));
  const fromKnownPreset = config.extends.presets.some((preset) => internal.settingDelay.includes(presetName(preset)));
  if (unreadablePreset !== undefined && !repositorySets && !(fromKnownPreset && byType.size > 0)) return { known: false, preset: unreadablePreset, line: config.extends.line };
  return { known: true, byType, unreadable };
}
