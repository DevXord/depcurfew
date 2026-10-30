// One registry's view of the policy: npm tools see the package names without a prefix, Python tools the pypi:
// names without it, so a name in depcurfew.json never reaches a tool of the other registry.
import type { Ecosystem, ToolKnowledge } from '../knowledge/types.ts';
import { patternsFor } from './package-pattern.ts';
import type { ResolvedPolicy } from './schema.ts';

export function ecosystemOfTool(tool: Pick<ToolKnowledge, 'ecosystem'>): Ecosystem {
  return tool.ecosystem ?? 'npm';
}

/** The policy with cooldown.exclude and installScripts.allow reduced to the patterns of one ecosystem. */
export function policyFor(policy: ResolvedPolicy, ecosystem: Ecosystem): ResolvedPolicy {
  return {
    ...policy,
    ...(policy.cooldown === undefined ? {} : { cooldown: { ...policy.cooldown, exclude: patternsFor(policy.cooldown.exclude, ecosystem) } }),
    ...(policy.installScripts === undefined ? {} : { installScripts: { ...policy.installScripts, allow: patternsFor(policy.installScripts.allow, ecosystem) } }),
  };
}
