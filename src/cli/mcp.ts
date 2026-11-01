// `depcurfew mcp [--dir <directory>] [--registry <url>] [--index <url>]`: the Model Context Protocol server over stdio,
// for agents other than Claude Code's hook (Claude Desktop, VS Code, and any client that starts a stdio server). The
// project directory is --dir, else CLAUDE_PROJECT_DIR (Claude Code sets it for the servers it starts), else the
// current directory. Exit code 0 when the server stops (stdin closed, stdout closed, SIGINT or SIGTERM), 2 for a usage
// error such as a directory that does not exist; the protocol owns stdout, so every message about it goes to stderr.
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { values } from '../apply/facts.ts';
import type { FetchLike } from '../check/registry.ts';
import { environment } from '../knowledge/environment.ts';
import { startMcpServer, type McpLimits } from '../mcp/server.ts';
import { checkDirectory, reportInputError } from './directory.ts';
import { EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

/** What the server talks over and the process around it; tests replace it. */
export interface McpProcess {
  input: Readable;
  output: Writable;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** Calls `stop` on SIGINT and SIGTERM; returns what removes the handlers. Left out in tests. */
  onSignal?: (stop: () => void) => () => void;
  limits?: Partial<McpLimits>;
}

export interface McpFlags {
  dir: string | undefined;
  registry: string | undefined;
  index: string | undefined;
}

export interface McpDependencies {
  fetch: FetchLike;
  now: () => Date;
  home?: () => string;
  process?: () => McpProcess;
}

/** The streams and signals of this process. */
export function currentProcess(): McpProcess {
  return {
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    cwd: process.cwd(),
    onSignal: (stop) => {
      // Claude Code sends SIGINT, then SIGTERM 100 ms later: both stop the server at once.
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      };
    },
  };
}

export async function mcp(flags: McpFlags, io: CliIo, dependencies: McpDependencies): Promise<number> {
  const host = dependencies.process?.() ?? currentProcess();
  const variable = values(environment.mcp.clients.claudeCode)[0]?.projectDirVariable;
  const fromEnvironment = variable === undefined ? undefined : host.env[variable];
  const given = flags.dir ?? (fromEnvironment === undefined || fromEnvironment === '' ? undefined : fromEnvironment);
  const target = checkDirectory(given, host.cwd);
  if (!target.ok) {
    // Say where the directory came from and which option or variable to change (decision D-113).
    const name = variable ?? 'CLAUDE_PROJECT_DIR';
    const fromVariable = flags.dir === undefined && given !== undefined;
    reportInputError(
      {
        ...target.error,
        message: fromVariable ? `${name} names the project directory, which cannot be used: ${target.error.message}` : target.error.message,
        fix: fromVariable
          ? `Set ${name} to the project directory, or pass --dir with the path of the project directory (--dir wins over ${name})`
          : flags.dir === undefined
            ? 'Start depcurfew mcp in the project directory, or pass --dir with the path of the project directory'
            : 'Pass --dir with the path of the project directory, an existing directory',
      },
      io,
    );
    return EXIT_USAGE;
  }
  const server = startMcpServer({
    input: host.input,
    output: host.output,
    stderr: io.stderr,
    context: {
      projectDir: target.directory,
      registry: flags.registry,
      index: flags.index,
      home: dependencies.home?.() ?? homedir(),
      fetch: dependencies.fetch,
      now: dependencies.now,
    },
    ...(host.limits === undefined ? {} : { limits: host.limits }),
  });
  const removeHandlers = host.onSignal?.(server.stop);
  try {
    await server.done;
  } finally {
    removeHandlers?.();
  }
  return EXIT_OK;
}
