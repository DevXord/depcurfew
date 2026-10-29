// Finds the packages a shell command line installs or downloads to run, for the install guard. It reads the line the
// way a POSIX shell splits it (quotes, escapes, &&, ||, ;, |, subshells, redirections, here-documents, reserved words)
// without running anything, and follows the command lines inside it: command substitutions, sh -c, eval, npx -c,
// a shell fed by a here-document and wrappers such as sudo, env, timeout or xargs. Words the shell would expand ($VAR,
// $(...), backticks, globs, $'...', {a,b}) cannot be known in advance; when such a word is part of an install command,
// the result says the command cannot be read, so the caller asks a person instead of guessing. So does an install
// next to a setting that points the package manager at another registry or configuration file. It is a guard against
// mistakes and simple disguises, not a sandbox: a program that installs packages itself (node -e, a script file) is
// not seen.
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { CommandLineKnowledge, DownloadCommand, RegistryOverridesKnowledge, ToolId } from '../knowledge/types.ts';

interface Word {
  text: string;
  /** The shell would expand part of it. */
  dynamic: boolean;
  /** xargs fills it from its input. */
  input?: boolean;
}

interface HereDocument {
  body: string;
}

type Item =
  | { kind: 'word'; word: Word }
  | { kind: 'separator' }
  | { kind: 'redirect' }
  | { kind: 'heredoc'; document: HereDocument }
  | { kind: 'herestring' };

export interface InstallRequest {
  tool: ToolId;
  /** The command as written, for messages. */
  command: string;
  spec: string;
}

export interface CommandScan {
  requests: InstallRequest[];
  /** Why an install command could not be read; undefined when every one could. */
  unreadable: string | undefined;
}

const SEPARATORS = ['&&', '||', '|&', ';;', '|', ';', '&', '(', ')'];
/** How deep command lines inside command lines are followed; anything deeper cannot be read. */
const MAX_DEPTH = 4;
/** How deep brackets may nest while a line is split. */
const MAX_NESTING = 64;
/** Brace expansion ({a,b} or {1..3}) in the unquoted part of a word. */
const BRACES = /\{[^{}]*(?:,|\.\.)[^{}]*\}/u;
/** Globs in the unquoted part of a word: *, ? and a bracket expression such as [ab]. */
const GLOB = /[*?]|\[[^\]]*\]/u;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/u;
/** A word that is one expansion as a whole, so nothing of it is known: $CMD, ${CMD}, $(...) or `...`. */
const WHOLE_EXPANSION = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|\$\{[^}]*\}|\$\(.*\)|`.*`)$/su;

class Unreadable extends Error {}

interface Reading {
  items: Item[];
  /** Command lines the shell runs to expand words: $(...), backticks, <(...) and >(...), also inside ${...}. */
  substitutions: string[];
  /** Index after the closing bracket (or the end of the line). */
  end: number;
  closed: boolean;
}

/** The command substitutions in the body of a here-document whose delimiter is not quoted. */
function bodySubstitutions(body: string, level: number): string[] {
  const found: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '$' && (body[index + 1] === '(' || body[index + 1] === '{')) {
      const inner = read(body, index + 2, body[index + 1] === '(' ? ')' : '}', level + 1);
      found.push(body.slice(index + 2, inner.closed ? inner.end - 1 : inner.end));
      index = inner.end - 1;
    } else if (char === '`') {
      let end = index + 1;
      while (end < body.length && body[end] !== '`') end += body[end] === '\\' ? 2 : 1;
      found.push(body.slice(index + 1, end));
      index = end;
    }
  }
  return found;
}

/**
 * Splits a command line into words and separators from `start`, as a POSIX shell does before expanding anything. With
 * `stop`, it reads the inside of $(...) or ${...} and ends at the bracket that closes it.
 */
function read(line: string, start: number, stop: ')' | '}' | undefined, level: number): Reading {
  if (level > MAX_NESTING) throw new Unreadable(`brackets are nested more than ${MAX_NESTING} levels deep`);
  const items: Item[] = [];
  const substitutions: string[] = [];
  const pending: { document: HereDocument; delimiter: string; strip: boolean; expand: boolean }[] = [];
  let text = '';
  let bare = '';
  let started = false;
  let dynamic = false;
  let quoted = false;
  let depth = 0;
  /** Open case statements, whose patterns end with a ) that does not close $(...). */
  let cases = 0;
  const finish = () => {
    if (started) {
      // A glob after name@ (lodash@4.*, @demo/api@workspace:*) would have to match a file named like a package with
      // its version; only globs in the rest count.
      const versionAt = bare.indexOf('@', bare.startsWith('@') ? 1 : 0);
      const expands = dynamic || BRACES.test(bare) || GLOB.test(versionAt > 0 ? bare.slice(0, versionAt) : bare);
      items.push({ kind: 'word', word: { text, dynamic: expands } });
      if (!quoted && !expands && text === 'case') cases += 1;
      if (!quoted && !expands && text === 'esac' && cases > 0) cases -= 1;
    }
    text = '';
    bare = '';
    started = false;
    dynamic = false;
    quoted = false;
  };
  /** $(...), ${...}, <(...) or >(...) from `from`, whose inside starts at `inside`; returns the index after it. */
  const nested = (from: number, inside: number, close: ')' | '}'): number => {
    dynamic = true;
    started = true;
    const inner = read(line, inside, close, level + 1);
    // The shell refuses a line with an open bracket, but depcurfew cannot tell where the command would have ended.
    if (!inner.closed) throw new Unreadable(`${line.slice(from, inside)} is not closed`);
    // ${...} is a parameter, whose default value may hold command substitutions; the others are command lines.
    if (close === '}') substitutions.push(...inner.substitutions);
    else substitutions.push(line.slice(inside, inner.end - 1));
    text += line.slice(from, inner.end);
    return inner.end;
  };
  /** $((...)) or ((...)): arithmetic from the first of two brackets at `from`; returns the index after it. */
  const arithmetic = (from: number): number => {
    let count = 0;
    let end = from;
    for (; end < line.length; end++) {
      if (line[end] === '(') count += 1;
      else if (line[end] === ')' && --count === 0) break;
    }
    if (end >= line.length) throw new Unreadable(`${line.slice(from, from + 2)} is not closed`);
    // Its words are not commands, but command substitutions in it run; bash may also read $((a) (b)) as $( (a) (b) ).
    const inside = line.slice(from + 2, end - 1);
    substitutions.push(...bodySubstitutions(inside, level), inside);
    dynamic = true;
    started = true;
    return end + 1;
  };
  const backtick = (from: number): number => {
    dynamic = true;
    started = true;
    let end = from + 1;
    while (end < line.length && line[end] !== '`') end += line[end] === '\\' ? 2 : 1;
    substitutions.push(line.slice(from + 1, Math.min(end, line.length)).replaceAll(/\\([`\\$])/gu, '$1'));
    text += line.slice(from, Math.min(end + 1, line.length));
    return Math.min(end + 1, line.length);
  };
  /** A parameter or substitution starting with $ at `from`; undefined when the $ is literal. */
  const dollar = (from: number): number | undefined => {
    const next = line[from + 1] ?? '';
    if (next === '(' && line[from + 2] === '(') {
      const end = arithmetic(from + 1);
      text += line.slice(from, end);
      return end;
    }
    if (next === '(') return nested(from, from + 2, ')');
    if (next === '{') return nested(from, from + 2, '}');
    if (!/[A-Za-z_0-9@*#?$!-]/u.test(next)) return undefined;
    dynamic = true;
    started = true;
    const end = from + 1 + (/^[A-Za-z_][A-Za-z0-9_]*|^./u.exec(line.slice(from + 1))?.[0].length ?? 0);
    text += line.slice(from, end);
    return end;
  };
  /** The delimiter word of a here-document: quoting any part of it keeps the body from being expanded. */
  const delimiter = (from: number): { word: string; quoted: boolean; end: number } => {
    let index = from;
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    let word = '';
    let quoted = false;
    while (index < line.length && !/[\s;&|<>()]/u.test(line[index] as string)) {
      const char = line[index] as string;
      if (char === "'" || char === '"') {
        const end = line.indexOf(char, index + 1);
        word += line.slice(index + 1, end === -1 ? line.length : end);
        quoted = true;
        index = end === -1 ? line.length : end + 1;
      } else if (char === '\\') {
        word += line[index + 1] ?? '';
        quoted = true;
        index += 2;
      } else {
        word += char;
        index += 1;
      }
    }
    return { word, quoted, end: index };
  };
  /** Reads the bodies of the here-documents opened on the line that just ended; returns the index after them. */
  const bodies = (from: number): number => {
    let position = from;
    for (const entry of pending) {
      const lines: string[] = [];
      while (position < line.length) {
        const lineStart = position;
        const newline = line.indexOf('\n', position);
        const current = line.slice(position, newline === -1 ? line.length : newline);
        position = newline === -1 ? line.length : newline + 1;
        const tabs = entry.strip ? (/^\t*/u.exec(current)?.[0].length ?? 0) : 0;
        const content = current.slice(tabs);
        if (content === entry.delimiter) break;
        const after = content.slice(entry.delimiter.length);
        if (stop === ')' && content.startsWith(entry.delimiter) && /^\s*\)/u.test(after)) {
          // Inside $(...), the delimiter followed by the closing bracket may end it too (shells differ); reading on
          // from the bracket keeps the commands after it in view.
          position = lineStart + tabs + entry.delimiter.length + after.indexOf(')');
          break;
        }
        lines.push(content);
      }
      // A here-document without its delimiter runs to the end of the line, as in bash.
      entry.document.body = lines.join('\n');
      if (entry.expand) substitutions.push(...bodySubstitutions(entry.document.body, level));
    }
    pending.length = 0;
    return position;
  };
  let index = start;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === '\\' && line[index + 1] === '\n') {
      index += 2;
      continue;
    }
    if (char === '\\') {
      text += line[index + 1] ?? '';
      started = true;
      quoted = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      text += line.slice(index + 1, end === -1 ? line.length : end);
      started = true;
      quoted = true;
      index = end === -1 ? line.length : end + 1;
      continue;
    }
    if (char === '$' && line[index + 1] === "'") {
      // ANSI-C quoting: the shell decodes escapes such as \x69, so the text is not known as written.
      dynamic = true;
      started = true;
      let end = index + 2;
      while (end < line.length && line[end] !== "'") end += line[end] === '\\' ? 2 : 1;
      text += line.slice(index, Math.min(end + 1, line.length));
      index = end + 1;
      continue;
    }
    if (char === '$' && line[index + 1] === '"') {
      // $"..." is translated by the shell; the quoted text follows.
      dynamic = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      started = true;
      quoted = true;
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === '\\' && '"\\$`\n'.includes(line[index + 1] ?? '')) {
          text += line[index + 1] === '\n' ? '' : line[index + 1];
          index += 2;
        } else if (line[index] === '`') {
          index = backtick(index);
        } else if (line[index] === '$' && /[({A-Za-z_0-9@*#?$!-]/u.test(line[index + 1] ?? '')) {
          index = dollar(index) ?? index + 1;
        } else {
          text += line[index];
          index += 1;
        }
      }
      index += 1;
      continue;
    }
    if (char === '$') {
      const end = dollar(index);
      if (end !== undefined) {
        index = end;
        continue;
      }
    }
    if (char === '`') {
      index = backtick(index);
      continue;
    }
    if ((char === '<' || char === '>') && line[index + 1] === '(') {
      index = nested(index, index + 2, ')');
      continue;
    }
    if (stop !== undefined && char === stop) {
      // The bracket ends the word before it, which may be the esac that closes a case statement.
      finish();
      if (depth === 0 && (stop !== ')' || cases === 0)) {
        if (pending.length > 0) bodies(line.length);
        return { items, substitutions, end: index + 1, closed: true };
      }
    }
    if (char === '#' && !started) {
      while (index < line.length && line[index] !== '\n') index += 1;
      continue;
    }
    if (char === ' ' || char === '\t') {
      finish();
      index += 1;
      continue;
    }
    if (char === '\n') {
      finish();
      items.push({ kind: 'separator' });
      index = bodies(index + 1);
      continue;
    }
    if (line.startsWith('<<<', index)) {
      finish();
      items.push({ kind: 'herestring' });
      index += 3;
      continue;
    }
    if (line.startsWith('<<', index)) {
      finish();
      const strip = line[index + 2] === '-';
      const found = delimiter(index + (strip ? 3 : 2));
      const document: HereDocument = { body: '' };
      items.push({ kind: 'heredoc', document });
      pending.push({ document, delimiter: found.word, strip, expand: !found.quoted });
      index = found.end;
      continue;
    }
    if (char === '<' || char === '>' || (char === '&' && line[index + 1] === '>')) {
      // A redirection: digits written just before it (2>) belong to it, and the next word is its target.
      if (/^\d+$/u.test(text) && started) {
        text = '';
        started = false;
      }
      finish();
      items.push({ kind: 'redirect' });
      index += 1;
      while ('<>&|'.includes(line[index] ?? ' ') && line[index] !== undefined) index += 1;
      continue;
    }
    if (line.startsWith('((', index) && !started) {
      // An arithmetic command: an opaque word, not a subshell in a subshell.
      const end = arithmetic(index);
      items.push({ kind: 'word', word: { text: line.slice(index, end), dynamic: true } });
      index = end;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => line.startsWith(candidate, index));
    if (separator !== undefined) {
      if (stop === ')' && separator === '(') depth += 1;
      if (stop === ')' && separator === ')' && depth > 0) depth -= 1;
      finish();
      items.push({ kind: 'separator' });
      index += separator.length;
      continue;
    }
    if (stop === '}' && char === '{') depth += 1;
    if (stop === '}' && char === '}') depth -= 1;
    text += char;
    bare += char;
    started = true;
    index += 1;
  }
  finish();
  if (pending.length > 0) bodies(line.length);
  return { items, substitutions, end: line.length, closed: false };
}

interface SimpleCommand {
  words: Word[];
  /** Bodies of its here-documents and here-strings, which become its input. */
  input: string[];
  /** Its input comes from a word the shell expands. */
  redirected: boolean;
  /** Found further along another command's words (which bash), so it reads no input of its own. */
  later?: boolean;
}

function simpleCommands(items: readonly Item[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], input: [], redirected: false };
  let next: 'word' | 'skip' | 'input' = 'word';
  for (const item of items) {
    if (item.kind === 'separator') {
      if (current.words.length > 0) commands.push(current);
      current = { words: [], input: [], redirected: false };
      next = 'word';
    } else if (item.kind === 'redirect') {
      next = 'skip';
    } else if (item.kind === 'heredoc') {
      current.input.push(item.document.body);
    } else if (item.kind === 'herestring') {
      next = 'input';
    } else if (next === 'skip') {
      next = 'word';
    } else if (next === 'input') {
      current.input.push(item.word.text);
      if (item.word.dynamic) current.redirected = true;
      next = 'word';
    } else {
      current.words.push(item.word);
    }
  }
  if (current.words.length > 0) commands.push(current);
  return commands;
}

interface ToolCommands {
  tool: ToolId;
  facts: CommandLineKnowledge;
  valueOptions: ReadonlySet<string>;
  /** Options whose value is a registry URL, and options whose value is another configuration file. */
  registryOptions: readonly RegExp[];
  configOptions: readonly RegExp[];
}

interface Commands {
  tools: ToolCommands[];
  /** Subcommands that add packages with any package manager; their arguments are checked for every one of them. */
  add: ReadonlySet<string>;
  /** Executables of every package manager command. */
  executables: ReadonlySet<string>;
  /** Last words of every install, run and create command, to spot them behind an executable the shell expands. */
  installWords: ReadonlySet<string>;
  /** Commands whose arguments may run a package manager: package manager executables, shells and wrappers. */
  runners: ReadonlySet<string>;
  /** Environment variables of any package manager, lowercased, whose value is a registry URL or a configuration file. */
  registryVariables: ReadonlySet<string>;
  configVariables: ReadonlySet<string>;
  /** The public registry, which a command may name without changing where packages come from. */
  publicRegistry: string;
}

/** A matcher for an option name in which <scope> stands for any scope. */
function optionPattern(option: string): RegExp {
  const escaped = option.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('<scope>', '[^:\\s/]+');
  return new RegExp(`^${escaped}$`, 'u');
}

let cached: Commands | undefined;

function overridesOf(id: ToolId): RegistryOverridesKnowledge | undefined {
  const fact = knowledgeBase.find((tool) => tool.id === id)?.extra?.['registryOverrides'];
  return fact === undefined ? undefined : (values(fact)[0] as RegistryOverridesKnowledge | undefined);
}

function commands(): Commands {
  if (cached !== undefined) return cached;
  const tools = knowledgeBase.flatMap((tool): ToolCommands[] => {
    const fact = tool.extra?.['commandLine'];
    const facts = fact === undefined ? undefined : (values(fact)[0] as CommandLineKnowledge | undefined);
    if (facts === undefined) return [];
    const extra = tool.extra?.['valueOptions'];
    const more = extra === undefined ? [] : ((values(extra)[0] as string[] | undefined) ?? []);
    const overrides = overridesOf(tool.id);
    return [
      {
        tool: tool.id,
        facts,
        valueOptions: new Set([...facts.valueOptions, ...more]),
        registryOptions: (overrides?.registryOptions ?? []).map(optionPattern),
        configOptions: (overrides?.configOptions ?? []).map(optionPattern),
      },
    ];
  });
  const all = tools.flatMap(({ facts }) => [...facts.add, ...[...facts.create, ...facts.run].map((entry) => entry.command)]);
  const executables = new Set(all.map((entry) => entry[0] ?? ''));
  const overrides = knowledgeBase.flatMap((tool) => overridesOf(tool.id) ?? []);
  cached = {
    tools,
    add: new Set(tools.flatMap(({ facts }) => facts.add.map((entry) => entry.at(-1) ?? ''))),
    executables,
    installWords: new Set(all.map((entry) => entry.at(-1) ?? '')),
    runners: new Set([...executables, ...SHELLS, ...WRAPPERS.keys()]),
    registryVariables: new Set(overrides.flatMap((entry) => entry.registryVariables.map((name) => name.toLowerCase()))),
    configVariables: new Set(overrides.flatMap((entry) => entry.configVariables.map((name) => name.toLowerCase()))),
    publicRegistry: values(environment.npmRegistry.api)[0]?.url ?? '',
  };
  return cached;
}

interface Wrapper {
  /** Options followed by a separate value. */
  values?: readonly string[];
  /** Operands before the command, such as the duration of timeout. */
  operands?: number;
  /** The rest is joined into a command line, as eval and watch do. */
  line?: boolean;
  /** Options whose value is split into the command, as env -S does. */
  split?: readonly string[];
  /** Options whose value is the command line to run, as su -c. */
  lineOptions?: readonly string[];
  /** The command gets more arguments from its input (xargs), in place of this option's value when it is given. */
  input?: readonly string[];
}

/** Commands that run the rest of the line as a command. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  [
    'sudo',
    {
      values: [
        '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-U', '--other-user',
        '-D', '--chdir', '-R', '--chroot', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-a', '--auth-type',
        '-c', '--login-class',
      ],
    },
  ],
  ['doas', { values: ['-u', '-C'] }],
  ['su', { values: ['-s', '--shell', '-g', '--group', '-G', '--supp-group'], lineOptions: ['-c', '--command'] }],
  ['env', { values: ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'], split: ['-S', '--split-string'] }],
  ['command', {}],
  ['builtin', {}],
  ['exec', { values: ['-a'] }],
  ['time', { values: ['-f', '--format', '-o', '--output'] }],
  ['nice', { values: ['-n', '--adjustment'] }],
  ['nohup', {}],
  ['setsid', {}],
  ['stdbuf', { values: ['-i', '--input', '-o', '--output', '-e', '--error'] }],
  ['ionice', { values: ['-c', '--class', '-n', '--classdata'] }],
  ['timeout', { values: ['-s', '--signal', '-k', '--kill-after'], operands: 1 }],
  ['corepack', {}],
  ['eval', { line: true }],
  ['watch', { values: ['-n', '--interval'], line: true }],
  [
    'xargs',
    {
      values: ['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'],
      input: ['-I', '--replace', '-i'],
    },
  ],
]);
/** Reserved words that may come before a command. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Shell options followed by a separate value. */
const SHELL_VALUES = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
/** Stands for the arguments xargs adds from its input. */
const XARGS_INPUT: Word = { text: '<input>', dynamic: true, input: true };

function basename(text: string): string {
  return (text.split(/[/\\]/u).at(-1) ?? text).replace(/\.(?:cmd|exe|ps1)$/iu, '');
}

function createPackage(argument: string, rule: CommandLineKnowledge['createNames']): string {
  const at = argument.indexOf('@', argument.startsWith('@') ? 1 : 0);
  const name = at <= 0 ? argument : argument.slice(0, at);
  const selector = at <= 0 ? '' : argument.slice(at);
  const prefixed = (part: string) => (rule === 'prefix-unless-prefixed' && part.startsWith('create-') ? part : `create-${part}`);
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    return slash === -1 ? `${name}/create${selector}` : `${name.slice(0, slash)}/${prefixed(name.slice(slash + 1))}${selector}`;
  }
  return `${prefixed(name)}${selector}`;
}

function isOption(text: string): boolean {
  return text.startsWith('-') && text !== '-';
}

function splitOption(text: string): [string, string | undefined] {
  const equals = text.indexOf('=');
  return equals === -1 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)];
}

function joined(words: readonly Word[]): string {
  return words.map((word) => word.text).join(' ');
}

/** A command for messages, cut short when it is long. */
function shown(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Why a word cannot be read. */
function expanded(word: Word, what = ''): string {
  return word.input === true ? 'xargs adds arguments from its input' : `${what}"${shown(word.text)}" is expanded by the shell`;
}

function sameRegistry(value: string, registry: string): boolean {
  const normalized = (url: string) => url.replace(/\/+$/u, '').toLowerCase();
  return registry !== '' && normalized(value) === normalized(registry);
}

function anotherRegistry(name: string): string {
  return `${name} may point the package manager at another registry, which depcurfew does not look up`;
}

/** Why an option may change where the tool fetches packages from; undefined when it does not. */
function registryOption(tool: ToolCommands, name: string, value: string | undefined): string | undefined {
  if (tool.configOptions.some((pattern) => pattern.test(name))) return anotherRegistry(name);
  if (!tool.registryOptions.some((pattern) => pattern.test(name))) return undefined;
  return value !== undefined && sameRegistry(value, commands().publicRegistry) ? undefined : anotherRegistry(name);
}

/** Why a variable may change where a package manager fetches packages from; undefined when it does not. */
function registryVariable(name: string, value: string | undefined): string | undefined {
  const { configVariables, registryVariables, publicRegistry } = commands();
  if (configVariables.has(name.toLowerCase())) return anotherRegistry(name);
  if (!registryVariables.has(name.toLowerCase())) return undefined;
  return value !== undefined && sameRegistry(value, publicRegistry) ? undefined : anotherRegistry(name);
}

const NOTHING: CommandScan = { requests: [], unreadable: undefined };

function unreadable(reason: string): CommandScan {
  return { requests: [], unreadable: reason };
}

function merge(into: CommandScan, scan: CommandScan): void {
  into.requests.push(...scan.requests);
  into.unreadable ??= scan.unreadable;
}

type Outcome = { specs: string[]; lines: string[]; rest: Word[] } | { unreadable: string };

/**
 * The package arguments after the subcommand, the command lines given to options and, for run and create commands,
 * the words left for the package; or why they cannot be read.
 */
function readArguments(words: readonly Word[], mode: 'add' | 'run' | 'create', tool: ToolCommands, entry: DownloadCommand | undefined): Outcome {
  const packageOptions = entry?.packageOptions ?? [];
  const lineOptions = entry?.lineOptions ?? [];
  const specs: string[] = [];
  const lines: string[] = [];
  let positional = false;
  let shell = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as Word;
    if (!positional && word.text === '--') {
      positional = true;
      continue;
    }
    if (!positional && isOption(word.text)) {
      // Options are read too: one the shell expands may name a package or change how the rest is read.
      if (word.dynamic) return { unreadable: expanded(word) };
      const [name, attached] = splitOption(word.text);
      // The arguments are local files (deno install --entrypoint), so no package is named.
      if (mode === 'add' && tool.facts.fileOptions?.includes(name) === true) return { specs: [], lines, rest: [] };
      if (entry?.shellOptions?.includes(name) === true) {
        shell = true;
        continue;
      }
      const takesValue = attached === undefined && (tool.valueOptions.has(name) || packageOptions.includes(name) || lineOptions.includes(name));
      const next = takesValue ? words[++index] : undefined;
      const value = attached ?? next?.text;
      if (lineOptions.includes(name)) {
        // A command line that runs with the packages: read like the rest, expansions included.
        if (next?.input === true) return { unreadable: expanded(next) };
        if (value !== undefined) lines.push(value);
        continue;
      }
      if (next?.dynamic === true) return { unreadable: `"${shown(`${word.text} ${next.text}`)}" is expanded by the shell` };
      const setting = registryOption(tool, name, value);
      if (setting !== undefined) return { unreadable: setting };
      if (mode !== 'add' && packageOptions.includes(name) && value !== undefined) specs.push(value);
      continue;
    }
    if (shell) {
      // Shell mode: the argument is a command line that runs with the packages.
      if (word.input === true) return { unreadable: expanded(word) };
      lines.push(word.text);
      return { specs, lines, rest: [] };
    }
    if (word.dynamic) return { unreadable: expanded(word) };
    if (mode === 'add') {
      specs.push(word.text);
      continue;
    }
    // run and create: the first positional argument names the package (unless --package did); it runs with the rest.
    if (mode === 'run' && specs.length === 0) specs.push(word.text);
    if (mode === 'create') specs.push(/^[.~/\\]|^[^@][^/]*\//u.test(word.text) ? word.text : createPackage(word.text, tool.facts.createNames));
    return { specs, lines, rest: words.slice(index) };
  }
  return { specs, lines, rest: [] };
}

function finish(tool: ToolCommands, line: string, outcome: Outcome, depth: number): CommandScan {
  if ('unreadable' in outcome) return unreadable(`${shown(line)}: ${outcome.unreadable}`);
  const scan: CommandScan = { requests: outcome.specs.map((spec) => ({ tool: tool.tool, command: line, spec })), unreadable: undefined };
  for (const nested of outcome.lines) merge(scan, scanLine(nested, depth + 1));
  // The package may run a package manager in turn (npx cross-env NODE_ENV=x npm install …).
  merge(scan, laterCommand(outcome.rest, depth));
  return scan;
}

/** A package manager, shell or wrapper further along the words, run by a command depcurfew does not know (strace, find -exec). */
function laterCommand(words: readonly Word[], depth: number): CommandScan {
  const { runners } = commands();
  const index = words.findIndex((word) => !word.dynamic && runners.has(basename(word.text)));
  return index === -1 ? NOTHING : scanCommand({ words: words.slice(index), input: [], redirected: false, later: true }, depth);
}

/** A shell: the command string after -c is read like any other line; without one it runs commands from its input. */
function scanShell(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  let index = 1;
  let commandString = false;
  let fromInput = false;
  while (index < words.length) {
    const text = (words[index] as Word).text;
    if (text === '--') {
      index += 1;
      break;
    }
    if (!/^[-+]./u.test(text)) break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(text)) commandString = true;
    if (/^-[A-Za-z]*s[A-Za-z]*$/u.test(text)) fromInput = true;
    index += SHELL_VALUES.has(text) ? 2 : 1;
  }
  let operand = words[index];
  if (!commandString) {
    // A -c after an option depcurfew does not know still gives a command string; reading it costs nothing.
    const flag = words.findIndex((word, position) => position > index && /^-[A-Za-z]*c[A-Za-z]*$/u.test(word.text));
    if (flag !== -1) {
      commandString = true;
      operand = words[flag + 1];
    }
  }
  if (commandString) {
    if (operand === undefined) return NOTHING;
    if (operand.input === true) return unreadable(`${shown(joined(words))}: ${expanded(operand)}`);
    return scanLine(operand.text, depth + 1);
  }
  const reads = fromInput || operand === undefined || operand.text === '-';
  if (!reads || command.later === true) return NOTHING;
  // A here-document or here-string is known; a pipe or a file is not.
  if (command.input.length === 0 || command.redirected) return unreadable(`${shown(joined(words))}: it runs commands from its input`);
  const scan: CommandScan = { requests: [], unreadable: undefined };
  for (const input of command.input) merge(scan, scanLine(input, depth + 1));
  return scan;
}

/** What a wrapper runs: the remaining words, or a command line to read. */
function unwrap(words: readonly Word[], wrapper: Wrapper): { words: Word[] } | { line: string } | { unreadable: string } {
  let index = 1;
  let replace: string | undefined;
  while (index < words.length) {
    const text = (words[index] as Word).text;
    if (ASSIGNMENT.test(text)) {
      index += 1;
      continue;
    }
    if (!isOption(text)) break;
    if (text === '--') {
      index += 1;
      break;
    }
    const [name, attached] = splitOption(text);
    if (wrapper.split?.includes(name)) {
      const value = attached ?? words[index + 1]?.text ?? '';
      return { line: [value, ...words.slice(index + (attached === undefined ? 2 : 1)).map((word) => word.text)].join(' ') };
    }
    if (wrapper.lineOptions?.includes(name)) {
      const value = attached === undefined ? words[index + 1] : { text: attached, dynamic: false };
      if (value?.input === true) return { unreadable: expanded(value) };
      return { line: value?.text ?? '' };
    }
    const inputOption = wrapper.input?.find((option) => name === option || (option.length === 2 && name.startsWith(option)));
    if (inputOption !== undefined) {
      // xargs -I{} or --replace={}: the string is replaced with input; -i alone means {}.
      const inline = attached ?? (name.length > inputOption.length ? name.slice(inputOption.length) : undefined);
      replace = inline ?? (inputOption === '-i' ? '{}' : words[index + 1]?.text);
      index += inline === undefined && inputOption !== '-i' ? 2 : 1;
      continue;
    }
    index += attached === undefined && wrapper.values?.includes(name) === true ? 2 : 1;
  }
  const rest = words.slice(index + (wrapper.operands ?? 0));
  if (wrapper.line === true) {
    const filled = rest.find((word) => word.input === true);
    return filled === undefined ? { line: joined(rest) } : { unreadable: expanded(filled) };
  }
  if (wrapper.input === undefined || rest.length === 0) return { words: rest };
  if (replace === undefined) return { words: [...rest, XARGS_INPUT] };
  const marker = replace;
  return { words: rest.map((word) => (word.text.includes(marker) ? { text: word.text, dynamic: true, input: true } : word)) };
}

function scanCommand(command: SimpleCommand, depth: number): CommandScan {
  const { tools, add, installWords } = commands();
  let words = command.words;
  // Assignments, reserved words and wrappers such as sudo or env come before the command itself.
  for (;;) {
    const head = words[0];
    if (head === undefined) return NOTHING;
    if (ASSIGNMENT.test(head.text)) {
      words = words.slice(1);
    } else if (!head.dynamic && KEYWORDS.has(head.text)) {
      words = words.slice(1);
    } else if (!head.dynamic && head.text === 'function') {
      words = words.slice(2);
    } else if (!head.dynamic && WRAPPERS.has(basename(head.text))) {
      const unwrapped = unwrap(words, WRAPPERS.get(basename(head.text)) as Wrapper);
      if ('unreadable' in unwrapped) return unreadable(`${shown(joined(words))}: ${unwrapped.unreadable}`);
      if ('line' in unwrapped) return scanLine(unwrapped.line, depth + 1);
      words = unwrapped.words;
    } else {
      break;
    }
  }
  const first = words[0] as Word;
  const line = joined(words);
  // A command line built at run time (eval "$CMD", sh -c "$X") cannot be known in advance.
  if (depth > 0 && WHOLE_EXPANSION.test(first.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  const executable = basename(first.text).replace(/@[^/]*$/u, '');
  if (SHELLS.has(executable)) return scanShell(words, command, depth);
  const rest = words.slice(1);
  for (const tool of tools) {
    const { facts } = tool;
    const run = facts.run.find((entry) => entry.command.length === 1 && entry.command[0] === executable);
    if (run !== undefined) return finish(tool, line, readArguments(rest, 'run', tool, run), depth);
    const owns = [...facts.add, ...facts.run.map((entry) => entry.command), ...facts.create.map((entry) => entry.command)].some((entry) => entry[0] === executable);
    if (!owns) continue;
    // The subcommand is the first word that is not an option or an option's value.
    let index = 0;
    while (index < rest.length && isOption(rest[index]?.text ?? '')) {
      const word = rest[index] as Word;
      if (word.dynamic) return unreadable(`${shown(line)}: ${expanded(word)}`);
      const [name, attached] = splitOption(word.text);
      const takesValue = attached === undefined && tool.valueOptions.has(name);
      const setting = registryOption(tool, name, attached ?? (takesValue ? rest[index + 1]?.text : undefined));
      if (setting !== undefined) return unreadable(`${shown(line)}: ${setting}`);
      index += takesValue ? 2 : 1;
    }
    const subcommand = rest[index];
    if (subcommand === undefined) return NOTHING;
    if (subcommand.dynamic) return unreadable(`${shown(line)}: ${expanded(subcommand, 'the subcommand ')}`);
    const after = rest.slice(index + 1);
    const find = (list: readonly DownloadCommand[]) => list.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    const workspace = facts.workspaceCommands?.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    if (workspace !== undefined) return scanCommand({ ...command, words: [first, ...after.slice(workspace.operands)] }, depth);
    const runEntry = find(facts.run);
    if (runEntry !== undefined) return finish(tool, line, readArguments(after, 'run', tool, runEntry), depth);
    const createEntry = find(facts.create);
    if (createEntry !== undefined) return finish(tool, line, readArguments(after, 'create', tool, createEntry), depth);
    if (add.has(subcommand.text)) return finish(tool, line, readArguments(after, 'add', tool, undefined), depth);
    // Another subcommand that ends in an add subcommand (yarn global add, yarn workspaces foreach -A add) adds too.
    const later = after.findIndex((word) => !word.dynamic && add.has(word.text));
    if (later !== -1) return finish(tool, line, readArguments(after.slice(later + 1), 'add', tool, undefined), depth);
    return NOTHING;
  }
  const subcommand = rest.find((word) => !isOption(word.text));
  if (first.dynamic && subcommand !== undefined && installWords.has(subcommand.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  return laterCommand(rest, depth);
}

/** A variable set anywhere on the line that may point a package manager at another registry or configuration file. */
function registryAssignment(items: readonly Item[]): string | undefined {
  for (const item of items) {
    if (item.kind !== 'word') continue;
    const name = ASSIGNMENT.exec(item.word.text)?.[1];
    const setting = name === undefined ? undefined : registryVariable(name, item.word.dynamic ? undefined : item.word.text.slice(name.length + 1));
    if (setting !== undefined) return setting;
  }
  return undefined;
}

function scanLine(line: string, depth: number): CommandScan {
  if (depth > MAX_DEPTH) return unreadable(`${shown(line)}: command lines are nested more than ${MAX_DEPTH} levels deep`);
  let reading: Reading;
  try {
    reading = read(line, 0, undefined, 0);
  } catch (error) {
    if (error instanceof Unreadable) return unreadable(`${shown(line)}: ${error.message}`);
    throw error;
  }
  const scan: CommandScan = { requests: [], unreadable: undefined };
  for (const command of simpleCommands(reading.items)) merge(scan, scanCommand(command, depth));
  for (const inner of reading.substitutions) merge(scan, scanLine(inner, depth + 1));
  if (scan.requests.length > 0) {
    const setting = registryAssignment(reading.items);
    if (setting !== undefined) scan.unreadable ??= `${shown(line)}: ${setting}`;
  }
  return scan;
}

/** The packages a command line installs or downloads to run with npm, pnpm, Yarn or Bun. */
export function scanCommandLine(line: string): CommandScan {
  return scanLine(line, 0);
}
