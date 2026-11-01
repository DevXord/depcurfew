// `depcurfew apply --user` (decision D-087): the user policy written into the user-level configuration of every tool
// that is installed (targets "auto") or listed, for the version read from its files or given with --for. Tools whose
// version is unknown get the settings of the latest version depcurfew knows, except where a value the installed
// version cannot parse would make every command fail (user.invalidValueFails): then nothing is written for them.
// Messages name the files as the user sees them (~/.config/uv/uv.toml), and the files of all tools, which live in
// different directories, are written all or none (decision D-091). A file that cannot be edited gets a fix for its
// problem, a key that a file read ahead of the user file overrides is reported (user-setting-overridden), and run as
// root in another user's home directory, what is created there belongs to that user (decision D-093).
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { createContext, EditFailed, type EditFailure, type Snippet } from '../apply/generators/context.ts';
import { formatVersion, type Version } from '../apply/version.ts';
import { warningText, type ApplyWarning } from '../apply/warnings.ts';
import { Workspace, writeChangeSets, type FileChange, type FileProblem } from '../apply/workspace.ts';
import { parseToml } from '../detect/toml.ts';
import { iniLines } from '../doctor/settings.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId, ToolKnowledge, UserFile } from '../knowledge/types.ts';
import { ecosystemOfTool, policyFor } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { readLimitedText } from '../read-limited.ts';
import { parseYamlDocument } from '../yaml-parse.ts';
import { reportProjectOnly, USER_GENERATORS, type UserTarget } from './generators.ts';
import { homeProblem, ownerOfNewUnderHome, type HomeProblem } from './home.ts';
import { locateUserFile, shownPath, userFilePath, type UserEnvironment } from './locate.ts';
import { listing } from '../apply/requirements.ts';
import { userPolicyPath } from './policy-path.ts';
import { environmentOverrides } from './variables.ts';
import { installedUserFile, uncertainUserFile, type UncertainUserFile } from './user-file.ts';
import { findExecutable, toolVersion } from './versions.ts';

export interface UserChange extends FileChange {
  /** The absolute path of the file. */
  path: string;
}

/** An error that concerns no single user file (the home directory does not exist), with its code. */
export type UserProblem = HomeProblem;

/** A user file that cannot be read or edited, with what to do about it in particular. */
export interface UserFailure extends EditFailure {
  fix: string;
}

export interface UserApplyReport {
  changes: UserChange[];
  warnings: string[];
  warningDetails: ApplyWarning[];
  snippets: Snippet[];
  /** Every error as one line: the problems first, then the files that cannot be edited (failures). */
  errors: string[];
  /** User files that cannot be read or edited, named as the user sees them (~/.npmrc), each with its fix. */
  failures: UserFailure[];
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
  environment: UserEnvironment;
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

/** The first line of an error, as the context records a failed edit: parsers put a code frame after it. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]?.replace(/:$/u, '') ?? '';
}

const COMMAND = 'depcurfew apply --user';
const FORMATS: Readonly<Record<UserFile['format'], string>> = { ini: 'INI', toml: 'TOML', yaml: 'YAML' };

/** The syntax error of a TOML or YAML text, with its line when the parser gives one; undefined when it parses. */
function syntaxError(format: UserFile['format'], text: string): { line?: number } | undefined {
  if (format === 'toml') {
    try {
      parseToml(text);
      return undefined;
    } catch (error) {
      const line = /^invalid TOML at line (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
      return line === undefined ? {} : { line: Number(line) };
    }
  }
  if (format === 'yaml') {
    const [error] = parseYamlDocument(text).errors;
    if (error === undefined) return undefined;
    const line = error.linePos?.[0].line;
    return line === undefined ? {} : { line };
  }
  return undefined;
}

/**
 * What to do about a user file apply --user cannot edit, for the reason the workspace recorded (a symlink, a file over
 * 1 MiB, ...), a syntax error in it, or anything else (a style depcurfew does not edit, whose message says what to do).
 * doctor --user gives the same fix.
 */
export function userFileFix(problem: FileProblem | { kind: 'syntax'; format: UserFile['format']; line?: number } | undefined, shown: string): string {
  const again = `then run ${COMMAND} again`;
  switch (problem?.kind) {
    case 'symlink':
      return `Replace the symlink ${shown} with the file it points to, so that ${COMMAND} can write it, or add the settings of the user policy to that file by hand`;
    case 'too-large':
      return `Make ${shown} smaller than 1 MiB, ${again}; or add the settings of the user policy by hand`;
    case 'not-utf8':
      return `Save ${shown} as UTF-8, ${again}`;
    case 'directory':
      return `Remove or rename the directory ${shown}, ${again}`;
    case 'not-a-file':
      return `Replace ${shown} with a regular file, or remove it, ${again}`;
    case 'not-a-directory':
      return `Move the file ${problem.part} out of the way, ${again}`;
    case 'unreadable':
      return problem.code === 'EACCES' || problem.code === 'EPERM'
        ? `Make ${shown} readable and writable for the user that runs depcurfew, ${again}`
        : `Make sure ${shown} can be read, ${again}`;
    case 'outside':
      return `Make the directory of ${shown} a real directory rather than a symlink, ${again}`;
    case 'syntax':
      return `Fix the ${FORMATS[problem.format]} error in ${shown}${problem.line === undefined ? '' : ` at line ${problem.line}`}, ${again}`;
    default:
      return `Do what the message says about ${shown}, ${again}; or add the settings of the user policy by hand`;
  }
}

/** The fix for a failure on `file` of a workspace: the reason it recorded, else a syntax error of the file's format. */
function failureFix(workspace: Workspace | undefined, file: string, format: UserFile['format'] | undefined, shown: string): string {
  const problem = workspace?.problem(file);
  if (problem !== undefined || workspace === undefined || format === undefined) return userFileFix(problem, shown);
  let text: string;
  try {
    text = workspace.read(file);
  } catch {
    return userFileFix(undefined, shown);
  }
  const syntax = syntaxError(format, text);
  return userFileFix(syntax === undefined ? undefined : { kind: 'syntax', format, ...syntax }, shown);
}

/** The INI keys of a text (lists without []) with their values in order and the line of the first. */
function iniValues(text: string, file: UserFile, managedOnly: boolean): Map<string, { values: string[]; line: number }> {
  const keys = new Map<string, { values: string[]; line: number }>();
  for (const entry of iniLines(text)) {
    if ((managedOnly && !entry.managed) || (file.sections !== undefined && !file.sections.includes(entry.section ?? ''))) continue;
    const key = entry.key.replace(/\[\]$/u, '');
    const known = keys.get(key);
    if (known === undefined) keys.set(key, { values: [entry.value], line: entry.line });
    else known.values.push(entry.value);
  }
  return keys;
}

const MAX_FILE = 1024 * 1024;

/**
 * user-file-uncertain: the version of the library that decides where the tool reads its user file (platformdirs for
 * Poetry and PDM on macOS) cannot be read, and its versions put the file in different places here. apply --user writes
 * where the tool's docs say, and names the other files and the variables that move it.
 */
function uncertainWarning(tool: ToolKnowledge, uncertain: UncertainUserFile): ApplyWarning {
  const { library } = uncertain;
  const files = uncertain.candidates.map((candidate) => `${candidate.shown} (${library} ${candidate.ranges.join(' or ')})`);
  const variables = listing(uncertain.variables);
  return {
    code: 'user-file-uncertain',
    tool: tool.id,
    location: { file: uncertain.shown },
    message: `${tool.name}: depcurfew cannot read the version of ${library} in ${tool.name}'s environment, which decides where ${tool.name} reads its user file here: ${files.join(', or ')}; depcurfew apply --user writes ${uncertain.shown}, where the ${tool.name} docs put it`,
    fix: `Look for the ${library}-<version>.dist-info folder next to ${tool.name}'s own in the site-packages folder of ${tool.name}'s environment to see which file ${tool.name} reads${uncertain.variables.length === 0 ? '' : `, or unset ${variables} so that every ${library} version reads ${uncertain.shown}`}, then run depcurfew apply --user again`,
  };
}

export function planUserApply(policy: ResolvedPolicy, options: UserApplyOptions): Planned {
  const tools = options.tools ?? knowledgeBase;
  const { environment } = options;
  const module = environment.platform === 'win32' ? win32 : posix;
  const name = (root: string, file: string) => shownPath(module.join(root, ...file.split('/')), environment);
  const warnings: ApplyWarning[] = [];
  const snippets: Snippet[] = [];
  const failures: UserFailure[] = [];
  const report = (changes: UserChange[], problems: UserProblem[]): UserApplyReport => ({
    changes,
    warnings: warnings.map(warningText),
    warningDetails: warnings,
    snippets,
    errors: [...problems.map((problem) => problem.message), ...failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`)],
    failures,
    problems,
  });

  const home = homeProblem(environment, 'apply');
  if (home !== undefined) return { report: report([], [home]), roots: new Map(), name, environment };

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

  const versionsUsed: Partial<Record<ToolId, Version | undefined>> = {};
  // Tools that share a user file (npm and Deno read ~/.npmrc) are written by one generator call.
  const byFile = new Map<string, UserTarget[]>();
  /** The failures each target's context records, with the file relative to its workspace root. */
  const recorded = new Map<UserTarget, { root: string; failures: EditFailure[] }>();
  /** Each configured target with its user file and the version in use, for the files read ahead of it. */
  const configured: Configured[] = [];
  for (const tool of targets) {
    const given = options.versions?.[tool.id];
    const installed = given === undefined ? toolVersion(tool, environment) : undefined;
    const version = given ?? installed?.version;
    versionsUsed[tool.id] = version;
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
    const file = installedUserFile(tool, version, environment);
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
      const { variable, value, file: relativeFile, path: fromCwd } = located.relative;
      warnings.push({
        code: 'user-directory-relative',
        tool: tool.id,
        message:
          fromCwd === undefined
            ? `${tool.name}: ${variable} is the relative path ${JSON.stringify(value)}, and depcurfew does not know where ${tool.name} looks for its user file then, so nothing is written for it`
            : `${tool.name}: ${variable} is the relative path ${JSON.stringify(value)}, so ${tool.name} reads ${relativeFile} relative to the directory each command runs in, a different file in each directory; nothing is written for it`,
        fix: `Set ${variable} to an absolute path, or unset it, then run depcurfew apply --user again`,
      });
      continue;
    }
    const { path } = located;
    const uncertain = uncertainUserFile(tool, version, environment);
    if (uncertain !== undefined) warnings.push(uncertainWarning(tool, uncertain));
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
    const context = createContext({ tool, tools, targets: targetIds, policy: view, version, workspace, warnings, snippets, failures: own, user: installed === undefined ? {} : { versionText: installed.text } });
    const target: UserTarget = { context, file: relativeFile, shown: shownPath(path, environment), policyFile };
    recorded.set(target, { root, failures: own });
    configured.push({ target, file, version });
    const group = byFile.get(path) ?? [];
    group.push(target);
    byFile.set(path, group);
  }
  // A variable that makes a tool read another file, or none, or override a value, would leave what apply writes
  // without effect; doctor --user names them too. Only the name is shown: a value may hold credentials.
  const overrides = environmentOverrides(environment, targets, versionsUsed);
  for (const name of new Set(overrides.map((override) => override.name))) {
    const forName = overrides.filter((override) => override.name === name);
    const toolNames = [...new Set(forName.map((override) => tools.find((tool) => tool.id === override.tool)?.name ?? override.tool))].join(', ');
    warnings.push({
      code: 'environment-overrides',
      message: `${name} is set in the environment and ${forName[0]?.effect ?? 'overrides the user-level configuration'} (${toolNames}), so what depcurfew apply --user writes may not take effect`,
      fix: `Unset ${name} in your shell profile or CI settings; depcurfew doctor --user lists every such variable`,
    });
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
      const format = configured.find((entry) => entry.target === target)?.file.format;
      for (const failure of own?.failures ?? []) {
        const mainFile = failure.file === target.file;
        const shown = mainFile ? target.shown : name(own?.root ?? '', failure.file);
        failures.push({ ...failure, file: shown, fix: failureFix(workspaces.get(own?.root ?? ''), failure.file, mainFile ? format : undefined, shown) });
      }
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
  overriddenSettings(configured, changes, failures, environment);
  return { report: report(changes, []), roots, name, environment };
}

interface Configured {
  target: UserTarget;
  file: UserFile;
  version: Version | undefined;
}

/**
 * user-setting-overridden: a key apply --user writes into a user file that a file the tool reads ahead of it
 * (UserFile.overriddenBy, ~/.npmrc for pnpm 10) sets to another value, so the written value has no effect. The file
 * read ahead is taken as it will be after this run, when apply --user changes it too.
 */
function overriddenSettings(configured: readonly Configured[], changes: readonly UserChange[], failures: readonly UserFailure[], environment: UserEnvironment): void {
  for (const { target, file, version } of configured) {
    const { context } = target;
    if (file.format !== 'ini' || failures.some((failure) => failure.file === target.shown)) continue;
    let mine: Map<string, { values: string[]; line: number }>;
    try {
      mine = iniValues(context.read(target.file), file, true);
    } catch {
      continue;
    }
    for (const other of file.overriddenBy ?? []) {
      const path = other.format === 'ini' ? userFilePath(other, environment) : undefined;
      if (path === undefined) continue;
      const text = changes.find((change) => change.path === path)?.after ?? readLimitedText(path, MAX_FILE);
      if (text === undefined) continue;
      const shown = shownPath(path, environment);
      const reader = version === undefined ? context.name : `${context.name} ${context.versionLabel}`;
      for (const [key, theirs] of iniValues(text, other, false)) {
        const ours = mine.get(key)?.values;
        if (ours === undefined || (ours.length === theirs.values.length && ours.every((value, index) => value === theirs.values[index]))) continue;
        context.warn({
          code: 'user-setting-overridden',
          location: { file: shown, line: theirs.line },
          message: `${context.name}: ${key}=${theirs.values.join(',')} in ${shown} (line ${theirs.line}) overrides the ${key}=${ours.join(',')} that depcurfew apply --user writes to ${target.shown}, because ${reader} reads ${shown} ahead of it`,
          fix: `Remove the ${key} ${theirs.values.length === 1 ? 'line' : 'lines'} from ${shown}, or ${ours.length === 1 ? `set it to ${ours[0] ?? ''} there` : `give it the values in ${target.shown}`}`,
        });
      }
    }
  }
}

/**
 * Writes the planned changes of every workspace root together: all files or none, so a file that cannot be written
 * puts back the ones already replaced, even in another directory. Nothing is written when the plan has errors.
 * Throws WriteFailed, which names the files as the user sees them.
 */
export function writeUserChanges(planned: Planned): void {
  if (planned.report.errors.length > 0) return;
  // Run as root in the home directory of another user (sudo with HOME kept), new files and directories there are theirs.
  const ownerOfNew = ownerOfNewUnderHome(planned.environment);
  writeChangeSets(
    [...planned.roots].map(([root, changes]) => ({ root, changes })),
    { name: planned.name, ...(ownerOfNew === undefined ? {} : { ownerOfNew }) },
  );
}
