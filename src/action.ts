// Entry point of the GitHub Action (action.yml, bundled into action/depcurfew.mjs): runs doctor on a directory of the
// workspace, prints the readable report to the log, adds annotations and a job summary for people, writes SARIF
// with paths relative to the repository root for code scanning and sets the step outputs. It does not fail the
// step itself, so the SARIF upload still runs; action.yml decides.
import { appendFileSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { values } from './apply/facts.ts';
import { loadPolicyIfPresent, PolicyError } from './apply/index.ts';
import { listedAsProject } from './apply/projects.ts';
import { fileSystemReason, writeChanges } from './apply/workspace.ts';
import { checkRunName, createCheckRun, fitSummary, type CheckRunContent, type CheckRunFetch } from './action-check-run.ts';
import { annotationCommands, cleanNotice, countLevels, failureSummary, jobSummary, renderText, RULES, runDoctor, toSarif, type DoctorReport } from './doctor/index.ts';
import { fails, policyFailOn, resolveFailOn, type FailOn, type FailOnSetting } from './doctor/fail-on.ts';
import { resultCounts } from './doctor/render.ts';
import { checkRunAnnotationNote, checkRunAnnotations, problemSummary } from './doctor/github.ts';
import { lineReader } from './doctor/sarif.ts';
import { POLICY_FILE } from './policy/defaults.ts';
import { environment } from './knowledge/environment.ts';
import { isInside } from './paths.ts';
import { printable } from './printable.ts';
import { getVersion } from './version.ts';

export interface ActionOutputs {
  'sarif-file': string;
  errors: number;
  warnings: number;
  notes: number;
  /** Set when doctor could not run, e.g. because depcurfew.json is invalid. */
  failure: string;
  /** Set when the findings fail the step (inputs fail-on and fail-on-error): what the failing step of action.yml says. */
  'fail-reason': string;
}

export interface ActionIo {
  log(text: string): void;
  /** Appends Markdown to the job summary. */
  summary(markdown: string): void;
  /** Receives the result for the depcurfew doctor check run, which main creates after the step (input check-run). */
  checkRun?(content: CheckRunContent): void;
}

function input(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

function enabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return input(env, name, 'true') !== 'false';
}

export type { FailOn } from './doctor/fail-on.ts';

const FAIL_ON: readonly FailOn[] = ['error', 'warning'];

/**
 * Why the findings fail the step, or '' when they do not. `setting` is which findings fail and where that was set:
 * the input fail-on, doctor.failOn of the policy or neither (decision D-112); undefined with fail-on-error: false.
 */
export function failReason(counts: Record<'error' | 'warning' | 'note', number>, setting: FailOnSetting | undefined): string {
  if (setting === undefined || !fails(counts, setting.failOn)) return '';
  const failing = (setting.failOn === 'warning' ? (['error', 'warning'] as const) : (['error'] as const)).filter((level) => counts[level] > 0);
  const found = failing.map((level) => `${counts[level]} ${counts[level] === 1 ? level : `${level}s`}`).join(' and ');
  const where = setting.from === 'policy' ? ` (doctor.failOn is "warning" in ${setting.file ?? POLICY_FILE})` : ' (fail-on: warning)';
  return `depcurfew doctor reported ${found}${setting.failOn === 'warning' ? where : ''}; the job summary and the log of the Run depcurfew doctor step say how to fix each one`;
}

function summaryLimit(): number {
  return values(environment.githubActions.stepSummary)[0]?.maxBytes ?? 0;
}

/** Report paths relative to the workspace instead of the scanned directory, as code scanning expects. */
function relativeToWorkspace(report: DoctorReport, prefix: string): DoctorReport {
  const move = (file: string) => (prefix === '' ? file : posix.join(prefix, file));
  return {
    ...report,
    findings: report.findings.map((finding) => ({ ...finding, location: { ...finding.location, file: move(finding.location.file) } })),
    notices: report.notices.map((notice) =>
      notice.file === undefined ? notice : { ...notice, file: move(notice.file), ...(notice.location === undefined ? {} : { location: { ...notice.location, file: move(notice.location.file) } }) },
    ),
    ...(report.checked === undefined
      ? {}
      : {
          checked: {
            ...report.checked,
            files: report.checked.files.map(move),
            tools: report.checked.tools.map((tool) => (tool.versionFrom === undefined ? tool : { ...tool, versionFrom: move(tool.versionFrom) })),
          },
        }),
  };
}

/**
 * Text from the repository (file and package names, policy errors) goes to the log with workflow commands turned
 * off, so a crafted name cannot add annotations or other commands to the run.
 */
function untrusted(text: string): string {
  const commands = values(environment.githubActions.stopCommands)[0];
  if (commands === undefined) return text.replaceAll(/^::/gmu, ': :');
  const token = randomUUID();
  return `${commands.stop.replace('{token}', token)}\n${text.endsWith('\n') ? text : `${text}\n`}${commands.resume.replace('{token}', token)}\n`;
}

/**
 * The directory itself, unless the nearest depcurfew.json above it in the workspace lists it under projects: then that
 * root, which checks it as one of its projects (decision D-115).
 */
function policyDirectory(workspace: string, directory: string): string {
  for (let current = directory; isInside(workspace, current); current = dirname(current)) {
    if (lstatSync(resolve(current, POLICY_FILE), { throwIfNoEntry: false }) !== undefined) return current !== directory && listedAsProject(current, directory) ? current : directory;
    if (current === workspace || dirname(current) === current) break;
  }
  return directory;
}

/** The real path of a directory inside the workspace, following symlinks only as far as they stay inside it. */
function scannedDirectory(workspace: string, input: string): string | undefined {
  try {
    const real = realpathSync(resolve(workspace, input));
    return isInside(realpathSync(workspace), real) && statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the SARIF file cannot be written, or undefined. The repository being checked may come from a pull request, so
 * no part of the path inside the workspace may be a symlink, which could send the report over a file elsewhere.
 */
function unsafeOutput(workspace: string, file: string): string | undefined {
  if (!isInside(workspace, file)) return undefined;
  let current = workspace;
  for (const part of relative(workspace, file).split(sep)) {
    current = resolve(current, part);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    if (stats.isSymbolicLink()) return `${relative(workspace, current).split(sep).join('/')} is a symlink; depcurfew does not write through symlinks`;
  }
  return lstatSync(file).isFile() ? undefined : `${relative(workspace, file).split(sep).join('/')} is not a regular file`;
}

export function runAction(env: NodeJS.ProcessEnv, io: ActionIo): ActionOutputs {
  const workspace = resolve(env['GITHUB_WORKSPACE'] ?? process.cwd());
  const sarifInput = input(env, 'sarif-file', 'depcurfew.sarif');
  const sarifFile = resolve(workspace, sarifInput);
  const outputs: ActionOutputs = { 'sarif-file': '', errors: 0, warnings: 0, notes: 0, failure: '', 'fail-reason': '' };
  const summary = enabled(env, 'job-summary');
  // Messages carry paths and text from the repository: control characters are shown as text in the log.
  const checkRun = enabled(env, 'check-run') ? io.checkRun : undefined;
  const failedCheck = (message: string, directory: string) =>
    checkRun?.({ name: checkRunName(directory), title: 'depcurfew could not check the repository', summary: failureSummary(message), conclusion: 'failure' });
  const fail = (message: string): ActionOutputs => {
    outputs.failure = message;
    io.log(untrusted(`depcurfew: ${printable(message)}\n`));
    if (summary) io.summary(failureSummary(message));
    failedCheck(message, '');
    return outputs;
  };
  // Empty (the default): doctor.failOn of the policy decides, else "error" (decision D-112).
  const failOnInput = input(env, 'fail-on', '');
  if (failOnInput !== '' && !(FAIL_ON as readonly string[]).includes(failOnInput)) {
    return fail(
      `the input fail-on is "${failOnInput}"; set it to error (errors fail the step) or warning (warnings fail it too), or leave it empty to follow doctor.failOn in ${POLICY_FILE} (errors only without it)`,
    );
  }
  const given = scannedDirectory(workspace, input(env, 'directory', '.'));
  if (given === undefined) return fail(`directory "${input(env, 'directory', '.')}" is not a directory inside the workspace`);
  // A directory without depcurfew.json of its own (one listed in projects) is checked with the nearest policy above it
  // in the workspace, as depcurfew doctor does from there (decision D-115).
  const directory = policyDirectory(realpathSync(workspace), given);
  const prefix = relative(realpathSync(workspace), directory).split(sep).join('/');
  if (directory !== given) {
    const file = prefix === '' ? POLICY_FILE : posix.join(prefix, POLICY_FILE);
    io.log(untrusted(`depcurfew: ${printable(input(env, 'directory', '.'))} is listed in projects in ${printable(file)}, so depcurfew doctor checks ${prefix === '' ? 'the repository root' : printable(prefix)} with its projects\n`));
  }

  let report: DoctorReport;
  let failOn: FailOnSetting | undefined;
  try {
    // The policy is read once, for doctor.failOn and for the rules.
    const policy = loadPolicyIfPresent(directory);
    report = runDoctor(directory, { policy: policy ?? null });
    const option = failOnInput === '' ? undefined : { failOn: failOnInput as FailOn, given: `fail-on: ${failOnInput}` };
    // fail-on-error: false keeps the step from failing on findings at all, whatever fail-on says (it came first).
    failOn = enabled(env, 'fail-on-error') ? resolveFailOn(option, { failOn: policyFailOn(policy), file: prefix === '' ? POLICY_FILE : posix.join(prefix, POLICY_FILE) }) : undefined;
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    outputs.failure = [error.message, ...error.issues].join('; ');
    io.log(untrusted(`depcurfew: ${printable(error.text)}\n${error.issues.map((issue) => `  ${printable(issue)}\n`).join('')}`));
    if (summary) io.summary(failureSummary(outputs.failure));
    failedCheck(outputs.failure, prefix);
    return outputs;
  }
  io.log(untrusted(renderText(report, RULES)));
  // The counts hold from here on, also when the SARIF file cannot be written.
  const counts = countLevels(report.findings);
  Object.assign(outputs, { errors: counts.error, warnings: counts.warning, notes: counts.note, 'fail-reason': failReason(counts, failOn) });

  const moved = relativeToWorkspace(report, prefix);
  if (enabled(env, 'annotations')) {
    const annotations = annotationCommands(moved, RULES);
    if (annotations.lines.length > 0) io.log(`${annotations.lines.join('\n')}\n`);
    const clean = cleanNotice(moved);
    if (clean !== undefined) io.log(`${clean}\n`);
    if (annotations.omitted > 0) {
      io.log(`GitHub shows a limited number of annotations per step; ${annotations.omitted} more ${annotations.omitted === 1 ? 'finding is' : 'findings are'} in the report above.\n`);
    }
  }
  if (summary) io.summary(jobSummary(moved, RULES, prefix, summaryLimit()));
  if (checkRun !== undefined) {
    // Nothing about the check fails the step (the result is in the log and the job summary already): one line instead.
    try {
      checkRun(checkRunContent(workspace, moved, prefix, outputs, counts));
    } catch (error) {
      io.log(`depcurfew: the depcurfew doctor check was not added: ${checkRunFailure(error)}\n`);
    }
  }
  const sarif = `${JSON.stringify(toSarif(moved, RULES, getVersion(), lineReader(workspace)), null, 2)}\n`;
  const shownSarif = isInside(workspace, sarifFile) ? relative(workspace, sarifFile).split(sep).join('/') : sarifFile;
  // doctor did run, so a SARIF file that cannot be written is a failure below the findings, not instead of them.
  const sarifFailure = (reason: string): ActionOutputs => {
    outputs.failure = `cannot write the SARIF file ${sarifInput}: ${reason}`;
    io.log(untrusted(`depcurfew: ${printable(outputs.failure)}\n`));
    if (summary) io.summary(problemSummary(outputs.failure));
    return outputs;
  };
  try {
    const unsafe = unsafeOutput(workspace, sarifFile);
    if (unsafe !== undefined) return sarifFailure(unsafe);
    const before = lstatSync(sarifFile, { throwIfNoEntry: false }) === undefined ? null : '';
    mkdirSync(dirname(sarifFile), { recursive: true });
    writeChanges(dirname(sarifFile), [{ file: basename(sarifFile), before, after: sarif }]);
  } catch (error) {
    return sarifFailure(error instanceof Error ? error.message : String(error));
  }
  return { ...outputs, 'sarif-file': shownSarif };
}

/**
 * Whether a finding's file can carry an annotation: a regular file in the workspace, looked at with lstat, so that a
 * symlink (also one that loops) is no file to annotate, and a file that cannot be looked at (EACCES, ELOOP on the way)
 * has none either; the finding stays in the summary and the log.
 */
function annotatable(workspace: string, file: string): boolean {
  try {
    const path = resolve(workspace, file);
    return isInside(workspace, path) && lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** The content of the depcurfew doctor check run. */
function checkRunContent(workspace: string, moved: DoctorReport, prefix: string, outputs: ActionOutputs, counts: ReturnType<typeof countLevels>): CheckRunContent {
  // Annotations only on files in the workspace that exist: a finding about a missing file stays in the summary.
  const annotated = checkRunAnnotations(moved, RULES, (file) => annotatable(workspace, file));
  const note = checkRunAnnotationNote(annotated.omitted);
  const limit = values(environment.githubActions.checkRuns)[0]?.summaryMaxLength ?? Number.MAX_SAFE_INTEGER;
  return {
    name: checkRunName(prefix),
    title: checkRunTitle(moved),
    // fitSummary cuts it to the limit of the API, keeping the note; the job summary has its own, smaller limit.
    summary: `${fitSummary(jobSummary(moved, RULES, prefix, Number.MAX_SAFE_INTEGER), limit - note.length)}${note}`,
    // The findings that fail the step fail the check; others make it neutral.
    conclusion: outputs['fail-reason'] !== '' ? 'failure' : counts.error > 0 || counts.warning > 0 ? 'neutral' : 'success',
    annotations: annotated.annotations,
  };
}

/** Why the check could not be prepared or sent, in plain words: never the message, which may name runner paths. */
function checkRunFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? `a file could not be looked at (${fileSystemReason(error)})` : 'an unexpected error occurred while preparing it';
}

/** The title of the check run: the result and the count of checks, e.g. "No problems found (14 checks: 9 passed, 5 not applicable)". */
function checkRunTitle(report: DoctorReport): string {
  const counts = countLevels(report.findings);
  const result =
    report.findings.length === 0
      ? 'No problems found'
      : (['error', 'warning', 'note'] as const)
          .filter((level) => counts[level] > 0)
          .map((level) => `${counts[level]} ${counts[level] === 1 ? level : `${level}s`}`)
          .join(', ');
  return report.checked === undefined ? result : `${result} (${resultCounts(report.checked.rules)})`;
}

/**
 * Writes step outputs in the format of the GITHUB_OUTPUT file, each on one line. action.yml prints the failure output
 * in the log, so its other control characters are shown as text too.
 */
export function formatOutputs(outputs: ActionOutputs): string {
  return Object.entries(outputs)
    .map(([name, value]) => `${name}=${printable(String(value).replaceAll(/[\r\n]+/gu, ' '))}\n`)
    .join('');
}

export async function main(env: NodeJS.ProcessEnv = process.env, fetchImpl: CheckRunFetch = (url, init) => fetch(url, init)): Promise<void> {
  const summaryVariable = values(environment.githubActions.stepSummary)[0]?.variable;
  const summaryFile = summaryVariable === undefined ? undefined : env[summaryVariable];
  let checkRun: CheckRunContent | undefined;
  const outputs = runAction(env, {
    log: (text) => process.stdout.write(text),
    summary: (markdown) => {
      if (summaryFile !== undefined && summaryFile !== '') appendFileSync(summaryFile, markdown);
    },
    checkRun: (content) => {
      checkRun = content;
    },
  });
  const file = env['GITHUB_OUTPUT'];
  if (file !== undefined && file !== '') appendFileSync(file, formatOutputs(outputs));
  // After the outputs, so that a slow API cannot keep them from the next steps.
  if (checkRun !== undefined) {
    const token = input(env, 'github-token', '');
    let line: string;
    try {
      line = token === '' ? 'depcurfew: the depcurfew doctor check was not added: the input github-token is empty\n' : await createCheckRun(env, token, checkRun, fetchImpl);
    } catch (error) {
      line = `depcurfew: the depcurfew doctor check was not added: ${checkRunFailure(error)}\n`;
    }
    process.stdout.write(line);
  }
}
