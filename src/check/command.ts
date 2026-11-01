// Finds the packages a shell command line installs or downloads to run, for the install guard. It reads the line the
// way a POSIX shell splits it (quotes, escapes, &&, ||, ;, |, subshells, redirections, here-documents, reserved words)
// without running anything, and follows the command lines inside it: command substitutions, sh -c, eval, npx -c,
// a shell fed by a here-document and wrappers such as sudo, env, timeout or xargs. $'...' is decoded as bash decodes
// it. Words the shell would expand ($VAR, $(...), backticks, globs, {a,b}) cannot be known in advance; when such a word
// is part of an install command, the result says the command cannot be read, so the caller asks a person instead of
// guessing. So does an install
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
  CommandNamesKnowledge,
  ConfigCommand,
  DirectoryOption,
  DirectoryOptionsKnowledge,
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
import {
  builtName,
  createdDirectories,
  directoryChange,
  DirectoryWalk,
  dynamicAssignment,
  HERE,
  isHere,
  shellVariables,
  within,
  type CommandBounds,
  type CommandDirectory,
  type Move,
  type ShellVariables,
} from './directories.ts';
import { parsePythonSpec } from './python-spec.ts';
import { NestingTooDeep, readCmd, readPowerShell } from './windows-shells.ts';

export interface Word {
  text: string;
  /** The shell would expand part of it. */
  dynamic: boolean;
  /**
   * What the shell makes of it may be several words or any text: an expansion outside double quotes, which the shell
   * splits, brace expansion, or $'…' that depcurfew cannot decode (decision D-119).
   */
  splits?: true;
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
  | { kind: 'separator'; pipe?: boolean; operator?: string }
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
  /** Where the install runs, when the command changes directory before it or moves it with an option (decision D-118). */
  directory?: CommandDirectory;
}

export type { CommandDirectory, KnownDirectory } from './directories.ts';

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
  /** Where its command runs, when that is not where the command line starts (decision D-118). */
  directory?: CommandDirectory;
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
  /** How the command changes the directory of the shell that runs it (cd, pushd, eval 'cd …'), in order. */
  moves?: Move[];
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
  /**
   * Command lines the shell runs to expand words: $(...), backticks, <(...) and >(...), also inside ${...}; `at` is the
   * index in `items` of the word they are in (of the here-document, for its body), so they run where that command does.
   */
  substitutions: { line: string; at: number }[];
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

/** The escapes of $'…' that stand for one character (bash's ANSI-C quoting). */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/**
 * The text of $'…' (`body`, between the quotes) as bash decodes it (decision D-119): \a \b \e \E \f \n \r \t \v \\ \'
 * \" \?, \nnn (one to three octal digits), \xHH (one or two hex digits), \uHHHH and \UHHHHHHHH (up to four and eight),
 * \cx (control-x, \c? is DEL, \c\\ is control-backslash); another escape keeps its backslash, and a NUL ends the text.
 * Checked on GNU bash 5.2. undefined for what depcurfew cannot tell: a byte that is not ASCII (its character depends on
 * the locale) or \c before something else.
 */
function ansiC(body: string): string | undefined {
  let text = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char !== '\\') {
      text += char;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) return undefined;
    index += 1;
    if (Object.hasOwn(ANSI_C_ESCAPES, next)) {
      text += ANSI_C_ESCAPES[next];
      continue;
    }
    let code: number | undefined;
    const digits = (pattern: RegExp, from: number, most: number, base: number): number | undefined => {
      const found = pattern.exec(body.slice(from, from + most))?.[0] ?? '';
      if (found === '') return undefined;
      index = from + found.length - 1;
      return Number.parseInt(found, base);
    };
    if (/[0-7]/u.test(next)) code = digits(/^[0-7]+/u, index, 3, 8);
    else if (next === 'x') code = digits(/^[0-9A-Fa-f]+/u, index + 1, 2, 16);
    else if (next === 'u') code = digits(/^[0-9A-Fa-f]+/u, index + 1, 4, 16);
    else if (next === 'U') code = digits(/^[0-9A-Fa-f]+/u, index + 1, 8, 16);
    else if (next === 'c') {
      const control = body[index + 1];
      if (control === undefined || !/[\x3f-\x7e]/u.test(control) || (control === '\\' && body[index + 2] !== '\\')) return undefined;
      index += control === '\\' ? 2 : 1;
      code = control === '?' ? 0x7f : control.toUpperCase().charCodeAt(0) & 0x1f;
    } else {
      text += `\\${next}`;
      continue;
    }
    // \x, \u and \U without a digit stay as they are.
    if (code === undefined) {
      text += `\\${next}`;
      continue;
    }
    if (code === 0) return text;
    // Unicode escapes give the character; other bytes above ASCII depend on the locale.
    const unicode = next === 'u' || next === 'U';
    if (code > 0x7f && (!unicode || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) return undefined;
    text += String.fromCodePoint(code);
  }
  return text;
}

/** A text for messages, cut short when it is long. */
function shownText(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Whether the inside of ${…} may assign a variable whose name the shell builds (decision D-123): a subscript or a
 * substring offset with an expansion (both are arithmetic, ${a[$X]}, ${s:$X}), or ${!X:=…}, which assigns the variable
 * that X names.
 */
function assignsBuiltName(inside: string): boolean {
  if (/^![A-Za-z_][A-Za-z0-9_]*:?=/u.test(inside)) return true;
  if (!/[$`]/u.test(inside)) return false;
  return /^[#!]?[A-Za-z_][A-Za-z0-9_]*\[[^\]]*[$`]/u.test(inside) || /^[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*])(?:\[[^\]]*\])?:(?![-=+?])/u.test(inside);
}

/** An assignment to an element of an array whose subscript the shell expands (a[$X]=1), which is arithmetic (decision D-123). */
const BUILT_SUBSCRIPT = /^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*[$`]/u;

/**
 * Splits a command line into words and separators from `start`, as a POSIX shell does before expanding anything. With
 * `stop`, it reads the inside of $(...) or ${...} and ends at the bracket that closes it.
 */
function read(line: string, start: number, stop: ')' | '}' | undefined, level: number): Reading {
  if (level > MAX_NESTING) throw new Unreadable(`brackets are nested more than ${MAX_NESTING} levels deep`);
  const items: Item[] = [];
  const substitutions: { line: string; at: number }[] = [];
  const pending: { document: HereDocument; delimiter: string; strip: boolean; expand: boolean; at: number }[] = [];
  let text = '';
  let bare = '';
  let started = false;
  let dynamic = false;
  /** The word may become several words or any text (Word.splits); `inQuotes`: inside "...", where nothing is split. */
  let splits = false;
  let inQuotes = false;
  let quoted = false;
  let depth = 0;
  /** Open case statements, whose patterns end with a ) that does not close $(...). */
  let cases = 0;
  const finish = () => {
    if (started) {
      // A glob after name@ (lodash@4.*, @demo/api@workspace:*) would have to match a file named like a package with
      // its version; only globs in the rest count.
      const versionAt = bare.indexOf('@', bare.startsWith('@') ? 1 : 0);
      const braces = BRACES.test(bare);
      const expands = dynamic || braces || GLOB.test(versionAt > 0 ? bare.slice(0, versionAt) : bare);
      items.push({ kind: 'word', word: { text, dynamic: expands, ...(splits || braces ? { splits: true as const } : {}) } });
      if (!quoted && !expands && text === 'case') cases += 1;
      if (!quoted && !expands && text === 'esac' && cases > 0) cases -= 1;
    }
    text = '';
    bare = '';
    started = false;
    dynamic = false;
    splits = false;
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
    if (close === '}') {
      substitutions.push(...inner.substitutions.map((entry) => ({ line: entry.line, at: items.length })));
      if (assignsBuiltName(line.slice(inside, inner.end - 1))) noteBuiltName(builtName(shownText(line.slice(from, inner.end))));
    } else substitutions.push({ line: line.slice(inside, inner.end - 1), at: items.length });
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
    // Arithmetic evaluates what an expansion gives, which may assign any variable: (( $X )) with X=OLDPWD=1 (D-123).
    if (/[$`]/u.test(inside)) noteBuiltName(builtName(shownText(line.slice(from, end + 1))));
    substitutions.push(...[...bodySubstitutions(inside, level), inside].map((entry) => ({ line: entry, at: items.length })));
    dynamic = true;
    started = true;
    return end + 1;
  };
  const backtick = (from: number): number => {
    dynamic = true;
    started = true;
    if (!inQuotes) splits = true;
    let end = from + 1;
    while (end < line.length && line[end] !== '`') end += line[end] === '\\' ? 2 : 1;
    substitutions.push({ line: line.slice(from + 1, Math.min(end, line.length)).replaceAll(/\\([`\\$])/gu, '$1'), at: items.length });
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
    if (!/[({A-Za-z_0-9@*#?$!-]/u.test(next)) return undefined;
    // Outside double quotes the shell splits what an expansion gives into words.
    if (!inQuotes) splits = true;
    if (next === '(') return nested(from, from + 2, ')');
    if (next === '{') return nested(from, from + 2, '}');
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
      if (entry.expand) substitutions.push(...bodySubstitutions(entry.document.body, level).map((found) => ({ line: found, at: entry.at })));
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
      // ANSI-C quoting: the text with its escapes decoded as bash decodes them (decision D-119). What depcurfew cannot
      // decode, or a $' that is not closed, may be any text.
      started = true;
      quoted = true;
      let end = index + 2;
      while (end < line.length && line[end] !== "'") end += line[end] === '\\' ? 2 : 1;
      const decoded = end < line.length ? ansiC(line.slice(index + 2, end)) : undefined;
      if (decoded === undefined) {
        dynamic = true;
        splits = true;
        text += line.slice(index, Math.min(end + 1, line.length));
      } else {
        text += decoded;
      }
      index = end + 1;
      continue;
    }
    if (char === '$' && line[index + 1] === '"') {
      // $"..." is translated with the message catalog of TEXTDOMAIN; without one it is "...". A command line that
      // names TEXTDOMAIN may bring a catalog, so the text may be any text.
      if (translated) {
        let end = index + 2;
        while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1;
        dynamic = true;
        splits = true;
        started = true;
        text += line.slice(index, Math.min(end + 1, line.length));
        index = end + 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      started = true;
      quoted = true;
      inQuotes = true;
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
      inQuotes = false;
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
      items.push({ kind: 'separator', operator: '\n' });
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
      pending.push({ document, delimiter: found.word, strip, expand: !found.quoted, at: items.length - 1 });
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
      items.push({ kind: 'separator', pipe: separator === '|' || separator === '|&', operator: separator });
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
  /** It redirects its output to a file (not /dev/null or another descriptor). */
  writes?: boolean;
  /** The operators around it, and the items of its line it is made of (from, up to to): for the directory it runs in. */
  bounds?: CommandBounds;
  from?: number;
  to?: number;
}

function simpleCommands(items: readonly Item[], shell: Shell = 'posix'): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], input: [], redirected: false, shell };
  let next: 'word' | 'skip' | 'source' | 'input' = 'word';
  /** The operators since the last command, and the item the current one starts at. */
  let operators: string[] = [];
  let start = 0;
  const end = (after: string | undefined, to: number) => {
    if (current.words.length === 0) return;
    commands.push({ ...current, bounds: { before: operators, after }, from: start, to });
    operators = [];
  };
  for (const [index, item] of items.entries()) {
    if (item.kind === 'separator') {
      const operator = item.operator ?? (item.pipe === true ? '|' : ';');
      end(operator, index);
      operators.push(operator);
      start = index + 1;
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
      // > file writes a file; >/dev/null, 2>&1 and >&- do not (decision D-123).
      if (next === 'skip' && (item.word.dynamic || !(item.word.text === '/dev/null' || /^(?:\d+|-)$/u.test(item.word.text)))) current.writes = true;
      next = 'word';
    } else if (next === 'input') {
      current.input.push(item.word.text);
      if (item.word.dynamic) current.redirected = true;
      next = 'word';
    } else {
      current.words.push(item.word);
    }
  }
  end(undefined, items.length);
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
  /** How the tool resolves aliases and abbreviations of its command names (npm). */
  commandNames: CommandNamesKnowledge | undefined;
  /** Options and variables that make one command run in another directory, or find its project there. */
  directories: DirectoryOptionsKnowledge | undefined;
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
  /** Variables, lowercased, that make a package manager's command run in another directory (directoryOptions). */
  directoryVariables: ReadonlySet<string>;
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
            commandNames: factOf<CommandNamesKnowledge>(tool, sibling(key, 'commandNames')),
            directories: factOf<DirectoryOptionsKnowledge>(tool, sibling(key, 'directoryOptions')),
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
    directoryVariables: new Set(tools.flatMap((tool) => (tool.directories?.variables ?? []).map((entry) => entry.name.toLowerCase()))),
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
  /** Options whose value is the directory the command runs in (env -C, sudo -D; decision D-119). */
  chdir?: readonly string[];
}

/** What a wrapper runs: the remaining words or a command line, and the directory it runs them in. */
type Unwrapped = ({ words: Word[] } | { line: string }) & { directory?: CommandDirectory; assigned?: Word[] };

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
      // sudo -D and --chdir: "Run the command in the specified directory instead of the current working directory".
      chdir: ['-D', '--chdir'],
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
  // GNU env -C DIR, --chdir=DIR: "change working directory to DIR" before it runs the command (src/env.c of coreutils).
  ['env', { values: ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'], split: ['-S', '--split-string'], chdir: ['-C', '--chdir'] }],
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
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const name = (slash === -1 ? text : text.slice(slash + 1)).toLowerCase();
  return name.length > 4 && name[name.length - 4] === '.' && /\.(?:cmd|exe|ps1|bat)$/u.test(name) ? name.slice(0, -4) : name;
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
const MAY_BE_ANY = 'and may stand for any command, also an install';
/** The command line expands to more than the scanner reads (decision D-119). */
const TOO_MUCH = 'depcurfew stops reading after';
/** A change of directory to a directory the hook does not find (decision D-119). */
const NOT_A_DIRECTORY = 'which is not an existing directory';
const CONFIG_CHANGE =
  "changes the package manager's configuration, which the install or other package manager command in the same command would use, while depcurfew checks it with the configuration from before the change";
const MANIFEST_CHANGE =
  'changes package.json, whose settings (overrides, scripts, allowScripts, trustedDependencies, pnpm settings) the install or other package manager command in the same command would use, while depcurfew checks it with the package.json from before the change';
const WEAKENS = 'what the project configured for every package this install fetches, also those depcurfew does not check';
const OVERRIDE_UNREAD = `is set in a way depcurfew does not read, which may weaken ${WEAKENS}`;
/** More specs than the hook checks for one command. */
export const TOO_MANY = 'depcurfew checks at most';
/** How the reason starts for an install whose directory cannot be told (decision D-118). */
const UNKNOWN_DIRECTORY = 'depcurfew cannot tell which directory';
/** A file run in this shell, and a trap that runs between later commands, make every later directory unknown (decision D-123). */
const SOURCED = 'runs a file in this shell';
const TRAP_BETWEEN = 'runs before or between later commands';

function anotherRegistry(name: string): string {
  return `${name} ${ANOTHER_REGISTRY}`;
}

/** What to do about a command that cannot be read, by why it cannot be read. */
export function unreadableFix(reason: string): string {
  if (reason.startsWith(UNKNOWN_DIRECTORY) && reason.includes(NOT_A_DIRECTORY)) {
    return 'Change only to a directory that exists (or create it with mkdir earlier in the same command), so depcurfew checks the install with the policy that applies there';
  }
  if (reason.startsWith(UNKNOWN_DIRECTORY) && (reason.includes(SOURCED) || reason.includes(TRAP_BETWEEN))) {
    return 'Run the install as a command of its own, without . or source of a file or a trap that changes directory before it, so depcurfew checks it with the policy of the directory it runs in';
  }
  if (reason.startsWith(UNKNOWN_DIRECTORY)) {
    return 'Run the install from that directory, or change to it with a path written out (cd path/to/project && …), so depcurfew checks it with the policy that applies there';
  }
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
  if (reason.includes(MAY_BE_ANY)) return 'Write the command out as plain text, without building it from variables or other commands, so depcurfew can check it';
  if (reason.includes(TOO_MUCH)) return 'Run the commands one by one, without aliases or eval that repeat them, so depcurfew can read each of them';
  if (reason.includes(CONFIG_CHANGE)) {
    return "Run the install as a command of its own, so depcurfew checks it with the configuration it will use; a change to the package manager's configuration is for the user to decide";
  }
  if (reason.includes(MANIFEST_CHANGE)) {
    return 'Run the install as a command of its own, so depcurfew checks it with the package.json it will use; a change to the settings in package.json is for the user to decide';
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

/** Appends every item of `items` to `list`, one by one: a spread of a long array would overflow the call stack. */
function appendAll<T>(list: T[], items: readonly T[]): void {
  for (const item of items) list.push(item);
}

function merge(into: CommandScan, scan: CommandScan): void {
  appendAll(into.requests, scan.requests);
  into.unreadable ??= scan.unreadable;
  // Appended in place, not copied: a long line may weaken thousands of installs (decision D-123).
  if (scan.overrides !== undefined && scan.overrides.length > 0) appendAll((into.overrides ??= []), scan.overrides);
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

/** The contexts made so far, by tool and command: every install of a long command line needs one (decision D-123). */
const CONTEXTS = new WeakMap<ToolCommands, Map<string, CommandContext>>();

function contextOf(tool: ToolCommands, command: readonly string[] | undefined): CommandContext {
  let made = CONTEXTS.get(tool);
  if (made === undefined) {
    made = new Map();
    CONTEXTS.set(tool, made);
  }
  const key = command === undefined ? '' : `\0${command.join('\0')}`;
  let context = made.get(key);
  if (context === undefined) {
    context = newContext(tool, command);
    made.set(key, context);
  }
  return context;
}

function newContext(tool: ToolCommands, command: readonly string[] | undefined): CommandContext {
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

/**
 * A prefix of an option that weakens the delay or the rule on install scripts (installOverrides), when no other such
 * option starts with it (--ignoreScripts and --ignore-scripts are one): the tool takes it for that option in some of its
 * versions or with some of its options (npm 11 has no other option starting with --ign, npm 12 has), so the scan does
 * too, which fails closed (decision D-119).
 */
function overrideAbbreviation(tool: ToolCommands, name: string): string | undefined {
  const matches = (tool.overrides?.options ?? []).map((option) => option.name).filter((option) => option.startsWith(name));
  const kinds = new Set(matches.map((option) => option.replaceAll('-', '').toLowerCase()));
  return kinds.size === 1 ? matches[0] : undefined;
}

/**
 * The option a word names under nopt's rules (npm, pnpm), without its dashes; `fixed` when it takes no further word
 * but true or false (`booleanWord`, a negated flag). nopt strips every leading no- in any case, each one inverting the
 * flag, and then resolves the rest as any option: an exact name or an unambiguous prefix (--no-ign is --no-ignore-scripts).
 */
function noptOption(tool: ToolCommands, bare: string): { name: string; fixed: boolean; value?: string; booleanWord?: true } {
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
  const negation = parsing.negation?.replace(/^-+/u, '');
  if (negation !== undefined && bare.toLowerCase().startsWith(negation)) {
    let rest = bare;
    let negated = false;
    while (rest.toLowerCase().startsWith(negation)) {
      negated = !negated;
      rest = rest.slice(negation.length);
    }
    const option = known.has(`--${rest}`) ? `--${rest}` : parsing.abbreviations === true ? (abbreviated(tool, `--${rest}`) ?? overrideAbbreviation(tool, `--${rest}`)) : undefined;
    const name = option ?? `--${rest}`;
    return { name: negated ? `--${negation}${name.replace(/^-+/u, '')}` : name, fixed: true, booleanWord: true };
  }
  if (parsing.abbreviations === true) {
    const option = abbreviated(tool, `--${bare}`);
    if (option !== undefined) return { name: option, fixed: false };
    const keys = tool.complete ? Object.keys(shorthands).filter((key) => key.startsWith(bare)) : [];
    if (keys.length === 1) return expand(shorthands[keys[0] as string] ?? []);
    const override = overrideAbbreviation(tool, `--${bare}`);
    if (override !== undefined) return { name: override, fixed: false };
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
      if (option.booleanWord === true && booleanWord !== undefined) return { name: option.name, value: booleanWord.text, next: booleanWord };
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
    name = abbreviated(tool, name) ?? overrideAbbreviation(tool, name) ?? name;
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
  const action = words.slice(0, index).findLast((word) => !word.dynamic && FIND_EXEC.has(word.text));
  if (action !== undefined) {
    // find … -exec command … ; (or +): the command ends there, and find puts the file names it finds in place of {}.
    const end = later.findIndex((word, position) => position > 0 && !word.dynamic && (word.text === ';' || word.text === '+'));
    if (end !== -1) later = later.slice(0, end);
    later = later.map((word) => (word.text.includes('{}') ? { text: word.text, dynamic: true, input: true, filler: 'find puts file names in place of {}' } : word));
  }
  const scan = inChild(scanCommand({ words: later, input: [], redirected: false, later: true }, depth));
  // -execdir and -okdir run the command in the directory of each file found, -exec and -ok where find runs (D-119).
  if (action?.text === '-execdir' || action?.text === '-okdir') {
    const reason = `find ${action.text} runs "${shown(joined(later))}" in the directory of each file it finds`;
    for (const entry of [...scan.requests, ...(scan.overrides ?? [])]) entry.directory = { unknown: reason };
  }
  return scan;
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
  if (isProcessSubstitution(file)) return { ...unreadable(`${shown(joined(words))}: ${FROM_PROCESS}`), moves: [sourced(words)] };
  const manager = file.dynamic ? undefined : scriptManager(file.text);
  if (manager !== undefined) return scanCommand({ ...command, words: [{ text: manager, dynamic: false }, ...words.slice(2)] }, depth);
  // source .venv/bin/activate: the activation script of a virtual environment, which the hook checks (decision D-123).
  const root = file.dynamic ? undefined : activationRoot(file.text, command.shell ?? 'posix');
  if (root !== undefined) return { requests: [], unreadable: undefined, moves: [{ kind: 'activate', root, reason: sourced(words).reason }] };
  // . "$X" i x: a file the shell expands, found on PATH and given an install word, may be a package manager (D-119).
  const next = words.slice(2).find((word) => !isOption(word.text));
  if (file.dynamic && next !== undefined && !next.dynamic && commands().installWords.has(next.text)) {
    return { ...unreadable(`${shown(joined(words))}: ${expanded(file, 'the file ')} ${MAY_BE_MANAGER}`), moves: [sourced(words)] };
  }
  // A file depcurfew does not read may change directory, set a trap or define a function named like any command.
  return file.dynamic || !STDIN_FILES.has(file.text) ? { requests: [], unreadable: undefined, moves: [sourced(words)] } : undefined;
}

/** . file and source file: the directory of every later command is unknown (decision D-123). */
function sourced(words: readonly Word[]): Extract<Move, { kind: 'unknown' }> {
  return { kind: 'unknown', reason: `"${shown(joined(words))}" ${SOURCED}, which depcurfew does not read and which may change directory`, lasting: true };
}

/**
 * The directory of the virtual environment whose activation script a path names, as written (decision D-123): one of
 * the scripts of environment.python.virtualEnvironment in its binary directory (bin/activate, bin/activate.fish,
 * Scripts\Activate.ps1), whose parent is the environment; '.' when the path starts at the binary directory. PowerShell
 * and cmd take \ as a separator, and Windows finds Scripts and its files in any case. undefined for another path, or
 * one relative to a home directory.
 */
function activationRoot(text: string, shell: Shell): string | undefined {
  const fact = values(environment.python.virtualEnvironment)[0];
  const path = shell === 'posix' ? text : text.replaceAll('\\', '/');
  if (fact === undefined || path.startsWith('~')) return undefined;
  const parts = path.split('/');
  if (parts.length < 2) return undefined;
  const name = parts.at(-1) as string;
  const directory = parts.at(-2) as string;
  const script = fact.scripts.some((entry) =>
    entry.platform === 'windows'
      ? entry.directory.toLowerCase() === directory.toLowerCase() && entry.names.some((known) => known.toLowerCase() === name.toLowerCase())
      : entry.directory === directory && entry.names.includes(name),
  );
  if (!script) return undefined;
  const root = parts.slice(0, -2).join('/');
  if (root !== '') return root;
  return path.startsWith('/') ? '/' : '.';
}

/** Why a sourced activation script cannot be trusted: its directory holds no pyvenv.cfg (decision D-123), as the hook says it. */
export function notVirtualEnvironment(directory: string): string {
  const marker = values(environment.python.virtualEnvironment)[0]?.marker ?? 'pyvenv.cfg';
  return `the command ${SOURCED} as the activation script of a virtual environment in "${shown(directory)}", which holds no ${marker}, so the file may change directory`;
}

/** source /dev/stdin with a here-document or here-string: its commands run in this shell, so their changes of directory count. */
function scanSourcedInput(words: readonly Word[], command: SimpleCommand, depth: number): CommandScan {
  if (command.input.length === 0 || command.redirected) return { ...unreadable(`${shown(joined(words))}: ${FROM_INPUT}`), moves: [sourced(words)] };
  const scan: CommandScan = { requests: [], unreadable: undefined };
  const moves: Move[] = [];
  for (const input of command.input) {
    const found = scanLine(input, depth + 1);
    merge(scan, found);
    if (found.moves !== undefined) moves.push(...found.moves);
  }
  return moves.length === 0 ? scan : { ...scan, moves };
}

/** Signal names of trap for the end of the shell, which runs the action after every later command. */
const EXIT_SIGNALS = /^(?:(?:SIG)?EXIT|0)$/iu;

/**
 * trap action signal…: the action is a command line the shell runs on those signals (EXIT, DEBUG, ERR…); - and a number
 * reset them. A trap on DEBUG, ERR, RETURN or a signal runs before or between later commands: when its action changes
 * directory, or cannot be read, the directory of every later command is unknown (decision D-123).
 */
function scanTrap(words: readonly Word[], depth: number): CommandScan {
  let index = 1;
  while (index < words.length && /^-[lpP]+$/u.test((words[index] as Word).text)) index += 1;
  if (words[index]?.text === '--') index += 1;
  const action = words[index];
  if (action === undefined || (!action.dynamic && (action.text === '-' || /^\d+$/u.test(action.text)))) return NOTHING;
  const scan = action.input === true ? unreadable(`${shown(joined(words))}: ${expanded(action)}`) : scanLine(action.text, depth + 1);
  // The action runs later, where the shell is by then: a change of directory after the trap makes that unknown.
  for (const entry of [...scan.requests, ...(scan.overrides ?? [])]) TRAPPED.add(entry);
  const between = words.slice(index + 1).some((signal) => signal.dynamic || !EXIT_SIGNALS.test(signal.text));
  if (!between || (scan.moves === undefined && scan.unreadable === undefined)) return inChild(scan);
  const what = scan.moves === undefined ? 'may change directory with an action depcurfew cannot read' : 'changes directory';
  return { ...inChild(scan), moves: [{ kind: 'unknown', reason: `the trap "${shown(joined(words))}" ${TRAP_BETWEEN} and ${what}`, lasting: true }] };
}

/** The aliases defined so far in the command line being scanned, by name, with their values. */
let aliases = new Map<string, string>();

/**
 * The aliases whose text is being read: bash does not expand such an alias again until its text has been read, so
 * alias a='a; a' runs the command a twice and expands nothing more (checked on GNU bash 5.2; decision D-119).
 */
let expanding = new Set<string>();

/**
 * How much one scan reads beyond the command line itself (which the hook limits to 1 MiB): each alias put in place and
 * each command line inside another costs its length, LINE_COST, and COMMAND_COST for each of its commands, every time
 * it is read.
 */
const WORK_LIMIT = 2_000_000;
const LINE_COST = 64;
const COMMAND_COST = 32;

/** What is left to read of WORK_LIMIT in the command line being scanned; beyond it, the scan asks (decision D-119). */
class Work {
  private remaining = WORK_LIMIT;

  /** Takes the cost of reading `text` with its `commands`; false when the scan has read as much as it reads in one command. */
  take(text: string, commands = 0): boolean {
    this.remaining -= text.length + LINE_COST + commands * COMMAND_COST;
    return this.remaining >= 0;
  }

  left(): boolean {
    return this.remaining >= 0;
  }

  spent(line: string): CommandScan {
    return unreadable(`${shown(line)}: ${TOO_MUCH} ${WORK_LIMIT / 1_000_000} million characters of command lines in one command (aliases and the command lines inside it count each time they are read)`);
  }
}
let work = new Work();

/** Installs and overrides in the action of a trap, which runs when the shell exits or gets a signal (decision D-119). */
const TRAPPED = new WeakSet<object>();

/** What the command line being scanned sets of CDPATH, OLDPWD, PWD and DIRSTACK, which change where cd goes. */
let variables: ShellVariables = shellVariables('');
/** The command line names TEXTDOMAIN or TEXTDOMAINDIR, so $"…" may be translated with a message catalog it brings. */
let translated = false;

/**
 * What a line read by the scanner sets; a line inside another counts for the rest of the command (decision D-119). The
 * names count as written and as the shell reads the words, after quotes, escapes and $'…' (export OLD\PWD=…; D-123).
 */
function noteLine(line: string): void {
  noteNames(line);
  translated ||= /\bTEXTDOMAIN(?:DIR)?\b/u.test(line);
}

/** The words of a line as the shell reads them, for the names of noteLine (decision D-123). */
function noteWords(items: readonly Item[]): void {
  noteNames(items.flatMap((item) => (item.kind === 'word' ? [item.word.text] : [])).join('\n'));
}

function noteNames(text: string): void {
  const found = shellVariables(text);
  variables = {
    ...variables,
    cdPath: variables.cdPath || found.cdPath,
    oldPwd: variables.oldPwd || found.oldPwd,
    pwd: variables.pwd || found.pwd,
    dirStack: variables.dirStack || found.dirStack,
  };
}

/** A command may set a variable whose name the shell builds, which may be OLDPWD, PWD, CDPATH or DIRSTACK (decision D-123). */
function noteBuiltName(reason: string): void {
  if (variables.dynamic === undefined) variables = { ...variables, dynamic: reason };
}

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
    const name = word.text.slice(0, equals);
    aliases.set(name, value);
    // The value is read as if the alias were put in place, so it does not expand itself.
    const own = !expanding.has(name);
    if (own) expanding.add(name);
    try {
      merge(scan, scanLine(value, depth + 1));
    } finally {
      if (own) expanding.delete(name);
    }
  }
  return scan;
}

/**
 * The words an alias stands for, or undefined when its value is more than one simple command (it is then read as a
 * line) or when the scan has read as much as it reads in one command.
 */
function aliasWords(value: string): Word[] | undefined {
  if (!work.take(value)) return undefined;
  try {
    const reading = read(value, 0, undefined, 0);
    return reading.items.every((item) => item.kind === 'word') ? reading.items.map((item) => (item as { word: Word }).word) : undefined;
  } catch (error) {
    if (error instanceof Unreadable) return undefined;
    throw error;
  }
}

/** A word of env -S with ${NAME} in it, as the shell would read it back (decision D-123). */
const SHELL_TEXT = new WeakMap<Word, string>();

/** A word as the shell would read it back: in single quotes unless the shell expands it. */
function requoted(word: Word): string {
  return SHELL_TEXT.get(word) ?? (word.dynamic ? word.text : `'${word.text.replaceAll("'", "'\\''")}'`);
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

/** A long option of a wrapper as getopt_long takes it: the option or an unambiguous prefix of it (env --ch=x is --chdir). */
function longOption(name: string, options: readonly string[] | undefined): boolean {
  return options?.some((option) => option === name || (name.startsWith('--') && name.length > 2 && option.startsWith(name))) === true;
}

/** The directory a wrapper's option names, relative to where the wrapper runs; unknown when the shell expands it. */
function wrapperDirectory(words: readonly Word[], value: Word | undefined): CommandDirectory | undefined {
  if (value === undefined) return undefined;
  if (value.dynamic) return { unknown: `the shell expands the directory of "${shown(joined(words))}"` };
  return { steps: [value.text] };
}

/** How many -S strings of env one command may have: GNU env reads each one again as arguments (decision D-123). */
const MAX_SPLITS = 16;

/** The escapes of a -S string of GNU env that stand for one character (build_argv in src/env.c). */
const SPLIT_ESCAPES: Readonly<Record<string, string>> = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '#': '#', $: '$', "'": "'", '\\': '\\' };
const SPLIT_BLANKS = new Set([' ', '\t', '\n', '\v', '\f', '\r']);
const SPLIT_VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/uy;

/**
 * The arguments GNU env makes of a -S string (build_argv in src/env.c, decision D-123): blanks separate them outside
 * quotes; '…' keeps everything but \\ and \'; "…" keeps blanks and reads the escapes; \_ separates (a space inside
 * "…"); \f \n \r \t \v are those characters and \" \# \$ \' \\ themselves; \c ends the string (an error inside "…"); #
 * at the start of an argument ends the string; ${NAME} is the value of the variable, as part of the argument (a word
 * depcurfew cannot know). undefined when env stops with an error: another escape, a $ without {NAME}, a quote left
 * open. A word the shell expands first is split at blanks, its expansions kept as they are: what they give may be any
 * text.
 */
function envSplit(word: Word): Word[] | undefined {
  const text = word.text;
  if (word.dynamic) {
    return text
      .split(/[ \t\n\v\f\r]+/u)
      .filter((part) => part !== '')
      .map((part) => (/[$`*?[{]/u.test(part) ? { text: part, dynamic: true, splits: true as const } : { text: part, dynamic: false }));
  }
  const found: Word[] = [];
  let current = '';
  let started = false;
  let dynamic = false;
  /** The word as the shell would read it back: the literal parts in single quotes, ${NAME} in double quotes. */
  let shellText = '';
  let literal = '';
  let single = false;
  let double = false;
  const end = () => {
    if (started) {
      const entry: Word = { text: current, dynamic };
      if (dynamic) SHELL_TEXT.set(entry, `${shellText}${requoted({ text: literal, dynamic: false })}`);
      found.push(entry);
    }
    current = '';
    started = false;
    dynamic = false;
    shellText = '';
    literal = '';
  };
  const add = (text: string) => {
    current += text;
    literal += text;
    started = true;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (single) {
      if (char === "'") single = false;
      else if (char === '\\' && (text[index + 1] === '\\' || text[index + 1] === "'")) add(text[++index] as string);
      else add(char);
      continue;
    }
    if (char === "'" && !double) {
      single = true;
      started = true;
    } else if (char === '"') {
      double = !double;
      started = true;
    } else if (!double && SPLIT_BLANKS.has(char)) {
      end();
    } else if (char === '#' && !double && !started) {
      // A comment ends the whole string.
      return found;
    } else if (char === '\\') {
      const next = text[++index];
      if (next === undefined) return undefined;
      if (next === '_') {
        if (double) add(' ');
        else end();
      } else if (next === 'c') {
        if (double) return undefined;
        end();
        return found;
      } else if (Object.hasOwn(SPLIT_ESCAPES, next)) {
        add(SPLIT_ESCAPES[next] as string);
      } else {
        return undefined;
      }
    } else if (char === '$') {
      SPLIT_VARIABLE.lastIndex = index;
      const variable = SPLIT_VARIABLE.exec(text);
      if (variable === null) return undefined;
      // The variable's value, from the environment env runs in.
      shellText += `${requoted({ text: literal, dynamic: false })}"${variable[0]}"`;
      literal = '';
      current += variable[0];
      started = true;
      dynamic = true;
      index += variable[0].length - 1;
    } else {
      add(char);
    }
  }
  if (single || double) return undefined;
  end();
  return found;
}

/**
 * What a wrapper runs: the remaining words, or a command line to read, with the directory it runs them in and the
 * variables it sets for them (env UV_PROJECT=sub uv add x).
 */
function unwrap(words: readonly Word[], wrapper: Wrapper): Unwrapped | { unreadable: string } {
  if (wrapper.anywhere === true) return unwrapAnywhere(words, wrapper);
  /** The arguments as the wrapper reads them: env -S puts the words of its string in place of the option. */
  let list: readonly Word[] = words;
  let index = 1;
  let replace: string | undefined;
  let shell = false;
  let directory: CommandDirectory | undefined;
  const assigned: Word[] = [];
  let splits = 0;
  // GNU env changes to one directory: a later -C replaces an earlier one (newdir = optarg in src/env.c).
  const moveTo = (value: Word | undefined) => {
    const found = wrapperDirectory(words, value);
    if (found !== undefined) directory = found;
  };
  /** A word the shell expands where an option may stand may be -C dir (env "$OPTS" npm i x; decision D-123). */
  const doubt = () => {
    if (wrapper.chdir !== undefined) directory = { unknown: `the shell expands an option of "${shown(joined(words))}", which may name the directory it runs the command in` };
  };
  const done = (result: Unwrapped | { unreadable: string }): Unwrapped | { unreadable: string } => {
    if ('unreadable' in result) return result;
    // After env -S the command is read as a line, with the variables env sets before it.
    const own = splits > 0 && 'words' in result ? { line: [...assigned, ...result.words].map((entry) => (/^[\w@%+=:,./-]+$/u.test(entry.text) ? entry.text : requoted(entry))).join(' ') } : result;
    return { ...own, ...(directory === undefined ? {} : { directory }), ...(splits === 0 && assigned.length > 0 ? { assigned } : {}) };
  };
  /** env -S and --split-string: the words of the string are read again as arguments, options included (src/env.c). */
  const split = (value: Word | undefined, next: number): Unwrapped | { unreadable: string } | undefined => {
    if (++splits > MAX_SPLITS) return { unreadable: `${TOO_MUCH} ${MAX_SPLITS} -S strings of env in one command` };
    // env -S without a string stops with an error, and so does a string it cannot split.
    const found = value === undefined ? undefined : envSplit(value);
    if (found === undefined) return { words: [] };
    if (value?.dynamic === true) doubt();
    list = [list[0] as Word, ...found, ...list.slice(next)];
    index = 1;
    return undefined;
  };
  while (index < list.length) {
    const word = list[index] as Word;
    const text = word.text;
    if (ASSIGNMENT.test(text)) {
      assigned.push(word);
      index += 1;
      continue;
    }
    if (!isOption(text)) {
      if (word.dynamic && /^[$`]/u.test(text)) doubt();
      break;
    }
    if (text === '--') {
      index += 1;
      break;
    }
    if (word.dynamic) doubt();
    const [name, attached] = splitOption(text);
    // getopt_long takes an unambiguous prefix of a long option: env --split='npm i x'.
    if (longOption(name, wrapper.split)) {
      const stop = split(attached === undefined ? list[index + 1] : { text: attached, dynamic: word.dynamic }, index + (attached === undefined ? 2 : 1));
      if (stop !== undefined) return done(stop);
      continue;
    }
    if (longOption(name, wrapper.chdir)) {
      moveTo(attached === undefined ? list[index + 1] : { text: attached, dynamic: word.dynamic });
      index += attached === undefined ? 2 : 1;
      continue;
    }
    if (wrapper.lineOptions?.includes(name)) return done(lineOf(attached, list[index + 1]));
    if (wrapper.shellOptions?.includes(name)) {
      shell = true;
      index += 1;
      continue;
    }
    const inputOption = wrapper.input?.find((option) => name === option || (option.length === 2 && name.startsWith(option)));
    if (inputOption !== undefined) {
      // xargs -I{} or --replace={}: the string is replaced with input; -i alone means {}.
      const inline = attached ?? (name.length > inputOption.length ? name.slice(inputOption.length) : undefined);
      replace = inline ?? (inputOption === '-i' ? '{}' : list[index + 1]?.text);
      index += inline === undefined && inputOption !== '-i' ? 2 : 1;
      continue;
    }
    if (/^-[^-]./u.test(text)) {
      const grouped = groupedOptions(list, index, wrapper);
      if ('line' in grouped || 'unreadable' in grouped) return done(grouped);
      shell ||= grouped.shell;
      if (grouped.chdir !== undefined) moveTo(grouped.chdir);
      if (grouped.split !== undefined) {
        const stop = split(grouped.split.value, grouped.split.next);
        if (stop !== undefined) return done(stop);
        continue;
      }
      index = grouped.next;
      continue;
    }
    index += attached === undefined && wrapper.values?.includes(name) === true ? 2 : 1;
  }
  const rest = list.slice(index + (wrapper.operands ?? 0));
  if (shell) {
    if (rest.length === 0) return done({ words: [] });
    const filled = rest.find((entry) => entry.input === true);
    return done(filled === undefined ? { line: joined(rest) } : { unreadable: expanded(filled) });
  }
  // flock file -c command: a line option may follow the operands.
  const [after, value] = splitOption(rest[0]?.text ?? '');
  if (wrapper.operands !== undefined && wrapper.lineOptions?.includes(after) === true) return done(lineOf(value, rest[1]));
  if (wrapper.line === true) {
    const filled = rest.find((entry) => entry.input === true);
    return done(filled === undefined ? { line: joined(rest) } : { unreadable: expanded(filled) });
  }
  if (wrapper.input === undefined || rest.length === 0) return done({ words: rest });
  if (replace === undefined) return done({ words: [...rest, XARGS_INPUT] });
  const marker = replace;
  return done({ words: rest.map((entry) => (entry.text.includes(marker) ? { text: entry.text, dynamic: true, input: true } : entry)) });
}

/**
 * One-letter options of a wrapper grouped in one word, as getopt reads them (env -iS'npm i x', env -vS 'npm i x',
 * sudo -Es): flags, then perhaps an option whose value is the rest of the word or the next word. The = of -u=x is part
 * of the value, so the word is read as written. `chdir`: the directory of env -iC dir or env -Cdir; `split`: the string
 * of env -iS, and where the arguments after it start.
 */
function groupedOptions(
  words: readonly Word[],
  index: number,
  wrapper: Wrapper,
): { next: number; shell: boolean; chdir?: Word | undefined; split?: { value: Word | undefined; next: number } } | { line: string } | { unreadable: string } {
  const word = words[index] as Word;
  const text = word.text;
  let shell = false;
  for (let position = 1; position < text.length; position++) {
    const option = `-${text[position] as string}`;
    const rest = text.slice(position + 1);
    if (wrapper.split?.includes(option)) {
      const value = rest === '' ? words[index + 1] : { text: rest, dynamic: word.dynamic };
      return { next: index + 1, shell, split: { value, next: index + (rest === '' ? 2 : 1) } };
    }
    if (wrapper.lineOptions?.includes(option)) return lineOf(rest === '' ? undefined : rest, words[index + 1]);
    if (wrapper.shellOptions?.includes(option)) shell = true;
    if (wrapper.chdir?.includes(option)) return { next: index + (rest === '' ? 2 : 1), shell, chdir: rest === '' ? words[index + 1] : { text: rest, dynamic: word.dynamic } };
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
  const base = basename(text);
  const name = base.includes('@') || base.includes('==') ? base.replace(/@[^/]*$/u, '').replace(/==.*$/u, '') : base;
  const { executables } = commands();
  if (executables.has(name)) return name;
  const unversioned = /[0-9.]$/u.test(name) ? name.replace(/[0-9][0-9.]*$/u, '') : name;
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
  /** Aliases this command puts in place, which are not expanded again while their text is read (decision D-119). */
  const put: string[] = [];
  try {
    return scanWords(command, depth, put);
  } finally {
    for (const name of put) expanding.delete(name);
  }
}

/** The words before the command itself: assignments, reserved words, aliases and wrappers such as sudo or env. */
function scanWords(command: SimpleCommand, depth: number, put: string[]): CommandScan {
  let words = command.words;
  /** Variables set for the command alone (UV_PROJECT=sub uv add x). */
  const assigned: Word[] = [];
  /** No wrapper such as sudo or env runs it, so a builtin of the shell (cd) runs in the shell itself. */
  let builtin = true;
  /** Where a wrapper runs the command (env -C, sudo -D; decision D-119), relative to the shell. */
  let directory: CommandDirectory | undefined;
  const moved = (scan: CommandScan) => (directory === undefined ? scan : placed(scan, directory));
  for (;;) {
    const head = words[0];
    if (head === undefined) return NOTHING;
    // a[$X]=1: the subscript is arithmetic, which may assign any variable (decision D-123).
    if (head.dynamic && BUILT_SUBSCRIPT.test(head.text)) noteBuiltName(builtName(shown(joined(words))));
    // A command found further along other words starts with its executable (pipx run pip==25.0), not an assignment.
    if (ASSIGNMENT.test(head.text) && !(command.later === true && words === command.words)) {
      assigned.push(head);
      words = words.slice(1);
    } else if (!head.dynamic && KEYWORDS.has(head.text)) {
      // coproc runs the command in a subshell of its own.
      if (head.text === 'coproc') builtin = false;
      words = words.slice(1);
    } else if (!head.dynamic && aliases.has(head.text) && !expanding.has(head.text)) {
      // Checked after wrappers too, as an alias whose value ends in a blank (alias s='sudo ') makes bash do. bash
      // does not expand an alias again while its text is read (alias ls='ls -F', alias a='a; a').
      const expansion = aliasText(words, put);
      if (expansion === undefined) return work.spent(joined(words));
      const rest = words.slice(expansion.used);
      const own = aliasWords(expansion.text);
      if (own === undefined) return moved(work.left() ? scanLine([expansion.text, ...rest.map(requoted)].join(' '), depth + 1) : work.spent(expansion.text));
      words = [...own, ...rest];
    } else if (!head.dynamic && head.text === 'function') {
      words = words.slice(2);
    } else if (!head.dynamic && WRAPPERS.has(basename(head.text))) {
      const wrapper = basename(head.text);
      const unwrapped = unwrap(words, WRAPPERS.get(wrapper) as Wrapper);
      if ('unreadable' in unwrapped) return unreadable(`${shown(joined(words))}: ${unwrapped.unreadable}`);
      if (unwrapped.directory !== undefined) directory = within(directory ?? HERE, unwrapped.directory);
      // env and sudo set the variables before the command for it alone (env UV_PROJECT=sub uv add x).
      if (unwrapped.assigned !== undefined) assigned.push(...unwrapped.assigned);
      if (wrapper === 'eval') {
        // eval of words the shell expands may assign any variable (eval "$X=…"; decision D-123).
        if (builtin && words.slice(1).some((word) => word.dynamic)) noteBuiltName(builtName(shown(joined(words))));
        // eval runs the line in the shell itself, so a cd in it changes the directory; the others start a process.
        if ('line' in unwrapped) return moved(scanLine(unwrapped.line, depth + 1));
      }
      if ('line' in unwrapped) return moved(inChild(scanLine(unwrapped.line, depth + 1)));
      // command, builtin and bash's reserved word time run a builtin in the shell itself.
      if (wrapper !== 'command' && wrapper !== 'builtin' && wrapper !== 'time') builtin = false;
      words = unwrapped.words;
    } else {
      break;
    }
  }
  // declare "${X}PWD=…", printf -v "$N", read "$N": a variable whose name the shell builds (decision D-123).
  if (builtin) {
    const reason = dynamicAssignment(words);
    if (reason !== undefined) noteBuiltName(reason);
  }
  return moved(scanSimple(command, words, assigned, builtin, depth));
}

/**
 * The text an alias at the start of `words` stands for, with the words after it that bash expands too: when the value
 * of an alias ends in a blank, the next word is checked for an alias as well, and so on (bash manual "Aliases";
 * decision D-123). That alias is no longer read when the next word is, so the next word may be the same alias. `used`:
 * how many of the words the text stands for; undefined when the scan has read as much as it reads in one command.
 */
function aliasText(words: readonly Word[], put: string[]): { text: string; used: number } | undefined {
  const first = (words[0] as Word).text;
  let value = aliases.get(first) as string;
  expanding.add(first);
  put.push(first);
  let text = value;
  let used = 1;
  while (/[ \t]$/u.test(value)) {
    const next = words[used];
    if (next === undefined || next.dynamic || !aliases.has(next.text)) break;
    // An alias of an outer reading is still being read.
    if (expanding.has(next.text) && !put.includes(next.text)) break;
    value = aliases.get(next.text) as string;
    if (!work.take(value)) return undefined;
    if (!expanding.has(next.text)) {
      expanding.add(next.text);
      put.push(next.text);
    }
    text += value;
    used += 1;
  }
  return { text, used };
}

/** A command without the words before it: the executable and its arguments. */
function scanSimple(command: SimpleCommand, words: readonly Word[], assigned: readonly Word[], builtin: boolean, depth: number): CommandScan {
  const { installWords } = commands();
  const first = words[0] as Word;
  const line = joined(words);
  // cd, pushd, Set-Location: where the commands after it run (decision D-118).
  const moves = directoryChange(words, command.shell ?? 'posix', builtin, variables);
  if (moves !== undefined) return { requests: [], unreadable: undefined, ...(moves.length === 0 ? {} : { moves }) };
  // A command line built at run time (eval "$CMD", sh -c "$X") cannot be known in advance. In PowerShell a variable
  // on its own is a value, not a command: only & or . would run it, and then its arguments decide.
  if (depth > 0 && command.shell !== 'powershell' && WHOLE_EXPANSION.test(first.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  // eval 'x$A', sh -c "${A}x": the shell splits the expansion into words, which may be any command; so may $'…' that
  // depcurfew cannot decode. Brace expansion makes several words of one anywhere ({npm,install,x}). (Decision D-119.)
  if (first.splits === true && command.shell !== 'powershell' && (depth > 0 || BRACES.test(first.text))) {
    return unreadable(`${shown(line)}: ${expanded(first, 'the command ')} ${MAY_BE_ANY}`);
  }
  // $SHELL -c '…', $(which bash) <<< '…', echo '…' | $SHELL: a shell named by an expansion runs a command line.
  if (first.dynamic && command.shell !== 'powershell' && commandLineGiven(words.slice(1), command)) {
    return unreadable(`${shown(line)}: ${expanded(first, 'the command ')} ${MAY_BE_SHELL}`);
  }
  const executable = first.dynamic ? basename(first.text) : executableOf(first.text);
  // Another shell, a PowerShell or cmd.exe process and a trap run their command lines elsewhere or later: a cd in them
  // does not change where the next command runs.
  if (SHELLS.has(executable)) return inChild(scanShell(words, command, depth));
  if (!first.dynamic && POWERSHELLS.has(executable)) return inChild(scanPowerShell(words, command, depth, executable === 'powershell'));
  if (!first.dynamic && CMD.has(executable)) return inChild(scanCmd(words, command, depth));
  // . and source run a file in this shell, and a trap may run its action before later commands (decision D-123).
  if (!first.dynamic && SOURCES.has(executable)) return scanSource(words, command, depth) ?? scanSourcedInput(words, command, depth);
  if (!first.dynamic && executable === 'trap') return scanTrap(words, depth);
  if (!first.dynamic && executable === 'alias') return scanAlias(words, depth);
  if (!first.dynamic && EXPRESSION_RUNNERS.has(executable)) return scanInvokeExpression(words, command, depth);
  if (!first.dynamic && interpreter()?.executables.includes(executable) === true) return scanInterpreter(words, command, depth);
  const reader = first.dynamic ? undefined : PROGRAM_READERS.get(executable);
  if (reader !== undefined) return scanProgramReader(words, command, reader, depth);
  const rest = words.slice(1);
  // A change of the configuration or of package.json counts when another package manager command is on the line.
  const change = first.dynamic ? undefined : configChange(executable, rest);
  if (change !== undefined) return { requests: [], unreadable: undefined, changes: `${shown(line)}: ${change === 'manifest' ? MANIFEST_CHANGE : CONFIG_CHANGE}` };
  const scan = scanPackageManager(command, first, executable, rest, line, depth, assigned);
  if (scan !== undefined) {
    const batch = batchArgument(first, executable, rest, command.shell);
    return batch === undefined ? scan : { ...scan, unreadable: scan.unreadable ?? `${shown(line)}: ${batch}` };
  }
  const subcommand = rest.find((word) => !isOption(word.text));
  if (first.dynamic && subcommand !== undefined && installWords.has(subcommand.text)) return unreadable(`${shown(line)}: ${expanded(first, 'the command ')}`);
  // Inside a command line, a command and a subcommand both built at run time may be an install (sh -c '/bin/np? $(echo i) x').
  if (first.dynamic && depth > 0 && subcommand?.dynamic === true && command.shell !== 'powershell') return unreadable(`${shown(line)}: ${expanded(first, 'the command ')} ${MAY_BE_ANY}`);
  // echo npm install lodash prints the words; it runs nothing.
  if (!first.dynamic && PRINTERS.has(executable)) return NOTHING;
  return laterCommand(rest, depth);
}

/**
 * A command name as the tool resolves it (npm's deref, commandNames): camelCase as kebab-case, an exact command, an
 * alias, or a unique prefix of a command or an alias, whose alias is followed (npm conf is config, npm pk is pkg).
 */
/** The command names resolved so far, by the names of a tool (decision D-123: a long command line resolves many). */
const RESOLVED = new WeakMap<CommandNamesKnowledge, Map<string, string>>();

function commandName(names: CommandNamesKnowledge, word: string): string {
  let resolved = RESOLVED.get(names);
  if (resolved === undefined) {
    resolved = new Map();
    RESOLVED.set(names, resolved);
  }
  let name = resolved.get(word);
  if (name === undefined) {
    name = resolveCommandName(names, word);
    // Words of a command line are as many as its length allows; keep the map from growing with them.
    if (resolved.size < 4096) resolved.set(word, name);
  }
  return name;
}

function resolveCommandName(names: CommandNamesKnowledge, word: string): string {
  const name = /[A-Z]/u.test(word) ? word.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`) : word;
  if (names.commands.includes(name)) return name;
  const alias = (key: string) => (Object.hasOwn(names.aliases, key) ? names.aliases[key] : undefined);
  let resolved = alias(name);
  if (resolved === undefined) {
    const candidates = [...names.commands, ...Object.keys(names.aliases)].filter((candidate) => candidate.startsWith(name));
    if (candidates.length !== 1) return name;
    resolved = candidates[0] as string;
  }
  for (let step = 0; step < 8 && !names.commands.includes(resolved); step++) resolved = alias(resolved) ?? resolved;
  return resolved;
}

/**
 * Whether a command changes a package manager's configuration (npm config set, pnpm config delete, yarn config set,
 * pip config set, poetry config key value) or package.json (npm pkg set): its subcommand words, skipping options and
 * their values, match a command of configCommands that writes. A word the shell expands where a writing word may
 * stand counts as one.
 */
function configChange(executable: string, rest: readonly Word[]): 'configuration' | 'manifest' | undefined {
  configExecutables ??= new Set(commands().tools.flatMap((tool) => tool.configCommands.map((entry) => entry.command[0] ?? '')));
  if (!configExecutables.has(executable)) return undefined;
  for (const tool of commands().tools) {
    const entries = tool.configCommands.filter((entry) => entry.command[0] === executable);
    if (entries.length === 0) continue;
    // The words are read once per tool, not once per entry: a long line may hold a hundred thousand installs.
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
    const names = tool.commandNames;
    const first = positional[0];
    const firstName = first === undefined || names === undefined ? first?.text : commandName(names, first.text);
    const named = (word: Word | undefined, index: number) => (index === 0 ? firstName : word?.text);
    for (const entry of entries) {
      const parts = entry.command.slice(1);
      if (!parts.every((part, index) => named(positional[index], index) === part && positional[index]?.dynamic !== true)) continue;
      const after = positional.slice(parts.length);
      const word = after[0];
      const kind = entry.manifest === true ? 'manifest' : 'configuration';
      if (entry.writes !== undefined && word !== undefined && (word.dynamic || entry.writes.includes(word.text))) return kind;
      if (entry.operands !== undefined && (after.length >= entry.operands || after.some((part) => part.dynamic))) return kind;
      if (entry.options?.some((option) => options.includes(option)) === true) return kind;
    }
  }
  return undefined;
}

/**
 * A command of a package manager: the packages it installs or runs, in the directory its options or variables move it
 * to (decision D-118); undefined when no package manager owns the executable.
 */
function scanPackageManager(command: SimpleCommand, first: Word, executable: string, rest: readonly Word[], line: string, depth: number, assigned: readonly Word[] = []): CommandScan | undefined {
  // Most commands of a long line are no package manager's (decision D-123: every 1 MiB line is read in time).
  if (!commands().executables.has(executable)) return undefined;
  for (const tool of commands().tools) {
    if (!ownedBy(tool).has(executable)) continue;
    const moved = toolDirectory(tool, executable, rest, assigned);
    const scan = scanToolCommand(tool, command, first, executable, moved.words, line, depth);
    if (scan !== undefined) return placed(scan, moved.directory);
  }
  return undefined;
}

/** The executables a tool's add, run and create commands start with. */
const OWNED = new WeakMap<ToolCommands, ReadonlySet<string>>();

function ownedBy(tool: ToolCommands): ReadonlySet<string> {
  let owned = OWNED.get(tool);
  if (owned === undefined) {
    const { facts } = tool;
    owned = new Set([...facts.add, ...facts.run.map((entry) => entry.command), ...facts.create.map((entry) => entry.command)].map((entry) => entry[0] ?? ''));
    OWNED.set(tool, owned);
  }
  return owned;
}

/** The executables of the commands that change a tool's configuration or package.json (configCommands). */
let configExecutables: ReadonlySet<string> | undefined;

/** Installs and overrides of a command that runs in `directory`, relative to the shell; their own directories are relative to it. */
function placed(scan: CommandScan, directory: CommandDirectory | undefined): CommandScan {
  if (directory === undefined) return scan;
  for (const entry of [...scan.requests, ...(scan.overrides ?? [])]) entry.directory = within(directory, entry.directory ?? HERE);
  return inChild(scan);
}

/** A scan of command lines that another process (or a trap) runs: their changes of directory do not reach this shell. */
function inChild(scan: CommandScan): CommandScan {
  if (scan.moves === undefined) return scan;
  const copy = { ...scan };
  delete copy.moves;
  return copy;
}

/** The positional words of a command up to --, as the tool reads its options, and how many of them stand before each option. */
function positionals(tool: ToolCommands, words: readonly Word[]): { texts: string[]; before: Map<number, number> } {
  const texts: string[] = [];
  /** For each option, by its index: how many positional words come before it. */
  const before = new Map<number, number>();
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as Word;
    if (word.text === '--') break;
    if (!isOption(word.text) || word.dynamic) {
      texts.push(word.text);
      continue;
    }
    before.set(index, texts.length);
    if (readOption(words, index, tool, (name) => tool.valueOptions.has(name)).next !== undefined) index += 1;
  }
  return { texts, before };
}

/**
 * Where one command of a tool runs, relative to the shell, by the options and variables that move it (directoryOptions;
 * decision D-118), and its words without the options that only the tool's start-up reads (yarn --cwd). Options of a
 * command that runs a package (npx, uvx, uv run) count only before the package: the words after it are the package's.
 * An option of the command line wins over a variable of the same kind; a project option is relative to a directory one.
 */
function toolDirectory(tool: ToolCommands, executable: string, words: readonly Word[], assigned: readonly Word[]): { directory: CommandDirectory | undefined; words: readonly Word[] } {
  const facts = tool.directories;
  if (facts === undefined) return { directory: undefined, words };
  let rest = words;
  const found: { option: DirectoryOption; value: Word }[] = [];
  for (const option of facts.options) {
    const head = rest[0];
    if (option.position === 'first' && head !== undefined && !head.dynamic) {
      if (head.text === option.name && rest[1] !== undefined) {
        found.push({ option, value: rest[1] });
        rest = rest.slice(2);
      } else if (head.text.startsWith(`${option.name}=`)) {
        found.push({ option, value: { text: head.text.slice(option.name.length + 1), dynamic: false } });
        rest = rest.slice(1);
      }
    }
    if (option.position === 'last' && option.command?.[0] === executable && rest[0]?.text === option.command[1] && rest.length >= 3 && rest.at(-2)?.text === option.name) {
      found.push({ option, value: rest.at(-1) as Word });
      rest = rest.slice(0, -2);
    }
  }
  const { texts, before } = positionals(tool, rest);
  const startsWith = (command: readonly string[]) => command[0] === executable && command.slice(1).every((part, at) => texts[at] === part);
  const runs = tool.facts.run.filter((entry) => startsWith(entry.command));
  const limit = runs.length === 0 ? Infinity : Math.max(...runs.map((entry) => entry.command.length));
  const counts = (option: DirectoryOption) => option.ignoredBy?.some(startsWith) !== true;
  for (const [index, count] of before) {
    if (count >= limit) continue;
    const option = readOption(rest, index, tool, (name) => tool.valueOptions.has(name));
    // A shorthand the tool expands (npm -C is --prefix, pnpm -C is --dir) counts as its option.
    const key = option.name.replace(/^-+/u, '');
    const shorthands = tool.parsing.shorthands ?? {};
    const short = Object.hasOwn(shorthands, key) ? shorthands[key] : undefined;
    const name = short?.length === 1 && short[0]?.includes('=') !== true ? (short[0] as string) : option.name;
    const entry = facts.options.find((candidate) => candidate.position === undefined && candidate.name === name && counts(candidate));
    const value = option.next ?? (option.value === undefined ? undefined : { text: option.value, dynamic: false });
    if (entry !== undefined && value !== undefined) found.push({ option: entry, value });
  }
  const variables: { option: DirectoryOption; value: Word }[] = [];
  for (const word of assigned) {
    const name = ASSIGNMENT.exec(word.text)?.[1] ?? '';
    const entry = facts.variables.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() && counts(candidate));
    if (entry !== undefined) variables.push({ option: entry, value: { text: word.text.slice(name.length + 1), dynamic: word.dynamic } });
  }
  const pick = (moves: DirectoryOption['moves']) => found.findLast((entry) => entry.option.moves === moves) ?? variables.findLast((entry) => entry.option.moves === moves);
  const chosen = [pick('directory'), pick('project')].filter((entry) => entry !== undefined);
  if (chosen.length === 0) return { directory: undefined, words: rest };
  const unread = chosen.find((entry) => entry.value.dynamic);
  if (unread !== undefined) return { directory: { unknown: `the shell expands ${unread.option.name}, which names the directory "${shown(executable)}" runs in` }, words: rest };
  // PIPENV_PIPFILE names the Pipfile: the project is its directory (decision D-123).
  const files = chosen.find((entry) => entry.option.file !== undefined && entry.value.text.split(/[\\/]/u).at(-1) !== entry.option.file);
  if (files !== undefined) {
    return { directory: { unknown: `${files.option.name} names "${shown(files.value.text)}" as the ${files.option.file as string} of "${shown(executable)}", a file depcurfew does not read` }, words: rest };
  }
  const steps = chosen.map((entry) => (entry.option.file === undefined ? entry.value.text : directoryOfFile(entry.value.text)));
  const local = chosen.some((entry) => entry.option.localPrefix === true) ? { localPrefix: true as const } : {};
  return { directory: { steps, ...local }, words: rest };
}

/** The directory of a file named by a path: '.' for a file named alone, '/' for one in the root. */
function directoryOfFile(path: string): string {
  const cut = path.replace(/[^\\/]*$/u, '');
  if (cut === '') return '.';
  return cut.replace(/(?<=.)[\\/]+$/u, '');
}

/** A command of one package manager: the packages it installs or runs; undefined when the tool does not own the executable. */
function scanToolCommand(tool: ToolCommands, command: SimpleCommand, first: Word, executable: string, rest: readonly Word[], line: string, depth: number): CommandScan | undefined {
  const { add } = commands();
  const { facts } = tool;
  const run = facts.run.find((entry) => entry.command.length === 1 && entry.command[0] === executable);
  if (run !== undefined) {
    const context = contextOf(tool, run.command);
    return finish(tool, line, readArguments(rest, 'run', tool, run, context), depth, [], context);
  }
  if (tool.ecosystem !== 'npm') return scanPythonTool(tool, executable, rest, line, depth);
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

/**
 * Variables set anywhere on the line that weaken the delay or the rule on install scripts (installOverrides), with the
 * directory of the command they are set on (`placeOf`).
 */
function overrideAssignments(items: readonly Item[], line: string, placeOf: ReadonlyMap<Word, CommandDirectory>): Override[] {
  const { overrideVariables } = commands();
  const found: Override[] = [];
  for (const item of items) {
    if (item.kind !== 'word') continue;
    const name = ASSIGNMENT.exec(item.word.text)?.[1];
    if (name === undefined) continue;
    const value = item.word.text.slice(name.length + 1);
    const place = placeOf.get(item.word);
    for (const { tool, entry } of overrideVariables.get(name.toLowerCase()) ?? []) {
      const base = { tool, command: line, written: item.word.text, weakens: entry.weakens, ...(place === undefined ? {} : { directory: place }) };
      if (item.word.dynamic) found.push({ ...base, expanded: true });
      else if (weakensWith(entry.values, value)) found.push({ ...base, ...(entry.values === 'delay' ? { delay: value } : {}) });
    }
  }
  return found;
}

/**
 * Commands that write no file unless their output is redirected, so that an activation script run after them is the
 * one on disk (decision D-123): changes of directory, setting variables and options, printing and reading, tests, and
 * the reserved words that end a compound command. Anything else (tee, cp, mv, ln, python -m venv, a function or an
 * alias) may write it.
 */
const WRITES_NOTHING = new Set([
  'cd', 'chdir', 'pushd', 'popd', 'dirs', 'set', 'shopt', 'export', 'unset', 'true', 'false', ':', 'echo', 'printf', 'test', '[', '[[',
  'pwd', 'ls', 'cat', 'which', 'type', 'hash', 'fi', 'done', 'esac', '}', 'then', 'else', 'elif', 'do',
  'set-location', 'sl', 'push-location', 'pop-location', 'get-location', 'write-host', 'write-output',
]);

/** Whether a simple command writes no file (WRITES_NOTHING, without an output redirection). */
function writesNothing(command: SimpleCommand): boolean {
  if (command.writes === true) return false;
  const head = command.words.find((word) => word.dynamic || (!ASSIGNMENT.test(word.text) && !KEYWORDS.has(word.text)));
  if (head === undefined) return true;
  if (head.dynamic || aliases.has(head.text)) return false;
  return WRITES_NOTHING.has(head.text.toLowerCase());
}

/** Commands that set a variable for the commands after them (export UV_PROJECT=sub; cmd's set NAME=value). */
const SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'set']);

/**
 * A variable that moves a package manager's command to another directory (UV_PROJECT), set on the line apart from the
 * command (export UV_PROJECT=sub; uv add x): depcurfew does not follow it, so the installs of the tools that read it
 * cannot be placed. Variables set for one command alone are read with it (toolDirectory).
 */
function directoryAssignments(commandList: readonly SimpleCommand[], scan: CommandScan): void {
  const { directoryVariables, tools } = commands();
  for (const command of commandList) {
    const words = command.words;
    const head = words[0];
    const setters = head !== undefined && !head.dynamic && SETTERS.has(head.text.toLowerCase()) ? words.slice(1) : words.every((word) => ASSIGNMENT.test(word.text)) ? words : [];
    for (const word of setters) {
      const name = ASSIGNMENT.exec(word.text)?.[1];
      if (name === undefined || !directoryVariables.has(name.toLowerCase())) continue;
      const readers = new Set(tools.filter((tool) => tool.directories?.variables.some((entry) => entry.name.toLowerCase() === name.toLowerCase()) === true).map((tool) => tool.tool));
      const reason = `${name} is set by "${shown(joined(words))}" apart from the command, which may move it to another directory`;
      for (const entry of [...scan.requests, ...(scan.overrides ?? [])]) if (readers.has(entry.tool)) entry.directory = { unknown: reason };
    }
  }
}

interface LineReading {
  items: Item[];
  /** Command lines inside the line, read with the shell given; `at` is the item of the word they are in. */
  nested: { line: string; shell: Shell; at?: number }[];
  /** Why part of a PowerShell line cannot be read, found before its commands are scanned. */
  unreadable?: string;
  /** PowerShell: the line without what was read as an assignment, for variables set in other ways. */
  named?: string;
}

function readLine(line: string, shell: Shell): LineReading {
  if (shell === 'cmd') return { items: readCmd(line), nested: [] };
  if (shell === 'posix') {
    const reading = read(line, 0, undefined, 0);
    return { items: reading.items, nested: reading.substitutions.map((inner) => ({ line: inner.line, shell, at: inner.at })) };
  }
  const reading = readPowerShell(line);
  let doubt: string | undefined;
  for (const statement of reading.statements) {
    const runner = statement.constructs.length === 0 ? undefined : namedRunner(statement.text);
    if (runner !== undefined) doubt ??= `${shown(statement.text.trim())}: depcurfew does not read ${statement.constructs[0] as string} ${POWERSHELL_UNREAD} ${runner}`;
  }
  return {
    items: reading.items,
    nested: reading.nested.map((inner) => ({ line: inner.line, shell, at: inner.at })),
    named: reading.named,
    ...(doubt === undefined ? {} : { unreadable: doubt }),
  };
}

function scanLine(line: string, depth: number, shell: Shell = 'posix'): CommandScan {
  if (depth > MAX_DEPTH) {
    // Brackets nest deeply in ordinary PowerShell; there only a line that names a package manager matters.
    if (shell === 'powershell' && namedRunner(line) === undefined) return NOTHING;
    return unreadable(`${shown(line)}: command lines are nested more than ${MAX_DEPTH} levels deep`);
  }
  // Aliases and command lines inside others are read each time they run, which has to end somewhere (decision D-119).
  if (depth > 0 && !work.left()) return work.spent(line);
  noteLine(line);
  let reading: LineReading;
  try {
    reading = readLine(line, shell);
  } catch (error) {
    if (error instanceof Unreadable || error instanceof NestingTooDeep) return unreadable(`${shown(line)}: ${error.message}`);
    throw error;
  }
  noteWords(reading.items);
  const scan: CommandScan = { requests: [], unreadable: reading.unreadable };
  // Each install runs in the directory the shell is in when its command runs (decision D-118).
  const walk = new DirectoryWalk(shell);
  /** Where the words of each command run, for the variables set on the line. */
  const placeOf = new Map<Word, CommandDirectory>();
  const add = (found: CommandScan) => {
    const requests = scan.requests.length;
    const overrides = scan.overrides?.length ?? 0;
    merge(scan, found);
    if (found.requests.length === 0 && (found.overrides?.length ?? 0) === 0) return;
    walk.placed([...scan.requests.slice(requests), ...(scan.overrides ?? []).slice(overrides)], (entry) => TRAPPED.has(entry));
  };
  // In the order of the items they are in (a here-document's body comes after the words of its line).
  const pending = [...reading.nested].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  let next = 0;
  const nested = (inner: LineReading['nested'][number]) => {
    const found = scanLine(inner.line, depth + 1, inner.shell);
    // What a command substitution runs may write files.
    walk.ran(false);
    add(found);
    // A command substitution runs in a subshell; in PowerShell the location belongs to the whole session.
    if (shell === 'powershell' && found.moves !== undefined) walk.nestedChange(inner.line);
  };
  const commandList = simpleCommands(reading.items, shell);
  if (depth > 0 && !work.take(line, commandList.length)) return work.spent(line);
  for (const command of commandList) {
    const bounds: CommandBounds = command.bounds ?? { before: [], after: undefined };
    walk.begin(command.words, bounds);
    // The command lines in its words (and before them) run first, where the command runs.
    while (next < pending.length && (pending[next]?.at ?? Infinity) < (command.to ?? 0)) nested(pending[next++] as LineReading['nested'][number]);
    // Only assignments are looked up (overrideAssignments).
    for (const word of command.words) if (word.text.includes('=')) placeOf.set(word, walk.place);
    // mkdir: a cd into the directory it creates later on the line need not find it (decision D-119).
    const start = command.words.findIndex((word) => word.dynamic || (!ASSIGNMENT.test(word.text) && !KEYWORDS.has(word.text)));
    const created = start === -1 ? undefined : createdDirectories(command.words.slice(start), shell);
    if (created !== undefined) walk.create(created.paths, created.parents);
    const found = scanCommand(command, depth);
    add(found);
    if (found.moves !== undefined) walk.changes(found.moves, command.words, bounds);
    // An activation script run after a command that may write files is not trusted (decision D-123).
    walk.ran(writesNothing(command));
  }
  while (next < pending.length) nested(pending[next++] as LineReading['nested'][number]);
  walk.finish();
  if (scan.requests.length > 0) {
    const setting = registryAssignment(reading.items) ?? (reading.named === undefined ? undefined : namedSetting(reading.named));
    if (setting !== undefined) scan.unreadable ??= `${shown(line)}: ${setting}`;
    const selection = selectionAssignments(reading.items);
    if ('unreadable' in selection) scan.unreadable ??= `${shown(line)}: ${selection.unreadable}`;
    // Variables set on this line count before those of the lines inside it, which come in first.
    else for (const request of scan.requests) PENDING.get(request)?.variables.unshift(...selection.set);
  }
  if (scan.requests.length > 0 || scan.manager === true) {
    // npm_config_ignore_scripts=false npm ci weakens that install as much as npm i lodash.
    const found = overrideAssignments(reading.items, shown(line), placeOf);
    if (found.length > 0) appendAll((scan.overrides ??= []), found);
    const named = reading.named === undefined ? undefined : namedOverride(reading.named);
    if (named !== undefined) scan.unreadable ??= `${shown(line)}: ${named}`;
    directoryAssignments(commandList, scan);
  }
  if (walk.moves.length > 0) scan.moves = walk.moves;
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

/** A directory as the scan gives it: left out when it is the directory the command line starts in. */
function shownDirectory(directory: CommandDirectory | undefined): { directory?: CommandDirectory } {
  return directory === undefined || isHere(directory) ? {} : { directory };
}

/** The request with what its command line settles about the version and the build, and where it runs. */
function settle(request: InstallRequest): InstallRequest {
  const pending = PENDING.get(request);
  const place = shownDirectory(request.directory);
  if (pending === undefined) {
    const { directory: _directory, ...rest } = request;
    return { ...rest, ...place };
  }
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
  return { ...result, ...place };
}

export interface ScanOptions {
  /** The shell that runs the line: a POSIX shell (the default; also Git Bash) or PowerShell. */
  shell?: 'posix' | 'powershell';
}

/** The packages a command line installs or downloads to run with npm, pnpm, Yarn, Bun, Deno, pip, uv, Poetry, PDM, Pipenv or pipx. */
export function scanCommandLine(line: string, options: ScanOptions = {}): CommandScan {
  const previous = { aliases, expanding, work, variables, translated };
  aliases = new Map();
  expanding = new Set();
  work = new Work();
  variables = shellVariables('');
  translated = false;
  try {
    const scan = scanLine(line, 0, options.shell ?? 'posix');
    // A change of the configuration matters to the installs next to it, also those without names (npm config set … && npm ci).
    const unreadable = scan.unreadable ?? (scan.requests.length > 0 || scan.manager === true ? scan.changes : undefined);
    const overrides = scan.overrides?.map(({ directory, ...override }) => ({ ...override, ...shownDirectory(directory) }));
    return { requests: scan.requests.map(settle), unreadable, ...(overrides === undefined ? {} : { overrides }) };
  } finally {
    ({ aliases, expanding, work, variables, translated } = previous);
  }
}

/** Why an install cannot be placed in a directory (decision D-118), as the hook says it. */
export function unknownDirectory(command: string, reason: string): string {
  return `${UNKNOWN_DIRECTORY} "${shown(command)}" runs in: ${reason}`;
}

/** Why the hook cannot place an install after a change to a directory that it does not find (decision D-119). */
export function missingDirectory(step: string): string {
  return `the command changes to "${shown(step)}", ${NOT_A_DIRECTORY}, so the shell may stay where it was`;
}

/**
 * Why the options and variables of a command (scanCommandLine's overrides) weaken one of the policies, for the hook:
 * a release-age delay shorter than the longest cooldown, or that cannot be compared with it, and install scripts
 * turned on where a policy restricts them; undefined when none does.
 */
export function overrideDoubt(overrides: readonly Override[] | undefined, policies: readonly ResolvedPolicy[], files: readonly (string | null | undefined)[] = []): string | undefined {
  const minutes = policies.map((policy) => policy.cooldown?.minimum.minutes ?? 0);
  const required = Math.max(0, ...minutes);
  // The file that sets it, as the hook names it relative to the project (decision D-123); null is the default policy.
  const fileOf = (index: number) => {
    const file = files[index];
    return file === null ? 'the default policy' : (file ?? 'depcurfew.json');
  };
  const delayFile = fileOf(minutes.indexOf(required));
  // A deny list counts only with the default deny (validation), so the default decides whether scripts are restricted.
  const denying = policies.findIndex((policy) => policy.installScripts?.default === 'deny');
  const scriptsFile = fileOf(denying);
  for (const override of overrides ?? []) {
    const where = `${shown(override.command)}: ${override.written}`;
    if (override.weakens === 'scripts') {
      if (denying === -1) continue;
      if (override.expanded === true) return `${where} is set to a value the shell expands, which may turn on dependency install scripts that ${scriptsFile} restricts, and may weaken ${WEAKENS}`;
      return `${where} lets dependency install scripts run that ${scriptsFile} restricts, and weakens ${WEAKENS}`;
    }
    if (required <= 0) continue;
    const policy = formatMinutes(required);
    if (override.expanded === true) return `${where} is set to a value the shell expands, so its release-age delay cannot be compared with the ${policy} in ${delayFile}, and may weaken ${WEAKENS}`;
    if (override.delay === undefined) return `${where} changes the release-age delay of ${policy} that ${delayFile} requires, and weakens ${WEAKENS}`;
    const tool = knowledgeBase.find((entry) => entry.id === override.tool);
    const delay = tool === undefined ? undefined : delayMinutes(tool, override.delay, undefined);
    if (delay?.ok === true && delay.minutes >= required) continue;
    if (delay?.ok === true) return `${where} sets the release-age delay to ${formatMinutes(delay.minutes)}, shorter than the ${policy} in ${delayFile}, and weakens ${WEAKENS}`;
    return `${where} sets the release-age delay to a value depcurfew does not compare with the ${policy} in ${delayFile} (a date, false or another form), and may weaken ${WEAKENS}`;
  }
  return undefined;
}
