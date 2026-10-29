export interface OptionInfo {
  name: string;
  summary: string;
}

export interface CommandInfo {
  name: string;
  summary: string;
  implemented: boolean;
  /** Positional arguments shown in the help, e.g. `[directory]`. */
  arguments?: string;
  /** Boolean flags this command accepts besides the global ones. */
  options?: readonly OptionInfo[];
  /** What the command does, for `depgate <command> --help`. */
  details: string;
  examples: readonly string[];
  /** Exit codes and what they mean. */
  exitCodes: readonly [number, string][];
}

export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'init',
    summary: 'Create a default policy file (depgate.json)',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'force', summary: 'Overwrite an existing depgate.json' }],
    details:
      'Writes depgate.json with the default policy: a 3-day release-age delay, install scripts denied, and git and tarball URL dependencies denied. Other files are not changed; run depgate apply next to configure the tools.',
    examples: ['depgate init', 'depgate init --force'],
    exitCodes: [
      [0, 'depgate.json was written'],
      [1, 'depgate.json already exists (pass --force) or cannot be written'],
      [2, 'a usage error'],
    ],
  },
  {
    name: 'apply',
    summary: 'Write the policy into the configuration of every target tool',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'dry-run', summary: 'Print a diff of the changes instead of writing them' }],
    details:
      'Reads depgate.json and writes the matching settings into the configuration files of every package manager and bot it detects (or of the tools listed under targets). Comments and formatting are kept, settings depgate does not manage are never removed, and nothing is written when any file cannot be edited. Running it again without changing depgate.json changes nothing.',
    examples: ['depgate apply --dry-run', 'depgate apply', 'depgate apply path/to/project'],
    exitCodes: [
      [0, 'the files match the policy (warnings included)'],
      [1, 'depgate.json is missing or invalid, or a file cannot be edited'],
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
      'Checks the repository for configuration that silently does not work (a setting the pinned version ignores, a bot that waits less than the package manager, a lockfile with sources or install scripts the policy denies) and for files that no longer match depgate.json. Every finding says where it is and how to fix it. Without depgate.json, only the rules that do not need a policy run.',
    examples: ['depgate doctor', 'depgate doctor --json', 'depgate doctor --sarif > depgate.sarif'],
    exitCodes: [
      [0, 'no finding with level error (warnings and notes included)'],
      [1, 'at least one finding with level error, or depgate.json is invalid'],
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
      'Shows what depgate detects in the repository (package managers and their versions, bots, workspaces, .npmrc files, GitHub Actions workflows) and, with depgate.json, the value written for each tool.',
    examples: ['depgate explain', 'depgate explain --json'],
    exitCodes: [
      [0, 'the repository was described'],
      [1, 'depgate.json is invalid'],
      [2, 'a usage error'],
    ],
  },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
