// `depcurfew apply`: turns the policy into configuration for every target tool. Package managers go first, so that
// bots can be given a delay at least as long as the longest one a manager enforces (otherwise a bot would
// propose versions the package manager then refuses to install).
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
import { shortenedDelays } from './delays.ts';
import { isRecord, sinceOf, values } from './facts.ts';
import { ignoredByGit, trackedFiles } from './gitignore.ts';
import { bun } from './generators/bun.ts';
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
import { listing } from './requirements.ts';
import { autoTargets } from './targets.ts';
import { pinnedVersion, type Version } from './version.ts';
import { warningText, type ApplyErrorCode, type ApplyWarning } from './warnings.ts';
import { WriteFailed, writeChanges, type FileChange } from './workspace.ts';

export type { FileChange } from './workspace.ts';
export type { EditFailure, Snippet } from './generators/context.ts';

export interface ApplyReport {
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
}

const MANAGERS: Partial<Record<ToolId, ManagerGenerator>> = { npm, pnpm, yarn, bun, deno, uv, pip, poetry, pdm, pipenv };
const BOTS: Partial<Record<ToolId, BotGenerator>> = { renovate, dependabot };

function latestVersion(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['latestVersion'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'string' ? value : undefined;
}

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
 * apply only adds to install-script allow-lists, so a package someone listed by hand keeps running its scripts after
 * the policy denies them; say so, and what to do about it.
 */
function allowListWarnings(root: string, policy: ResolvedPolicy, detection: Detection, targets: ReadonlySet<ToolId>, tools: readonly ToolKnowledge[]): ApplyWarning[] {
  if (policy.installScripts?.default !== 'deny') return [];
  const repository = new Repository(root);
  return detection.packageManagers
    .filter((manager) => manager.supported && targets.has(manager.id))
    .flatMap((manager) => {
      const tool = tools.find((entry) => entry.id === manager.id);
      const allow = policyFor(policy, tool === undefined ? 'npm' : ecosystemOfTool(tool)).installScripts?.allow ?? [];
      return allowEntries(repository, manager.id, manager.configFiles)
        .filter((entry) => !allow.some((pattern) => matchesPattern(entry.package, pattern)))
        .map(
          (entry): ApplyWarning => ({
            code: 'allow-list-entry-outside-policy',
            tool: manager.id,
            location: { file: entry.file },
            message: `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it; depcurfew apply does not remove entries it did not write`,
            fix: `Remove ${entry.name} from ${entry.setting} by hand, or add ${entry.package} to installScripts.allow in ${POLICY_FILE}`,
          }),
        );
    });
}

/**
 * file-ignored-by-git: a file apply writes that git does not pick up, so the protection never reaches the repository
 * and a fresh clone lacks it. Files git already tracks are not affected by .gitignore.
 */
function ignoredFileWarnings(root: string, changes: readonly FileChange[]): ApplyWarning[] {
  const repository = new Repository(root);
  const cache: Parameters<typeof ignoredByGit>[2] = new Map();
  let tracked: Set<string> | undefined | null = null;
  return changes.flatMap((change): ApplyWarning[] => {
    let result: ReturnType<typeof ignoredByGit>;
    try {
      result = ignoredByGit(repository, change.file, cache);
      if (result.ignored === true) tracked ??= trackedFiles(repository);
    } catch {
      // The warning only helps; .gitignore and the index come from the repository, so they never stop apply.
      return [];
    }
    if (result.ignored !== true) return [];
    if (tracked?.has(change.file) === true) return [];
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

/** Computes every change without writing anything. */
export function planApply(root: string, policy: ResolvedPolicy, detection: Detection, tools: readonly ToolKnowledge[] = knowledgeBase): ApplyReport {
  const workspace = new ManifestGuard(root, manifestNames(tools));
  const warnings: ApplyWarning[] = [];
  const snippets: Snippet[] = [];
  const failures: EditFailure[] = [];
  const auto = policy.targets === 'auto' ? autoTargets(root, detection, tools) : undefined;
  const targets = new Set<ToolId>(policy.targets === 'auto' ? (auto?.targets ?? []) : policy.targets);
  for (const entry of auto?.ciOnly ?? []) {
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
  // A file detection could not parse may hide a tool; nothing is written into it, but the user should know.
  for (const warning of detection.warnings.filter((entry) => entry.code === 'invalid-file')) {
    const file = warning.files[0];
    warnings.push({
      code: 'file-unreadable',
      ...(file === undefined ? {} : { location: { file } }),
      // A YAML error's first line ends with the colon of a code excerpt that is not shown.
      message: `${warning.message.replace(/:$/u, '')}; depcurfew cannot tell which tools it configures`,
      fix: `Fix the syntax error${file === undefined ? '' : ` in ${file}`}, then run depcurfew apply again`,
    });
  }
  if (targets.size === 0) {
    warnings.push({
      code: 'nothing-to-configure',
      message: 'no tools to configure: depcurfew found no supported package manager or bot here',
      fix: 'Run depcurfew explain to see what depcurfew detects',
    });
  }

  // Package managers see the policy of their registry; bots serve both and get all of it.
  const run = (tool: ToolKnowledge, version: Version | undefined, action: (context: ReturnType<typeof createContext>) => void) => {
    const view = tool.kind === 'package-manager' ? policyFor(policy, ecosystemOfTool(tool)) : policy;
    const context = createContext({ tool, tools, targets, policy: view, version, workspace, warnings, snippets, failures });
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
  const changes = workspace.changes();
  if (policy.cooldown !== undefined) warnings.push(...shortenedDelays(root, changes, detection, tools, targets, policy.cooldown.minimum.text));
  warnings.push(...ignoredFileWarnings(root, changes));
  const errors = failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`);
  return { changes, warnings: warnings.map(warningText), warningDetails: warnings, snippets, errors, failures };
}

export class PolicyError extends Error {
  readonly issues: string[];
  readonly code: ApplyErrorCode;
  /** What to do, when the message does not say it. */
  readonly fix: string | undefined;

  constructor(message: string, issues: string[] = [], code: ApplyErrorCode = 'policy-invalid', fix?: string) {
    super(message);
    this.issues = issues;
    this.code = code;
    this.fix = fix;
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
  if (!result.ok) throw new PolicyError(`${POLICY_FILE} is invalid`, result.issues.map(formatIssue));
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

  constructor(failure: WriteFailed, report: ApplyReport) {
    super(`cannot write ${failure.file}: ${failure.message}`);
    this.file = failure.file;
    this.unrestored = failure.unrestored;
    this.report = report;
    const code = (failure.cause as NodeJS.ErrnoException | undefined)?.code;
    const fixes: Record<string, string> = {
      EROFS: 'Run depcurfew apply where the files can be written',
      ENOSPC: 'Free some disk space, then run depcurfew apply again',
      EDQUOT: 'Free some disk space, then run depcurfew apply again',
      EISDIR: `Move the directory ${failure.file} out of the way, then run depcurfew apply again`,
    };
    const fix = (code === undefined ? undefined : fixes[code]) ?? `Make ${failure.file} and its directory writable for the user that runs depcurfew, then run depcurfew apply again`;
    this.fix = this.unrestored.length === 0 ? fix : `Restore ${this.unrestored.join(', ')} from version control or a backup. ${fix}`;
  }
}

/**
 * Reads the policy, detects the project, plans the changes and (unless told otherwise) writes them. If any file
 * could not be edited, nothing is written, so a run either applies the whole policy or leaves the repository as it was.
 * A file that cannot be written throws ApplyWriteError after the files already written are put back.
 */
export function applyProject(root: string, options: { write?: boolean } = {}): ApplyReport {
  const report = planApply(root, loadPolicy(root), detectProject(root));
  if (options.write !== false && report.errors.length === 0) {
    try {
      writeChanges(root, report.changes);
    } catch (error) {
      if (error instanceof WriteFailed) throw new ApplyWriteError(error, report);
      throw error;
    }
  }
  return report;
}

