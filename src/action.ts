// Entry point of the GitHub Action (action.yml, bundled into action/depgate.mjs): runs doctor on a directory of the
// workspace, prints the readable report to the log, writes SARIF with paths relative to the repository root and
// sets the step outputs. It does not fail the step itself, so the SARIF upload still runs; action.yml decides.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { PolicyError } from './apply/index.ts';
import { countLevels, renderText, RULES, runDoctor, toSarif, type DoctorReport } from './doctor/index.ts';
import { getVersion } from './version.ts';

export interface ActionOutputs {
  'sarif-file': string;
  errors: number;
  warnings: number;
  notes: number;
  /** Set when doctor could not run, e.g. because depgate.json is invalid. */
  failure: string;
}

export interface ActionIo {
  log(text: string): void;
}

function input(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`]?.trim();
  return value === undefined || value === '' ? fallback : value;
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

export function runAction(env: NodeJS.ProcessEnv, io: ActionIo): ActionOutputs {
  const workspace = resolve(env['GITHUB_WORKSPACE'] ?? process.cwd());
  const directory = resolve(workspace, input(env, 'directory', '.'));
  const sarifFile = resolve(workspace, input(env, 'sarif-file', 'depgate.sarif'));
  const outputs: ActionOutputs = { 'sarif-file': '', errors: 0, warnings: 0, notes: 0, failure: '' };
  const prefix = relative(workspace, directory).split(sep).join('/');
  if (prefix.startsWith('..') || !statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    outputs.failure = `directory "${input(env, 'directory', '.')}" is not a directory inside the workspace`;
    io.log(`depgate: ${outputs.failure}\n`);
    return outputs;
  }

  let report: DoctorReport;
  try {
    report = runDoctor(directory);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    outputs.failure = [error.message, ...error.issues].join('; ');
    io.log(`depgate: ${error.message}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`);
    return outputs;
  }
  io.log(renderText(report, RULES));

  const moved = relativeToWorkspace(report, prefix);
  const readLine = (file: string, line: number) => {
    try {
      return readFileSync(resolve(workspace, file), 'utf8').split(/\r?\n/u)[line - 1];
    } catch {
      return undefined;
    }
  };
  mkdirSync(dirname(sarifFile), { recursive: true });
  writeFileSync(sarifFile, `${JSON.stringify(toSarif(moved, RULES, getVersion(), readLine), null, 2)}\n`);
  const counts = countLevels(report.findings);
  return { ...outputs, 'sarif-file': relative(workspace, sarifFile).split(sep).join('/'), errors: counts.error, warnings: counts.warning, notes: counts.note };
}

/** Writes step outputs in the format of the GITHUB_OUTPUT file. */
export function formatOutputs(outputs: ActionOutputs): string {
  return Object.entries(outputs)
    .map(([name, value]) => `${name}=${String(value).replaceAll(/[\r\n]+/gu, ' ')}\n`)
    .join('');
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const outputs = runAction(env, { log: (text) => process.stdout.write(text) });
  const file = env['GITHUB_OUTPUT'];
  if (file !== undefined && file !== '') appendFileSync(file, formatOutputs(outputs));
}
