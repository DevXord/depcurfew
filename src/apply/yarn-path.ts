// The Yarn release yarnPath names as the version of the project (decision D-165): every Yarn from 1.18 runs it instead
// of itself, so it wins over packageManager. What apply and doctor say about it, with the packageManager pin it
// overrides when the two differ, and the command that replaces the release (yarn extra.setVersion).
import type { PackageManagerInfo, VersionDeclaration } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { listing } from './requirements.ts';
import { extraOf, isRecord } from './facts.ts';
import { compareVersions, parseVersion } from './version.ts';

export type Declared = VersionDeclaration & { version: string };

/** The declaration the pinned version comes from: the first exact one, as pinnedVersion takes it. */
export function pinnedDeclaration(manager: PackageManagerInfo): Declared | undefined {
  return manager.versions.find((entry): entry is Declared => 'version' in entry && parseVersion(entry.version) !== undefined);
}

/** The exact packageManager pins of another release than the one yarnPath names, which runs instead of them. */
export function overriddenPins(manager: PackageManagerInfo, yarnPath: Declared): Declared[] {
  const runs = parseVersion(yarnPath.version);
  if (yarnPath.source !== 'yarnPath' || runs === undefined) return [];
  return manager.versions.filter((entry): entry is Declared => {
    if (entry.source !== 'packageManager' || !('version' in entry)) return false;
    const pinned = parseVersion(entry.version);
    return pinned !== undefined && compareVersions(pinned, runs) !== 0;
  });
}

/** ", which runs instead of yarn@4.12.0 in packageManager", or nothing when no pin differs. */
export function insteadText(manager: PackageManagerInfo, yarnPath: Declared): string {
  const others = overriddenPins(manager, yarnPath);
  return others.length === 0 ? '' : `, which runs instead of ${listing(others.map((entry) => `${manager.id}@${entry.version} in ${entry.source}`))}`;
}

/** Where the pinned version comes from, for a message about it: "yarnPath in .yarnrc.yml, which runs instead of …". */
export function yarnPathNote(manager: PackageManagerInfo, declaration: Declared | undefined): string | undefined {
  if (declaration?.source !== 'yarnPath') return undefined;
  return `yarnPath in ${declaration.file}${insteadText(manager, declaration)}`;
}

interface SetVersion {
  command: string;
  releases: string;
}
const isSetVersion = (value: unknown): value is SetVersion => isRecord(value) && typeof value['command'] === 'string' && typeof value['releases'] === 'string';

/**
 * "Run yarn set version 4.14.0 (or a later release), which saves it in .yarn/releases, points yarnPath in .yarnrc.yml to
 * it and sets packageManager in package.json"; undefined without the fact.
 */
export function setVersionText(tool: ToolKnowledge, version: string, which: string, file: string): string | undefined {
  if (tool.extra?.['setVersion'] === undefined) return undefined;
  const fact = extraOf(tool, 'setVersion', isSetVersion);
  return `Run ${fact.command} ${version} (${which}), which saves it in ${fact.releases}, points yarnPath in ${file} to it and sets packageManager in package.json`;
}
