// Whether a doctor rule concerns the project at all (decision D-098), from detection only, so that deciding reads no
// file the rules did not read. A rule that does not apply is shown as "not applicable" instead of "passed"; its check
// still runs, and a finding always wins. When in doubt a rule applies.
import type { BotId, PackageManagerId } from '../detect/types.ts';
import type { ProjectView } from './types.ts';

/** The project uses one of these package managers (any, when none is named) in a version the knowledge base covers. */
export function usesManager(scope: ProjectView, ids?: readonly PackageManagerId[]): boolean {
  return scope.detection.packageManagers.some((manager) => manager.supported && (ids === undefined || ids.includes(manager.id)));
}

/** The project configures an update bot (any, when none is named). */
export function usesBot(scope: ProjectView, ids?: readonly BotId[]): boolean {
  return scope.detection.bots.some((bot) => ids === undefined || ids.includes(bot.id));
}

/** A package manager has a lockfile, or for pip requirements files, which say where packages come from too. */
export function hasLockfile(scope: ProjectView): boolean {
  return scope.detection.packageManagers.some(
    (manager) => manager.supported && (manager.evidence.some((evidence) => evidence.kind === 'lockfile') || (manager.id === 'pip' && manager.configFiles.length > 0)),
  );
}
