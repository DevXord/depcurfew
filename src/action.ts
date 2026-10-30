// Entry point of the GitHub Action (action.yml, bundled into action/depcurfew.mjs): runs doctor on a directory of the
// workspace, prints the readable report to the log, adds annotations and a job summary for people, writes SARIF
// with paths relative to the repository root for code scanning and sets the step outputs. It does not fail the
// step itself, so the SARIF upload still runs; action.yml decides.
import { appendFileSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { values } from './apply/facts.ts';
import { PolicyError } from './apply/index.ts';
import { writeChanges } from './apply/workspace.ts';
import { Repository } from './detect/repository.ts';
import { annotationCommands, countLevels, failureSummary, jobSummary, renderText, RULES, runDoctor, toSarif, type DoctorReport } from './doctor/index.ts';
import { environment } from './knowledge/environment.ts';
import { getVersion } from './version.ts';

export interface ActionOutputs {
  'sarif-file': string;
  errors: number;
  warnings: number;
  notes: number;
  /** Set when doctor could not run, e.g. because depcurfew.json is invalid. */
  failure: string;
}

export interface ActionIo {
  log(text: string): void;
  /** Appends Markdown to the job summary. */
  summary(markdown: string): void;
}

function input(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

function enabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return input(env, name, 'true') !== 'false';
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
    notices: report.notices.map((notice) => (notice.file === undefined ? notice : { ...notice, file: move(notice.file) })),
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

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** The real path of a directory inside the workspace, following symlinks only as far as they stay inside it. */
function scannedDirectory(workspace: string, input: string): string | undefined {
  try {
    const real = realpathSync(resolve(workspace, input));
    return inside(realpathSync(workspace), real) && statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the SARIF file cannot be written, or undefined. The repository being checked may come from a pull request, so
 * no part of the path inside the workspace may be a symlink, which could send the report over a file elsewhere.
 */
function unsafeOutput(workspace: string, file: string): string | undefined {
  if (!inside(workspace, file)) return undefined;
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
  const outputs: ActionOutputs = { 'sarif-file': '', errors: 0, warnings: 0, notes: 0, failure: '' };
  const summary = enabled(env, 'job-summary');
  const fail = (message: string): ActionOutputs => {
    outputs.failure = message;
    io.log(untrusted(`depcurfew: ${message}\n`));
    if (summary) io.summary(failureSummary(message));
    return outputs;
  };
  const directory = scannedDirectory(workspace, input(env, 'directory', '.'));
  if (directory === undefined) return fail(`directory "${input(env, 'directory', '.')}" is not a directory inside the workspace`);
  const prefix = relative(realpathSync(workspace), directory).split(sep).join('/');

  let report: DoctorReport;
  try {
    report = runDoctor(directory);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    outputs.failure = [error.message, ...error.issues].join('; ');
    io.log(untrusted(`depcurfew: ${error.text}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`));
    if (summary) io.summary(failureSummary(outputs.failure));
    return outputs;
  }
  io.log(untrusted(renderText(report, RULES)));

  const moved = relativeToWorkspace(report, prefix);
  if (enabled(env, 'annotations')) {
    const annotations = annotationCommands(moved, RULES);
    if (annotations.lines.length > 0) io.log(`${annotations.lines.join('\n')}\n`);
    if (annotations.omitted > 0) {
      io.log(`GitHub shows a limited number of annotations per step; ${annotations.omitted} more ${annotations.omitted === 1 ? 'finding is' : 'findings are'} in the report above.\n`);
    }
  }
  if (summary) io.summary(jobSummary(moved, RULES, prefix, summaryLimit()));
  const repository = new Repository(workspace);
  const readLine = (file: string, line: number) => repository.readText(file)?.split(/\r?\n/u)[line - 1];
  const sarif = `${JSON.stringify(toSarif(moved, RULES, getVersion(), readLine), null, 2)}\n`;
  const shownSarif = inside(workspace, sarifFile) ? relative(workspace, sarifFile).split(sep).join('/') : sarifFile;
  try {
    const unsafe = unsafeOutput(workspace, sarifFile);
    if (unsafe !== undefined) return fail(`cannot write the SARIF file ${sarifInput}: ${unsafe}`);
    const before = lstatSync(sarifFile, { throwIfNoEntry: false }) === undefined ? null : '';
    mkdirSync(dirname(sarifFile), { recursive: true });
    writeChanges(dirname(sarifFile), [{ file: basename(sarifFile), before, after: sarif }]);
  } catch (error) {
    return fail(`cannot write the SARIF file ${sarifInput}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const counts = countLevels(report.findings);
  return { ...outputs, 'sarif-file': shownSarif, errors: counts.error, warnings: counts.warning, notes: counts.note };
}

/** Writes step outputs in the format of the GITHUB_OUTPUT file. */
export function formatOutputs(outputs: ActionOutputs): string {
  return Object.entries(outputs)
    .map(([name, value]) => `${name}=${String(value).replaceAll(/[\r\n]+/gu, ' ')}\n`)
    .join('');
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const summaryVariable = values(environment.githubActions.stepSummary)[0]?.variable;
  const summaryFile = summaryVariable === undefined ? undefined : env[summaryVariable];
  const outputs = runAction(env, {
    log: (text) => process.stdout.write(text),
    summary: (markdown) => {
      if (summaryFile !== undefined && summaryFile !== '') appendFileSync(summaryFile, markdown);
    },
  });
  const file = env['GITHUB_OUTPUT'];
  if (file !== undefined && file !== '') appendFileSync(file, formatOutputs(outputs));
}
