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
    /** npm ci and its aliases: they install the versions of package-lock.json (extra.cleanInstall). */
    cleanCommands: readonly string[];
    /** --ignore-scripts and npm_config_ignore_scripts=true turn dependency install scripts off (extra.scriptsOff). */
    scriptsOff?: { option: string; variable: string; value: string };
  };
  /** pnpm, Yarn and Bun: install commands (pnpm install, pnpm i), add commands, and whether the bare tool installs (yarn). */
  others: readonly { tool: 'pnpm' | 'yarn' | 'bun'; install: readonly string[]; add: readonly string[]; bare: boolean; valueOptions: readonly string[] }[];
  pip: {
    /** Executables whose install command installs packages: pip, pip3. */
    executables: readonly string[];
    installCommand: string;
    valueOptions: readonly string[];
    /** --uploaded-prior-to, PIP_UPLOADED_PRIOR_TO and PIP_CONFIG_FILE: where pip takes its release-age delay from. */
    delay?: { option: string; variable: string; configVariable: string };
    /** pip config set, unset and edit, and the names of pip's configuration files (pip.conf, pip.ini). */
    config?: { command: string; writes: readonly string[]; files: readonly string[] };
  };
  python: { executables: readonly string[]; moduleOption: string; commandOption: string; valueOptions: readonly string[] };
  corepack: { enableCommand: string };
  /** The package of Poetry and the commands that install it (pipx install, pip install; poetry extra.installedPackage). */
  poetry?: { name: string; commands: readonly (readonly string[])[] };
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
  return splitWithDepth(script).map((command) => command.words);
}

/**
 * The same, with how deep in ( ) and $( ) each command is: a cd in a subshell does not change the directory of the
 * commands after it (decision D-115).
 */
function splitWithDepth(script: string): { words: Word[]; depth: number }[] {
  const commands: { words: Word[]; depth: number }[] = [];
  let words: Word[] = [];
  let text = '';
  let start = -1;
  let depth = 0;
  const endWord = () => {
    if (start >= 0) words.push({ text, offset: start });
    text = '';
    start = -1;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push({ words, depth });
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
      if (char === '(') depth += 1;
      else if (char === ')' && depth > 0) depth -= 1;
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
  return commandParts(words).command;
}

/** The program and its arguments, and the variables the command line sets for it (NAME=value, env NAME=value). */
function commandParts(words: readonly Word[]): { command: Word[]; assignments: [string, string][] } {
  const assignments: [string, string][] = [];
  let index = 0;
  while (index < words.length) {
    const text = words[index]?.text ?? '';
    if (ASSIGNMENT.test(text)) {
      const equals = text.indexOf('=');
      assignments.push([text.slice(0, equals), text.slice(equals + 1)]);
      index += 1;
    } else if (RESERVED.has(text)) {
      index += 1;
    } else if (WRAPPERS.has(programName(text))) {
      index += 1;
      while (index < words.length && /^-/u.test(words[index]?.text ?? '')) index += 1;
    } else {
      break;
    }
  }
  return { command: words.slice(index), assignments };
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

/** The options of a list as a set, made once per list (the facts are the same for every command of a run). */
const SETS = new WeakMap<readonly string[], ReadonlySet<string>>();
function setOf(list: readonly string[]): ReadonlySet<string> {
  let found = SETS.get(list);
  if (found === undefined) {
    found = new Set(list);
    SETS.set(list, found);
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

/** A command as found: `cd` is the directory it runs in relative to where the script starts ('' there), as written. */
type Found = Omit<ToolCommand, 'line' | 'directory'> & { offset: number; cd?: string };

/** The variables a command sees: those set before the script (CI env, Dockerfile ENV), by export, and on its own line. */
export type Environment = ReadonlyMap<string, string>;

/** The value of a variable that the tool reads in any case (npm_config_*), the last one set winning. */
function anyCase(environment: Environment, name: string): string | undefined {
  let found: string | undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of environment) if (key.toLowerCase() === lower) found = value;
  return found;
}

/**
 * Whether npm runs with dependency install scripts off: npm_config_ignore_scripts=true in any case, then
 * --ignore-scripts (or =true, or followed by true) on the command line, which a later --ignore-scripts=false or
 * --no-ignore-scripts turns back on. Only the value true counts: anything else may leave them on (decision D-115).
 */
function scriptsOff(args: readonly Word[], environment: Environment, facts: CommandFacts): boolean {
  const known = facts.npm.scriptsOff;
  if (known === undefined) return false;
  let off = anyCase(environment, known.variable) === known.value;
  const negated = `--no-${known.option.slice(2)}`;
  for (const [index, word] of args.entries()) {
    if (word.text === known.option) {
      const next = args[index + 1]?.text;
      off = next !== 'false';
    } else if (word.text.startsWith(`${known.option}=`)) {
      off = word.text.slice(known.option.length + 1) === known.value;
    } else if (word.text === negated) {
      off = false;
    }
  }
  return off;
}

function npmCommand(args: readonly Word[], at: number, facts: CommandFacts, environment: Environment): Found | undefined {
  const values = setOf(facts.npm.valueOptions);
  const index = firstOperand(args, values);
  const command = args[index]?.text;
  if (command === undefined || !facts.npm.installCommands.includes(command)) return undefined;
  const rest = args.filter((_, position) => position !== index);
  const global = rest.some((word) => facts.npm.globalOptions.includes(word.text));
  const self = operands(rest, values).find((word) => /^npm(?:@|$)/u.test(word.text));
  if (global && self !== undefined) return { kind: 'upgrade', tool: 'npm', version: self.text.includes('@') ? self.text.slice(4) || 'latest' : 'latest', offset: at };
  // npm install -g typescript installs a program for the machine; npm does not read the project .npmrc then.
  if (global && facts.npm.globalIgnoresProject) return undefined;
  return {
    kind: 'install',
    tool: 'npm',
    ...(facts.npm.cleanCommands.includes(command) ? { lockfile: true as const } : {}),
    ...(scriptsOff(rest, environment, facts) ? { scriptsOff: true as const } : {}),
    offset: at,
  };
}

/** pnpm install, pnpm i, pnpm add, yarn, yarn install, yarn add, bun install, bun add. */
function otherCommand(tool: CommandFacts['others'][number], args: readonly Word[], at: number): Found | undefined {
  const index = firstOperand(args, setOf(tool.valueOptions));
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
  const values = setOf(facts.python.valueOptions);
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

/** poetry==2.3.0 (or poetry>=2.4) among the operands of an install: the Poetry it installs, as written (decision D-115). */
function poetryVersions(words: readonly Word[], at: number, facts: CommandFacts): Found[] {
  const name = facts.poetry?.name;
  if (name === undefined) return [];
  return words.flatMap((word): Found[] => {
    const match = new RegExp(`^${name}(?:\\[[^\\]]*\\])?\\s*([=<>~!].*)$`, 'iu').exec(word.text);
    const spec = match?.[1];
    return spec === undefined ? [] : [{ kind: 'upgrade', tool: 'poetry', version: pipVersion(spec), offset: at }];
  });
}

/**
 * The release-age delay a pip install gets (decision D-115): --uploaded-prior-to on the command line, else
 * PIP_UPLOADED_PRIOR_TO; unknown when PIP_CONFIG_FILE names a file that may set it, or the value has a variable.
 */
function pipDelay(args: readonly Word[], environment: Environment, facts: CommandFacts): Pick<ToolCommand, 'delay' | 'delayUnknown'> {
  const known = facts.pip.delay;
  if (known === undefined) return {};
  let value = environment.get(known.variable);
  for (const [index, word] of args.entries()) {
    if (word.text === known.option) value = args[index + 1]?.text;
    else if (word.text.startsWith(`${known.option}=`)) value = word.text.slice(known.option.length + 1);
  }
  const config = environment.get(known.configVariable);
  if ((config !== undefined && config !== '') || value?.includes('$') === true) return { delayUnknown: true };
  return value === undefined || value === '' ? {} : { delay: value };
}

function pipCommand(args: readonly Word[], at: number, facts: CommandFacts, environment: Environment): Found[] {
  const values = setOf(facts.pip.valueOptions);
  const index = firstOperand(args, values);
  if (args[index]?.text !== facts.pip.installCommand) return [];
  const rest = args.slice(index + 1);
  const upgrade = rest.some((word) => word.text === '-U' || word.text === '--upgrade');
  for (const word of operands(rest, values)) {
    const match = /^pip(?=$|[=<>~!\s[;])(?:\[[^\]]*\])?\s*(.*)$/iu.exec(word.text);
    if (match === null) continue;
    const spec = match[1] ?? '';
    if (spec !== '') return [{ kind: 'upgrade', tool: 'pip', version: pipVersion(spec), offset: at }];
    if (upgrade) return [{ kind: 'upgrade', tool: 'pip', version: 'latest', offset: at }];
    return [];
  }
  return [{ kind: 'install', tool: 'pip', ...pipDelay(rest, environment, facts), offset: at }, ...poetryVersions(operands(rest, values), at, facts)];
}

/** pipx install poetry==2.3.0: the Poetry it installs. */
function pipxCommand(args: readonly Word[], at: number, facts: CommandFacts): Found[] {
  const pipx = facts.poetry?.commands.find((command) => command[0] === 'pipx');
  const index = args.findIndex((word) => !word.text.startsWith('-'));
  if (pipx === undefined || args[index]?.text !== pipx[1]) return [];
  return poetryVersions(args.slice(index + 1).filter((word) => !word.text.startsWith('-')), at, facts);
}

/**
 * Whether a simple command may change pip's configuration: pip config set, unset or edit, or a word naming pip.conf or
 * pip.ini (cp, tee, a redirection to it). Then the delay of later pip installs cannot be told (decision D-115).
 */
function changesPipConfig(words: readonly Word[], facts: CommandFacts): boolean {
  const config = facts.pip.config;
  if (config === undefined) return false;
  if (words.some((word) => config.files.includes(programName(word.text.replace(/^\d*>+/u, ''))))) return true;
  const pip = pipArguments(words, facts);
  if (pip === undefined) return false;
  const operands = pip.filter((word) => !word.text.startsWith('-'));
  return operands[0]?.text === config.command && config.writes.includes(operands[1]?.text ?? '');
}

/** What one simple command does with npm or pip, if anything. */
function readCommand(words: readonly Word[], facts: CommandFacts, depth: number, environment: Environment = new Map()): { found: Found[]; runsNode: boolean; pipConfig?: true } {
  const { command, assignments } = commandParts(words);
  const first = command[0];
  if (first === undefined) return { found: [], runsNode: false };
  if (changesPipConfig(command, facts)) return { found: [], runsNode: false, pipConfig: true };
  const seen: Environment = assignments.length === 0 ? environment : new Map([...environment, ...assignments]);
  const name = programName(first.text);
  const args = command.slice(1);
  // sh -c '...' runs its argument as a script.
  if (SHELLS.has(name) && depth < 2) {
    const script = args.find((_word, index) => index > 0 && isCommandOption(args[index - 1]?.text ?? ''));
    if (script !== undefined) {
      const inner = findToolCommands(script.text, facts, depth + 1, seen);
      return { found: inner.commands.map((item) => ({ ...item, offset: script.offset })), runsNode: inner.runsNode, ...(inner.pipConfig === true ? { pipConfig: true as const } : {}) };
    }
  }
  const runsNode = NODE_EXECUTABLES.has(name);
  if (name === 'npm') return { found: [npmCommand(args, first.offset, facts, seen)].filter((item) => item !== undefined), runsNode };
  if (name === 'corepack') return { found: [corepackCommand(args, first.offset, facts)].filter((item) => item !== undefined), runsNode };
  const other = facts.others.find((entry) => entry.tool === name);
  if (other !== undefined) return { found: [otherCommand(other, args, first.offset)].filter((item) => item !== undefined), runsNode };
  if (name === 'pipx') return { found: pipxCommand(args, first.offset, facts), runsNode };
  const pip = pipArguments(command, facts);
  if (pip !== undefined) return { found: pipCommand(pip, first.offset, facts, seen), runsNode };
  return { found: [], runsNode };
}

/**
 * A directory a cd leads to that depcurfew does not follow ($DIR, ~, an absolute path, a path out of the start). No
 * directory listed in projects can have this name (project-directory.ts refuses < and >).
 */
export const UNKNOWN_DIRECTORY = '<unknown>';

/**
 * The directory after `cd <path>` from `current` (relative to where the script starts, '' there): a literal relative
 * path is followed, .. included; anything else (a variable, ~, -, an absolute path, out of the start) is unknown.
 */
function changeDirectory(current: string, target: string | undefined): string {
  if (current === UNKNOWN_DIRECTORY || target === undefined || target === '' || /[$~`*?]/u.test(target) || target.startsWith('/') || target === '-') return UNKNOWN_DIRECTORY;
  const parts = current === '' ? [] : current.split('/');
  for (const part of target.replace(/\\/gu, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return UNKNOWN_DIRECTORY;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * The install and upgrade commands of a script, with the offset of each in the script, and whether it runs Node.js.
 * `environment` holds the variables set before the script (CI env, Dockerfile ENV); export NAME=value adds to them for
 * the later commands. A literal cd changes the directory of the later commands of the same shell (`cd`, relative to
 * where the script starts), not of those after the ( ) it is in (decision D-115).
 */
export function findToolCommands(script: string, facts: CommandFacts, depth = 0, environment: Environment = new Map()): { commands: Found[]; runsNode: boolean; pipConfig?: true } {
  const commands: Found[] = [];
  let runsNode = false;
  let pipConfig = false;
  const variables = new Map(environment);
  // The directory at each depth of ( ); a deeper command starts from the one around it.
  const directories: string[] = [''];
  for (const { words, depth: level } of splitWithDepth(script)) {
    while (directories.length <= level) directories.push(directories.at(-1) ?? '');
    directories.length = level + 1;
    const here = directories[level] ?? '';
    const { command } = commandParts(words);
    const program = command[0]?.text;
    if (program === 'cd') {
      directories[level] = changeDirectory(here, command.find((word, index) => index > 0 && !word.text.startsWith('-'))?.text ?? '~');
      continue;
    }
    if (program === 'export') {
      for (const word of command.slice(1)) {
        const equals = word.text.indexOf('=');
        if (equals > 0 && ASSIGNMENT.test(word.text)) variables.set(word.text.slice(0, equals), word.text.slice(equals + 1));
      }
      continue;
    }
    const result = readCommand(words, facts, depth, variables);
    for (const found of result.found) {
      const cd = found.cd === undefined ? here : here === '' ? found.cd : found.cd === '' ? here : changeDirectory(here, found.cd);
      commands.push(cd === '' ? (({ cd: _cd, ...rest }) => rest)(found) : { ...found, cd });
    }
    runsNode ||= result.runsNode;
    pipConfig ||= result.pipConfig === true;
  }
  return { commands, runsNode, ...(pipConfig ? { pipConfig: true as const } : {}) };
}

/** The same for the words of an exec form (RUN ["npm", "ci"]), which no shell splits. */
export function findExecCommands(words: readonly Word[], facts: CommandFacts, environment: Environment = new Map()): { commands: Found[]; runsNode: boolean; pipConfig?: true } {
  const result = readCommand(words, facts, 0, environment);
  return { commands: result.found, runsNode: result.runsNode, ...(result.pipConfig === true ? { pipConfig: true as const } : {}) };
}
