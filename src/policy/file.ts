// Reads depcurfew.json like any other file of the repository: never through a symlink that leads outside it and never
// beyond the size limit for configuration files, so an untrusted repository cannot make depcurfew read (and echo in
// validation errors) a file of the machine it runs on. A file that cannot be read, e.g. for lack of permission, is
// reported as unreadable, not thrown.
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Repository } from '../detect/repository.ts';
import { POLICY_FILE } from './defaults.ts';

export type PolicyFile = { status: 'missing' } | { status: 'unreadable'; reason: string } | { status: 'ok'; text: string };

/** The directory entry git keeps at the root of a working tree: a directory, or a file in a worktree or submodule. */
const GIT_ENTRY = '.git';

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0] ?? message;
}

/** Whether a path exists; an error other than "no such file" counts as existing, so that it is reported, not skipped. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

export function readPolicyFile(root: string): PolicyFile {
  if (!exists(join(root, POLICY_FILE))) return { status: 'missing' };
  let repository: Repository;
  let text: string | undefined;
  try {
    repository = new Repository(root);
    text = repository.readText(POLICY_FILE);
  } catch (error) {
    return { status: 'unreadable', reason: `cannot read ${POLICY_FILE}: ${firstLine(error)}` };
  }
  if (text !== undefined) return { status: 'ok', text };
  return { status: 'unreadable', reason: repository.warnings[0]?.message ?? `${POLICY_FILE} is not a regular file and was not read` };
}

/**
 * The directory whose depcurfew.json applies to `start`: `start` itself, or the nearest parent with one up to the root
 * of the repository (the first directory with .git); undefined when there is none. A policy above the repository
 * belongs to another project. Outside a repository only `start` counts: a parent such as /tmp or a shared folder may
 * hold a depcurfew.json that someone else put there (decision D-079).
 */
export function findPolicyDirectory(start: string): string | undefined {
  const first = resolve(start);
  for (let directory = first; ; directory = dirname(directory)) {
    if (exists(join(directory, POLICY_FILE))) return directory === first || insideRepository(directory) ? directory : undefined;
    if (exists(join(directory, GIT_ENTRY)) || dirname(directory) === directory) return undefined;
  }
}

/** Whether `directory` or one of its parents has .git. */
function insideRepository(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (exists(join(current, GIT_ENTRY))) return true;
    if (dirname(current) === current) return false;
  }
}
