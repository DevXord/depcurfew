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
  { name: 'apply', summary: 'Generate configuration for every detected tool', implemented: false },
  { name: 'doctor', summary: 'Find configuration that silently does not work', implemented: false },
  { name: 'explain', summary: 'Show the effective settings for every tool', implemented: false },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
