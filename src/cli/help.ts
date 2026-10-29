import { COMMANDS } from './commands.ts';

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const commands = COMMANDS.map((command) => {
    const status = command.implemented ? '' : ' (planned)';
    return `  ${command.name.padEnd(width)}  ${command.summary}${status}`;
  });
  const flag = (option: { name: string; value?: string }) => `--${option.name}${option.value === undefined ? '' : ` <${option.value}>`}`;
  const flagWidth = Math.max(13, ...COMMANDS.flatMap((command) => command.options ?? []).map((option) => flag(option).length));
  const commandOptions = COMMANDS.filter((command) => command.options !== undefined).flatMap((command) => [
    '',
    `${[command.name, command.arguments].filter(Boolean).join(' ')}:`,
    ...(command.options ?? []).map((option) => `  ${flag(option).padEnd(flagWidth)}  ${option.summary}`),
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
