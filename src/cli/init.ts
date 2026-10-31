import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shownPath, type UserEnvironment } from '../user/locate.ts';
import { userPolicyPath } from '../user/policy-path.ts';
import { describeDelay, longestDelay, policyDuration } from '../apply/delays.ts';
import { writeChanges } from '../apply/workspace.ts';
import { detectProject } from '../detect/index.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import { autoTargets } from '../apply/targets.ts';
import { listing } from '../apply/requirements.ts';
import { detectedNames, toolName } from './describe.ts';
import { reportInputError, resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

/** A file system error without the path, e.g. "EACCES: permission denied". */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && message.startsWith(`${code}: `) ? (message.split(',', 1)[0] ?? message) : message;
}

/** init --user: the default policy as the user policy, in a directory that is created when missing. */
export function initUser(force: boolean, environment: UserEnvironment, io: CliIo): number {
  const target = userPolicyPath(environment);
  const shown = shownPath(target, environment);
  const fail = (code: ApplyErrorCode, message: string, fix: string): number => {
    reportInputError({ code, level: 'error', location: { file: shown }, message, fix }, io);
    return EXIT_FAILURE;
  };
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isDirectory() === true) return fail('cannot-write', `${shown} is a directory, not a file`, `Remove or rename the directory ${shown}, then run depcurfew init --user again`);
  if (existing !== undefined && !force) return fail('policy-exists', `${shown} already exists`, 'Pass --force to overwrite it with the default policy, or edit it by hand');
  if (existing?.isSymbolicLink() === true) return fail('cannot-write', `${shown} is a symlink; depcurfew does not write through symlinks`, 'Replace the symlink with a regular file');
  if (existing !== undefined && !existing.isFile()) return fail('cannot-write', `${shown} is not a regular file`, `Remove ${shown}, then run depcurfew init --user again`);
  const directory = dirname(target);
  try {
    mkdirSync(directory, { recursive: true });
    writeChanges(directory, [{ file: POLICY_FILE, before: existing === undefined ? null : readFileSync(target, 'utf8'), after: renderPolicy(DEFAULT_POLICY) }]);
  } catch (error) {
    return fail('cannot-write', `cannot write ${shown}: ${errorMessage(error)}`, 'Make sure you can write to the directory, then run depcurfew init --user again');
  }
  io.stdout(`${existing === undefined ? 'Created' : 'Overwrote'} ${shown} with the default policy.\n`);
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
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  const kept = defaultMinimum.ok ? longestDelay(absolute, detection, defaultMinimum.duration.minutes) : undefined;
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  const text = renderPolicy({ ...DEFAULT_POLICY, cooldown: { ...DEFAULT_POLICY.cooldown, minimum } });
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
  const detected = detectedNames(detection).filter((name) => !ciNames.has(name));
  io.stdout(`${existing === undefined ? 'Created' : 'Overwrote'} ${shownTarget} with the default policy.\n`);
  if (kept !== undefined) {
    io.stdout(`cooldown.minimum is ${minimum} instead of ${DEFAULT_POLICY.cooldown.minimum}, to keep the longest release-age delay already set: ${describeDelay(kept)}.\n`);
  }
  io.stdout(`Detected tools: ${detected.length === 0 ? 'none' : detected.join(', ')}.\n`);
  for (const entry of ciOnly) {
    io.stdout(
      `${toolName(entry.id)} is seen only in a CI setup step (${listing(entry.workflows)}), so depcurfew apply does not configure it; add "${entry.id}" to targets in ${POLICY_FILE} if it installs packages for this project.\n`,
    );
  }
  return EXIT_OK;
}
