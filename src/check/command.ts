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
import { values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type {
  CommandLineKnowledge,
  CommandLineParsing,
  DownloadCommand,
  Ecosystem,
  NpmVersionSelectionKnowledge,
  PythonInterpreterKnowledge,
  PythonSelectionKnowledge,
  RegistryOverridesKnowledge,
  SelectionSwitches,
  ToolId,
} from '../knowledge/types.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import { PYPI_PREFIX } from '../policy/package-pattern.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { parsePythonSpec } from './python-spec.ts';

interface Word {
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

type Item =
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

interface SimpleCommand {
  words: Word[];
  /** Bodies of its here-documents and here-strings, which become its input. */
  input: string[];
  /** Its input comes from a word the shell expands. */
  redirected: boolean;
  /** Found further along another command's words (which bash), so it reads no input of its own. */
  later?: boolean;
  /** Its standard input comes from a pipe, or from a file or command named after <. */
  stdin?: 'pipe' | 'file';
}

function simpleCommands(items: readonly Item[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], input: [], redirected: false };
  let next: 'word' | 'skip' | 'source' | 'input' = 'word';
  for (const item of items) {
    if (item.kind === 'separator') {
      if (current.words.length > 0) commands.push(current);
      current = item.pipe === true ? { words: [], input: [], redirected: false, stdin: 'pipe' } : { words: [], input: [], redirected: false };
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
}

interface Commands {
  tools: ToolCommands[];
  /** Subcommands that add packages with any npm package manager; their arguments are checked for every one of them. */
  add: ReadonlySet<string>;
  /** Executables of every package manager command. */
  executables: ReadonlySet<string>;
  /** Last words of every install, run and create command, to spot them behind an executable the shell expands. */
  installWords: ReadonlySet<string>;
  /** Commands whose arguments may run a package manager: package manager executables, shells, wrappers and Python. */
  runners: ReadonlySet<string>;
  /** Environment variables of any package manager, lowercased, whose value is a registry URL, with that ecosystem's public registry. */
  registryVariables: ReadonlyMap<string, string>;
  configVariables: ReadonlySet<string>;
  /** Variables, lowercased, that change the version a package manager picks or whether it builds from source. */
  selectionVariables: ReadonlySet<string>;
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
        const parsing: CommandLineParsing = { ...facts.parsing, ...factOf<CommandLineParsing>(tool, sibling(key, 'parsing')) };
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
          },
        ];
      }),
  );
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
    installWords: new Set(all.map((entry) => entry.at(-1) ?? '')),
    runners: new Set([
      ...executables,
      ...SHELLS,
      ...POWERSHELLS,
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

function basename(text: string): string {
  return (text.split(/[/\\]/u).at(-1) ?? text).replace(/\.(?:cmd|exe|ps1)$/iu, '');
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

type Outcome = { specs: string[]; lines: string[]; rest: Word[]; events: SelectionEvent[] } | { unreadable: string };

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
  if (parsing.anyDashes === true) {
    const option = noptOption(tool, name.replace(/^-+/u, ''));
    if (option.fixed) return { name: option.name, value: attached ?? option.value, next: undefined };
    name = option.name;
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
      if (mode === 'add' && tool.facts.fileOptions?.includes(name) === true) return { specs: [], lines, rest: [], events };
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
      return { specs, lines, rest: [], events };
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
        return { specs, lines, rest: words.slice(index), events };
      }
      if (entry?.scriptSuffixes?.some((suffix) => word.text.toLowerCase().endsWith(suffix)) === true) {
        return url ? { unreadable: scriptDownload(word.text) } : { specs, lines, rest: [], events };
      }
      if (!named && isInterpreter(word.text, tool.facts.interpreterNames)) return { specs, lines, rest: words.slice(index), events };
      if (!named) specs.push(entry?.binaryPath === true ? withoutBinary(word.text) : word.text);
    }
    if (mode === 'create') specs.push(/^[.~/\\]|^[^@][^/]*\//u.test(word.text) ? word.text : createPackage(word.text, tool.facts.createNames));
    return { specs, lines, rest: words.slice(index), events };
  }
  return { specs, lines, rest: [], events };
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

function finish(tool: ToolCommands, line: string, outcome: Outcome, depth: number, before: readonly SelectionEvent[] = [], context?: CommandContext): CommandScan {
  if ('unreadable' in outcome) return unreadable(`${shown(line)}: ${outcome.unreadable}`);
  // Python specs carry the prefix of the policy, so that check looks them up on the index.
  const prefix = tool.ecosystem === 'pypi' ? PYPI_PREFIX : '';
  const events = [...before, ...outcome.events];
  const requests = outcome.specs.map((spec): InstallRequest => {
    const request: InstallRequest = { tool: tool.tool, command: line, spec: `${prefix}${spec}` };
    PENDING.set(request, { events, variables: [], switches: context?.switches, tagVariable: tool.versionSelection?.tagVariable });
    return request;
  });
  const scan: CommandScan = { requests, unreadable: undefined };
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
function scanInput(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  if (command.later === true) return NOTHING;
  if (command.input.length === 0 || command.redirected) return unreadable(`${shown(joined(words))}: ${FROM_INPUT}`);
  const scan: CommandScan = { requests: [], unreadable: undefined };
  for (const input of command.input) merge(scan, scanLine(input, depth + 1));
  return scan;
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

/** source file and . file run a file in the current shell: a local script is not read, but standard input and <(…) are. */
function scanSource(words: readonly Word[], command: SimpleCommand): CommandScan | undefined {
  const file = words[1];
  if (file === undefined) return NOTHING;
  if (isProcessSubstitution(file)) return unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`);
  return file.dynamic || !STDIN_FILES.has(file.text) ? NOTHING : undefined;
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
      if (first.input === true) return unreadable(`${shown(joined(words))}: ${expanded(first)}`);
      return scanLine(first.text, depth + 1);
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
    return STDIN_FILES.has(first.text) ? scanInput(words, command, depth) : NOTHING;
  }
  if (first.text === '-') return scanInput(words, command, depth);
  const filled = rest.find((word) => word.input === true);
  return filled === undefined ? scanLine(joined(rest), depth + 1) : unreadable(`${shown(joined(words))}: ${expanded(filled)}`);
}

/** Invoke-Expression (iex) runs the code it is given, or the code piped into it: iex (irm …) and irm … | iex download and run a script. */
function scanInvokeExpression(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  const rest = words.slice(1).filter((word) => !/^-command$/iu.test(word.text));
  const code = rest[0];
  if (command.later === true) return NOTHING;
  if (code === undefined || command.stdin === 'pipe') return unreadable(`${shown(joined(words))}: ${FROM_INPUT}`);
  if (code.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(code, 'the code ')}`);
  return scanLine(code.text, depth + 1);
}

/** What a wrapper runs: the remaining words, or a command line to read. */
function unwrap(words: readonly Word[], wrapper: Wrapper): { words: Word[] } | { line: string } | { unreadable: string } {
  if (wrapper.anywhere === true) return unwrapAnywhere(words, wrapper);
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
    if (wrapper.lineOptions?.includes(name)) return lineOf(attached, words[index + 1]);
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
function scanProgramReader(words: readonly Word[], command: SimpleCommand, reader: ProgramReader): CommandScan {
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (!isOption(word.text)) return scanProgram(words, command, word);
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
    if (!isOption(word.text)) return scanProgram(words, command, word);
    if (word.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(word)}`);
    // A command string (-c) is Python code, which depcurfew does not read, unless another command prints it.
    if (word.text.startsWith(facts.commandOption)) {
      const code = word.text.length > facts.commandOption.length ? word : words[index + 1];
      return printedCode(code) ? unreadable(`${shown(joined(words))}: ${FROM_PRINTED_CODE}`) : NOTHING;
    }
    if (word.text.startsWith(facts.moduleOption)) {
      const attached = word.text.slice(facts.moduleOption.length);
      const module = attached === '' ? words[index + 1] : { text: attached, dynamic: false };
      if (module === undefined) return NOTHING;
      if (module.dynamic) return unreadable(`${shown(joined(words))}: ${expanded(module, 'the module ')}`);
      if (!commands().executables.has(module.text)) return NOTHING;
      return scanCommand({ ...command, words: [{ text: module.text, dynamic: false }, ...words.slice(index + (attached === '' ? 2 : 1))] }, depth);
    }
    if (facts.valueOptions.includes(word.text)) index += 1;
  }
  return scanProgram(words, command, undefined);
}

/** The subcommand words after the executable, skipping options and their values, with where each one stands. */
function commandWords(rest: readonly Word[], tool: ToolCommands, line: string): { words: { word: Word; index: number }[]; events: SelectionEvent[] } | { unreadable: string } {
  const found: { word: Word; index: number }[] = [];
  const events: SelectionEvent[] = [];
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
      events.push(...optionEvents(context, option.name, option.value));
      if (option.next !== undefined) index += 1;
      continue;
    }
    found.push({ word, index });
  }
  return { words: found, events };
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
    return finish(tool, line, readArguments(rest.slice(start), mode, tool, entry, context), depth, read.events, context);
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
  return undefined;
}

function scanCommand(command: SimpleCommand, depth: number): CommandScan {
  const { tools, add, installWords } = commands();
  let words = command.words;
  // Assignments, reserved words and wrappers such as sudo or env come before the command itself.
  for (;;) {
    const head = words[0];
    if (head === undefined) return NOTHING;
    // A command found further along other words starts with its executable (pipx run pip==25.0), not an assignment.
    if (ASSIGNMENT.test(head.text) && !(command.later === true && words === command.words)) {
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
  const executable = first.dynamic ? basename(first.text) : executableOf(first.text);
  if (SHELLS.has(executable)) return scanShell(words, command, depth);
  if (!first.dynamic && POWERSHELLS.has(executable.toLowerCase())) return scanPowerShell(words, command, depth, executable.toLowerCase() === 'powershell');
  if (!first.dynamic && SOURCES.has(executable)) return scanSource(words, command) ?? scanInput(words, command, depth);
  if (!first.dynamic && EXPRESSION_RUNNERS.has(executable.toLowerCase())) return scanInvokeExpression(words, command, depth);
  if (!first.dynamic && interpreter()?.executables.includes(executable) === true) return scanInterpreter(words, command, depth);
  const reader = first.dynamic ? undefined : PROGRAM_READERS.get(executable);
  if (reader !== undefined) return scanProgramReader(words, command, reader);
  const rest = words.slice(1);
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
    while (index < rest.length && isOption(rest[index]?.text ?? '')) {
      const word = rest[index] as Word;
      if (word.dynamic) return unreadable(`${shown(line)}: ${expanded(word)}`);
      const option = readOption(rest, index, tool, (name) => tool.valueOptions.has(name));
      if (option.next?.dynamic === true) return unreadable(`${shown(line)}: "${shown(`${word.text} ${option.next.text}`)}" is expanded by the shell`);
      const setting = registryOption(tool, option.name, option.value);
      if (setting !== undefined) return unreadable(`${shown(line)}: ${setting}`);
      before.push(...optionEvents(contextOf(tool, undefined), option.name, option.value));
      index += option.next === undefined ? 1 : 2;
    }
    const subcommand = rest[index];
    if (subcommand === undefined) return NOTHING;
    if (subcommand.dynamic) return unreadable(`${shown(line)}: ${expanded(subcommand, 'the subcommand ')}`);
    const after = rest.slice(index + 1);
    const context = contextOf(tool, undefined);
    const find = (list: readonly DownloadCommand[]) => list.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    const workspace = facts.workspaceCommands?.find((entry) => entry.command[0] === executable && entry.command[1] === subcommand.text);
    if (workspace !== undefined) return scanCommand({ ...command, words: [first, ...after.slice(workspace.operands)] }, depth);
    const runEntry = find(facts.run);
    if (runEntry !== undefined) {
      const own = contextOf(tool, runEntry.command);
      return finish(tool, line, readArguments(after, 'run', tool, runEntry, own), depth, before, own);
    }
    const createEntry = find(facts.create);
    if (createEntry !== undefined) return finish(tool, line, readArguments(after, 'create', tool, createEntry, context), depth, before, context);
    if (add.has(subcommand.text)) return finish(tool, line, readArguments(after, 'add', tool, undefined, context), depth, before, context);
    // Another subcommand that ends in an add subcommand (yarn global add, yarn workspaces foreach -A add) adds too.
    const later = after.findIndex((word) => !word.dynamic && add.has(word.text));
    if (later !== -1) return finish(tool, line, readArguments(after.slice(later + 1), 'add', tool, undefined, context), depth, before, context);
    return NOTHING;
  }
  const subcommand = rest.find((word) => !isOption(word.text));
  if (first.dynamic && subcommand !== undefined && installWords.has(subcommand.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  // echo npm install lodash prints the words; it runs nothing.
  if (!first.dynamic && PRINTERS.has(executable)) return NOTHING;
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
    const variables = selectionAssignments(reading.items);
    if ('unreadable' in variables) scan.unreadable ??= `${shown(line)}: ${variables.unreadable}`;
    // Variables set on this line count before those of the lines inside it, which come in first.
    else for (const request of scan.requests) PENDING.get(request)?.variables.unshift(...variables.set);
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

/** The packages a command line installs or downloads to run with npm, pnpm, Yarn, Bun, Deno, pip, uv, Poetry, PDM, Pipenv or pipx. */
export function scanCommandLine(line: string): CommandScan {
  const scan = scanLine(line, 0);
  return { requests: scan.requests.map(settle), unreadable: scan.unreadable };
}
