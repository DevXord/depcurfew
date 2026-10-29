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
}

export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'init',
    summary: 'Create a default policy file (depgate.json)',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'force', summary: 'Overwrite an existing depgate.json' }],
  },
  {
    name: 'apply',
    summary: 'Write the policy into the configuration of every target tool',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'dry-run', summary: 'Print a diff of the changes instead of writing them' }],
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
  },
  {
    name: 'check',
    summary: 'Check packages against the policy before installing them',
    implemented: true,
    arguments: '<package...>',
    variadic: true,
    options: [
      { name: 'json', summary: 'Print the result as JSON' },
      { name: 'dir', value: 'directory', summary: 'Use the depgate.json of this directory (default: the current one)' },
      { name: 'registry', value: 'url', summary: 'Look packages up in this registry (default: the registry of .npmrc, else the public npm registry)' },
      { name: 'hook', value: 'name', summary: 'Run as a hook that guards installs: claude-code' },
    ],
  },
  {
    name: 'explain',
    summary: 'Describe the repository and the policy values for each tool',
    implemented: true,
    arguments: '[directory]',
    options: [{ name: 'json', summary: 'Print the result as JSON' }],
  },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
