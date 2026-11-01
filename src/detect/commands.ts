// Finds the commands of a shell script (a CI run step, a Dockerfile RUN instruction) that install packages with npm,
// pip, pnpm, Yarn or Bun, or that replace npm or pip itself (npm install -g npm@11, pip install --upgrade pip, corepack enable npm). It
// splits the script into simple commands the way a shell roughly would (quotes, ;, &&, ||, |, &, brackets, line
// continuations, # comments) in one pass, without expanding anything: it tells detection where a package manager is
// used, it is not a guard (the install guard in src/check/command.ts reads command lines far more strictly).
import type { ToolCommand } from './types.ts';

/** The facts the reader needs, from the knowledge base (src/detect/knowledge.ts). */
export interface CommandFacts {
  npm: {
    /** Commands that install packages into the project, aliases included. */
    installCommands: readonly string[];
    /** Options that make an install global: --global, -g, --location=global. */
    globalOptions: readonly string[];
    /** npm options followed by a separate value. */
    valueOptions: readonly string[];
    /** npm does not read the project .npmrc in global mode, so npm install -g <package> is no install into the project. */
    globalIgnoresProject: boolean;
  };
  /** pnpm, Yarn and Bun: install commands (pnpm install, pnpm i), add commands, and whether the bare tool installs (yarn). */
  others: readonly { tool: 'pnpm' | 'yarn' | 'bun'; install: readonly string[]; add: readonly string[]; bare: boolean; valueOptions: readonly string[] }[];
  pip: {
    /** Executables whose install command installs packages: pip, pip3. */
    executables: readonly string[];
    installCommand: string;
    valueOptions: readonly string[];
  };
  python: { executables: readonly string[]; moduleOption: string; commandOption: string; valueOptions: readonly string[] };
  corepack: { enableCommand: string };
}

export interface Word {
  text: string;
  /** Offset of the word's first character in the script. */
  offset: number;
}

/** Programs that run the rest of their arguments as a command. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'exec', 'command', 'nohup', 'nice']);
/** Executables that show a job uses Node.js. */
export const NODE_EXECUTABLES = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'corepack']);
const SHELLS = new Set(['sh', 'bash', 'ash', 'dash', 'zsh']);
/** Reserved words of the shell that may come before a command. */
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Splits a script into simple commands of words, in one pass over the text. Quotes are removed, a backslash before a
 * line break joins the lines, and `#` at the start of a word starts a comment.
 */
export function splitCommands(script: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let text = '';
  let start = -1;
  const endWord = () => {
    if (start >= 0) words.push({ text, offset: start });
    text = '';
    start = -1;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const begin = (index: number) => {
    if (start < 0) start = index;
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? '';
    if (char === '\\') {
      const next = script[index + 1];
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next === '\r' && script[index + 2] === '\n') {
        index += 2;
        continue;
      }
      begin(index);
      if (next !== undefined) text += next;
      index += 1;
    } else if (char === "'") {
      begin(index);
      const end = script.indexOf("'", index + 1);
      const close = end < 0 ? script.length : end;
      text += script.slice(index + 1, close);
      index = close;
    } else if (char === '"') {
      begin(index);
      let cursor = index + 1;
      while (cursor < script.length && script[cursor] !== '"') {
        if (script[cursor] === '\\' && cursor + 1 < script.length) cursor += 1;
        text += script[cursor] ?? '';
        cursor += 1;
      }
      index = cursor;
    } else if (char === '$' && script[index + 1] === '{') {
      // ${VAR} stays part of the word, braces included.
      begin(index);
      const end = script.indexOf('}', index + 2);
      const close = end < 0 ? script.length - 1 : end;
      text += script.slice(index, close + 1);
      index = close;
    } else if (char === '#' && start < 0) {
      const end = script.indexOf('\n', index);
      endCommand();
      index = end < 0 ? script.length : end;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
    } else if (char === '\n' || char === ';' || char === '&' || char === '|' || char === '(' || char === ')' || char === '`') {
      // $( opens a command substitution: the $ belongs to no word.
      if (char === '(' && text === '$' && start >= 0 && script[index - 1] === '$') {
        text = '';
        start = -1;
      }
      endCommand();
    } else {
      begin(index);
      text += char;
    }
  }
  endCommand();
  return commands;
}

/** The program name of a word: without its directory, in lower case, without .exe, .cmd, .bat or .ps1. */
function programName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase();
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/u, '');
}

/** The words after assignments and wrappers such as sudo or env: the program and its arguments. */
function commandWords(words: readonly Word[]): Word[] {
  let index = 0;
  while (index < words.length) {
    const text = words[index]?.text ?? '';
    if (ASSIGNMENT.test(text) || RESERVED.has(text)) {
      index += 1;
    } else if (WRAPPERS.has(programName(text))) {
      index += 1;
      while (index < words.length && /^-/u.test(words[index]?.text ?? '')) index += 1;
    } else {
      break;
    }
  }
  return words.slice(index);
}

/** The first argument that is not an option, skipping the values of options that take one. */
function firstOperand(args: readonly Word[], valueOptions: ReadonlySet<string>): number {
  for (let index = 0; index < args.length; index++) {
    const text = args[index]?.text ?? '';
    if (!text.startsWith('-')) return index;
    if (!text.includes('=') && valueOptions.has(text)) index += 1;
  }
  return -1;
}

function operands(args: readonly Word[], valueOptions: ReadonlySet<string>): Word[] {
  const found: Word[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === undefined) continue;
    if (!word.text.startsWith('-')) found.push(word);
    else if (!word.text.includes('=') && valueOptions.has(word.text)) index += 1;
  }
  return found;
}

/** Longer words are no program name depcurfew knows, so they are not looked at further. */
const MAX_NAME = 64;

/**
 * A name that is the executable with a version appended (python3.12, pip3.13) stands for the executable. The suffix is
 * cut by a loop from the end, so a long word of digits takes linear time.
 */
export function matchesExecutable(name: string, executables: readonly string[]): boolean {
  if (name.length > MAX_NAME) return false;
  if (executables.includes(name)) return true;
  let end = name.length;
  while (end > 0 && /[0-9.]/u.test(name[end - 1] ?? '')) end -= 1;
  // The suffix starts with a digit: python3.12 is python, python.12 is not.
  while (end < name.length && name[end] === '.') end += 1;
  return end < name.length && end > 0 && executables.includes(name.slice(0, end));
}

/** -c, or grouped short options that include c (-ec, -xc): a shell reads its script from the next argument. */
export function isCommandOption(text: string): boolean {
  if (text.length < 2 || text.length > MAX_NAME || text[0] !== '-' || text[1] === '-') return false;
  let command = false;
  for (let index = 1; index < text.length; index++) {
    const char = text[index] ?? '';
    if (!/\w/u.test(char)) return false;
    if (char === 'c') command = true;
  }
  return command;
}

type Found = Omit<ToolCommand, 'line'> & { offset: number };

function npmCommand(args: readonly Word[], at: number, facts: CommandFacts): Found | undefined {
  const values = new Set(facts.npm.valueOptions);
  const index = firstOperand(args, values);
  const command = args[index]?.text;
  if (command === undefined || !facts.npm.installCommands.includes(command)) return undefined;
  const rest = args.filter((_, position) => position !== index);
  const global = rest.some((word) => facts.npm.globalOptions.includes(word.text));
  const self = operands(rest, values).find((word) => /^npm(?:@|$)/u.test(word.text));
  if (global && self !== undefined) return { kind: 'upgrade', tool: 'npm', version: self.text.includes('@') ? self.text.slice(4) || 'latest' : 'latest', offset: at };
  // npm install -g typescript installs a program for the machine; npm does not read the project .npmrc then.
  if (global && facts.npm.globalIgnoresProject) return undefined;
  return { kind: 'install', tool: 'npm', offset: at };
}

/** pnpm install, pnpm i, pnpm add, yarn, yarn install, yarn add, bun install, bun add. */
function otherCommand(tool: CommandFacts['others'][number], args: readonly Word[], at: number): Found | undefined {
  const index = firstOperand(args, new Set(tool.valueOptions));
  const command = args[index]?.text;
  if (command === undefined ? tool.bare : tool.install.includes(command) || tool.add.includes(command)) return { kind: 'install', tool: tool.tool, offset: at };
  return undefined;
}

function corepackCommand(args: readonly Word[], at: number, facts: CommandFacts): Found | undefined {
  const command = args.find((word) => !word.text.startsWith('-'));
  if (command === undefined) return undefined;
  const names = args.filter((word) => word !== command && !word.text.startsWith('-'));
  if (command.text === facts.corepack.enableCommand && names.some((word) => word.text === 'npm')) return { kind: 'upgrade', tool: 'npm', offset: at };
  const spec = names.find((word) => word.text.startsWith('npm@'));
  const global = args.some((word) => word.text === '-g' || word.text === '--global');
  const activate = args.some((word) => word.text === '--activate');
  if (spec !== undefined && ((command.text === 'install' && global) || (command.text === 'prepare' && activate))) {
    return { kind: 'upgrade', tool: 'npm', version: spec.text.slice(4) || 'latest', offset: at };
  }
  return undefined;
}

/** The arguments of pip when the words run it: pip install ..., or python -m pip install ... */
function pipArguments(words: readonly Word[], facts: CommandFacts): Word[] | undefined {
  const name = programName(words[0]?.text ?? '');
  if (matchesExecutable(name, facts.pip.executables)) return words.slice(1);
  if (!matchesExecutable(name, facts.python.executables)) return undefined;
  const { moduleOption, commandOption } = facts.python;
  const values = new Set(facts.python.valueOptions);
  const letter = moduleOption.slice(1);
  for (let index = 1; index < words.length; index++) {
    const text = words[index]?.text ?? '';
    if (!text.startsWith('-') || text === commandOption) return undefined;
    // -m pip, -Im pip (grouped flags ending in m) or -mpip.
    const grouped = /^-([A-Za-z]*)$/u.exec(text)?.[1];
    if (text === moduleOption || (grouped !== undefined && grouped.endsWith(letter) && !grouped.slice(0, -1).includes(commandOption.slice(1)))) {
      return words[index + 1]?.text === 'pip' ? words.slice(index + 2) : undefined;
    }
    if (text.startsWith(moduleOption) && text.length > moduleOption.length) return text.slice(moduleOption.length) === 'pip' ? words.slice(index + 1) : undefined;
    if (values.has(text)) index += 1;
  }
  return undefined;
}

/** pip==26.1 or pip>=26.1 as a version: an exact one with three parts (pip pins 26.1 as 26.1.0), a range as written. */
function pipVersion(spec: string): string {
  const exact = /^===?\s*(\d+(?:\.\d+)*)$/u.exec(spec.trim());
  if (exact?.[1] !== undefined) {
    const parts = exact[1].split('.');
    while (parts.length < 3) parts.push('0');
    return parts.join('.');
  }
  return spec.trim();
}

function pipCommand(args: readonly Word[], at: number, facts: CommandFacts): Found | undefined {
  const values = new Set(facts.pip.valueOptions);
  const index = firstOperand(args, values);
  if (args[index]?.text !== facts.pip.installCommand) return undefined;
  const rest = args.slice(index + 1);
  const upgrade = rest.some((word) => word.text === '-U' || word.text === '--upgrade');
  for (const word of operands(rest, values)) {
    const match = /^pip(?=$|[=<>~!\s[;])(?:\[[^\]]*\])?\s*(.*)$/iu.exec(word.text);
    if (match === null) continue;
    const spec = match[1] ?? '';
    if (spec !== '') return { kind: 'upgrade', tool: 'pip', version: pipVersion(spec), offset: at };
    if (upgrade) return { kind: 'upgrade', tool: 'pip', version: 'latest', offset: at };
    return undefined;
  }
  return { kind: 'install', tool: 'pip', offset: at };
}

/** What one simple command does with npm or pip, if anything. */
function readCommand(words: readonly Word[], facts: CommandFacts, depth: number): { found: Found[]; runsNode: boolean } {
  const command = commandWords(words);
  const first = command[0];
  if (first === undefined) return { found: [], runsNode: false };
  const name = programName(first.text);
  const args = command.slice(1);
  // sh -c '...' runs its argument as a script.
  if (SHELLS.has(name) && depth < 2) {
    const script = args.find((_word, index) => index > 0 && isCommandOption(args[index - 1]?.text ?? ''));
    if (script !== undefined) {
      const inner = findToolCommands(script.text, facts, depth + 1);
      return { found: inner.commands.map((item) => ({ ...item, offset: script.offset })), runsNode: inner.runsNode };
    }
  }
  const runsNode = NODE_EXECUTABLES.has(name);
  if (name === 'npm') return { found: [npmCommand(args, first.offset, facts)].filter((item) => item !== undefined), runsNode };
  if (name === 'corepack') return { found: [corepackCommand(args, first.offset, facts)].filter((item) => item !== undefined), runsNode };
  const other = facts.others.find((entry) => entry.tool === name);
  if (other !== undefined) return { found: [otherCommand(other, args, first.offset)].filter((item) => item !== undefined), runsNode };
  const pip = pipArguments(command, facts);
  if (pip !== undefined) return { found: [pipCommand(pip, first.offset, facts)].filter((item) => item !== undefined), runsNode };
  return { found: [], runsNode };
}

/** The install and upgrade commands of a script, with the offset of each in the script, and whether it runs Node.js. */
export function findToolCommands(script: string, facts: CommandFacts, depth = 0): { commands: Found[]; runsNode: boolean } {
  const commands: Found[] = [];
  let runsNode = false;
  for (const words of splitCommands(script)) {
    const result = readCommand(words, facts, depth);
    commands.push(...result.found);
    runsNode ||= result.runsNode;
  }
  return { commands, runsNode };
}

/** The same for the words of an exec form (RUN ["npm", "ci"]), which no shell splits. */
export function findExecCommands(words: readonly Word[], facts: CommandFacts): { commands: Found[]; runsNode: boolean } {
  const result = readCommand(words, facts, 0);
  return { commands: result.found, runsNode: result.runsNode };
}
