import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '../detect/index.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { detectedNames } from './describe.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Writes the default policy to depgate.json in `directory` (default: the current directory). */
export function init(directory: string | undefined, force: boolean, io: CliIo): number {
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;

  const target = join(absolute, POLICY_FILE);
  const shownTarget = directory === undefined ? POLICY_FILE : join(directory, POLICY_FILE);
  const existed = existsSync(target);
  try {
    // 'wx' fails if the file appeared in the meantime, so nothing is overwritten without --force.
    writeFileSync(target, renderPolicy(DEFAULT_POLICY), { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      io.stderr(`depgate: ${shownTarget} already exists; pass --force to overwrite it.\n`);
    } else {
      io.stderr(`depgate: cannot write ${shownTarget}: ${errorMessage(error)}\n`);
    }
    return EXIT_FAILURE;
  }
  const detected = detectedNames(detectProject(absolute));
  io.stdout(`${existed ? 'Overwrote' : 'Created'} ${shownTarget} with the default policy.\n`);
  io.stdout(`Detected tools: ${detected.length === 0 ? 'none' : detected.join(', ')}.\n`);
  return EXIT_OK;
}
