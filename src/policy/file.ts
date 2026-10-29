// Reads depgate.json like any other file of the repository: never through a symlink that leads outside it and never
// beyond the size limit for configuration files, so an untrusted repository cannot make depgate read (and echo in
// validation errors) a file of the machine it runs on.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from '../detect/repository.ts';
import { POLICY_FILE } from './defaults.ts';

export type PolicyFile = { status: 'missing' } | { status: 'unreadable'; reason: string } | { status: 'ok'; text: string };

export function readPolicyFile(root: string): PolicyFile {
  try {
    lstatSync(join(root, POLICY_FILE));
  } catch {
    return { status: 'missing' };
  }
  const repository = new Repository(root);
  const text = repository.readText(POLICY_FILE);
  if (text !== undefined) return { status: 'ok', text };
  return { status: 'unreadable', reason: repository.warnings[0]?.message ?? `${POLICY_FILE} is not a regular file and was not read` };
}
