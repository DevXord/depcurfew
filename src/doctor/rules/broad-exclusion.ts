// broad-exclusion: an exception list that matches every package turns the protection off while the setting still
// looks configured. Checked in depcurfew.json, in the tools' own files and in Renovate packageRules.
import { extraOf, isRecord, settingOf, values } from '../../apply/facts.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { delayMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import { matchesEveryName, readRenovateConfig, ruleScope, type RuleScope } from '../renovate.ts';
import { lineOf, readSetting, yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

/** Patterns that match every package (or every scoped package): *, **, @*\/*, npm:*, and regexes like /.*\/. */
export const isBroad = matchesEveryName;

function tool(context: RuleContext, id: string): ToolKnowledge | undefined {
  return context.tools.find((entry) => entry.id === id);
}

function checkPolicy(context: RuleContext): void {
  const policy = context.policy;
  if (policy === undefined) return;
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
    for (const file of files) {
      const found = readSetting(context.repository, file, setting);
      if (found === undefined || !Array.isArray(found.value)) continue;
      for (const pattern of (found.value as unknown[]).filter((item): item is string => typeof item === 'string' && isBroad(item))) {
        context.report({
          location: { file, line: found.line },
          message: `${setting} contains "${pattern}", so ${knowledge.name} applies no release-age delay to any package`,
          fix: `Remove "${pattern}" and list only the packages that need the exception`,
        });
      }
    }
  }
}

function checkDependabot(context: RuleContext, file: string): void {
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const updates = yamlSetting(text, ['updates']);
  if (updates === undefined || !Array.isArray(updates.value)) return;
  (updates.value as unknown[]).forEach((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry['cooldown']) || !Array.isArray(entry['cooldown']['exclude'])) return;
    const broad = (entry['cooldown']['exclude'] as unknown[]).filter((item): item is string => typeof item === 'string' && isBroad(item));
    if (broad.length === 0) return;
    context.report({
      location: { file, line: yamlSetting(text, ['updates', String(index), 'cooldown', 'exclude'])?.line ?? updates.line },
      message: `cooldown.exclude in updates[${index}] (${String(entry['package-ecosystem'])}) contains "${broad[0] ?? ''}", so Dependabot applies no cooldown`,
      fix: `Remove "${broad[0] ?? ''}" and list only the dependencies that need the exception`,
    });
  });
}

const isPackageJsonConfig = (value: unknown): value is { file: string; key: string } =>
  isRecord(value) && typeof value['file'] === 'string' && typeof value['key'] === 'string';
const isMatching = (value: unknown): value is { negation: string; datasourceMatcher: string; updateTypeMatcher: string } =>
  isRecord(value) && typeof value['negation'] === 'string' && typeof value['datasourceMatcher'] === 'string' && typeof value['updateTypeMatcher'] === 'string';

function listing(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What a packageRules entry covers, for the message: its update types, names and datasources. */
function covers(scope: RuleScope, datasources: readonly string[], matching: { negation: string; datasourceMatcher: string; updateTypeMatcher: string }): string {
  const types = scope.matchers.includes(matching.updateTypeMatcher) ? `${listing(scope.updateTypes)} updates of ` : '';
  const names = scope.names.kind === 'except' ? `every package except ${listing(scope.names.patterns.map((pattern) => pattern.slice(matching.negation.length)))}` : 'every package';
  const from = scope.matchers.includes(matching.datasourceMatcher) ? ` from the ${listing(datasources)} datasource${datasources.length === 1 ? '' : 's'}` : '';
  const note = scope.names.kind === 'except' ? ' (a list of only negative patterns matches every other package)' : '';
  return `${types}${names}${from}${note}`;
}

/** packageRules entries that turn minimumReleaseAge off for every package of a registry (extra.packageRuleMatching). */
function checkRenovate(context: RuleContext, file: string): void {
  const bot = tool(context, 'renovate');
  if (bot === undefined || !/\.jsonc?$/u.test(file)) return;
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const packageJson = extraOf(bot, 'packageJsonConfig', isPackageJsonConfig);
  const config = readRenovateConfig(text, file, file === packageJson.file ? [packageJson.key] : []);
  const matching = extraOf(bot, 'packageRuleMatching', isMatching);
  const datasources = extraOf(bot, 'datasources', isRecord);
  // Registries of the detected package managers; a rule for another registry changes nothing here.
  const detected = [...new Set(context.detection.packageManagers.filter((entry) => entry.supported).flatMap((entry) => {
    const knowledge = tool(context, entry.id);
    return knowledge === undefined ? [] : [ecosystemOfTool(knowledge)];
  }))];
  const ecosystems = detected.length > 0 ? detected : (['npm', 'pypi'] as const);
  for (const { index, line, rule } of config.rules) {
    if (!('minimumReleaseAge' in rule)) continue;
    const delay = delayMinutes(bot, rule['minimumReleaseAge'], latestVersion(bot));
    if (!delay.ok || delay.minutes !== 0) continue;
    const covered = ecosystems.flatMap((ecosystem) => {
      const scope = ruleScope(bot, rule, ecosystem);
      return scope === undefined ? [] : [{ scope, datasource: String(datasources[ecosystem]) }];
    });
    const first = covered[0];
    if (first === undefined) continue;
    const { scope } = first;
    context.report({
      location: { file, line },
      message:
        scope.matchers.length === 0
          ? `packageRules[${index}] turns off minimumReleaseAge without matching any packages, so it applies to all of them`
          : scope.names.kind === 'pattern' && scope.matchers.every((key) => key !== matching.datasourceMatcher && key !== matching.updateTypeMatcher)
            ? `packageRules[${index}] turns off minimumReleaseAge for "${scope.names.pattern}", which matches every package`
            : `packageRules[${index}] turns off minimumReleaseAge for ${covers(scope, covered.map((item) => item.datasource), matching)}`,
      fix: 'Match only the packages that need the exception, e.g. with matchPackageNames: ["@your-scope/*"]',
    });
  }
}

export const broadExclusion: Rule = {
  id: 'broad-exclusion',
  summary: 'An exception list matches every package, which turns the protection off.',
  description:
    'A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies. The same goes for a Renovate packageRules entry that turns minimumReleaseAge off for a whole datasource, for major, minor or patch updates of every package, or with only negative patterns, which match every package they do not name.',
  help: 'Replace the pattern with the packages or scopes that really need the exception.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    checkPolicy(context);
    checkManagers(context);
    for (const bot of context.detection.bots) {
      for (const file of bot.configFiles) {
        if (bot.id === 'dependabot') checkDependabot(context, file);
        if (bot.id === 'renovate') checkRenovate(context, file);
      }
    }
  },
};
