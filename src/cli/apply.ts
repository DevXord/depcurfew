// `depcurfew apply [directory] [--dry-run] [--json]`. The result goes to stdout (the files written, or with --dry-run a
// unified diff that `git apply` accepts); warnings, snippets to add by hand and errors go to stderr. When any file
// cannot be edited, nothing is written and stdout stays empty, also with --dry-run. With --json, stdout holds one JSON
// document with all of it (each change with its diff, warnings and errors with a code) and stderr stays empty. Without
// a directory it works on the nearest directory with depcurfew.json (projectDirectory in directory.ts).
import { applyProject, ApplyWriteError, PolicyError, type ApplyReport } from '../apply/index.ts';
import { unifiedDiff } from '../apply/diff.ts';
import type { Version } from '../apply/version.ts';
import { WriteFailed } from '../apply/workspace.ts';
import type { ToolId } from '../knowledge/types.ts';
import { planUserApply, writeUserChanges } from '../user/apply.ts';
import { shownPath, type UserEnvironment } from '../user/locate.ts';
import { userPolicyPath } from '../user/policy-path.ts';
import { loadUserPolicy } from '../user/policy.ts';
import type { ApplyErrorCode, ApplyWarning } from '../apply/warnings.ts';
import { paint, type Paint } from '../color.ts';
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

const CANNOT_EDIT_FIX = 'Fix what the message describes, then run depcurfew apply again; or add the settings by hand';

/**
 * A warning as doctor shows a finding: the message with its code, and what to do on the next line. Messages, file
 * names and snippets carry names and values from the repository: control characters in them are shown as text.
 */
function warningLines(warning: ApplyWarning, colors: Paint): string[] {
  const lines = [`warning: ${printable(warning.message)} ${colors.dim(`(${warning.code})`)}`];
  if (warning.fix !== undefined) lines.push(`  ${colors.green('fix:')} ${printable(warning.fix)}`);
  return lines;
}

function diagnostics(report: ApplyReport, colors: Paint): string {
  const lines = report.warningDetails.flatMap((warning) => warningLines(warning, colors));
  for (const snippet of report.snippets) {
    lines.push(colors.bold(`${toolName(snippet.tool)}: add this to ${printable(snippet.file)} by hand:`), indent(printable(snippet.text, { lines: true })));
  }
  // Every error of a plan is a file that cannot be edited.
  for (const error of report.errors) lines.push(`error: ${printable(error)} ${colors.dim('(cannot-edit)')}`, `  ${colors.green('fix:')} ${CANNOT_EDIT_FIX}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function count(changes: number): string {
  return `${changes} ${changes === 1 ? 'file' : 'files'}`;
}

interface JsonError {
  code: ApplyErrorCode;
  level: 'error';
  tool?: string;
  location: { file: string };
  message: string;
  fix?: string;
  issues?: string[];
}

/**
 * The JSON document of apply --json; the same for a run that fails before it can plan anything. `policy` is null when
 * depcurfew.json was not looked for, because the directory does not exist.
 */
function jsonReport(dryRun: boolean, policy: 'valid' | 'missing' | 'invalid' | null, report: ApplyReport | undefined, errors: JsonError[], notices: readonly { message: string }[]): string {
  const changes =
    report === undefined || errors.length > 0
      ? []
      : report.changes.map((change) => ({ file: change.file, action: change.before === null ? 'create' : 'update', diff: unifiedDiff(change.file, change.before, change.after) }));
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
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A file could not be written: the warnings of the plan and the error, in text or as the JSON document. */
function writeError(error: ApplyWriteError, json: boolean, notices: readonly { message: string }[], io: CliIo): number {
  if (json) {
    io.stdout(jsonReport(false, 'valid', error.report, [{ code: error.code, level: 'error', location: { file: error.file }, message: error.message, fix: error.fix }], notices));
    return EXIT_FAILURE;
  }
  const colors = paint(io.colors?.stderr);
  const lines = [
    diagnostics({ ...error.report, errors: [], failures: [] }, colors),
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
      return writeError(new ApplyWriteError(error, planned.report), options.json, [], io);
    }
  }
  return printReport(planned.report, options, [], io);
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

  return printReport(report, options, notices, io);
}

/** The result of a plan (project or user): the JSON document, or the changes or diff on stdout and the diagnostics on stderr. */
function printReport(report: ApplyReport, options: { dryRun: boolean; json: boolean }, notices: readonly { message: string }[], io: CliIo): number {
  const { dryRun } = options;
  if (options.json) {
    const errors = report.failures.map(
      (failure, index): JsonError => ({ code: 'cannot-edit', level: 'error', tool: failure.tool, location: { file: failure.file }, message: report.errors[index] ?? failure.message, fix: CANNOT_EDIT_FIX }),
    );
    io.stdout(jsonReport(dryRun, 'valid', report, errors, notices));
    return errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
  }

  const colors = paint(io.colors?.stdout);
  // With errors nothing would be written, so a dry run prints no diff either: applying it would apply half the policy.
  if (report.errors.length === 0 && dryRun) {
    const diff = report.changes.map((change) => unifiedDiff(change.file, change.before, change.after)).join('');
    // On a terminal the diff is for reading, so control characters in the files are shown as text; written to a file
    // or a pipe it stays exactly what git apply needs.
    const shown = io.terminal?.stdout === true || io.colors?.stdout === true ? diff.split('\n').map((line) => printable(line)).join('\n') : diff;
    io.stdout(paintDiff(shown, colors));
  } else if (report.errors.length === 0) {
    io.stdout(
      report.changes.length === 0
        ? report.warnings.length + report.snippets.length === 0
          ? colors.green('Nothing to change; the configuration already matches the policy.') + '\n'
          : 'No files changed; what depcurfew could not apply is listed below.\n'
        : report.changes.map((change) => `${colors.green(change.before === null ? 'Created' : 'Updated')} ${printable(change.file)}\n`).join(''),
    );
  }
  io.stderr(diagnostics(report, paint(io.colors?.stderr)));
  if (report.errors.length > 0) {
    io.stderr(dryRun ? 'depcurfew: apply would write nothing because of the errors above.\n' : 'depcurfew: nothing written because of the errors above.\n');
    return EXIT_FAILURE;
  }
  if (dryRun) io.stderr(report.changes.length === 0 ? 'Dry run: nothing to change.\n' : `Dry run: ${count(report.changes.length)} would change; nothing written.\n`);
  return EXIT_OK;
}

