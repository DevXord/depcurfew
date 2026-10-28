// Renovate: minimumReleaseAge, a packageRules entry for exclusions (recognised by its description) and the delay
// for security updates. JSON5 files and the deprecated package.json key are not edited; a snippet is printed.
import { convertCooldown } from '../../policy/convert.ts';
import { extraOf, isRecord, settingOf, values } from '../facts.ts';
import { exclusions } from './common.ts';
import type { BotGenerator } from './context.ts';

export const RULE_DESCRIPTION = 'depgate: packages excluded from minimumReleaseAge';

interface ExcludeRule {
  list: string;
  match: string;
  value: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isRule = (value: unknown): value is ExcludeRule => isRecord(value) && typeof value['list'] === 'string' && typeof value['match'] === 'string';
const isPath = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

export const renovate: BotGenerator = (context, duration) => {
  const { tool, policy, workspace } = context;
  if (policy.cooldown === undefined || duration === undefined) return;
  const result = convertCooldown(tool, duration);
  if (!result.ok) {
    context.warn(`${context.name}: cooldown not written: ${result.reason}`);
    return;
  }
  const setting = settingOf(tool.cooldown.setting) ?? 'minimumReleaseAge';
  const rule = extraOf(tool, 'excludeRule', isRule);
  const descriptionKey = extraOf(tool, 'ruleDescription', isString);
  const securityPath = extraOf(tool, 'securityUpdatesSetting', isPath);
  const patterns = exclusions(context) ?? [];
  const exclusionRule = { [descriptionKey]: RULE_DESCRIPTION, [rule.match]: patterns, [setting]: rule.value };
  const security = policy.cooldown.securityUpdates === 'delay' ? result.value : null;

  const candidates = values(tool.cooldown.configFiles)[0] ?? [];
  const file = candidates.find((name) => workspace.exists(name));
  const snippet = () =>
    JSON.stringify(
      {
        [setting]: result.value,
        ...(patterns.length > 0 ? { [rule.list]: [exclusionRule] } : {}),
        ...(securityPath.reduceRight<unknown>((inner, key) => ({ [key]: inner }), security) as Record<string, unknown>),
      },
      null,
      2,
    );

  if (file === undefined || !/\.jsonc?$/u.test(file)) {
    const packageJson = extraOf(tool, 'packageJsonConfig', isRecord);
    const where = file ?? (workspace.exists('package.json') && context.json('package.json').get([String(packageJson['key'])]) !== undefined ? 'package.json' : undefined);
    if (where === undefined) {
      context.warn(`${context.name}: no configuration file found; depgate does not create one`);
      return;
    }
    context.warn(
      where === 'package.json'
        ? `${context.name}: configuration in package.json is deprecated and depgate does not edit it; move it to renovate.json or add the snippet by hand`
        : `${context.name}: ${where} is not plain JSON or JSONC, so depgate does not edit it; add the snippet by hand`,
    );
    context.snippet(where, snippet());
    return;
  }

  const json = context.json(file);
  json.set([setting], result.value);
  const rules = json.get([rule.list]);
  const index = Array.isArray(rules) ? rules.findIndex((entry) => isRecord(entry) && entry[descriptionKey] === RULE_DESCRIPTION) : -1;
  if (patterns.length > 0) {
    if (index >= 0) {
      if (JSON.stringify((rules as unknown[])[index]) !== JSON.stringify(exclusionRule)) json.replace([rule.list], index, exclusionRule);
    } else if (Array.isArray(rules)) {
      json.append([rule.list], exclusionRule);
    } else {
      json.set([rule.list], [exclusionRule]);
    }
  } else if (index >= 0) {
    json.remove([rule.list], index);
  }
  json.set(securityPath, security);
};
