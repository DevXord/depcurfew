// `depcurfew apply [directory] [--dry-run] [--json]`. The result goes to stdout (the files written, or with --dry-run a
// unified diff that `git apply` accepts); warnings, snippets to add by hand and errors go to stderr. When any file
// cannot be edited, nothing is written and stdout stays empty, also with --dry-run. With --json, stdout holds one JSON
// document with all of it (each change with its diff, warnings and errors with a code) and stderr stays empty. Without
// a directory it works on the nearest directory with depcurfew.json (projectDirectory in directory.ts). Diffs never
// show the values of secrets (tokens and passwords in .npmrc and the like). The text diff shows control and
// bidirectional characters from the files as text (\x1b, ‮) in every line, on a terminal and in a pipe alike (in
// a pipe the CR of CRLF line breaks stays, so the diff still applies); the diff in the JSON document keeps them all,
// escaped by JSON.
import { applyProject, ApplyWriteError, PolicyError, type ApplyReport } from '../apply/index.ts';
import { unifiedDiff } from '../apply/diff.ts';
import type { Version } from '../apply/version.ts';
import { WriteFailed } from '../apply/workspace.ts';
import type { ToolId } from '../knowledge/types.ts';
import { planUserApply, writeUserChanges, type UserProblem } from '../user/apply.ts';
import { shownPath, type UserEnvironment } from '../user/locate.ts';
import { userPolicyPath } from '../user/policy-path.ts';
import { loadUserPolicy } from '../user/policy.ts';
import type { ApplyErrorCode, ApplyWarning } from '../apply/warnings.ts';
import { paint, type Paint } from '../color.ts';
import { safeJson } from '../json-safe.ts';
import { printable } from '../printable.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { toolName } from './describe.ts';
import { policyInputError, projectDirectory, reportInputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
}

/** A unified diff with added lines green, removed lines red and hunk headers cyan. */
function paintDiff(diff: string, colors: Paint): string {
  return diff.replace(/^.*$/gmu, (line) => {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) return colors.bold(line);
    if (line.startsWith('+')) return colors.green(line);
    if (line.startsWith('-')) return colors.red(line);
    return line.startsWith('@@') ? colors.cyan(line) : line;
  });
}

/** The diff apply shows of a change: secrets redacted, in the text and in the JSON document alike. */
function diffOf(change: { file: string; before: string | null; after: string }): string {
  return unifiedDiff(change.file, change.before, change.after, 3, { redact: true });
}

/** What to do about a file that cannot be edited; `command` is what to run again. apply --user names a fix of its own. */
function cannotEditFix(failure: object, command: string): string {
  return 'fix' in failure && typeof failure.fix === 'string' ? failure.fix : `Fix what the message describes, then run ${command} again; or add the settings by hand`;
}

/**
 * A diff for text output: control and bidirectional characters from the files written as text in each line
 * (printable), the +, - and space at the start of a line kept. A terminal control sequence in a configuration value
 * would otherwise reach the terminal or the CI log as it is. Written to a file or a pipe, the carriage return of a
 * CRLF line break stays, so that the diff of a file with Windows line endings still applies; on a terminal, where
 * the diff is only read, it shows as \x0d too.
 */
function printableDiff(diff: string, terminal: boolean): string {
  return diff
    .split('\n')
    .map((line) => (!terminal && line.endsWith('\r') ? `${printable(line.slice(0, -1), { lines: true })}\r` : printable(line, { lines: true })))
    .join('\n');
}

/**
 * A warning as doctor shows a finding: the message with its code, and what to do on the next line. Messages, file
 * names and snippets carry names and values from the repository: control characters in them are shown as text.
 */
function warningLines(warning: ApplyWarning, colors: Paint): string[] {
  const lines = [`warning: ${printable(warning.message)} ${colors.dim(`(${warning.code})`)}`];
  if (warning.fix !== undefined) lines.push(`  ${colors.green('fix:')} ${printable(warning.fix)}`);
  return lines;
}

/** Warnings, snippets and errors on stderr, from the same errors as the JSON document. */
function diagnostics(report: ApplyReport, errors: readonly JsonError[], colors: Paint): string {
  const lines = report.warningDetails.flatMap((warning) => warningLines(warning, colors));
  for (const snippet of report.snippets) {
    lines.push(colors.bold(`${toolName(snippet.tool)}: add this to ${printable(snippet.file)} by hand:`), indent(printable(snippet.text, { lines: true })));
  }
  for (const error of errors) {
    lines.push(`error: ${printable(error.message)} ${colors.dim(`(${error.code})`)}`);
    if (error.fix !== undefined) lines.push(`  ${colors.green('fix:')} ${printable(error.fix)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function count(changes: number): string {
  return `${changes} ${changes === 1 ? 'file' : 'files'}`;
}

interface JsonError {
  code: ApplyErrorCode;
  level: 'error';
  tool?: string;
  location: { file: string; line?: number };
  message: string;
  fix?: string;
  issues?: string[];
}

/** The line a parser names in its message (invalid TOML at line 3, … at line 2, column 1), when it names one. */
function lineOf(message: string): number | undefined {
  const match = /\bat line (\d+)\b/u.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The errors of a plan, one source for the text and the JSON document: the problems that concern no single file
 * (apply --user), then every file that cannot be edited. `report.errors` holds the problems' messages first.
 */
function planErrors(report: ApplyReport, problems: readonly UserProblem[], command: string): JsonError[] {
  return [
    ...problems.map((problem): JsonError => ({ code: problem.code, level: 'error', location: problem.location, message: problem.message, fix: problem.fix })),
    ...report.failures.map((failure, index): JsonError => {
      const line = lineOf(failure.message);
      return {
        code: 'cannot-edit',
        level: 'error',
        tool: failure.tool,
        location: { file: failure.file, ...(line === undefined ? {} : { line }) },
        message: report.errors[problems.length + index] ?? failure.message,
        fix: cannotEditFix(failure, command),
      };
    }),
  ];
}

/**
 * The JSON document of apply --json; the same for a run that fails before it can plan anything. `policy` is null when
 * depcurfew.json was not looked for, because the directory does not exist.
 */
function jsonReport(dryRun: boolean, policy: 'valid' | 'missing' | 'invalid' | null, report: ApplyReport | undefined, errors: JsonError[], notices: readonly { message: string }[]): string {
  const changes = report === undefined || errors.length > 0 ? [] : report.changes.map((change) => ({ file: change.file, action: change.before === null ? 'create' : 'update', diff: diffOf(change) }));
  const warnings = (report?.warningDetails ?? []).map(({ code, ...rest }) => ({ code, level: 'warning', ...rest }));
  const document = {
    schemaVersion: 1,
    policy,
    dryRun,
    written: !dryRun && errors.length === 0 && changes.length > 0,
    changes,
    warnings,
    snippets: report?.snippets ?? [],
    errors,
    notices,
    summary: { changes: changes.length, warnings: warnings.length, errors: errors.length },
  };
  return `${safeJson(document, 2)}\n`;
}

/** A file could not be written: the warnings of the plan and the error, in text or as the JSON document. */
function writeError(error: ApplyWriteError, json: boolean, notices: readonly { message: string }[], io: CliIo): number {
  if (json) {
    io.stdout(jsonReport(false, 'valid', error.report, [{ code: error.code, level: 'error', location: { file: error.file }, message: error.message, fix: error.fix }], notices));
    return EXIT_FAILURE;
  }
  const colors = paint(io.colors?.stderr);
  const lines = [
    diagnostics(error.report, [], colors),
    `error: ${printable(error.message)} ${colors.dim(`(${error.code})`)}\n`,
    `  ${colors.green('fix:')} ${printable(error.fix)}\n`,
  ];
  lines.push(error.unrestored.length === 0 ? 'depcurfew: nothing written because of the errors above.\n' : 'depcurfew: some files were changed; see the error above.\n');
  io.stderr(lines.join(''));
  return EXIT_FAILURE;
}

export interface ApplyOptions {
  dryRun: boolean;
  json: boolean;
  /** --user: the user policy into the user-level configuration (decision D-087). */
  user?: { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> };
}

const USER_COMMAND = 'depcurfew apply --user';

/** apply --user: the user policy, planned and written like a project's, with the files shown under ~/. */
function applyUser(options: ApplyOptions & { user: NonNullable<ApplyOptions['user']> }, io: CliIo): number {
  const { dryRun } = options;
  let loaded;
  try {
    loaded = loadUserPolicy(options.user.environment);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    const file = shownPath(userPolicyPath(options.user.environment), options.user.environment);
    const failure = policyInputError(error, file);
    if (options.json) io.stdout(jsonReport(dryRun, error.code === 'policy-missing' ? 'missing' : 'invalid', undefined, [failure], []));
    else reportInputError(failure, io);
    return EXIT_FAILURE;
  }
  const planned = planUserApply(loaded.policy, { environment: options.user.environment, versions: options.user.versions });
  if (!dryRun) {
    try {
      writeUserChanges(planned);
    } catch (error) {
      if (!(error instanceof WriteFailed)) throw error;
      // User files are seldom under version control: the fix names a backup only.
      return writeError(new ApplyWriteError(error, planned.report, { command: USER_COMMAND, versionControl: false }), options.json, [], io);
    }
  }
  return printReport(planned.report, planErrors(planned.report, planned.report.problems, USER_COMMAND), options, [], io);
}

export function apply(directory: string | undefined, options: ApplyOptions, io: CliIo): number {
  if (options.user !== undefined) return applyUser({ ...options, user: options.user }, io);
  const { dryRun } = options;
  const target = projectDirectory(directory, 'apply');
  if (!target.ok) {
    if (options.json) io.stdout(jsonReport(dryRun, null, undefined, [target.error], []));
    else reportInputError(target.error, io);
    return EXIT_USAGE;
  }
  const absolute = target.directory;
  const notices = target.notice === undefined ? [] : [{ message: target.notice }];
  if (!options.json) for (const notice of notices) io.stderr(`note: ${notice.message}\n`);
  let report: ApplyReport;
  try {
    report = applyProject(absolute, { write: !dryRun });
  } catch (error) {
    if (error instanceof ApplyWriteError) return writeError(error, options.json, notices, io);
    if (!(error instanceof PolicyError)) throw error;
    const failure = policyInputError(error, POLICY_FILE);
    if (options.json) io.stdout(jsonReport(dryRun, error.code === 'policy-missing' ? 'missing' : 'invalid', undefined, [failure], notices));
    else reportInputError(failure, io);
    return EXIT_FAILURE;
  }

  return printReport(report, planErrors(report, [], 'depcurfew apply'), options, notices, io);
}

/** The result of a plan (project or user): the JSON document, or the changes or diff on stdout and the diagnostics on stderr. */
function printReport(report: ApplyReport, errors: JsonError[], options: { dryRun: boolean; json: boolean }, notices: readonly { message: string }[], io: CliIo): number {
  const { dryRun } = options;
  if (options.json) {
    io.stdout(jsonReport(dryRun, 'valid', report, errors, notices));
    return errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
  }

  const colors = paint(io.colors?.stdout);
  // With errors nothing would be written, so a dry run prints no diff either: applying it would apply half the policy.
  if (errors.length === 0 && dryRun) {
    const terminal = io.terminal?.stdout === true || io.colors?.stdout === true;
    io.stdout(paintDiff(printableDiff(report.changes.map(diffOf).join(''), terminal), colors));
  } else if (errors.length === 0) {
    io.stdout(
      report.changes.length === 0
        ? report.warnings.length + report.snippets.length === 0
          ? colors.green('Nothing to change; the configuration already matches the policy.') + '\n'
          : 'No files changed; what depcurfew could not apply is listed below.\n'
        : report.changes.map((change) => `${colors.green(change.before === null ? 'Created' : 'Updated')} ${printable(change.file)}\n`).join(''),
    );
  }
  io.stderr(diagnostics(report, errors, paint(io.colors?.stderr)));
  if (errors.length > 0) {
    io.stderr(dryRun ? 'depcurfew: apply would write nothing because of the errors above.\n' : 'depcurfew: nothing written because of the errors above.\n');
    return EXIT_FAILURE;
  }
  if (dryRun) io.stderr(report.changes.length === 0 ? 'Dry run: nothing to change.\n' : `Dry run: ${count(report.changes.length)} would change; nothing written.\n`);
  return EXIT_OK;
}
