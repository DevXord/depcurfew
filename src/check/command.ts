// Finds the packages a shell command line installs or downloads to run, for the install guard. It reads the line the
// way a POSIX shell splits it (quotes, escapes, &&, ||, ;, |, subshells, redirections, here-documents, reserved words)
// without running anything, and follows the command lines inside it: command substitutions, sh -c, eval, npx -c,
// a shell fed by a here-document and wrappers such as sudo, env, timeout or xargs. Words the shell would expand ($VAR,
// $(...), backticks, globs, $'...', {a,b}) cannot be known in advance; when such a word is part of an install command,
// the result says the command cannot be read, so the caller asks a person instead of guessing. So does an install
// next to a setting that points the package manager at another registry or configuration file, and a script piped
// into a shell or an interpreter. Options and variables that change the version the package manager picks (npm's
// --tag, pip's --pre) or make it build from source (--no-binary) go with each request. It is a guard against mistakes
// and simple disguises, not a sandbox: a program that installs packages itself (node -e, a script file) is not seen.
// PowerShell lines (the PowerShell tool, powershell -c) and cmd /c lines have their own readers in windows-shells.ts;
// PowerShell syntax that reader does not understand makes the line unreadable when its statement names a package
// manager. Executables are matched in any case and without .exe, .cmd, .bat or .ps1, as Windows and macOS find them.
// Options and variables that weaken, for one command, the release-age delay or the rule on install scripts that
// depcurfew apply configured (--min-release-age=0, npm_config_ignore_scripts=false) are returned as overrides, which
// the hook compares with the policy; a command that changes the package manager's configuration (npm config set)
// next to an install makes that install unreadable, as the install would not use the configuration that was read.
import { values } from '../apply/facts.ts';
import { delayMinutes, formatMinutes } from '../doctor/durations.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type {
  CommandLineKnowledge,
  CommandLineParsing,
  ConfigCommand,
  DownloadCommand,
  Ecosystem,
  InstallOverridesKnowledge,
  NpmVersionSelectionKnowledge,
  OverrideSwitch,
  OverrideValues,
  PythonInterpreterKnowledge,
  PythonSelectionKnowledge,
  RegistryOverridesKnowledge,
  SelectionSwitches,
  ToolId,
} from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { PYPI_PREFIX } from '../policy/package-pattern.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePythonSpec } from './python-spec.ts';
import { NestingTooDeep, readCmd, readPowerShell } from './windows-shells.ts';

export interface Word {
  text: string;
  /** The shell would expand part of it. */
  dynamic: boolean;
  /** xargs (or find) fills it from its input. */
  input?: boolean;
  /** Who fills it, when that is not xargs. */
  filler?: string;
}

interface HereDocument {
  body: string;
}

export type Item =
  | { kind: 'word'; word: Word }
  | { kind: 'separator'; pipe?: boolean }
  | { kind: 'redirect'; input: boolean }
  | { kind: 'heredoc'; document: HereDocument }
  | { kind: 'herestring' };

export interface InstallRequest {
  tool: ToolId;
  /** The command as written, for messages. */
  command: string;
  spec: string;
  /** npm: the dist-tag the command makes npm prefer (--tag, npm_config_tag). */
  tag?: string;
  /** Python: the command allows pre-releases of the package, or forbids them; left out, the tool's default applies. */
  prereleases?: 'allow' | 'deny';
  /** Python: the command makes the tool build the package from source (true) or install wheels only (false). */
  buildFromSource?: boolean;
}

/** An option or variable of a command that weakens the release-age delay or the rule on install scripts (installOverrides). */
export interface Override {
  tool: ToolId;
  /** The command it is on, for messages. */
  command: string;
  /** As written: --min-release-age=0, npm_config_ignore_scripts=false. */
  written: string;
  weakens: OverrideSwitch['weakens'];
  /** The delay it sets, to compare with the policy; left out when any value weakens it. */
  delay?: string;
  /** The shell expands its value. */
  expanded?: boolean;
}

export interface CommandScan {
  requests: InstallRequest[];
  /** Why an install command could not be read; undefined when every one could. */
  unreadable: string | undefined;
  /** Options and variables that weaken what depcurfew apply configured, to be compared with the policy. */
  overrides?: Override[];
  /** A command on the line changes the package manager's configuration; it counts when the line installs packages. */
  changes?: string;
  /** A package manager runs on the line, so variables that weaken it count. */
  manager?: boolean;
}

/** An override before the command it is on is known. */
type Found = Omit<Override, 'command'>;

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
/** A word that is one expansion as a whole, so nothing of it is known: $CMD, ${CMD}, $(...), `...`, or cmd's %CMD% and !CMD!. */
const WHOLE_EXPANSION = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|\$\{[^}]*\}|\$\(.*\)|`.*`|%[^%\s]+%|![^!\s]+!)$/su;

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
  /**
   * The delimiter word of a here-document: quoting any part of it keeps the body from being expanded. It ends at a
   * blank (space, tab), a newline or an operator, as bash's words do: a carriage return of a CRLF line belongs to it,
   * and bash ends the body only at a line that holds it too (cat <<EOF\r\n…\r\nEOF\r\n).
   */
  const delimiter = (from: number): { word: string; quoted: boolean; end: number } => {
    let index = from;
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    let word = '';
    let quoted = false;
    while (index < line.length && !/[ \t\n;&|<>()]/u.test(line[index] as string)) {
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
      items.push({ kind: 'redirect', input: char === '<' });
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
      items.push({ kind: 'separator', pipe: separator === '|' || separator === '|&' });
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

/** The shells whose command lines the scanner reads. */
export type Shell = 'posix' | 'powershell' | 'cmd';

interface SimpleCommand {
  words: Word[];
  /** The shell that runs it, when it matters (PowerShell passes arguments to batch files through cmd.exe). */
  shell?: Shell;
  /** Bodies of its here-documents and here-strings, which become its input. */
  input: string[];
  /** Its input comes from a word the shell expands. */
  redirected: boolean;
  /** Found further along another command's words (which bash), so it reads no input of its own. */
  later?: boolean;
  /** Its standard input comes from a pipe, or from a file or command named after <. */
  stdin?: 'pipe' | 'file';
}

function simpleCommands(items: readonly Item[], shell: Shell = 'posix'): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], input: [], redirected: false, shell };
  let next: 'word' | 'skip' | 'source' | 'input' = 'word';
  for (const item of items) {
    if (item.kind === 'separator') {
      if (current.words.length > 0) commands.push(current);
      current = item.pipe === true ? { words: [], input: [], redirected: false, shell, stdin: 'pipe' } : { words: [], input: [], redirected: false, shell };
      next = 'word';
    } else if (item.kind === 'redirect') {
      if (item.input) current.stdin = 'file';
      next = item.input ? 'source' : 'skip';
    } else if (item.kind === 'heredoc') {
      current.input.push(item.document.body);
    } else if (item.kind === 'herestring') {
      next = 'input';
    } else if (next === 'skip' || next === 'source') {
      // < <(curl …) feeds the command what another command prints, as a pipe does.
      if (next === 'source' && item.word.dynamic && item.word.text.startsWith('<(')) current.stdin = 'pipe';
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
  ecosystem: Ecosystem;
  facts: CommandLineKnowledge;
  valueOptions: ReadonlySet<string>;
  /** Every long option the tool is known to have, to resolve abbreviations. */
  longOptions: readonly string[];
  /** Options whose value is a registry URL, and options whose value is another configuration file. */
  registryOptions: readonly RegExp[];
  configOptions: readonly RegExp[];
  /** The public registry of the tool's ecosystem, which a command may name without changing where packages come from. */
  publicRegistry: string;
  parsing: CommandLineParsing;
  /** Every option name the tool is known to have, as written in the facts (--name or -n). */
  known: ReadonlySet<string>;
  /** Long registry and configuration options without a scope, to resolve abbreviations of tools whose flags are not listed. */
  registryLong: readonly string[];
  /** The flags are listed too, so an abbreviation can be resolved to any option; otherwise only to a registry or configuration option. */
  complete: boolean;
  /** How the command line changes which version is picked (Python) and which dist-tag npm prefers. */
  selection: PythonSelectionKnowledge | undefined;
  versionSelection: NpmVersionSelectionKnowledge | undefined;
  /** Options and variables that weaken the delay or the rule on install scripts for one command. */
  overrides: InstallOverridesKnowledge | undefined;
  /** Commands that change the tool's configuration. */
  configCommands: readonly ConfigCommand[];
}

interface Commands {
  tools: ToolCommands[];
  /** Subcommands that add packages with any npm package manager; their arguments are checked for every one of them. */
  add: ReadonlySet<string>;
  /** Executables of every package manager command. */
  executables: ReadonlySet<string>;
  /** Executables of the npm package managers, which npm installs on Windows as .cmd shims. */
  npmExecutables: ReadonlySet<string>;
  /** Last words of every install, run and create command, to spot them behind an executable the shell expands. */
  installWords: ReadonlySet<string>;
  /** Commands whose arguments may run a package manager: package manager executables, shells, wrappers and Python. */
  runners: ReadonlySet<string>;
  /** Environment variables of any package manager, lowercased, whose value is a registry URL, with that ecosystem's public registry. */
  registryVariables: ReadonlyMap<string, string>;
  configVariables: ReadonlySet<string>;
  /** Variables, lowercased, that change the version a package manager picks or whether it builds from source. */
  selectionVariables: ReadonlySet<string>;
  /** Variables, lowercased, that weaken the delay or the rule on install scripts, with the tools that read them. */
  overrideVariables: ReadonlyMap<string, readonly { tool: ToolId; entry: OverrideSwitch }[]>;
}

/** The variables of a tool's selection switches. */
function switchVariables(switches: SelectionSwitches | undefined): string[] {
  return [
    ...(switches?.flagVariables ?? []),
    ...(switches?.onListVariables ?? []),
    ...(switches?.offListVariables ?? []),
    ...(switches?.onPackageVariables ?? []),
    ...(switches?.modeVariables ?? []),
  ];
}

/** A matcher for an option name in which <scope> stands for any scope. */
function optionPattern(option: string): RegExp {
  const escaped = option.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('<scope>', '[^:\\s/]+');
  return new RegExp(`^${escaped}$`, 'u');
}

let cached: Commands | undefined;

function factOf<T>(tool: (typeof knowledgeBase)[number], key: string): T | undefined {
  const fact = tool.extra?.[key];
  return fact === undefined ? undefined : (values(fact)[0] as T | undefined);
}

function publicRegistryOf(ecosystem: Ecosystem): string {
  return ecosystem === 'pypi' ? (values(environment.pypiIndex.api)[0]?.url ?? '') : (values(environment.npmRegistry.api)[0]?.url ?? '');
}

/** Python interpreters, whose -m runs a package manager as a module (python -m pip). */
function interpreter(): PythonInterpreterKnowledge | undefined {
  return values(environment.python.interpreter)[0];
}

/** The name of a fact next to a command-line fact: valueOptions next to commandLine, pipxValueOptions next to pipxCommandLine. */
function sibling(key: string, name: string): string {
  return key.replace(/(?:^c|C)ommandLine$/u, (found) => (found.startsWith('c') ? name : `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`));
}

function commands(): Commands {
  if (cached !== undefined) return cached;
  // A tool may have several command-line facts (pip has pipx's too); each has its registry overrides next to it.
  const tools = knowledgeBase.flatMap((tool): ToolCommands[] =>
    Object.keys(tool.extra ?? {})
      .filter((key) => /(?:^c|C)ommandLine$/u.test(key))
      .flatMap((key): ToolCommands[] => {
        const facts = factOf<CommandLineKnowledge>(tool, key);
        if (facts === undefined) return [];
        const more = factOf<string[]>(tool, sibling(key, 'valueOptions')) ?? [];
        const flags = [...(facts.flagOptions ?? []), ...(factOf<string[]>(tool, sibling(key, 'flagOptions')) ?? [])];
        const parsing: CommandLineParsing = {
          ...facts.parsing,
          ...factOf<CommandLineParsing>(tool, sibling(key, 'parsing')),
          ...(factOf<boolean>(tool, sibling(key, 'booleanWords')) === true ? { booleanWords: true } : {}),
        };
        const overrides = factOf<RegistryOverridesKnowledge>(tool, sibling(key, 'registryOverrides'));
        const ecosystem = ecosystemOfTool(tool);
        const download = [...facts.run, ...facts.create];
        const valueOptions = new Set([...facts.valueOptions, ...more]);
        const all = [
          ...valueOptions,
          ...flags,
          ...download.flatMap((entry) => [...entry.packageOptions, ...(entry.extraPackageOptions ?? []), ...(entry.lineOptions ?? []), ...(entry.shellOptions ?? [])]),
          ...(facts.commandOptions ?? []).flatMap((entry) => entry.valueOptions),
          ...(overrides?.registryOptions ?? []),
          ...(overrides?.configOptions ?? []),
        ];
        return [
          {
            tool: tool.id,
            ecosystem,
            facts,
            valueOptions,
            longOptions: [...new Set(all.filter((option) => option.startsWith('--') && !option.includes('<')))],
            registryOptions: (overrides?.registryOptions ?? []).map(optionPattern),
            configOptions: (overrides?.configOptions ?? []).map(optionPattern),
            publicRegistry: publicRegistryOf(ecosystem),
            parsing,
            known: new Set(all.filter((option) => !option.includes('<'))),
            registryLong: [...(overrides?.registryOptions ?? []), ...(overrides?.configOptions ?? [])].filter((option) => option.startsWith('--') && !option.includes('<')),
            complete: flags.length > 0,
            selection: factOf<PythonSelectionKnowledge>(tool, sibling(key, 'selection')),
            versionSelection: factOf<NpmVersionSelectionKnowledge>(tool, sibling(key, 'versionSelection')),
            overrides: factOf<InstallOverridesKnowledge>(tool, sibling(key, 'installOverrides')),
            configCommands: factOf<ConfigCommand[]>(tool, sibling(key, 'configCommands')) ?? [],
          },
        ];
      }),
  );
  const overrideVariables = new Map<string, { tool: ToolId; entry: OverrideSwitch }[]>();
  for (const tool of tools) {
    for (const entry of tool.overrides?.variables ?? []) {
      const name = entry.name.toLowerCase();
      overrideVariables.set(name, [...(overrideVariables.get(name) ?? []), { tool: tool.tool, entry }]);
    }
  }
  const all = tools.flatMap(({ facts }) => [...facts.add, ...[...facts.create, ...facts.run].map((entry) => entry.command)]);
  const executables = new Set(all.map((entry) => entry[0] ?? ''));
  const overrides = tools.flatMap((tool) => {
    const source = knowledgeBase.find((entry) => entry.id === tool.tool);
    return source === undefined
      ? []
      : Object.keys(source.extra ?? {})
          .filter((key) => /(?:^r|R)egistryOverrides$/u.test(key))
          .flatMap((key) => {
            const fact = factOf<RegistryOverridesKnowledge>(source, key);
            return fact === undefined ? [] : [{ fact, publicRegistry: tool.publicRegistry }];
          });
  });
  // Only npm package managers share their add subcommands: pip, uv and Poetry commands are matched word for word.
  const npmTools = tools.filter((tool) => tool.ecosystem === 'npm');
  cached = {
    tools,
    add: new Set(npmTools.flatMap(({ facts }) => facts.add.map((entry) => entry.at(-1) ?? ''))),
    executables,
    npmExecutables: new Set(npmTools.flatMap(({ facts }) => [...facts.add, ...[...facts.create, ...facts.run].map((entry) => entry.command)].map((entry) => entry[0] ?? ''))),
    installWords: new Set(all.map((entry) => entry.at(-1) ?? '')),
    runners: new Set([
      ...executables,
      ...SHELLS,
      ...POWERSHELLS,
      ...CMD,
      ...PROGRAM_READERS.keys(),
      ...WRAPPERS.keys(),
      ...(interpreter()?.executables ?? []),
    ]),
    registryVariables: new Map(overrides.flatMap(({ fact, publicRegistry }) => fact.registryVariables.map((name) => [name.toLowerCase(), publicRegistry] as const))),
    configVariables: new Set(overrides.flatMap(({ fact }) => fact.configVariables.map((name) => name.toLowerCase()))),
    selectionVariables: new Set(
      tools
        .flatMap(({ selection, versionSelection }) => [
          ...[selection, ...(selection?.commands ?? [])].flatMap((entry) => [...switchVariables(entry?.prereleases), ...switchVariables(entry?.buildFromSource)]),
          ...(versionSelection === undefined ? [] : [versionSelection.tagVariable]),
        ])
        .map((name) => name.toLowerCase()),
    ),
    overrideVariables,
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
  /**
   * Options may stand anywhere, as getopt reorders them, and one-letter options may be grouped (su -lc): a line option
   * gives the command line; without one, the words after a commandAfter option are the command, else nothing runs
   * but an interactive shell (su, runuser, script).
   */
  anywhere?: boolean;
  /** Options after which the remaining words are the command (runuser -u user command). */
  commandAfter?: readonly string[];
  /** Flags that make it run the remaining words through a shell as one command line (sudo -s, sudo -i). */
  shellOptions?: readonly string[];
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
      // sudo -s and -i run the command through a shell: its words are read as one command line, which also covers a
      // command line given as one word (sudo -s 'npm i x'), whatever escaping the sudo version applies.
      shellOptions: ['-s', '--shell', '-i', '--login'],
    },
  ],
  ['doas', { values: ['-u', '-C'] }],
  [
    'su',
    {
      values: ['-s', '--shell', '-g', '--group', '-G', '--supp-group', '-w', '--whitelist-environment'],
      lineOptions: ['-c', '--command', '--session-command'],
      anywhere: true,
    },
  ],
  [
    'runuser',
    {
      values: ['-s', '--shell', '-g', '--group', '-G', '--supp-group', '-w', '--whitelist-environment', '-u', '--user'],
      lineOptions: ['-c', '--command', '--session-command'],
      anywhere: true,
      commandAfter: ['-u', '--user'],
    },
  ],
  [
    'script',
    {
      values: ['-E', '--echo', '-I', '--log-in', '-O', '--log-out', '-B', '--log-io', '-T', '--log-timing', '-m', '--logging-format', '-o', '--output-limit'],
      lineOptions: ['-c', '--command'],
      anywhere: true,
    },
  ],
  // flock [options] file command…, or flock [options] file -c command.
  ['flock', { values: ['-w', '--timeout', '--wait', '-E', '--conflict-exit-code'], operands: 1, lineOptions: ['-c', '--command'] }],
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'yash', 'posh', 'csh', 'tcsh']);
/** PowerShell: pwsh (6 and later) runs a script file given without a parameter, Windows PowerShell a command. */
const POWERSHELLS = new Set(['pwsh', 'powershell']);
/** cmd.exe: /c and /k run the rest of the line as a command line. */
const CMD = new Set(['cmd']);
/** Run a file in the current shell. */
const SOURCES = new Set(['source', '.']);
/** PowerShell's Invoke-Expression and its alias: they run the code given to them or piped into them. */
const EXPRESSION_RUNNERS = new Set(['iex', 'invoke-expression']);
/** Commands that only print their arguments. */
const PRINTERS = new Set(['echo', 'printf']);
/** Files that are the standard input of the command reading them. */
const STDIN_FILES = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
/** find options after which a command runs, ended by ; or +, with {} in place of the file names. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/**
 * Interpreters that run a program read from their standard input when they get no script: the options that give the
 * code on the command line or do something else, and the options followed by a separate value.
 */
interface ProgramReader {
  inline: readonly string[];
  values: readonly string[];
}
const NODE: ProgramReader = {
  inline: ['-e', '--eval', '-p', '--print', '-c', '--check', '-v', '--version', '-h', '--help', '--test', '--run', '--v8-options'],
  values: ['-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '-C', '--conditions', '--env-file', '--title'],
};
const PROGRAM_READERS: ReadonlyMap<string, ProgramReader> = new Map<string, ProgramReader>([
  ['node', NODE],
  ['nodejs', NODE],
  ['ruby', { inline: ['-e', '-v', '--version', '-h', '--help'], values: ['-r', '-I', '-C', '-E', '--encoding'] }],
  ['perl', { inline: ['-e', '-E', '-v', '-V', '-h'], values: [] }],
  ['php', { inline: ['-r', '-R', '-F', '-B', '-E', '-v', '--version', '-h', '--help', '-i', '--info', '-m', '--modules', '-l', '--syntax-check', '-s', '-S', '-a'], values: ['-c', '-d', '-z', '-t'] }],
]);
/** Shell options followed by a separate value. */
const SHELL_VALUES = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
/** Stands for the arguments xargs adds from its input. */
const XARGS_INPUT: Word = { text: '<input>', dynamic: true, input: true };

/** <(...) as a whole: a file holding what the command inside prints. */
function isProcessSubstitution(word: Word): boolean {
  return word.dynamic && word.text.startsWith('<(');
}

/** The name of the program a word runs, lowercased: Windows and macOS find NPM.CMD and npm alike. */
function basename(text: string): string {
  return (text.split(/[/\\]/u).at(-1) ?? text).replace(/\.(?:cmd|exe|ps1|bat)$/iu, '').toLowerCase();
}

function createPackage(argument: string, rule: CommandLineKnowledge['createNames'] = 'prefix'): string {
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
  if (word.input === true) return word.filler ?? 'xargs adds arguments from its input';
  return `${what}"${shown(word.text)}" is expanded by the shell`;
}

function sameRegistry(value: string, registry: string): boolean {
  const normalized = (url: string) => url.replace(/\/+$/u, '').toLowerCase();
  return registry !== '' && normalized(value) === normalized(registry);
}

const ANOTHER_REGISTRY = 'may point the package manager at another registry, which depcurfew does not look up';
const SCRIPT_DOWNLOAD = 'downloads and runs a script from';
const FROM_INPUT = 'it runs commands from its input';
const FROM_PROCESS = 'it runs commands that another command prints';
const FROM_PRINTED_CODE = 'it runs code that another command prints';

/** Inline code (python -c, node -e) that a command substitution fills in: what runs is what that command prints. */
function printedCode(word: Word | undefined): boolean {
  return word !== undefined && word.dynamic && /\$\(|`/u.test(word.text);
}
const FROM_PROGRAM = 'it runs a program from its input';
const ENCODED = 'is encoded, so depcurfew cannot read it';
const VERSION_SETTING = 'is set to a value the shell expands, which may change the version that is installed';
const SET_UNREAD = 'is set in a way depcurfew does not read, which may change the version that is installed';
const POWERSHELL_UNREAD = 'in PowerShell, and the statement names';
const CMD_READS_AGAIN = 'has & | < > " or a line break, which cmd.exe may read as another command';
const MAY_BE_SHELL = 'and may be a shell that runs the command line it is given';
const MAY_BE_MANAGER = 'and may be a package manager';
const CONFIG_CHANGE =
  "changes the package manager's configuration, which the install in the same command would use, while depcurfew checks packages with the configuration from before the change";
const WEAKENS = 'what the project configured for every package this install fetches, also those depcurfew does not check';
const OVERRIDE_UNREAD = `is set in a way depcurfew does not read, which may weaken ${WEAKENS}`;
/** More specs than the hook checks for one command. */
export const TOO_MANY = 'depcurfew checks at most';

function anotherRegistry(name: string): string {
  return `${name} ${ANOTHER_REGISTRY}`;
}

/** What to do about a command that cannot be read, by why it cannot be read. */
export function unreadableFix(reason: string): string {
  if (reason.includes(ANOTHER_REGISTRY)) {
    return 'Leave out the option or variable so that packages come from the registry depcurfew checks; if the other registry is intended, the user decides';
  }
  if (reason.includes(SCRIPT_DOWNLOAD)) return 'Download the script and read it first, or install its dependencies by name so that depcurfew can check them';
  if (reason.includes(FROM_INPUT) || reason.includes(FROM_PROCESS) || reason.includes(FROM_PROGRAM)) {
    return 'Download the script and read it first, or run its commands one by one so that depcurfew can check them';
  }
  if (reason.includes(ENCODED)) return 'Write the command out as plain text, so depcurfew can check it';
  if (reason.includes(VERSION_SETTING)) return 'Write the value out in the command, so depcurfew can check the version it selects';
  if (reason.includes(SET_UNREAD)) return "Set the variable as $env:NAME = 'value' or NAME=value before the command, or leave it out, so depcurfew can check the version it selects";
  if (reason.includes(POWERSHELL_UNREAD)) {
    return 'Run the package manager as a plain command with the package names written out (no variables, (...), {...}, Start-Process or aliases), so depcurfew can check them';
  }
  if (reason.includes(MAY_BE_SHELL)) return 'Name the shell (bash -c, sh -c) or run the command itself, so depcurfew can check it';
  if (reason.includes(MAY_BE_MANAGER)) return 'Run the package manager by its name (npm, pnpm, yarn, bun, pip, uv) with the package names written out, so depcurfew can check the command';
  if (reason.includes(CONFIG_CHANGE)) {
    return "Run the install as a command of its own, so depcurfew checks it with the configuration it will use; a change to the package manager's configuration is for the user to decide";
  }
  if (reason.includes(WEAKENS)) {
    return 'Run the install without that option or variable, so it keeps the release-age delay and install-script settings of the project; if the change is intended, the user decides';
  }
  if (reason.includes(CMD_READS_AGAIN)) return 'Leave & | < > and " out of the arguments of the package manager, so depcurfew can check the command';
  if (reason.includes(TOO_MANY)) return 'Install the packages in smaller groups, so depcurfew can check each of them';
  return 'Write the package names out in the command, so depcurfew can check them';
}

/** Why an option may change where the tool fetches packages from; undefined when it does not. */
function registryOption(tool: ToolCommands, name: string, value: string | undefined): string | undefined {
  if (tool.configOptions.some((pattern) => pattern.test(name))) return anotherRegistry(name);
  if (!tool.registryOptions.some((pattern) => pattern.test(name))) return undefined;
  return value !== undefined && sameRegistry(value, tool.publicRegistry) ? undefined : anotherRegistry(name);
}

/** Why a variable may change where a package manager fetches packages from; undefined when it does not. */
function registryVariable(name: string, value: string | undefined): string | undefined {
  const { configVariables, registryVariables } = commands();
  if (configVariables.has(name.toLowerCase())) return anotherRegistry(name);
  const publicRegistry = registryVariables.get(name.toLowerCase());
  if (publicRegistry === undefined) return undefined;
  return value !== undefined && sameRegistry(value, publicRegistry) ? undefined : anotherRegistry(name);
}

const NOTHING: CommandScan = { requests: [], unreadable: undefined };

function unreadable(reason: string): CommandScan {
  return { requests: [], unreadable: reason };
}

function merge(into: CommandScan, scan: CommandScan): void {
  into.requests.push(...scan.requests);
  into.unreadable ??= scan.unreadable;
  if (scan.overrides !== undefined && scan.overrides.length > 0) into.overrides = [...(into.overrides ?? []), ...scan.overrides];
  if (into.changes === undefined && scan.changes !== undefined) into.changes = scan.changes;
  if (scan.manager === true) into.manager = true;
}

/** Whether a switch weakens the protection with this value: lists match in any case, exceptions only exactly (fail closed). */
function weakensWith(values: OverrideValues, value: string): boolean {
  if (values === 'delay' || values === 'any') return true;
  const text = value.trim();
  if ('except' in values) return !values.except.includes(text);
  return values.some((entry) => entry.toLowerCase() === text.toLowerCase());
}

/**
 * The override an option of a tool's command sets, read as the tool reads it: a flag alone is true, and nopt's
 * --no-<name> is <name> set to false (--no-<name> true sets it to false too, as nopt inverts the word).
 */
function overrideOption(tool: ToolCommands, name: string, value: string | undefined, written: string): Found | undefined {
  const options = tool.overrides?.options ?? [];
  let entry = options.find((option) => option.name === name);
  let given = value ?? 'true';
  const negation = tool.parsing.negation;
  if (entry === undefined && negation !== undefined && name.startsWith(negation)) {
    entry = options.find((option) => option.name === `--${name.slice(negation.length)}`);
    given = value === 'false' ? 'true' : 'false';
  }
  if (entry === undefined || !weakensWith(entry.values, given)) return undefined;
  return { tool: tool.tool, written, weakens: entry.weakens, ...(entry.values === 'delay' ? { delay: given } : {}) };
}

/** The overrides among the options of a command that is not an install (npm ci --ignore-scripts=false). */
function optionOverrides(tool: ToolCommands, words: readonly Word[]): Found[] {
  const found: Found[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as Word;
    if (word.text === '--') break;
    if (!isOption(word.text) || word.dynamic) continue;
    const option = readOption(words, index, tool, (name) => tool.valueOptions.has(name));
    const override = overrideOption(tool, option.name, option.value, option.next === undefined ? word.text : `${word.text} ${option.next.text}`);
    if (override !== undefined) found.push(override);
    if (option.next !== undefined) index += 1;
  }
  return found;
}

/** The tool's command with what it weakens; it runs a package manager, so variables on its line count. */
function managerScan(line: string, found: readonly Found[]): CommandScan {
  return { requests: [], unreadable: undefined, manager: true, ...(found.length === 0 ? {} : { overrides: found.map((override) => ({ ...override, command: line })) }) };
}

/** What an option or a variable changes about the version a package manager picks or how it installs it. */
type SelectionEvent =
  | { setting: 'tag'; value: string }
  | {
      setting: 'prereleases' | 'buildFromSource';
      /** On, off, or back to the default. */
      value: boolean | undefined;
      /** Every package, the packages with this value (:none:), or the named packages (normalized). */
      scope: 'all' | 'none' | readonly string[];
      /** From a list (:all:), which also clears the packages named before. */
      list?: boolean;
    };

type Outcome = { specs: string[]; lines: string[]; rest: Word[]; events: SelectionEvent[]; overrides: Found[] } | { unreadable: string };

interface Switches {
  prereleases: SelectionSwitches;
  buildFromSource: SelectionSwitches;
}

/** The options of one command of a tool: those of the tool and those of the command. */
interface CommandContext {
  values: ReadonlySet<string>;
  editable: ReadonlySet<string>;
  /** How the options of this command change the version or the build of Python packages. */
  switches: Switches | undefined;
  /** npm: the option naming the dist-tag npm prefers. */
  tagOption: string | undefined;
}

function sameCommand(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function contextOf(tool: ToolCommands, command: readonly string[] | undefined): CommandContext {
  const own = command === undefined ? undefined : tool.facts.commandOptions?.find((entry) => sameCommand(entry.command, command));
  const selection = tool.selection;
  const special = command === undefined ? undefined : selection?.commands?.find((entry) => sameCommand(entry.command, command));
  return {
    values: new Set([...tool.valueOptions, ...(own?.valueOptions ?? [])]),
    editable: new Set([...(tool.facts.editableOptions ?? []), ...(own?.editableOptions ?? [])]),
    switches:
      selection === undefined
        ? undefined
        : { prereleases: special?.prereleases ?? selection.prereleases, buildFromSource: special?.buildFromSource ?? selection.buildFromSource },
    tagOption: tool.versionSelection?.tagOption,
  };
}

/** Values a boolean variable is false for, as pip's strtobool and uv's boolish parser read them; any other value is true. */
const FALSE = new Set(['', '0', 'false', 'no', 'off', 'n', 'f']);

/** A list of packages separated by commas: :all:, :none: and names, as pip reads --no-binary. */
function listEvents(setting: 'prereleases' | 'buildFromSource', value: boolean, text: string, booleans: boolean | undefined): SelectionEvent[] {
  return text.split(',').map((raw): SelectionEvent => {
    const item = raw.trim();
    const all = item === ':all:' || (booleans === true && item.toLowerCase() === 'true');
    const none = item === ':none:' || (booleans === true && item.toLowerCase() === 'false');
    if (all) return { setting, value, scope: 'all', list: true };
    if (none) return { setting, value, scope: 'none' };
    return { setting, value, scope: [normalizePythonName(item)] };
  });
}

function modeValue(switches: SelectionSwitches, mode: string): boolean | undefined {
  if (switches.onModes?.includes(mode) === true) return true;
  if (switches.offModes?.includes(mode) === true) return false;
  return undefined;
}

const SETTINGS = ['prereleases', 'buildFromSource'] as const;

/** What an option of a command changes about the version or the build. */
function optionEvents(context: CommandContext, name: string, value: string | undefined): SelectionEvent[] {
  const events: SelectionEvent[] = [];
  if (context.tagOption === name && value !== undefined) events.push({ setting: 'tag', value });
  for (const setting of SETTINGS) {
    const switches = context.switches?.[setting];
    if (switches === undefined) continue;
    if (switches.onFlags?.includes(name) === true) events.push({ setting, value: true, scope: 'all' });
    if (switches.offFlags?.includes(name) === true) events.push({ setting, value: false, scope: 'all' });
    if (value === undefined) continue;
    if (switches.onLists?.includes(name) === true) events.push(...listEvents(setting, true, value, switches.listBooleans));
    if (switches.offLists?.includes(name) === true) events.push(...listEvents(setting, false, value, switches.listBooleans));
    if (switches.onPackages?.includes(name) === true) events.push({ setting, value: true, scope: value.split(/\s+/u).filter((part) => part !== '').map(normalizePythonName) });
    if (switches.modeOptions?.includes(name) === true) events.push({ setting, value: modeValue(switches, value), scope: 'all' });
    if (switches.packageModeOptions?.includes(name) === true) {
      const equals = value.indexOf('=');
      if (equals > 0) events.push({ setting, value: modeValue(switches, value.slice(equals + 1)), scope: [normalizePythonName(value.slice(0, equals))] });
    }
  }
  return events;
}

/** What a variable set on the line changes about the version or the build. */
function variableEvents(switches: Switches | undefined, tagVariable: string | undefined, name: string, value: string): SelectionEvent[] {
  const lower = name.toLowerCase();
  const events: SelectionEvent[] = [];
  if (tagVariable !== undefined && tagVariable.toLowerCase() === lower) events.push({ setting: 'tag', value });
  for (const setting of SETTINGS) {
    const own = switches?.[setting];
    if (own === undefined) continue;
    const has = (list: readonly string[] | undefined) => list?.some((variable) => variable.toLowerCase() === lower) === true;
    // PIP_PRE=0 or UV_NO_BINARY=false only leaves the default.
    if (has(own.flagVariables)) events.push({ setting, value: FALSE.has(value.trim().toLowerCase()) ? undefined : true, scope: 'all' });
    if (has(own.onListVariables)) events.push(...listEvents(setting, true, value, own.listBooleans));
    if (has(own.offListVariables)) events.push(...listEvents(setting, false, value, own.listBooleans));
    if (has(own.onPackageVariables)) events.push({ setting, value: true, scope: value.split(/\s+/u).filter((part) => part !== '').map(normalizePythonName) });
    if (has(own.modeVariables)) events.push({ setting, value: modeValue(own, value.trim()), scope: 'all' });
  }
  return events;
}

/** Whether a package ends up with the setting on, off or at the default: a package named on its own wins over :all:. */
function settled(events: readonly SelectionEvent[], setting: 'prereleases' | 'buildFromSource', name: string | undefined): boolean | undefined {
  let all: boolean | undefined;
  const named = new Map<string, boolean | undefined>();
  for (const event of events) {
    if (event.setting !== setting) continue;
    if (event.scope === 'all') {
      all = event.value;
      if (event.list === true) named.clear();
    } else if (event.scope === 'none') {
      for (const [key, value] of named) if (value === event.value) named.delete(key);
      if (all === event.value) all = undefined;
    } else {
      for (const key of event.scope) named.set(key, event.value);
    }
  }
  return name !== undefined && named.has(name) ? named.get(name) : all;
}

interface ReadOption {
  /** The option, its abbreviation resolved. */
  name: string;
  /** Its value: attached (--opt=value, -ovalue) or the next word. */
  value: string | undefined;
  /** The next word, when it is the value. */
  next: Word | undefined;
}

/** A long option for an unambiguous prefix: of any option when the tool's flags are listed, else of a registry or configuration option. */
function abbreviated(tool: ToolCommands, name: string): string | undefined {
  const pool = tool.complete ? tool.longOptions : tool.registryLong;
  const matches = pool.filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The option a word names under nopt's rules (npm, pnpm), without its dashes; `fixed` when it takes no further word. */
function noptOption(tool: ToolCommands, bare: string): { name: string; fixed: boolean; value?: string } {
  const { parsing, known } = tool;
  if (known.has(`--${bare}`)) return { name: `--${bare}`, fixed: false };
  if (known.has(`-${bare}`)) return { name: `-${bare}`, fixed: false };
  if (parsing.settingPrefix !== undefined && `--${bare}`.startsWith(parsing.settingPrefix) && `--${bare}`.length > parsing.settingPrefix.length) {
    return noptOption(tool, `--${bare}`.slice(parsing.settingPrefix.length));
  }
  const shorthands = parsing.shorthands ?? {};
  const expand = (expansion: readonly string[]): { name: string; fixed: boolean; value?: string } => {
    const [name, value] = splitOption(expansion[0] ?? '');
    if (value !== undefined) return { name, fixed: true, value };
    return expansion.length > 1 ? { name, fixed: true, value: expansion.slice(1).join(' ') } : { name, fixed: false };
  };
  if (Object.hasOwn(shorthands, bare)) return expand(shorthands[bare] ?? []);
  const letters = [...bare];
  if (letters.length > 1 && letters.every((letter) => Object.hasOwn(shorthands, letter))) {
    // -gD: one-letter shorthands together; the last may take the next word.
    return expand(shorthands[letters.at(-1) as string] ?? []);
  }
  if (parsing.negation !== undefined && `--${bare}`.startsWith(parsing.negation)) return { name: `--${bare}`, fixed: true };
  if (parsing.abbreviations === true) {
    const option = abbreviated(tool, `--${bare}`);
    if (option !== undefined) return { name: option, fixed: false };
    const keys = tool.complete ? Object.keys(shorthands).filter((key) => key.startsWith(bare)) : [];
    if (keys.length === 1) return expand(shorthands[keys[0] as string] ?? []);
  }
  return { name: `--${bare}`, fixed: false };
}

/**
 * Reads the option at `index`. `takes` tells whether a resolved option takes a value. Tools that accept abbreviated long
 * options (optparse, argparse) have them resolved to the one option they name; tools that group short options read
 * -Uq as two flags and -ivalue as -i with a value. npm and pnpm (nopt) take any number of dashes, shorthands such as
 * --reg for --registry, and prefixes of option names.
 */
function readOption(words: readonly Word[], index: number, tool: ToolCommands, takes: (name: string) => boolean): ReadOption {
  const text = (words[index] as Word).text;
  const parsing = tool.parsing;
  let [name, attached] = splitOption(text);
  // nopt takes the word true or false after a flag as its value (--ignore-scripts false), also after --no-<name>.
  const word = words[index + 1];
  const booleanWord = parsing.booleanWords === true && attached === undefined && word !== undefined && !word.dynamic && (word.text === 'true' || word.text === 'false') ? word : undefined;
  if (parsing.anyDashes === true) {
    const option = noptOption(tool, name.replace(/^-+/u, ''));
    if (option.fixed) {
      const negated = parsing.negation !== undefined && option.name.startsWith(parsing.negation) && option.value === undefined;
      if (negated && booleanWord !== undefined) return { name: option.name, value: booleanWord.text, next: booleanWord };
      return { name: option.name, value: attached ?? option.value, next: undefined };
    }
    name = option.name;
    if (booleanWord !== undefined && !takes(name) && tool.known.has(name)) return { name, value: booleanWord.text, next: booleanWord };
  } else if (parsing.groupedShortOptions === true && /^-[^-]./u.test(text) && attached === undefined) {
    // -Uihttps://… is -U, then -i with the rest of the word as its value.
    for (let position = 1; position < text.length; position++) {
      const option = `-${text[position] as string}`;
      if (takes(option)) {
        const rest = text.slice(position + 1);
        return rest === '' ? { name: option, value: words[index + 1]?.text, next: words[index + 1] } : { name: option, value: rest, next: undefined };
      }
    }
    return { name: text, value: undefined, next: undefined };
  } else if (parsing.abbreviations === true && name.startsWith('--') && !tool.longOptions.includes(name)) {
    name = abbreviated(tool, name) ?? name;
  }
  if (attached !== undefined || !takes(name)) return { name, value: attached, next: undefined };
  return { name, value: words[index + 1]?.text, next: words[index + 1] };
}

/** A path for an editable install: pip and uv take the value of -e for a path even without a separator. */
function editablePath(value: string): string {
  return /[/\\]|^\.|:\/\/|^[A-Za-z]+\+/u.test(value) ? value : `./${value}`;
}

/** uv's lists of requirements: split at commas outside [...] that are not followed by !, =, <, > or ~. */
function commaSeparated(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '[') depth += 1;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0 && !/^\s*[!=<>~]/u.test(value.slice(index + 1))) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** A first argument that names an interpreter (uvx python3.12), not a package. */
function isInterpreter(text: string, names: readonly string[] | undefined): boolean {
  return names !== undefined && names.some((name) => new RegExp(`^${name}(?:@?[0-9][0-9.]*)?$`, 'iu').test(text));
}

function scriptDownload(text: string): string {
  return `it ${SCRIPT_DOWNLOAD} ${shown(text)}, whose dependencies depcurfew cannot see`;
}

/**
 * The package arguments after the subcommand, the command lines given to options and, for run and create commands,
 * the words left for the package; or why they cannot be read.
 */
function readArguments(words: readonly Word[], mode: 'add' | 'run' | 'create', tool: ToolCommands, entry: DownloadCommand | undefined, context: CommandContext): Outcome {
  const packageOptions = entry?.packageOptions ?? [];
  const extraOptions = mode === 'add' ? (tool.facts.addPackageOptions ?? []) : (entry?.extraPackageOptions ?? []);
  const lineOptions = entry?.lineOptions ?? [];
  const takes = (name: string) => context.values.has(name) || packageOptions.includes(name) || extraOptions.includes(name) || lineOptions.includes(name);
  const specs: string[] = [];
  const lines: string[] = [];
  const events: SelectionEvent[] = [];
  const overrides: Found[] = [];
  let named = false;
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
      const option = readOption(words, index, tool, takes);
      const { name, value, next } = option;
      // The arguments are local files (deno install --entrypoint), so no package is named.
      if (mode === 'add' && tool.facts.fileOptions?.includes(name) === true) return { specs: [], lines, rest: [], events, overrides };
      if (entry?.shellOptions?.includes(name) === true) {
        shell = true;
        continue;
      }
      if (next !== undefined) index += 1;
      if (lineOptions.includes(name)) {
        // A command line that runs with the packages: read like the rest, expansions included.
        if (next?.input === true) return { unreadable: expanded(next) };
        if (value !== undefined) lines.push(value);
        continue;
      }
      if (next?.dynamic === true) return { unreadable: `"${shown(`${word.text} ${next.text}`)}" is expanded by the shell` };
      const setting = registryOption(tool, name, value);
      if (setting !== undefined) return { unreadable: setting };
      const override = overrideOption(tool, name, value, next === undefined ? word.text : `${word.text} ${next.text}`);
      if (override !== undefined) overrides.push(override);
      events.push(...optionEvents(context, name, value));
      if (value === undefined) continue;
      const listed = tool.facts.commaSeparatedOptions?.includes(name) === true ? commaSeparated(value) : [value];
      const editable = context.editable.has(name);
      if ((mode !== 'add' && packageOptions.includes(name)) || extraOptions.includes(name) || editable) {
        specs.push(...listed.map((spec) => (editable ? editablePath(spec) : spec)));
        if (packageOptions.includes(name)) named = true;
      }
      continue;
    }
    if (shell) {
      // Shell mode: the argument is a command line that runs with the packages.
      if (word.input === true) return { unreadable: expanded(word) };
      lines.push(word.text);
      return { specs, lines, rest: [], events, overrides };
    }
    if (word.dynamic) return { unreadable: expanded(word) };
    if (mode === 'add') {
      specs.push(word.text);
      continue;
    }
    // run and create: the first positional argument names the package (unless an option did); it runs with the rest.
    if (mode === 'run') {
      const url = /^https?:\/\//iu.test(word.text);
      if (entry?.packageArgument === false) {
        if (entry.scriptUrls === true && url) return { unreadable: scriptDownload(word.text) };
        return { specs, lines, rest: words.slice(index), events, overrides };
      }
      if (entry?.scriptSuffixes?.some((suffix) => word.text.toLowerCase().endsWith(suffix)) === true) {
        return url ? { unreadable: scriptDownload(word.text) } : { specs, lines, rest: [], events, overrides };
      }
      if (!named && isInterpreter(word.text, tool.facts.interpreterNames)) return { specs, lines, rest: words.slice(index), events, overrides };
      if (!named) specs.push(entry?.binaryPath === true ? withoutBinary(word.text) : word.text);
    }
    if (mode === 'create') specs.push(/^[.~/\\]|^[^@][^/]*\//u.test(word.text) ? word.text : createPackage(word.text, tool.facts.createNames));
    return { specs, lines, rest: words.slice(index), events, overrides };
  }
  return { specs, lines, rest: [], events, overrides };
}

/** A package without the /<binary> after it (deno x npm:typescript/tsc); scoped names keep their own slash. */
function withoutBinary(spec: string): string {
  const prefix = /^[a-z]+:/u.exec(spec)?.[0] ?? '';
  // jsr: exports are paths of the package, which depcurfew does not look up anyway.
  if (prefix !== '' && prefix !== 'npm:') return spec;
  const rest = spec.slice(prefix.length);
  const slash = rest.indexOf('/', rest.startsWith('@') ? rest.indexOf('/') + 1 : 0);
  return slash <= 0 ? spec : `${prefix}${rest.slice(0, slash)}`;
}

interface Pending {
  /** What the command's options change, in order. */
  events: readonly SelectionEvent[];
  /** Variables set on the line and the lines around it, outer lines first; they count before the options. */
  variables: { name: string; value: string }[];
  switches: Switches | undefined;
  tagVariable: string | undefined;
}

/** What is still to be settled about each request: the variables of the lines around it come in on the way out. */
const PENDING = new WeakMap<InstallRequest, Pending>();

function finish(
  tool: ToolCommands,
  line: string,
  outcome: Outcome,
  depth: number,
  before: readonly SelectionEvent[] = [],
  context?: CommandContext,
  overridesBefore: readonly Found[] = [],
): CommandScan {
  if ('unreadable' in outcome) return unreadable(`${shown(line)}: ${outcome.unreadable}`);
  // Python specs carry the prefix of the policy, so that check looks them up on the index.
  const prefix = tool.ecosystem === 'pypi' ? PYPI_PREFIX : '';
  const events = [...before, ...outcome.events];
  const requests = outcome.specs.map((spec): InstallRequest => {
    const request: InstallRequest = { tool: tool.tool, command: line, spec: `${prefix}${spec}` };
    PENDING.set(request, { events, variables: [], switches: context?.switches, tagVariable: tool.versionSelection?.tagVariable });
    return request;
  });
  const scan: CommandScan = managerScan(line, [...overridesBefore, ...outcome.overrides]);
  scan.requests.push(...requests);
  for (const nested of outcome.lines) merge(scan, scanLine(nested, depth + 1));
  // The package may run a package manager in turn (npx cross-env NODE_ENV=x npm install …).
  merge(scan, laterCommand(outcome.rest, depth));
  return scan;
}

/** A package manager, shell or wrapper further along the words, run by a command depcurfew does not know (strace, find -exec). */
function laterCommand(words: readonly Word[], depth: number): CommandScan {
  const { runners } = commands();
  const index = words.findIndex((word) => !word.dynamic && runners.has(executableOf(word.text)));
  if (index === -1) return NOTHING;
  let later = words.slice(index);
  if (words.slice(0, index).some((word) => !word.dynamic && FIND_EXEC.has(word.text))) {
    // find … -exec command … ; (or +): the command ends there, and find puts the file names it finds in place of {}.
    const end = later.findIndex((word, position) => position > 0 && !word.dynamic && (word.text === ';' || word.text === '+'));
    if (end !== -1) later = later.slice(0, end);
    later = later.map((word) => (word.text.includes('{}') ? { text: word.text, dynamic: true, input: true, filler: 'find puts file names in place of {}' } : word));
  }
  return scanCommand({ words: later, input: [], redirected: false, later: true }, depth);
}

/** The commands in the input of a command that runs it as commands: a here-document or here-string is known, a pipe or a file is not. */
function scanInput(words: readonly Word[], command: SimpleCommand, depth: number, shell: Shell = 'posix'): CommandScan {
  if (command.later === true) return NOTHING;
  if (command.input.length === 0 || command.redirected) return unreadable(`${shown(joined(words))}: ${FROM_INPUT}`);
  const scan: CommandScan = { requests: [], unreadable: undefined };
  for (const input of command.input) merge(scan, scanLine(input, depth + 1, shell));
  return scan;
}

/**
 * The command line another shell (PowerShell, cmd) gets as words: a word the calling shell expands changes the text
 * before that shell reads it, so the line cannot be known.
 */
function commandLineOf(words: readonly Word[], rest: readonly Word[]): { line: string } | { unreadable: string } {
  const expands = rest.find((word) => word.dynamic);
  return expands === undefined ? { line: joined(rest) } : { unreadable: `${shown(joined(words))}: ${expanded(expands)}` };
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
  // bash <(curl …) runs what another command prints, like curl … | bash.
  if (operand !== undefined && isProcessSubstitution(operand)) return unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`);
  const reads = fromInput || operand === undefined || STDIN_FILES.has(operand.text);
  return reads ? scanInput(words, command, depth) : NOTHING;
}

/**
 * source file and . file run a file in the current shell: a local script is not read, but standard input and <(…)
 * are. bash finds a file named without a slash on PATH and passes it the words after it, so . npm i x runs an npm
 * that is a shell script (Git Bash) with i x; in PowerShell, . npm i x dot-sources the command npm. Either way the
 * package manager it names is read with those words.
 */
function scanSource(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan | undefined {
  const file = words[1];
  if (file === undefined) return NOTHING;
  if (isProcessSubstitution(file)) return unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`);
  const manager = file.dynamic ? undefined : scriptManager(file.text);
  if (manager !== undefined) return scanCommand({ ...command, words: [{ text: manager, dynamic: false }, ...words.slice(2)] }, depth);
  return file.dynamic || !STDIN_FILES.has(file.text) ? NOTHING : undefined;
}

/** trap action signal…: the action is a command line the shell runs on those signals (EXIT, DEBUG, ERR…); - and a number reset them. */
function scanTrap(words: readonly Word[], depth: number): CommandScan {
  let index = 1;
  while (index < words.length && /^-[lpP]+$/u.test((words[index] as Word).text)) index += 1;
  if (words[index]?.text === '--') index += 1;
  const action = words[index];
  if (action === undefined || (!action.dynamic && (action.text === '-' || /^\d+$/u.test(action.text)))) return NOTHING;
  if (action.input === true) return unreadable(`${shown(joined(words))}: ${expanded(action)}`);
  return scanLine(action.text, depth + 1);
}

/** The aliases defined so far in the command line being scanned, by name, with their values. */
let aliases = new Map<string, string>();

/**
 * alias name=value: the value is read as a command line, and a later command that starts with the name is read with
 * the value in its place. bash expands aliases only in later lines and with expand_aliases, zsh in any shell; depcurfew
 * reads them everywhere, which at worst checks a command that would not run.
 */
function scanAlias(words: readonly Word[], depth: number): CommandScan {
  const scan: CommandScan = { requests: [], unreadable: undefined };
  for (const word of words.slice(1)) {
    const equals = word.text.indexOf('=');
    if (isOption(word.text) || equals <= 0) continue;
    const value = word.text.slice(equals + 1);
    aliases.set(word.text.slice(0, equals), value);
    merge(scan, scanLine(value, depth + 1));
  }
  return scan;
}

/** The words an alias stands for, or undefined when its value is more than one simple command (it is then read as a line). */
function aliasWords(value: string): Word[] | undefined {
  try {
    const reading = read(value, 0, undefined, 0);
    return reading.items.every((item) => item.kind === 'word') ? reading.items.map((item) => (item as { word: Word }).word) : undefined;
  } catch (error) {
    if (error instanceof Unreadable) return undefined;
    throw error;
  }
}

/** A word as the shell would read it back: in single quotes unless the shell expands it. */
function requoted(word: Word): string {
  return word.dynamic ? word.text : `'${word.text.replaceAll("'", "'\\''")}'`;
}

/** PowerShell parameters with a separate value, by name and alias; any other parameter is a switch. */
const POWERSHELL_VALUES = [
  'executionpolicy', 'ex', 'ep', 'windowstyle', 'w', 'workingdirectory', 'wd', 'wo', 'inputformat', 'inp', 'if', 'outputformat', 'o', 'of',
  'configurationname', 'config', 'settingsfile', 'settings', 'custompipename',
];

/** Whether a PowerShell parameter (without its dash, lowercased) is `name`, one of its aliases or a prefix of it at least `shortest` long. */
function powerShellParameter(given: string, name: string, aliases: readonly string[], shortest: number): boolean {
  return given === name || aliases.includes(given) || (given.length >= shortest && name.startsWith(given));
}

/**
 * pwsh and powershell: -Command (-c) takes the rest of the words as the command line, read like a shell line;
 * -EncodedCommand cannot be read; -File (-f) runs a script. Without either, pwsh runs a script and Windows PowerShell
 * a command.
 */
function scanPowerShell(words: readonly Word[], command: SimpleCommand, depth: number, windows: boolean): CommandScan {
  let index = 1;
  let mode: 'command' | 'file' | undefined;
  for (; index < words.length; index++) {
    const word = words[index] as Word;
    if (!/^-[A-Za-z]/u.test(word.text)) break;
    if (word.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(word)}`);
    const given = word.text.slice(1).split(':')[0]?.toLowerCase() ?? '';
    if (powerShellParameter(given, 'encodedcommand', ['e', 'ec', 'en', 'enc'], 2)) return unreadable(`${shown(joined(words))}: the command ${ENCODED}`);
    if (powerShellParameter(given, 'commandwithargs', ['cwa'], 8)) {
      const first = words[index + 1];
      if (first === undefined) return NOTHING;
      if (first.input === true || first.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(first)}`);
      return scanLine(first.text, depth + 1, 'powershell');
    }
    if (powerShellParameter(given, 'command', ['c'], 3)) {
      mode = 'command';
      index += 1;
      break;
    }
    if (powerShellParameter(given, 'file', ['f'], 2)) {
      mode = 'file';
      index += 1;
      break;
    }
    if (POWERSHELL_VALUES.includes(given) || POWERSHELL_VALUES.some((name) => given.length >= 3 && name.startsWith(given))) index += 1;
  }
  const rest = words.slice(index);
  const first = rest[0];
  if (first === undefined) return NOTHING;
  if ((mode ?? (windows ? 'command' : 'file')) === 'file') {
    if (isProcessSubstitution(first)) return unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`);
    return STDIN_FILES.has(first.text) ? scanInput(words, command, depth, 'powershell') : NOTHING;
  }
  if (first.text === '-') return scanInput(words, command, depth, 'powershell');
  const commandLine = commandLineOf(words, rest);
  return 'line' in commandLine ? scanLine(commandLine.line, depth + 1, 'powershell') : unreadable(commandLine.unreadable);
}

/**
 * Whether a command gets a command line as a shell would: after -c (also grouped, as -lc) or cmd's /c and /k, a word
 * that is expanded or holds spaces or operators, or a here-document, a here-string or a pipe as its input.
 */
function commandLineGiven(rest: readonly Word[], command: SimpleCommand): boolean {
  if (command.later === true) return false;
  if (command.input.length > 0 || command.redirected || command.stdin === 'pipe') return true;
  const flag = rest.findIndex((word) => !word.dynamic && /^(?:-[A-Za-z]*c[A-Za-z]*|\/+[ck])$/iu.test(word.text));
  const operand = flag === -1 ? undefined : rest[flag + 1];
  return operand !== undefined && (operand.dynamic || /[\s;&|<>()`$]/u.test(operand.text));
}

/** cmd /c and cmd /k run the rest as a cmd command line (also /cdir, and //c from Git Bash); without either cmd reads commands from its input. */
function scanCmd(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    const option = /^\/+([A-Za-z])(.*)$/su.exec(word.text);
    if (option === null || word.dynamic) break;
    if (/^[ck]$/iu.test(option[1] as string)) {
      const glued = option[2] as string;
      const rest = [...(glued === '' ? [] : [{ text: glued, dynamic: false }]), ...words.slice(index + 1)];
      if (rest.length === 0) return NOTHING;
      const commandLine = commandLineOf(words, rest);
      return 'line' in commandLine ? scanLine(commandLine.line, depth + 1, 'cmd') : unreadable(commandLine.unreadable);
    }
  }
  return scanInput(words, command, depth, 'cmd');
}

/** Invoke-Expression (iex) runs the code it is given, or the code piped into it: iex (irm …) and irm … | iex download and run a script. */
function scanInvokeExpression(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  const rest = words.slice(1).filter((word) => !/^-command$/iu.test(word.text));
  const code = rest[0];
  if (command.later === true) return NOTHING;
  if (code === undefined || command.stdin === 'pipe') return unreadable(`${shown(joined(words))}: ${FROM_INPUT}`);
  if (code.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(code, 'the code ')}`);
  return scanLine(code.text, depth + 1, 'powershell');
}

/** What a wrapper runs: the remaining words, or a command line to read. */
function unwrap(words: readonly Word[], wrapper: Wrapper): { words: Word[] } | { line: string } | { unreadable: string } {
  if (wrapper.anywhere === true) return unwrapAnywhere(words, wrapper);
  let index = 1;
  let replace: string | undefined;
  let shell = false;
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
    // getopt_long takes an unambiguous prefix of a long option: env --split='npm i x'.
    if (wrapper.split?.some((option) => option === name || (name.startsWith('--') && name.length > 2 && option.startsWith(name))) === true) {
      const value = attached ?? words[index + 1]?.text ?? '';
      return { line: [value, ...words.slice(index + (attached === undefined ? 2 : 1)).map((word) => word.text)].join(' ') };
    }
    if (wrapper.lineOptions?.includes(name)) return lineOf(attached, words[index + 1]);
    if (wrapper.shellOptions?.includes(name)) {
      shell = true;
      index += 1;
      continue;
    }
    const inputOption = wrapper.input?.find((option) => name === option || (option.length === 2 && name.startsWith(option)));
    if (inputOption !== undefined) {
      // xargs -I{} or --replace={}: the string is replaced with input; -i alone means {}.
      const inline = attached ?? (name.length > inputOption.length ? name.slice(inputOption.length) : undefined);
      replace = inline ?? (inputOption === '-i' ? '{}' : words[index + 1]?.text);
      index += inline === undefined && inputOption !== '-i' ? 2 : 1;
      continue;
    }
    if (/^-[^-]./u.test(text)) {
      const grouped = groupedOptions(words, index, wrapper);
      if (!('next' in grouped)) return grouped;
      shell ||= grouped.shell;
      index = grouped.next;
      continue;
    }
    index += attached === undefined && wrapper.values?.includes(name) === true ? 2 : 1;
  }
  const rest = words.slice(index + (wrapper.operands ?? 0));
  if (shell) {
    if (rest.length === 0) return { words: [] };
    const filled = rest.find((word) => word.input === true);
    return filled === undefined ? { line: joined(rest) } : { unreadable: expanded(filled) };
  }
  // flock file -c command: a line option may follow the operands.
  const [after, value] = splitOption(rest[0]?.text ?? '');
  if (wrapper.operands !== undefined && wrapper.lineOptions?.includes(after) === true) return lineOf(value, rest[1]);
  if (wrapper.line === true) {
    const filled = rest.find((word) => word.input === true);
    return filled === undefined ? { line: joined(rest) } : { unreadable: expanded(filled) };
  }
  if (wrapper.input === undefined || rest.length === 0) return { words: rest };
  if (replace === undefined) return { words: [...rest, XARGS_INPUT] };
  const marker = replace;
  return { words: rest.map((word) => (word.text.includes(marker) ? { text: word.text, dynamic: true, input: true } : word)) };
}

/**
 * One-letter options of a wrapper grouped in one word, as getopt reads them (env -iS'npm i x', env -vS 'npm i x',
 * sudo -Es): flags, then perhaps an option whose value is the rest of the word or the next word. The = of -u=x is part
 * of the value, so the word is read as written.
 */
function groupedOptions(words: readonly Word[], index: number, wrapper: Wrapper): { next: number; shell: boolean } | { line: string } | { unreadable: string } {
  const text = (words[index] as Word).text;
  let shell = false;
  for (let position = 1; position < text.length; position++) {
    const option = `-${text[position] as string}`;
    const rest = text.slice(position + 1);
    if (wrapper.split?.includes(option)) {
      const value = rest === '' ? (words[index + 1]?.text ?? '') : rest;
      return { line: [value, ...words.slice(index + (rest === '' ? 2 : 1)).map((word) => word.text)].join(' ') };
    }
    if (wrapper.lineOptions?.includes(option)) return lineOf(rest === '' ? undefined : rest, words[index + 1]);
    if (wrapper.shellOptions?.includes(option)) shell = true;
    if (wrapper.values?.includes(option)) return { next: index + (rest === '' ? 2 : 1), shell };
  }
  return { next: index + 1, shell };
}

/** The command line given to a line option: in the same word (attached) or the next one. */
function lineOf(attached: string | undefined, next: Word | undefined): { line: string } | { unreadable: string } {
  const value = attached === undefined ? next : { text: attached, dynamic: false };
  if (value?.input === true) return { unreadable: expanded(value) };
  return { line: value?.text ?? '' };
}

/** su, runuser and script: getopt reads their options anywhere among the words, and one-letter options may be grouped. */
function unwrapAnywhere(words: readonly Word[], wrapper: Wrapper): { words: Word[] } | { line: string } | { unreadable: string } {
  let command: number | undefined;
  for (let index = 1; index < words.length; index++) {
    const text = (words[index] as Word).text;
    if (text === '--') return { words: command === undefined ? [] : words.slice(index + 1) };
    if (!isOption(text)) {
      if (command !== undefined) return { words: words.slice(index) };
      continue;
    }
    const [name, attached] = splitOption(text);
    if (wrapper.lineOptions?.includes(name)) return lineOf(attached, words[index + 1]);
    if (/^-[^-]./u.test(text)) {
      // -lc 'command': flags, then an option whose value is the rest of the word or the next word.
      let grouped = false;
      for (let position = 1; position < text.length; position++) {
        const option = `-${text[position] as string}`;
        const rest = text.slice(position + 1);
        if (wrapper.lineOptions?.includes(option)) return lineOf(rest === '' ? undefined : rest, words[index + 1]);
        if (wrapper.values?.includes(option)) {
          if (wrapper.commandAfter?.includes(option)) command = index;
          if (rest === '') index += 1;
          grouped = true;
          break;
        }
      }
      if (grouped) continue;
    }
    if (wrapper.commandAfter?.includes(name)) command = index;
    if (attached === undefined && wrapper.values?.includes(name) === true) index += 1;
  }
  // No command: su and runuser start an interactive shell, script records one.
  return { words: [] };
}

/** The executable a word runs: its base name, without @version (npx@10), ==version (pip==25) or a version suffix such as pip3.12 or python3.12. */
function executableOf(text: string): string {
  const name = basename(text).replace(/@[^/]*$/u, '').replace(/==.*$/u, '');
  const { executables } = commands();
  if (executables.has(name)) return name;
  const unversioned = name.replace(/[0-9][0-9.]*$/u, '');
  return unversioned !== name && (executables.has(unversioned) || interpreter()?.executables.includes(unversioned) === true) ? unversioned : name;
}

/** Script files a JavaScript or Python interpreter runs: npm-cli.js, yarn-4.1.0.cjs, pnpm.mjs, pip.pyz, __main__.py. */
const SCRIPT_EXTENSIONS = /\.(?:js|cjs|mjs|pyz|py)$/iu;

/**
 * The package manager a script path runs: its file name without the extension, -cli or a version (/usr/bin/npm,
 * node_modules/npm/bin/npm-cli.js, .yarn/releases/yarn-4.1.0.cjs, pip.pyz), the folder of a __main__.py, or the Yarn
 * a project keeps in .yarn/releases; undefined when it names none.
 */
function scriptManager(text: string): string | undefined {
  const { executables } = commands();
  const parts = text.split(/[/\\]/u).filter((part) => part !== '');
  let name = (parts.at(-1) ?? '').replace(SCRIPT_EXTENSIONS, '');
  if (name === '__main__') name = parts.at(-2) ?? '';
  for (const candidate of [name, name.replace(/-cli$/iu, ''), name.replace(/-v?\d[\w.+-]*$/u, '')]) {
    const executable = executableOf(candidate);
    if (candidate !== '' && executables.has(executable)) return executable;
  }
  return parts.at(-3) === '.yarn' && parts.at(-2) === 'releases' && executables.has('yarn') ? 'yarn' : undefined;
}

/** A package manager a folder of a script path names (/usr/lib/node_modules/npm/lib/cli.js): the script may be its entry point. */
function managerFolder(text: string): string | undefined {
  const { executables } = commands();
  return text
    .split(/[/\\]/u)
    .slice(0, -1)
    .map((part) => executableOf(part))
    .find((part) => executables.has(part));
}

/**
 * The script an interpreter runs, with the words after it: a package manager's script is that package manager; a
 * script the shell expands, or one in a package manager's folder, followed by an install word may be one (ask).
 */
function scanScript(words: readonly Word[], index: number, command: SimpleCommand, depth: number): CommandScan {
  const script = words[index] as Word;
  const rest = words.slice(index + 1);
  const manager = script.dynamic ? undefined : scriptManager(script.text);
  if (manager !== undefined) return scanCommand({ ...command, words: [{ text: manager, dynamic: false }, ...rest] }, depth);
  const next = rest.find((word) => !isOption(word.text));
  // run is left out: node "$SCRIPT" run lint is common, and running a script of a project installs nothing.
  if (next !== undefined && !next.dynamic && next.text !== 'run' && commands().installWords.has(next.text)) {
    if (script.dynamic && !isProcessSubstitution(script)) return unreadable(`${shown(joined(words))}: ${expanded(script, 'the script ')} ${MAY_BE_MANAGER}`);
    const folder = script.dynamic ? undefined : managerFolder(script.text);
    if (folder !== undefined) return unreadable(`${shown(joined(words))}: the script "${shown(script.text)}" is in a folder named ${folder} ${MAY_BE_MANAGER}`);
  }
  return scanProgram(words, command, script);
}

/**
 * The script operand of an interpreter run without inline code: a program read from a pipe (curl … | python3) or
 * printed by another command (python3 <(curl …)) cannot be read; a local script and a here-document are not read.
 */
function scanProgram(words: readonly Word[], command: SimpleCommand, script: Word | undefined): CommandScan {
  if (script !== undefined && isProcessSubstitution(script)) return unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`);
  const fromInput = script === undefined || STDIN_FILES.has(script.text);
  return fromInput && command.later !== true && command.stdin === 'pipe' ? unreadable(`${shown(joined(words))}: ${FROM_PROGRAM}`) : NOTHING;
}

/** node, ruby, perl or php: options, then the script; without one (or with -) they run the program on their input. */
function scanProgramReader(words: readonly Word[], command: SimpleCommand, reader: ProgramReader, depth: number): CommandScan {
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (!isOption(word.text)) return scanScript(words, index, command, depth);
    const [name] = splitOption(word.text);
    const inline = reader.inline.find((option) => name === option || (option.length === 2 && name.startsWith(option)));
    if (inline !== undefined) {
      const code = word.text.length > inline.length ? word : words[index + 1];
      return printedCode(code) ? unreadable(`${shown(joined(words))}: ${FROM_PRINTED_CODE}`) : NOTHING;
    }
    if (reader.values.includes(name) && !word.text.includes('=')) index += 1;
  }
  return scanProgram(words, command, undefined);
}

/** python -m <module>: the module when it is a package manager (python -m pip install …), run with the rest of the words. */
function scanInterpreter(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  const facts = interpreter();
  if (facts === undefined) return NOTHING;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (!isOption(word.text)) return scanScript(words, index, command, depth);
    if (word.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(word)}`);
    if (word.text === '--') return words[index + 1] === undefined ? scanProgram(words, command, undefined) : scanScript(words, index + 1, command, depth);
    if (word.text.startsWith('--')) {
      if (facts.valueOptions.includes(word.text)) index += 1;
      continue;
    }
    // One-letter options, grouped as getopt reads them (-Im pip): flags up to one that takes a value, which is the
    // rest of the word or the next word.
    const letters = facts.groupedShortOptions ? word.text.slice(1) : word.text.slice(1, 2);
    for (let at = 0; at < letters.length; at++) {
      const option = `-${letters[at] as string}`;
      const attached = facts.groupedShortOptions ? letters.slice(at + 1) : word.text.slice(2);
      // A command string (-c) is Python code, which depcurfew does not read, unless another command prints it.
      if (option === facts.commandOption) {
        const code = attached === '' ? words[index + 1] : word;
        return printedCode(code) ? unreadable(`${shown(joined(words))}: ${FROM_PRINTED_CODE}`) : NOTHING;
      }
      if (option === facts.moduleOption) {
        const module = attached === '' ? words[index + 1] : { text: attached, dynamic: false };
        if (module === undefined) return NOTHING;
        if (module.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(module, 'the module ')}`);
        // A module inside a package manager's package runs that package manager: python -m pip.__main__.
        const name = module.text.split('.')[0] ?? '';
        if (!commands().executables.has(name)) return NOTHING;
        return scanCommand({ ...command, words: [{ text: name, dynamic: false }, ...words.slice(index + (attached === '' ? 2 : 1))] }, depth);
      }
      if (facts.valueOptions.includes(option)) {
        if (attached === '') index += 1;
        break;
      }
    }
  }
  return scanProgram(words, command, undefined);
}

/** The subcommand words after the executable, skipping options and their values, with where each one stands. */
function commandWords(
  rest: readonly Word[],
  tool: ToolCommands,
  line: string,
): { words: { word: Word; index: number }[]; events: SelectionEvent[]; overrides: Found[] } | { unreadable: string } {
  const found: { word: Word; index: number }[] = [];
  const events: SelectionEvent[] = [];
  const overrides: Found[] = [];
  const context = contextOf(tool, undefined);
  for (let index = 0; index < rest.length && found.length < 3; index++) {
    const word = rest[index] as Word;
    if (word.text === '--') break;
    if (isOption(word.text)) {
      if (word.dynamic) return { unreadable: `${shown(line)}: ${expanded(word)}` };
      const option = readOption(rest, index, tool, (name) => context.values.has(name));
      if (option.next?.dynamic === true) return { unreadable: `${shown(line)}: "${shown(`${word.text} ${option.next.text}`)}" is expanded by the shell` };
      const setting = registryOption(tool, option.name, option.value);
      if (setting !== undefined) return { unreadable: `${shown(line)}: ${setting}` };
      const override = overrideOption(tool, option.name, option.value, option.next === undefined ? word.text : `${word.text} ${option.next.text}`);
      if (override !== undefined) overrides.push(override);
      events.push(...optionEvents(context, option.name, option.value));
      if (option.next !== undefined) index += 1;
      continue;
    }
    found.push({ word, index });
  }
  return { words: found, events, overrides };
}

/** pip, uv, Poetry, PDM, Pipenv and pipx: their install, run and add commands matched word for word (uv pip install, uv tool run). */
function scanPythonTool(tool: ToolCommands, executable: string, rest: readonly Word[], line: string, depth: number): CommandScan | undefined {
  const { facts } = tool;
  const read = commandWords(rest, tool, line);
  if ('unreadable' in read) return unreadable(read.unreadable);
  const found = read.words;
  const dynamic = found.find(({ word }) => word.dynamic);
  /** Where the arguments of the command start, when the words match it. */
  const match = (command: readonly string[]): number | undefined => {
    if (command[0] !== executable) return undefined;
    const parts = command.slice(1);
    for (let index = 0; index < parts.length; index++) if (found[index]?.word.text !== parts[index] || found[index]?.word.dynamic === true) return undefined;
    return parts.length === 0 ? 0 : (found[parts.length - 1]?.index ?? 0) + 1;
  };
  // Longer commands first, so that uv tool run is not taken for uv run.
  const byLength = <T>(list: readonly T[], command: (entry: T) => readonly string[]) => [...list].sort((a, b) => command(b).length - command(a).length);
  const run = (mode: 'add' | 'run' | 'create', start: number, command: readonly string[], entry: DownloadCommand | undefined) => {
    const context = contextOf(tool, command);
    return finish(tool, line, readArguments(rest.slice(start), mode, tool, entry, context), depth, read.events, context, read.overrides);
  };
  for (const entry of byLength(facts.run, (item) => item.command)) {
    const start = match(entry.command);
    if (start !== undefined) return run('run', start, entry.command, entry);
  }
  for (const entry of byLength(facts.create, (item) => item.command)) {
    const start = match(entry.command);
    if (start !== undefined) return run('create', start, entry.command, entry);
  }
  for (const command of byLength(facts.add, (item) => item)) {
    const start = match(command);
    if (start !== undefined) return run('add', start, command, undefined);
  }
  if (dynamic !== undefined) return unreadable(`${shown(line)}: ${expanded(dynamic.word, 'the subcommand ')}`);
  // Another command of the tool (uv sync, poetry run): what its options weaken, and a package manager it runs.
  const scan = managerScan(line, optionOverrides(tool, rest));
  merge(scan, laterCommand(rest, depth));
  return scan;
}

/**
 * Why cmd.exe may read an argument differently from the scanner: PowerShell hands the arguments of a batch file to
 * cmd.exe as a raw command line (environment.windows.batchArguments), npm's shims for package managers on Windows are
 * .cmd files that pass them on with %* (environment.windows.commandShims), and a .cmd file named outright runs so from
 * any shell. An argument with & | < > " or a line break may then run another command.
 */
function batchArgument(first: Word, executable: string, rest: readonly Word[], shell: Shell | undefined): string | undefined {
  if (shell === 'cmd') return undefined;
  const batch = values(environment.windows.batchArguments)[0];
  const shims = values(environment.windows.commandShims)[0];
  const named = batch?.extensions.some((extension) => first.text.toLowerCase().endsWith(extension)) === true;
  const shim = shell === 'powershell' && shims !== undefined && batch?.extensions.includes(shims.batchExtension) === true && commands().npmExecutables.has(executable);
  if (!named && !shim) return undefined;
  const word = rest.find((entry) => /[&|<>"\r\n]/u.test(entry.text));
  if (word === undefined) return undefined;
  return `"${shown(word.text)}" ${CMD_READS_AGAIN} when ${executable} runs as a batch file (${batch?.extensions.join(' or ') ?? '.cmd'})`;
}

function scanCommand(command: SimpleCommand, depth: number): CommandScan {
  const { installWords } = commands();
  let words = command.words;
  /** Aliases already put in place, which bash does not expand a second time (alias ls='ls -F'). */
  const replaced = new Set<string>();
  // Assignments, reserved words, aliases and wrappers such as sudo or env come before the command itself.
  for (;;) {
    const head = words[0];
    if (head === undefined) return NOTHING;
    // A command found further along other words starts with its executable (pipx run pip==25.0), not an assignment.
    if (ASSIGNMENT.test(head.text) && !(command.later === true && words === command.words)) {
      words = words.slice(1);
    } else if (!head.dynamic && KEYWORDS.has(head.text)) {
      words = words.slice(1);
    } else if (!head.dynamic && aliases.has(head.text) && !replaced.has(head.text)) {
      // Checked after wrappers too, as an alias whose value ends in a blank (alias s='sudo ') makes bash do.
      const value = aliases.get(head.text) as string;
      replaced.add(head.text);
      const own = aliasWords(value);
      if (own === undefined) return scanLine([value, ...words.slice(1).map(requoted)].join(' '), depth + 1);
      words = [...own, ...words.slice(1)];
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
  // A command line built at run time (eval "$CMD", sh -c "$X") cannot be known in advance. In PowerShell a variable
  // on its own is a value, not a command: only & or . would run it, and then its arguments decide.
  if (depth > 0 && command.shell !== 'powershell' && WHOLE_EXPANSION.test(first.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  // $SHELL -c '…', $(which bash) <<< '…', echo '…' | $SHELL: a shell named by an expansion runs a command line.
  if (first.dynamic && command.shell !== 'powershell' && commandLineGiven(words.slice(1), command)) {
    return unreadable(`${shown(line)}: ${expanded(first, 'the command ')} ${MAY_BE_SHELL}`);
  }
  const executable = first.dynamic ? basename(first.text) : executableOf(first.text);
  if (SHELLS.has(executable)) return scanShell(words, command, depth);
  if (!first.dynamic && POWERSHELLS.has(executable)) return scanPowerShell(words, command, depth, executable === 'powershell');
  if (!first.dynamic && CMD.has(executable)) return scanCmd(words, command, depth);
  if (!first.dynamic && SOURCES.has(executable)) return scanSource(words, command, depth) ?? scanInput(words, command, depth);
  if (!first.dynamic && executable === 'trap') return scanTrap(words, depth);
  if (!first.dynamic && executable === 'alias') return scanAlias(words, depth);
  if (!first.dynamic && EXPRESSION_RUNNERS.has(executable)) return scanInvokeExpression(words, command, depth);
  if (!first.dynamic && interpreter()?.executables.includes(executable) === true) return scanInterpreter(words, command, depth);
  const reader = first.dynamic ? undefined : PROGRAM_READERS.get(executable);
  if (reader !== undefined) return scanProgramReader(words, command, reader, depth);
  const rest = words.slice(1);
  if (!first.dynamic && configChange(executable, rest)) return { requests: [], unreadable: undefined, changes: `${shown(line)}: ${CONFIG_CHANGE}`, manager: true };
  const scan = scanPackageManager(command, first, executable, rest, line, depth);
  if (scan !== undefined) {
    const batch = batchArgument(first, executable, rest, command.shell);
    return batch === undefined ? scan : { ...scan, unreadable: scan.unreadable ?? `${shown(line)}: ${batch}` };
  }
  const subcommand = rest.find((word) => !isOption(word.text));
  if (first.dynamic && subcommand !== undefined && installWords.has(subcommand.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  // echo npm install lodash prints the words; it runs nothing.
  if (!first.dynamic && PRINTERS.has(executable)) return NOTHING;
  return laterCommand(rest, depth);
}

/**
 * Whether a command changes a package manager's configuration (npm config set, pnpm config delete, yarn config set,
 * pip config set, poetry config key value): its subcommand words, skipping options and their values, match a
 * command of configCommands that writes. A word the shell expands where a writing word may stand counts as one.
 */
function configChange(executable: string, rest: readonly Word[]): boolean {
  for (const tool of commands().tools) {
    for (const entry of tool.configCommands) {
      if (entry.command[0] !== executable) continue;
      const positional: Word[] = [];
      const options: string[] = [];
      for (let index = 0; index < rest.length; index++) {
        const word = rest[index] as Word;
        if (word.text === '--') {
          positional.push(...rest.slice(index + 1));
          break;
        }
        if (!isOption(word.text)) {
          positional.push(word);
          continue;
        }
        const option = readOption(rest, index, tool, (name) => tool.valueOptions.has(name));
        options.push(option.name);
        if (option.next !== undefined) index += 1;
      }
      const parts = entry.command.slice(1);
      if (!parts.every((part, index) => positional[index]?.text === part && positional[index]?.dynamic !== true)) continue;
      const after = positional.slice(parts.length);
      const word = after[0];
      if (entry.writes !== undefined && word !== undefined && (word.dynamic || entry.writes.includes(word.text))) return true;
      if (entry.operands !== undefined && (after.length >= entry.operands || after.some((part) => part.dynamic))) return true;
      if (entry.options?.some((option) => options.includes(option)) === true) return true;
    }
  }
  return false;
}

/** A command of a package manager: the packages it installs or runs; undefined when no package manager owns the executable. */
function scanPackageManager(command: SimpleCommand, first: Word, executable: string, rest: readonly Word[], line: string, depth: number): CommandScan | undefined {
  const { tools, add } = commands();
  for (const tool of tools) {
    const { facts } = tool;
    const run = facts.run.find((entry) => entry.command.length === 1 && entry.command[0] === executable);
    if (run !== undefined) {
      const context = contextOf(tool, run.command);
      return finish(tool, line, readArguments(rest, 'run', tool, run, context), depth, [], context);
    }
    const owns = [...facts.add, ...facts.run.map((entry) => entry.command), ...facts.create.map((entry) => entry.command)].some((entry) => entry[0] === executable);
    if (!owns) continue;
    if (tool.ecosystem !== 'npm') {
      const scan = scanPythonTool(tool, executable, rest, line, depth);
      if (scan !== undefined) return scan;
      continue;
    }
    // The subcommand is the first word that is not an option or an option's value.
    let index = 0;
    const before: SelectionEvent[] = [];
    const overridesBefore: Found[] = [];
    while (index < rest.length && isOption(rest[index]?.text ?? '')) {
      const word = rest[index] as Word;
      if (word.dynamic) return unreadable(`${shown(line)}: ${expanded(word)}`);
      const option = readOption(rest, index, tool, (name) => tool.valueOptions.has(name));
      if (option.next?.dynamic === true) return unreadable(`${shown(line)}: "${shown(`${word.text} ${option.next.text}`)}" is expanded by the shell`);
      const setting = registryOption(tool, option.name, option.value);
      if (setting !== undefined) return unreadable(`${shown(line)}: ${setting}`);
      const override = overrideOption(tool, option.name, option.value, option.next === undefined ? word.text : `${word.text} ${option.next.text}`);
      if (override !== undefined) overridesBefore.push(override);
      before.push(...optionEvents(contextOf(tool, undefined), option.name, option.value));
      index += option.next === undefined ? 1 : 2;
    }
    const subcommand = rest[index];
    if (subcommand === undefined) return managerScan(line, overridesBefore);
    if (subcommand.dynamic) return unreadable(`${shown(line)}: ${expanded(subcommand, 'the subcommand ')}`);
    const after = rest.slice(index + 1);
    const context = contextOf(tool, undefined);
    const find = (list: readonly DownloadCommand[]) => list.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    const workspace = facts.workspaceCommands?.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    if (workspace !== undefined) return scanCommand({ ...command, words: [first, ...after.slice(workspace.operands)] }, depth);
    const runEntry = find(facts.run);
    if (runEntry !== undefined) {
      const own = contextOf(tool, runEntry.command);
      return finish(tool, line, readArguments(after, 'run', tool, runEntry, own), depth, before, own, overridesBefore);
    }
    const createEntry = find(facts.create);
    if (createEntry !== undefined) return finish(tool, line, readArguments(after, 'create', tool, createEntry, context), depth, before, context, overridesBefore);
    if (add.has(subcommand.text)) return finish(tool, line, readArguments(after, 'add', tool, undefined, context), depth, before, context, overridesBefore);
    // A package manager's script run by its path (bun /usr/bin/npx …, bun ./npm-cli.js …) is that package manager.
    const manager = /[\\/]/u.test(subcommand.text) || SCRIPT_EXTENSIONS.test(subcommand.text) ? scriptManager(subcommand.text) : undefined;
    if (manager !== undefined) return scanCommand({ ...command, words: [{ text: manager, dynamic: false }, ...after] }, depth);
    // Another subcommand that ends in an add subcommand (yarn global add, yarn workspaces foreach -A add) adds too.
    const later = after.findIndex((word) => !word.dynamic && add.has(word.text));
    if (later !== -1) return finish(tool, line, readArguments(after.slice(later + 1), 'add', tool, undefined, context), depth, before, context, overridesBefore);
    // Any other command (npm ci, npm rebuild): what its options weaken.
    return managerScan(line, [...overridesBefore, ...optionOverrides(tool, after)]);
  }
  return undefined;
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

/** Package managers, shells and Invoke-Expression, which a PowerShell statement naming them may run. */
const RUNNER_NAMES = new Set(['corepack', ...SHELLS, ...POWERSHELLS, ...CMD, ...EXPRESSION_RUNNERS]);

/** The first package manager, shell or Invoke-Expression that a text names anywhere, also inside strings and paths. */
function namedRunner(text: string): string | undefined {
  const { executables } = commands();
  for (const piece of text.split(/[^A-Za-z0-9_.-]+/u)) {
    const name = executableOf(piece.replace(/^\.+|\.+$/gu, ''));
    if (name !== '' && (executables.has(name) || RUNNER_NAMES.has(name))) return name;
  }
  return undefined;
}

/**
 * A variable that may point a package manager at another registry, or change the version it picks, named anywhere in
 * a PowerShell line outside the $env:NAME = value assignments that were read (Set-Item env:…, ${env:…} = …,
 * [Environment]::SetEnvironmentVariable(…)).
 */
function namedSetting(text: string): string | undefined {
  const { configVariables, registryVariables, selectionVariables } = commands();
  for (const piece of text.split(/[^A-Za-z0-9_]+/u)) {
    const lower = piece.toLowerCase();
    if (configVariables.has(lower) || registryVariables.has(lower)) return anotherRegistry(piece);
    if (selectionVariables.has(lower)) return `${piece} ${SET_UNREAD}`;
  }
  return undefined;
}

/** A variable that weakens the delay or the rule on install scripts, named in a PowerShell line outside what was read. */
function namedOverride(text: string): string | undefined {
  const { overrideVariables } = commands();
  const piece = text.split(/[^A-Za-z0-9_]+/u).find((part) => overrideVariables.has(part.toLowerCase()));
  return piece === undefined ? undefined : `${piece} ${OVERRIDE_UNREAD}`;
}

/** Variables set anywhere on the line that weaken the delay or the rule on install scripts (installOverrides). */
function overrideAssignments(items: readonly Item[], line: string): Override[] {
  const { overrideVariables } = commands();
  const found: Override[] = [];
  for (const item of items) {
    if (item.kind !== 'word') continue;
    const name = ASSIGNMENT.exec(item.word.text)?.[1];
    if (name === undefined) continue;
    const value = item.word.text.slice(name.length + 1);
    for (const { tool, entry } of overrideVariables.get(name.toLowerCase()) ?? []) {
      const base = { tool, command: line, written: item.word.text, weakens: entry.weakens };
      if (item.word.dynamic) found.push({ ...base, expanded: true });
      else if (weakensWith(entry.values, value)) found.push({ ...base, ...(entry.values === 'delay' ? { delay: value } : {}) });
    }
  }
  return found;
}

interface LineReading {
  items: Item[];
  /** Command lines inside the line, read with the shell given. */
  nested: { line: string; shell: Shell }[];
  /** Why part of a PowerShell line cannot be read, found before its commands are scanned. */
  unreadable?: string;
  /** PowerShell: the line without what was read as an assignment, for variables set in other ways. */
  named?: string;
}

function readLine(line: string, shell: Shell): LineReading {
  if (shell === 'cmd') return { items: readCmd(line), nested: [] };
  if (shell === 'posix') {
    const reading = read(line, 0, undefined, 0);
    return { items: reading.items, nested: reading.substitutions.map((inner) => ({ line: inner, shell })) };
  }
  const reading = readPowerShell(line);
  let doubt: string | undefined;
  for (const statement of reading.statements) {
    const runner = statement.constructs.length === 0 ? undefined : namedRunner(statement.text);
    if (runner !== undefined) doubt ??= `${shown(statement.text.trim())}: depcurfew does not read ${statement.constructs[0] as string} ${POWERSHELL_UNREAD} ${runner}`;
  }
  return { items: reading.items, nested: reading.nested.map((inner) => ({ line: inner, shell })), named: reading.named, ...(doubt === undefined ? {} : { unreadable: doubt }) };
}

function scanLine(line: string, depth: number, shell: Shell = 'posix'): CommandScan {
  if (depth > MAX_DEPTH) {
    // Brackets nest deeply in ordinary PowerShell; there only a line that names a package manager matters.
    if (shell === 'powershell' && namedRunner(line) === undefined) return NOTHING;
    return unreadable(`${shown(line)}: command lines are nested more than ${MAX_DEPTH} levels deep`);
  }
  let reading: LineReading;
  try {
    reading = readLine(line, shell);
  } catch (error) {
    if (error instanceof Unreadable || error instanceof NestingTooDeep) return unreadable(`${shown(line)}: ${error.message}`);
    throw error;
  }
  const scan: CommandScan = { requests: [], unreadable: reading.unreadable };
  for (const command of simpleCommands(reading.items, shell)) merge(scan, scanCommand(command, depth));
  for (const inner of reading.nested) merge(scan, scanLine(inner.line, depth + 1, inner.shell));
  if (scan.requests.length > 0) {
    const setting = registryAssignment(reading.items) ?? (reading.named === undefined ? undefined : namedSetting(reading.named));
    if (setting !== undefined) scan.unreadable ??= `${shown(line)}: ${setting}`;
    const variables = selectionAssignments(reading.items);
    if ('unreadable' in variables) scan.unreadable ??= `${shown(line)}: ${variables.unreadable}`;
    // Variables set on this line count before those of the lines inside it, which come in first.
    else for (const request of scan.requests) PENDING.get(request)?.variables.unshift(...variables.set);
  }
  if (scan.requests.length > 0 || scan.manager === true) {
    // npm_config_ignore_scripts=false npm ci weakens that install as much as npm i lodash.
    const found = overrideAssignments(reading.items, shown(line));
    if (found.length > 0) scan.overrides = [...(scan.overrides ?? []), ...found];
    const named = reading.named === undefined ? undefined : namedOverride(reading.named);
    if (named !== undefined) scan.unreadable ??= `${shown(line)}: ${named}`;
  }
  return scan;
}

/** Variables set anywhere on the line that may change the version a package manager picks or whether it builds from source. */
function selectionAssignments(items: readonly Item[]): { set: { name: string; value: string }[] } | { unreadable: string } {
  const { selectionVariables } = commands();
  const set: { name: string; value: string }[] = [];
  for (const item of items) {
    if (item.kind !== 'word') continue;
    const name = ASSIGNMENT.exec(item.word.text)?.[1];
    if (name === undefined || !selectionVariables.has(name.toLowerCase())) continue;
    if (item.word.dynamic) return { unreadable: `${name} ${VERSION_SETTING}` };
    set.push({ name, value: item.word.text.slice(name.length + 1) });
  }
  return { set };
}

/** The request with what its command line settles about the version and the build. */
function settle(request: InstallRequest): InstallRequest {
  const pending = PENDING.get(request);
  if (pending === undefined) return request;
  const events = [...pending.variables.flatMap(({ name, value }) => variableEvents(pending.switches, pending.tagVariable, name, value)), ...pending.events];
  const result: InstallRequest = { tool: request.tool, command: request.command, spec: request.spec };
  const tag = events.findLast((event) => event.setting === 'tag');
  if (tag !== undefined && tag.setting === 'tag') result.tag = tag.value;
  if (pending.switches !== undefined) {
    const name = request.spec.startsWith(PYPI_PREFIX) ? parsePythonSpec(request.spec.slice(PYPI_PREFIX.length))?.name : undefined;
    const prereleases = settled(events, 'prereleases', name);
    if (prereleases !== undefined) result.prereleases = prereleases ? 'allow' : 'deny';
    const build = settled(events, 'buildFromSource', name);
    if (build !== undefined) result.buildFromSource = build;
  }
  return result;
}

export interface ScanOptions {
  /** The shell that runs the line: a POSIX shell (the default; also Git Bash) or PowerShell. */
  shell?: 'posix' | 'powershell';
}

/** The packages a command line installs or downloads to run with npm, pnpm, Yarn, Bun, Deno, pip, uv, Poetry, PDM, Pipenv or pipx. */
export function scanCommandLine(line: string, options: ScanOptions = {}): CommandScan {
  const previous = aliases;
  aliases = new Map();
  try {
    const scan = scanLine(line, 0, options.shell ?? 'posix');
    // A change of the configuration matters to the packages installed next to it (npm config set registry … && npm i x).
    const unreadable = scan.unreadable ?? (scan.requests.length > 0 ? scan.changes : undefined);
    return { requests: scan.requests.map(settle), unreadable, ...(scan.overrides === undefined ? {} : { overrides: scan.overrides }) };
  } finally {
    aliases = previous;
  }
}

/**
 * Why the options and variables of a command (scanCommandLine's overrides) weaken one of the policies, for the hook:
 * a release-age delay shorter than the longest cooldown, or that cannot be compared with it, and install scripts
 * turned on where a policy restricts them; undefined when none does.
 */
export function overrideDoubt(overrides: readonly Override[] | undefined, policies: readonly ResolvedPolicy[]): string | undefined {
  const required = Math.max(0, ...policies.map((policy) => policy.cooldown?.minimum.minutes ?? 0));
  // A deny list counts only with the default deny (validation), so the default decides whether scripts are restricted.
  const scripts = policies.some((policy) => policy.installScripts?.default === 'deny');
  for (const override of overrides ?? []) {
    const where = `${shown(override.command)}: ${override.written}`;
    if (override.weakens === 'scripts') {
      if (!scripts) continue;
      if (override.expanded === true) return `${where} is set to a value the shell expands, which may turn on dependency install scripts that depcurfew.json restricts, and may weaken ${WEAKENS}`;
      return `${where} lets dependency install scripts run that depcurfew.json restricts, and weakens ${WEAKENS}`;
    }
    if (required <= 0) continue;
    const policy = formatMinutes(required);
    if (override.expanded === true) return `${where} is set to a value the shell expands, so its release-age delay cannot be compared with the ${policy} in depcurfew.json, and may weaken ${WEAKENS}`;
    if (override.delay === undefined) return `${where} changes the release-age delay of ${policy} that depcurfew.json requires, and weakens ${WEAKENS}`;
    const tool = knowledgeBase.find((entry) => entry.id === override.tool);
    const delay = tool === undefined ? undefined : delayMinutes(tool, override.delay, undefined);
    if (delay?.ok === true && delay.minutes >= required) continue;
    if (delay?.ok === true) return `${where} sets the release-age delay to ${formatMinutes(delay.minutes)}, shorter than the ${policy} in depcurfew.json, and weakens ${WEAKENS}`;
    return `${where} sets the release-age delay to a value depcurfew does not compare with the ${policy} in depcurfew.json (a date, false or another form), and may weaken ${WEAKENS}`;
  }
  return undefined;
}
