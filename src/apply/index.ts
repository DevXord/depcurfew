// `depcurfew apply`: turns the policy into configuration for every target tool. Package managers go first, so that
// bots can be given a delay at least as long as the longest one a manager enforces (otherwise a bot would
// propose versions the package manager then refuses to install).
import { join } from 'node:path';
import { detectProject } from '../detect/index.ts';
import { Repository } from '../detect/repository.ts';
import { denyConflictText, remainingConflicts } from '../doctor/allow-lists.ts';
import { UNREADABLE_WARNINGS } from '../doctor/unreadable-warnings.ts';
import type { Detection, VersionDeclaration, WorkflowJob } from '../detect/types.ts';
import { jobsInProject, npmInUse, rootPlaces, type NpmInUse, type RootPlaces } from '../doctor/rules/bundled-versions.ts';
import { SOURCE_LABEL } from '../doctor/rules/manager-version.ts';
import { environment as environmentKnowledge } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { Fact, ToolId, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { formatDuration, type Duration } from '../policy/duration.ts';
import { ecosystemOfTool, policyFor } from '../policy/ecosystem.ts';
import { isNewerThanRunning, outdatedText, projectCopy } from '../self-version.ts';
import { readPolicyFile } from '../policy/file.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { formatIssue, parsePolicy } from '../policy/validate.ts';
import { shortenedDelays } from './delays.ts';
import { isRecord, sinceOf, values } from './facts.ts';
import { foldCase, ignoredByGit, ignoresCase, trackedFiles } from './gitignore.ts';
import { bun } from './generators/bun.ts';
import { workspaceText } from './generators/common.ts';
import { createContext, EditFailed, type BotGenerator, type EditFailure, type ManagerGenerator, type Snippet } from './generators/context.ts';
import { deno } from './generators/deno.ts';
import { dependabot } from './generators/dependabot.ts';
import { npm } from './generators/npm.ts';
import { pip } from './generators/pip.ts';
import { pnpm } from './generators/pnpm.ts';
import { pdm } from './generators/pdm.ts';
import { pipenv } from './generators/pipenv.ts';
import { poetry } from './generators/poetry.ts';
import { renovate } from './generators/renovate.ts';
import { uv } from './generators/uv.ts';
import { yarn } from './generators/yarn.ts';
import { ManifestGuard, manifestNames } from './manifests.ts';
import { inProject, projectProblems, relocateText } from './projects.ts';
import { listing } from './requirements.ts';
import { directoryTargets } from './targets.ts';
import { parseVersion, pinnedVersion, type Version } from './version.ts';
import { warningText, type ApplyErrorCode, type ApplyWarning } from './warnings.ts';
import { CHANGED, OUTSIDE, WriteFailed, writeChanges, type FileChange } from './workspace.ts';
import { policyIssueLine } from '../doctor/policy-lines.ts';

export type { FileChange } from './workspace.ts';
export type { ProjectProblem } from './projects.ts';
export type { EditFailure, Snippet } from './generators/context.ts';

export interface ApplyReport {
  /** Repository-relative paths, also for the files of the directories listed in projects. */
  changes: FileChange[];
  /** The warnings as one line of text each. */
  warnings: string[];
  /** The same warnings with a code, the tool, the file and what to do (apply --json). */
  warningDetails: ApplyWarning[];
  snippets: Snippet[];
  /** Files that could not be edited, as messages. When there are any, nothing is written. */
  errors: string[];
  /** The same failures with the tool and the file. */
  failures: EditFailure[];
  /**
   * Directories listed in projects that cannot be used (decision D-100); their messages come first in `errors`, and
   * nothing is written when there is one.
   */
  problems?: ApplyProblem[];
}

/** An error that concerns no file being edited (a directory listed in projects, the home directory of apply --user). */
export interface ApplyProblem {
  code: ApplyErrorCode;
  location: { file: string; line?: number };
  message: string;
  fix: string;
}

/** How a directory is planned in a repository with projects (decision D-100). */
export interface PlanOptions {
  /** The directory is the project listed so in projects (relative to the repository root): bots are not configured there. */
  project?: string;
  /** The directory is the root of a repository with projects: what the projects configure, which bots serve too. */
  projects?: { managerMinutes: readonly number[]; targets: ReadonlySet<ToolId> };
  /**
   * The project's installs in CI jobs of the repository root (working-directory: frontend), with their Node.js setup
   * steps, for the npm the project runs (decision D-105); jobsInProject gives them.
   */
  ci?: { jobs: readonly WorkflowJob[]; versions: readonly VersionDeclaration[] };
  /**
   * What the project takes from the repository root (decision D-109): the root's Node.js version files when it has none
   * of its own, and the stages of root Dockerfiles that build it; rootPlaces gives them.
   */
  root?: RootPlaces;
}

/** What a plan configured, for the plan of the root in a repository with projects (and doctor's). */
export interface PlanDetails {
  /** The delays the package managers were given, in minutes. */
  managerMinutes: readonly number[];
  /** The tools configured. */
  targets: ReadonlySet<ToolId>;
}

const DETAILS = new WeakMap<ApplyReport, PlanDetails>();

/** What planApply configured for this report; undefined for a report it did not make. */
export function planDetails(report: ApplyReport): PlanDetails | undefined {
  return DETAILS.get(report);
}

const MANAGERS: Partial<Record<ToolId, ManagerGenerator>> = { npm, pnpm, yarn, bun, deno, uv, pip, poetry, pdm, pipenv };
const BOTS: Partial<Record<ToolId, BotGenerator>> = { renovate, dependabot };

function latestVersion(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['latestVersion'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'string' ? value : undefined;
}

/** Detection warnings about a file it could not read or parse (the codes of unreadable-config for single files). */
const FILE_UNREADABLE = new Set(['invalid-file', 'file-too-large', 'unreadable-file', 'outside-repository', 'not-a-regular-file']);

/** Where a repository can pin the version of a tool, for the warning when none is pinned. */
/** Where the version of a tool can be pinned, or undefined when the project cannot pin it (PDM, Pipenv). */
function pinPlaces(tool: ToolKnowledge): string | undefined {
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
  if (places.length === 0) return undefined;
  return places.length === 1 ? places[0] : `${places.slice(0, -1).join(', ')} or ${places.at(-1) ?? ''}`;
}

function pinFix(tool: ToolKnowledge): string {
  const places = pinPlaces(tool);
  if (places !== undefined) return `Pin the version you use (${places}) to configure for it`;
  return `Use ${tool.name} ${latestVersion(tool) ?? 'latest'} or a recent version wherever the project is installed; ${tool.name} has no setting that pins its version in the project`;
}

/** The bots' delay: the policy's, or longer if a package manager rounded its delay up further. */
export function botDuration(policy: Duration, managerMinutes: readonly number[]): Duration {
  const minutes = Math.max(policy.minutes, ...managerMinutes);
  return minutes === policy.minutes ? policy : { text: formatDuration(Math.ceil(minutes)), minutes: Math.ceil(minutes) };
}

/**
 * apply only adds to install-script allow-lists and never changes an entry it did not write (decision D-088), so a
 * package someone listed by hand keeps running its scripts after the policy denies them, and a hand-written denial
 * keeps blocking a package the policy allows; say so, and what to do about it.
 */
function allowListWarnings(root: string, workspace: ManifestGuard, policy: ResolvedPolicy, detection: Detection, targets: ReadonlySet<ToolId>, tools: readonly ToolKnowledge[]): ApplyWarning[] {
  if (policy.installScripts?.default !== 'deny') return [];
  const repository = new Repository(root);
  const planned = workspaceText(workspace);
  return detection.packageManagers
    .filter((manager) => manager.supported && targets.has(manager.id))
    .flatMap((manager) => {
      const tool = tools.find((entry) => entry.id === manager.id);
      const scripts = policyFor(policy, tool === undefined ? 'npm' : ecosystemOfTool(tool)).installScripts ?? { allow: [], deny: [] };
      const version = pinnedVersion(manager) ?? (tool === undefined ? undefined : parseVersion(latestVersion(tool) ?? ''));
      const options = { ...(tool === undefined ? {} : { tool }), ...(version === undefined ? {} : { version }) };
      return remainingConflicts(repository, planned, manager.id, manager.configFiles, options, scripts).map((conflict): ApplyWarning => {
        const { entry } = conflict;
        const location = { file: entry.file, ...(entry.line === undefined ? {} : { line: entry.line }) };
        if (conflict.kind === 'outside') {
          return {
            code: 'allow-list-entry-outside-policy',
            tool: manager.id,
            location,
            message: `${entry.setting} in ${entry.file}${entry.line === undefined ? '' : ` (line ${entry.line})`} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it; depcurfew apply does not remove entries it did not write`,
            fix: `Remove ${entry.name} from ${entry.setting} by hand, or add ${entry.package} to installScripts.allow in ${POLICY_FILE}`,
          };
        }
        const text = denyConflictText({ kind: conflict.kind, entry }, true);
        return { code: 'deny-conflicts-with-file', tool: manager.id, location, message: `${text.message}; depcurfew apply does not change entries it did not write`, fix: text.fix };
      });
    });
}

/**
 * file-ignored-by-git: a file apply writes that git does not pick up, so the protection never reaches the repository
 * and a fresh clone lacks it. Files git already tracks are not affected by .gitignore.
 */
/** The tracked files in lower case, for a repository that ignores case. */
function foldedSet(files: Set<string> | undefined): Set<string> | undefined {
  return files === undefined ? undefined : new Set([...files].map(foldCase));
}

function ignoredFileWarnings(root: string, changes: readonly FileChange[]): ApplyWarning[] {
  const repository = new Repository(root);
  const cache: Parameters<typeof ignoredByGit>[2] = new Map();
  let tracked: Set<string> | undefined | null = null;
  let ignoreCase: boolean | undefined;
  return changes.flatMap((change): ApplyWarning[] => {
    let result: ReturnType<typeof ignoredByGit>;
    try {
      ignoreCase ??= ignoresCase(repository);
      result = ignoredByGit(repository, change.file, cache, { ignoreCase });
      if (result.ignored === true) tracked ??= ignoreCase ? foldedSet(trackedFiles(repository)) : trackedFiles(repository);
    } catch {
      // The warning only helps; .gitignore and the index come from the repository, so they never stop apply.
      return [];
    }
    if (result.ignored !== true) return [];
    if (tracked?.has(ignoreCase === true ? foldCase(change.file) : change.file) === true) return [];
    const { rule } = result;
    // A pattern can be as long as a line of the file; the warning names it, shortened, and the line.
    const pattern = rule.pattern.length > 120 ? `${rule.pattern.slice(0, 117)}...` : rule.pattern;
    // A file apply creates cannot be tracked yet; for one it updates, only the index can tell.
    const unless = change.before === null || tracked !== undefined ? '' : ' unless git already tracks it';
    return [
      {
        code: 'file-ignored-by-git',
        location: { file: rule.file, line: rule.line },
        message: `${change.file} matches the rule ${pattern} in ${rule.file} (line ${rule.line}), so git ignores it${unless}: what depcurfew apply writes there stays on this machine, and a fresh clone (CI included) does not get it`,
        fix: `Remove ${pattern} from ${rule.file}, or add the file with git add -f ${change.file}, then commit it`,
      },
    ];
  });
}

/**
 * Computes every change of one directory without writing anything. With projects in the policy, `options` says which
 * part of the repository this directory is (planRepository plans them all).
 */
export function planApply(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase, options: PlanOptions = {}): ApplyReport {
  const workspace = new ManifestGuard(root, manifestNames(tools));
  const warnings: ApplyWarning[] = [];
  const snippets: Snippet[] = [];
  const failures: EditFailure[] = [];
  const copy = projectCopy(new Repository(root));
  if (copy !== undefined && isNewerThanRunning(copy)) {
    const text = outdatedText(copy, 'apply', true);
    warnings.push({ code: 'depcurfew-outdated', location: { file: copy.file, ...(copy.line === undefined ? {} : { line: copy.line }) }, message: text.message, fix: text.fix });
  }
  const { targets, auto } = directoryTargets(root, policy, detection, tools, { ...(options.project === undefined ? {} : { project: options.project }), withProjects: options.project !== undefined || options.projects !== undefined });
  // A tool a project configures appears in the workflows of the root, which set up every project.
  for (const entry of (auto?.ciOnly ?? []).filter((item) => options.projects?.targets.has(item.id) !== true)) {
    const tool = tools.find((item) => item.id === entry.id);
    const name = tool?.name ?? entry.id;
    warnings.push({
      code: 'tool-only-in-ci',
      tool: entry.id,
      location: { file: entry.workflows[0] ?? '' },
      message: `${name} appears only in a CI setup step (${listing(entry.workflows)}); the repository has no ${listing(entry.manifests)}, lockfile or ${name} configuration, so nothing is written for it`,
      fix: `If ${name} installs packages for this project, add "${entry.id}" to targets in ${POLICY_FILE} and run depcurfew apply again`,
    });
  }
  for (const manager of detection.packageManagers) {
    if (!manager.supported && (policy.targets === 'auto' || targets.has(manager.id))) {
      const berry = tools.find((tool) => tool.id === manager.id);
      const since = berry === undefined ? undefined : sinceOf(berry.cooldown.availableSince);
      const advice =
        manager.variant === 'classic' && berry !== undefined
          ? `Move to ${berry.name}${since === undefined ? '' : ` ${since} or later`}, or to another package manager depcurfew configures`
          : `Configure ${manager.id} by hand, or move to a package manager depcurfew configures`;
      warnings.push({
        code: 'tool-not-supported',
        tool: manager.id,
        message: `${manager.variant === 'classic' ? 'Yarn Classic (1.x)' : manager.id} is not supported; nothing written for it`,
        fix: advice,
      });
      targets.delete(manager.id);
    }
  }
  // A file detection could not read or parse (too large, a symlink out of the repository, no permission, invalid) may
  // hide a tool; nothing is written into it, but the user should know, as doctor reports it as unreadable-config.
  for (const warning of detection.warnings) {
    const fix = FILE_UNREADABLE.has(warning.code) ? UNREADABLE_WARNINGS[warning.code] : undefined;
    if (fix === undefined) continue;
    const file = warning.files[0];
    warnings.push({
      code: 'file-unreadable',
      ...(file === undefined ? {} : { location: { file } }),
      // A YAML error's first line ends with the colon of a code excerpt that is not shown.
      message: `${warning.message.replace(/:$/u, '')}; depcurfew cannot tell which tools it configures`,
      fix: warning.code === 'invalid-file' ? `Fix the syntax error${file === undefined ? '' : ` in ${file}`}, then run depcurfew apply again` : `${fix}, then run depcurfew apply again`,
    });
  }
  // The root of a repository with projects may hold nothing but the projects.
  if (targets.size === 0 && options.project !== undefined) {
    // relocateReport puts the name of the project in front of a message without a file.
    const excluded = policy.targets === 'auto' ? [] : detection.packageManagers.filter((manager) => manager.supported && !policy.targets.includes(manager.id)).map((manager) => manager.id);
    const names = excluded.map((id) => tools.find((tool) => tool.id === id)?.name ?? id);
    warnings.push(
      excluded.length > 0
        ? {
            code: 'nothing-to-configure',
            message: `no tools to configure: ${options.project} uses ${listing(names)}, but targets in ${POLICY_FILE} does not list ${names.length === 1 ? 'it' : 'them'}`,
            fix: `Add ${listing(excluded.map((id) => `"${id}"`))} to targets in ${POLICY_FILE} to configure ${options.project}, or remove "${options.project}" from projects if depcurfew should leave it alone`,
          }
        : {
            code: 'nothing-to-configure',
            message: 'no tools to configure: depcurfew found no supported package manager there',
            fix: `Check that "${options.project}" in projects in ${POLICY_FILE} is the directory of the project, with its manifest and lockfile; depcurfew explain shows what it detects`,
          },
    );
  } else if (targets.size === 0 && options.projects === undefined) {
    warnings.push({
      code: 'nothing-to-configure',
      message: 'no tools to configure: depcurfew found no supported package manager or bot here',
      fix: 'Run depcurfew explain to see what depcurfew detects',
    });
  }

  // Package managers see the policy of their registry; bots serve both and get all of it, and the package managers of
  // every project too.
  const botTargets = new Set<ToolId>([...targets, ...(options.projects?.targets ?? [])]);
  const run = (tool: ToolKnowledge, version: Version | undefined, action: (context: ReturnType<typeof createContext>) => void, inUse?: readonly NpmInUse[]) => {
    const view = tool.kind === 'package-manager' ? policyFor(policy, ecosystemOfTool(tool)) : policy;
    const context = createContext({
      tool,
      tools,
      targets: tool.kind === 'package-manager' ? targets : botTargets,
      policy: view,
      version,
      workspace,
      warnings,
      snippets,
      failures,
      ...(inUse === undefined ? {} : { inUse }),
      ...(options.project === undefined ? {} : { project: options.project }),
    });
    workspace.startTool(tool.id);
    try {
      action(context);
    } catch (error) {
      if (!(error instanceof EditFailed)) throw error;
    }
    context.finish();
    for (const skipped of workspace.skipped()) {
      const settings = skipped.settings.length === 0 ? `${tool.name}'s settings` : listing(skipped.settings);
      warnings.push({
        code: 'manifest-missing',
        tool: tool.id,
        location: { file: skipped.file },
        message: `${tool.name}: there is no ${skipped.file}, so ${settings} ${skipped.count === 1 ? 'is' : 'are'} not written; depcurfew does not create project manifests`,
        fix:
          policy.targets === 'auto'
            ? `If ${tool.name} installs packages for this project, create ${skipped.file} first, then run depcurfew apply again`
            : `If ${tool.name} installs packages for this project, create ${skipped.file} first, then run depcurfew apply again; otherwise remove "${tool.id}" from targets in ${POLICY_FILE}`,
      });
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
      warnings.push({
        code: 'version-not-pinned',
        tool: tool.id,
        message: `${tool.name}: no exact version is pinned, so depcurfew configures for ${tool.name} ${latest ?? 'latest'}, the latest version it knows`,
        fix: pinFix(tool),
      });
    }
    run(
      tool,
      version,
      (context) => {
        const minutes = generator(context);
        if (minutes !== undefined) managerMinutes.push(minutes);
      },
      tool.id === 'npm' && manager !== undefined ? npmVersionsInUse(root, detection, policy, options) : undefined,
    );
  }

  const duration = policy.cooldown === undefined ? undefined : botDuration(policy.cooldown.minimum, [...managerMinutes, ...(options.projects?.managerMinutes ?? [])]);
  for (const tool of tools) {
    const generator = BOTS[tool.id];
    if (generator === undefined || !targets.has(tool.id)) continue;
    run(tool, undefined, (context) => generator(context, duration));
  }

  warnings.push(...allowListWarnings(root, workspace, policy, detection, targets, tools));
  const changes = workspace.changes();
  if (policy.cooldown !== undefined) warnings.push(...shortenedDelays(root, changes, detection, tools, targets, policy.cooldown.minimum.text));
  // A project's files may match a .gitignore of the root, which planRepository reads for all of them.
  if (options.project === undefined) warnings.push(...ignoredFileWarnings(root, changes));
  const errors = failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`);
  const report: ApplyReport = { changes, warnings: warnings.map(warningText), warningDetails: warnings, snippets, errors, failures };
  DETAILS.set(report, { managerMinutes, targets });
  return report;
}

/**
 * The npm versions a directory runs (decisions D-105 and D-109): the versions declared for npm (the pin for the whole
 * repository among them), the npm of the declared Node.js versions and the npm CI jobs and Dockerfiles install. At the
 * root of a repository with projects, CI installs in a project's directory and root Dockerfile stages that build a
 * project belong to that project; a project gets them, and the root's version files, through options.ci and options.root.
 */
function npmVersionsInUse(root: string, detection: Detection, policy: ResolvedPolicy, options: PlanOptions): NpmInUse[] {
  const manifest = new Repository(root).parseOnce('package.json', (text) => JSON.parse(text) as unknown);
  return npmInUse(detection, manifest, (declaration) => SOURCE_LABEL[declaration.source], {
    projects: options.project === undefined ? policy.projects : [],
    ...(options.ci === undefined ? {} : { extra: options.ci }),
    ...(options.root === undefined ? {} : { root: options.root }),
  });
}

/**
 * The plan options of a directory listed in projects: its name, the installs root CI jobs run in it, and what it takes
 * from the root (its version files and Dockerfile stages, rootPlaces); `detection` is the project's.
 */
export function projectPlanOptions(rootDetection: Detection, project: string, detection?: Detection): PlanOptions {
  const ci = jobsInProject(rootDetection, project);
  const root = rootPlaces(rootDetection, project, detection);
  return { project, ...(ci.jobs.length === 0 ? {} : { ci }), ...(root.versions.length === 0 && root.dockerfiles.length === 0 ? {} : { root }) };
}

/** The files a message about a project may name, relative to the project: what detection found and what the plan touched. */
export function projectFiles(detection: Detection, report?: ApplyReport): Set<string> {
  const files = new Set<string>([
    ...detection.npmrcFiles,
    ...detection.workflows,
    ...detection.warnings.flatMap((warning) => warning.files),
    // Node.js version files and Dockerfiles, which the messages about the npm a project runs name (decision D-105).
    ...detection.node.versions.map((declaration) => declaration.file),
    ...detection.dockerfiles.map((dockerfile) => dockerfile.file),
  ]);
  for (const manager of detection.packageManagers) {
    for (const file of [...manager.evidence.map((item) => item.file), ...manager.configFiles, ...manager.versions.map((item) => item.file)]) files.add(file);
  }
  for (const bot of detection.bots) for (const file of bot.configFiles) files.add(file);
  for (const declaration of detection.workspaces?.declarations ?? []) files.add(declaration.file);
  if (report !== undefined) {
    for (const change of report.changes) files.add(change.file);
    for (const failure of report.failures) files.add(failure.file);
    for (const snippet of report.snippets) files.add(snippet.file);
    for (const warning of report.warningDetails) if (warning.location !== undefined) files.add(warning.location.file);
  }
  return files;
}

/** The plan of a project with every file named relative to the repository root, in paths and in messages. */
function relocateReport(project: string, report: ApplyReport, detection: Detection): ApplyReport {
  const files = projectFiles(detection, report);
  const text = (value: string) => relocateText(value, project, files);
  const warningDetails = report.warningDetails.map((warning): ApplyWarning => {
    const { code, location, message, fix, ...rest } = warning;
    return {
      code,
      project,
      ...rest,
      ...(location === undefined ? {} : { location: { ...location, file: inProject(project, location.file) } }),
      // Every warning of a project says which project it is about, also one with a file (decision D-111).
      message: `${project}: ${text(message)}`,
      ...(fix === undefined ? {} : { fix: text(fix) }),
    };
  });
  return {
    changes: report.changes.map((change) => ({ ...change, file: inProject(project, change.file) })),
    warnings: warningDetails.map(warningText),
    warningDetails,
    snippets: report.snippets.map((snippet) => ({ ...snippet, file: inProject(project, snippet.file) })),
    errors: report.errors.map(text),
    failures: report.failures.map((failure) => ({ ...failure, file: inProject(project, failure.file), message: text(failure.message) })),
  };
}

function byFile(a: FileChange, b: FileChange): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/**
 * Plans the whole repository: the root as planApply does, and each directory listed in projects as a project of its
 * own with the same policy (decision D-100). Bots are configured only from the root, with a delay at least as long
 * as any package manager of any project gets. Every path is relative to the root. A listed directory that cannot be
 * used is an error (`problems`), so that nothing is written; the other directories are still planned, so one run
 * reports everything.
 */
export function planRepository(root: string, policy: ResolvedPolicy, tools: readonly ToolKnowledge[] = knowledgeBase, rootDetection: Detection = detectProject(root, tools)): ApplyReport {
  if (policy.projects.length === 0) return planApply(root, policy, rootDetection, tools);
  const problems = projectProblems(root, policy.projects, rootDetection);
  const projects = policy.projects
    .filter((project) => !problems.some((problem) => problem.project === project))
    .map((project) => {
      const directory = join(root, project);
      const detection = detectProject(directory, tools);
      const report = planApply(directory, policy, detection, tools, projectPlanOptions(rootDetection, project, detection));
      return { project, detection, report, details: planDetails(report) };
    });
  const projectTargets = new Set(projects.flatMap((entry) => [...(entry.details?.targets ?? [])]));
  const rootReport = planApply(root, policy, rootDetection, tools, {
    projects: { managerMinutes: projects.flatMap((entry) => entry.details?.managerMinutes ?? []), targets: projectTargets },
  });
  const rootDetails = planDetails(rootReport);
  const relocated = projects.map((entry) => relocateReport(entry.project, entry.report, entry.detection));
  const projectChanges = relocated.flatMap((entry) => entry.changes);
  const warningDetails = [...rootReport.warningDetails, ...relocated.flatMap((entry) => entry.warningDetails), ...ignoredFileWarnings(root, projectChanges)];
  const configured = new Set([...(rootDetails?.targets ?? []), ...projectTargets]);
  // With listed targets, a package manager that no directory uses is configured nowhere (decision D-100).
  if (policy.targets !== 'auto') {
    for (const id of policy.targets.filter((entry) => !configured.has(entry) && tools.find((tool) => tool.id === entry)?.kind === 'package-manager')) {
      const name = tools.find((tool) => tool.id === id)?.name ?? id;
      warningDetails.push({
        code: 'target-not-found',
        tool: id,
        message: `${name} is listed in targets, but neither the repository root nor a directory in projects uses it, so nothing is written for it`,
        fix: `Add the directory of the ${name} project to projects in ${POLICY_FILE}, or remove "${id}" from targets`,
      });
    }
  }
  const report: ApplyReport = {
    changes: [...rootReport.changes, ...projectChanges].sort(byFile),
    warnings: warningDetails.map(warningText),
    warningDetails,
    snippets: [...rootReport.snippets, ...relocated.flatMap((entry) => entry.snippets)],
    errors: [...problems.map((problem) => problem.message), ...rootReport.errors, ...relocated.flatMap((entry) => entry.errors)],
    failures: [...rootReport.failures, ...relocated.flatMap((entry) => entry.failures)],
    problems,
  };
  DETAILS.set(report, { managerMinutes: [...(rootDetails?.managerMinutes ?? []), ...projects.flatMap((entry) => entry.details?.managerMinutes ?? [])], targets: configured });
  return report;
}

export class PolicyError extends Error {
  readonly issues: string[];
  readonly code: ApplyErrorCode;
  /** What to do, when the message does not say it. */
  readonly fix: string | undefined;
  /** The line of the policy file the first problem concerns, when it can be found (decision D-116). */
  readonly line: number | undefined;

  constructor(message: string, issues: string[] = [], code: ApplyErrorCode = 'policy-invalid', fix?: string, line?: number) {
    super(message);
    this.issues = issues;
    this.code = code;
    this.fix = fix;
    this.line = line;
  }

  /** The message and what to do, as one line of text. */
  get text(): string {
    return this.fix === undefined ? this.message : `${this.message}; ${this.fix.charAt(0).toLowerCase()}${this.fix.slice(1)}`;
  }
}

/** What to do about a policy that cannot be used, the same in doctor and in the JSON of apply and check. */
export function policyErrorFix(error: PolicyError): string {
  if (error.fix !== undefined) return error.fix;
  return error.code === 'policy-unreadable'
    ? `Make ${POLICY_FILE} a regular file inside the repository that the user running depcurfew can read`
    : `Fix these problems in ${POLICY_FILE}; an editor that reads its $schema shows them as you type`;
}

/** The policy of the repository; undefined when it has no depcurfew.json. Throws PolicyError when it cannot be used. */
export function loadPolicyIfPresent(root: string): ResolvedPolicy | undefined {
  const file = readPolicyFile(root);
  if (file.status === 'missing') return undefined;
  if (file.status === 'unreadable') throw new PolicyError(file.reason, [], 'policy-unreadable');
  const result = parsePolicy(file.text);
  if (!result.ok) throw new PolicyError(`${POLICY_FILE} is invalid`, result.issues.map(formatIssue), 'policy-invalid', undefined, policyIssueLine(file.text, result.issues));
  return result.policy;
}

export function loadPolicy(root: string): ResolvedPolicy {
  const policy = loadPolicyIfPresent(root);
  if (policy === undefined) throw new PolicyError(`no ${POLICY_FILE} in ${root}`, [], 'policy-missing', "Run 'depcurfew init' first");
  return policy;
}

/**
 * A file could not be written (code cannot-write). The files apply had already replaced were put back, so the
 * repository is as it was, unless `unrestored` lists files. `report` is the plan that was being written.
 */
export class ApplyWriteError extends Error {
  readonly code = 'cannot-write' as const satisfies ApplyErrorCode;
  /** The file that could not be written, relative to the repository. */
  readonly file: string;
  /** What to do. */
  readonly fix: string;
  /** Files already replaced that could not be put back (normally none). */
  readonly unrestored: string[];
  readonly report: ApplyReport;

  /**
   * `command` is what the fix tells the user to run again (depcurfew apply --user for user files), and
   * `versionControl` whether the files may be in version control, to restore them from.
   */
  constructor(failure: WriteFailed, report: ApplyReport, options: { command?: string; versionControl?: boolean } = {}) {
    super(`cannot write ${failure.file}: ${failure.message}`);
    this.file = failure.file;
    this.unrestored = failure.unrestored;
    this.report = report;
    const command = options.command ?? 'depcurfew apply';
    const versionControl = options.versionControl ?? true;
    const code = (failure.cause as NodeJS.ErrnoException | undefined)?.code;
    const fixes: Record<string, string> = {
      EROFS: `Run ${command} where the files can be written`,
      ENOSPC: `Free some disk space, then run ${command} again`,
      EDQUOT: `Free some disk space, then run ${command} again`,
      EISDIR: `Move the directory ${failure.file} out of the way, then run ${command} again`,
      [OUTSIDE]: `Make every directory on the way to ${failure.file} a real directory inside ${versionControl ? 'the repository' : 'your home directory'} rather than a symlink, then run ${command} again`,
      [CHANGED]: `Make sure no other program moves the directories on the way to ${failure.file}, then run ${command} again`,
    };
    const quoted = /\s/u.test(failure.file) ? `"${failure.file}"` : failure.file;
    const busy = !failure.busy
      ? undefined
      : failure.platform === 'win32'
        ? `Close the program that has ${failure.file} open (an editor or a sync client; a virus scan ends by itself), clear the read-only attribute if it is set (attrib -r ${quoted}), then run ${command} again`
        : `Close the program that has ${failure.file} open, then run ${command} again`;
    const fix = busy ?? (code === undefined ? undefined : fixes[code]) ?? `Make ${failure.file} and its directory writable for the user that runs depcurfew, then run ${command} again`;
    const withBackup = this.unrestored.filter((file) => failure.backups[file] !== undefined);
    const withoutBackup = this.unrestored.filter((file) => failure.backups[file] === undefined);
    this.fix = [
      ...withBackup.map((file) => `Restore ${file} from ${failure.backups[file] as string}, which holds its earlier text${versionControl ? ', or from version control' : ''}.`),
      ...(withoutBackup.length === 0 ? [] : [`Restore ${withoutBackup.join(', ')} from ${versionControl ? 'version control or ' : ''}a backup.`]),
      ...(failure.leftovers.length === 0 ? [] : [`Delete ${failure.leftovers.join(', ')}.`]),
      fix,
    ].join(' ');
  }
}

/**
 * Reads the policy, detects the project, plans the changes and (unless told otherwise) writes them. If any file
 * could not be edited, nothing is written, so a run either applies the whole policy or leaves the repository as it was.
 * A file that cannot be written throws ApplyWriteError after the files already written are put back.
 */
export function applyProject(root: string, options: { write?: boolean; beforeWrite?: () => void } = {}): ApplyReport {
  const report = planRepository(root, loadPolicy(root));
  if (options.write !== false && report.errors.length === 0) {
    // Tests change the file system between the plan and the write here.
    options.beforeWrite?.();
    try {
      writeChanges(root, report.changes);
    } catch (error) {
      if (error instanceof WriteFailed) throw new ApplyWriteError(error, report);
      throw error;
    }
  }
  return report;
}

