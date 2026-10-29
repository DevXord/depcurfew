import { PLAIN, type Paint } from '../color.ts';
import { COMMANDS, type CommandInfo } from './commands.ts';

/** Wraps a paragraph at `width` columns. */
function wrap(text: string, width = 78): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Headings ("Usage: …", "Options:") in bold. */
function headings(text: string, colors: Paint): string {
  return text.replace(/^(Usage:|[A-Za-z][A-Za-z .<>[\]]*:$)/gmu, (heading) => colors.bold(heading));
}

export function helpText(colors: Paint = PLAIN): string {
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

  const text = [
    'Usage: depcurfew <command> [options]',
    '',
    'One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, Renovate and Dependabot.',
    '',
    'Commands:',
    ...commands,
    '',
    'Options:',
    '  -h, --help     Show this help',
    '  -v, --version  Show the depcurfew version',
    ...commandOptions,
    '',
    "Run 'depcurfew <command> --help' for what a command does, examples and exit codes.",
    '',
  ].join('\n');
  return headings(text, colors);
}

/** `depcurfew <command> --help`: what the command does, its options, examples and exit codes. */
export function commandHelpText(command: CommandInfo, colors: Paint = PLAIN): string {
  const flag = (option: { name: string; value?: string }) => `--${option.name}${option.value === undefined ? '' : ` <${option.value}>`}`;
  const options = [...(command.options ?? []).map((option) => [flag(option), option.summary] as const), ['-h, --help', 'Show this help'] as const];
  const width = Math.max(...options.map(([name]) => name.length));
  const text = [
    `Usage: depcurfew ${[command.name, command.arguments, '[options]'].filter(Boolean).join(' ')}`,
    '',
    `${command.summary}.`,
    '',
    ...wrap(command.details),
    '',
    'Options:',
    ...options.flatMap(([name, summary]) =>
      wrap(summary, 78 - width - 4).map((line, index) => `  ${(index === 0 ? name : '').padEnd(width)}  ${line}`),
    ),
    '',
    'Examples:',
    ...command.examples.map((example) => `  ${example}`),
    '',
    'Exit codes:',
    ...command.exitCodes.flatMap(([code, meaning]) => wrap(meaning, 73).map((line, index) => `  ${index === 0 ? code : ' '}  ${line}`)),
    '',
  ].join('\n');
  return headings(text, colors);
}
