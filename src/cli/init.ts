// `depcurfew init [directory] [--force] [--json]` and `depcurfew init --user`. What init says besides the file it
// writes (the projects it lists, the delay it keeps, what the default policy blocks) is a list of warnings and notes
// with a code (src/cli/init-codes.ts): one source for the text on stdout, where each has its level word, code and fix,
// and for the JSON document of --json (decision D-122). Errors are those of the other commands: on stderr, or with
// --json in the document on stdout, with the same exit codes.
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homeProblem, ownerOfNewUnderHome } from '../user/home.ts';
import { shownPath, type UserEnvironment } from '../user/locate.ts';
import { userPolicyPath } from '../user/policy-path.ts';
import { describeDelay, longestDelay, policyDuration, type ConfiguredDelay } from '../apply/delays.ts';
import { longestUserDelay } from '../user/delays.ts';
import { fileSystemReason, writeChanges } from '../apply/workspace.ts';
import { detectProject } from '../detect/index.ts';
import type { Detection } from '../detect/types.ts';
import { DEFAULT_POLICY, POLICY_FILE, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import type { ApplyErrorCode } from '../apply/warnings.ts';
import { autoTargets } from '../apply/targets.ts';
import { listing } from '../apply/requirements.ts';
import { inProject } from '../apply/projects.ts';
import { paint, type Paint } from '../color.ts';
import { jsonSetting } from '../doctor/settings.ts';
import { safeJson } from '../json-safe.ts';
import type { ToolId } from '../knowledge/types.ts';
import { printable } from '../printable.ts';
import { toolName } from './describe.ts';
import type { InitMessage } from './init-codes.ts';
import { proposedProjects } from './init-projects.ts';
import { hasBuildRecords } from '../doctor/python-lockfiles.ts';
import { checkDirectory, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';

export interface InitOptions {
  force: boolean;
  /** --json: one JSON document on stdout, nothing on stderr (decision D-122). */
  json: boolean;
}

/** A tool init detected, for the line "Detected tools" and the JSON document. */
interface DetectedTool {
  tool: ToolId;
  name: string;
  /** "." for the directory init works on, else the entry of projects. */
  directory: string;
  supported: boolean;
}

/** The JSON document of init --json; schemaVersion 1, and fields are only added within it. */
interface InitDocument {
  schemaVersion: 1;
  /** The policy file init writes, as the text names it; null when the directory does not exist or HOME is unusable. */
  policy: string | null;
  written: boolean;
  action: 'create' | 'overwrite' | null;
  projects: string[];
  /** null for init --user, which detects no tools. */
  tools: DetectedTool[] | null;
  warnings: InitMessage[];
  notices: InitMessage[];
  errors: InputError[];
}

/** What init has to say, in the order of the text: the line "Detected tools" stands between `before` and `after`. */
interface InitReport {
  policy: string;
  action: 'create' | 'overwrite';
  projects: string[];
  tools: DetectedTool[] | null;
  before: InitMessage[];
  after: InitMessage[];
  /** What to run next, for the text only. */
  next?: string;
}

function document(fields: Omit<InitDocument, 'schemaVersion' | 'warnings' | 'notices' | 'errors'>, messages: readonly InitMessage[], errors: InputError[]): string {
  const result: InitDocument = {
    schemaVersion: 1,
    ...fields,
    warnings: messages.filter((entry) => entry.level === 'warning'),
    notices: messages.filter((entry) => entry.level === 'note'),
    errors,
  };
  return `${safeJson(result, 2)}\n`;
}

/** A warning or note as the text shows it: level word, message, code, and what to do on the next line. */
function messageText(entry: InitMessage, colors: Paint): string {
  const level = entry.level === 'warning' ? colors.yellow('warning:') : colors.cyan('note:');
  return `${level} ${printable(entry.message)} ${colors.dim(`(${entry.code})`)}\n  ${colors.green('fix:')} ${printable(entry.fix)}\n`;
}

/** The result of init: the JSON document, or the text on stdout. */
function printReport(report: InitReport, options: InitOptions, io: CliIo): number {
  const messages = [...report.before, ...report.after];
  if (options.json) {
    io.stdout(document({ policy: report.policy, written: true, action: report.action, projects: report.projects, tools: report.tools }, messages, []));
    return EXIT_OK;
  }
  const colors = paint(io.colors?.stdout);
  const lines = [`${report.action === 'create' ? 'Created' : 'Overwrote'} ${printable(report.policy)} with the default policy.\n`, ...report.before.map((entry) => messageText(entry, colors))];
  if (report.tools !== null) {
    const names = report.tools.map((entry) => `${entry.name}${entry.supported ? '' : ' (not supported)'}${entry.directory === '.' ? '' : ` (${entry.directory})`}`);
    lines.push(`Detected tools: ${names.length === 0 ? 'none' : printable(names.join(', '))}.\n`);
  }
  lines.push(...report.after.map((entry) => messageText(entry, colors)));
  if (report.next !== undefined) lines.push(`${report.next}\n`);
  io.stdout(lines.join(''));
  return EXIT_OK;
}

/** An error that keeps init from writing: on stderr, or with --json as the document on stdout. */
function printError(error: InputError, exitCode: number, fields: { policy: string | null; tools: DetectedTool[] | null }, options: InitOptions, io: CliIo): number {
  if (options.json) io.stdout(document({ policy: fields.policy, written: false, action: null, projects: [], tools: fields.tools }, [], [error]));
  else reportInputError(error, io);
  return exitCode;
}

/** Whether a tool installs PyPI packages, by its ecosystem in the knowledge base. */
function isPythonTool(id: string): boolean {
  const tool = knowledgeBase.find((entry) => entry.id === id);
  return tool !== undefined && ecosystemOfTool(tool) === 'pypi';
}

/** A file system error without the path, e.g. "EACCES: permission denied". */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && message.startsWith(`${code}: `) ? (message.split(',', 1)[0] ?? message) : message;
}

/** The nearest existing directory above `path` when it is not a directory (a regular file in the way); else undefined. */
function blockingFile(path: string): string | undefined {
  for (let current = dirname(path); ; current = dirname(current)) {
    let stats;
    try {
      stats = statSync(current, { throwIfNoEntry: false });
    } catch (error) {
      // ENOTDIR: a part above is the file in the way; anything else (EACCES) is reported by the caller.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') return undefined;
    }
    if (stats !== undefined) return stats.isDirectory() ? undefined : current;
    if (dirname(current) === current) return undefined;
  }
}

/** The default policy, with the longest delay `longest` finds above the default minimum as cooldown.minimum. */
function keepLongest(longest: (minutes: number) => ConfiguredDelay | undefined): { kept: ConfiguredDelay | undefined; minimum: string; text: string } {
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  const kept = defaultMinimum.ok ? longest(defaultMinimum.duration.minutes) : undefined;
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  return { kept, minimum, text: renderPolicy({ ...DEFAULT_POLICY, cooldown: { ...DEFAULT_POLICY.cooldown, minimum } }) };
}

/**
 * The note that cooldown.minimum keeps a longer delay, at the place of that delay (setting, value, file and line).
 * `policy` is the policy file as the fix names it, `apply` the command that writes the delay.
 */
function keptNote(kept: ConfiguredDelay, minimum: string, policy: string, apply: string): InitMessage {
  return {
    code: 'cooldown-kept',
    level: 'note',
    location: { file: kept.location.file, line: kept.location.line },
    message: `cooldown.minimum is ${minimum} instead of ${DEFAULT_POLICY.cooldown.minimum}, to keep the longest release-age delay already set: ${describeDelay(kept)}`,
    fix: `Leave cooldown.minimum as it is to keep that delay, or lower it in ${policy} before you run ${apply}`,
  };
}

/** A setting of the policy init writes, as a location: depcurfew.json and the line of the setting. */
function policyLocation(text: string, path: readonly string[]): { file: string; line?: number } {
  const found = jsonSetting(text, path);
  return found === undefined ? { file: POLICY_FILE } : { file: POLICY_FILE, line: found.line };
}

/**
 * init --user: the default policy as the user policy, in a directory that is created when missing; not without a home
 * directory (home-missing, as apply --user). A longer release-age delay that the user files of the installed tools set
 * becomes cooldown.minimum (decision D-101). Run by root in the home directory of another user, what it creates there
 * belongs to that user (decision D-093).
 */
export function initUser(options: InitOptions, environment: UserEnvironment, io: CliIo): number {
  const home = homeProblem(environment, 'init');
  if (home !== undefined) return printError({ ...home, level: 'error' }, EXIT_FAILURE, { policy: null, tools: null }, options, io);
  const target = userPolicyPath(environment);
  const shown = shownPath(target, environment);
  const fail = (code: ApplyErrorCode, message: string, fix: string): number =>
    printError({ code, level: 'error', location: { file: shown }, message, fix }, EXIT_FAILURE, { policy: shown, tools: null }, options, io);
  const blocked = (): number | undefined => {
    const file = blockingFile(target);
    if (file === undefined) return undefined;
    const name = shownPath(file, environment);
    return fail('cannot-write', `${name} is not a directory, so depcurfew init --user cannot create ${shown}`, `Move the file ${name} out of the way, then run depcurfew init --user again`);
  };
  let existing;
  try {
    existing = lstatSync(target, { throwIfNoEntry: false });
  } catch (error) {
    return (
      blocked() ??
      fail('cannot-write', `cannot look at ${shown}: ${fileSystemReason(error)}`, `Make sure the user running depcurfew may open the directories on the way to ${shown}, then run depcurfew init --user again`)
    );
  }
  // Windows reports a path through a file as missing.
  const blocker = existing === undefined ? blocked() : undefined;
  if (blocker !== undefined) return blocker;
  if (existing?.isDirectory() === true) return fail('cannot-write', `${shown} is a directory, not a file`, `Remove or rename the directory ${shown}, then run depcurfew init --user again`);
  if (existing !== undefined && !options.force) return fail('policy-exists', `${shown} already exists`, 'Pass --force to overwrite it with the default policy, or edit it by hand');
  if (existing?.isSymbolicLink() === true) return fail('cannot-write', `${shown} is a symlink; depcurfew does not write through symlinks`, 'Replace the symlink with a regular file');
  if (existing !== undefined && !existing.isFile()) return fail('cannot-write', `${shown} is not a regular file`, `Remove ${shown}, then run depcurfew init --user again`);
  const ownerOfNew = ownerOfNewUnderHome(environment);
  // A longer delay the user files of the installed tools set becomes cooldown.minimum, as in a project (decision D-101).
  const { kept, minimum, text } = keepLongest((minutes) => longestUserDelay(environment, minutes));
  try {
    // writeChanges creates the missing directories, one level at a time when they are given to the owner of HOME.
    writeChanges(dirname(target), [{ file: POLICY_FILE, before: existing === undefined ? null : readFileSync(target, 'utf8'), after: text }], ownerOfNew === undefined ? {} : { ownerOfNew });
  } catch (error) {
    return fail('cannot-write', `cannot write ${shown}: ${errorMessage(error)}`, 'Make sure you can write to the directory, then run depcurfew init --user again');
  }
  return printReport(
    {
      policy: shown,
      action: existing === undefined ? 'create' : 'overwrite',
      projects: [],
      tools: null,
      before: kept === undefined ? [] : [keptNote(kept, minimum, shown, 'depcurfew apply --user')],
      after: [],
      next: 'Run depcurfew apply --user --dry-run to see what it writes into the user-level configuration of your tools.',
    },
    options,
    io,
  );
}

/** The tools of a detection for the report, without the ones `skipped` names (seen only in a CI setup step). */
function detectedTools(detection: Detection, directory: string, skipped: ReadonlySet<string> = new Set()): DetectedTool[] {
  return [
    ...detection.packageManagers
      .filter((manager) => !skipped.has(manager.id))
      .map((manager) => ({ tool: manager.id, name: manager.variant === 'classic' ? 'Yarn Classic' : toolName(manager.id), directory, supported: manager.supported })),
    ...detection.bots.map((bot) => ({ tool: bot.id, name: toolName(bot.id), directory, supported: true })),
  ];
}

/**
 * Writes the default policy to depcurfew.json in `directory` (default: the current directory). A longer release-age
 * delay the repository already sets becomes cooldown.minimum, so that apply does not shorten it (decision D-075).
 */
export function init(directory: string | undefined, options: InitOptions, io: CliIo): number {
  const checked = checkDirectory(directory);
  if (!checked.ok) return printError(checked.error, EXIT_USAGE, { policy: null, tools: [] }, options, io);
  const absolute = checked.directory;

  const target = join(absolute, POLICY_FILE);
  const shownTarget = directory === undefined ? POLICY_FILE : join(directory, POLICY_FILE);
  const fail = (code: ApplyErrorCode, message: string, fix: string): number =>
    printError({ code, level: 'error', location: { file: shownTarget }, message, fix }, EXIT_FAILURE, { policy: shownTarget, tools: [] }, options, io);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isDirectory() === true) {
    return fail('cannot-write', `${shownTarget} is a directory, not a file`, `Remove or rename the directory ${shownTarget}, then run depcurfew init again`);
  }
  const detection = detectProject(absolute);
  // No manifest in the root, but in direct subdirectories: independent projects (decision D-100).
  const proposed = proposedProjects(absolute);
  const projects = proposed.projects.map((project) => ({ project, detection: detectProject(join(absolute, project)) }));
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  // The longest delay of the root and of every project, which apply would otherwise shorten (decision D-075).
  let kept = defaultMinimum.ok ? longestDelay(absolute, detection, defaultMinimum.duration.minutes) : undefined;
  for (const entry of defaultMinimum.ok ? projects : []) {
    const longer = longestDelay(join(absolute, entry.project), entry.detection, kept?.minutes ?? (defaultMinimum.ok ? defaultMinimum.duration.minutes : 0));
    if (longer !== undefined) kept = { ...longer, location: { ...longer.location, file: inProject(entry.project, longer.location.file) } };
  }
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  const text = renderPolicy({
    ...DEFAULT_POLICY,
    cooldown: { ...DEFAULT_POLICY.cooldown, minimum },
    ...(projects.length === 0 ? {} : { projects: projects.map((entry) => entry.project) }),
  });
  try {
    if (existing === undefined || !options.force) {
      // 'wx' fails if the file appeared in the meantime, so nothing is overwritten without --force.
      writeFileSync(target, text, { flag: 'wx' });
    } else if (existing.isSymbolicLink()) {
      return fail(
        'cannot-write',
        `${shownTarget} is a symlink; depcurfew does not write through symlinks`,
        'Replace the symlink with a regular file, or run depcurfew init in the directory it points to',
      );
    } else if (!existing.isFile()) {
      // A FIFO or a device: reading it for the earlier text would wait for ever or never end.
      return fail('cannot-write', `${shownTarget} is not a regular file`, `Remove ${shownTarget}, then run depcurfew init again`);
    } else {
      // Through a temporary file and a rename, like apply: the directory entry is replaced, never followed.
      writeChanges(absolute, [{ file: POLICY_FILE, before: readFileSync(target, 'utf8'), after: text }]);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail('policy-exists', `${shownTarget} already exists`, 'Pass --force to overwrite it with the default policy, or edit it by hand');
    }
    return fail('cannot-write', `cannot write ${shownTarget}: ${errorMessage(error)}`, 'Make sure you can write to the directory, then run depcurfew init again');
  }
  // As apply sees it under targets "auto": a tool seen only in a CI setup step is not configured (decision D-075).
  const { ciOnly } = autoTargets(absolute, detection);
  const tools = [...detectedTools(detection, '.', new Set(ciOnly.map((entry) => entry.id))), ...projects.flatMap((entry) => detectedTools(entry.detection, entry.project))];
  const before: InitMessage[] = [];
  if (projects.length > 0) {
    before.push({
      code: 'projects-listed',
      level: 'note',
      location: policyLocation(text, ['projects']),
      message: `projects lists ${listing(projects.map((entry) => entry.project))}: the root has no manifest or lockfile, these directories do, so depcurfew configures each as a project of its own and the bots from the root`,
      fix: `Edit projects in ${POLICY_FILE} if that is not right`,
    });
  }
  for (const entry of proposed.leftOut) {
    before.push({ code: 'project-left-out', level: 'warning', location: { file: entry.file }, message: `${entry.project} is not in projects: ${entry.reason}`, fix: entry.fix });
  }
  if (kept !== undefined) before.push(keptNote(kept, minimum, POLICY_FILE, 'depcurfew apply'));
  const after: InitMessage[] = [];
  // Building from source runs the package's own build code, so the default deny blocks it (decision D-065); a package
  // without wheels then stops installing, which a team should see before apply (user feedback before 1.3.0).
  // doctor sees which locked packages have no wheels only in a lockfile that lists their files (uv.lock, poetry.lock,
  // pdm.lock, pylock.toml); a requirements file or Pipfile.lock lists hashes only, so check asks the index (D-107).
  const found = [detection, ...projects.map((entry) => entry.detection)];
  const python = found.filter((item) => item.packageManagers.some((manager) => manager.supported && isPythonTool(manager.id)));
  if (DEFAULT_POLICY.installScripts.default === 'deny' && python.length > 0) {
    const locked = python.some((item) => hasBuildRecords(item.packageManagers, knowledgeBase, 'pypi'));
    const unlocked = python.some((item) => !hasBuildRecords(item.packageManagers, knowledgeBase, 'pypi'));
    const how = [
      ...(locked ? ['run depcurfew doctor before depcurfew apply to see the locked packages that have none'] : []),
      ...(unlocked ? [`run depcurfew check pypi:<name> for each package ${locked ? 'of the projects without such a lockfile' : 'the project installs'} to see whether it has wheels (doctor can tell only from a uv.lock, poetry.lock, pdm.lock or pylock.toml)`] : []),
    ].join(', and ');
    after.push({
      code: 'python-builds-denied',
      level: 'note',
      location: policyLocation(text, ['installScripts', 'default']),
      message: 'installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for your platform stops installing',
      fix: `${how.charAt(0).toUpperCase()}${how.slice(1)}, and add the ones you trust to installScripts.allow as pypi:<name>`,
    });
  }
  // In a repository of projects the workflows of the root set up the projects' tools, as apply knows (decision D-100).
  const inProjects = new Set(projects.flatMap((entry) => entry.detection.packageManagers.map((manager) => manager.id)));
  for (const entry of ciOnly.filter((item) => !inProjects.has(item.id as never))) {
    after.push({
      code: 'tool-only-in-ci',
      level: 'note',
      location: { file: entry.workflows[0] ?? POLICY_FILE },
      message: `${toolName(entry.id)} is seen only in a CI setup step (${listing(entry.workflows)}), so depcurfew apply does not configure it`,
      fix: `Add "${entry.id}" to targets in ${POLICY_FILE} if it installs packages for this project`,
    });
  }
  return printReport(
    { policy: shownTarget, action: existing === undefined ? 'create' : 'overwrite', projects: projects.map((entry) => entry.project), tools, before, after },
    options,
    io,
  );
}
