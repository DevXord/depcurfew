// The install-script allow-lists written in each package manager's own format, read back as package names with
// the line that names them, and the entries that block a package's scripts on purpose (installScripts.deny).
import { extraOf, isRecord, sinceOf, yamlOptionsFor } from '../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, type Version } from '../apply/version.ts';
import { pnpmOwner, readPnpmIncludes } from '../apply/pnpm-includes.ts';
import type { PackageManagerId } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { wildcardMatch } from '../detect/wildcard.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { composerPolicyName, keyCoveredBy, matchesEveryComposerName } from './composer.ts';
import { splitSpec } from './lockfiles.ts';
import { jsonSetting, lineOf, yamlSetting } from './settings.ts';

/** Where the lists are read from: the repository, or the files as depcurfew apply would leave them. */
export interface TextSource {
  /** The file's text, or undefined when it is missing or cannot be read. */
  readText(file: string): string | undefined;
}

export interface AllowEntry {
  /** As written, possibly with a version (esbuild@0.25.0, which npm install-scripts approve writes). */
  name: string;
  /** The package it names, without a version. */
  package: string;
  file: string;
  line: number | undefined;
  /** The setting as written, e.g. "allowBuilds" or "dependenciesMeta". */
  setting: string;
  /**
   * The package as depcurfew.json names it, where its registry takes a prefix there (composer:vendor/name in lower
   * case); absent for a Composer key the policy cannot name (a key that matches every plugin, a name that is no
   * vendor/name).
   */
  policyName?: string;
  /**
   * A key of Composer's allow-plugins: Composer matches it without regard to case and its * stands for any characters
   * (BasePackage::packageNameToRegexp), so it is compared with the policy as keyCoveredBy does (decision D-134).
   */
  composerKey?: true;
}

/** The package of an entry as depcurfew.json writes it. */
export function policyName(entry: AllowEntry): string {
  return entry.policyName ?? entry.package;
}

/** Whether the policy's patterns cover an entry: as the tool matches the entry (Composer keys), else by its package. */
function covers(entry: AllowEntry, patterns: readonly string[]): boolean {
  return entry.composerKey === true ? keyCoveredBy(entry.name, patterns) : patterns.some((pattern) => matchesPattern(entry.package, pattern));
}

/**
 * The version in use when it does not read the tool's install-script allow-list yet (Deno before 2.6.0 has no
 * allowScripts in deno.json, decision D-173): an entry there then lets no package run its scripts, though a later
 * version would. undefined when the version reads it or is not known.
 */
export interface UnreadList {
  tool: string;
  version: string;
  since: string;
}

export function unreadAllowList(tool: ToolKnowledge | undefined, version: Version | undefined): UnreadList | undefined {
  const since = tool === undefined ? undefined : sinceOf(tool.installScripts.allowList.availableSince);
  const required = since === undefined ? undefined : parseVersion(since);
  if (tool === undefined || since === undefined || required === undefined || version === undefined || compareVersions(version, required) >= 0) return undefined;
  return { tool: tool.name, version: formatVersion(version), since };
}

/** "Deno 2.5.6 does not read allowScripts (added in 2.6.0), so it runs no install scripts of sharp now, but …". */
function unreadText(entry: AllowEntry, unread: UnreadList): string {
  return `${unread.tool} ${unread.version} does not read ${entry.setting} (added in ${unread.since}), so it runs no install scripts of ${entry.name} now, but ${unread.tool} ${unread.since} and later would let it run them`;
}

/**
 * What is wrong with an entry that lets a package the policy does not list run its install scripts, and what to do:
 * for apply (allow-list-entry-outside-policy, `apply` true: with the line, and the entry removed by hand) and doctor
 * (config-drift). A Composer key that matches every plugin, or one the policy cannot name, is not offered for
 * installScripts.allow, since the policy rejects such a name.
 */
export function outsideConflictText(entry: AllowEntry, apply = false, unread?: UnreadList): { message: string; fix: string } {
  const where = `${entry.setting} in ${entry.file}${apply && entry.line !== undefined ? ` (line ${entry.line})` : ''}`;
  if (entry.composerKey === true && (matchesEveryComposerName(entry.name) || entry.policyName === undefined)) {
    const every = matchesEveryComposerName(entry.name);
    return {
      message: `${where} has ${JSON.stringify(entry.name)}: true, which lets ${every ? 'every plugin that no earlier key names' : 'the plugins it matches'} run, but ${POLICY_FILE} does not allow ${every ? 'them' : 'them all'}`,
      fix: `Remove ${JSON.stringify(entry.name)} from ${entry.setting} in ${entry.file} by hand and list the plugins that may run in installScripts.allow in ${POLICY_FILE} (with the prefix composer:), then run depcurfew apply`,
    };
  }
  if (entry.composerKey === true) {
    // A Composer plugin runs as a whole; it has no install scripts (decision D-141).
    const what = entry.name.includes('*') ? `every plugin that ${entry.name} matches` : `the Composer plugin ${entry.name}`;
    return {
      message: `${where} lets ${what} run, but ${POLICY_FILE} does not allow ${entry.name.includes('*') ? 'them' : 'it'}`,
      fix: `Remove ${JSON.stringify(entry.name)} from ${entry.setting} in ${entry.file}${apply ? ' by hand' : ''}, or add ${policyName(entry)} to installScripts.allow in ${POLICY_FILE}`,
    };
  }
  return {
    message: unread === undefined ? `${where} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it` : `${where} lists ${entry.name}, which ${POLICY_FILE} does not allow; ${unreadText(entry, unread)}`,
    fix: apply
      ? `Remove ${entry.name} from ${entry.setting} by hand, or add ${policyName(entry)} to installScripts.allow in ${POLICY_FILE}`
      : `Remove ${entry.name} from ${entry.setting}, or add ${entry.policyName ?? (entry.name === entry.package ? 'it' : entry.package)} to installScripts.allow in ${POLICY_FILE}`,
  };
}

function read(repository: TextSource, file: string): string | undefined {
  return repository.readText(file);
}

/** The line of a key or list item below `path` in a JSON file; undefined for other files. */
function jsonLine(text: string, file: string, path: readonly string[]): (key: string | number) => number | undefined {
  return (key) => (/\.json[c5]?$/u.test(file) ? jsonSetting(text, [...path, key])?.line : undefined);
}

function fromKeys(text: string, file: string, setting: string, value: unknown, enabled: (entry: unknown) => boolean, locate?: (key: string) => number | undefined): AllowEntry[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => enabled(entry))
    .map(([name]) => ({ name, package: splitSpec(name).name, file, line: locate?.(name) ?? lineOf(text, JSON.stringify(name)) ?? lineOf(text, `${name}:`), setting }));
}

function fromList(text: string, file: string, setting: string, value: unknown, prefix = '', locate?: (index: number) => number | undefined): AllowEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((item, index) => {
    if (typeof item !== 'string') return [];
    const name = item.startsWith(prefix) ? item.slice(prefix.length) : item;
    return [{ name, package: splitSpec(name).name, file, line: locate?.(index) ?? lineOf(text, item), setting }];
  });
}

const isPermissions = (value: unknown): value is { setting: string; capability: string; since: string; allow: unknown; deny: unknown } =>
  isRecord(value) && typeof value['setting'] === 'string' && typeof value['capability'] === 'string' && typeof value['since'] === 'string';

/**
 * pnpm 12.11+: permissions.<package>.build (extra.buildPermissions), which outranks the package's allowBuilds entry.
 * The decisions by package key, or undefined for a version without it or a tool without the fact.
 */
function buildPermissions(text: string, tool: ToolKnowledge | undefined, version: Version | undefined): Map<string, { allowed: boolean; line: number }> | undefined {
  if (tool?.extra?.['buildPermissions'] === undefined) return undefined;
  const fact = extraOf(tool, 'buildPermissions', isPermissions);
  const since = parseVersion(fact.since);
  if (version !== undefined && since !== undefined && compareVersions(version, since) < 0) return undefined;
  const yaml = yamlOptionsFor('pnpm-workspace.yaml');
  const permissions = yamlSetting(text, [fact.setting], yaml);
  const decisions = new Map<string, { allowed: boolean; line: number }>();
  if (permissions === undefined || !isRecord(permissions.value)) return decisions;
  for (const [name, entry] of Object.entries(permissions.value)) {
    const decision = isRecord(entry) ? entry[fact.capability] : undefined;
    if (decision !== fact.allow && decision !== fact.deny) continue;
    decisions.set(name, { allowed: decision === fact.allow, line: yamlSetting(text, [fact.setting, name, fact.capability], yaml)?.line ?? permissions.line });
  }
  return decisions;
}

export interface ListOptions {
  tool?: ToolKnowledge;
  version?: Version;
}

/**
 * The entries of one kind in each manager's own lists: `allowed` true for the entries that let a package run its install
 * scripts, false for those that block them on purpose.
 */
function listEntries(repository: TextSource, manager: PackageManagerId, configFiles: readonly string[], options: ListOptions, allowed: boolean): AllowEntry[] {
  const manifest = read(repository, 'package.json');
  const entries: AllowEntry[] = [];
  const json = (path: string[]) => (manifest === undefined ? undefined : jsonSetting(manifest, path)?.value);
  const fromManifestKeys = (setting: string, enabled: (entry: unknown) => boolean) =>
    manifest === undefined ? [] : fromKeys(manifest, 'package.json', setting, json([setting]), enabled, jsonLine(manifest, 'package.json', [setting]));
  switch (manager) {
    case 'npm':
      entries.push(...fromManifestKeys('allowScripts', (entry) => entry === allowed));
      break;
    case 'pnpm': {
      // pnpm 12.15+ reads allowBuilds (and permissions, which shares its owner) from the file include gives it to; a
      // config dependency's list cannot be read (decision D-164).
      const includes = options.tool === undefined ? undefined : readPnpmIncludes(options.tool, options.version, (file) => read(repository, file));
      const owner = pnpmOwner(includes, 'allowBuilds');
      const file = owner.kind === 'file' ? owner.file : undefined;
      const workspace = file === undefined ? undefined : read(repository, file);
      const yaml = yamlOptionsFor('pnpm-workspace.yaml');
      if (workspace !== undefined && file !== undefined) {
        const permissions = buildPermissions(workspace, options.tool, options.version);
        // A permissions entry outranks the allowBuilds entry of the same package.
        const allowBuilds = fromKeys(workspace, file, 'allowBuilds', yamlSetting(workspace, ['allowBuilds'], yaml)?.value, (entry) => entry === allowed, (name) =>
          yamlSetting(workspace, ['allowBuilds', name], yaml)?.line,
        );
        entries.push(...allowBuilds.filter((entry) => permissions?.has(entry.name) !== true));
        for (const [name, decision] of permissions ?? []) {
          if (decision.allowed === allowed) entries.push({ name, package: splitSpec(name).name, file, line: decision.line, setting: 'permissions' });
        }
      }
      // ignoredBuiltDependencies only silences pnpm's report about a skipped build, so it neither allows nor blocks.
      const legacy = pnpmOwner(includes, 'onlyBuiltDependencies');
      const legacyText = legacy.kind === 'file' ? read(repository, legacy.file) : undefined;
      if (allowed && legacy.kind === 'file' && legacyText !== undefined) entries.push(...fromList(legacyText, legacy.file, 'onlyBuiltDependencies', yamlSetting(legacyText, ['onlyBuiltDependencies'], yaml)?.value));
      if (allowed && manifest !== undefined) {
        entries.push(...fromList(manifest, 'package.json', 'pnpm.onlyBuiltDependencies', json(['pnpm', 'onlyBuiltDependencies']), '', jsonLine(manifest, 'package.json', ['pnpm', 'onlyBuiltDependencies'])));
      }
      break;
    }
    case 'yarn':
      entries.push(...fromManifestKeys('dependenciesMeta', (entry) => isRecord(entry) && entry['built'] === allowed));
      break;
    case 'bun':
      if (allowed && manifest !== undefined) entries.push(...fromList(manifest, 'package.json', 'trustedDependencies', json(['trustedDependencies']), '', jsonLine(manifest, 'package.json', ['trustedDependencies'])));
      break;
    case 'deno':
      for (const file of configFiles.filter((name) => /^deno\.jsonc?$/u.test(name))) {
        const text = read(repository, file);
        if (text === undefined) continue;
        const value = jsonSetting(text, ['allowScripts'])?.value;
        if (allowed) entries.push(...fromList(text, file, 'allowScripts', isRecord(value) ? value['allow'] : value, 'npm:', jsonLine(text, file, isRecord(value) ? ['allowScripts', 'allow'] : ['allowScripts'])));
        else if (isRecord(value)) entries.push(...fromList(text, file, 'allowScripts.deny', value['deny'], 'npm:', jsonLine(text, file, ['allowScripts', 'deny'])));
      }
      break;
    case 'composer': {
      // config.allow-plugins: Composer allows a plugin only with true (PluginManager::isPluginAllowed); its keys may be
      // patterns, matched without regard to case. true for the whole setting allows every plugin, which stands here as
      // the pattern *.
      const text = read(repository, 'composer.json');
      if (text === undefined) break;
      const found = jsonSetting(text, ['config', 'allow-plugins']);
      const keys: AllowEntry[] = [];
      // Named as the other Composer messages name it, config.allow-plugins (decision D-141).
      if (found?.value === true && allowed) keys.push({ name: '*', package: '*', file: 'composer.json', line: found.line, setting: 'config.allow-plugins' });
      keys.push(...fromKeys(text, 'composer.json', 'config.allow-plugins', found?.value, (entry) => (entry === true) === allowed, jsonLine(text, 'composer.json', ['config', 'allow-plugins'])));
      for (const entry of keys) {
        const name = composerPolicyName(entry.name);
        entries.push({ ...entry, package: entry.name.toLowerCase(), composerKey: true, ...(name === undefined || matchesEveryComposerName(entry.name) ? {} : { policyName: name }) });
      }
      break;
    }
  }
  return entries;
}

/**
 * Entries that let a package run its install scripts, per manager. Unreadable files give no entries. `tool` and
 * `version` decide settings that depend on the version, such as pnpm's permissions (the latest known version when
 * none is given).
 */
export function allowEntries(repository: TextSource, manager: PackageManagerId, configFiles: readonly string[], options: ListOptions = {}): AllowEntry[] {
  return listEntries(repository, manager, configFiles, options, true);
}

/**
 * Entries that block a package's install scripts on purpose, per manager: false in npm's allowScripts and pnpm's
 * allowBuilds (or build: false in pnpm's permissions), built: false in Yarn's dependenciesMeta, allowScripts.deny in
 * deno.json. Bun has none.
 */
export function denyEntries(repository: TextSource, manager: PackageManagerId, configFiles: readonly string[], options: ListOptions = {}): AllowEntry[] {
  return listEntries(repository, manager, configFiles, options, false);
}

/**
 * An entry of a tool's own list that the policy does not agree with: `denied`, it lets a package of installScripts.deny
 * run its scripts; `allowed`, it blocks a package of installScripts.allow; `outside`, it lets a package the policy does
 * not list run them.
 */
export interface ListConflict {
  kind: 'denied' | 'allowed' | 'outside';
  entry: AllowEntry;
}

/** The entries of a tool's own lists that contradict installScripts (the policy of the tool's registry). */
export function listConflicts(
  repository: TextSource,
  manager: PackageManagerId,
  configFiles: readonly string[],
  options: ListOptions,
  scripts: { allow: readonly string[]; deny: readonly string[] },
): ListConflict[] {
  const conflicts: ListConflict[] = [];
  for (const entry of allowEntries(repository, manager, configFiles, options)) {
    if (covers(entry, scripts.allow)) continue;
    conflicts.push({ kind: covers(entry, scripts.deny) ? 'denied' : 'outside', entry });
  }
  for (const entry of denyEntries(repository, manager, configFiles, options)) {
    if (covers(entry, scripts.allow)) conflicts.push({ kind: 'allowed', entry });
  }
  return conflicts;
}

/**
 * The conflicts in the files as they are (`now`) that remain once depcurfew apply has written the policy (`planned`):
 * apply writes the entries of the policy's own packages, so only the others stay.
 */
export function remainingConflicts(
  now: TextSource,
  planned: TextSource,
  manager: PackageManagerId,
  configFiles: readonly string[],
  options: ListOptions,
  scripts: { allow: readonly string[]; deny: readonly string[] },
): ListConflict[] {
  const key = (conflict: ListConflict) => [conflict.kind, conflict.entry.file, conflict.entry.setting, conflict.entry.name].join('\u0000');
  const after = new Set(listConflicts(planned, manager, configFiles, options, scripts).map(key));
  return listConflicts(now, manager, configFiles, options, scripts).filter((conflict) => after.has(key(conflict)));
}

/**
 * What is wrong with an entry that contradicts installScripts.allow or installScripts.deny, and what to do: the same in
 * apply (deny-conflicts-with-file) and doctor (config-drift). `line` puts the line into the message, for apply's text.
 */
export function denyConflictText(conflict: ListConflict & { kind: 'denied' | 'allowed' }, line = false, unread?: UnreadList): { message: string; fix: string } {
  const { entry } = conflict;
  const where = `${entry.setting} in ${entry.file}${line && entry.line !== undefined ? ` (line ${entry.line})` : ''}`;
  if (entry.composerKey === true) {
    // A Composer plugin runs as a whole; it has no install scripts (decision D-141).
    const plugin = entry.name.includes('*') ? `every plugin that ${entry.name} matches` : `the Composer plugin ${entry.name}`;
    return conflict.kind === 'denied'
      ? {
          message: `${where} lets ${plugin} run, although installScripts.deny in ${POLICY_FILE} denies ${entry.name.includes('*') ? 'them' : 'it'}`,
          fix: `Remove ${JSON.stringify(entry.name)} from ${entry.setting} in ${entry.file}, or move ${policyName(entry)} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing the plugin`,
        }
      : {
          message: `${where} blocks ${plugin}, but installScripts.allow in ${POLICY_FILE} allows ${entry.name.includes('*') ? 'them' : 'it'}`,
          fix: `Remove ${JSON.stringify(entry.name)} from ${entry.setting} in ${entry.file}, or move ${policyName(entry)} from installScripts.allow to installScripts.deny in ${POLICY_FILE} if the project works without it`,
        };
  }
  if (conflict.kind === 'denied') {
    return {
      message:
        unread === undefined
          ? `${where} lets ${entry.name} run its install scripts, although installScripts.deny in ${POLICY_FILE} says they must not run`
          : `${where} lists ${entry.name}, which installScripts.deny in ${POLICY_FILE} denies; ${unreadText(entry, unread)}`,
      fix: `Remove ${entry.name} from ${entry.setting} in ${entry.file}, or move ${policyName(entry)} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing its scripts`,
    };
  }
  return {
    message: `${where} blocks the install scripts of ${entry.name}, but installScripts.allow in ${POLICY_FILE} allows them`,
    fix: `Remove ${entry.name} from ${entry.setting} in ${entry.file}, or move ${policyName(entry)} from installScripts.allow to installScripts.deny in ${POLICY_FILE} if it works without its scripts`,
  };
}

/** Whether a package name matches a policy pattern; `*` stands for any characters except `/`. */
export function matchesPattern(name: string, pattern: string): boolean {
  return wildcardMatch(name, pattern);
}
