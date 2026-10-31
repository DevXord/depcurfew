// The user policy (decision D-087): depcurfew.json in the user's configuration directory, read like a project policy.
import { PolicyError } from '../apply/index.ts';
import { readLimited } from '../read-limited.ts';
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
  const read = readLimited(path, MAX_POLICY);
  if (!read.ok) {
    if (read.problem === 'missing') throw new PolicyError(`no user policy at ${shown}`, [], 'policy-missing', "Run 'depcurfew init --user' first");
    if (read.problem === 'too-large') throw new PolicyError(`${shown} is larger than 1 MiB`, [], 'policy-unreadable');
    if (read.problem === 'unreadable') throw new PolicyError(`${shown} cannot be read: ${read.error.message}`, [], 'policy-unreadable');
    throw new PolicyError(`${shown} is not a file`, [], 'policy-unreadable');
  }
  const result = parsePolicy(read.bytes.toString('utf8'));
  if (!result.ok) throw new PolicyError(`${shown} is invalid`, result.issues.map(formatIssue));
  return { policy: result.policy, path, shown };
}
