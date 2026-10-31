// `depcurfew apply --user` (decision D-087): the user policy written into the user-level configuration of every tool
// that is installed (targets "auto") or listed, for the version read from its files or given with --for. Tools whose
// version is unknown get the settings of the latest version depcurfew knows, except where a value the installed
// version cannot parse would make every command fail (user.invalidValueFails): then nothing is written for them.
// Messages name the files as the user sees them (~/.config/uv/uv.toml), and the files of all tools, which live in
// different directories, are written all or none (decision D-091).
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { createContext, EditFailed, type EditFailure, type Snippet } from '../apply/generators/context.ts';
import { formatVersion, type Version } from '../apply/version.ts';
import { warningText, type ApplyErrorCode, type ApplyWarning } from '../apply/warnings.ts';
import { Workspace, writeChangeSets, type FileChange } from '../apply/workspace.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { ecosystemOfTool, policyFor } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { reportProjectOnly, USER_GENERATORS, type UserTarget } from './generators.ts';
import { locateUserFile, shownPath, userFileFor, type UserEnvironment } from './locate.ts';
import { userPolicyPath } from './policy-path.ts';
import { findExecutable, installedVersion } from './versions.ts';

export interface UserChange extends FileChange {
  /** The absolute path of the file. */
  path: string;
}

/** An error that concerns no single user file (the home directory does not exist), with its code. */
export interface UserProblem {
  code: ApplyErrorCode;
  location: { file: string };
  message: string;
  fix: string;
}

export interface UserApplyReport {
  changes: UserChange[];
  warnings: string[];
  warningDetails: ApplyWarning[];
  snippets: Snippet[];
  /** Every error as one line: the problems first, then the files that cannot be edited (failures). */
  errors: string[];
  /** User files that cannot be read or edited, named as the user sees them (~/.npmrc). */
  failures: EditFailure[];
  /** Errors that concern no single file; nothing is planned when there is one. */
  problems: UserProblem[];
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
  /** How messages name a file of a workspace root: ~/.npmrc. */
  name: (root: string, file: string) => string;
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

/**
 * The home directory has to exist: every user file but those under an absolute XDG_CONFIG_HOME or APPDATA is in it,
 * and creating it (with mkdir -p) would make one for a system user such as nobody, whose HOME is /nonexistent.
 */
function homeProblem(environment: UserEnvironment, module: typeof posix): UserProblem | undefined {
  const { home } = environment;
  const variable = environment.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const fix = `Set ${variable} to an existing directory, or run depcurfew apply --user as a user who has a home directory`;
  const problem = (message: string): UserProblem => ({ code: 'home-missing', location: { file: home }, message, fix });
  if (!module.isAbsolute(home)) return problem(`the home directory ${JSON.stringify(home)} is not an absolute path, so depcurfew apply --user cannot tell where the user configuration is`);
  let stats;
  try {
    stats = statSync(home, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (stats === undefined) return problem(`the home directory ${home} does not exist, so depcurfew apply --user has nowhere to write the user configuration`);
  if (!stats.isDirectory()) return problem(`the home directory ${home} is not a directory, so depcurfew apply --user has nowhere to write the user configuration`);
  return undefined;
}

/** The first line of an error, as the context records a failed edit: parsers put a code frame after it. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]?.replace(/:$/u, '') ?? '';
}

export function planUserApply(policy: ResolvedPolicy, options: UserApplyOptions): Planned {
  const tools = options.tools ?? knowledgeBase;
  const { environment } = options;
  const module = environment.platform === 'win32' ? win32 : posix;
  const name = (root: string, file: string) => shownPath(module.join(root, ...file.split('/')), environment);
  const warnings: ApplyWarning[] = [];
  const snippets: Snippet[] = [];
  const failures: EditFailure[] = [];
  const report = (changes: UserChange[], problems: UserProblem[]): UserApplyReport => ({
    changes,
    warnings: warnings.map(warningText),
    warningDetails: warnings,
    snippets,
    errors: [...problems.map((problem) => problem.message), ...failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`)],
    failures,
    problems,
  });

  const home = homeProblem(environment, module);
  if (home !== undefined) return { report: report([], [home]), roots: new Map(), name };

  const workspaces = new Map<string, Workspace>();
  const workspaceFor = (path: string): { root: string; workspace: Workspace; file: string } => {
    const root = existingAncestor(module.dirname(path), module);
    let workspace = workspaces.get(root);
    if (workspace === undefined) {
      workspace = new Workspace(root, { name: (file) => name(root, file) });
      workspaces.set(root, workspace);
    }
    return { root, workspace, file: module.relative(root, path).split(module.sep).join('/') };
  };
  const policyFile = shownPath(userPolicyPath(environment), environment);

  const targets = userTargets(policy, tools, environment);
  const targetIds = new Set<ToolId>(targets.map((tool) => tool.id));
  if (targets.length === 0) {
    warnings.push(
      policy.targets === 'auto'
        ? {
            code: 'nothing-to-configure',
            message: 'no tools to configure: depcurfew found no supported package manager in PATH',
            fix: 'List the tools under targets in the user depcurfew.json, or install them first',
          }
        : {
            code: 'nothing-to-configure',
            message: `no tools to configure: targets in ${policyFile} lists no package manager, and depcurfew apply --user configures only package managers`,
            fix: `List the package managers under targets in ${policyFile}, or set targets to "auto" to configure the ones in PATH`,
          },
    );
  }
  // A version given for a tool that is not configured would otherwise be dropped without a word.
  for (const [id, version] of Object.entries(options.versions ?? {}) as [ToolId, Version | undefined][]) {
    if (version === undefined || targetIds.has(id)) continue;
    const tool = tools.find((candidate) => candidate.id === id);
    const toolName = tool?.name ?? id;
    const given = `--for ${id}@${formatVersion(version)}`;
    const because =
      tool?.user === undefined
        ? `depcurfew knows no user-level configuration of ${toolName}`
        : policy.targets === 'auto'
          ? `${toolName} is not in PATH and the user policy has targets "auto"`
          : `targets in ${policyFile} does not list ${toolName}`;
    warnings.push({
      code: 'version-not-used',
      tool: id,
      message: `${toolName}: ${given} is not used, because ${because}`,
      fix:
        tool?.user === undefined
          ? `Leave out ${given}`
          : policy.targets === 'auto'
            ? `Add "${id}" to targets in ${policyFile} to configure ${toolName} anyway, or leave out ${given}`
            : `Add "${id}" to targets in ${policyFile}, or leave out ${given}`,
    });
  }

  // Tools that share a user file (npm and Deno read ~/.npmrc) are written by one generator call.
  const byFile = new Map<string, UserTarget[]>();
  /** The failures each target's context records, with the file relative to its workspace root. */
  const recorded = new Map<UserTarget, { root: string; failures: EditFailure[] }>();
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
    const located = locateUserFile(file, environment);
    if (located === undefined) continue;
    if ('relative' in located) {
      const { variable, value } = located.relative;
      warnings.push({
        code: 'user-directory-relative',
        tool: tool.id,
        message: `${tool.name}: ${variable} is the relative path ${JSON.stringify(value)}, and depcurfew does not know where ${tool.name} looks for its user file then, so nothing is written for it`,
        fix: `Set ${variable} to an absolute path, or unset it, then run depcurfew apply --user again`,
      });
      continue;
    }
    const { path } = located;
    if (version === undefined) {
      warnings.push({
        code: 'version-not-pinned',
        tool: tool.id,
        message: `${tool.name}: depcurfew cannot read the installed version from its files, so it configures for the latest version it knows`,
        fix: `Pass the version with --for ${tool.id}@<version> (${tool.id} --version shows it) to configure for it`,
      });
    }
    const { root, workspace, file: relativeFile } = workspaceFor(path);
    const view = policyFor(policy, ecosystemOfTool(tool));
    const own: EditFailure[] = [];
    const context = createContext({ tool, tools, targets: targetIds, policy: view, version, workspace, warnings, snippets, failures: own });
    const target: UserTarget = { context, file: relativeFile, shown: shownPath(path, environment) };
    recorded.set(target, { root, failures: own });
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
    } catch (error) {
      // A failed edit through the context is recorded already; anything else (a file read straight from the
      // workspace, say) is recorded here, so that no file is skipped without an error. The other files are still planned.
      if (!(error instanceof EditFailed)) recorded.get(first)?.failures.push({ tool: first.context.tool.id, file: first.file, message: firstLine(error) });
    }
    for (const target of group) {
      reportProjectOnly(target);
      target.context.finish();
      const own = recorded.get(target);
      for (const failure of own?.failures ?? []) failures.push({ ...failure, file: failure.file === target.file ? target.shown : name(own?.root ?? '', failure.file) });
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
  return { report: report(changes, []), roots, name };
}

/**
 * Writes the planned changes of every workspace root together: all files or none, so a file that cannot be written
 * puts back the ones already replaced, even in another directory. Nothing is written when the plan has errors.
 * Throws WriteFailed, which names the files as the user sees them.
 */
export function writeUserChanges(planned: Planned): void {
  if (planned.report.errors.length > 0) return;
  writeChangeSets(
    [...planned.roots].map(([root, changes]) => ({ root, changes })),
    { name: planned.name },
  );
}
