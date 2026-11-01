// The changes depcurfew apply would make, planned once per doctor run and shared by the rules that need them.
import { planApply, type ApplyReport, type PlanOptions } from '../apply/index.ts';
import type { Detection } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import type { RuleContext } from './types.ts';

const plans = new WeakMap<ResolvedPolicy, WeakMap<Detection, ApplyReport>>();

/**
 * The plan of one directory, made once for a policy and a detection. A directory is planned with the same options
 * throughout a doctor run (the root, or a project listed in projects), so they are not part of the key.
 */
export function plannedFor(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[], options?: PlanOptions): ApplyReport {
  let byDetection = plans.get(policy);
  if (byDetection === undefined) {
    byDetection = new WeakMap();
    plans.set(policy, byDetection);
  }
  let plan = byDetection.get(detection);
  if (plan === undefined) {
    plan = planApply(root, policy, detection, tools, options);
    byDetection.set(detection, plan);
  }
  return plan;
}

/** undefined when the repository has no policy. */
export function plannedApply(context: RuleContext): ApplyReport | undefined {
  const { policy, detection } = context;
  if (policy === undefined) return undefined;
  return plannedFor(context.root, policy, detection, context.tools, context.plan);
}
