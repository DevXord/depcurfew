// `depgate apply`: turns the policy into configuration for every target tool. Package managers go first, so that
// bots can be given a delay at least as long as the longest one a manager enforces (otherwise a bot would
// propose versions the package manager then refuses to install).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectedTargets } from '../cli/describe.ts';
import { detectProject } from '../detect/index.ts';
import type { Detection } from '../detect/types.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { formatDuration, type Duration } from '../policy/duration.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { formatIssue, parsePolicy } from '../policy/validate.ts';
import { values } from './facts.ts';
import { bun } from './generators/bun.ts';
import { createContext, EditFailed, type BotGenerator, type ManagerGenerator, type Snippet } from './generators/context.ts';
import { deno } from './generators/deno.ts';
import { dependabot } from './generators/dependabot.ts';
import { npm } from './generators/npm.ts';
import { pnpm } from './generators/pnpm.ts';
import { renovate } from './generators/renovate.ts';
import { yarn } from './generators/yarn.ts';
import { pinnedVersion, type Version } from './version.ts';
import { Workspace, writeChanges, type FileChange } from './workspace.ts';

export type { FileChange } from './workspace.ts';
export type { Snippet } from './generators/context.ts';

export interface ApplyReport {
  changes: FileChange[];
  warnings: string[];
  snippets: Snippet[];
  /** Files that could not be edited. When there are any, nothing is written. */
  errors: string[];
}

const MANAGERS: Partial<Record<ToolId, ManagerGenerator>> = { npm, pnpm, yarn, bun, deno };
const BOTS: Partial<Record<ToolId, BotGenerator>> = { renovate, dependabot };

function latestVersion(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['latestVersion'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'string' ? value : undefined;
}

/** The bots' delay: the policy's, or longer if a package manager rounded its delay up further. */
export function botDuration(policy: Duration, managerMinutes: readonly number[]): Duration {
  const minutes = Math.max(policy.minutes, ...managerMinutes);
  return minutes === policy.minutes ? policy : { text: formatDuration(Math.ceil(minutes)), minutes: Math.ceil(minutes) };
}

/** Computes every change without writing anything. */
export function planApply(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): ApplyReport {
  const workspace = new Workspace(root);
  const warnings: string[] = [];
  const snippets: Snippet[] = [];
  const errors: string[] = [];
  const targets = new Set<ToolId>(policy.targets === 'auto' ? detectedTargets(detection) : policy.targets);
  for (const manager of detection.packageManagers) {
    if (!manager.supported && (policy.targets === 'auto' || targets.has(manager.id))) {
      warnings.push(`${manager.variant === 'classic' ? 'Yarn Classic (1.x)' : manager.id} is not supported; nothing written for it`);
      targets.delete(manager.id);
    }
  }
  if (targets.size === 0) warnings.push('no tools to configure');

  const run = (tool: ToolKnowledge, version: Version | undefined, action: (context: ReturnType<typeof createContext>) => void) => {
    const context = createContext({ tool, policy, version, workspace, warnings, snippets, errors });
    try {
      action(context);
    } catch (error) {
      if (!(error instanceof EditFailed)) throw error;
    }
  };

  const managerMinutes: number[] = [];
  for (const tool of tools) {
    const generator = MANAGERS[tool.id];
    if (generator === undefined || !targets.has(tool.id)) continue;
    const manager = detection.packageManagers.find((entry) => entry.id === tool.id);
    const version = manager === undefined ? undefined : pinnedVersion(manager);
    if (version === undefined) {
      const latest = latestVersion(tool);
      warnings.push(`${tool.name}: no exact version is pinned; configuring for ${tool.name} ${latest ?? 'latest'}, the latest known version`);
    }
    run(tool, version, (context) => {
      const minutes = generator(context);
      if (minutes !== undefined) managerMinutes.push(minutes);
    });
  }

  const duration = policy.cooldown === undefined ? undefined : botDuration(policy.cooldown.minimum, managerMinutes);
  for (const tool of tools) {
    const generator = BOTS[tool.id];
    if (generator === undefined || !targets.has(tool.id)) continue;
    run(tool, undefined, (context) => generator(context, duration));
  }

  return { changes: workspace.changes(), warnings, snippets, errors };
}

export class PolicyError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

export function loadPolicy(root: string): ResolvedPolicy {
  let text: string;
  try {
    text = readFileSync(join(root, POLICY_FILE), 'utf8');
  } catch {
    throw new PolicyError(`no ${POLICY_FILE} in ${root}; run 'depgate init' first`);
  }
  const result = parsePolicy(text);
  if (!result.ok) throw new PolicyError(`${POLICY_FILE} is invalid`, result.issues.map(formatIssue));
  return result.policy;
}

/**
 * Reads the policy, detects the project, plans the changes and (unless told otherwise) writes them. If any file
 * could not be edited, nothing is written, so a run either applies the whole policy or leaves the repository as it was.
 */
export function applyProject(root: string, options: { write?: boolean } = {}): ApplyReport {
  const report = planApply(root, loadPolicy(root), detectProject(root));
  if (options.write !== false && report.errors.length === 0) writeChanges(root, report.changes);
  return report;
}

