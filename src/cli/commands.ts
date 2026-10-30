export interface OptionInfo {
  name: string;
  summary: string;
  /** For an option that takes a value: its name in the help, e.g. `url`. Options without one are flags. */
  value?: string;
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

export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'init',
    summary: 'Create a default policy file (depcurfew.json)',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'force', summary: 'Overwrite an existing depcurfew.json' }],
    details:
      'Writes depcurfew.json with the default policy: a 3-day release-age delay, install scripts denied, and git and tarball URL dependencies denied. Other files are not changed; run depcurfew apply next to configure the tools.',
    examples: ['depcurfew init', 'depcurfew init --force'],
    exitCodes: [
      [0, 'depcurfew.json was written'],
      [1, 'depcurfew.json already exists (pass --force) or cannot be written'],
      [2, 'a usage error'],
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
    ],
    details:
      'Reads depcurfew.json and writes the matching settings into the configuration files of every package manager and bot it detects (or of the tools listed under targets). Comments and formatting are kept, settings depcurfew does not manage are never removed, and nothing is written when any file cannot be edited. Running it again without changing depcurfew.json changes nothing. Every warning has a code and says what to do; with --json, stdout holds one JSON document and stderr stays empty.',
    examples: ['depcurfew apply --dry-run', 'depcurfew apply', 'depcurfew apply --dry-run --json', 'depcurfew apply path/to/project'],
    exitCodes: [
      [0, 'the files match the policy (warnings included)'],
      [1, 'depcurfew.json is missing or invalid, or a file cannot be edited'],
      [2, 'a usage error'],
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
    ],
    details:
      'Checks the repository for configuration that silently does not work (a setting the pinned version ignores, a bot that waits less than the package manager, a lockfile with sources or install scripts the policy denies) and for files that no longer match depcurfew.json. Every finding says where it is and how to fix it. Without depcurfew.json, only the rules that do not need a policy run; an invalid depcurfew.json is reported as an error finding (invalid-policy), and the same rules run.',
    examples: ['depcurfew doctor', 'depcurfew doctor --json', 'depcurfew doctor --sarif > depcurfew.sarif'],
    exitCodes: [
      [0, 'no finding with level error (warnings and notes included)'],
      [1, 'at least one finding with level error, or depcurfew.json is invalid'],
      [2, 'a usage error'],
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
      { name: 'dir', value: 'directory', summary: 'Use the depcurfew.json of this directory (default: the current one)' },
      { name: 'registry', value: 'url', summary: 'Look packages up in this registry (default: the registry of .npmrc, else the public npm registry)' },
      { name: 'hook', value: 'name', summary: 'Run as a hook that guards installs: claude-code' },
    ],
    details:
      'Looks each package up in the registry before it is installed and checks it against depcurfew.json (or the default policy of depcurfew init): a name the registry does not know, which is how mistyped and made-up names show up, a version younger than the cooldown, install scripts the policy does not allow, a name that looks like a popular package, and sources the policy denies. Every problem comes with what to do instead. With --hook claude-code it reads a Claude Code hook event from stdin and denies or asks about shell commands that would install such packages; the decision goes to stdout as JSON and the exit code is 0, except when the event cannot be read: then depcurfew exits with the code that makes Claude Code block the command. With --json, stdout holds one JSON document, also for a depcurfew.json that cannot be used, and stderr stays empty.',
    examples: ['depcurfew check zod@4 left-pad', 'depcurfew check --json react@19', 'depcurfew check --dir path/to/project @acme/ui', 'depcurfew check --hook claude-code'],
    exitCodes: [
      [0, 'every package checks out (warnings included)'],
      [1, 'a package breaks the policy or cannot be checked, or depcurfew.json is invalid'],
      [2, 'a usage error'],
    ],
  },
  {
    name: 'explain',
    summary: 'Describe the repository and the policy values for each tool',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'json', summary: 'Print the result as JSON' }],
    details:
      'Shows what depcurfew detects in the repository (package managers and their versions, bots, workspaces, .npmrc files, GitHub Actions workflows) and, with depcurfew.json, the value written for each tool.',
    examples: ['depcurfew explain', 'depcurfew explain --json'],
    exitCodes: [
      [0, 'the repository was described'],
      [1, 'depcurfew.json is invalid'],
      [2, 'a usage error'],
    ],
  },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
