import { evidenceOf, factAt } from './facts.ts';
import type { ToolId, ToolKind } from './types.ts';

export const TOOL_IDS: readonly ToolId[] = ['npm', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'pip', 'poetry', 'renovate', 'dependabot'];

export const SOURCE_KINDS = ['git', 'remoteTarball', 'file', 'directory'] as const;

/** Facts that describe a setting; required only when the anchor setting exists (is not `null`). */
interface FactGroup {
  anchor: string;
  dependents: readonly string[];
}

const ALWAYS_REQUIRED = [
  'cooldown.setting',
  'cooldown.configFiles',
  'cooldown.cliFlag',
  'cooldown.unit',
  'cooldown.availableSince',
  'cooldown.default',
  'cooldown.securityUpdates',
  'installScripts.defaultPolicy',
  'installScripts.disableAll',
];

const COMMON_GROUPS: readonly FactGroup[] = [
  {
    anchor: 'cooldown.exclude.setting',
    dependents: ['cooldown.exclude.availableSince', 'cooldown.exclude.patternSyntax'],
  },
  {
    anchor: 'installScripts.allowList.setting',
    dependents: ['installScripts.allowList.file', 'installScripts.allowList.availableSince', 'installScripts.allowList.format'],
  },
];

const PROJECT_FACTS = ['project.lockfiles', 'project.manifests', 'project.workspaces', 'project.workspacesObjectKey'];

const SOURCE_GROUPS: readonly FactGroup[] = SOURCE_KINDS.map((kind) => ({
  anchor: `sources.${kind}.setting`,
  dependents: ['values', 'availableSince', 'default'].map((field) => `sources.${kind}.${field}`),
}));

/**
 * Dot paths of the facts a tool entry must define. Bots do not resolve dependency sources, so only package
 * managers need source facts. Details of a setting are required unless the setting is known not to exist.
 */
export function requiredFactPaths(tool: { kind: ToolKind }): readonly string[] {
  const groups = tool.kind === 'package-manager' ? [...COMMON_GROUPS, ...SOURCE_GROUPS] : COMMON_GROUPS;
  const paths = tool.kind === 'package-manager' ? [...ALWAYS_REQUIRED, ...PROJECT_FACTS] : [...ALWAYS_REQUIRED];
  for (const group of groups) {
    paths.push(group.anchor);
    const anchor = factAt(tool, group.anchor);
    const exists = anchor === undefined || evidenceOf(anchor).some((evidence) => evidence.value !== null);
    if (exists) paths.push(...group.dependents);
  }
  return paths;
}
