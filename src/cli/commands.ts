export interface CommandInfo {
  name: string;
  summary: string;
  implemented: boolean;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: 'init', summary: 'Detect package managers and bots, create a policy file', implemented: false },
  { name: 'apply', summary: 'Generate configuration for every detected tool', implemented: false },
  { name: 'doctor', summary: 'Find configuration that silently does not work', implemented: false },
  { name: 'explain', summary: 'Show the effective settings for every tool', implemented: false },
];

export function findCommand(name: string): CommandInfo | undefined {
  return COMMANDS.find((command) => command.name === name);
}
