// The changes depgate apply would make, planned once per doctor run and shared by the rules that need them.
import { planApply, type ApplyReport } from '../apply/index.ts';
import type { Detection } from '../detect/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import type { RuleContext } from './types.ts';

const plans = new WeakMap<ResolvedPolicy, WeakMap<Detection, ApplyReport>>();

/** undefined when the repository has no policy. */
export function plannedApply(context: RuleContext): ApplyReport | undefined {
  const { policy, detection } = context;
  if (policy === undefined) return undefined;
  let byDetection = plans.get(policy);
  if (byDetection === undefined) {
    byDetection = new WeakMap();
    plans.set(policy, byDetection);
  }
  let plan = byDetection.get(detection);
  if (plan === undefined) {
    plan = planApply(context.root, policy, detection, context.tools);
    byDetection.set(detection, plan);
  }
  return plan;
}
