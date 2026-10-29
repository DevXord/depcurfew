// broad-exclusion: an exception list that matches every package turns the protection off while the setting still
// looks configured. Checked in depgate.json and in the tools' own files.
import { isRecord, settingOf, values } from '../../apply/facts.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { jsonSetting, lineOf, readSetting, yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

/** Patterns that match every package (or every scoped package): *, **, @*\/*, npm:*, and regexes like /.*\/. */
export function isBroad(pattern: string): boolean {
  const name = pattern.replace(/^(npm|jsr):/u, '');
  return /^(@\*+\/)?\*+$/u.test(name) || /^\/\^?\.[*+]\$?\/[a-z]*$/u.test(name);
}

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

const MATCHERS = /^(match|exclude)[A-Z]/u;

function checkRenovate(context: RuleContext, file: string): void {
  if (!/\.jsonc?$/u.test(file)) return;
  const text = context.repository.readText(file);
  if (text === undefined) return;
  const rules = jsonSetting(text, ['packageRules']);
  if (rules === undefined || !Array.isArray(rules.value)) return;
  (rules.value as unknown[]).forEach((rule, index) => {
    if (!isRecord(rule) || !('minimumReleaseAge' in rule) || (rule['minimumReleaseAge'] !== null && rule['minimumReleaseAge'] !== '0 days')) return;
    const names = Array.isArray(rule['matchPackageNames']) ? (rule['matchPackageNames'] as unknown[]) : [];
    const broad = names.find((name): name is string => typeof name === 'string' && isBroad(name));
    const unscoped = !Object.keys(rule).some((key) => MATCHERS.test(key));
    if (broad === undefined && !unscoped) return;
    const line = jsonSetting(text, ['packageRules', index])?.line ?? rules.line;
    context.report({
      location: { file, line },
      message:
        broad === undefined
          ? `packageRules[${index}] turns off minimumReleaseAge without matching any packages, so it applies to all of them`
          : `packageRules[${index}] turns off minimumReleaseAge for "${broad}", which matches every package`,
      fix: 'Match only the packages that need the exception, e.g. with matchPackageNames: ["@your-scope/*"]',
    });
  });
}

export const broadExclusion: Rule = {
  id: 'broad-exclusion',
  summary: 'An exception list matches every package, which turns the protection off.',
  description:
    'A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies.',
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
