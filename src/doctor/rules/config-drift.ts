// config-drift: what `depgate apply` would change is exactly what no longer matches the policy, so the rule plans
// an apply in memory and reports the first difference in every file.
import { lines, myers } from '../../apply/diff.ts';
import { YAML_MARKER } from '../../apply/yaml-edit.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { allowEntries, matchesPattern } from '../allow-lists.ts';
import { plannedApply } from '../plan.ts';
import type { Rule, RuleContext } from '../types.ts';

function clean(line: string): string {
  return line.replace(/[\r\u0000]/gu, '').trim();
}

/** The line of `before` where the first difference starts, and what apply would remove or add there. */
function firstDifference(before: string, after: string): { line: number; removed: string | undefined; added: string | undefined } {
  const operations = myers(lines(before), lines(after));
  let line = 1;
  let index = 0;
  while (index < operations.length && operations[index]?.kind === 'same') {
    line += 1;
    index += 1;
  }
  let removed: string | undefined;
  let added: string | undefined;
  for (; index < operations.length && operations[index]?.kind !== 'same'; index++) {
    const operation = operations[index];
    if (operation === undefined) break;
    const text = clean(operation.line);
    if (operation.kind === 'delete') removed ??= text;
    else if (text !== '' && text !== YAML_MARKER) added ??= text;
  }
  return { line: Math.min(line, Math.max(lines(before).length, 1)), removed, added };
}

/** apply only adds to allow-lists, so packages the policy does not allow can stay there; report them. */
function checkAllowLists(context: RuleContext): void {
  const scripts = context.policy?.installScripts;
  if (scripts?.default !== 'deny') return;
  const targets = context.policy?.targets;
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
    if (targets !== undefined && targets !== 'auto' && !targets.includes(manager.id)) continue;
    for (const entry of allowEntries(context.repository, manager.id, manager.configFiles)) {
      if (scripts.allow.some((pattern) => matchesPattern(entry.package, pattern))) continue;
      context.report({
        level: 'warning',
        location: entry.line === undefined ? { file: entry.file } : { file: entry.file, line: entry.line },
        message: `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it`,
        fix: `Remove ${entry.name} from ${entry.setting}, or add ${entry.name === entry.package ? 'it' : entry.package} to installScripts.allow in ${POLICY_FILE}`,
      });
    }
  }
}

export const configDrift: Rule = {
  id: 'config-drift',
  summary: 'A configuration file does not match what depgate apply writes for depgate.json.',
  description:
    'A generated setting was edited by hand, or depgate.json changed without running depgate apply, so the tools enforce something other than the policy.',
  help: 'Run depgate apply (depgate apply --dry-run shows the difference), or change depgate.json if the edit was intended.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const plan = plannedApply(context);
    if (plan === undefined) return;
    // Files apply cannot edit are reported by unreadable-config.
    for (const change of plan.changes) {
      if (change.before === null) {
        context.report({ location: { file: POLICY_FILE }, message: `${change.file} is missing; depgate apply would create it with the settings from ${POLICY_FILE}` });
        continue;
      }
      const difference = firstDifference(change.before, change.after);
      const detail =
        difference.removed !== undefined && difference.added !== undefined
          ? `"${difference.removed}" should be "${difference.added}"`
          : difference.added !== undefined
            ? `"${difference.added}" is missing`
            : `"${difference.removed ?? ''}" should not be there`;
      context.report({ location: { file: change.file, line: difference.line }, message: `${change.file} does not match ${POLICY_FILE}: ${detail}` });
    }
    checkAllowLists(context);
  },
};
