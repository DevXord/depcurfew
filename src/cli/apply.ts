// `depcurfew apply [directory] [--dry-run] [--json]`. The result goes to stdout (the files written, or with --dry-run a
// unified diff that `git apply` accepts); warnings, snippets to add by hand and errors go to stderr. When any file
// cannot be edited, nothing is written and stdout stays empty, also with --dry-run. With --json, stdout holds one JSON
// document with all of it (each change with its diff, warnings and errors with a code) and stderr stays empty.
import { applyProject, ApplyWriteError, PolicyError, policyErrorFix, type ApplyReport } from '../apply/index.ts';
import { unifiedDiff } from '../apply/diff.ts';
import type { ApplyErrorCode, ApplyWarning } from '../apply/warnings.ts';
import { paint, type Paint } from '../color.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { toolName } from './describe.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.ts';

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

/** A warning as doctor shows a finding: the message with its code, and what to do on the next line. */
function warningLines(warning: ApplyWarning, colors: Paint): string[] {
  const lines = [`warning: ${warning.message} ${colors.dim(`(${warning.code})`)}`];
  if (warning.fix !== undefined) lines.push(`  ${colors.green('fix:')} ${warning.fix}`);
  return lines;
}

function diagnostics(report: ApplyReport, colors: Paint): string {
  const lines = report.warningDetails.flatMap((warning) => warningLines(warning, colors));
  for (const snippet of report.snippets) {
    lines.push(colors.bold(`${toolName(snippet.tool)}: add this to ${snippet.file} by hand:`), indent(snippet.text));
  }
  // Every error of a plan is a file that cannot be edited.
  for (const error of report.errors) lines.push(`error: ${error} ${colors.dim('(cannot-edit)')}`, `  ${colors.green('fix:')} ${CANNOT_EDIT_FIX}`);
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

/** The JSON document of apply --json; the same for a run that fails before it can plan anything. */
function jsonReport(dryRun: boolean, policy: 'valid' | 'missing' | 'invalid', report: ApplyReport | undefined, errors: JsonError[]): string {
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
    summary: { changes: changes.length, warnings: warnings.length, errors: errors.length },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A file could not be written: the warnings of the plan and the error, in text or as the JSON document. */
function writeError(error: ApplyWriteError, json: boolean, io: CliIo): number {
  if (json) {
    io.stdout(jsonReport(false, 'valid', error.report, [{ code: error.code, level: 'error', location: { file: error.file }, message: error.message, fix: error.fix }]));
    return EXIT_FAILURE;
  }
  const colors = paint(io.colors?.stderr);
  const lines = [diagnostics({ ...error.report, errors: [], failures: [] }, colors), `error: ${error.message} ${colors.dim(`(${error.code})`)}\n`, `  ${colors.green('fix:')} ${error.fix}\n`];
  lines.push(error.unrestored.length === 0 ? 'depcurfew: nothing written because of the errors above.\n' : 'depcurfew: some files were changed; see the error above.\n');
  io.stderr(lines.join(''));
  return EXIT_FAILURE;
}

export function apply(directory: string | undefined, options: { dryRun: boolean; json: boolean }, io: CliIo): number {
  const { dryRun } = options;
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;
  let report: ApplyReport;
  try {
    report = applyProject(absolute, { write: !dryRun });
  } catch (error) {
    if (error instanceof ApplyWriteError) return writeError(error, options.json, io);
    if (!(error instanceof PolicyError)) throw error;
    if (options.json) {
      const failure: JsonError = {
        code: error.code,
        level: 'error',
        location: { file: POLICY_FILE },
        message: error.message,
        fix: policyErrorFix(error),
        ...(error.issues.length === 0 ? {} : { issues: error.issues }),
      };
      io.stdout(jsonReport(dryRun, error.code === 'policy-missing' ? 'missing' : 'invalid', undefined, [failure]));
      return EXIT_FAILURE;
    }
    io.stderr(`depcurfew: ${error.text}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`);
    return EXIT_FAILURE;
  }

  if (options.json) {
    const errors = report.failures.map(
      (failure, index): JsonError => ({ code: 'cannot-edit', level: 'error', tool: failure.tool, location: { file: failure.file }, message: report.errors[index] ?? failure.message, fix: CANNOT_EDIT_FIX }),
    );
    io.stdout(jsonReport(dryRun, 'valid', report, errors));
    return errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
  }

  const colors = paint(io.colors?.stdout);
  // With errors nothing would be written, so a dry run prints no diff either: applying it would apply half the policy.
  if (report.errors.length === 0 && dryRun) {
    io.stdout(paintDiff(report.changes.map((change) => unifiedDiff(change.file, change.before, change.after)).join(''), colors));
  } else if (report.errors.length === 0) {
    io.stdout(
      report.changes.length === 0
        ? report.warnings.length + report.snippets.length === 0
          ? colors.green('Nothing to change; the configuration already matches the policy.') + '\n'
          : 'No files changed; what depcurfew could not apply is listed below.\n'
        : report.changes.map((change) => `${colors.green(change.before === null ? 'Created' : 'Updated')} ${change.file}\n`).join(''),
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
