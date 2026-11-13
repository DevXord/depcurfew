// Renovate configuration as doctor reads it: the delay Renovate applies to the packages of one package manager, which
// one Renovate manager updates from one datasource, to the actions the workflows run (decisions D-130 and D-131) or to
// the dependencies of an ecosystem updated by bots only (decision D-151), from the top-level minimumReleaseAge, the
// presets in extends and the packageRules that cover all of them (extra.packageRuleMatching, extra.managerMatching,
// extra.packageRulesOrder). For the actions, a rule for every
// workflow file (matchFileNames) or for the depType of the actions (matchDepTypes, extra.actionsMatching) covers them
// too (decision D-135). A rule that narrows the packages by anything else (names, files, dependency types...) is an
// exception for some packages and does not count; neither does a rule with a matcher depcurfew cannot read, which is
// listed so that doctor can say so.
import { extraOf, isRecord } from '../apply/facts.ts';
import { matchSegment, wildcardMatch } from '../detect/wildcard.ts';
import type { BotOnlyEcosystemId, Ecosystem, ToolKnowledge } from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { delayMinutes } from './durations.ts';
import { latestVersion } from './effective.ts';
import { MAX_WAYS, MAX_WAYS_UNBOUNDED, RegexBudget } from './renovate-regex.ts';
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
  /** The built-in preset of extends that set it, with the datasource its rule matches (decision D-171). */
  preset?: { name: string; datasource: string };
  /** The rule sets it only when a /regex/ depcurfew does not run matches, which depcurfew counts as matching (decision D-200). */
  regex?: RefusedRegex;
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
  /** A matcher depcurfew does not model at all (matchBaseBranches, matchJsonata...), not only patterns it cannot read. */
  unmodelled?: true;
  /** A /regex/ of the matcher that depcurfew does not run, and why (decision D-200). */
  regex?: RefusedRegex;
}

/** A /regex/ pattern of a matcher that depcurfew does not run, so that a crafted pattern cannot stall it (decision D-200). */
export interface RefusedRegex {
  pattern: string;
  /** The matcher it is in. */
  matcher: string;
  /** What it has, after "has": "a quantified group", "a backreference"... */
  reason: string;
  /** It came after the work depcurfew spends on the /regex/ patterns of one file (RegexBudget). */
  budget?: true;
}

/** Why depcurfew does not run the pattern, for a fix: `depcurfew does not run "/…/" in matchFileNames: it has …`. */
export function refusedRegexAdvice(regex: RefusedRegex): string {
  const why =
    regex.budget === true
      ? 'it stops running the /regex/ patterns of a Renovate file after a fixed amount of work, so that a crafted file cannot stall it, and this pattern came after that'
      : `it has ${regex.reason}, and depcurfew runs a /regex/ only without quantified groups, backreferences and lookaround, with at most one *, + or {n,}, and with at most ${MAX_WAYS} ways to match through ?, {n,m} and | (${MAX_WAYS_UNBOUNDED} next to a *, + or {n,}), so that a crafted pattern cannot stall it`;
  return `depcurfew does not run ${JSON.stringify(regex.pattern)} in ${regex.matcher}: ${why}`;
}

/** For a message: the refused /regex/ a finding counts as matching (decision D-200). */
export function countedRegex(regex: RefusedRegex): string {
  return `counting ${regex.matcher} ${JSON.stringify(regex.pattern)} as matching, which depcurfew does not run`;
}

/** For a fix: what to do about a refused /regex/ counted as matching. */
export function countedRegexFix(regex: RefusedRegex): string {
  return `${refusedRegexAdvice(regex)}; it counts the pattern as matching, so rewrite it with names, globs or a /regex/ that depcurfew runs if the rule should not apply here`;
}

/**
 * How one evaluation runs the /regex/ patterns of a rule: the budget of its file, whether a pattern depcurfew does
 * not run counts as matching (`assume`, the direction that reports a rule that shortens the delay) or as one it cannot
 * read, and the first such pattern of each matcher, with the matchers whose result it could not tell.
 */
interface Run {
  budget: RegexBudget;
  assume: boolean;
  matcher: string;
  refused: Map<string, RefusedRegex>;
  unknown: string[];
}

/** The budget of the file each rule was read from (readRenovateConfig); a rule of no file gets one for each evaluation. */
const budgets = new WeakMap<object, RegexBudget>();

function newRun(budget: RegexBudget, assume: boolean): Run {
  return { budget, assume, matcher: '', refused: new Map(), unknown: [] };
}

/** The first refused /regex/ of a matcher whose result the run could not tell. */
function decisive(run: Run): RefusedRegex | undefined {
  for (const matcher of run.unknown) {
    const regex = run.refused.get(matcher);
    if (regex !== undefined) return regex;
  }
  return undefined;
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
  /** The dependencies of an ecosystem updated by bots only, which one Renovate manager updates (decision D-151). */
  ecosystem?: BotOnlyEcosystemId;
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
/** A built-in preset that sets minimumReleaseAge for one datasource (extra.minimumReleaseAgePresets, pypiPresets, cratePresets). */
export interface PresetDelay {
  presets: string[];
  value: string;
  datasource: string;
}

const isPresetFact = (value: unknown): value is PresetDelay =>
  isRecord(value) && isStrings(value['presets']) && typeof value['value'] === 'string' && typeof value['datasource'] === 'string';

/** The built-in presets that set minimumReleaseAge, each in a packageRules entry with matchDatasources for its datasource. */
export function presetDelays(bot: ToolKnowledge): PresetDelay[] {
  return ['minimumReleaseAgePresets', 'pypiPresets', 'cratePresets'].flatMap((key) => (bot.extra?.[key] === undefined ? [] : [extraOf(bot, key, isPresetFact)]));
}

/** The preset of `extends` that `fact` is about, as written there (with its arguments), if the list has one. */
export function presetIn(presets: readonly string[], fact: PresetDelay): string | undefined {
  return presets.find((item) => fact.presets.includes(presetName(item)));
}
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
  // One budget for the /regex/ patterns of the file (decision D-200).
  const budget = new RegexBudget();
  for (const { rule } of rules) budgets.set(rule, budget);
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
function matchesPattern(input: string, pattern: string, negation: string, run: Run): boolean | undefined {
  const negative = pattern.startsWith(negation);
  const body = negative ? pattern.slice(negation.length) : pattern;
  if (!negative && body === '*') return true;
  const regex = /^\/(.+)\/(i?)$/u.exec(body);
  if (regex !== null) {
    const outcome = run.budget.test(regex[1] ?? '', regex[2] === 'i' ? 'iu' : 'u', input);
    if ('invalid' in outcome) return undefined;
    if ('refused' in outcome) {
      // A shape that can backtrack for minutes, or one past the budget of the file, is not run (decision D-200).
      if (!run.refused.has(run.matcher)) run.refused.set(run.matcher, { pattern, matcher: run.matcher, reason: outcome.refused, ...(outcome.budget === true ? { budget: true as const } : {}) });
      return run.assume ? true : undefined;
    }
    return negative ? !outcome.result : outcome.result;
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
function matchesFilePattern(input: string, pattern: string, negation: string, run: Run): boolean | undefined {
  const negative = pattern.startsWith(negation);
  const body = negative ? pattern.slice(negation.length) : pattern;
  if (!negative && body === '*') return true;
  if (/^\/(.+)\/(i?)$/u.test(body)) return matchesPattern(input, pattern, negation, run);
  const result = matchesPath(input, body);
  return result === undefined ? undefined : negative ? !result : result;
}

/** matchRegexOrGlobList: some positive pattern matches (when there are any) and every negative pattern does too. */
function matchesList(input: string, patterns: readonly string[], negation: string, run: Run, matches = matchesPattern): boolean | undefined {
  if (patterns.length === 0) return false;
  const positive = patterns.filter((pattern) => !pattern.startsWith(negation));
  const negative = patterns.filter((pattern) => pattern.startsWith(negation));
  const results = positive.map((pattern) => matches(input, pattern, negation, run));
  if (positive.length > 0 && !results.includes(true)) return results.includes(undefined) ? undefined : false;
  const excluded = negative.map((pattern) => matches(input, pattern, negation, run));
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
export type RuleCoverage =
  | { kind: 'covers'; scope: RuleScope; assumed?: AssumedScope }
  | { kind: 'narrow'; assumed?: undefined }
  | { kind: 'unknown'; matcher: string; unmodelled?: true; regex?: RefusedRegex; assumed?: AssumedScope };

/**
 * What a rule covers when the /regex/ patterns depcurfew does not run count as matching, where that covers more than
 * the patterns it runs tell (decision D-200): the direction that reports a rule that shortens or turns off the delay.
 * `regex` is the pattern that made the difference.
 */
export type AssumedScope = RuleScope & { regex: RefusedRegex };

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

const isBotOnly = (value: unknown): value is Record<string, { manager: string; datasource: string; categories: string[] }> =>
  isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && typeof entry['manager'] === 'string' && typeof entry['datasource'] === 'string' && isStrings(entry['categories']));

/**
 * The dependencies of the ecosystems updated by bots only among `ids` (extra.botOnlyEcosystems, decision D-151), one
 * target each, with the manager, datasource and categories Renovate gives them; none without the fact.
 */
export function botEcosystemTargets(bot: ToolKnowledge, ids: readonly BotOnlyEcosystemId[]): RenovateTarget[] {
  if (bot.extra?.['botOnlyEcosystems'] === undefined) return [];
  const fact = extraOf(bot, 'botOnlyEcosystems', isBotOnly);
  return [...new Set(ids)].flatMap((id) => {
    const entry = fact[id];
    return entry === undefined ? [] : [{ datasource: entry.datasource, manager: entry.manager, categories: [...entry.categories], ecosystem: id }];
  });
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
function matchesAny(inputs: readonly string[], patterns: readonly string[], negation: string, run: Run): boolean | undefined {
  const results = inputs.map((input) => matchesList(input, patterns, negation, run));
  if (results.includes(true)) return true;
  return results.includes(undefined) ? undefined : false;
}

/**
 * How a rule covers the packages of `on` (a target, or the packages of a registry without a known manager): all of
 * them for some update types, some of them only, or depcurfew cannot tell.
 */
export function ruleCoverage(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): RuleCoverage {
  const budget = budgets.get(rule) ?? new RegexBudget();
  const strictRun = newRun(budget, false);
  const strict = coverageOf(bot, rule, on, strictRun);
  if (strictRun.refused.size === 0 || (strict.kind === 'unknown' && strict.unmodelled === true)) return strict;
  // A /regex/ depcurfew does not run: what the rule covers when it counts as matching (decision D-200). Counting a
  // pattern as matching only widens what a rule covers, so a rule narrow then is narrow whatever the pattern matches.
  const assumed = coverageOf(bot, rule, on, newRun(budget, true));
  if (assumed.kind === 'narrow') return strict.kind === 'covers' ? strict : assumed;
  if (assumed.kind === 'unknown') return strict.kind === 'unknown' ? { kind: 'unknown', matcher: strict.matcher } : strict;
  if (strict.kind === 'covers' && assumed.scope.updateTypes.length === strict.scope.updateTypes.length) return strict;
  const regex = decisive(strictRun) ?? [...strictRun.refused.values()][0];
  if (regex === undefined) return strict;
  const scope = { ...assumed.scope, regex };
  return strict.kind === 'unknown' ? { kind: 'unknown', matcher: strict.matcher, regex, assumed: scope } : strict.kind === 'covers' ? { ...strict, assumed: scope } : strict;
}

function coverageOf(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem, run: Run): RuleCoverage {
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
  // Every matcher must match: one that does not makes the rule narrow, even when another cannot be read. A matcher
  // depcurfew does not model (matchBaseBranches, matchJsonata, matchRepositories, matchCurrentAge...) may match every
  // package, so a rule that has one and that no other matcher narrows is one depcurfew cannot read (decision D-141).
  const unmodelled = matchers.find((key) => !known.has(key));
  let unknown: string | undefined = unmodelled;
  const result = (key: string, matches: boolean | undefined): boolean => {
    if (matches === undefined) {
      unknown ??= key;
      run.unknown.push(key);
    }
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
    run.matcher = key;
    const patterns = patternsOf(rule[key], stringIsList);
    const matches = patterns === undefined || inputs === undefined ? undefined : matchesAny(inputs, patterns, matching.negation, run);
    if (!result(key, matches)) return { kind: 'narrow' };
  }
  if (actionsMatching !== undefined) {
    // matchFileNames covers the actions when it matches every workflow file; matchDepTypes when it matches their depType.
    if (actionsMatching.fileMatcher in rule) {
      run.matcher = actionsMatching.fileMatcher;
      const patterns = patternsOf(rule[actionsMatching.fileMatcher], actionsMatching.fileStringIsList);
      const files = target.files ?? [];
      const each = patterns === undefined ? [undefined] : files.map((file) => matchesList(file, patterns, matching.negation, run, matchesFilePattern));
      const matches = files.length === 0 || each.includes(false) ? false : each.includes(undefined) ? undefined : true;
      if (!result(actionsMatching.fileMatcher, matches)) return { kind: 'narrow' };
    }
    if (actionsMatching.depTypeMatcher in rule) {
      run.matcher = actionsMatching.depTypeMatcher;
      const patterns = patternsOf(rule[actionsMatching.depTypeMatcher], actionsMatching.depTypeStringIsList);
      const matches = patterns === undefined || target.depTypes === undefined ? undefined : matchesAny(target.depTypes, patterns, matching.negation, run);
      if (!result(actionsMatching.depTypeMatcher, matches)) return { kind: 'narrow' };
    }
  }
  let types = updateTypes;
  if (matching.updateTypeMatcher in rule) {
    run.matcher = matching.updateTypeMatcher;
    const patterns = patternsOf(rule[matching.updateTypeMatcher], stringIsList);
    const matched = patterns === undefined ? [] : updateTypes.map((type) => matchesList(type, patterns, matching.negation, run));
    types = updateTypes.filter((_, index) => matched[index] === true);
    if (matched.includes(undefined)) run.unknown.push(matching.updateTypeMatcher);
    if (types.length === 0 && !result(matching.updateTypeMatcher, patterns === undefined || matched.includes(undefined) ? undefined : false)) return { kind: 'narrow' };
  }
  if (unknown !== undefined) return { kind: 'unknown', matcher: unknown, ...(unknown === unmodelled ? { unmodelled: true as const } : {}) };
  if (types.length === 0) return { kind: 'narrow' };
  const categoryPatterns = managerMatching === undefined ? undefined : patternsOf(rule[managerMatching.categoryMatcher], stringIsList);
  run.matcher = managerMatching?.categoryMatcher ?? '';
  const categories = categoryPatterns === undefined ? undefined : target.categories.filter((category) => matchesList(category, categoryPatterns, matching.negation, run) === true);
  return { kind: 'covers', scope: { updateTypes: types, names, matchers, ...(categories === undefined ? {} : { categories }) } };
}

/**
 * Whether a rule can apply to packages of the target at all, by its datasource, manager and category matchers only:
 * true when each of them matches (or the rule has none), false when one does not, undefined when depcurfew cannot read
 * one. Matchers of names, update types and the rest only narrow the packages further (decision D-171).
 */
export function ruleReaches(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): boolean | undefined {
  return reachOf(bot, rule, on, newRun(budgets.get(rule) ?? new RegexBudget(), false));
}

/**
 * ruleReaches with the /regex/ patterns depcurfew does not run counted as matching, for a rule that shortens or turns
 * off the delay (decision D-200); `regex` is the pattern that made the difference, when one did.
 */
export function ruleReachesCounting(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): { reaches: boolean | undefined; regex?: RefusedRegex } {
  const budget = budgets.get(rule) ?? new RegexBudget();
  const strictRun = newRun(budget, false);
  const strict = reachOf(bot, rule, on, strictRun);
  if (strict !== undefined || strictRun.refused.size === 0) return { reaches: strict };
  const reaches = reachOf(bot, rule, on, newRun(budget, true));
  const regex = decisive(strictRun);
  return reaches === undefined || regex === undefined ? { reaches: strict } : { reaches, regex };
}

function reachOf(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem, run: Run): boolean | undefined {
  const target = targetOf(bot, on);
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const managerMatching = bot.extra?.['managerMatching'] === undefined ? undefined : extraOf(bot, 'managerMatching', isManagerMatching);
  const stringIsList = managerMatching?.stringIsList === true;
  const lists: [string, readonly string[] | undefined][] = [[matching.datasourceMatcher, target.datasource === undefined ? undefined : [target.datasource]]];
  if (managerMatching !== undefined) {
    lists.push([managerMatching.managerMatcher, target.manager === undefined ? undefined : [target.manager]]);
    lists.push([managerMatching.categoryMatcher, target.categories.length === 0 ? undefined : target.categories]);
  }
  let reaches: boolean | undefined = true;
  for (const [key, inputs] of lists) {
    if (!(key in rule)) continue;
    run.matcher = key;
    const patterns = patternsOf(rule[key], stringIsList);
    const matches = patterns === undefined || inputs === undefined ? undefined : matchesAny(inputs, patterns, matching.negation, run);
    if (matches === false) return false;
    if (matches === undefined) {
      reaches = undefined;
      run.unknown.push(key);
    }
  }
  return reaches;
}

/** Whether a package name matches a Renovate pattern of matchPackageNames ("*", /regex/ or a glob; undefined when depcurfew cannot tell). */
export function matchesName(bot: ToolKnowledge, name: string, pattern: string): boolean | undefined {
  return matchesPattern(name, pattern, extraOf(bot, 'packageRuleMatching', isMatching).negation, newRun(new RegexBudget(), false));
}

/**
 * The delayed update types a rule applies to (all without matchUpdateTypes); undefined when depcurfew cannot read its
 * patterns. For a rule that shortens the delay, a /regex/ depcurfew does not run counts as matching (decision D-200),
 * and `regex` names it when it made the difference.
 */
export function ruleUpdateTypes(bot: ToolKnowledge, rule: Record<string, unknown>): { types: UpdateType[] | undefined; regex?: RefusedRegex } {
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', isStrings);
  if (!(matching.updateTypeMatcher in rule)) return { types: updateTypes };
  const managerMatching = bot.extra?.['managerMatching'] === undefined ? undefined : extraOf(bot, 'managerMatching', isManagerMatching);
  const patterns = patternsOf(rule[matching.updateTypeMatcher], managerMatching?.stringIsList === true);
  if (patterns === undefined) return { types: undefined };
  const budget = budgets.get(rule) ?? new RegexBudget();
  const typesOf = (run: Run) => {
    run.matcher = matching.updateTypeMatcher;
    const matched = updateTypes.map((type) => matchesList(type, patterns, matching.negation, run));
    return matched.includes(undefined) ? undefined : updateTypes.filter((_, index) => matched[index] === true);
  };
  const strictRun = newRun(budget, false);
  const strict = typesOf(strictRun);
  const regex = strictRun.refused.get(matching.updateTypeMatcher);
  if (strict !== undefined || regex === undefined) return { types: strict };
  const types = typesOf(newRun(budget, true));
  return types === undefined ? { types: strict } : { types, regex };
}

/** The patterns of the name matchers of a rule (matchPackageNames, matchDepNames); undefined when one cannot be read. */
export function namePatterns(bot: ToolKnowledge, rule: Record<string, unknown>): string[] | undefined {
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const managerMatching = bot.extra?.['managerMatching'] === undefined ? undefined : extraOf(bot, 'managerMatching', isManagerMatching);
  const patterns: string[] = [];
  for (const key of matching.packageMatchers) {
    if (!(key in rule)) continue;
    const list = patternsOf(rule[key], managerMatching?.stringIsList === true);
    if (list === undefined) return undefined;
    patterns.push(...list);
  }
  return patterns;
}

/**
 * The update types for which a rule applies to every package of the target (or of a registry), or undefined when it
 * narrows the packages or depcurfew cannot tell.
 */
export function ruleScope(bot: ToolKnowledge, rule: Record<string, unknown>, on: RenovateTarget | Ecosystem): RuleScope | undefined {
  const coverage = ruleCoverage(bot, rule, on);
  return coverage.kind === 'covers' ? coverage.scope : undefined;
}

/**
 * A preset without its arguments, as replace(/\(.*\)$/u, '') leaves it: when it ends with ), cut at the first ( after
 * its last line terminator (. stops at those). Read with indexOf (decision D-200): the pattern took seconds on an
 * extends entry of 40,000 opening brackets.
 */
export function presetName(preset: string): string {
  if (!preset.endsWith(')')) return preset;
  const last = Math.max(preset.lastIndexOf('\n'), preset.lastIndexOf('\r'), preset.lastIndexOf('\u2028'), preset.lastIndexOf('\u2029'));
  const open = preset.indexOf('(', last + 1);
  return open === -1 || open === preset.length - 1 ? preset : preset.slice(0, open);
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
  for (const fact of presetDelays(bot)) {
    const preset = presetIn(config.extends.presets, fact);
    if (preset === undefined || target.datasource !== fact.datasource) continue;
    set(updateTypes, { value: fact.value, origin: `the preset ${preset} in ${config.file} (${fact.value})`, line: config.extends.line, preset: { name: preset, datasource: fact.datasource } });
  }
  let repositorySets = config.top !== undefined;
  const minutesOf = (value: unknown): number | undefined => {
    const minutes = delayMinutes(bot, value, latestVersion(bot));
    return minutes.ok ? minutes.minutes : undefined;
  };
  for (const { index, line, rule } of config.rules) {
    if (!('minimumReleaseAge' in rule)) continue;
    const coverage = ruleCoverage(bot, rule, target);
    const origin = `minimumReleaseAge: ${JSON.stringify(rule['minimumReleaseAge'])} in packageRules[${index}] of ${config.file}`;
    // A rule whose /regex/ depcurfew does not run counts for the update types where it shortens the delay that applies
    // before it (decision D-200): the direction that reports. Where it would make the delay longer, it does not count.
    let counted = false;
    if (coverage.assumed !== undefined) {
      const regex = coverage.assumed.regex;
      const minutes = minutesOf(rule['minimumReleaseAge']);
      const shortened = coverage.assumed.updateTypes.filter((type) => {
        if (coverage.kind === 'covers' && coverage.scope.updateTypes.includes(type)) return false;
        const before = byType.get(type);
        const current = before === undefined ? 0 : minutesOf(before.value);
        return minutes !== undefined && current !== undefined && minutes < current;
      });
      if (shortened.length > 0) {
        counted = true;
        repositorySets = true;
        set(shortened, { value: rule['minimumReleaseAge'], origin: `${origin}, ${countedRegex(regex)}`, line, rule: index, regex });
      }
    }
    if (coverage.kind === 'unknown' && !counted) {
      unreadable.push({
        index,
        line,
        matcher: coverage.matcher,
        patterns: rule[coverage.matcher],
        value: rule['minimumReleaseAge'],
        ...(coverage.unmodelled === true ? { unmodelled: true as const } : {}),
        ...(coverage.regex === undefined ? {} : { regex: coverage.regex }),
      });
    }
    if (coverage.kind !== 'covers') continue;
    repositorySets = true;
    set(coverage.scope.updateTypes, { value: rule['minimumReleaseAge'], origin, line, rule: index });
  }
  const unreadablePreset = config.extends.presets.find((preset) => !internal.prefixes.some((prefix) => preset.startsWith(prefix)));
  const fromKnownPreset = config.extends.presets.some((preset) => internal.settingDelay.includes(presetName(preset)));
  if (unreadablePreset !== undefined && !repositorySets && !(fromKnownPreset && byType.size > 0)) return { known: false, preset: unreadablePreset, line: config.extends.line };
  return { known: true, byType, unreadable };
}
