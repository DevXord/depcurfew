// What a shell script (a CI run step, a Dockerfile RUN instruction) sets for the commands after it and what each of
// its commands runs, read without running anything (decision D-166): export NAME=value, NAME=value before a command
// (env NAME=value too), and NAME=value lines that echo or printf write to the environment file of GitHub Actions
// ($GITHUB_ENV), which the later steps of the job get. One pass over the script (splitCommands), so a long script
// costs time in proportion to its length.
import { commandParts, splitCommands, type Word } from './commands.ts';

/** A variable a script sets. */
export interface ScriptVariable {
  name: string;
  value: string;
  /** Offset in the script of the command that sets it. */
  offset: number;
  /**
   * export: export NAME=value, for the later commands of the script; command: NAME=value before one command, for that
   * command only; environment-file: a NAME=value line written to the environment file, for the later steps of the job.
   */
  how: 'export' | 'command' | 'environment-file';
  /** command: the program the variable is set for, as written. */
  program?: string;
}

/** A simple command of a script: the program and its arguments, after the assignments and wrappers before them. */
export interface ScriptCommand {
  words: Word[];
  /** The variables set for this command alone (NAME=value before it). */
  assignments: [string, string][];
  /** Offset in the script of its first word. */
  offset: number;
}

export interface ScriptReading {
  variables: ScriptVariable[];
  commands: ScriptCommand[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REDIRECTION = /^\d?>>?$/u;

/** Whether a word, with the quotes the splitter removed, is the variable of the environment file: $GITHUB_ENV or ${GITHUB_ENV}. */
function namesFile(text: string, variable: string): boolean {
  return text === `$${variable}` || text === `\${${variable}}`;
}

/**
 * The index of the words that redirect the output of a command into the environment file (`>> "$GITHUB_ENV"`, also
 * written as one word), and how many words the redirection takes; undefined when it writes elsewhere.
 */
function fileRedirection(words: readonly Word[], variable: string): { index: number; count: number } | undefined {
  for (let index = 0; index < words.length; index++) {
    const text = words[index]?.text ?? '';
    if (REDIRECTION.test(text) && namesFile(words[index + 1]?.text ?? '', variable)) return { index, count: 2 };
    const attached = /^\d?>>?(.+)$/u.exec(text)?.[1];
    if (attached !== undefined && namesFile(attached, variable)) return { index, count: 1 };
  }
  return undefined;
}

/**
 * The lines echo or printf write: echo joins its arguments with spaces (-e reads \n as a line break); printf writes its
 * format, with \n as a line break, or each argument on a line of its own for the format %s\n. undefined for another
 * program or another format.
 */
function writtenLines(words: readonly Word[]): string[] | undefined {
  const program = words[0]?.text;
  const args = words.slice(1).map((word) => word.text);
  if (program === 'echo') {
    let escapes = false;
    while (args.length > 0 && /^-[neE]+$/u.test(args[0] ?? '')) {
      if ((args[0] ?? '').includes('e')) escapes = true;
      args.shift();
    }
    const text = args.join(' ');
    return escapes ? text.split('\\n') : [text];
  }
  if (program === 'printf') {
    const format = args[0];
    if (format === undefined) return undefined;
    if (format === '%s\\n') return args.slice(1);
    return format.includes('%') ? undefined : format.split('\\n');
  }
  return undefined;
}

/**
 * The variables a script sets and the commands it runs. `environmentFile` names the variable of the environment file
 * (GITHUB_ENV) in a CI run step; a Dockerfile has none. A name=value line written there with a name that is not a
 * variable name, or a multiline value (NAME<<DELIMITER), is not read.
 */
export function readScript(script: string, environmentFile?: string): ScriptReading {
  const variables: ScriptVariable[] = [];
  const commands: ScriptCommand[] = [];
  for (const words of splitCommands(script)) {
    const { command, assignments } = commandParts(words);
    const first = command[0];
    const offset = first?.offset ?? words[0]?.offset ?? 0;
    if (first === undefined) continue;
    if (first.text === 'export') {
      for (const word of command.slice(1)) {
        const equals = word.text.indexOf('=');
        const name = word.text.slice(0, equals);
        if (equals > 0 && NAME.test(name)) variables.push({ name, value: word.text.slice(equals + 1), offset: word.offset, how: 'export' });
      }
      continue;
    }
    for (const [name, value] of assignments) variables.push({ name, value, offset, how: 'command', program: first.text });
    commands.push({ words: command, assignments, offset });
    if (environmentFile === undefined) continue;
    const redirection = fileRedirection(command, environmentFile);
    if (redirection === undefined) continue;
    const lines = writtenLines([...command.slice(0, redirection.index), ...command.slice(redirection.index + redirection.count)]);
    for (const line of lines ?? []) {
      const equals = line.indexOf('=');
      const name = line.slice(0, equals);
      if (equals > 0 && NAME.test(name)) variables.push({ name, value: line.slice(equals + 1), offset, how: 'environment-file' });
    }
  }
  return { variables, commands };
}
