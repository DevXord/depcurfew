// The environment variables a PowerShell line names (decision D-138), for the install guard: $env:NAME and
// ${env:NAME}, paths on the Env: drive of the Environment provider (Env:NAME, Env:\NAME, Environment::NAME), the names
// that New-Item (-Name), Rename-Item (-NewName), Copy-Item and Move-Item (-Destination) give there, and the name that
// [Environment]::SetEnvironmentVariable(…) sets. Words are read as PowerShell reads them in argument mode: backtick
// escapes and quotes are removed, so Env:COMPO`SER and Env:COMPO'SER' are Env:COMPOSER. Parameters are bound as
// PowerShell binds them: any case, the exact name or alias, else the one parameter or alias the word starts
// (a parameter of the cmdlet before a common parameter), -Name:value and -Name: value, and the other words by
// position. When the line uses the Env: drive (or SetEnvironmentVariable, or New-PSDrive with the Environment provider)
// in a way that gives no name the reader can tell (a name the shell builds, a wildcard, splatting, a parameter that is
// unknown or ambiguous), the first such command is returned, so the caller can ask (fail closed).
// Sources (github.com/MicrosoftDocs/PowerShell-Docs, reference/7.5 and 5.1): about_Environment_Provider (the cmdlets
// the provider supports, the Env: drive and $Env:), about_Parameters (-Name value and -Name:value), about_Parsing (--,
// --%), about_CommonParameters (names and aliases), the pages of New-Item, Set-Item, Rename-Item, Copy-Item,
// Move-Item, Set-Content and Add-Content (parameters, aliases, positions); github.com/PowerShell/PowerShell at v7.5.4:
// engine/parser/tokenizer.cs (ScanParameter: a parameter starts with a dash and a letter, _ or ?, ends at a space, one
// of {}();,|&.[ or a colon, and a quote makes the token an argument), engine/MergedCommandParameterMetadata.cs
// (GetMatchingParameter: exact name or alias first, then prefixes of names and aliases, of several the one declared by
// the cmdlet, else ambiguous), engine/InitialSessionState.cs (the aliases ni, si, rni, ren, cpi, copy, cp, mi, move,
// mv, sc, ac, ndr, mount) and namespaces/SessionStateProviderBase.cs (the Environment provider writes content too).
import { closing, MAX_NESTING, NestingTooDeep } from './windows-shells.ts';

/** What a PowerShell line says about environment variables. */
export interface PowerShellEnvironment {
  /** The environment variable names it names, as PowerShell reads them (without escapes and quotes), in order. */
  names: string[];
  /** The first command that uses the Env: drive or SetEnvironmentVariable with a name the reader cannot tell. */
  unresolved?: string;
}

interface Word {
  /** Its elements (several for an array: a, b), each its value, or undefined when the shell computes it. */
  values: (string | undefined)[];
  /** As written, without backtick escapes and with the content of brackets left out: for Env: in a computed word. */
  raw: string;
  /** An unquoted -Name: the name without the dash. */
  parameter?: string;
  /** -Name: with a colon, so the next word is its value. */
  colon?: boolean;
  splat?: boolean;
  /** --, after which every word is an argument. */
  endOfParameters?: boolean;
  /** The variables it names: $env:NAME, ${env:NAME} and the name of SetEnvironmentVariable('NAME', …). */
  named: string[];
  /** The calls of SetEnvironmentVariable in it whose name was read. */
  calls: number;
  /** The end of `raw`, as long as the method name: slicing a long concatenated string would copy it each time. */
  tail: string;
}

interface Command {
  words: Word[];
  /** The command as written, for messages. */
  text: string;
}

type Role = 'path' | 'literal' | 'name' | 'other';

interface Parameter {
  /** In lower case, as all names here. */
  name: string;
  aliases: readonly string[];
  switch?: boolean;
  role?: Role;
  /** A common or risk-mitigation parameter, which loses to a parameter of the cmdlet for the same prefix. */
  common?: boolean;
}

interface Cmdlet {
  parameters: readonly Parameter[];
  /** The positions, in order: the role of a word there and the parameters that fill it. */
  positions: readonly { role: Role; parameters: readonly string[] }[];
  /** It creates a variable or changes its value, so a wildcard in its path matters. */
  writes: boolean;
}

const COMMON: readonly Parameter[] = [
  { name: 'verbose', aliases: ['vb'], switch: true, common: true },
  { name: 'debug', aliases: ['db'], switch: true, common: true },
  { name: 'erroraction', aliases: ['ea'], common: true },
  { name: 'warningaction', aliases: ['wa'], common: true },
  { name: 'informationaction', aliases: ['infa'], common: true },
  { name: 'progressaction', aliases: ['proga'], common: true },
  { name: 'errorvariable', aliases: ['ev'], common: true },
  { name: 'warningvariable', aliases: ['wv'], common: true },
  { name: 'informationvariable', aliases: ['iv'], common: true },
  { name: 'outvariable', aliases: ['ov'], common: true },
  { name: 'outbuffer', aliases: ['ob'], common: true },
  { name: 'pipelinevariable', aliases: ['pv'], common: true },
  { name: 'whatif', aliases: ['wi'], switch: true, common: true },
  { name: 'confirm', aliases: ['cf'], switch: true, common: true },
  // Windows PowerShell 5.1.
  { name: 'usetransaction', aliases: ['usetx'], switch: true, common: true },
];

const PATH: Parameter = { name: 'path', aliases: [], role: 'path' };
const LITERAL_PATH: Parameter = { name: 'literalpath', aliases: ['pspath', 'lp'], role: 'literal' };
const switches = (...names: string[]): Parameter[] => names.map((name) => ({ name, aliases: [], switch: true }));
const values = (...names: string[]): Parameter[] => names.map((name) => ({ name, aliases: [] }));
const AT_PATH = { role: 'path', parameters: ['path', 'literalpath'] } as const;

const NEW_ITEM: Cmdlet = {
  parameters: [PATH, { name: 'name', aliases: [], role: 'name' }, { name: 'itemtype', aliases: ['type'] }, { name: 'value', aliases: ['target'] }, ...switches('force'), ...values('credential')],
  positions: [{ role: 'path', parameters: ['path'] }],
  writes: true,
};
const SET_ITEM: Cmdlet = {
  parameters: [PATH, LITERAL_PATH, ...values('value', 'filter', 'include', 'exclude', 'credential'), ...switches('force', 'passthru')],
  positions: [AT_PATH, { role: 'other', parameters: ['value'] }],
  writes: true,
};
const RENAME_ITEM: Cmdlet = {
  parameters: [PATH, LITERAL_PATH, { name: 'newname', aliases: [], role: 'name' }, ...values('credential'), ...switches('force', 'passthru')],
  positions: [AT_PATH, { role: 'name', parameters: ['newname'] }],
  writes: true,
};
const COPY_ITEM: Cmdlet = {
  parameters: [
    PATH,
    LITERAL_PATH,
    { name: 'destination', aliases: [], role: 'name' },
    ...values('filter', 'include', 'exclude', 'credential', 'fromsession', 'tosession'),
    ...switches('container', 'force', 'recurse', 'passthru'),
  ],
  positions: [AT_PATH, { role: 'name', parameters: ['destination'] }],
  writes: true,
};
const MOVE_ITEM: Cmdlet = {
  parameters: [PATH, LITERAL_PATH, { name: 'destination', aliases: [], role: 'name' }, ...values('filter', 'include', 'exclude', 'credential'), ...switches('force', 'passthru')],
  positions: [AT_PATH, { role: 'name', parameters: ['destination'] }],
  writes: true,
};
const SET_CONTENT: Cmdlet = {
  parameters: [PATH, LITERAL_PATH, ...values('value', 'filter', 'include', 'exclude', 'credential', 'encoding', 'stream'), ...switches('passthru', 'force', 'nonewline', 'asbytestream')],
  positions: [AT_PATH, { role: 'other', parameters: ['value'] }],
  writes: true,
};

/** The cmdlets read with their parameters, by name and built-in alias. */
const CMDLETS = new Map<string, Cmdlet>([
  ['new-item', NEW_ITEM],
  ['ni', NEW_ITEM],
  ['set-item', SET_ITEM],
  ['si', SET_ITEM],
  ['rename-item', RENAME_ITEM],
  ['rni', RENAME_ITEM],
  ['ren', RENAME_ITEM],
  ['copy-item', COPY_ITEM],
  ['cpi', COPY_ITEM],
  ['copy', COPY_ITEM],
  ['cp', COPY_ITEM],
  ['move-item', MOVE_ITEM],
  ['mi', MOVE_ITEM],
  ['move', MOVE_ITEM],
  ['mv', MOVE_ITEM],
  ['set-content', SET_CONTENT],
  ['sc', SET_CONTENT],
  ['add-content', SET_CONTENT],
  ['ac', SET_CONTENT],
]);

/** New-PSDrive and its aliases: a drive of the Environment provider under another name. */
const NEW_DRIVE = new Set(['new-psdrive', 'ndr', 'mount']);

/** Set-Location and Push-Location with their aliases: after one to the Env: drive, a relative path names a variable. */
const LOCATION = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd']);

const SINGLE = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b']);
const DOUBLE = new Set(['"', '\u201c', '\u201d', '\u201e']);
const DASH = new Set(['-', '\u2013', '\u2014', '\u2015']);
/** The characters that end a parameter name besides spaces and the colon (ScanParameter). */
const PARAMETER_END = new Set(['{', '}', '(', ')', ';', ',', '|', '&', '.', '[', '\r', '\n']);
/** A path on the Env: drive, also provider-qualified. */
const ENV_PATH = /^(?:env:|(?:microsoft\.powershell\.core\\)?environment::)/iu;
/** Env: inside a word the shell computes: not $env:NAME or ${env:NAME}, which name the variable. */
const ENV_IN_TEXT = /(?:^|[^$\w{:])(?:env:|environment::)/iu;
const SET_VARIABLE = /setenvironmentvariable/giu;
/** The method name, in lower case, that a bracket after it calls. */
const SET_NAME = 'setenvironmentvariable';
/** The first argument of SetEnvironmentVariable(…) when it is a string written out. */
const FIRST_ARGUMENT = /^\s*(?:['\u2018-\u201b]((?:[^'\u2018-\u201b]|['\u2018-\u201b]{2})*)['\u2018-\u201b]|["\u201c-\u201e]([^"\u201c-\u201e`$]*)["\u201c-\u201e])\s*,/u;
const VARIABLE = /\$(?:([A-Za-z0-9_]+)(?::([A-Za-z0-9_]+))?|[?^$])/uy;

function isSpace(char: string): boolean {
  return char !== '\n' && char !== '\r' && (/\s/u.test(char) || char === '\u0085');
}

/** The commands of a text and of the brackets in it, inner ones first. */
function readCommands(text: string, depth: number, commands: Command[]): void {
  if (depth > MAX_NESTING) throw new NestingTooDeep(`brackets are nested more than ${MAX_NESTING} levels deep`);
  let words: Word[] = [];
  let start = -1;
  let element: string | undefined = '';
  let elements: (string | undefined)[] = [];
  let raw = '';
  let tail = '';
  let named: string[] = [];
  let calls = 0;
  let started = false;
  let splat = false;
  const begin = (at: number) => {
    if (start === -1) start = at;
    started = true;
  };
  const append = (written: string) => {
    raw += written;
    tail = (tail + written.slice(-SET_NAME.length)).slice(-SET_NAME.length);
  };
  const add = (value: string, written = value) => {
    if (element !== undefined) element += value;
    append(written);
  };
  const computed = (written: string) => {
    element = undefined;
    append(written);
  };
  const finishWord = () => {
    if (!started) return;
    elements.push(element);
    words.push({ values: elements, raw, named, calls, tail, ...(splat ? { splat: true } : {}) });
    element = '';
    elements = [];
    raw = '';
    tail = '';
    named = [];
    calls = 0;
    started = false;
    splat = false;
  };
  const finishCommand = (end: number) => {
    finishWord();
    if (words.length > 0) commands.push({ words, text: text.slice(start, end).trim() });
    words = [];
    start = -1;
  };
  /** A bracket at `open` (( or {): its commands are read, the word gets a computed part. */
  const bracket = (open: number, prefix = ''): number => {
    const end = closing(text, open);
    const stop = end === -1 ? text.length : end;
    const inner = text.slice(open + 1, end === -1 ? text.length : end - 1);
    if (text[open] === '(' && tail.toLowerCase() === SET_NAME) {
      const argument = FIRST_ARGUMENT.exec(inner);
      if (argument !== null) {
        named.push(argument[1] === undefined ? (argument[2] ?? '') : argument[1].replace(/(['\u2018-\u201b])\1/gu, '$1'));
        calls += 1;
      }
    }
    readCommands(inner, depth + 1, commands);
    computed(`${prefix}${text[open] === '(' ? '(…)' : '{…}'}`);
    return stop;
  };
  /** $name, $scope:name, $?, $^, $$ at `at`; a name of the env: scope goes on with backtick escapes (fail closed). */
  const variable = (at: number): number => {
    VARIABLE.lastIndex = at;
    const match = VARIABLE.exec(text);
    let end = at + (match?.[0].length ?? 1);
    let written = match?.[0] ?? '$';
    if (match?.[1]?.toLowerCase() === 'env' && match[2] !== undefined) {
      let name = match[2];
      while (text[end] === '`' && /[A-Za-z0-9_]/u.test(text[end + 1] ?? '')) {
        const rest = /[A-Za-z0-9_]+/uy;
        rest.lastIndex = end + 1;
        const part = rest.exec(text)?.[0] ?? '';
        name += part;
        written += part;
        end += 1 + part.length;
      }
      named.push(name);
    }
    computed(written);
    return end;
  };
  /** ${…} at `at`: a variable name with any characters, a backtick escaping the next one. */
  const braced = (at: number): number => {
    let end = at + 2;
    let name = '';
    while (end < text.length && text[end] !== '}') {
      if (text[end] === '`' && end + 1 < text.length) end += 1;
      name += text[end];
      end += 1;
    }
    const scoped = /^env:(.+)$/isu.exec(name);
    if (scoped?.[1] !== undefined) named.push(scoped[1]);
    computed(`\${${name}}`);
    return Math.min(end + 1, text.length);
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1] ?? '';
    if (char === '`' && (next === '\n' || (next === '\r' && text[index + 2] === '\n'))) {
      finishWord();
      index += next === '\n' ? 2 : 3;
      continue;
    }
    if (char === '`') {
      begin(index);
      add(next);
      index += 2;
      continue;
    }
    if (char === '\r' && next === '\n') {
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r' || char === ';') {
      finishCommand(index);
      index += 1;
      continue;
    }
    if (isSpace(char)) {
      finishWord();
      index += 1;
      continue;
    }
    if (char === '|' || (char === '&' && next === '&')) {
      finishCommand(index);
      index += next === char ? 2 : 1;
      continue;
    }
    if (char === '&') {
      // The call operator before the command; anywhere else the background operator, which ends the command.
      if (!started && words.length === 0) {
        if (start === -1) start = index;
        index += 1;
      } else {
        finishCommand(index);
        index += 1;
      }
      continue;
    }
    if (!started && char === '#') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (!started && char === '<' && next === '#') {
      const end = text.indexOf('#>', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (!started && (char === '>' || char === '<' || (/[1-6*]/u.test(char) && next === '>'))) {
      const operator = /^[1-6*]?(?:>>?|<)(?:&[12])?/u.exec(text.slice(index, index + 5))?.[0] ?? char;
      index += operator.length;
      continue;
    }
    if (!started && DASH.has(char) && DASH.has(next) && (index + 2 >= text.length || isSpace(text[index + 2] as string))) {
      begin(index);
      words.push({ values: [], raw: '--', named: [], calls: 0, tail: '--', endOfParameters: true });
      started = false;
      index += 2;
      continue;
    }
    if (!started && DASH.has(char) && DASH.has(next) && text[index + 2] === '%') {
      // The stop-parsing token: the rest up to the end of the line goes to the program as it is.
      begin(index);
      let end = index + 3;
      while (end < text.length && text[end] !== '\n' && text[end] !== '|') end += 1;
      computed(text.slice(index, end));
      index = end;
      continue;
    }
    if (!started && DASH.has(char) && /[\p{L}_?]/u.test(next)) {
      let end = index + 1;
      while (end < text.length && !isSpace(text[end] as string) && !PARAMETER_END.has(text[end] as string) && text[end] !== ':' && !SINGLE.has(text[end] as string) && !DOUBLE.has(text[end] as string)) {
        end += 1;
      }
      // A quote in it makes the token an argument (ScanParameter), read on as a word below.
      if (!SINGLE.has(text[end] ?? '') && !DOUBLE.has(text[end] ?? '')) {
        if (start === -1) start = index;
        const colon = text[end] === ':';
        words.push({ values: [], raw: text.slice(index, colon ? end + 1 : end), parameter: text.slice(index + 1, end), named: [], calls: 0, tail: '', ...(colon ? { colon: true } : {}) });
        index = colon ? end + 1 : end;
        continue;
      }
    }
    if (SINGLE.has(char)) {
      begin(index);
      let at = index + 1;
      let value = '';
      while (at < text.length) {
        if (SINGLE.has(text[at] as string)) {
          if (!SINGLE.has(text[at + 1] ?? '')) break;
          value += text[at];
          at += 2;
        } else {
          value += text[at];
          at += 1;
        }
      }
      add(value, text.slice(index, Math.min(at + 1, text.length)));
      index = at + 1;
      continue;
    }
    if (DOUBLE.has(char)) {
      begin(index);
      append(char);
      index += 1;
      while (index < text.length) {
        const inside = text[index] as string;
        const after = text[index + 1] ?? '';
        if (DOUBLE.has(inside)) {
          if (!DOUBLE.has(after)) {
            append(inside);
            index += 1;
            break;
          }
          add(inside, `${inside}${after}`);
          index += 2;
        } else if (inside === '`') {
          add(after);
          index += 2;
        } else if (inside === '$' && after === '(') {
          index = bracket(index + 1, '$');
        } else if (inside === '$' && after === '{') {
          index = braced(index);
        } else if (inside === '$' && /[A-Za-z0-9_?^$]/u.test(after)) {
          index = variable(index);
        } else {
          add(inside);
          index += 1;
        }
      }
      continue;
    }
    if (char === '$') {
      begin(index);
      if (next === '(') index = bracket(index + 1, '$');
      else if (next === '{') index = braced(index);
      else if (/[A-Za-z0-9_?^$]/u.test(next)) index = variable(index);
      else {
        add(char);
        index += 1;
      }
      continue;
    }
    if (!started && char === '@') {
      if (next === '(' || next === '{') {
        begin(index);
        index = bracket(index + 1, '@');
        continue;
      }
      const name = /^@[A-Za-z0-9_]+/u.exec(text.slice(index, index + 256))?.[0];
      // @scope/name is a package name; @name alone splats the variable $name.
      if (name !== undefined && text[index + name.length] !== '/') {
        begin(index);
        splat = true;
        computed(name);
        index += name.length;
        continue;
      }
    }
    if (char === '(' || char === '{') {
      begin(index);
      index = bracket(index);
      continue;
    }
    if (char === ')' || char === '}') {
      finishWord();
      index += 1;
      continue;
    }
    if (!started && char === '[') {
      begin(index);
      let level = 0;
      let end = index;
      for (; end < text.length; end++) {
        if (text[end] === '[') level += 1;
        else if (text[end] === ']' && --level === 0) break;
      }
      computed(text.slice(index, Math.min(end + 1, text.length)));
      index = end + 1;
      continue;
    }
    if (char === ',') {
      // An array: the elements go on in the same word, also after spaces and a line break.
      if (!started) {
        const last = words.at(-1);
        if (last !== undefined && last.parameter === undefined && last.endOfParameters !== true) {
          words.pop();
          elements = last.values;
          raw = last.raw;
          tail = last.tail;
          named = last.named;
          calls = last.calls;
          splat = last.splat === true;
          started = true;
        } else begin(index);
      } else elements.push(element);
      element = '';
      append(',');
      index += 1;
      while (index < text.length && (isSpace(text[index] as string) || text[index] === '\n' || text[index] === '\r')) index += 1;
      continue;
    }
    begin(index);
    add(char);
    index += 1;
  }
  finishCommand(text.length);
}

/**
 * The parameter a word names, as GetMatchingParameter finds it: the exact name or alias, else the parameters whose
 * name or alias starts with it; of several, the one parameter of the cmdlet among them; undefined when none or more.
 */
function matchParameter(parameters: readonly Parameter[], given: string): Parameter | undefined {
  const name = given.toLowerCase();
  const exact = parameters.find((parameter) => parameter.name === name || parameter.aliases.includes(name));
  if (exact !== undefined) return exact;
  const matches = parameters.filter((parameter) => parameter.name.startsWith(name) || parameter.aliases.some((alias) => alias.startsWith(name)));
  if (matches.length === 1) return matches[0];
  const declared = matches.filter((parameter) => parameter.common !== true);
  return declared.length === 1 ? declared[0] : undefined;
}

/** The index of the command word: the first word, or the one after . (dot-sourcing, as & before it). */
function head(command: Command): number {
  const first = command.words[0];
  return first?.values.length === 1 && first.values[0] === '.' && command.words.length > 1 ? 1 : 0;
}

/** The name of the command, in lower case and without a module (Microsoft.PowerShell.Management\Set-Item). */
function commandName(command: Command): string | undefined {
  const first = command.words[head(command)];
  const value = first?.parameter === undefined ? first?.values[0] : undefined;
  return value === undefined || first?.values.length !== 1 ? undefined : (value.split('\\').at(-1) ?? value).toLowerCase();
}

/**
 * The role of each word of an item cmdlet, bound as PowerShell binds its parameters; false when the binder cannot be
 * followed (splatting, a parameter that is unknown or ambiguous).
 */
function bind(command: Command, cmdlet: Cmdlet): Map<Word, Role> | false {
  const parameters = [...cmdlet.parameters, ...COMMON];
  const roles = new Map<Word, Role>();
  const byName = new Set<string>();
  const positional: Word[] = [];
  let end = false;
  const words = command.words;
  for (let index = head(command) + 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (word.splat === true) return false;
    if (!end && word.endOfParameters === true) {
      end = true;
      continue;
    }
    if (end || word.parameter === undefined) {
      if (word.endOfParameters !== true) positional.push(word);
      continue;
    }
    const parameter = matchParameter(parameters, word.parameter);
    if (parameter === undefined) return false;
    byName.add(parameter.name);
    if (parameter.switch === true) {
      if (word.colon === true) index += 1;
      continue;
    }
    const value = words[index + 1];
    // A parameter right after one that needs a value is an error, unless a colon binds it as the value.
    if (value === undefined || (value.parameter !== undefined && word.colon !== true)) continue;
    index += 1;
    roles.set(value, parameter.role ?? 'other');
  }
  const slots = cmdlet.positions.filter((slot) => !slot.parameters.some((name) => byName.has(name)));
  // A word beyond the positions is an error of PowerShell; read as a name, it can only make the hook ask.
  for (const word of positional) roles.set(word, slots.shift()?.role ?? 'name');
  return roles;
}

/** The parts of a path after the drive or provider, which name variables. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/u).filter((part) => part !== '');
}

/** What a PowerShell line says about environment variables; see the comment at the top. */
/** Appends without spreading, so that a path of any number of segments does not exhaust the call stack. */
function append(target: string[], items: readonly string[]): void {
  for (const item of items) target.push(item);
}

export function powerShellEnvironment(line: string): PowerShellEnvironment {
  const commands: Command[] = [];
  try {
    readCommands(line, 0, commands);
  } catch (error) {
    if (error instanceof NestingTooDeep) return { names: [], unresolved: line.trim() };
    throw error;
  }
  const computedEnv = (word: Word) => word.values.includes(undefined) && ENV_IN_TEXT.test(word.raw);
  const touched = commands.some(
    (command) =>
      NEW_DRIVE.has(commandName(command) ?? '') ||
      // Env: anywhere in a value counts too, as in the hashtable @{ Path = 'Env:'; Name = … } of a splatted New-Item.
      command.words.some((word) => word.calls > 0 || word.values.some((value) => value !== undefined && ENV_IN_TEXT.test(value)) || computedEnv(word)),
  );
  // A change of location to the Env: drive makes the relative paths of the item cmdlets names of variables.
  const onDrive = commands.some(
    (command) => LOCATION.has(commandName(command) ?? '') && command.words.slice(head(command) + 1).some((word) => word.values.some((value) => value !== undefined && ENV_IN_TEXT.test(value)) || computedEnv(word)),
  );
  const names: string[] = [];
  let unresolved: string | undefined;
  for (const command of commands) {
    const name = commandName(command);
    const cmdlet = touched && name !== undefined ? CMDLETS.get(name) : undefined;
    const roles = cmdlet === undefined ? undefined : bind(command, cmdlet);
    let fails = roles === false || (name !== undefined && NEW_DRIVE.has(name) && command.words.some((word) => /environment/iu.test(word.raw) || word.values.includes(undefined)));
    for (const word of command.words) {
      if (word.parameter !== undefined) continue;
      append(names, word.named);
      if ((word.raw.match(SET_VARIABLE)?.length ?? 0) > word.calls || computedEnv(word)) fails = true;
      const role = roles === false ? undefined : roles?.get(word);
      for (const value of word.values) {
        const drive = value === undefined ? null : ENV_PATH.exec(value);
        if (role === 'name') {
          if (value === undefined || /[*?[]/u.test(value)) fails = true;
          else append(names, segments(drive === null ? value : value.slice(drive[0].length)));
          continue;
        }
        if ((role === 'path' || role === 'literal') && value === undefined) fails = true;
        const relative = onDrive && (role === 'path' || role === 'literal') && value !== undefined && drive === null;
        if (value === undefined || (drive === null && !relative)) continue;
        const parts = segments(drive === null ? value : value.slice(drive[0].length));
        if (role === 'path' && cmdlet?.writes === true && parts.some((part) => /[*?[]/u.test(part))) fails = true;
        append(names, parts);
      }
    }
    if (fails) unresolved ??= command.text;
  }
  return unresolved === undefined ? { names } : { names, unresolved };
}
