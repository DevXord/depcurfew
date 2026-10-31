// Readers for the command lines of the Windows shells, for the install guard: PowerShell (the PowerShell tool of
// Claude Code, powershell -c, pwsh -c, Invoke-Expression) and cmd.exe (cmd /c, cmd /k). Like the POSIX reader in
// command.ts, they split a line into words, separators and redirections without running anything, and mark the words
// the shell would expand; command.ts then finds the packages in them.
//
// PowerShell is a full language, and this reader understands plain commands only: quoting ('…' with '', "…" with
// backtick escapes), literal backslashes, ; | && || and the background &, the call operator & before a written-out
// command, redirections, comments, and $env:NAME = value as a variable for the commands after it. Everything else it
// does not read: variables, (…), $(…), @(…), {…}, @{…}, [Type], splatting, backticks outside line continuations,
// commas (arrays), --%, here-strings, typographic quotes, dashes and spaces, and commands that start programs from
// arguments it does not follow (Start-Process, Set-Alias, …). It lists them for each statement, so the caller can ask
// when such a statement names a package manager, and returns the command lines inside brackets to be read as well.
// The syntax follows about_Parsing and about_Quoting_Rules (github.com/MicrosoftDocs/PowerShell-Docs, reference/7.5):
// in argument mode < > @ # are special only at the start of a token, PowerShell takes typographic quotes for quotes,
// and & ends a statement unless it calls a command.
import type { Item } from './command.ts';

/** Brackets nested deeper than this cannot be read. */
const MAX_NESTING = 64;

export class NestingTooDeep extends Error {}

export interface PowerShellStatement {
  /** The statement as written, without comments and the names of $env: assignments that were read. */
  text: string;
  /** What in it this reader does not read, for messages ("(Get-Content p.txt)", a backtick, …). */
  constructs: string[];
}

export interface PowerShellReading {
  items: Item[];
  /** Command lines inside brackets: (…), $(…), @(…), {…} and @{…}, also inside "…". */
  nested: string[];
  statements: PowerShellStatement[];
  /** The line without comments and without the names of the $env: assignments that were read. */
  named: string;
}

/** PowerShell commands that start programs, or give names to them, from arguments this reader does not follow. */
const POWERSHELL_RUNNERS = new Set([
  'start-process', 'saps', 'start', 'start-job', 'sajb', 'start-threadjob', 'invoke-command', 'icm', 'invoke-item', 'ii',
  'set-alias', 'sal', 'new-alias', 'nal', 'new-object', 'add-type', 'invoke-wmimethod', 'iwmi', 'invoke-cimmethod',
  'register-scheduledjob',
]);

/** Characters PowerShell may read as quotes, dashes or spaces, which this reader does not. */
const UNUSUAL: readonly (readonly [RegExp, string])[] = [
  [/[\u2018-\u201e]/u, 'typographic quotes'],
  [/[\u2013-\u2015]/u, 'typographic dashes'],
  [/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u, 'Unicode spaces'],
];

const SPACE = new Set([' ', '\t', '\f', '\v']);
/** $env:NAME = at the start of a statement; compound operators (+=, ??=) leave the value unknown. */
const ENV_ASSIGNMENT = /\$env:([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\+|-|\*|\/|%|\?\?)?=(?!=)[ \t]*/iuy;
const VARIABLE = /\$(?:[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)?|[?^$])/uy;
const SPLAT = /@[A-Za-z0-9_]+/uy;
const REDIRECT = /[1-6*]?>>?(?:&[12])?/uy;
const CMD_EXPANSION = /%[^%\s]+%|![^!\s]+!/uy;

/** Text for a message: quoted and, when long, cut short. */
function quote(text: string): string {
  return `"${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`;
}

/** Whether a # at `index` starts a comment: at the start of a token. */
function startsToken(line: string, index: number): boolean {
  return index === 0 || /[\s;(){}|&]/u.test(line[index - 1] as string);
}

/** The index after a single-quoted string that starts at `index` ('' stands for '); -1 when it is not closed. */
function afterSingleQuoted(line: string, index: number): number {
  let at = index + 1;
  while (at < line.length) {
    if (line[at] === "'") {
      if (line[at + 1] !== "'") return at + 1;
      at += 2;
    } else {
      at += 1;
    }
  }
  return -1;
}

/**
 * The index after the bracket that closes the one at `open` (( or {), skipping strings, comments and other brackets;
 * -1 when it is not closed, or closed by the wrong bracket.
 */
function closing(line: string, open: number, level = 0): number {
  if (level > MAX_NESTING) throw new NestingTooDeep(`brackets are nested more than ${MAX_NESTING} levels deep`);
  const stack = [line[open] === '(' ? ')' : '}'];
  let index = open + 1;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === '`') {
      index += 2;
    } else if (char === "'") {
      index = afterSingleQuoted(line, index);
      if (index === -1) return -1;
    } else if (char === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === '`') {
          index += 2;
        } else if (line[index] === '$' && line[index + 1] === '(') {
          const end = closing(line, index + 1, level + 1);
          if (end === -1) return -1;
          index = end;
        } else {
          index += 1;
        }
      }
      index += 1;
    } else if (char === '#' && startsToken(line, index)) {
      const end = line.indexOf('\n', index);
      index = end === -1 ? line.length : end;
    } else if (char === '<' && line[index + 1] === '#') {
      const end = line.indexOf('#>', index + 2);
      index = end === -1 ? line.length : end + 2;
    } else if (char === '(' || char === '{') {
      stack.push(char === '(' ? ')' : '}');
      if (stack.length + level > MAX_NESTING) throw new NestingTooDeep(`brackets are nested more than ${MAX_NESTING} levels deep`);
      index += 1;
    } else if (char === ')' || char === '}') {
      if (stack.pop() !== char) return -1;
      index += 1;
      if (stack.length === 0) return index;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** Splits a PowerShell command line into words, separators and redirections; see the comment at the top. */
export function readPowerShell(line: string): PowerShellReading {
  const items: Item[] = [];
  const nested: string[] = [];
  const statements: PowerShellStatement[] = [];
  const blanked = [...line];
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at++) if (blanked[at] !== '\n') blanked[at] = ' ';
  };
  let constructs: string[] = [];
  let statementStart = 0;
  let text = '';
  let started = false;
  let dynamic = false;
  /** The next word that is finished is the command of a command. */
  let commandPending = true;
  /** The next word is the target of a redirection, where a variable such as $null is only a file. */
  let redirectTarget = false;
  /** $env:NAME = was read; the next word is its value. */
  let pendingEnv: { name: string; dynamic: boolean } | undefined;
  /** The variable set by the statement, which becomes unknown when more words follow its value. */
  let assignment: { kind: 'word'; word: { text: string; dynamic: boolean } } | undefined;

  const finish = () => {
    if (!started) return;
    const word = { text, dynamic };
    if (commandPending && !dynamic && POWERSHELL_RUNNERS.has(text.toLowerCase())) constructs.push(quote(text));
    if (pendingEnv !== undefined) {
      assignment = { kind: 'word', word: { text: `${pendingEnv.name}=${text}`, dynamic: dynamic || pendingEnv.dynamic } };
      pendingEnv = undefined;
      // A bare word after = runs as a command, so the value is read as one too.
      items.push(assignment, { kind: 'separator' }, { kind: 'word', word });
    } else {
      if (assignment !== undefined) assignment.word.dynamic = true;
      items.push({ kind: 'word', word });
    }
    text = '';
    started = false;
    dynamic = false;
    commandPending = false;
    redirectTarget = false;
  };
  const endStatement = (end: number, next: number) => {
    finish();
    if (pendingEnv !== undefined) items.push({ kind: 'word', word: { text: `${pendingEnv.name}=`, dynamic: pendingEnv.dynamic } });
    pendingEnv = undefined;
    assignment = undefined;
    statements.push({ text: blanked.slice(statementStart, end).join(''), constructs });
    constructs = [];
    statementStart = next;
    commandPending = true;
  };
  const bracket = (from: number, open: number): number => {
    const end = closing(line, open);
    const stop = end === -1 ? line.length : end;
    nested.push(line.slice(open + 1, end === -1 ? line.length : end - 1));
    constructs.push(end === -1 ? `${quote(line.slice(from, stop))} (not closed)` : quote(line.slice(from, stop)));
    text += line.slice(from, stop);
    started = true;
    dynamic = true;
    return stop;
  };
  const variable = (from: number): number => {
    VARIABLE.lastIndex = from;
    const name = VARIABLE.exec(line)?.[0] ?? '$';
    if (!(redirectTarget && !started)) constructs.push(quote(name));
    text += name;
    started = true;
    dynamic = true;
    return from + name.length;
  };
  const braced = (from: number): number => {
    const end = line.indexOf('}', from + 2);
    const stop = end === -1 ? line.length : end + 1;
    constructs.push(end === -1 ? `${quote(line.slice(from, stop))} (not closed)` : quote(line.slice(from, stop)));
    text += line.slice(from, stop);
    started = true;
    dynamic = true;
    return stop;
  };

  let index = 0;
  while (index < line.length) {
    const char = line[index] as string;
    const next = line[index + 1] ?? '';
    if (char === '`' && (next === '\n' || (next === '\r' && line[index + 2] === '\n'))) {
      // A line continuation separates words like a space.
      finish();
      index += next === '\n' ? 2 : 3;
      continue;
    }
    if (char === '`') {
      constructs.push('a backtick (`)');
      if (next === '') {
        index += 1;
        continue;
      }
      text += next;
      started = true;
      dynamic = true;
      index += 2;
      continue;
    }
    if (SPACE.has(char)) {
      finish();
      index += 1;
      continue;
    }
    if (char === '\r' && next === '\n') {
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endStatement(index, index + 1);
      items.push({ kind: 'separator' });
      index += 1;
      continue;
    }
    if (!started && char === '#') {
      const end = line.indexOf('\n', index);
      const stop = end === -1 ? line.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (!started && char === '<' && next === '#') {
      const end = line.indexOf('#>', index + 2);
      const stop = end === -1 ? line.length : end + 2;
      if (end === -1) constructs.push('a block comment that is not closed');
      blank(index, stop);
      index = stop;
      continue;
    }
    if (!started && char === '<') {
      constructs.push(quote('<'));
      index += 1;
      continue;
    }
    if (!started && (char === '>' || (/[1-6*]/u.test(char) && next === '>'))) {
      REDIRECT.lastIndex = index;
      const operator = REDIRECT.exec(line)?.[0] ?? '>';
      finish();
      index += operator.length;
      // 2>&1 joins two streams; any other redirection writes to the file named next.
      if (!operator.includes('&')) {
        items.push({ kind: 'redirect', input: false });
        redirectTarget = true;
      }
      continue;
    }
    if (char === ';') {
      endStatement(index, index + 1);
      items.push({ kind: 'separator' });
      index += 1;
      continue;
    }
    if (char === '|') {
      if (next === '|') {
        endStatement(index, index + 2);
        items.push({ kind: 'separator' });
        index += 2;
      } else {
        finish();
        items.push({ kind: 'separator', pipe: true });
        commandPending = true;
        index += 1;
      }
      continue;
    }
    if (char === '&') {
      if (next === '&') {
        endStatement(index, index + 2);
        items.push({ kind: 'separator' });
        index += 2;
      } else if (!started && commandPending) {
        // The call operator: the next word is the command.
        index += 1;
      } else {
        // The background operator ends the statement.
        endStatement(index, index + 1);
        items.push({ kind: 'separator' });
        index += 1;
      }
      continue;
    }
    if (char === '$' && !started && commandPending) {
      ENV_ASSIGNMENT.lastIndex = index;
      const match = ENV_ASSIGNMENT.exec(line);
      if (match !== null) {
        blank(index, index + match[0].length);
        pendingEnv = { name: match[1] as string, dynamic: match[2] !== undefined };
        commandPending = false;
        index += match[0].length;
        continue;
      }
    }
    if (char === "'") {
      const end = afterSingleQuoted(line, index);
      text += line.slice(index + 1, end === -1 ? line.length : end - 1).replaceAll("''", "'");
      if (end === -1) constructs.push('a quote that is not closed');
      started = true;
      index = end === -1 ? line.length : end;
      continue;
    }
    if (char === '"') {
      started = true;
      index += 1;
      while (index < line.length && !(line[index] === '"' && line[index + 1] !== '"')) {
        const inside = line[index] as string;
        const after = line[index + 1] ?? '';
        if (inside === '`') {
          constructs.push('a backtick (`)');
          text += after;
          dynamic = true;
          index += 2;
        } else if (inside === '"') {
          text += '"';
          index += 2;
        } else if (inside === '$' && after === '(') {
          index = bracket(index, index + 1);
        } else if (inside === '$' && after === '{') {
          index = braced(index);
        } else if (inside === '$' && /[A-Za-z0-9_?^$]/u.test(after)) {
          index = variable(index);
        } else {
          text += inside;
          index += 1;
        }
      }
      if (index >= line.length) constructs.push('a quote that is not closed');
      index += 1;
      continue;
    }
    if (char === '$') {
      if (next === '(') index = bracket(index, index + 1);
      else if (next === '{') index = braced(index);
      else if (/[A-Za-z0-9_?^$]/u.test(next)) index = variable(index);
      else {
        // A $ that starts no variable is a literal character.
        text += char;
        started = true;
        index += 1;
      }
      continue;
    }
    if (!started && char === '@') {
      if (next === '(' || next === '{') {
        index = bracket(index, index + 1);
        continue;
      }
      if (next === "'" || next === '"') {
        const end = line.indexOf(`\n${next}@`, index + 2);
        const stop = end === -1 ? line.length : end + 3;
        constructs.push(end === -1 ? 'a here-string that is not closed' : 'a here-string');
        text += line.slice(index, stop);
        started = true;
        dynamic = true;
        index = stop;
        continue;
      }
      SPLAT.lastIndex = index;
      const splat = SPLAT.exec(line)?.[0];
      // @scope/name is a package name; @name alone splats the variable $name.
      if (splat !== undefined && line[index + splat.length] !== '/') {
        constructs.push(quote(splat));
        text += splat;
        started = true;
        dynamic = true;
        index += splat.length;
        continue;
      }
    }
    if (char === '(' || char === '{') {
      index = bracket(index, index);
      continue;
    }
    if (char === ')' || char === '}') {
      constructs.push(`${quote(char)} without its opening bracket`);
      finish();
      index += 1;
      continue;
    }
    if (!started && char === '[') {
      let depth = 0;
      let end = index;
      for (; end < line.length; end++) {
        if (line[end] === '[') depth += 1;
        else if (line[end] === ']' && --depth === 0) break;
      }
      const stop = Math.min(end + 1, line.length);
      constructs.push(quote(line.slice(index, stop)));
      text += line.slice(index, stop);
      started = true;
      dynamic = true;
      index = stop;
      continue;
    }
    if (char === ',') {
      constructs.push(`${quote(',')} (an array)`);
      text += char;
      started = true;
      dynamic = true;
      index += 1;
      continue;
    }
    if (!started && line.startsWith('--%', index) && (index + 3 >= line.length || /\s/u.test(line[index + 3] as string))) {
      // The stop-parsing token: the rest up to the end of the line or a pipe goes to the program as it is.
      let end = index + 3;
      while (end < line.length && line[end] !== '\n' && line[end] !== '|') end += 1;
      constructs.push(quote('--%'));
      text += line.slice(index, end);
      started = true;
      dynamic = true;
      index = end;
      continue;
    }
    text += char;
    started = true;
    index += 1;
  }
  endStatement(line.length, line.length);
  for (const statement of statements) {
    for (const [pattern, label] of UNUSUAL) if (pattern.test(statement.text)) statement.constructs.push(label);
  }
  return { items, nested, statements, named: blanked.join('') };
}

/**
 * Splits a cmd.exe command line (what follows cmd /c or /k) into words, separators and redirections. & && || | and
 * newlines separate commands, ( ) group them, "…" quotes, ^ escapes the next character and %NAME% (also !NAME! with
 * delayed expansion) is expanded. An escaped operator (^&) is marked as expanded: a batch file such as npm.cmd reads
 * its arguments again, unescaped.
 */
export function readCmd(line: string): Item[] {
  const items: Item[] = [];
  let text = '';
  let started = false;
  let dynamic = false;
  let quoted = false;
  let parentheses = 0;
  let commandPending = true;
  const finish = () => {
    if (started) items.push({ kind: 'word', word: { text, dynamic } });
    if (started) commandPending = false;
    text = '';
    started = false;
    dynamic = false;
  };
  const separator = (pipe = false) => {
    finish();
    items.push(pipe ? { kind: 'separator', pipe: true } : { kind: 'separator' });
    commandPending = true;
  };
  const expansion = (at: number): string | undefined => {
    CMD_EXPANSION.lastIndex = at;
    return CMD_EXPANSION.exec(line)?.[0];
  };
  let index = 0;
  while (index < line.length) {
    const char = line[index] as string;
    const next = line[index + 1] ?? '';
    const expanded = char === '%' || char === '!' ? expansion(index) : undefined;
    if (expanded !== undefined) {
      text += expanded;
      started = true;
      dynamic = true;
      index += expanded.length;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      else text += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
      index += 1;
      continue;
    }
    if (char === '^') {
      if (next === '' || next === '\n' || next === '\r') {
        // A line continuation, or nothing to escape at the end of the line.
        index += next === '\r' && line[index + 2] === '\n' ? 3 : next === '' ? 1 : 2;
        continue;
      }
      if ('&|<>()^"%!'.includes(next)) dynamic = true;
      text += next;
      started = true;
      index += 2;
      continue;
    }
    if (char === ' ' || char === '\t') {
      finish();
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      separator();
      index += 1;
      continue;
    }
    if (char === '&' || char === '|') {
      const double = next === char;
      separator(char === '|' && !double);
      index += double ? 2 : 1;
      continue;
    }
    if (char === '(' && !started && commandPending) {
      separator();
      parentheses += 1;
      index += 1;
      continue;
    }
    if (char === ')' && parentheses > 0) {
      separator();
      parentheses -= 1;
      index += 1;
      continue;
    }
    if (char === '@' && !started && commandPending) {
      // @ before a command keeps it from being echoed.
      index += 1;
      continue;
    }
    if (char === '<' || char === '>' || (!started && /\d/u.test(char) && next === '>')) {
      finish();
      const operator = /^\d?(?:>>?|<)(?:&\d)?/u.exec(line.slice(index, index + 5))?.[0] ?? char;
      index += operator.length;
      if (!operator.includes('&')) items.push({ kind: 'redirect', input: operator.includes('<') });
      continue;
    }
    text += char;
    started = true;
    index += 1;
  }
  finish();
  return items;
}
