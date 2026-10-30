import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDelay, longestDelay, policyDuration } from '../apply/delays.ts';
import { writeChanges } from '../apply/workspace.ts';
import { detectProject } from '../detect/index.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import { detectedNames } from './describe.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes the default policy to depcurfew.json in `directory` (default: the current directory). A longer release-age
 * delay the repository already sets becomes cooldown.minimum, so that apply does not shorten it (decision D-075).
 */
export function init(directory: string | undefined, force: boolean, io: CliIo): number {
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;

  const target = join(absolute, POLICY_FILE);
  const shownTarget = directory === undefined ? POLICY_FILE : join(directory, POLICY_FILE);
  const existing = lstatSync(target, { throwIfNoEntry: false });
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
      io.stderr(`depcurfew: ${shownTarget} is a symlink; depcurfew does not write through symlinks\n`);
      return EXIT_FAILURE;
    } else {
      // Through a temporary file and a rename, like apply: the directory entry is replaced, never followed.
      writeChanges(absolute, [{ file: POLICY_FILE, before: readFileSync(target, 'utf8'), after: text }]);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      io.stderr(`depcurfew: ${shownTarget} already exists; pass --force to overwrite it.\n`);
    } else {
      io.stderr(`depcurfew: cannot write ${shownTarget}: ${errorMessage(error)}\n`);
    }
    return EXIT_FAILURE;
  }
  const detected = detectedNames(detection);
  io.stdout(`${existing === undefined ? 'Created' : 'Overwrote'} ${shownTarget} with the default policy.\n`);
  if (kept !== undefined) {
    io.stdout(`cooldown.minimum is ${minimum} instead of ${DEFAULT_POLICY.cooldown.minimum}, to keep the longest release-age delay already set: ${describeDelay(kept)}.\n`);
  }
  io.stdout(`Detected tools: ${detected.length === 0 ? 'none' : detected.join(', ')}.\n`);
  return EXIT_OK;
}
