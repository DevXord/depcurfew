// config-drift: what `depcurfew apply` would change is exactly what no longer matches the policy, so the rule plans
// an apply in memory and reports every difference in every file (decision D-115: not only the first). Against the
// default policy, without depcurfew.json, it gives one note per file with the settings apply would set (decision D-149).
import { lines, myers, redactText } from '../../apply/diff.ts';
import { BLOCK_END, isBlockStart, SUPERSEDED, TURNED_OFF } from '../../apply/block.ts';
import { YAML_MARKER } from '../../apply/yaml-edit.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { planDetails, type ApplyReport } from '../../apply/index.ts';
import { cooldownMayHold } from '../../apply/generators/bundler.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { pinnedVersion } from '../../apply/version.ts';
import { listing } from '../../apply/requirements.ts';
import { extraOf, isRecord, settingOf, values, yamlOptionsFor } from '../../apply/facts.ts';
import { parseJsonc } from '../../detect/jsonc.ts';
import { parseYaml } from '../../yaml-parse.ts';
import { denyConflictText, outsideConflictText, remainingConflicts, unreadAllowList, type TextSource } from '../allow-lists.ts';
import { ignoreOutsidePolicy, ignoreOutsideText } from '../composer.ts';
import { latestVersion, managerDelay } from '../effective.ts';
import { APPLY_NEXT, DEFAULT_POLICY_NAME, INIT_FIRST } from '../default-policy.ts';
import { formatMinutes } from '../durations.ts';
import { plannedApply } from '../plan.ts';
import { settingChanges } from '../setting-changes.ts';
import { yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

/** The most findings of one file; the last one says how many places differ besides (doctor --user too, D-122). */
export const MAX_DIFFERENCES = 5;

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
    // A set of the added lines, so that a block of thousands of lines takes linear time (decision D-121).
    const addedLines = new Set(added.map(withoutComma));
    const commaOnly = new Set(removed.map(withoutComma).filter((text) => addedLines.has(text)));
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

/**
 * Removed lines for a message: one line as it is, or a YAML key with the lines below it as the value Dependabot or the
 * tool reads (`exclude: ["*\/*"]`) when that is short, else the first line and a count (decision D-141).
 */
function removedText(file: string, removed: readonly string[]): string {
  const [first = ''] = removed;
  if (removed.length === 1) return code(first);
  const data = /\.ya?ml$/u.test(file) && /:$/u.test(first) ? dataOf(file, removed.join('\n')) : undefined;
  const entries = isObject(data) ? Object.entries(data) : [];
  const [entry] = entries;
  if (entry !== undefined && entries.length === 1) {
    const text = `${entry[0]}: ${JSON.stringify(entry[1])}`;
    if (text.length <= 100) return code(text);
  }
  return `${code(first)} (and ${removed.length - 1} more ${removed.length === 2 ? 'line' : 'lines'})`;
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
function describe(file: string, original: Difference, before: string, after: string): string {
  // In YAML apply keeps the entries it drops from a list as a comment above it (decision D-167); the difference is the
  // value it writes, which says more than the comment.
  const kept = /\.ya?ml$/u.test(file) ? original.added.filter((text) => !isCommentedOut(text)) : original.added;
  const difference = kept.length > 0 ? { ...original, added: kept } : original;
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
  if (removed !== undefined && difference.added.length > 0) return `${removedText(file, difference.removed)} should be ${addedText(difference.added)}${quotedNote(file, removed, difference.added[0] ?? '')}`;
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
    // A version that does not read the allow-list yet runs no script an entry names (Deno before 2.6.0, decision D-173).
    const unread = unreadAllowList(knowledge, version);
    for (const conflict of remainingConflicts(context.repository, planned, manager.id, manager.configFiles, options, scripts)) {
      const { entry } = conflict;
      const location = entry.line === undefined ? { file: entry.file } : { file: entry.file, line: entry.line };
      // An entry that lets a package of installScripts.deny run its scripts contradicts the policy, so it is an error,
      // like the differences apply would fix; entries for packages the policy does not name, and entries that only
      // block a package the policy allows, are warnings (decision D-092). One the version in use does not read is a
      // warning: it lets nothing run there yet.
      if (conflict.kind !== 'outside') {
        context.report({ level: conflict.kind === 'denied' && unread === undefined ? 'error' : 'warning', location, ...denyConflictText({ kind: conflict.kind, entry }, false, unread) });
        continue;
      }
      context.report({ level: 'warning', location, ...outsideConflictText(entry, false, unread) });
    }
  }
}

/**
 * Composer: depcurfew apply adds the exceptions of cooldown.exclude to config.policy.cooldown.ignore and removes only
 * those it wrote with its reason (decision D-134), so other entries can exempt a package the policy does not; report the
 * ones still there once apply has run.
 */
function checkComposerExclusions(context: RuleContext, plan: ApplyReport): void {
  const policy = context.policy;
  if (policy?.cooldown === undefined || (policy.targets !== 'auto' && !policy.targets.includes('composer'))) return;
  const tool = context.tools.find((entry) => entry.id === 'composer');
  if (tool === undefined || !context.detection.packageManagers.some((entry) => entry.id === 'composer' && entry.supported)) return;
  const setting = settingOf(tool.cooldown.exclude.setting);
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (setting === null || file === undefined) return;
  const hash = extraOf(tool, 'contentHash', (value): value is { command: string } => isRecord(value) && typeof value['command'] === 'string');
  const now = context.repository.readText(file);
  const planned = plan.changes.find((change) => change.file === file)?.after ?? now;
  const patterns = policyFor(policy, 'packagist').cooldown?.exclude ?? [];
  for (const entry of ignoreOutsidePolicy(now, planned, setting.split('.'), patterns)) {
    context.report({
      level: 'warning',
      location: entry.line === undefined ? { file } : { file, line: entry.line },
      ...ignoreOutsideText(entry, { setting, file, policyFile: POLICY_FILE, relock: hash.command }),
    });
  }
}

/**
 * Bundler: when apply cannot write the cooldown (the only source "https://rubygems.org" has a block, a modifier or
 * another form apply does not edit, its URL comes from ENV, the Gemfile has no such source, or depcurfew does not read
 * the Gemfile as Ruby does), the plan has no change and Bundler has no delay. Each cooldown-not-written of the plan is
 * reported where it points, with apply's text (decision D-159): as an error, or as a warning when the call there already
 * waits at least the policy's days and depcurfew only cannot be sure that Ruby runs it. A source inside a block or with
 * a URL from ENV is reported also next to a plain call, and the Gemfile is read from disk with \r\n as one newline, as
 * apply reads it (decision D-163).
 */
function checkBundlerCooldown(context: RuleContext, plan: ApplyReport): void {
  const tool = context.tools.find((entry) => entry.id === 'bundler');
  const minimum = tool === undefined || context.policy === undefined ? undefined : policyFor(context.policy, ecosystemOfTool(tool)).cooldown?.minimum;
  if (tool === undefined || minimum === undefined) return;
  const converted = convertCooldown(tool, minimum);
  const days = converted.ok && typeof converted.value === 'number' ? converted.value : undefined;
  for (const warning of plan.warningDetails) {
    if (warning.code !== 'cooldown-not-written' || warning.tool !== 'bundler' || warning.location === undefined) continue;
    const text = context.repository.readText(warning.location.file);
    const mayHold = days !== undefined && text !== undefined && cooldownMayHold(text, warning.location.line, days);
    context.report({ ...(mayHold ? { level: 'warning' as const } : {}), location: warning.location, message: warning.message, ...(warning.fix === undefined ? {} : { fix: warning.fix }) });
  }
}

/**
 * pip: a --no-binary or --only-binary=:none: in requirements.txt or a file it includes that apply cannot comment out
 * (after a requirement, next to other options, on a continued line) undoes --only-binary=:all: after apply too; each
 * build-switch-undone of the plan is reported where it points, with apply's text (decision D-167). Lines apply comments
 * out are differences of the plan, reported above.
 */
function checkPipOptions(context: RuleContext, plan: ApplyReport): void {
  for (const warning of plan.warningDetails) {
    if (warning.code !== 'build-switch-undone' || warning.location === undefined) continue;
    context.report({ location: warning.location, message: warning.message, ...(warning.fix === undefined ? {} : { fix: warning.fix }) });
  }
}

/**
 * Cargo (E07): a setting of .cargo/config.toml that undoes the delay apply writes (cooldown-overridden), a value apply
 * cannot read or that Cargo may wrap, and the older name .cargo/config (cooldown-not-written) stay after apply; each is
 * reported where it points, with apply's text, once per line, as for Bundler (decision D-159) and pip (decision D-167).
 */
function checkCargoCooldown(context: RuleContext, plan: ApplyReport): void {
  const seen = new Set<string>();
  for (const warning of plan.warningDetails) {
    if (warning.tool !== 'cargo' || warning.location === undefined || (warning.code !== 'cooldown-overridden' && warning.code !== 'cooldown-not-written')) continue;
    const key = `${warning.location.file}\u0000${warning.location.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    context.report({ location: warning.location, message: warning.message, ...(warning.fix === undefined ? {} : { fix: warning.fix }) });
  }
}

/** The most settings a note against the default policy names; the rest are counted (decision D-149). */
export const MAX_SETTINGS = 6;

/** Settings for a message: `a`, `b` and `c`, at most MAX_SETTINGS, then how many more. */
function settingList(settings: readonly string[]): string {
  const shown = settings.slice(0, MAX_SETTINGS).map((setting) => `\`${setting}\``);
  const rest = settings.length - shown.length;
  if (rest > 0) shown.push(`${rest} more ${rest === 1 ? 'setting' : 'settings'}`);
  return listing(shown);
}

/**
 * The package managers that wait less than cooldown.minimum now, each in words with where its delay comes from, by
 * the file apply writes its delay to (decision D-149).
 */
function delaysNow(context: RuleContext, plan: ApplyReport): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const policy = context.policy;
  if (policy === undefined) return found;
  const targets = planDetails(plan)?.targets;
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported && targets?.has(entry.id) !== false)) {
    const tool = context.tools.find((entry) => entry.id === manager.id);
    if (tool === undefined || tool.kind !== 'package-manager') continue;
    const minimum = policyFor(policy, ecosystemOfTool(tool)).cooldown?.minimum.minutes;
    if (minimum === undefined) continue;
    const delay = managerDelay(context, manager, tool);
    if (delay === undefined || delay.minutes >= minimum) continue;
    const file = [delay.location?.file, ...(values(tool.cooldown.configFiles)[0] ?? [])].find((name) => name !== undefined && plan.changes.some((change) => change.file === name));
    if (file === undefined) continue;
    // Where the delay comes from, unless the version simply has none by default.
    const text =
      delay.minutes === 0
        ? `${tool.name} installs new versions without a release-age delay${delay.byDefault === true ? '' : ` (${delay.origin})`}`
        : `${tool.name} waits only ${formatMinutes(delay.minutes)} before installing a new version (${delay.origin})`;
    found.set(file, [...(found.get(file) ?? []), text]);
  }
  return found;
}

/**
 * Against the default policy (decision D-149), one note per file instead of one finding per difference: what the
 * package manager does now, when it waits less, and the settings apply would set, as the tool reads them. A file whose
 * settings already hold, where apply would only move them into its block or add its comments, gives none.
 */
function reportAgainstDefault(context: RuleContext, plan: ApplyReport): void {
  const now = delaysNow(context, plan);
  for (const change of plan.changes) {
    const { set, removed } = settingChanges(change.file, change.before, change.after);
    if (set.length === 0 && removed.length === 0) continue;
    const what = [...(set.length === 0 ? [] : [`set ${settingList(set)}`]), ...(removed.length === 0 ? [] : [`remove ${settingList(removed)}`])].join(', and ');
    const state = (now.get(change.file) ?? []).map((text) => `${text}; `).join('');
    const [first] = change.before === null ? [] : differences(change.before, change.after);
    context.report({
      location: change.before === null || first === undefined ? { file: change.file } : { file: change.file, line: findingLine(change.file, first, change.before) },
      message:
        change.before === null
          ? `${change.file} does not exist; ${state}with ${DEFAULT_POLICY_NAME}, depcurfew apply would create it and ${what}`
          : `${change.file}: ${state}with ${DEFAULT_POLICY_NAME}, depcurfew apply would ${what}`,
      fix: `${INIT_FIRST}, then ${APPLY_NEXT}`,
    });
  }
}

export const configDrift: Rule = {
  id: 'config-drift',
  checks: 'Configuration files match what depcurfew apply writes for depcurfew.json',
  summary: 'A configuration file does not match what depcurfew apply writes for depcurfew.json.',
  description:
    'A generated setting was edited by hand, or depcurfew.json changed without depcurfew apply, so the tools enforce something other than the policy. Entries in a tool\'s own install-script lists that apply does not change are reported too: one that lets a package of installScripts.deny run its scripts is an error; one that lets a package the policy does not name run them, blocks a package the policy allows, or is not read by the version in use yet (Deno before 2.6.0) is a warning, as is an entry of config.policy.cooldown.ignore in composer.json that exempts a package cooldown.exclude does not, unless apply wrote it. What apply cannot write is an error where it says: the cooldown of Bundler in a Gemfile (a source with a block, a modifier or in other code, cooldown: twice, a URL from ENV, no rubygems.org source, a Gemfile depcurfew cannot read as Ruby does; a warning if that call waits as long as the policy), and a --no-binary or --only-binary=:none: of pip it cannot comment out.',
  help: 'Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const plan = plannedApply(context);
    if (plan === undefined) return;
    if (context.defaultPolicy === true) {
      reportAgainstDefault(context, plan);
      checkBundlerCooldown(context, plan);
      checkPipOptions(context, plan);
      checkCargoCooldown(context, plan);
      checkAllowLists(context, plan);
      checkComposerExclusions(context, plan);
      return;
    }
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
      // The lines a finding quotes show secrets as apply --dry-run does: as <redacted> (decision D-192).
      const before = redactText(change.file, change.before);
      const after = redactText(change.file, change.after);
      const all = reportedDifferences(before, after);
      // A file with hundreds of differences (500 Dependabot entries) gives MAX_DIFFERENCES findings, the last with the count.
      const shown = all.slice(0, MAX_DIFFERENCES);
      const rest = all.length - shown.length;
      for (const [index, difference] of shown.entries()) {
        const more = index === shown.length - 1 && rest > 0 ? `; ${rest} more ${rest === 1 ? 'place' : 'places'} in ${change.file} ${rest === 1 ? 'differs' : 'differ'} too (depcurfew apply --dry-run shows them)` : '';
        context.report({
          location: { file: change.file, line: findingLine(change.file, difference, before) },
          message: `${change.file} does not match ${POLICY_FILE}: ${describe(change.file, difference, before, after)}${more}`,
          fix: `Run depcurfew apply to bring ${change.file} back in line with ${POLICY_FILE} (depcurfew apply --dry-run shows the change first), or change ${POLICY_FILE} if the edit was intended`,
        });
      }
    }
    checkBundlerCooldown(context, plan);
    checkPipOptions(context, plan);
    checkCargoCooldown(context, plan);
    checkAllowLists(context, plan);
    checkComposerExclusions(context, plan);
  },
};

/**
 * The differences config-drift reports for a planned change, in order: every block of `differences` but those whose
 * lines the first one already names as commented out further down.
 */
function reportedDifferences(before: string, after: string): Difference[] {
  const [first, ...later] = differences(before, after);
  // The lines the first finding names as commented out further down are not reported again.
  const named = new Set(first?.commentedLater ?? []);
  // The lines themselves, without the comment apply puts before them: a set, so that thousands of commented lines
  // take linear time (decision D-121).
  const originals = new Set([...named].map((line) => line.slice(line.startsWith(SUPERSEDED) ? SUPERSEDED.length : TURNED_OFF.length).trim()));
  const repeats = (item: Difference) => item.added.some((text) => named.has(text)) && item.removed.every((text) => originals.has(text));
  return [first, ...later.filter((item) => !repeats(item))].filter((item): item is Difference => item !== undefined);
}

/**
 * Every place of a planned change that config-drift reports, as it words them, each with its line: for doctor --user,
 * whose user files drift the same way (decisions D-116 and D-122). At least one place.
 */
export function driftPlaces(file: string, original: string, planned: string): { line: number; text: string }[] {
  // With secrets as <redacted>, as config-drift quotes lines (decision D-192).
  const before = redactText(file, original);
  const after = redactText(file, planned);
  return reportedDifferences(before, after).map((difference) => ({ line: findingLine(file, difference, before), text: describe(file, difference, before, after) }));
}
