// `depcurfew doctor [directory] [--json | --sarif]`. Exit code 1 when any finding is an error; an invalid depcurfew.json
// is one (invalid-policy), in every output format.
import { Repository } from '../detect/repository.ts';
import { countLevels, renderText, RULES, runDoctor, toSarif, type DoctorReport } from '../doctor/index.ts';
import { getVersion } from '../version.ts';
import { paint } from '../color.ts';
import { resolveDirectory } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export function doctor(directory: string | undefined, format: { json: boolean; sarif: boolean }, io: CliIo): number {
  if (format.json && format.sarif) {
    io.stderr("depcurfew: '--json' and '--sarif' cannot be used together; pick one\nRun 'depcurfew doctor --help' for usage.\n");
    return EXIT_USAGE;
  }
  const absolute = resolveDirectory(directory, io);
  if (absolute === undefined) return EXIT_FAILURE;
  const report: DoctorReport = runDoctor(absolute, { invalidPolicy: 'report' });
  if (format.sarif) {
    const repository = new Repository(absolute);
    const readLine = (file: string, line: number) => repository.readText(file)?.split(/\r?\n/u)[line - 1];
    io.stdout(`${JSON.stringify(toSarif(report, RULES, getVersion(), readLine), null, 2)}\n`);
  } else if (format.json) {
    io.stdout(`${JSON.stringify({ ...report, summary: countLevels(report.findings) }, null, 2)}\n`);
  } else {
    io.stdout(renderText(report, RULES, paint(io.colors?.stdout)));
  }
  return countLevels(report.findings).error > 0 ? EXIT_FAILURE : EXIT_OK;
}
