// The user policy (decision D-087): depcurfew.json in the user's configuration directory, read like a project policy.
import { readFileSync, statSync } from 'node:fs';
import { PolicyError } from '../apply/index.ts';
import { formatIssue, parsePolicy } from '../policy/validate.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { shownPath, type UserEnvironment } from './locate.ts';
import { userPolicyPath } from './policy-path.ts';

const MAX_POLICY = 1024 * 1024;

export interface UserPolicy {
  policy: ResolvedPolicy;
  path: string;
  /** The path as messages show it (~/.config/depcurfew/depcurfew.json). */
  shown: string;
}

/** The user policy; PolicyError when it is missing, unreadable or invalid, as for a project policy. */
export function loadUserPolicy(environment: UserEnvironment): UserPolicy {
  const path = userPolicyPath(environment);
  const shown = shownPath(path, environment);
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new PolicyError(`${shown} is not a file`, [], 'policy-unreadable');
    if (stats.size > MAX_POLICY) throw new PolicyError(`${shown} is larger than 1 MiB`, [], 'policy-unreadable');
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PolicyError(`no user policy at ${shown}`, [], 'policy-missing', "Run 'depcurfew init --user' first");
    }
    throw new PolicyError(`${shown} cannot be read: ${(error as Error).message}`, [], 'policy-unreadable');
  }
  const result = parsePolicy(text);
  if (!result.ok) throw new PolicyError(`${shown} is invalid`, result.issues.map(formatIssue));
  return { policy: result.policy, path, shown };
}
