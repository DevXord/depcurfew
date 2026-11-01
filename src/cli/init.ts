import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homeProblem, ownerOfNewUnderHome } from '../user/home.ts';
import { shownPath, type UserEnvironment } from '../user/locate.ts';
import { userPolicyPath } from '../user/policy-path.ts';
import { describeDelay, longestDelay, policyDuration, type ConfiguredDelay } from '../apply/delays.ts';
import { longestUserDelay } from '../user/delays.ts';
import { fileSystemReason, writeChanges } from '../apply/workspace.ts';
import { detectProject } from '../detect/index.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import { autoTargets } from '../apply/targets.ts';
import { listing } from '../apply/requirements.ts';
import { inProject } from '../apply/projects.ts';
import { detectedNames, toolName } from './describe.ts';
import { proposedProjects } from './init-projects.ts';
import { reportInputError, resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';

/** Whether a tool installs PyPI packages, by its ecosystem in the knowledge base. */
function isPythonTool(id: string): boolean {
  const tool = knowledgeBase.find((entry) => entry.id === id);
  return tool !== undefined && ecosystemOfTool(tool) === 'pypi';
}

/** A file system error without the path, e.g. "EACCES: permission denied". */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && message.startsWith(`${code}: `) ? (message.split(',', 1)[0] ?? message) : message;
}

/** The nearest existing directory above `path` when it is not a directory (a regular file in the way); else undefined. */
function blockingFile(path: string): string | undefined {
  for (let current = dirname(path); ; current = dirname(current)) {
    let stats;
    try {
      stats = statSync(current, { throwIfNoEntry: false });
    } catch (error) {
      // ENOTDIR: a part above is the file in the way; anything else (EACCES) is reported by the caller.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') return undefined;
    }
    if (stats !== undefined) return stats.isDirectory() ? undefined : current;
    if (dirname(current) === current) return undefined;
  }
}

/** The default policy, with the longest delay `longest` finds above the default minimum as cooldown.minimum. */
function keepLongest(longest: (minutes: number) => ConfiguredDelay | undefined): { kept: ConfiguredDelay | undefined; minimum: string; text: string } {
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  const kept = defaultMinimum.ok ? longest(defaultMinimum.duration.minutes) : undefined;
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  return { kept, minimum, text: renderPolicy({ ...DEFAULT_POLICY, cooldown: { ...DEFAULT_POLICY.cooldown, minimum } }) };
}

/** Where the delay that init keeps is set: setting, value, file and line. */
const keptMessage = (kept: ConfiguredDelay, minimum: string): string =>
  `cooldown.minimum is ${minimum} instead of ${DEFAULT_POLICY.cooldown.minimum}, to keep the longest release-age delay already set: ${describeDelay(kept)}.\n`;

/**
 * init --user: the default policy as the user policy, in a directory that is created when missing; not without a home
 * directory (home-missing, as apply --user). A longer release-age delay that the user files of the installed tools set
 * becomes cooldown.minimum (decision D-101). Run by root in the home directory of another user, what it creates there
 * belongs to that user (decision D-093).
 */
export function initUser(force: boolean, environment: UserEnvironment, io: CliIo): number {
  const home = homeProblem(environment, 'init');
  if (home !== undefined) {
    reportInputError({ ...home, level: 'error' }, io);
    return EXIT_FAILURE;
  }
  const target = userPolicyPath(environment);
  const shown = shownPath(target, environment);
  const fail = (code: ApplyErrorCode, message: string, fix: string): number => {
    reportInputError({ code, level: 'error', location: { file: shown }, message, fix }, io);
    return EXIT_FAILURE;
  };
  const blocked = (): number | undefined => {
    const file = blockingFile(target);
    if (file === undefined) return undefined;
    const name = shownPath(file, environment);
    return fail('cannot-write', `${name} is not a directory, so depcurfew init --user cannot create ${shown}`, `Move the file ${name} out of the way, then run depcurfew init --user again`);
  };
  let existing;
  try {
    existing = lstatSync(target, { throwIfNoEntry: false });
  } catch (error) {
    return (
      blocked() ??
      fail('cannot-write', `cannot look at ${shown}: ${fileSystemReason(error)}`, `Make sure the user running depcurfew may open the directories on the way to ${shown}, then run depcurfew init --user again`)
    );
  }
  // Windows reports a path through a file as missing.
  const blocker = existing === undefined ? blocked() : undefined;
  if (blocker !== undefined) return blocker;
  if (existing?.isDirectory() === true) return fail('cannot-write', `${shown} is a directory, not a file`, `Remove or rename the directory ${shown}, then run depcurfew init --user again`);
  if (existing !== undefined && !force) return fail('policy-exists', `${shown} already exists`, 'Pass --force to overwrite it with the default policy, or edit it by hand');
  if (existing?.isSymbolicLink() === true) return fail('cannot-write', `${shown} is a symlink; depcurfew does not write through symlinks`, 'Replace the symlink with a regular file');
  if (existing !== undefined && !existing.isFile()) return fail('cannot-write', `${shown} is not a regular file`, `Remove ${shown}, then run depcurfew init --user again`);
  const ownerOfNew = ownerOfNewUnderHome(environment);
  // A longer delay the user files of the installed tools set becomes cooldown.minimum, as in a project (decision D-101).
  const { kept, minimum, text } = keepLongest((minutes) => longestUserDelay(environment, minutes));
  try {
    // writeChanges creates the missing directories, one level at a time when they are given to the owner of HOME.
    writeChanges(dirname(target), [{ file: POLICY_FILE, before: existing === undefined ? null : readFileSync(target, 'utf8'), after: text }], ownerOfNew === undefined ? {} : { ownerOfNew });
  } catch (error) {
    return fail('cannot-write', `cannot write ${shown}: ${errorMessage(error)}`, 'Make sure you can write to the directory, then run depcurfew init --user again');
  }
  io.stdout(`${existing === undefined ? 'Created' : 'Overwrote'} ${shown} with the default policy.\n`);
  if (kept !== undefined) io.stdout(keptMessage(kept, minimum));
  io.stdout('Run depcurfew apply --user --dry-run to see what it writes into the user-level configuration of your tools.\n');
  return EXIT_OK;
}

/**
 * Writes the default policy to depcurfew.json in `directory` (default: the current directory). A longer release-age
 * delay the repository already sets becomes cooldown.minimum, so that apply does not shorten it (decision D-075).
 */
export function init(directory: string | undefined, force: boolean, io: CliIo): number {
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_USAGE;

  const target = join(absolute, POLICY_FILE);
  const shownTarget = directory === undefined ? POLICY_FILE : join(directory, POLICY_FILE);
  const fail = (code: ApplyErrorCode, message: string, fix: string): number => {
    reportInputError({ code, level: 'error', location: { file: shownTarget }, message, fix }, io);
    return EXIT_FAILURE;
  };
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isDirectory() === true) {
    return fail('cannot-write', `${shownTarget} is a directory, not a file`, `Remove or rename the directory ${shownTarget}, then run depcurfew init again`);
  }
  const detection = detectProject(absolute);
  // No manifest in the root, but in direct subdirectories: independent projects (decision D-100).
  const projects = proposedProjects(absolute).map((project) => ({ project, detection: detectProject(join(absolute, project)) }));
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  // The longest delay of the root and of every project, which apply would otherwise shorten (decision D-075).
  let kept = defaultMinimum.ok ? longestDelay(absolute, detection, defaultMinimum.duration.minutes) : undefined;
  for (const entry of defaultMinimum.ok ? projects : []) {
    const longer = longestDelay(join(absolute, entry.project), entry.detection, kept?.minutes ?? (defaultMinimum.ok ? defaultMinimum.duration.minutes : 0));
    if (longer !== undefined) kept = { ...longer, location: { ...longer.location, file: inProject(entry.project, longer.location.file) } };
  }
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  const text = renderPolicy({
    ...DEFAULT_POLICY,
    cooldown: { ...DEFAULT_POLICY.cooldown, minimum },
    ...(projects.length === 0 ? {} : { projects: projects.map((entry) => entry.project) }),
  });
  try {
    if (existing === undefined || !force) {
      // 'wx' fails if the file appeared in the meantime, so nothing is overwritten without --force.
      writeFileSync(target, text, { flag: 'wx' });
    } else if (existing.isSymbolicLink()) {
      return fail(
        'cannot-write',
        `${shownTarget} is a symlink; depcurfew does not write through symlinks`,
        'Replace the symlink with a regular file, or run depcurfew init in the directory it points to',
      );
    } else if (!existing.isFile()) {
      // A FIFO or a device: reading it for the earlier text would wait for ever or never end.
      return fail('cannot-write', `${shownTarget} is not a regular file`, `Remove ${shownTarget}, then run depcurfew init again`);
    } else {
      // Through a temporary file and a rename, like apply: the directory entry is replaced, never followed.
      writeChanges(absolute, [{ file: POLICY_FILE, before: readFileSync(target, 'utf8'), after: text }]);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail('policy-exists', `${shownTarget} already exists`, 'Pass --force to overwrite it with the default policy, or edit it by hand');
    }
    return fail('cannot-write', `cannot write ${shownTarget}: ${errorMessage(error)}`, 'Make sure you can write to the directory, then run depcurfew init again');
  }
  // As apply sees it under targets "auto": a tool seen only in a CI setup step is not configured (decision D-075).
  const { ciOnly } = autoTargets(absolute, detection);
  const ciNames = new Set(ciOnly.map((entry) => toolName(entry.id)));
  const projectTools = projects.flatMap((entry) => detectedNames(entry.detection).map((name) => `${name} (${entry.project})`));
  const detected = [...detectedNames(detection).filter((name) => !ciNames.has(name)), ...projectTools];
  io.stdout(`${existing === undefined ? 'Created' : 'Overwrote'} ${shownTarget} with the default policy.\n`);
  if (projects.length > 0) {
    io.stdout(
      `projects lists ${listing(projects.map((entry) => entry.project))}: the root has no manifest or lockfile, these directories do, so depcurfew configures each as a project of its own and the bots from the root; edit projects in ${POLICY_FILE} if that is not right.\n`,
    );
  }
  if (kept !== undefined) io.stdout(keptMessage(kept, minimum));
  io.stdout(`Detected tools: ${detected.length === 0 ? 'none' : detected.join(', ')}.\n`);
  // Building from source runs the package's own build code, so the default deny blocks it (decision D-065); a package
  // without wheels then stops installing, which a team should see before apply (user feedback before 1.3.0).
  if (DEFAULT_POLICY.installScripts.default === 'deny' && [detection, ...projects.map((entry) => entry.detection)].some((found) => found.packageManagers.some((manager) => manager.supported && isPythonTool(manager.id)))) {
    io.stdout(
      'note: installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for your platform stops installing; run depcurfew doctor before depcurfew apply to see the locked packages that have none, and add the ones you trust to installScripts.allow as pypi:<name>.\n',
    );
  }
  // In a repository of projects the workflows of the root set up the projects' tools, as apply knows (decision D-100).
  const inProjects = new Set(projects.flatMap((entry) => entry.detection.packageManagers.map((manager) => manager.id)));
  for (const entry of ciOnly.filter((item) => !inProjects.has(item.id as never))) {
    io.stdout(
      `${toolName(entry.id)} is seen only in a CI setup step (${listing(entry.workflows)}), so depcurfew apply does not configure it; add "${entry.id}" to targets in ${POLICY_FILE} if it installs packages for this project.\n`,
    );
  }
  return EXIT_OK;
}
