// broad-exclusion: an exception list that matches every package turns the protection off while the setting still
// looks configured. Checked in depcurfew.json, in the tools' own files and in Renovate packageRules.
import { extraOf, isRecord, settingOf, values } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion } from '../../apply/version.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
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
  if (bot === undefined || !/(\.jsonc?|\.renovaterc)$/u.test(file)) return;
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
  summary: 'An exception list matches every package, or a per-scope setting shortens the delay, which turns the protection off.',
  description:
    'A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies. The same goes for a Renovate packageRules entry that turns minimumReleaseAge off for a whole datasource, for major, minor or patch updates of every package, or with only negative patterns, which match every package they do not name. In Yarn 4.17 and later, npmScopes.<scope>.npmMinimalAgeGate replaces the delay for one scope, so a shorter value there exempts that scope.',
  help: 'Replace the pattern with the packages or scopes that really need the exception.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    checkPolicy(context);
    checkManagers(context);
    checkYarnScopes(context);
    for (const bot of context.detection.bots) {
      for (const file of bot.configFiles) {
        if (bot.id === 'dependabot') checkDependabot(context, file);
        if (bot.id === 'renovate') checkRenovate(context, file);
      }
    }
  },
};
