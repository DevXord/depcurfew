// Which findings make depcurfew doctor fail (decision D-112): the option (--fail-on, or --strict for --fail-on warning)
// wins over doctor.failOn of the policy, which wins over the default "error". Notes never fail.
import type { FAIL_ON_LEVELS, ResolvedPolicy } from '../policy/schema.ts';
import type { Level } from './types.ts';

export type FailOn = (typeof FAIL_ON_LEVELS)[number];

/** Where the setting came from: the command line (or the Action input), doctor.failOn of the policy, or neither. */
export type FailOnFrom = 'option' | 'policy' | 'default';

export interface FailOnSetting {
  failOn: FailOn;
  from: FailOnFrom;
  /** from option: the option as given, "--strict" or "--fail-on warning". */
  option?: string;
  /** from policy: the policy file as messages show it, e.g. depcurfew.json. */
  file?: string;
}

/** doctor.failOn of a valid policy; undefined without a policy, without the section or without the field in it (decision D-116). */
export function policyFailOn(policy: ResolvedPolicy | undefined): FailOn | undefined {
  return policy?.doctor?.failOn;
}

/** The setting that applies: the option, else the policy's doctor.failOn, else "error". */
export function resolveFailOn(option: { failOn: FailOn; given: string } | undefined, policy: { failOn: FailOn | undefined; file: string }): FailOnSetting {
  if (option !== undefined) return { failOn: option.failOn, from: 'option', option: option.given };
  if (policy.failOn !== undefined) return { failOn: policy.failOn, from: 'policy', file: policy.file };
  return { failOn: 'error', from: 'default' };
}

/** Whether findings with these counts fail doctor. */
export function fails(counts: Record<Level, number>, failOn: FailOn): boolean {
  return counts.error > 0 || (failOn === 'warning' && counts.warning > 0);
}

/**
 * The line under the counts when warnings make doctor fail, and how to fail on errors only; undefined when they do
 * not. One source for the text of the CLI.
 */
export function failOnExplanation(setting: FailOnSetting, counts: Record<Level, number>): { message: string; fix: string } | undefined {
  if (setting.failOn !== 'warning' || counts.warning === 0) return undefined;
  if (setting.from === 'policy') {
    const file = setting.file ?? 'depcurfew.json';
    return {
      message: `doctor.failOn is "warning" in ${file}, so warnings count as failures and depcurfew doctor exits with 1`,
      fix: `Set doctor.failOn to "error" in ${file}, or pass --fail-on error, to fail on errors only`,
    };
  }
  const option = setting.option ?? '--fail-on warning';
  return {
    message: `${option}: warnings count as failures, so depcurfew doctor exits with 1`,
    fix: `Pass --fail-on error instead of ${option} to fail on errors only`,
  };
}
