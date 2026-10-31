// `depcurfew doctor [directory] [--json | --sarif]`. Exit code 1 when any finding is an error; an invalid depcurfew.json
// is one (invalid-policy), in every output format. A directory that does not exist is a usage error (exit code 2),
// also reported as a JSON document or a SARIF run that did not succeed.
import { countLevels, renderText, RULES, runDoctor, toSarif, type DoctorReport } from '../doctor/index.ts';
import { lineReader } from '../doctor/sarif.ts';
import { getVersion } from '../version.ts';
import type { Version } from '../apply/version.ts';
import type { ToolId } from '../knowledge/types.ts';
import { safeJson } from '../json-safe.ts';
import { runUserDoctor, USER_RULES } from '../user/doctor.ts';
import type { UserEnvironment } from '../user/locate.ts';
import { toUserSarif } from '../user/sarif.ts';
import { paint } from '../color.ts';
import { projectDirectory, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

function json(report: Omit<DoctorReport, 'policy'> & { policy: DoctorReport['policy'] | null }, errors: readonly InputError[]): string {
  // Errors count in the summary too, so a program that reads only the summary sees that doctor could not check.
  const summary = countLevels(report.findings);
  return `${safeJson({ ...report, errors, summary: { ...summary, error: summary.error + errors.length } }, 2)}\n`;
}

/** doctor --user: the user files and the environment, in the same formats; exit code 1 only for an error finding. */
function doctorUser(format: { json: boolean; sarif: boolean }, user: { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> }, io: CliIo): number {
  const { policyFile: _policyFile, ...report } = runUserDoctor({ environment: user.environment, versions: user.versions });
  if (format.sarif) io.stdout(`${safeJson(toUserSarif(report, getVersion(), user.environment), 2)}\n`);
  else if (format.json) io.stdout(json(report, []));
  else io.stdout(renderText(report, USER_RULES, paint(io.colors?.stdout)));
  return countLevels(report.findings).error > 0 ? EXIT_FAILURE : EXIT_OK;
}

export function doctor(
  directory: string | undefined,
  format: { json: boolean; sarif: boolean; user?: { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> } },
  io: CliIo,
): number {
  if (format.json && format.sarif) {
    io.stderr("depcurfew: '--json' and '--sarif' cannot be used together; pick one\nRun 'depcurfew doctor --help' for usage.\n");
    return EXIT_USAGE;
  }
  if (format.user !== undefined) return doctorUser(format, format.user, io);
  const target = projectDirectory(directory, 'doctor');
  if (!target.ok) {
    if (format.sarif) {
      const empty: DoctorReport = { schemaVersion: 1, policy: 'missing', findings: [], notices: [] };
      io.stdout(`${safeJson(toSarif(empty, RULES, getVersion(), undefined, [target.error]), 2)}\n`);
    } else if (format.json) {
      io.stdout(json({ schemaVersion: 1, policy: null, findings: [], notices: [] }, [target.error]));
    } else {
      reportInputError(target.error, io);
    }
    return EXIT_USAGE;
  }
  const found = runDoctor(target.directory, { invalidPolicy: 'report' });
  const report: DoctorReport = target.notice === undefined ? found : { ...found, notices: [{ message: target.notice }, ...found.notices] };
  if (format.sarif) {
    io.stdout(`${safeJson(toSarif(report, RULES, getVersion(), lineReader(target.directory)), 2)}\n`);
  } else if (format.json) {
    io.stdout(json(report, []));
  } else {
    io.stdout(renderText(report, RULES, paint(io.colors?.stdout)));
  }
  return countLevels(report.findings).error > 0 ? EXIT_FAILURE : EXIT_OK;
}
