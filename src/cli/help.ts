import { COMMANDS } from './commands.ts';

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const commands = COMMANDS.map((command) => {
    const status = command.implemented ? '' : ' (planned)';
    return `  ${command.name.padEnd(width)}  ${command.summary}${status}`;
  });

  return [
    'Usage: depgate <command> [options]',
    '',
    'One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, Renovate and Dependabot.',
    '',
    'Commands:',
    ...commands,
    '',
    'Options:',
    '  -h, --help     Show this help',
    '  -v, --version  Show the depgate version',
    '',
  ].join('\n');
}
