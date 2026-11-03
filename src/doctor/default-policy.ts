// doctor without depcurfew.json (decision D-149): the rules that need a policy compare the repository with the policy
// depcurfew init would write. What they find is a note that names that policy, with depcurfew init and depcurfew apply
// as the fix, so that a repository without a policy never fails doctor because of it.
import { listing } from '../apply/requirements.ts';
import { DEFAULT_POLICY, POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { makeNotice, type Finding, type Notice, type Rule } from './types.ts';

/** How messages name the policy the rules compared the repository with. */
export const DEFAULT_POLICY_NAME = 'the default policy of depcurfew init';

/** What to run, at the end of a fix. */
export const APPLY_NEXT = 'depcurfew apply (depcurfew apply --dry-run shows the changes first)';

/** The start of every fix of such a note. */
export const INIT_FIRST = `Run depcurfew init to write ${POLICY_FILE} with the default policy`;

/** depcurfew.json as a word of a message, not a part of a path such as frontend/depcurfew.json. */
const POLICY_WORD = new RegExp(`(?<![\\w./\\\\-])${POLICY_FILE.replaceAll('.', '\\.')}(?![\\w-])`, 'gu');

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * A finding of a rule that ran against the default policy, as a note: the message names that policy instead of
 * depcurfew.json (or says it at the end when it names no policy), and the fix runs depcurfew init first, then what the
 * finding says, then depcurfew apply. A message that already names the default policy (config-drift) keeps its text.
 */
export function asDefaultFinding(finding: Finding, rule: Pick<Rule, 'help'>): Finding {
  const named = finding.message.replace(POLICY_WORD, DEFAULT_POLICY_NAME);
  const message = finding.message.includes(DEFAULT_POLICY_NAME) ? finding.message : named !== finding.message ? named : `${finding.message} (compared with ${DEFAULT_POLICY_NAME})`;
  const original = (finding.fix ?? rule.help).replace(/\.$/u, '');
  const fix = original.startsWith(INIT_FIRST)
    ? original
    : `${INIT_FIRST}; then ${lowerFirst(original)}${original.includes('depcurfew apply') ? '' : `; then run ${APPLY_NEXT}`}`;
  return { ...finding, level: 'note', message, fix, policy: 'default' };
}

/** The most notes of one rule in one file against the default policy; one more note counts the rest (decision D-149). */
export const MAX_DEFAULT_NOTES = 5;

/**
 * The notes against the default policy, at most MAX_DEFAULT_NOTES of a rule in one file (a lockfile with dozens of
 * packages with install scripts), so that the overview stays short; one note more says how many are left out and how
 * to see them. Their order is kept.
 */
export function shortened(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, { shown: number; hidden: number; last?: Finding }>();
  for (const finding of findings) {
    const key = `${finding.rule}\u0000${finding.location.file}`;
    const group = groups.get(key) ?? { shown: 0, hidden: 0 };
    groups.set(key, group);
    if (group.shown < MAX_DEFAULT_NOTES) {
      group.shown += 1;
      group.last = finding;
    } else {
      group.hidden += 1;
    }
  }
  const kept: Finding[] = [];
  const shown = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.rule}\u0000${finding.location.file}`;
    const count = (shown.get(key) ?? 0) + 1;
    shown.set(key, count);
    if (count > MAX_DEFAULT_NOTES) continue;
    kept.push(finding);
    const group = groups.get(key);
    if (group === undefined || group.hidden === 0 || group.last !== finding) continue;
    const { hidden } = group;
    kept.push({
      rule: finding.rule,
      level: 'note',
      location: { file: finding.location.file },
      message: `${hidden} more ${finding.rule} ${hidden === 1 ? 'finding' : 'findings'} in ${finding.location.file} against ${DEFAULT_POLICY_NAME} ${hidden === 1 ? 'is' : 'are'} not shown`,
      fix: `${INIT_FIRST}, then run depcurfew doctor again to see them all`,
      policy: 'default',
    });
  }
  return kept;
}

/**
 * The notice policy-missing when the rules that need a policy ran against the default policy: which policy that was,
 * with the longer delay and the projects init would write, and what to run.
 */
export function defaultPolicyNotice(policy: ResolvedPolicy): Notice {
  const extras: string[] = [];
  const minimum = policy.cooldown?.minimum.text;
  if (minimum !== undefined && minimum !== DEFAULT_POLICY.cooldown.minimum) extras.push(`cooldown.minimum "${minimum}", the longest release-age delay the repository already sets`);
  if (policy.projects.length > 0) extras.push(`projects ${listing(policy.projects.map((project) => `"${project}"`))}`);
  return makeNotice(
    'policy-missing',
    `no ${POLICY_FILE}: the rules that need a policy compared the repository with ${DEFAULT_POLICY_NAME}${extras.length === 0 ? '' : ` (with ${extras.join(' and ')})`}; what they find is a note and does not fail doctor`,
    undefined,
    `Run depcurfew init to write ${POLICY_FILE} with this policy, then ${APPLY_NEXT}`,
  );
}
