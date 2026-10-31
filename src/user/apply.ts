// `depcurfew apply --user` (decision D-087): the user policy written into the user-level configuration of every tool
// that is installed (targets "auto") or listed, for the version read from its files or given with --for. Tools whose
// version is unknown get the settings of the latest version depcurfew knows, except where a value the installed
// version cannot parse would make every command fail (user.invalidValueFails): then nothing is written for them.
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { createContext, type EditFailure, type Snippet } from '../apply/generators/context.ts';
import { formatVersion, type Version } from '../apply/version.ts';
import { warningText, type ApplyWarning } from '../apply/warnings.ts';
import { Workspace, writeChanges, type FileChange } from '../apply/workspace.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { ecosystemOfTool, policyFor } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { reportProjectOnly, USER_GENERATORS, type UserTarget } from './generators.ts';
import { shownPath, userFileFor, userFilePath, type UserEnvironment } from './locate.ts';
import { findExecutable, installedVersion } from './versions.ts';

export interface UserChange extends FileChange {
  /** The absolute path of the file. */
  path: string;
}

export interface UserApplyReport {
  changes: UserChange[];
  warnings: string[];
  warningDetails: ApplyWarning[];
  snippets: Snippet[];
  errors: string[];
  failures: EditFailure[];
}

export interface UserApplyOptions {
  environment: UserEnvironment;
  /** Versions given with --for, which win over the ones read from files. */
  versions?: Partial<Record<ToolId, Version>>;
  tools?: readonly ToolKnowledge[];
}

interface Planned {
  report: UserApplyReport;
  /** Per workspace root, the changes to write. */
  roots: Map<string, FileChange[]>;
}

/** The nearest directory that exists, from `path` up: a workspace needs a real root. */
function existingAncestor(path: string, module: typeof posix): string {
  let current = path;
  for (;;) {
    try {
      if (existsSync(current) && statSync(current).isDirectory()) return current;
    } catch {
      // Not readable: go up.
    }
    const parent = module.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function invalidValueFails(tool: ToolKnowledge): boolean {
  return tool.user === undefined ? false : evidenceOf(tool.user.invalidValueFails).some((evidence) => evidence.value);
}

/** Which tools apply --user configures: the listed ones, or with "auto" the package managers found in PATH. */
function userTargets(policy: ResolvedPolicy, tools: readonly ToolKnowledge[], environment: UserEnvironment): ToolKnowledge[] {
  const managers = tools.filter((tool) => tool.kind === 'package-manager' && tool.user !== undefined);
  if (policy.targets !== 'auto') return managers.filter((tool) => (policy.targets as readonly ToolId[]).includes(tool.id));
  return managers.filter((tool) => findExecutable(tool.id, environment) !== undefined);
}

export function planUserApply(policy: ResolvedPolicy, options: UserApplyOptions): Planned {
  const tools = options.tools ?? knowledgeBase;
  const { environment } = options;
  const module = environment.platform === 'win32' ? win32 : posix;
  const warnings: ApplyWarning[] = [];
  const snippets: Snippet[] = [];
  const failures: EditFailure[] = [];
  const workspaces = new Map<string, Workspace>();
  const workspaceFor = (path: string): { workspace: Workspace; file: string } => {
    const root = existingAncestor(module.dirname(path), module);
    let workspace = workspaces.get(root);
    if (workspace === undefined) {
      workspace = new Workspace(root);
      workspaces.set(root, workspace);
    }
    return { workspace, file: module.relative(root, path).split(module.sep).join('/') };
  };

  const targets = userTargets(policy, tools, environment);
  const targetIds = new Set<ToolId>(targets.map((tool) => tool.id));
  if (targets.length === 0) {
    warnings.push({
      code: 'nothing-to-configure',
      message: 'no tools to configure: depcurfew found no supported package manager in PATH',
      fix: 'List the tools under targets in the user depcurfew.json, or install them first',
    });
  }
  // Tools that share a user file (npm and Deno read ~/.npmrc) are written by one generator call.
  const byFile = new Map<string, UserTarget[]>();
  for (const tool of targets) {
    const given = options.versions?.[tool.id];
    const installed = given === undefined ? installedVersion(tool.id, ecosystemOfTool(tool), environment) : undefined;
    const version = given ?? installed?.version;
    if (version === undefined) {
      if (invalidValueFails(tool)) {
        warnings.push({
          code: 'version-unknown',
          tool: tool.id,
          message: `${tool.name}: depcurfew cannot read the installed version from its files, and ${tool.name} stops every command on a value its version does not understand, so nothing is written for it`,
          fix: `Pass the version with --for ${tool.id}@<version> (${tool.id} --version shows it), then run depcurfew apply --user again`,
        });
        continue;
      }
    }
    const file = userFileFor(tool, version);
    if (file === null) {
      warnings.push({
        code: 'no-user-config',
        tool: tool.id,
        message: `${tool.name}${version === undefined ? '' : ` ${formatVersion(version)}`} has no user-level configuration file, so depcurfew apply --user writes nothing for it`,
        fix: `Run depcurfew apply in each project that uses ${tool.name}`,
      });
      continue;
    }
    const path = userFilePath(file, environment);
    if (path === undefined) continue;
    if (version === undefined) {
      warnings.push({
        code: 'version-not-pinned',
        tool: tool.id,
        message: `${tool.name}: depcurfew cannot read the installed version from its files, so it configures for the latest version it knows`,
        fix: `Pass the version with --for ${tool.id}@<version> (${tool.id} --version shows it) to configure for it`,
      });
    }
    const { workspace, file: relativeFile } = workspaceFor(path);
    const view = policyFor(policy, ecosystemOfTool(tool));
    const context = createContext({ tool, tools, targets: targetIds, policy: view, version, workspace, warnings, snippets, failures });
    const target: UserTarget = { context, file: relativeFile, shown: shownPath(path, environment) };
    const group = byFile.get(path) ?? [];
    group.push(target);
    byFile.set(path, group);
  }
  for (const group of byFile.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const generator = USER_GENERATORS[first.context.tool.id];
    if (generator === undefined) continue;
    try {
      generator(group);
    } catch {
      // The context recorded the failure; the other files are still planned.
    }
    for (const target of group) {
      reportProjectOnly(target);
      target.context.finish();
    }
  }

  const roots = new Map<string, FileChange[]>();
  const changes: UserChange[] = [];
  for (const [root, workspace] of workspaces) {
    const list = workspace.changes();
    if (list.length > 0) roots.set(root, list);
    for (const change of list) {
      const path = module.join(root, ...change.file.split('/'));
      changes.push({ ...change, file: shownPath(path, environment), path });
    }
  }
  const errors = failures.map((failure) => `${failure.file}: ${failure.message}`);
  return { report: { changes, warnings: warnings.map(warningText), warningDetails: warnings, snippets, errors, failures }, roots };
}

/** Writes the planned changes, one workspace root at a time; nothing is written when the plan has errors. */
export function writeUserChanges(planned: Planned): void {
  if (planned.report.errors.length > 0) return;
  for (const [root, changes] of planned.roots) writeChanges(root, changes);
}
