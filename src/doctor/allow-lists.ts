// The install-script allow-lists written in each package manager's own format, read back as package names with
// the line that names them.
import { extraOf, isRecord } from '../apply/facts.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';
import type { PackageManagerId } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import type { Repository } from '../detect/repository.ts';
import { wildcardMatch } from '../detect/wildcard.ts';
import { splitSpec } from './lockfiles.ts';
import { jsonSetting, lineOf, yamlSetting } from './settings.ts';

export interface AllowEntry {
  /** As written, possibly with a version (esbuild@0.25.0, which npm install-scripts approve writes). */
  name: string;
  /** The package it names, without a version. */
  package: string;
  file: string;
  line: number | undefined;
  /** The setting as written, e.g. "allowBuilds" or "dependenciesMeta". */
  setting: string;
}

function read(repository: Repository, file: string): string | undefined {
  return repository.readText(file);
}

function fromKeys(text: string, file: string, setting: string, value: unknown, enabled: (entry: unknown) => boolean): AllowEntry[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => enabled(entry))
    .map(([name]) => ({ name, package: splitSpec(name).name, file, line: lineOf(text, JSON.stringify(name)) ?? lineOf(text, `${name}:`), setting }));
}

function fromList(text: string, file: string, setting: string, value: unknown, prefix = ''): AllowEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => {
      const name = item.startsWith(prefix) ? item.slice(prefix.length) : item;
      return { name, package: splitSpec(name).name, file, line: lineOf(text, item), setting };
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
  const permissions = yamlSetting(text, [fact.setting]);
  const decisions = new Map<string, { allowed: boolean; line: number }>();
  if (permissions === undefined || !isRecord(permissions.value)) return decisions;
  for (const [name, entry] of Object.entries(permissions.value)) {
    const decision = isRecord(entry) ? entry[fact.capability] : undefined;
    if (decision !== fact.allow && decision !== fact.deny) continue;
    decisions.set(name, { allowed: decision === fact.allow, line: yamlSetting(text, [fact.setting, name, fact.capability])?.line ?? permissions.line });
  }
  return decisions;
}

/**
 * Entries that let a package run its install scripts, per manager. Unreadable files give no entries. `tool` and
 * `version` decide settings that depend on the version, such as pnpm's permissions (the latest known version when
 * none is given).
 */
export function allowEntries(
  repository: Repository,
  manager: PackageManagerId,
  configFiles: readonly string[],
  options: { tool?: ToolKnowledge; version?: Version } = {},
): AllowEntry[] {
  const manifest = read(repository, 'package.json');
  const entries: AllowEntry[] = [];
  const json = (path: string[]) => (manifest === undefined ? undefined : jsonSetting(manifest, path)?.value);
  switch (manager) {
    case 'npm':
      if (manifest !== undefined) entries.push(...fromKeys(manifest, 'package.json', 'allowScripts', json(['allowScripts']), (entry) => entry === true));
      break;
    case 'pnpm': {
      const workspace = read(repository, 'pnpm-workspace.yaml');
      if (workspace !== undefined) {
        const permissions = buildPermissions(workspace, options.tool, options.version);
        // A permissions entry outranks the allowBuilds entry of the same package.
        const allowBuilds = fromKeys(workspace, 'pnpm-workspace.yaml', 'allowBuilds', yamlSetting(workspace, ['allowBuilds'])?.value, (entry) => entry === true);
        entries.push(...allowBuilds.filter((entry) => permissions?.has(entry.name) !== true));
        for (const [name, decision] of permissions ?? []) {
          if (decision.allowed) entries.push({ name, package: splitSpec(name).name, file: 'pnpm-workspace.yaml', line: decision.line, setting: 'permissions' });
        }
        entries.push(...fromList(workspace, 'pnpm-workspace.yaml', 'onlyBuiltDependencies', yamlSetting(workspace, ['onlyBuiltDependencies'])?.value));
      }
      if (manifest !== undefined) entries.push(...fromList(manifest, 'package.json', 'pnpm.onlyBuiltDependencies', json(['pnpm', 'onlyBuiltDependencies'])));
      break;
    }
    case 'yarn':
      if (manifest !== undefined) {
        entries.push(...fromKeys(manifest, 'package.json', 'dependenciesMeta', json(['dependenciesMeta']), (entry) => isRecord(entry) && entry['built'] === true));
      }
      break;
    case 'bun':
      if (manifest !== undefined) entries.push(...fromList(manifest, 'package.json', 'trustedDependencies', json(['trustedDependencies'])));
      break;
    case 'deno':
      for (const file of configFiles.filter((name) => /^deno\.jsonc?$/u.test(name))) {
        const text = read(repository, file);
        if (text === undefined) continue;
        const value = jsonSetting(text, ['allowScripts'])?.value;
        entries.push(...fromList(text, file, 'allowScripts', isRecord(value) ? value['allow'] : value, 'npm:'));
      }
      break;
  }
  return entries;
}

/** Whether a package name matches a policy pattern; `*` stands for any characters except `/`. */
export function matchesPattern(name: string, pattern: string): boolean {
  return wildcardMatch(name, pattern);
}
