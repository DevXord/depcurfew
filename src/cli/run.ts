import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { COMMANDS, findCommand } from './commands.ts';
import { helpText } from './help.ts';
import { init } from './init.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './io.ts';
export type { CliIo } from './io.ts';

const USAGE_HINT = "Run 'depgate --help' for usage.\n";

const GLOBAL_OPTIONS = new Set(['help', 'version']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
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
    io.stderr(`depgate: ${errorMessage(error)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  const [commandName, ...rest] = parsed.positionals;
  const values = parsed.values as Record<string, boolean | undefined>;

  if (values['version'] === true) {
    io.stdout(`${getVersion()}\n`);
    return EXIT_OK;
  }
  if (values['help'] === true || commandName === undefined || commandName === 'help') {
    io.stdout(helpText());
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
    io.stderr(`depgate: option '--${foreign}' is not supported by '${command.name}'\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  if (command.name === 'init') {
    if (rest.length > 1) {
      io.stderr(`depgate: too many arguments for 'init'\n${USAGE_HINT}`);
      return EXIT_USAGE;
    }
    return init(rest[0], values['force'] === true, io);
  }

  io.stderr(`depgate: '${command.name}' is not implemented yet.\n`);
  return EXIT_FAILURE;
}
