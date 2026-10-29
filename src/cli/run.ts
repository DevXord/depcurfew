import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { apply } from './apply.ts';
import { paint, paintDiagnostics } from '../color.ts';
import { COMMANDS, findCommand } from './commands.ts';
import { doctor } from './doctor.ts';
import { commandHelpText, helpText } from './help.ts';
import { explain } from './explain.ts';
import { init } from './init.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './io.ts';
export type { CliIo } from './io.ts';

const USAGE_HINT = "Run 'depgate --help' for usage.\n";

const GLOBAL_OPTIONS = new Set(['help', 'version']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function run(argv: readonly string[], output: CliIo): Promise<number> {
  const errors = paint(output.colors?.stderr);
  const io: CliIo = { ...output, stderr: (text) => output.stderr(paintDiagnostics(text, errors)) };
  const commandOptions = Object.fromEntries(
    COMMANDS.flatMap((command) => command.options ?? []).map((option) => [option.name, { type: 'boolean' as const }]),
  );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        ...commandOptions,
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // parseArgs explains how to pass a positional that starts with '-'; an unknown option is the usual case.
    const unknown = /Unknown option '([^']+)'/u.exec(errorMessage(error))?.[1];
    const named = findCommand(argv.find((argument) => !argument.startsWith('-')) ?? '');
    const hint = named === undefined ? USAGE_HINT : `Run 'depgate ${named.name} --help' for its options.\n`;
    io.stderr(`depgate: ${unknown === undefined ? errorMessage(error) : `unknown option '${unknown}'`}\n${hint}`);
    return EXIT_USAGE;
  }

  const [commandName, ...rest] = parsed.positionals;
  const values = parsed.values as Record<string, boolean | undefined>;

  if (values['version'] === true) {
    io.stdout(`${getVersion()}\n`);
    return EXIT_OK;
  }
  // depgate <command> --help and depgate help <command> describe that command.
  const helpFor = commandName === 'help' ? findCommand(rest[0] ?? '') : values['help'] === true ? findCommand(commandName ?? '') : undefined;
  if (helpFor !== undefined) {
    io.stdout(commandHelpText(helpFor, paint(io.colors?.stdout)));
    return EXIT_OK;
  }
  if (values['help'] === true || commandName === undefined || commandName === 'help') {
    io.stdout(helpText(paint(io.colors?.stdout)));
    return EXIT_OK;
  }

  const command = findCommand(commandName);
  if (command === undefined) {
    io.stderr(`depgate: unknown command '${commandName}'\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...(command.options ?? []).map((option) => option.name)]);
  const foreign = Object.keys(values).find((name) => !allowed.has(name));
  if (foreign !== undefined) {
    io.stderr(`depgate: option '--${foreign}' is not supported by '${command.name}'\nRun 'depgate ${command.name} --help' for its options.\n`);
    return EXIT_USAGE;
  }

  if (command.implemented && rest.length > 1) {
    io.stderr(`depgate: too many arguments for '${command.name}'\nRun 'depgate ${command.name} --help' for usage.\n`);
    return EXIT_USAGE;
  }
  if (command.name === 'init') return init(rest[0], values['force'] === true, io);
  if (command.name === 'explain') return explain(rest[0], values['json'] === true, io);
  if (command.name === 'apply') return apply(rest[0], values['dry-run'] === true, io);
  if (command.name === 'doctor') return doctor(rest[0], { json: values['json'] === true, sarif: values['sarif'] === true }, io);

  io.stderr(`depgate: '${command.name}' is not implemented yet.\n`);
  return EXIT_FAILURE;
}
