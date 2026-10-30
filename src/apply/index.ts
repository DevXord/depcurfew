// `depcurfew apply`: turns the policy into configuration for every target tool. Package managers go first, so that
// bots can be given a delay at least as long as the longest one a manager enforces (otherwise a bot would
// propose versions the package manager then refuses to install).
import { detectedTargets } from '../cli/describe.ts';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { allowEntries, matchesPattern } from '../doctor/allow-lists.ts';
import type { Detection } from '../detect/types.ts';
import { environment as environmentKnowledge } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { Fact, ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { formatDuration, type Duration } from '../policy/duration.ts';
import { ecosystemOfTool, policyFor } from '../policy/ecosystem.ts';
import { readPolicyFile } from '../policy/file.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { formatIssue, parsePolicy } from '../policy/validate.ts';
import { isRecord, sinceOf, values } from './facts.ts';
import { bun } from './generators/bun.ts';
import { createContext, EditFailed, type BotGenerator, type EditFailure, type ManagerGenerator, type Snippet } from './generators/context.ts';
import { deno } from './generators/deno.ts';
import { dependabot } from './generators/dependabot.ts';
import { npm } from './generators/npm.ts';
import { pip } from './generators/pip.ts';
import { pnpm } from './generators/pnpm.ts';
import { poetry } from './generators/poetry.ts';
import { renovate } from './generators/renovate.ts';
import { uv } from './generators/uv.ts';
import { yarn } from './generators/yarn.ts';
import { pinnedVersion, type Version } from './version.ts';
import { Workspace, writeChanges, type FileChange } from './workspace.ts';

export type { FileChange } from './workspace.ts';
export type { EditFailure, Snippet } from './generators/context.ts';

export interface ApplyReport {
  changes: FileChange[];
  warnings: string[];
  snippets: Snippet[];
  /** Files that could not be edited, as messages. When there are any, nothing is written. */
  errors: string[];
  /** The same failures with the tool and the file. */
  failures: EditFailure[];
}

const MANAGERS: Partial<Record<ToolId, ManagerGenerator>> = { npm, pnpm, yarn, bun, deno, uv, pip, poetry };
const BOTS: Partial<Record<ToolId, BotGenerator>> = { renovate, dependabot };

function latestVersion(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['latestVersion'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'string' ? value : undefined;
}

/** Where a repository can pin the version of a tool, for the warning when none is pinned. */
function pinPlaces(tool: ToolKnowledge): string {
  if (ecosystemOfTool(tool) === 'npm') return 'packageManager, devEngines, .tool-versions or a CI setup step';
  const required = tool.extra?.['requiredVersion'];
  const value = required === undefined ? undefined : values(required)[0];
  const places = isRecord(value) && typeof value['key'] === 'string' && typeof value['table'] === 'string' ? [`${value['key']} in [${value['table']}]`] : [];
  const plugins = values(environmentKnowledge.asdf.plugins)[0] ?? {};
  if (Object.values(plugins).includes(tool.id)) places.push('.tool-versions');
  const actions = Object.values(environmentKnowledge.githubActions).flatMap((fact) => values(fact as Fact<unknown>));
  if (actions.some((action) => isRecord(action) && Array.isArray(action['inputs']) && action['inputs'].some((input: unknown) => isRecord(input) && input['tool'] === tool.id))) {
    places.push('a CI setup step');
  }
  return places.length < 2 ? (places[0] ?? 'a CI setup step') : `${places.slice(0, -1).join(', ')} or ${places.at(-1) ?? ''}`;
}

/** The bots' delay: the policy's, or longer if a package manager rounded its delay up further. */
export function botDuration(policy: Duration, managerMinutes: readonly number[]): Duration {
  const minutes = Math.max(policy.minutes, ...managerMinutes);
  return minutes === policy.minutes ? policy : { text: formatDuration(Math.ceil(minutes)), minutes: Math.ceil(minutes) };
}

/**
 * apply only adds to install-script allow-lists, so a package someone listed by hand keeps running its scripts after
 * the policy denies them; say so, and what to do about it.
 */
function allowListWarnings(root: string, policy: ResolvedPolicy, detection: Detection, targets: ReadonlySet<ToolId>, tools: readonly ToolKnowledge[]): string[] {
  if (policy.installScripts?.default !== 'deny') return [];
  const repository = new Repository(root);
  return detection.packageManagers
    .filter((manager) => manager.supported && targets.has(manager.id))
    .flatMap((manager) => {
      const tool = tools.find((entry) => entry.id === manager.id);
      const allow = policyFor(policy, tool === undefined ? 'npm' : ecosystemOfTool(tool)).installScripts?.allow ?? [];
      return allowEntries(repository, manager.id, manager.configFiles).filter((entry) => !allow.some((pattern) => matchesPattern(entry.package, pattern)));
    })
    .map(
      (entry) =>
        `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it; depcurfew apply does not remove entries it did not write, so remove ${entry.name} from ${entry.setting} by hand or add ${entry.name === entry.package ? 'it' : entry.package} to installScripts.allow in ${POLICY_FILE}`,
    );
}

/** Computes every change without writing anything. */
export function planApply(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): ApplyReport {
  const workspace = new Workspace(root);
  const warnings: string[] = [];
  const snippets: Snippet[] = [];
  const failures: EditFailure[] = [];
  const targets = new Set<ToolId>(policy.targets === 'auto' ? detectedTargets(detection) : policy.targets);
  for (const manager of detection.packageManagers) {
    if (!manager.supported && (policy.targets === 'auto' || targets.has(manager.id))) {
      const berry = tools.find((tool) => tool.id === manager.id);
      const since = berry === undefined ? undefined : sinceOf(berry.cooldown.availableSince);
      const advice = manager.variant === 'classic' && berry !== undefined ? `. Move to ${berry.name}${since === undefined ? '' : ` ${since} or later`}, or to another package manager depcurfew configures` : '';
      warnings.push(`${manager.variant === 'classic' ? 'Yarn Classic (1.x)' : manager.id} is not supported; nothing written for it${advice}`);
      targets.delete(manager.id);
    }
  }
  if (targets.size === 0) warnings.push('no tools to configure: depcurfew found no supported package manager or bot here (depcurfew explain shows what it detects)');

  // Package managers see the policy of their registry; bots serve both and get all of it.
  const run = (tool: ToolKnowledge, version: Version | undefined, action: (context: ReturnType<typeof createContext>) => void) => {
    const view = tool.kind === 'package-manager' ? policyFor(policy, ecosystemOfTool(tool)) : policy;
    const context = createContext({ tool, tools, targets, policy: view, version, workspace, warnings, snippets, failures });
    try {
      action(context);
    } catch (error) {
      if (!(error instanceof EditFailed)) throw error;
    }
    context.finish();
  };

  const managerMinutes: number[] = [];
  for (const tool of tools) {
    const generator = MANAGERS[tool.id];
    if (generator === undefined || !targets.has(tool.id)) continue;
    const manager = detection.packageManagers.find((entry) => entry.id === tool.id);
    const version = manager === undefined ? undefined : pinnedVersion(manager);
    if (version === undefined) {
      const latest = latestVersion(tool);
      warnings.push(
        `${tool.name}: no exact version is pinned, so depcurfew configures for ${tool.name} ${latest ?? 'latest'}, the latest version it knows; pin the version you use (${pinPlaces(tool)}) to configure for it`,
      );
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

  warnings.push(...allowListWarnings(root, policy, detection, targets, tools));
  const errors = failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`);
  return { changes: workspace.changes(), warnings, snippets, errors, failures };
}

export class PolicyError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** The policy of the repository; undefined when it has no depcurfew.json. Throws PolicyError when it cannot be used. */
export function loadPolicyIfPresent(root: string): ResolvedPolicy | undefined {
  const file = readPolicyFile(root);
  if (file.status === 'missing') return undefined;
  if (file.status === 'unreadable') throw new PolicyError(file.reason);
  const result = parsePolicy(file.text);
  if (!result.ok) throw new PolicyError(`${POLICY_FILE} is invalid`, result.issues.map(formatIssue));
  return result.policy;
}

export function loadPolicy(root: string): ResolvedPolicy {
  const policy = loadPolicyIfPresent(root);
  if (policy === undefined) throw new PolicyError(`no ${POLICY_FILE} in ${root}; run 'depcurfew init' first`);
  return policy;
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

