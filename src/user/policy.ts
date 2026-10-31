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

/** What to do about a user policy that cannot be used, naming it as messages show it. */
export function userPolicyFix(error: PolicyError, shown: string): string {
  if (error.fix !== undefined) return error.fix;
  return error.code === 'policy-unreadable'
    ? `Make ${shown} a regular file of at most 1 MiB that the user running depcurfew can read, or write a new one with depcurfew init --user --force`
    : `Fix these problems in ${shown}; an editor that reads its $schema shows them as you type`;
}

/** The user policy; PolicyError when it is missing, unreadable or invalid, as for a project policy. */
export function loadUserPolicy(environment: UserEnvironment): UserPolicy {
  const path = userPolicyPath(environment);
  const shown = shownPath(path, environment);
  const read = readLimited(path, MAX_POLICY);
  // The fixes of a project policy speak of the repository; the user policy is in the user's configuration directory.
  const unreadable = `Make ${shown} a regular file of at most 1 MiB that the user running depcurfew can read`;
  if (!read.ok) {
    if (read.problem === 'missing') throw new PolicyError(`no user policy at ${shown}`, [], 'policy-missing', "Run 'depcurfew init --user' first");
    if (read.problem === 'too-large') throw new PolicyError(`${shown} is larger than 1 MiB`, [], 'policy-unreadable', unreadable);
    if (read.problem === 'unreadable') throw new PolicyError(`${shown} cannot be read: ${read.error.message}`, [], 'policy-unreadable', unreadable);
    throw new PolicyError(`${shown} is not a file`, [], 'policy-unreadable', unreadable);
  }
  const result = parsePolicy(read.bytes.toString('utf8'));
  if (!result.ok) throw new PolicyError(`${shown} is invalid`, result.issues.map(formatIssue), 'policy-invalid', `Fix these problems in ${shown}; an editor that reads its $schema shows them as you type`);
  return { policy: result.policy, path, shown };
}
