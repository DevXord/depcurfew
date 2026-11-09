// What to do about a file depcurfew could not read, by the code of the repository warning: the fix of unreadable-config
// in doctor, and of the file-unreadable warning of apply.
import { sinceOf } from '../apply/facts.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { MAX_WORKSPACE_DIRECTORIES } from '../detect/workspaces.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { yarn } from '../knowledge/yarn.ts';
import { MAX_LOCKFILE_SIZE, MAX_YAML_LOCKFILE_SIZE } from './lockfiles.ts';

/**
 * What to do about Yarn Classic, which depcurfew does not configure: move to the first Yarn with the release-age delay
 * (cooldown.availableSince of Yarn). One text for explain, apply and doctor (decision D-170).
 */
export function yarnClassicFix(berry: ToolKnowledge = yarn): string {
  const since = sinceOf(berry.cooldown.availableSince);
  return `Move to ${berry.name}${since === undefined ? '' : ` ${since} or later`}, or to another package manager depcurfew configures`;
}

/** Repository warnings that mean a file was not checked. */
export const UNREADABLE_WARNINGS: Readonly<Record<string, string>> = {
  'invalid-file': 'Fix the syntax error, so that depcurfew can check the file',
  'unreadable-file': 'Make the file readable for the user that runs depcurfew, so that depcurfew can check it',
  'file-too-large': 'Make the file smaller than the limit, or check its settings by hand',
  'lockfile-too-large': `Check where the packages in the lockfile come from and which have install scripts by hand; depcurfew reads YAML lockfiles up to ${MAX_YAML_LOCKFILE_SIZE / (1024 * 1024)} MiB and JSON lockfiles up to ${MAX_LOCKFILE_SIZE / (1024 * 1024)} MiB`,
  'outside-repository': 'Replace the symlink with a regular file inside the repository',
  'not-a-regular-file': 'Replace it with a regular file, or remove it; npm and pnpm read .npmrc as a file',
  'workspace-outside-repository': 'Keep workspace packages inside the repository',
  'unreadable-include': 'Keep the included files in the repository and refer to them by a relative path, so that depcurfew can check them',
  'too-many-includes': 'Include fewer requirements files, or the same ones fewer times, so that depcurfew can follow them all; until then check the rest by hand',
};

/**
 * What to do about each warning of detection, by its code: the fixes above for files that could not be read, and the
 * others. One source for the warnings of explain and the notices of doctor (decision D-116).
 */
export const WARNING_FIXES: Readonly<Record<string, string>> = {
  ...UNREADABLE_WARNINGS,
  'nothing-detected': `Run depcurfew explain in the directory of the project, or list the directories of the projects under projects in ${POLICY_FILE}`,
  'invalid-package-manager': 'Write packageManager in package.json as name@version, with a package manager depcurfew knows',
  'package-manager-assumed': 'Commit the lockfile, or name the package manager and its version in packageManager in package.json',
  'yarn-classic-unsupported': yarnClassicFix(),
  'renovate-config-in-package-json': 'Move the renovate key of package.json to renovate.json',
  'multiple-lockfiles': 'Remove the lockfiles of the package managers the project does not use',
  'package-manager-mismatch': 'Commit the lockfile of the package manager that packageManager in package.json names, or correct packageManager',
  'python-tool-unknown': `Commit the lockfile of the tool that installs the project, or name the tool in targets in ${POLICY_FILE}`,
  'script-not-followed': 'Split the script into shorter run steps or RUN instructions, or check by hand where the installs after that point run and with which variables',
  'pnpm-hook': 'Read the pnpmfile and make sure its updateConfig hook leaves the security settings as they are; set pnpmfile: [] in pnpm-workspace.yaml when the project needs no pnpmfile, and remove config-dependency plugins it does not need (depcurfew doctor reports each one as pnpm-config-unverifiable)',
  'workspace-search-limit':`Narrow the workspace patterns (for example packages/* instead of **), so that they match at most ${MAX_WORKSPACE_DIRECTORIES} directories and depcurfew finds every workspace package`,
};

/**
 * Warnings of detection that doctor shows as notices: what detection could not follow, so the rules did not check it
 * (decision D-121), such as a script it stopped following or workspace patterns it stopped matching (decision D-161).
 * The others are about what explain and apply configure.
 */
export const DETECTION_NOTICES: ReadonlySet<string> = new Set(['script-not-followed', 'workspace-search-limit']);
