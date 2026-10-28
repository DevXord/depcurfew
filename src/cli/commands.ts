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
  { name: 'doctor', summary: 'Find configuration that silently does not work', implemented: false },
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
