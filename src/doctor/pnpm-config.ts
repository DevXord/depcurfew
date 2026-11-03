// Where doctor reads a pnpm setting (decision D-164): pnpm 12.15+ takes it from the file include in pnpm-workspace.yaml
// gives it to, and a setting a config dependency owns cannot be read at all. The index is read once per repository
// and version, as the rules read the same files.
import { mergesYamlKeys, values } from '../apply/facts.ts';
import { pnpmOwner, readPnpmIncludes, type PnpmIncludes, type PnpmOwner } from '../apply/pnpm-includes.ts';
import { formatVersion, pinnedVersion, type Version } from '../apply/version.ts';
import type { Repository } from '../detect/repository.ts';
import type { Detection, PackageManagerInfo } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { latestVersion } from './effective.ts';
import { readSetting, type Setting } from './settings.ts';

const CACHE = new WeakMap<Repository, Map<string, PnpmIncludes | undefined>>();

/** The include index of the repository for a pnpm version (undefined: the latest known). */
export function repositoryIncludes(repository: Repository, tool: ToolKnowledge, version: Version | undefined): PnpmIncludes | undefined {
  let known = CACHE.get(repository);
  if (known === undefined) {
    known = new Map();
    CACHE.set(repository, known);
  }
  const key = version === undefined ? '' : formatVersion(version);
  if (!known.has(key)) known.set(key, readPnpmIncludes(tool, version, (file) => repository.readText(file)));
  return known.get(key);
}

/** pnpm as doctor checks it: the detected manager, its knowledge and the pinned version, else the latest known. */
export function pnpmOf(detection: Detection, tools: readonly ToolKnowledge[]): { manager: PackageManagerInfo; tool: ToolKnowledge; version: Version | undefined } | undefined {
  const manager = detection.packageManagers.find((entry) => entry.id === 'pnpm' && entry.supported);
  const tool = tools.find((entry) => entry.id === 'pnpm');
  return manager === undefined || tool === undefined ? undefined : { manager, tool, version: pinnedVersion(manager) ?? latestVersion(tool) };
}

/** The root manifest of pnpm, whose settings include may give to other files. */
function manifestOf(tool: ToolKnowledge): string {
  return values(tool.cooldown.configFiles)[0]?.[0] ?? 'pnpm-workspace.yaml';
}

/** Where pnpm takes `setting` from, for a file doctor would read it in; the file itself for every other tool and file. */
export function settingOwner(repository: Repository, tool: ToolKnowledge, version: Version | undefined, file: string, setting: string): PnpmOwner {
  if (tool.id !== 'pnpm' || file !== manifestOf(tool)) return { kind: 'file', file };
  return pnpmOwner(repositoryIncludes(repository, tool, version), setting, file);
}

/**
 * A setting of a tool's configuration file as the tool reads it: readSetting, except that pnpm 12.15+ takes a setting
 * of pnpm-workspace.yaml from the file include gives it to, read with merge keys as pnpm reads it; undefined when a
 * config dependency or a file outside the directory owns it. The version is the one doctor checks pnpm against.
 */
export function readRuleSetting(context: { repository: Repository; detection: Detection; tools: readonly ToolKnowledge[] }, tool: ToolKnowledge, file: string, setting: string): Setting | undefined {
  const version = tool.id === 'pnpm' ? pnpmOf(context.detection, context.tools)?.version : undefined;
  return readToolSetting(context.repository, tool, version, file, setting);
}

/** readToolSetting with the version of the tool given. */
export function readToolSetting(repository: Repository, tool: ToolKnowledge, version: Version | undefined, file: string, setting: string): Setting | undefined {
  const owner = settingOwner(repository, tool, version, file, setting.split('.')[0] ?? setting);
  if (owner.kind !== 'file') return undefined;
  return owner.file === file ? readSetting(repository, file, setting) : readSetting(repository, owner.file, setting, { merge: mergesYamlKeys(tool) });
}
