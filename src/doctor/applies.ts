// Whether a doctor rule concerns the project at all (decision D-098), from detection only, so that deciding reads no
// file the rules did not read. A rule that does not apply is shown as "not applicable" instead of "passed"; its check
// still runs, and a finding always wins. When in doubt a rule applies.
import type { BotId, PackageManagerId } from '../detect/types.ts';
import type { RuleScope } from './types.ts';

/** The project uses one of these package managers (any, when none is named) in a version the knowledge base covers. */
export function usesManager(scope: RuleScope, ids?: readonly PackageManagerId[]): boolean {
  // At the root of a repository of projects (decision D-100), the bots of the root serve the managers of every project.
  return [scope.detection, ...(scope.projects ?? []).map((project) => project.detection)].some((detection) =>
    detection.packageManagers.some((manager) => manager.supported && (ids === undefined || ids.includes(manager.id))),
  );
}

/** The project configures an update bot (any, when none is named). */
export function usesBot(scope: RuleScope, ids?: readonly BotId[]): boolean {
  return scope.detection.bots.some((bot) => ids === undefined || ids.includes(bot.id));
}

/** A package manager has a lockfile, or for pip requirements files, which say where packages come from too. */
export function hasLockfile(scope: RuleScope): boolean {
  return scope.detection.packageManagers.some(
    (manager) => manager.supported && (manager.evidence.some((evidence) => evidence.kind === 'lockfile') || (manager.id === 'pip' && manager.configFiles.length > 0)),
  );
}
