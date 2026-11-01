import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { apply } from './apply.ts';
import { paint, paintDiagnostics } from '../color.ts';
import { check, type CheckDependencies } from './check.ts';
import { COMMANDS, findCommand } from './commands.ts';
import { doctor } from './doctor.ts';
import { commandHelpText, helpText } from './help.ts';
import { explain } from './explain.ts';
import { init, initUser } from './init.ts';
import { mcp } from './mcp.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';
import { readStdin } from './stdin.ts';
import { parseVersion, type Version } from '../apply/version.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId } from '../knowledge/types.ts';
import { currentEnvironment } from '../user/environment.ts';
import type { UserEnvironment } from '../user/locate.ts';

export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './io.ts';
export type { CliIo } from './io.ts';

const USAGE_HINT = "Run 'depcurfew --help' for usage.\n";

const GLOBAL_OPTIONS = new Set(['help', 'version']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_DEPENDENCIES: CheckDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  stdin: () => readStdin(),
};

/** --user and --for: the user environment and the versions given, or 'usage' after reporting a usage error. */
function userOptions(
  values: Record<string, boolean | string | string[] | undefined>,
  rest: readonly string[],
  command: string,
  io: CliIo,
  dependencies: CheckDependencies,
): { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> } | 'usage' | undefined {
  const given = Array.isArray(values['for']) ? values['for'] : [];
  if (values['user'] !== true) {
    if (given.length === 0) return undefined;
    io.stderr(`depcurfew: --for works only with --user\nRun 'depcurfew ${command} --help' for usage.\n`);
    return 'usage';
  }
  if (rest.length > 0) {
    io.stderr(`depcurfew: --user takes no directory; it works on the user policy\nRun 'depcurfew ${command} --help' for usage.\n`);
    return 'usage';
  }
  const versions: Partial<Record<ToolId, Version>> = {};
  for (const entry of given) {
    const at = entry.lastIndexOf('@');
    const id = entry.slice(0, at) as ToolId;
    // pip --version prints two parts (pip 26.1), and Python releases may have two: the missing patch is 0.
    const text = entry.slice(at + 1).trim();
    const version = at <= 0 ? undefined : parseVersion(/^v?\d+\.\d+$/u.test(text) ? `${text}.0` : text);
    const tool = knowledgeBase.find((candidate) => candidate.id === id && candidate.kind === 'package-manager');
    if (tool === undefined || version === undefined) {
      io.stderr(`depcurfew: --for expects a package manager and an exact version, e.g. --for pnpm@11.28.10, not '${entry}'\nRun 'depcurfew ${command} --help' for usage.\n`);
      return 'usage';
    }
    versions[id] = version;
  }
  return { environment: dependencies.userEnvironment?.() ?? currentEnvironment(), versions };
}

export async function run(argv: readonly string[], output: CliIo, dependencies: CheckDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const errors = paint(output.colors?.stderr);
  const io: CliIo = { ...output, stderr: (text) => output.stderr(paintDiagnostics(text, errors)) };
  const commandOptions = Object.fromEntries(
    COMMANDS.flatMap((command) => command.options ?? []).map((option) => [
      option.name,
      { type: option.value === undefined ? ('boolean' as const) : ('string' as const), ...(option.multiple === true ? { multiple: true } : {}) },
    ]),
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
    const hint = named === undefined ? USAGE_HINT : `Run 'depcurfew ${named.name} --help' for its options.\n`;
    io.stderr(`depcurfew: ${unknown === undefined ? errorMessage(error) : `unknown option '${unknown}'`}\n${hint}`);
    return EXIT_USAGE;
  }

  const [commandName, ...rest] = parsed.positionals;
  const values = parsed.values as Record<string, boolean | string | string[] | undefined>;
  const text = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);

  if (values['version'] === true) {
    io.stdout(`${getVersion()}\n`);
    return EXIT_OK;
  }
  // depcurfew <command> --help and depcurfew help <command> describe that command.
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
    io.stderr(`depcurfew: unknown command '${commandName}'\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...(command.options ?? []).map((option) => option.name)]);
  const foreign = Object.keys(values).find((name) => !allowed.has(name));
  if (foreign !== undefined) {
    io.stderr(`depcurfew: option '--${foreign}' is not supported by '${command.name}'\nRun 'depcurfew ${command.name} --help' for its options.\n`);
    return EXIT_USAGE;
  }

  if (command.implemented && command.variadic !== true && rest.length > 1) {
    io.stderr(`depcurfew: too many arguments for '${command.name}'\nRun 'depcurfew ${command.name} --help' for usage.\n`);
    return EXIT_USAGE;
  }
  if (command.name === 'init') {
    if (values['user'] === true) {
      if (rest.length > 0) {
        io.stderr(`depcurfew: --user takes no directory; it writes the user policy\nRun 'depcurfew init --help' for usage.\n`);
        return EXIT_USAGE;
      }
      return initUser(values['force'] === true, dependencies.userEnvironment?.() ?? currentEnvironment(), io);
    }
    return init(rest[0], values['force'] === true, io);
  }
  if (command.name === 'explain') return explain(rest[0], values['json'] === true, io);
  if (command.name === 'apply') {
    const user = userOptions(values, rest, command.name, io, dependencies);
    if (user === 'usage') return EXIT_USAGE;
    return apply(rest[0], { dryRun: values['dry-run'] === true, json: values['json'] === true, ...(user === undefined ? {} : { user }) }, io);
  }
  if (command.name === 'doctor') {
    const user = userOptions(values, rest, command.name, io, dependencies);
    if (user === 'usage') return EXIT_USAGE;
    return doctor(rest[0], { json: values['json'] === true, sarif: values['sarif'] === true, strict: values['strict'] === true, ...(user === undefined ? {} : { user }) }, io);
  }
  if (command.name === 'check') {
    return check(rest, { json: values['json'] === true, dir: text('dir'), registry: text('registry'), index: text('index'), hook: text('hook') }, io, dependencies);
  }
  if (command.name === 'mcp') {
    if (rest.length > 0) {
      io.stderr("depcurfew: 'mcp' takes no arguments; pass the project directory with --dir\nRun 'depcurfew mcp --help' for usage.\n");
      return EXIT_USAGE;
    }
    return mcp({ dir: text('dir'), registry: text('registry'), index: text('index') }, io, {
      fetch: dependencies.fetch,
      now: dependencies.now,
      ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
      ...(dependencies.mcpProcess === undefined ? {} : { process: dependencies.mcpProcess }),
    });
  }

  io.stderr(`depcurfew: '${command.name}' is not implemented yet.\n`);
  return EXIT_FAILURE;
}
