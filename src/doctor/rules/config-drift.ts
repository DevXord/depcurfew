// config-drift: what `depcurfew apply` would change is exactly what no longer matches the policy, so the rule plans
// an apply in memory and reports the first difference in every file.
import { lines, myers } from '../../apply/diff.ts';
import { BLOCK_END, BLOCK_START, SUPERSEDED, TURNED_OFF } from '../../apply/block.ts';
import { YAML_MARKER } from '../../apply/yaml-edit.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { allowEntries, matchesPattern } from '../allow-lists.ts';
import { plannedApply } from '../plan.ts';
import type { Rule, RuleContext } from '../types.ts';

function clean(line: string): string {
  return line.replace(/[\r\u0000]/gu, '').trim();
}

/** A line without the trailing comma that JSON needs before a following key. */
function withoutComma(line: string): string {
  return line.replace(/,$/u, '');
}

/** Lines depcurfew writes around its settings, which say nothing about a setting themselves. */
function isFrame(line: string): boolean {
  return line === '' || line === YAML_MARKER || line === BLOCK_START || line === BLOCK_END;
}

interface Difference {
  /** 1-based line of the file where the first difference starts. */
  line: number;
  removed: string[];
  added: string[];
}

/**
 * The first block of lines that apply would change, without the lines that only gain or lose a trailing comma
 * (adding a JSON key changes the line before it) and without depcurfew's frame lines.
 */
function firstDifference(before: string, after: string): Difference {
  const operations = myers(lines(before), lines(after));
  let line = 1;
  let index = 0;
  while (index < operations.length && operations[index]?.kind === 'same') {
    line += 1;
    index += 1;
  }
  let removed: string[] = [];
  let added: string[] = [];
  for (; index < operations.length && operations[index]?.kind !== 'same'; index++) {
    const operation = operations[index];
    if (operation === undefined) break;
    (operation.kind === 'delete' ? removed : added).push(clean(operation.line));
  }
  const commaOnly = new Set(removed.filter((text) => added.some((other) => withoutComma(other) === withoutComma(text))).map(withoutComma));
  removed = removed.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
  added = added.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
  return { line: Math.min(line, Math.max(lines(before).length, 1)), removed, added };
}

function code(text: string): string {
  return `\`${withoutComma(text)}\``;
}

/** Added lines for a message: a short JSON object or array on one line, otherwise the first line and a count. */
function addedText(added: readonly string[]): string {
  const [first = ''] = added;
  if (added.length === 1) return code(first);
  const joined = added.join(' ').replaceAll(/\s+/gu, ' ');
  if (/[{[]$/u.test(first) && joined.length <= 100) return code(joined);
  return `${code(first)} (and ${added.length - 1} more ${added.length === 2 ? 'line' : 'lines'})`;
}

/** What is wrong, in words: a value to change, a line to add or remove, or a hand-written line to comment out. */
function describe(difference: Difference): string {
  const commented = difference.added.find((text) => text.startsWith(SUPERSEDED) || text.startsWith(TURNED_OFF));
  if (commented !== undefined) {
    if (commented.startsWith(SUPERSEDED)) {
      return `${code(commented.slice(SUPERSEDED.length))} is set outside the block that depcurfew manages; depcurfew apply comments it out, and the block sets what ${POLICY_FILE} requires`;
    }
    return `${code(commented.slice(TURNED_OFF.length))} is set by hand, but ${POLICY_FILE} manages this setting; depcurfew apply comments it out`;
  }
  const [removed] = difference.removed;
  if (removed !== undefined && difference.added.length > 0) return `${code(removed)} should be ${addedText(difference.added)}`;
  if (difference.added.length > 0) return `${addedText(difference.added)} is missing`;
  if (removed !== undefined) return `${code(removed)} should not be there`;
  return 'its layout differs from what depcurfew apply writes';
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
  summary: 'A configuration file does not match what depcurfew apply writes for depcurfew.json.',
  description:
    'A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy.',
  help: 'Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const plan = plannedApply(context);
    if (plan === undefined) return;
    // Files apply cannot edit are reported by unreadable-config.
    for (const change of plan.changes) {
      if (change.before === null) {
        context.report({
          location: { file: POLICY_FILE },
          message: `${change.file} is missing; depcurfew apply would create it with the settings from ${POLICY_FILE}`,
          fix: `Run depcurfew apply to create ${change.file} (depcurfew apply --dry-run shows its content first)`,
        });
        continue;
      }
      const difference = firstDifference(change.before, change.after);
      context.report({
        location: { file: change.file, line: difference.line },
        message: `${change.file} does not match ${POLICY_FILE}: ${describe(difference)}`,
        fix: `Run depcurfew apply to bring ${change.file} back in line with ${POLICY_FILE} (depcurfew apply --dry-run shows the change first), or change ${POLICY_FILE} if the edit was intended`,
      });
    }
    checkAllowLists(context);
  },
};
