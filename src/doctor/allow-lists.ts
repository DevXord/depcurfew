// The install-script allow-lists written in each package manager's own format, read back as package names with
// the line that names them.
import { isRecord } from '../apply/facts.ts';
import type { PackageManagerId } from '../detect/types.ts';
import type { Repository } from '../detect/repository.ts';
import { jsonSetting, lineOf, yamlSetting } from './settings.ts';

export interface AllowEntry {
  name: string;
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
    .map(([name]) => ({ name, file, line: lineOf(text, JSON.stringify(name)) ?? lineOf(text, `${name}:`), setting }));
}

function fromList(text: string, file: string, setting: string, value: unknown, prefix = ''): AllowEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => ({ name: item.startsWith(prefix) ? item.slice(prefix.length) : item, file, line: lineOf(text, item), setting }));
}

/** Entries that let a package run its install scripts, per manager. Unreadable files give no entries. */
export function allowEntries(repository: Repository, manager: PackageManagerId, configFiles: readonly string[]): AllowEntry[] {
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
        entries.push(...fromKeys(workspace, 'pnpm-workspace.yaml', 'allowBuilds', yamlSetting(workspace, ['allowBuilds'])?.value, (entry) => entry === true));
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
  const expression = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*');
  return new RegExp(`^${expression}$`, 'u').test(name);
}
