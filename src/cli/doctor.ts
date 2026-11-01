// `depcurfew doctor [directory] [--json | --sarif] [--fail-on error|warning] [--strict]`. Exit code 1 when any finding
// is an error, and also for a warning when --fail-on (--strict is --fail-on warning) or else doctor.failOn of the
// policy is "warning" (decision D-112); notes never fail. An invalid depcurfew.json is one (invalid-policy), in every
// output format, and counts as "error" unless the option says otherwise. A directory that does not exist is a usage
// error (exit code 2), also reported as a JSON document or a SARIF run that did not succeed.
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { countLevels, renderText, RULES, runDoctor, toSarif, type DoctorReport } from '../doctor/index.ts';
import { fails, policyFailOn, resolveFailOn, type FailOn, type FailOnSetting } from '../doctor/fail-on.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { lineReader } from '../doctor/sarif.ts';
import { getVersion } from '../version.ts';
import type { Version } from '../apply/version.ts';
import type { ToolId } from '../knowledge/types.ts';
import { safeJson } from '../json-safe.ts';
import { runUserDoctor, USER_RULES } from '../user/doctor.ts';
import type { UserEnvironment } from '../user/locate.ts';
import { loadUserPolicy } from '../user/policy.ts';
import { toUserSarif } from '../user/sarif.ts';
import { paint } from '../color.ts';
import { projectDirectory, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

function json(report: Omit<DoctorReport, 'policy'> & { policy: DoctorReport['policy'] | null }, errors: readonly InputError[], setting: FailOnSetting): string {
  // Errors count in the summary too, so a program that reads only the summary sees that doctor could not check.
  const summary = countLevels(report.findings);
  // strict (D-097) stays: true when warnings fail; failOn and failOnFrom say which setting applies and where it came from.
  const mode = { strict: setting.failOn === 'warning', failOn: setting.failOn, failOnFrom: setting.from };
  return `${safeJson({ ...report, ...mode, errors, summary: { ...summary, error: summary.error + errors.length } }, 2)}\n`;
}

/** The exit code: 1 for an error finding, and with failOn "warning" also for a warning; notes never fail. */
function exitCode(report: Pick<DoctorReport, 'findings'>, setting: FailOnSetting): number {
  return fails(countLevels(report.findings), setting.failOn) ? EXIT_FAILURE : EXIT_OK;
}

export interface DoctorFormat {
  json: boolean;
  sarif: boolean;
  /** --strict: warnings fail too, as with failOn "warning". */
  strict?: boolean;
  /** --fail-on: which findings fail, over doctor.failOn of the policy; run checks that it does not conflict with --strict. */
  failOn?: FailOn;
  user?: { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> };
}

/** The option that decides, as given: --fail-on, else --strict; undefined when the policy or the default decides. */
function optionFailOn(format: DoctorFormat): { failOn: FailOn; given: string } | undefined {
  if (format.failOn !== undefined) return { failOn: format.failOn, given: `--fail-on ${format.failOn}` };
  return format.strict === true ? { failOn: 'warning', given: '--strict' } : undefined;
}

/** doctor.failOn of the user policy; undefined when it is missing, invalid or unreadable (doctor reports that). */
function userPolicyFailOn(environment: UserEnvironment): FailOn | undefined {
  try {
    return policyFailOn(loadUserPolicy(environment).policy);
  } catch (error) {
    if (error instanceof PolicyError) return undefined;
    throw error;
  }
}

/** doctor --user: the user files and the environment, in the same formats; exit code 1 for a finding that fails. */
function doctorUser(format: DoctorFormat, user: NonNullable<DoctorFormat['user']>, io: CliIo): number {
  const { policyFile, ...report } = runUserDoctor({ environment: user.environment, versions: user.versions });
  const setting = resolveFailOn(optionFailOn(format), { failOn: report.policy === 'valid' ? userPolicyFailOn(user.environment) : undefined, file: policyFile });
  if (format.sarif) io.stdout(`${safeJson(toUserSarif(report, getVersion(), user.environment), 2)}\n`);
  else if (format.json) io.stdout(json(report, [], setting));
  else io.stdout(renderText(report, USER_RULES, paint(io.colors?.stdout), { failOn: setting }));
  return exitCode(report, setting);
}

/** The project policy read once for doctor: the policy (undefined without one), or 'invalid', which runDoctor reports. */
function projectPolicy(directory: string): ResolvedPolicy | undefined | 'invalid' {
  try {
    return loadPolicyIfPresent(directory);
  } catch (error) {
    if (error instanceof PolicyError) return 'invalid';
    throw error;
  }
}

export function doctor(
  directory: string | undefined,
  format: DoctorFormat,
  io: CliIo,
): number {
  if (format.json && format.sarif) {
    io.stderr("depcurfew: '--json' and '--sarif' cannot be used together; pick one\nRun 'depcurfew doctor --help' for usage.\n");
    return EXIT_USAGE;
  }
  if (format.user !== undefined) return doctorUser(format, format.user, io);
  const option = optionFailOn(format);
  const target = projectDirectory(directory, 'doctor');
  if (!target.ok) {
    if (format.sarif) {
      const empty: DoctorReport = { schemaVersion: 1, policy: 'missing', findings: [], notices: [] };
      io.stdout(`${safeJson(toSarif(empty, RULES, getVersion(), undefined, [target.error]), 2)}\n`);
    } else if (format.json) {
      io.stdout(json({ schemaVersion: 1, policy: null, findings: [], notices: [] }, [target.error], resolveFailOn(option, { failOn: undefined, file: POLICY_FILE })));
    } else {
      reportInputError(target.error, io);
    }
    return EXIT_USAGE;
  }
  // An invalid policy is read again by runDoctor, which reports it; it counts as failOn "error" unless the option says otherwise.
  const policy = projectPolicy(target.directory);
  const found = policy === 'invalid' ? runDoctor(target.directory, { invalidPolicy: 'report' }) : runDoctor(target.directory, { policy: policy ?? null });
  const report: DoctorReport = target.notice === undefined ? found : { ...found, notices: [{ message: target.notice }, ...found.notices] };
  const setting = resolveFailOn(option, { failOn: policy === 'invalid' ? undefined : policyFailOn(policy), file: POLICY_FILE });
  if (format.sarif) {
    io.stdout(`${safeJson(toSarif(report, RULES, getVersion(), lineReader(target.directory)), 2)}\n`);
  } else if (format.json) {
    io.stdout(json(report, [], setting));
  } else {
    io.stdout(renderText(report, RULES, paint(io.colors?.stdout), { failOn: setting }));
  }
  return exitCode(report, setting);
}
