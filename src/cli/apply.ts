// `depgate apply [directory] [--dry-run]`. The result goes to stdout (the files written, or with --dry-run a
// unified diff that `git apply` accepts); warnings, snippets to add by hand and errors go to stderr. When any file
// cannot be edited, nothing is written and stdout stays empty, also with --dry-run.
import { applyProject, PolicyError, type ApplyReport } from '../apply/index.ts';
import { unifiedDiff } from '../apply/diff.ts';
import { paint, type Paint } from '../color.ts';
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

function diagnostics(report: ApplyReport, colors: Paint): string {
  const lines = report.warnings.map((warning) => `warning: ${warning}`);
  for (const snippet of report.snippets) {
    lines.push(colors.bold(`${toolName(snippet.tool)}: add this to ${snippet.file} by hand:`), indent(snippet.text));
  }
  lines.push(...report.errors.map((error) => `error: ${error}`));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function count(changes: number): string {
  return `${changes} ${changes === 1 ? 'file' : 'files'}`;
}

export function apply(directory: string | undefined, dryRun: boolean, io: CliIo): number {
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;
  let report: ApplyReport;
  try {
    report = applyProject(absolute, { write: !dryRun });
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    io.stderr(`depgate: ${error.message}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`);
    return EXIT_FAILURE;
  }

  const colors = paint(io.colors?.stdout);
  // With errors nothing would be written, so a dry run prints no diff either: applying it would apply half the policy.
  if (report.errors.length === 0 && dryRun) {
    io.stdout(paintDiff(report.changes.map((change) => unifiedDiff(change.file, change.before, change.after)).join(''), colors));
  } else if (report.errors.length === 0) {
    io.stdout(
      report.changes.length === 0
        ? colors.green('Nothing to change; the configuration already matches the policy.') + '\n'
        : report.changes.map((change) => `${colors.green(change.before === null ? 'Created' : 'Updated')} ${change.file}\n`).join(''),
    );
  }
  io.stderr(diagnostics(report, paint(io.colors?.stderr)));
  if (report.errors.length > 0) {
    io.stderr(dryRun ? 'depgate: apply would write nothing because of the errors above.\n' : 'depgate: nothing written because of the errors above.\n');
    return EXIT_FAILURE;
  }
  if (dryRun) io.stderr(report.changes.length === 0 ? 'Dry run: nothing to change.\n' : `Dry run: ${count(report.changes.length)} would change; nothing written.\n`);
  return EXIT_OK;
}
