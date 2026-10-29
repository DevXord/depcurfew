import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { apply } from './apply.ts';
import { check, type CheckDependencies } from './check.ts';
import { COMMANDS, findCommand } from './commands.ts';
import { doctor } from './doctor.ts';
import { helpText } from './help.ts';
import { explain } from './explain.ts';
import { init } from './init.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';
import { readStdin } from './stdin.ts';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './io.ts';
export type { CliIo } from './io.ts';

const USAGE_HINT = "Run 'depgate --help' for usage.\n";

const GLOBAL_OPTIONS = new Set(['help', 'version']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_DEPENDENCIES: CheckDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  stdin: () => readStdin(),
};

export async function run(argv: readonly string[], io: CliIo, dependencies: CheckDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const commandOptions = Object.fromEntries(
    COMMANDS.flatMap((command) => command.options ?? []).map((option) => [option.name, { type: option.value === undefined ? ('boolean' as const) : ('string' as const) }]),
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
  const values = parsed.values as Record<string, boolean | string | undefined>;
  const text = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);

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

  if (command.implemented && command.variadic !== true && rest.length > 1) {
    io.stderr(`depgate: too many arguments for '${command.name}'\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (command.name === 'init') return init(rest[0], values['force'] === true, io);
  if (command.name === 'explain') return explain(rest[0], values['json'] === true, io);
  if (command.name === 'apply') return apply(rest[0], values['dry-run'] === true, io);
  if (command.name === 'doctor') return doctor(rest[0], { json: values['json'] === true, sarif: values['sarif'] === true }, io);
  if (command.name === 'check') {
    return check(rest, { json: values['json'] === true, dir: text('dir'), registry: text('registry'), hook: text('hook') }, io, dependencies);
  }

  io.stderr(`depgate: '${command.name}' is not implemented yet.\n`);
  return EXIT_FAILURE;
}
