import { COMMANDS } from './commands.ts';

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const commands = COMMANDS.map((command) => {
    const status = command.implemented ? '' : ' (planned)';
    return `  ${command.name.padEnd(width)}  ${command.summary}${status}`;
  });
  const commandOptions = COMMANDS.filter((command) => command.options !== undefined).flatMap((command) => [
    '',
    `${[command.name, command.arguments].filter(Boolean).join(' ')}:`,
    ...(command.options ?? []).map((option) => `  ${`--${option.name}`.padEnd(13)}  ${option.summary}`),
  ]);

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
    ...commandOptions,
    '',
  ].join('\n');
}
