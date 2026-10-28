// Builds complete, valid tool entries for tests; individual tests then break one thing at a time.
import { requiredFactPaths } from '../../src/knowledge/schema.ts';
import type { ToolId, ToolKind, ToolKnowledge } from '../../src/knowledge/types.ts';

export const TODAY = '2026-10-28';

const SAMPLE_SOURCE: Record<ToolId, string> = {
  npm: 'https://docs.npmjs.com/cli/v11/using-npm/config',
  pnpm: 'https://pnpm.io/settings',
  yarn: 'https://yarnpkg.com/configuration/yarnrc',
  bun: 'https://bun.com/docs/runtime/bunfig',
  deno: 'https://docs.deno.com/runtime/reference/cli/install/',
  renovate: 'https://docs.renovatebot.com/configuration-options/',
  dependabot: 'https://docs.github.com/en/code-security/dependabot',
};

export function verified(value: unknown, source: string, verifiedAt = TODAY) {
  return { status: 'verified', value, source, verifiedAt };
}

export function buildTool(id: ToolId = 'npm', kind: ToolKind = 'package-manager'): ToolKnowledge {
  const tool: Record<string, unknown> = { id, name: `Sample ${id}`, kind };
  for (const path of requiredFactPaths({ kind })) {
    setPath(tool, path, verified(`value of ${path}`, `${SAMPLE_SOURCE[id]}#${path}`));
  }
  return tool as unknown as ToolKnowledge;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let node = target;
  for (const key of keys) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

export function getPath(target: unknown, path: string): Record<string, unknown> {
  let node = target as Record<string, unknown>;
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
  return node;
}

export function deletePath(target: unknown, path: string): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  delete getPath(target, keys.join('.'))[last];
}
