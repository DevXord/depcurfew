import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';

export interface OptionInfo {
  name: string;
  summary: string;
  /** For an option that takes a value: its name in the help, e.g. `url`. Options without one are flags. */
  value?: string;
  /** Whether the option may be given more than once. */
  multiple?: boolean;
}

export interface CommandInfo {
  name: string;
  summary: string;
  implemented: boolean;
  /** Positional arguments shown in the help, e.g. `[directory]`. */
  arguments?: string;
  /** Options this command accepts besides the global ones. */
  options?: readonly OptionInfo[];
  /** Whether the command takes any number of positional arguments. */
  variadic?: boolean;
  /** What the command does, for `depcurfew <command> --help`. */
  details: string;
  examples: readonly string[];
  /** Exit codes and what they mean. */
  exitCodes: readonly [number, string][];
}

/** Where apply, doctor and explain work without a directory (projectDirectory in directory.ts). */
const NEAREST_POLICY =
  'Without a directory, the command works on the nearest directory with depcurfew.json, from the current one up to the root of the repository (the directory with .git), and says so when that is a parent; a directory given on the command line is used as it is.';

/** The protocol revisions depcurfew mcp speaks, from the knowledge base. */
function mcpRevisions(): string {
  const revisions = values(environment.mcp.revisions)[0];
  const lifecycle = values(environment.mcp.lifecycle)[0];
  if (revisions === undefined || lifecycle === undefined) return '';
  return `It speaks the ${lifecycle.initialize} handshake of the protocol revisions ${revisions.legacy.join(', ')} and, without it, the revision ${revisions.modern.join(', ')}.`;
}

const MCP_REVISIONS = mcpRevisions();

export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'init',
    summary: 'Create a default policy file (depcurfew.json)',
    implemented: true,
    arguments: '[directory]',
    options: [
      { name: 'force', summary: 'Overwrite an existing depcurfew.json' },
      { name: 'json', summary: 'Print the file written, the projects and tools, the warnings and notes and the errors as JSON, each with a code' },
      { name: 'user', summary: 'Create the user policy (~/.config/depcurfew/depcurfew.json) that apply --user and doctor --user use' },
    ],
    details:
      'Writes depcurfew.json with the default policy: a 3-day release-age delay, install scripts denied, and git and tarball URL dependencies denied. When the repository already sets a longer release-age delay for a tool it detects, cooldown.minimum keeps the longest one, so that apply does not shorten it; init says where it found it. Other files are not changed; run depcurfew apply next to configure the tools. Every warning and note has a code and says what to do; with --json, stdout holds one JSON document and stderr stays empty, with the same exit codes. With --user it writes the user policy instead (~/.config/depcurfew/depcurfew.json, in $XDG_CONFIG_HOME when that is set to an absolute path, in %APPDATA% on Windows), which apply --user and doctor --user use.',
    examples: ['depcurfew init', 'depcurfew init --force', 'depcurfew init --json', 'depcurfew init --user'],
    exitCodes: [
      [0, 'depcurfew.json was written (warnings and notes included)'],
      [1, 'depcurfew.json already exists (pass --force) or cannot be written; with --user also when the home directory cannot be used'],
      [2, 'a usage error, such as an unknown option or a missing directory'],
    ],
  },
  {
    name: 'apply',
    summary: 'Write the policy into the configuration of every target tool',
    implemented: true,
    arguments: '[directory]',
    options: [
      { name: 'dry-run', summary: 'Print a diff of the changes instead of writing them' },
      { name: 'json', summary: 'Print the changes with their diff, the warnings and the errors as JSON, each with a code' },
      { name: 'user', summary: 'Write the user policy into the user-level configuration of the installed tools (~/.npmrc and others)' },
      { name: 'for', value: 'tool@version', multiple: true, summary: 'With --user: the version of a tool, when depcurfew cannot read it from its files' },
    ],
    details:
      `Reads depcurfew.json and writes the matching settings into the configuration files of every package manager and bot it detects (or of the tools listed under targets). Comments and formatting are kept, settings depcurfew does not manage are never removed, and nothing is written when any file cannot be edited. Running it again without changing depcurfew.json changes nothing. Every warning has a code and says what to do; with --json, stdout holds one JSON document and stderr stays empty. ${NEAREST_POLICY} With --user it writes the user policy into the user-level configuration of the installed package managers, which protects every project that does not set those settings itself, and npx, uvx and global installs; the version of each tool is read from its files or given with --for, and a tool that stops every command on a value its version does not understand gets nothing until its version is known.`,
    examples: ['depcurfew apply --dry-run', 'depcurfew apply', 'depcurfew apply --dry-run --json', 'depcurfew apply path/to/project', 'depcurfew apply --user --dry-run', 'depcurfew apply --user --for uv@0.13.6'],
    exitCodes: [
      [0, 'the files match the policy (warnings included)'],
      [1, 'depcurfew.json is missing, invalid or unreadable, or a file cannot be edited or written'],
      [2, 'a usage error, such as an unknown option or a missing directory'],
    ],
  },
  {
    name: 'doctor',
    summary: 'Find configuration that silently does not work and drift from the policy',
    implemented: true,
    arguments: '[directory]',
    options: [
      { name: 'json', summary: 'Print the findings as JSON' },
      { name: 'sarif', summary: 'Print the findings as SARIF 2.1.0 for code scanning' },
      {
        name: 'fail-on',
        value: 'level',
        summary: 'Which findings make doctor exit with 1: error (only errors, the default) or warning (warnings too; notes never fail); overrides doctor.failOn in depcurfew.json',
      },
      { name: 'strict', summary: 'The same as --fail-on warning: exit with 1 for warnings too, not only for errors (notes never fail)' },
      { name: 'user', summary: 'Check the user-level configuration of the installed tools against the user policy, and the environment' },
      { name: 'for', value: 'tool@version', multiple: true, summary: 'With --user: the version of a tool, when depcurfew cannot read it from its files' },
    ],
    details:
      `Checks the repository for configuration that silently does not work (a setting the pinned version ignores, a bot that waits less than the package manager, a lockfile with sources or install scripts the policy denies) and for files that no longer match depcurfew.json. Every finding says where it is and how to fix it. Errors make it fail; warnings do too when doctor.failOn in depcurfew.json is "warning", which depcurfew init writes, so that CI keeps a repository free of them (notes, which say what doctor could not check, never fail). Without doctor.failOn only errors fail. --fail-on error or --fail-on warning overrides the policy, and --strict is --fail-on warning; an invalid or missing depcurfew.json counts as "error" unless --fail-on says otherwise. Without depcurfew.json, only the rules that do not need a policy run; an invalid depcurfew.json is reported as an error finding (invalid-policy), and the same rules run. ${NEAREST_POLICY} With --user it checks the user-level configuration of the installed package managers against the user policy, values there and in files read ahead of it that weaken every project, and environment variables that override it; an invalid or unreadable user policy (user-policy-invalid) and a user file it cannot read, parse or edit (user-config-unreadable) are error findings, and doctor.failOn of the user policy decides whether warnings fail.`,
    examples: ['depcurfew doctor', 'depcurfew doctor --json', 'depcurfew doctor --sarif > depcurfew.sarif', 'depcurfew doctor --fail-on warning', 'depcurfew doctor --fail-on error', 'depcurfew doctor --user'],
    exitCodes: [
      [0, 'no finding that fails: no error, and no warning when warnings fail (notes never fail)'],
      [
        1,
        'at least one finding with level error, or with level warning when doctor.failOn in depcurfew.json or --fail-on is warning (--strict is --fail-on warning; with --user doctor.failOn of the user policy), or depcurfew.json (with --user the user policy) is invalid or unreadable',
      ],
      [2, 'a usage error, such as an unknown option or a missing directory'],
    ],
  },
  {
    name: 'check',
    summary: 'Check packages against the policy before installing them',
    implemented: true,
    arguments: '<package...>',
    variadic: true,
    options: [
      { name: 'json', summary: 'Print the result as JSON' },
      { name: 'dir', value: 'directory', summary: 'Use the depcurfew.json of this directory or the nearest parent, up to the root of the repository (default: the current directory)' },
      { name: 'registry', value: 'url', summary: 'Look packages up in this registry (default: the registry of .npmrc, else the public npm registry)' },
      { name: 'index', value: 'url', summary: 'Look pypi: packages up in this Python package index (default: PyPI)' },
      { name: 'hook', value: 'name', summary: 'Run as a hook that guards installs: claude-code' },
    ],
    details:
      'Looks each package up in the registry before it is installed and checks it against depcurfew.json (or the default policy of depcurfew init): a name the registry does not know, which is how mistyped and made-up names show up, a version younger than the cooldown, install scripts the policy does not allow, a name that looks like a popular package, and sources the policy denies. Python packages carry the prefix pypi: and are looked up on PyPI; for them a version without wheels, which is built from source, counts as install scripts. Every problem comes with what to do instead. With --hook claude-code it reads a Claude Code hook event from stdin and denies or asks about shell commands that would install such packages with npm, pnpm, Yarn, Bun, Deno, pip, uv, Poetry, PDM, Pipenv or pipx; the decision goes to stdout as JSON and the exit code is 0, except when the event cannot be read: then depcurfew exits with the code that makes Claude Code block the command. With --json, stdout holds one JSON document, also for a depcurfew.json that cannot be used, and stderr stays empty.',
    examples: ['depcurfew check zod@4 left-pad', 'depcurfew check pypi:requests pypi:django==5.2', 'depcurfew check --json react@19', 'depcurfew check --dir path/to/project @acme/ui', 'depcurfew check --hook claude-code'],
    exitCodes: [
      [0, 'every package checks out (warnings included)'],
      [1, 'a package breaks the policy or cannot be checked, or depcurfew.json is invalid or unreadable'],
      [2, 'a usage error, such as an unknown option or a missing directory'],
    ],
  },
  {
    name: 'mcp',
    summary: 'Serve check and the policy to AI agents as a Model Context Protocol server over stdio',
    implemented: true,
    options: [
      { name: 'dir', value: 'directory', summary: 'The project directory (default: $CLAUDE_PROJECT_DIR, else the current directory)' },
      { name: 'registry', value: 'url', summary: 'Look packages up in this registry (default: the registry of .npmrc, else the public npm registry)' },
      { name: 'index', value: 'url', summary: 'Look pypi: packages up in this Python package index (default: PyPI)' },
    ],
    details:
      `Runs a Model Context Protocol server that an AI agent's client (Claude Desktop, VS Code, Claude Code or any client that starts a stdio server) starts and talks to over stdin and stdout. It offers two read-only tools: check_packages, the check of depcurfew check --json for up to 50 packages, and explain_policy, the policy that applies to the project. The registry and the index are options of the server, never arguments of a call, so an agent cannot name one that vouches for any package; a directory in a call must be inside the project directory. ${MCP_REVISIONS} It stops when stdin closes, on SIGINT and on SIGTERM. stdout carries only protocol messages; problems go to stderr. The server gives advice: the package manager configuration that depcurfew apply writes is what enforces the policy.`,
    examples: ['depcurfew mcp', 'depcurfew mcp --dir /path/to/project', 'node node_modules/depcurfew/dist/cli.js mcp --registry https://npm.internal.example/'],
    exitCodes: [
      [0, 'the server stopped: stdin or stdout closed, or SIGINT or SIGTERM'],
      [2, 'a usage error, such as an unknown option or a project directory that does not exist'],
    ],
  },
  {
    name: 'explain',
    summary: 'Describe the repository and the policy values for each tool',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'json', summary: 'Print the result as JSON' }],
    details:
      `Shows what depcurfew detects in the repository (package managers and their versions, bots, workspaces, .npmrc files, GitHub Actions workflows) and, with depcurfew.json, the release-age delay written for each tool and, for installScripts and sources, the settings depcurfew apply writes for each tool with their files, or the warning apply gives when a tool cannot enforce them, with its code and what to do. ${NEAREST_POLICY}`,
    examples: ['depcurfew explain', 'depcurfew explain --json'],
    exitCodes: [
      [0, 'the repository was described'],
      [1, 'depcurfew.json is invalid or unreadable, or a directory listed in its projects cannot be used'],
      [2, 'a usage error, such as an unknown option or a missing directory'],
    ],
  },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
