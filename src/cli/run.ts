import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { findCommand } from './commands.ts';
import { helpText } from './help.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE_HINT = "Run 'depgate --help' for usage.\n";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.stderr(`depgate: ${errorMessage(error)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  const [commandName] = parsed.positionals;

  if (parsed.values.version === true) {
    io.stdout(`${getVersion()}\n`);
    return EXIT_OK;
  }
  if (parsed.values.help === true || commandName === undefined || commandName === 'help') {
    io.stdout(helpText());
    return EXIT_OK;
  }

  const command = findCommand(commandName);
  if (command === undefined) {
    io.stderr(`depgate: unknown command '${commandName}'\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  io.stderr(`depgate: '${command.name}' is not implemented yet.\n`);
  return EXIT_FAILURE;
}
