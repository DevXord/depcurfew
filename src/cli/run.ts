import { parseArgs } from 'node:util';
import { getVersion } from '../version.ts';
import { apply } from './apply.ts';
import { paint, paintDiagnostics } from '../color.ts';
import { check, type CheckDependencies } from './check.ts';
import { COMMANDS, findCommand } from './commands.ts';
import { doctor } from './doctor.ts';
import { RULES, toSarif } from '../doctor/index.ts';
import { commandHelpText, helpText } from './help.ts';
import { explain } from './explain.ts';
import { init, initUser } from './init.ts';
import { mcp } from './mcp.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';
import { readStdin } from './stdin.ts';
import { safeJson } from '../json-safe.ts';
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

/**
 * Reports a usage error: on stderr as `depcurfew: <message>` and the hint, or with --json as the JSON document of an
 * error that keeps a command from starting (code usage, the message and the hint as the fix) on stdout, with nothing on
 * stderr (decision D-107). Returns exit code 2.
 */
type Usage = (message: string, hint: string) => number;

function usageReporter(io: CliIo, json: () => boolean, sarif: () => boolean = () => false): Usage {
  return (message, hint) => {
    const error = { code: 'usage', level: 'error' as const, location: { file: '' }, message, fix: hint.replace(/\.\n?$/u, '') };
    if (json()) io.stdout(`${safeJson({ schemaVersion: 1, errors: [{ code: error.code, level: error.level, message, fix: error.fix }] }, 2)}\n`);
    // doctor --sarif alone: a run that did not succeed, so an upload to code scanning gets a document, not an empty file.
    else if (sarif()) io.stdout(`${safeJson(toSarif({ schemaVersion: 1, policy: 'missing', findings: [], notices: [] }, RULES, getVersion(), undefined, [error]), 2)}\n`);
    else io.stderr(`depcurfew: ${message}\n${hint.endsWith('\n') ? hint : `${hint}\n`}`);
    return EXIT_USAGE;
  };
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
  usage: Usage,
  dependencies: CheckDependencies,
): { environment: UserEnvironment; versions: Partial<Record<ToolId, Version>> } | 'usage' | undefined {
  const given = Array.isArray(values['for']) ? values['for'] : [];
  if (values['user'] !== true) {
    if (given.length === 0) return undefined;
    usage('--for works only with --user', `Run 'depcurfew ${command} --help' for usage.`);
    return 'usage';
  }
  if (rest.length > 0) {
    usage('--user takes no directory; it works on the user policy', `Run 'depcurfew ${command} --help' for usage.`);
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
      usage(`--for expects a package manager and an exact version, e.g. --for pnpm@11.28.10, not '${entry}'`, `Run 'depcurfew ${command} --help' for usage.`);
      return 'usage';
    }
    versions[id] = version;
  }
  return { environment: dependencies.userEnvironment?.() ?? currentEnvironment(), versions };
}

export async function run(argv: readonly string[], output: CliIo, dependencies: CheckDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const errors = paint(output.colors?.stderr);
  const io: CliIo = { ...output, stderr: (text) => output.stderr(paintDiagnostics(text, errors)) };
  // --json before the end of the options, also when they cannot be parsed.
  const end = argv.indexOf('--');
  // --json=x and --sarif=x (a value for an option that takes none) are usage errors too, reported in that format.
  const options = end === -1 ? argv : argv.slice(0, end);
  const given = (name: string) => options.some((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));
  const jsonGiven = given('json');
  // Only for a command that prints JSON: the stdout of mcp is its protocol, and init has no --json.
  const named = findCommand(argv.find((argument) => !argument.startsWith('-')) ?? '');
  const sarifGiven = given('sarif');
  const usage = usageReporter(
    io,
    () => jsonGiven && named?.options?.some((option) => option.name === 'json') === true,
    () => sarifGiven && named?.options?.some((option) => option.name === 'sarif') === true,
  );
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
    const valued = /Option '(--[^']+)' does not take an argument/u.exec(errorMessage(error))?.[1];
    const hint = named === undefined ? USAGE_HINT : `Run 'depcurfew ${named.name} --help' for its options.\n`;
    return usage(unknown !== undefined ? `unknown option '${unknown}'` : valued !== undefined ? `option '${valued}' takes no value` : errorMessage(error), hint);
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
    return usage(`unknown command '${commandName}'`, USAGE_HINT);
  }
  const allowed = new Set([...GLOBAL_OPTIONS, ...(command.options ?? []).map((option) => option.name)]);
  const foreign = Object.keys(values).find((name) => !allowed.has(name));
  if (foreign !== undefined) {
    return usage(`option '--${foreign}' is not supported by '${command.name}'`, `Run 'depcurfew ${command.name} --help' for its options.`);
  }

  if (command.implemented && command.variadic !== true && rest.length > 1) {
    return usage(`too many arguments for '${command.name}'`, `Run 'depcurfew ${command.name} --help' for usage.`);
  }
  if (command.name === 'init') {
    if (values['user'] === true) {
      if (rest.length > 0) {
        return usage('--user takes no directory; it writes the user policy', "Run 'depcurfew init --help' for usage.");
      }
      return initUser(values['force'] === true, dependencies.userEnvironment?.() ?? currentEnvironment(), io);
    }
    return init(rest[0], values['force'] === true, io);
  }
  if (command.name === 'explain') return explain(rest[0], values['json'] === true, io);
  if (command.name === 'apply') {
    const user = userOptions(values, rest, command.name, usage, dependencies);
    if (user === 'usage') return EXIT_USAGE;
    return apply(rest[0], { dryRun: values['dry-run'] === true, json: values['json'] === true, ...(user === undefined ? {} : { user }) }, io);
  }
  if (command.name === 'doctor') {
    if (values['json'] === true && values['sarif'] === true) return usage("'--json' and '--sarif' cannot be used together; pick one", "Run 'depcurfew doctor --help' for usage.");
    const user = userOptions(values, rest, command.name, usage, dependencies);
    if (user === 'usage') return EXIT_USAGE;
    return doctor(rest[0], { json: values['json'] === true, sarif: values['sarif'] === true, strict: values['strict'] === true, ...(user === undefined ? {} : { user }) }, io);
  }
  if (command.name === 'check') {
    // The usage errors of check, here so that --json gets them as a document.
    const hook = text('hook');
    if (hook === undefined && rest.length === 0) return usage("'check' needs at least one package, e.g. depcurfew check lodash@4", "Run 'depcurfew check --help' for usage.");
    if (hook !== undefined && rest.length > 0) return usage("'--hook' reads the command from stdin and takes no packages", "Run 'depcurfew check --help' for usage.");
    return check(rest, { json: values['json'] === true, dir: text('dir'), registry: text('registry'), index: text('index'), hook: text('hook') }, io, dependencies);
  }
  if (command.name === 'mcp') {
    if (rest.length > 0) {
      return usage("'mcp' takes no arguments; pass the project directory with --dir", "Run 'depcurfew mcp --help' for usage.");
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
