import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliIo } from './io.ts';

/** The absolute path of an existing directory given on the command line (default: the current directory). */
export function resolveDirectory(directory: string | undefined, io: CliIo): string | undefined {
  const shown = directory ?? '.';
  const absolute = resolve(shown);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    io.stderr(`depcurfew: directory not found: ${shown}\n`);
    return undefined;
  }
  if (!isDirectory) {
    io.stderr(`depcurfew: not a directory: ${shown}\n`);
    return undefined;
  }
  return absolute;
}
