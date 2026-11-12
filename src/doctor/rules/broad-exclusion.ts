// broad-exclusion: an exception list that matches every package turns the protection off while the setting still
// looks configured. Checked in depcurfew.json, in the tools' own files and in Renovate packageRules; there also a rule
// that exempts npm, Python or Composer packages cooldown.exclude does not, and a rule depcurfew apply wrote for the
// names of one registry that is not limited to its datasource (decision D-171).
import { extraOf, isRecord, settingOf, values, yamlOptionsFor } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion } from '../../apply/version.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { matchesEveryComposerName } from '../composer.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import {
  actionsTarget,
  botEcosystemTargets,
  countedRegex,
  countedRegexFix,
  managerTargets,
  matchesEveryName,
  matchesName,
  namePatterns,
  readRenovateConfig,
  ruleCoverage,
  ruleReaches,
  ruleReachesCounting,
  ruleUpdateTypes,
  type RefusedRegex,
  type RenovateConfig,
  type RenovateTarget,
  type RuleScope,
} from '../renovate.ts';
import { COMPOSER_RULE_DESCRIPTION, PYTHON_RULE_DESCRIPTION, RULE_DESCRIPTION } from '../../apply/generators/renovate.ts';
import { botEcosystemFact } from '../../detect/bot-ecosystems.ts';
import { COMPOSER_PREFIX, PYPI_PREFIX, patternsFor } from '../../policy/package-pattern.ts';
import type { Ecosystem } from '../../knowledge/types.ts';
import { lineOf, readSetting, rejectsYamlAliases, yamlAliasLine, yamlSetting } from '../settings.ts';
import { managerSources } from '../projects.ts';
import { readToolSetting } from '../pnpm-config.ts';
import type { Rule, RuleContext } from '../types.ts';
import { usesBot, usesManager } from '../applies.ts';
import { coversActions, coversBotEcosystems } from '../../apply/targets.ts';

/** Patterns that match every package (or every scoped package): *, **, @*\/*, npm:*, and regexes like /.*\/. */
export const isBroad = matchesEveryName;

function tool(context: RuleContext, id: string): ToolKnowledge | undefined {
  return context.tools.find((entry) => entry.id === id);
}

function checkPolicy(context: RuleContext): void {
  const policy = context.policy;
  // depcurfew.json is the root's; a project listed in projects has none (decision D-100).
  if (policy === undefined || context.project !== undefined) return;
  const text = context.repository.readText(POLICY_FILE) ?? '';
  const lists: [string, readonly string[]][] = [
    ['cooldown.exclude', policy.cooldown?.exclude ?? []],
    ['installScripts.allow', policy.installScripts?.allow ?? []],
  ];
  for (const [field, patterns] of lists) {
    for (const pattern of patterns.filter(isBroad)) {
      const line = lineOf(text, JSON.stringify(pattern));
      context.report({
        location: line === undefined ? { file: POLICY_FILE } : { file: POLICY_FILE, line },
        message: `${field} contains "${pattern}", which matches every scoped package`,
        fix: `List the packages or scopes that need the exception, e.g. "@your-scope/*"`,
      });
    }
  }
}

/** The managers' own exception lists (npm, pnpm, Yarn, Deno; Bun takes no wildcards). */
function checkManagers(context: RuleContext): void {
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
    const knowledge = tool(context, manager.id);
    if (knowledge === undefined) continue;
    const setting = settingOf(knowledge.cooldown.exclude.setting);
    if (setting === null) continue;
    const files = manager.id === 'deno' ? manager.configFiles.filter((file) => /^deno\.jsonc?$/u.test(file)) : (values(knowledge.cooldown.configFiles)[0] ?? []).slice(0, 1);
    const version = pinnedVersion(manager) ?? latestVersion(knowledge);
    for (const file of files) {
      // pnpm 12.15+ may take the list from a file of include (decision D-164); found.file says which.
      const found = readToolSetting(context.repository, knowledge, version, file, setting);
      // Composer's ignore may also be an object of names to reasons, and its * matches / as well (vendor names).
      const items: unknown[] | undefined = Array.isArray(found?.value) ? found.value : isRecord(found?.value) ? Object.keys(found.value) : undefined;
      if (found === undefined || items === undefined) continue;
      const broad = (item: string) => isBroad(item) || (ecosystemOfTool(knowledge) === 'packagist' && matchesEveryComposerName(item));
      for (const pattern of items.filter((item): item is string => typeof item === 'string' && broad(item))) {
        context.report({
          location: { file: found.file, line: found.line },
          message: `${setting} contains "${pattern}", so ${knowledge.name} applies no release-age delay to any package`,
          fix: `Remove "${pattern}" and list only the packages that need the exception`,
        });
      }
    }
  }
}

function checkDependabot(context: RuleContext, file: string): void {
  const text = context.repository.readText(file);
  const bot = tool(context, 'dependabot');
  // Dependabot does not read a file with YAML aliases (extra.yamlAliases); bot-cooldown-mismatch gives a note for it.
  if (text === undefined || (bot !== undefined && rejectsYamlAliases(bot) && yamlAliasLine(text) !== undefined)) return;
  const updates = yamlSetting(text, ['updates'], yamlOptionsFor(file, context.tools));
  if (updates === undefined || !Array.isArray(updates.value)) return;
  // dependabot-core matches with File.fnmatch? without FNM_PATHNAME, so * matches / too (extra.excludeMatching): "*/*"
  // matches every Composer package (vendor/name), as matchesEveryComposerName says (decision D-141).
  const slash = bot?.extra?.['excludeMatching'] !== undefined && extraOf(bot, 'excludeMatching', isRecord)['starMatchesSlash'] === true;
  const ecosystems = bot?.extra?.['ecosystems'] === undefined ? {} : extraOf(bot, 'ecosystems', isRecord);
  const composerEcosystems = Object.keys(ecosystems).filter((name) => {
    const managers = ecosystems[name];
    return Array.isArray(managers) && managers.some((id) => tool(context, String(id)) !== undefined && ecosystemOfTool(tool(context, String(id)) as ToolKnowledge) === 'packagist');
  });
  (updates.value as unknown[]).forEach((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry['cooldown']) || !Array.isArray(entry['cooldown']['exclude'])) return;
    const composer = slash && composerEcosystems.includes(String(entry['package-ecosystem']));
    const broad = (entry['cooldown']['exclude'] as unknown[]).filter((item): item is string => typeof item === 'string' && (isBroad(item) || (composer && matchesEveryComposerName(item))));
    if (broad.length === 0) return;
    context.report({
      location: { file, line: yamlSetting(text, ['updates', String(index), 'cooldown', 'exclude'])?.line ?? updates.line },
      message: `cooldown.exclude in updates[${index}] (${String(entry['package-ecosystem'])}) contains "${broad[0] ?? ''}", so Dependabot applies no cooldown`,
      fix: `Remove "${broad[0] ?? ''}" and list only the dependencies that need the exception`,
    });
  });
}

const isScopeGate = (value: unknown): value is { scopes: string; setting: string; since: string; unset: string } =>
  isRecord(value) && typeof value['scopes'] === 'string' && typeof value['setting'] === 'string' && typeof value['since'] === 'string' && typeof value['unset'] === 'string';

/**
 * Yarn 4.17+: npmScopes.<scope>.npmMinimalAgeGate replaces the global gate for the packages of that scope (extra.perScopeGate),
 * and a scope listed without it gets Yarn's default instead of the global gate. A shorter delay than the policy's is an
 * exception the policy does not make, unless cooldown.exclude exempts the whole scope.
 */
function checkYarnScopes(context: RuleContext): void {
  const cooldown = context.policy === undefined ? undefined : policyFor(context.policy, 'npm').cooldown;
  const manager = context.detection.packageManagers.find((entry) => entry.id === 'yarn' && entry.supported);
  const yarn = tool(context, 'yarn');
  if (cooldown === undefined || manager === undefined || yarn?.extra?.['perScopeGate'] === undefined) return;
  const fact = extraOf(yarn, 'perScopeGate', isScopeGate);
  const version = pinnedVersion(manager) ?? latestVersion(yarn);
  const since = parseVersion(fact.since);
  if (version === undefined || since === undefined || compareVersions(version, since) < 0) return;
  const file = values(yarn.cooldown.configFiles)[0]?.[0] ?? '.yarnrc.yml';
  const text = context.repository.readText(file);
  const scopes = text === undefined ? undefined : yamlSetting(text, [fact.scopes]);
  if (text === undefined || scopes === undefined || !isRecord(scopes.value)) return;
  const wanted = convertCooldown(yarn, cooldown.minimum);
  const label = `Yarn ${formatVersion(version)}`;
  for (const [scope, settings] of Object.entries(scopes.value)) {
    if (settings !== null && !isRecord(settings)) continue;
    if (cooldown.exclude.some((pattern) => pattern === `@${scope}/*` || isBroad(pattern))) continue;
    const explicit = settings?.[fact.setting];
    const delay = delayMinutes(yarn, explicit ?? fact.unset, version);
    if (!delay.ok || delay.minutes >= cooldown.minimum.minutes) continue;
    const path = `${fact.scopes}.${scope}`;
    const line = (explicit === undefined ? undefined : yamlSetting(text, [fact.scopes, scope, fact.setting])?.line) ?? yamlSetting(text, [fact.scopes, scope])?.line ?? scopes.line;
    const value = wanted.ok ? String(wanted.value) : cooldown.minimum.text;
    const fix = `Set ${path}.${fact.setting}: ${value} in ${file}, or add "@${scope}/*" to cooldown.exclude in ${POLICY_FILE} if the scope needs no delay`;
    if (explicit === undefined) {
      // From Yarn's code (configuration defaults), not from a test: a warning.
      context.report({
        level: 'warning',
        location: { file, line },
        message: `${path} in ${file} sets no ${fact.setting}, so ${label} gives @${scope} packages its default of ${formatMinutes(delay.minutes)} instead of the global ${fact.setting}, shorter than ${cooldown.minimum.text} in ${POLICY_FILE}`,
        fix,
      });
      continue;
    }
    context.report({
      location: { file, line },
      message:
        delay.minutes === 0
          ? `${path}.${fact.setting} in ${file} is 0, so ${label} applies no release-age delay to @${scope} packages, which ${POLICY_FILE} does not exempt`
          : `${path}.${fact.setting} in ${file} makes ${label} wait ${formatMinutes(delay.minutes)} for @${scope} packages instead of the global ${fact.setting}, shorter than ${cooldown.minimum.text} in ${POLICY_FILE}`,
      fix,
    });
  }
}

const isPackageJsonConfig = (value: unknown): value is { file: string; key: string } =>
  isRecord(value) && typeof value['file'] === 'string' && typeof value['key'] === 'string';
const isMatching = (value: unknown): value is { negation: string; datasourceMatcher: string; updateTypeMatcher: string } =>
  isRecord(value) && typeof value['negation'] === 'string' && typeof value['datasourceMatcher'] === 'string' && typeof value['updateTypeMatcher'] === 'string';
const isManagerMatching = (value: unknown): value is { managerMatcher: string; categoryMatcher: string } =>
  isRecord(value) && typeof value['managerMatcher'] === 'string' && typeof value['categoryMatcher'] === 'string';
const isActionsMatching = (value: unknown): value is { fileMatcher: string; depTypeMatcher: string } =>
  isRecord(value) && typeof value['fileMatcher'] === 'string' && typeof value['depTypeMatcher'] === 'string';

interface Matchers {
  negation: string;
  datasourceMatcher: string;
  updateTypeMatcher: string;
  managerMatcher?: string;
  categoryMatcher?: string;
  /** For the actions: matchFileNames and matchDepTypes (extra.actionsMatching, decision D-135). */
  fileMatcher?: string;
  depTypeMatcher?: string;
}

/** What a packageRules entry covers, for the message: its update types, names, datasources, managers and categories. */
function covers(scope: RuleScope, targets: readonly RenovateTarget[], matching: Matchers): string {
  const unique = (items: readonly (string | undefined)[]) => [...new Set(items.filter((item): item is string => item !== undefined))];
  const plural = (items: readonly string[], one: string, many: string) => (items.length === 1 ? one : many);
  const has = (matcher: string | undefined) => matcher !== undefined && scope.matchers.includes(matcher);
  const types = has(matching.updateTypeMatcher) ? `${listing(scope.updateTypes)} updates of ` : '';
  const names = scope.names.kind === 'except' ? `every package except ${listing(scope.names.patterns.map((pattern) => pattern.slice(matching.negation.length)))}` : 'every package';
  const datasources = unique(targets.map((target) => target.datasource));
  const from = has(matching.datasourceMatcher) ? ` from the ${listing(datasources)} ${plural(datasources, 'datasource', 'datasources')}` : '';
  const managers = unique(targets.map((target) => target.manager));
  const of = has(matching.managerMatcher) ? ` of the Renovate ${listing(managers)} ${plural(managers, 'manager', 'managers')}` : '';
  const categories = unique(targets.flatMap((target) => target.categories).filter((category) => scope.categories?.includes(category) === true));
  const within = has(matching.categoryMatcher) ? ` in the Renovate ${listing(categories)} ${plural(categories, 'category', 'categories')}` : '';
  const files = has(matching.fileMatcher) ? ' in every workflow file' : '';
  const depTypes = unique(targets.flatMap((target) => target.depTypes ?? []));
  const typed = has(matching.depTypeMatcher) ? ` with the depType ${listing(depTypes)}` : '';
  const note = scope.names.kind === 'except' ? ' (a list of only negative patterns matches every other package)' : '';
  return `${types}${names}${from}${of}${within}${files}${typed}${note}`;
}

/**
 * packageRules entries that turn minimumReleaseAge off for every package of a package manager in use, by registry,
 * Renovate manager or category (extra.packageRuleMatching, extra.managerMatching, decision D-131), or, when the
 * policy's delay covers them, for the actions of the workflows (decision D-130) or the dependencies of an ecosystem
 * updated by bots only that the repository has (decision D-151).
 */
function checkRenovate(context: RuleContext, file: string): void {
  const bot = tool(context, 'renovate');
  if (bot === undefined || !/(\.jsonc?|\.renovaterc)$/u.test(file)) return;
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const packageJson = extraOf(bot, 'packageJsonConfig', isPackageJsonConfig);
  const config = readRenovateConfig(text, file, file === packageJson.file ? [packageJson.key] : []);
  const managerMatching = bot.extra?.['managerMatching'] === undefined ? undefined : extraOf(bot, 'managerMatching', isManagerMatching);
  const actionsMatching = bot.extra?.['actionsMatching'] === undefined ? undefined : extraOf(bot, 'actionsMatching', isActionsMatching);
  const matching: Matchers = {
    ...extraOf(bot, 'packageRuleMatching', isMatching),
    ...(managerMatching === undefined ? {} : { managerMatcher: managerMatching.managerMatcher, categoryMatcher: managerMatching.categoryMatcher }),
    ...(actionsMatching === undefined ? {} : { fileMatcher: actionsMatching.fileMatcher, depTypeMatcher: actionsMatching.depTypeMatcher }),
  };
  // The package managers in use; a rule for another one changes nothing here. Without any, every package manager
  // counts. The bots of the root serve every project listed in projects too (decision D-100).
  const detected = managerSources(context).flatMap((source) => source.managers.flatMap((entry) => tool(context, entry.id) ?? []));
  const actions = coversActions(context.policy, bot.id, context.detection) ? actionsTarget(bot, context.detection.workflows) : undefined;
  const botOnly = coversBotEcosystems(context.policy, bot.id) ? botEcosystemTargets(bot, (context.detection.botEcosystems ?? []).map((entry) => entry.id)) : [];
  const targets = [...managerTargets(bot, detected.length > 0 ? detected : context.tools).map((group) => group.target), ...botOnly, ...(actions === undefined ? [] : [actions])];
  const narrowing = [matching.datasourceMatcher, matching.updateTypeMatcher, matching.managerMatcher, matching.categoryMatcher, matching.fileMatcher, matching.depTypeMatcher];
  const reported = new Set<number>();
  for (const { index, line, rule } of config.rules) {
    if (!('minimumReleaseAge' in rule)) continue;
    const delay = delayMinutes(bot, rule['minimumReleaseAge'], latestVersion(bot));
    if (!delay.ok || delay.minutes !== 0) continue;
    // A /regex/ depcurfew does not run counts as matching here, the direction that reports (decision D-200).
    const covered = targets.flatMap((target) => {
      const coverage = ruleCoverage(bot, rule, target);
      const scope = coverage.assumed ?? (coverage.kind === 'covers' ? coverage.scope : undefined);
      return scope === undefined ? [] : [{ scope, target, regex: coverage.assumed?.regex }];
    });
    const first = covered[0];
    if (first === undefined) continue;
    const { scope } = first;
    const regex = covered.find((item) => item.regex !== undefined)?.regex;
    reported.add(index);
    const counting = regex === undefined ? '' : `, ${countedRegex(regex)}`;
    context.report({
      location: { file, line },
      message:
        scope.matchers.length === 0
          ? `packageRules[${index}] turns off minimumReleaseAge without matching any packages, so it applies to all of them`
          : scope.names.kind === 'pattern' && scope.matchers.every((key) => !narrowing.includes(key))
            ? `packageRules[${index}] turns off minimumReleaseAge for "${scope.names.pattern}", which matches every package${counting}`
            : `packageRules[${index}] turns off minimumReleaseAge for ${covers(scope, covered.map((item) => item.target), matching)}${counting}`,
      fix: `Match only the packages that need the exception, e.g. with matchPackageNames: ["@your-scope/*"]${regex === undefined ? '' : `; ${countedRegexFix(regex)}`}`,
    });
  }
  const registries = managerTargets(bot, detected.length > 0 ? detected : context.tools).flatMap(({ target, tools }) => {
    const ecosystem = tools[0] === undefined ? undefined : ecosystemOfTool(tools[0]);
    return ecosystem === undefined ? [] : [{ target, ecosystem }];
  });
  // apply edits renovate.json and renovate.jsonc, not the deprecated key of package.json or a .renovaterc (it prints a snippet).
  const edits = /\.jsonc?$/u.test(file) && file !== packageJson.file;
  ownRuleDatasources(context, bot, file, config, matching, registries, [...botOnly, ...(actions === undefined ? [] : [actions])], reported, edits);
  exemptions(context, bot, file, config, matching, registries, reported, edits);
}

const REGISTRY_LABELS: Readonly<Record<Ecosystem, string>> = { npm: 'npm', pypi: 'Python', packagist: 'Composer', rubygems: 'Ruby', crates: 'Rust' };
const POLICY_PREFIXES: Readonly<Partial<Record<Ecosystem, string>>> = { npm: '', pypi: PYPI_PREFIX, packagist: COMPOSER_PREFIX };

/** The datasource each rule depcurfew apply writes for the names of one registry is limited to (decision D-171). */
const OWN_RULES: readonly { description: string; ecosystem: Ecosystem }[] = [
  { description: RULE_DESCRIPTION, ecosystem: 'npm' },
  { description: PYTHON_RULE_DESCRIPTION, ecosystem: 'pypi' },
  { description: COMPOSER_RULE_DESCRIPTION, ecosystem: 'packagist' },
];

/** A target as messages name it: "npm packages", "Cargo dependencies", "GitHub Actions". */
function targetLabel(target: RenovateTarget, registries: readonly { target: RenovateTarget; ecosystem: Ecosystem }[]): string {
  if (target.actions === true) return 'GitHub Actions';
  if (target.ecosystem !== undefined) return `${botEcosystemFact(target.ecosystem)?.client ?? target.ecosystem} dependencies`;
  const ecosystem = registries.find((entry) => entry.target === target)?.ecosystem;
  return `${ecosystem === undefined ? (target.datasource ?? 'other') : REGISTRY_LABELS[ecosystem]} packages`;
}

/**
 * A rule depcurfew apply writes for the names of one registry (recognized by its description) that is not limited to
 * that registry's datasource, as earlier versions of depcurfew wrote the rule for npm names (with no matchDatasources, or with only
 * negative ones): it exempts packages of the same names from every other datasource too, the crates, Go modules and
 * actions of the repository among them, which cooldown.exclude never names (decisions D-065 and D-171).
 */
function ownRuleDatasources(
  context: RuleContext,
  bot: ToolKnowledge,
  file: string,
  config: RenovateConfig,
  matching: Matchers,
  registries: readonly { target: RenovateTarget; ecosystem: Ecosystem }[],
  others: readonly RenovateTarget[],
  reported: Set<number>,
  edits: boolean,
): void {
  const datasources = extraOf(bot, 'datasources', isRecord);
  const negation = matching.negation;
  for (const { index, line, rule } of config.rules) {
    const own = OWN_RULES.find((entry) => entry.description === rule['description']);
    const datasource = own === undefined ? undefined : datasources[own.ecosystem];
    if (own === undefined || typeof datasource !== 'string' || reported.has(index) || !('minimumReleaseAge' in rule)) continue;
    const written = rule[matching.datasourceMatcher];
    const limited = Array.isArray(written) && written.length > 0 && written.every((item) => typeof item === 'string' && !item.startsWith(negation) && item.toLowerCase() === datasource);
    if (limited) continue;
    const targets = [...registries.map((entry) => entry.target), ...others];
    const reached = [...new Set(targets.filter((target) => target.datasource !== datasource && ruleReaches(bot, rule, target) === true).map((target) => targetLabel(target, registries)))];
    const wanted = JSON.stringify([datasource]);
    reported.add(index);
    context.report({
      location: { file, line },
      message: `packageRules[${index}] in ${file}, the rule depcurfew apply writes for the ${REGISTRY_LABELS[own.ecosystem]} names of cooldown.exclude in ${POLICY_FILE}, is not limited to ${matching.datasourceMatcher} ${wanted}, so it also turns off minimumReleaseAge for packages of the same names from other datasources${reached.length === 0 ? '' : `, ${listing(reached)} among them`}`,
      fix: edits
        ? `Run depcurfew apply, which limits the rule to ${matching.datasourceMatcher} ${wanted}`
        : `Add ${matching.datasourceMatcher}: ${wanted} to packageRules[${index}] of ${file}, as the snippet of depcurfew apply shows it (depcurfew apply does not edit ${file})`,
    });
  }
}

/**
 * Whether a positive pattern of a rule names only packages that one of the policy's patterns exempts: the same pattern,
 * or one the policy's pattern matches as text (its * stands for any text, so it covers whatever the * of the rule's
 * pattern stands for: "@acme/*" covers "@acme/ui" and "@acme/ui-*"). A /regex/ is compared as written only.
 */
function exempted(bot: ToolKnowledge, pattern: string, policy: readonly string[]): boolean {
  const normal = (text: string) => text.toLowerCase().replaceAll('**', '*');
  if (policy.some((item) => normal(item) === normal(pattern))) return true;
  if (/^\/.*\/i?$/u.test(pattern)) return false;
  return policy.some((item) => matchesName(bot, normal(pattern), item) === true);
}

/**
 * packageRules entries that give npm, Python or Composer packages of some names a shorter delay than cooldown.minimum,
 * or none, while cooldown.exclude does not exempt them (decision D-171): an exception the policy does not make, like a
 * Yarn npmScopes entry. Only the registries the policy names packages of count: the exceptions of actions, Ruby gems
 * and the ecosystems updated by bots only stay the repository's own, as in Dependabot (decision D-152). A rule that
 * covers every package is the business of the checks above and of bot-cooldown-mismatch.
 */
function exemptions(
  context: RuleContext,
  bot: ToolKnowledge,
  file: string,
  config: RenovateConfig,
  matching: Matchers,
  registries: readonly { target: RenovateTarget; ecosystem: Ecosystem }[],
  reported: ReadonlySet<number>,
  edits: boolean,
): void {
  const cooldown = context.policy?.cooldown;
  if (cooldown === undefined) return;
  const updateTypes = extraOf(bot, 'delayedUpdateTypes', (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
  for (const { index, line, rule } of config.rules) {
    if (reported.has(index) || !('minimumReleaseAge' in rule)) continue;
    const delay = delayMinutes(bot, rule['minimumReleaseAge'], latestVersion(bot));
    if (!delay.ok || delay.minutes >= cooldown.minimum.minutes) continue;
    const patterns = namePatterns(bot, rule);
    const positive = (patterns ?? []).filter((pattern) => !pattern.startsWith(matching.negation));
    if (positive.length === 0 || positive.some(matchesEveryName)) continue;
    // The delayed update types it applies to; none (pin, lockFileMaintenance only) is no exception. A /regex/ depcurfew
    // does not run counts as matching, here and for the registries it reaches (decision D-200).
    const { types, regex: typesRegex } = ruleUpdateTypes(bot, rule);
    if (types === undefined || types.length === 0) continue;
    const found = registries.flatMap(({ target, ecosystem }): { label: string; names: string[]; prefix: string; regex?: RefusedRegex }[] => {
      const prefix = POLICY_PREFIXES[ecosystem];
      const reach = prefix === undefined ? undefined : ruleReachesCounting(bot, rule, target);
      if (prefix === undefined || reach?.reaches !== true) return [];
      const policy = patternsFor(cooldown.exclude, ecosystem);
      const names = positive.filter((pattern) => !exempted(bot, pattern, policy));
      return names.length === 0 ? [] : [{ label: REGISTRY_LABELS[ecosystem], names, prefix, ...(reach.regex === undefined ? {} : { regex: reach.regex }) }];
    });
    if (found.length === 0) continue;
    const regex = typesRegex ?? found.find((entry) => entry.regex !== undefined)?.regex;
    const counting = regex === undefined ? '' : `, ${countedRegex(regex)}`;
    const names = [...new Set(found.flatMap((entry) => entry.names))];
    const quoted = listing(names.map((name) => JSON.stringify(name)));
    const labels = [...new Set(found.map((entry) => entry.label))];
    const where = `${listing(labels)} packages`;
    const scope = types.length === updateTypes.length ? quoted : `${listing(types)} updates of ${quoted}`;
    const own = OWN_RULES.some((entry) => entry.description === rule['description']);
    const additions = [...new Set(found.flatMap((entry) => entry.names.map((name) => JSON.stringify(`${entry.prefix}${name}`))))];
    // A /regex/ has no place in cooldown.exclude, which takes names and * patterns.
    const add = names.every((name) => !/^\/.*\/i?$/u.test(name)) ? `Add ${listing(additions)} to cooldown.exclude in ${POLICY_FILE}` : `List the packages in cooldown.exclude in ${POLICY_FILE}`;
    const then = (rules: string) => `depcurfew apply then ${edits ? 'writes' : 'shows in a snippet'} the ${rules} for them`;
    context.report({
      location: { file, line },
      message:
        delay.minutes === 0
          ? `packageRules[${index}] in ${file} turns off minimumReleaseAge for ${scope} (${where}${counting}), which cooldown.exclude in ${POLICY_FILE} does not exempt`
          : `packageRules[${index}] in ${file} sets minimumReleaseAge: ${JSON.stringify(rule['minimumReleaseAge'])} for ${scope} (${where}${counting}), shorter than cooldown.minimum "${cooldown.minimum.text}" in ${POLICY_FILE}, which cooldown.exclude does not exempt them from`,
      fix: `${(own
        ? edits
          ? `Run depcurfew apply, which writes the rule from cooldown.exclude in ${POLICY_FILE}`
          : `Write packageRules[${index}] of ${file} as the snippet of depcurfew apply shows it, from cooldown.exclude in ${POLICY_FILE} (depcurfew apply does not edit ${file})`
        : labels.length === 1
          ? `${add} if these packages need no delay (${then('rule')}), or remove the exception from packageRules[${index}] of ${file}`
          : `${add} if these packages need no delay (${then('rules')}), limit packageRules[${index}] of ${file} with ${matching.datasourceMatcher} to the registry it is meant for, or remove the exception from it`)}${regex === undefined ? '' : `; ${countedRegexFix(regex)}`}`,
    });
  }
}

export const broadExclusion: Rule = {
  id: 'broad-exclusion',
  checks: 'No exception list, per-scope setting or Renovate rule turns the release-age delay off beyond cooldown.exclude',
  summary: 'An exception list matches every package, or a per-scope setting or a Renovate rule exempts packages cooldown.exclude does not, which turns the protection off.',
  description:
    'A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks narrow but exempts every package, so the delay or the install-script block never applies. The same goes for a Renovate packageRules entry that turns minimumReleaseAge off for a whole datasource, manager (matchManagers) or category (matchCategories) in use, for major, minor or patch updates of every package, or with only negative patterns; with a cooldown for Renovate, also for the actions of the workflows (the github-actions manager, every workflow file, the depType action) and for Cargo, Go modules, Maven, Gradle or NuGet in the repository. A Renovate rule that gives npm, Python or Composer packages of some names a shorter delay than cooldown.minimum is an exception cooldown.exclude must make too, and a rule depcurfew apply wrote for the names of one registry must be limited to its datasource. In Yarn 4.17 and later, a shorter npmScopes.<scope>.npmMinimalAgeGate exempts that scope.',
  help: 'Replace the pattern with the packages or scopes that really need the exception.',
  level: 'error',
  requiresPolicy: false,
  // The policy's own lists, the package managers' exception lists and the bots' rules.
  applies: (scope) => scope.policy !== undefined || usesManager(scope) || usesBot(scope),
  check(context) {
    checkPolicy(context);
    checkManagers(context);
    checkYarnScopes(context);
    // A project's own bot files are never read by the bot; bot-cooldown-mismatch gives a note at each (decision D-107).
    for (const bot of context.project === undefined ? context.detection.bots : []) {
      for (const file of bot.configFiles) {
        if (bot.id === 'dependabot') checkDependabot(context, file);
        if (bot.id === 'renovate') checkRenovate(context, file);
      }
    }
  },
};
