// `depgate doctor [directory] [--json | --sarif]`. Exit code 1 when any finding is an error or depgate.json is invalid.
import { PolicyError } from '../apply/index.ts';
import { Repository } from '../detect/repository.ts';
import { countLevels, renderText, RULES, runDoctor, toSarif, type DoctorReport } from '../doctor/index.ts';
import { getVersion } from '../version.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export function doctor(directory: string | undefined, format: { json: boolean; sarif: boolean }, io: CliIo): number {
  if (format.json && format.sarif) {
    io.stderr("depgate: '--json' and '--sarif' cannot be used together\nRun 'depgate --help' for usage.\n");
    return EXIT_USAGE;
  }
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;
  let report: DoctorReport;
  try {
    report = runDoctor(absolute);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    io.stderr(`depgate: ${error.message}\n${error.issues.map((issue) => `  ${issue}\n`).join('')}`);
    return EXIT_FAILURE;
  }
  if (format.sarif) {
    const repository = new Repository(absolute);
    const readLine = (file: string, line: number) => repository.readText(file)?.split(/\r?\n/u)[line - 1];
    io.stdout(`${JSON.stringify(toSarif(report, RULES, getVersion(), readLine), null, 2)}\n`);
  } else if (format.json) {
    io.stdout(`${JSON.stringify({ ...report, summary: countLevels(report.findings) }, null, 2)}\n`);
  } else {
    io.stdout(renderText(report, RULES));
  }
  return countLevels(report.findings).error > 0 ? EXIT_FAILURE : EXIT_OK;
}
