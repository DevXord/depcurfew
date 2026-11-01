// config-drift: what `depcurfew apply` would change is exactly what no longer matches the policy, so the rule plans
// an apply in memory and reports every difference in every file (decision D-115: not only the first).
import { lines, myers } from '../../apply/diff.ts';
import { BLOCK_END, isBlockStart, SUPERSEDED, TURNED_OFF } from '../../apply/block.ts';
import { YAML_MARKER } from '../../apply/yaml-edit.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import type { ApplyReport } from '../../apply/index.ts';
import { pinnedVersion } from '../../apply/version.ts';
import { yamlOptionsFor } from '../../apply/facts.ts';
import { parseJsonc } from '../../detect/jsonc.ts';
import { parseYaml } from '../../yaml-parse.ts';
import { denyConflictText, remainingConflicts, type TextSource } from '../allow-lists.ts';
import { latestVersion } from '../effective.ts';
import { plannedApply } from '../plan.ts';
import { yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

/** The most findings of one file; the last one says how many places differ besides. */
const MAX_DIFFERENCES = 5;

function clean(line: string): string {
  return line.replace(/[\r\u0000]/gu, '').trim();
}

/** A line without the trailing comma that JSON needs before a following key. */
function withoutComma(line: string): string {
  return line.replace(/,$/u, '');
}

/** Lines depcurfew writes around its settings, which say nothing about a setting themselves. */
function isFrame(line: string): boolean {
  return line === '' || line === YAML_MARKER || isBlockStart(line) || line === BLOCK_END;
}

interface Difference {
  /** 1-based line of the file where the first difference starts. */
  line: number;
  removed: string[];
  added: string[];
  /** Lines apply comments out further down, outside the first difference (an .npmrc line set by hand). */
  commentedLater: string[];
}

/**
 * Every block of lines that apply would change, in order, without the lines that only gain or lose a trailing comma
 * (adding a JSON key changes the line before it) and without depcurfew's frame lines; a block left empty by that is
 * left out, but the first one stays. The first block also lists the lines apply comments out further down.
 */
function differences(before: string, after: string): Difference[] {
  const operations = myers(lines(before), lines(after));
  const total = Math.max(lines(before).length, 1);
  const found: Difference[] = [];
  let line = 1;
  let index = 0;
  while (index < operations.length) {
    while (index < operations.length && operations[index]?.kind === 'same') {
      line += 1;
      index += 1;
    }
    if (index >= operations.length) break;
    const start = line;
    let removed: string[] = [];
    let added: string[] = [];
    for (; index < operations.length && operations[index]?.kind !== 'same'; index++) {
      const operation = operations[index];
      if (operation === undefined) break;
      if (operation.kind === 'delete') line += 1;
      (operation.kind === 'delete' ? removed : added).push(clean(operation.line));
    }
    const commaOnly = new Set(removed.filter((text) => added.some((other) => withoutComma(other) === withoutComma(text))).map(withoutComma));
    removed = removed.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
    added = added.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
    const commentedLater =
      found.length === 0
        ? operations
            .slice(index)
            .filter((operation) => operation.kind === 'insert' && isCommentedOut(clean(operation.line)))
            .map((operation) => clean(operation.line))
        : [];
    if (found.length === 0 || removed.length > 0 || added.length > 0) found.push({ line: Math.min(start, total), removed, added, commentedLater });
  }
  return found.length === 0 ? [{ line: 1, removed: [], added: [], commentedLater: [] }] : found;
}

function isCommentedOut(line: string): boolean {
  return line.startsWith(SUPERSEDED) || line.startsWith(TURNED_OFF);
}

/** The structured data of a JSON or YAML file as the tool reads it, or undefined for other files and broken ones. */
function dataOf(file: string, text: string): unknown {
  try {
    if (/\.jsonc?$/u.test(file)) return parseJsonc(text);
    if (/\.ya?ml$/u.test(file)) return parseYaml(text, yamlOptionsFor(file));
  } catch {
    return undefined;
  }
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first key path, depth first, that the data after apply has and the data before lacks. */
function firstMissing(before: unknown, after: unknown, path: readonly string[] = []): string[] | undefined {
  if (!isObject(after) || !isObject(before)) return undefined;
  for (const [key, value] of Object.entries(after)) {
    if (!Object.hasOwn(before, key)) return [...path, key];
    const deeper = firstMissing(before[key], value, [...path, key]);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
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

/** Lines as a list for a message: `a`, `b` and `c`. */
function codeList(texts: readonly string[]): string {
  const quoted = texts.map(code);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`;
}

/** A YAML `key: value` line at the top level of the map: its key and value as the tool reads them. */
function topLevelYaml(file: string, line: string): { key: string; value: unknown } | undefined {
  if (!/\.ya?ml$/u.test(file) || /^\s/u.test(line)) return undefined;
  const data = dataOf(file, line);
  if (!isObject(data)) return undefined;
  const [entry, ...rest] = Object.entries(data);
  return entry === undefined || rest.length > 0 ? undefined : { key: entry[0], value: entry[1] };
}

/** Why a value that reads like the right one is not: quotes make "false" a string. */
function quotedNote(file: string, removed: string, added: string): string {
  const old = topLevelYaml(file, removed) ?? (/\.jsonc?$/u.test(file) ? jsonPair(removed) : undefined);
  const wanted = topLevelYaml(file, added) ?? (/\.jsonc?$/u.test(file) ? jsonPair(added) : undefined);
  if (old === undefined || wanted === undefined || old.key !== wanted.key || typeof old.value !== 'string' || typeof wanted.value === 'string') return '';
  return old.value === String(wanted.value) ? ` (in quotes it is a string, not ${JSON.stringify(wanted.value)})` : '';
}

/** A JSON line `"key": value` as a key and value. */
function jsonPair(line: string): { key: string; value: unknown } | undefined {
  try {
    const data = JSON.parse(`{${withoutComma(line)}}`) as unknown;
    const [entry, ...rest] = isObject(data) ? Object.entries(data) : [];
    return entry === undefined || rest.length > 0 ? undefined : { key: entry[0], value: entry[1] };
  } catch {
    return undefined;
  }
}

/** The key of a `key=value`, `key = value` or `key: value` line, for pairing an old line with its replacement. */
function keyOf(line: string): string | undefined {
  return /^\s*(?:-\s+)?["']?([^=:"'\s]+)["']?\s*[=:]/u.exec(line)?.[1];
}

/** What is wrong, in words: a value to change, a line to add or remove, or a hand-written line to comment out. */
function describe(file: string, difference: Difference, before: string, after: string): string {
  const commented = difference.added.filter(isCommentedOut);
  if (commented.length > 0) {
    // Every line apply comments out, also those further down: each one is a setting that does not hold.
    const all = [...commented, ...difference.commentedLater.filter((text) => !commented.includes(text))];
    const superseded = all.filter((text) => text.startsWith(SUPERSEDED)).map((text) => text.slice(SUPERSEDED.length));
    const turnedOff = all.filter((text) => text.startsWith(TURNED_OFF)).map((text) => text.slice(TURNED_OFF.length));
    const parts: string[] = [];
    if (superseded.length > 0) {
      const one = superseded.length === 1;
      parts.push(
        `${codeList(superseded)} ${one ? 'is' : 'are'} set outside the block that depcurfew manages; depcurfew apply comments ${one ? 'it' : 'them'} out, and the block sets what ${POLICY_FILE} requires`,
      );
    }
    if (turnedOff.length > 0) {
      const one = turnedOff.length === 1;
      parts.push(`${codeList(turnedOff)} ${one ? 'is' : 'are'} set by hand, but ${POLICY_FILE} manages ${one ? 'this setting' : 'these settings'}; depcurfew apply comments ${one ? 'it' : 'them'} out`);
    }
    return parts.join('; ');
  }
  const [removed] = difference.removed;
  // Several settings of one block changed: each old line and the line that replaces it (decision D-115).
  const pairs = difference.removed.length > 1 && difference.removed.length === difference.added.length && difference.removed.every((text, index) => keyOf(text) !== undefined && keyOf(text) === keyOf(difference.added[index] ?? ''));
  if (pairs) return difference.removed.map((text, index) => `${code(text)} should be ${code(difference.added[index] ?? '')}${quotedNote(file, text, difference.added[index] ?? '')}`).join(', ');
  if (removed !== undefined && difference.added.length > 0) return `${code(removed)} should be ${addedText(difference.added)}${quotedNote(file, removed, difference.added[0] ?? '')}`;
  if (difference.added.length > 0) {
    // A YAML key the map gets through a merge key (<<): the value apply writes into the map itself wins over it.
    const top = difference.added.length === 1 ? topLevelYaml(file, difference.added[0] ?? '') : undefined;
    const merged = top === undefined ? undefined : yamlSetting(before, [top.key], yamlOptionsFor(file));
    if (top !== undefined && merged?.mergedAt !== undefined) {
      return `${code(`${top.key}: ${JSON.stringify(merged.value)}`)} comes in through the merge key << at line ${merged.mergedAt} and should be ${addedText(difference.added)}; depcurfew apply writes it into the map itself, where it wins over merged keys`;
    }
    // A JSON object or list that is missing as a whole: name the setting, since the diff may begin inside it.
    const missing = firstMissing(dataOf(file, before), dataOf(file, after));
    if (missing !== undefined && /\.jsonc?$/u.test(file)) {
      const value = missing.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), dataOf(file, after));
      const text = JSON.stringify(value);
      return `${missing.join('.')} is missing${text !== undefined && text.length <= 100 ? `; depcurfew apply adds ${code(`"${missing.at(-1) ?? ''}": ${text}`)}` : ''}`;
    }
    return `${addedText(difference.added)} is missing`;
  }
  if (removed !== undefined) return `${code(removed)} should not be there`;
  return 'its layout differs from what depcurfew apply writes';
}

/** Where the finding points: the line of a value that comes in through a merge key, else the first difference. */
function findingLine(file: string, difference: Difference, before: string): number {
  if (difference.removed.length > 0 || difference.added.length !== 1) return difference.line;
  const top = topLevelYaml(file, difference.added[0] ?? '');
  const merged = top === undefined ? undefined : yamlSetting(before, [top.key], yamlOptionsFor(file));
  return merged?.mergedAt === undefined ? difference.line : merged.line;
}

/**
 * apply only adds to allow-lists and never changes an entry it did not write (decision D-088), so packages the policy
 * does not allow can stay there, and so can entries that contradict installScripts.deny or installScripts.allow;
 * report the ones that are still there once apply has run.
 */
function checkAllowLists(context: RuleContext, plan: ApplyReport): void {
  const policy = context.policy;
  if (policy?.installScripts?.default !== 'deny') return;
  const targets = policy.targets;
  const planned: TextSource = { readText: (file) => plan.changes.find((change) => change.file === file)?.after ?? context.repository.readText(file) };
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
    if (targets !== 'auto' && !targets.includes(manager.id)) continue;
    const knowledge = context.tools.find((entry) => entry.id === manager.id);
    const scripts = policyFor(policy, knowledge === undefined ? 'npm' : ecosystemOfTool(knowledge)).installScripts ?? { allow: [], deny: [] };
    const version = pinnedVersion(manager) ?? (knowledge === undefined ? undefined : latestVersion(knowledge));
    const options = { ...(knowledge === undefined ? {} : { tool: knowledge }), ...(version === undefined ? {} : { version }) };
    for (const conflict of remainingConflicts(context.repository, planned, manager.id, manager.configFiles, options, scripts)) {
      const { entry } = conflict;
      const location = entry.line === undefined ? { file: entry.file } : { file: entry.file, line: entry.line };
      // An entry that lets a package of installScripts.deny run its scripts contradicts the policy, so it is an error,
      // like the differences apply would fix; entries for packages the policy does not name, and entries that only
      // block a package the policy allows, are warnings (decision D-092).
      if (conflict.kind !== 'outside') {
        context.report({ level: conflict.kind === 'denied' ? 'error' : 'warning', location, ...denyConflictText({ kind: conflict.kind, entry }) });
        continue;
      }
      context.report({
        level: 'warning',
        location,
        message: `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it`,
        fix: `Remove ${entry.name} from ${entry.setting}, or add ${entry.name === entry.package ? 'it' : entry.package} to installScripts.allow in ${POLICY_FILE}`,
      });
    }
  }
}

export const configDrift: Rule = {
  id: 'config-drift',
  checks: 'Configuration files match what depcurfew apply writes for depcurfew.json',
  summary: 'A configuration file does not match what depcurfew apply writes for depcurfew.json.',
  description:
    'A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy. Entries in a tool\'s own install-script lists that apply does not change are reported as well: one that lets a package of installScripts.deny run its scripts is an error, like the differences depcurfew apply fixes, and one that lets a package the policy does not name run them, or that blocks a package the policy allows, is a warning.',
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
      const [first, ...later] = differences(change.before, change.after);
      // The lines the first finding names as commented out further down are not reported again.
      const named = new Set(first?.commentedLater ?? []);
      const repeats = (item: Difference) => item.added.some((text) => named.has(text)) && item.removed.every((text) => [...named].some((line) => line.endsWith(text)));
      const all = [first, ...later.filter((item) => !repeats(item))].filter((item): item is Difference => item !== undefined);
      // A file with hundreds of differences (500 Dependabot entries) gives MAX_DIFFERENCES findings, the last with the count.
      const shown = all.slice(0, MAX_DIFFERENCES);
      const rest = all.length - shown.length;
      for (const [index, difference] of shown.entries()) {
        const more = index === shown.length - 1 && rest > 0 ? `; ${rest} more ${rest === 1 ? 'place' : 'places'} in ${change.file} ${rest === 1 ? 'differs' : 'differ'} too (depcurfew apply --dry-run shows them)` : '';
        context.report({
          location: { file: change.file, line: findingLine(change.file, difference, change.before) },
          message: `${change.file} does not match ${POLICY_FILE}: ${describe(change.file, difference, change.before, change.after)}${more}`,
          fix: `Run depcurfew apply to bring ${change.file} back in line with ${POLICY_FILE} (depcurfew apply --dry-run shows the change first), or change ${POLICY_FILE} if the edit was intended`,
        });
      }
    }
    checkAllowLists(context, plan);
  },
};

/**
 * The first difference of a planned change as config-drift words it, with its line: for doctor --user, whose user
 * files drift the same way (decision D-116).
 */
export function driftDescription(file: string, before: string, after: string): { line: number; text: string } {
  const difference = firstDifference(before, after);
  return { line: findingLine(file, difference, before), text: describe(file, difference, before, after) };
}
