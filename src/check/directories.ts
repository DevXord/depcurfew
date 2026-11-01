// Which directory each install of a command line runs in, for the install guard (decision D-118). A command line may
// change directory before it installs (cd pkgs/strict && npm i x), and the hook checks the install with the policy of
// that directory. The scanner in command.ts reads the commands; this module knows the commands that change directory
// and how far a change reaches:
//
// - POSIX shells: cd, pushd, popd (bash) and chdir (zsh), with cd - and popd going back. A subshell ( … ), a command
//   substitution, sh -c and the other shells a command starts end the change; eval and an alias run in the shell
//   itself. A command in the background or in a pipeline runs in a subshell. sudo, env and the other wrappers cannot
//   run cd, which is a builtin of the shell, so it changes nothing there.
// - PowerShell: Set-Location (cd, chdir, sl), Push-Location (pushd) and Pop-Location (popd), with -Path and
//   -LiteralPath; the location belongs to the whole session, so a change inside brackets makes it unknown.
// - cmd.exe: cd and chdir (with /d), pushd and popd; & runs the next command in the same shell.
//
// Whatever cannot be read makes the directory unknown, with the reason: a directory the shell expands ("$DIR", ~, a
// glob), cd without one (the home directory), cd - or popd to a directory from before the command line, CDPATH, and a
// change in a loop, a function, one branch of if or case, or a pipeline. The caller asks about an install whose
// directory is unknown. Facts about the shells stay in code (decision D-077), as in command.ts; the behaviour was
// checked against GNU bash 5.2 and the PowerShell reference (MicrosoftDocs/PowerShell-Docs, reference/7.5).
//
// A change of directory the shell makes fails, and leaves the shell where it was, when the directory does not exist:
// such steps are marked `entered`, and the hook checks them on disk, unless a mkdir earlier on the line creates the
// directory. cd -P, set -P and set -o physical resolve the path through symlinks (`physical`). OLDPWD (cd -), PWD
// (relative cd) and DIRSTACK (popd) set or unset on the line make those changes unknown (decision D-119).
import { isAbsolute, posix } from 'node:path';
import type { Word } from './command.ts';

/**
 * Where a command runs, relative to the directory the command line starts in: the directories it changes to, in order
 * (an absolute one starts over), or why that cannot be told. `localPrefix`: npm --prefix names npm's local prefix,
 * whose .npmrc npm reads without looking for a package.json above it. `entered`: the indexes of the steps that the
 * shell changes to (cd, pushd, Set-Location), which fail and leave the shell where it was when the directory does not
 * exist, so the hook checks that it does (decision D-119); a directory that a mkdir earlier on the line creates is left
 * out. `physical`: the indexes of the steps resolved through symlinks (cd -P, set -P), as the system resolves them.
 */
export type CommandDirectory = { steps: readonly string[]; localPrefix?: true; entered?: readonly number[]; physical?: readonly number[] } | { unknown: string };

/** The directory the command line starts in. */
export const HERE: CommandDirectory = { steps: [] };

/** The most changes of directory one command line may make before the directory counts as unknown. */
const MAX_STEPS = 64;

/**
 * A change of directory by one command: cd, cd -, pushd (with no path, Push-Location keeps the location), popd, and
 * set -P or set +P, which make later changes resolve the path physically or not. `physical`: cd -P or cd -L chose.
 */
export type Move =
  | { kind: 'cd'; path: string; physical?: boolean }
  | { kind: 'back'; command: string }
  | { kind: 'push'; path: string | undefined }
  | { kind: 'pop'; command: string }
  | { kind: 'mode'; physical: boolean }
  | { kind: 'unknown'; reason: string };

/** Indexes of steps after `offset` more steps, from `from` on. */
function shifted(indexes: readonly number[] | undefined, offset: number, from = 0): number[] {
  return (indexes ?? []).filter((index) => index >= from).map((index) => index + offset);
}

/** A directory with its entered and physical steps, each left out when empty. */
function directoryOf(steps: readonly string[], entered: readonly number[], physical: readonly number[], local: { localPrefix?: true }): CommandDirectory {
  return { steps, ...local, ...(entered.length === 0 ? {} : { entered }), ...(physical.length === 0 ? {} : { physical }) };
}

/** `inner`, a directory relative to `outer`, as a directory relative to where `outer` is relative to. */
export function within(outer: CommandDirectory, inner: CommandDirectory): CommandDirectory {
  if ('unknown' in inner) return inner;
  const restart = inner.steps.findLastIndex((step) => isAbsolute(step));
  // The command runs in the directory of `outer` itself (npm --prefix sub): npm's local prefix stays the one given.
  const own = inner.steps.length === 0 && !('unknown' in outer) ? outer.localPrefix === true : inner.localPrefix === true;
  const local = own ? { localPrefix: true as const } : {};
  if (restart !== -1) return directoryOf(inner.steps.slice(restart), shifted(inner.entered, -restart, restart), shifted(inner.physical, -restart, restart), local);
  if ('unknown' in outer) return outer;
  const steps = [...outer.steps, ...inner.steps];
  if (steps.length > MAX_STEPS) return { unknown: `depcurfew follows at most ${MAX_STEPS} changes of directory in one command` };
  const offset = outer.steps.length;
  return directoryOf(steps, [...shifted(outer.entered, 0), ...shifted(inner.entered, offset)], [...shifted(outer.physical, 0), ...shifted(inner.physical, offset)], local);
}

/** Whether a directory is the one the command line starts in, as it is written. */
export function isHere(directory: CommandDirectory | undefined): boolean {
  return directory === undefined || (!('unknown' in directory) && directory.steps.length === 0 && directory.localPrefix !== true);
}

/** Reserved words that may stand before a command. */
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc', 'time']);

const GOES_BACK = 'goes back to a directory from before this command, which depcurfew cannot see';
const EXPANDS = 'the shell expands the directory of';

/** A command for messages, cut short when it is long. */
function shown(words: readonly Word[]): string {
  // Reserved words before a command are not part of it: { cd a; } is cd a.
  const start = words.findIndex((word) => word.dynamic || !RESERVED.has(word.text));
  const line = words
    .slice(start === -1 ? words.length : start)
    .map((word) => word.text)
    .join(' ');
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * A directory as a key, relative to the start of the line, to compare the directory a cd enters with those a mkdir
 * creates; undefined when it cannot be told or depends on symlinks.
 */
function keyOf(directory: CommandDirectory): string | undefined {
  if ('unknown' in directory || (directory.physical?.length ?? 0) > 0) return undefined;
  return posix.resolve('/', ...directory.steps);
}

/** The directories of a shell while a command line runs: where it is, where cd - goes, and the stack of pushd. */
export class ShellDirectories {
  place: CommandDirectory = HERE;
  /** undefined: cd - would go to a directory from before the command line. */
  previous: CommandDirectory | undefined;
  stack: CommandDirectory[] = [];
  /** set -P or set -o physical: cd resolves the path through symlinks. */
  physical = false;
  /** The directories a mkdir on the line creates (keyOf), shared by every scope: the file system is the same. */
  created = new Set<string>();

  copy(): ShellDirectories {
    const copy = new ShellDirectories();
    copy.place = this.place;
    copy.previous = this.previous;
    copy.stack = [...this.stack];
    copy.physical = this.physical;
    copy.created = this.created;
    return copy;
  }

  /** The directory a change to `path` enters, which must exist unless a mkdir on the line creates it (decision D-119). */
  private enter(from: CommandDirectory, path: string, physical: boolean): CommandDirectory {
    const target = within(from, { steps: [path] });
    const key = physical ? undefined : keyOf(target);
    const created = key !== undefined && this.created.has(key);
    return within(from, { steps: [path], ...(created ? {} : { entered: [0] }), ...(physical ? { physical: [0] } : {}) });
  }

  apply(move: Move): void {
    const from = this.place;
    if (move.kind === 'mode') {
      this.physical = move.physical;
      return;
    }
    if (move.kind === 'cd') {
      this.place = this.enter(from, move.path, move.physical ?? this.physical);
    } else if (move.kind === 'back') {
      this.place = this.previous ?? { unknown: `"${move.command}" ${GOES_BACK}` };
    } else if (move.kind === 'push') {
      this.stack.push(from);
      if (move.path === undefined) return;
      this.place = this.enter(from, move.path, this.physical);
    } else if (move.kind === 'pop') {
      this.place = this.stack.pop() ?? { unknown: `"${move.command}" ${GOES_BACK}` };
    } else {
      this.place = { unknown: move.reason };
    }
    this.previous = from;
  }

  /** mkdir: the directories it creates where the shell is; with -p (`parents`) also each directory above them. */
  create(paths: readonly string[], parents: boolean): void {
    for (const path of paths) {
      const parts = path.split('/').filter((part) => part !== '' && part !== '.');
      const prefix = isAbsolute(path) ? ['/'] : [];
      for (let length = parents ? 1 : parts.length; length <= parts.length; length++) {
        const key = keyOf(within(this.place, { steps: [[...prefix, ...parts.slice(0, length)].join('/') || '/'] }));
        if (key !== undefined) this.created.add(key);
      }
    }
  }
}

/** Variables the command line sets that change where cd goes: CDPATH, OLDPWD (cd -), PWD and DIRSTACK (popd). */
export interface ShellVariables {
  cdPath: boolean;
  oldPwd: boolean;
  pwd: boolean;
  dirStack: boolean;
}

/** A name as written on a line, but not as an expansion ($OLDPWD, ${PWD}, ${#DIRSTACK}): set, unset, exported or read into. */
function named(line: string, name: string): boolean {
  return new RegExp(`(?<!\\$\\{?[#!]?)\\b${name}\\b`, 'u').test(line);
}

/** The variables a command line names that change where cd goes; CDPATH counts wherever it is named. */
export function shellVariables(line: string): ShellVariables {
  return { cdPath: /\bCDPATH\b/u.test(line), oldPwd: named(line, 'OLDPWD'), pwd: named(line, 'PWD'), dirStack: named(line, 'DIRSTACK') };
}

/** The shells whose command lines the scanner reads. */
type Shell = 'posix' | 'powershell' | 'cmd';

/** Why a directory cannot be told, as one move. */
function unknownMove(reason: string): Move[] {
  return [{ kind: 'unknown', reason }];
}

/** Whether the path of a POSIX cd or pushd is written out: not expanded, not relative to a home directory. */
function posixPath(word: Word, words: readonly Word[]): Move[] | undefined {
  if (word.dynamic || word.input === true) return unknownMove(`${EXPANDS} "${shown(words)}"`);
  if (word.text === '') return unknownMove(`depcurfew does not read "${shown(words)}", which names no directory`);
  if (word.text === '~') return unknownMove(`"${shown(words)}" goes to the home directory`);
  if (word.text.startsWith('~')) return unknownMove(`"${shown(words)}" is relative to a home directory, which depcurfew does not look at`);
  return undefined;
}

/**
 * set -P, set -o physical and their + forms: whether later changes of directory resolve the path physically; undefined
 * when the command changes neither (set -e, set -- -P).
 */
function physicalMode(words: readonly Word[]): Move[] | undefined {
  let physical: boolean | undefined;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (word.dynamic || word.text === '--' || word.text === '-' || !/^[-+][A-Za-z]+$/u.test(word.text)) break;
    const on = word.text.startsWith('-');
    if (word.text.includes('P')) physical = on;
    // -o takes the name of an option as the next word (set -euo pipefail).
    if (word.text.includes('o')) {
      if (words[index + 1]?.text === 'physical') physical = on;
      index += 1;
    }
  }
  return physical === undefined ? undefined : [{ kind: 'mode', physical }];
}

/** cd, pushd, popd and chdir of bash and zsh: the moves, [] when nothing changes, undefined for another command. */
function posixChange(words: readonly Word[], builtin: boolean, variables: ShellVariables): Move[] | undefined {
  const name = words[0]?.text ?? '';
  if (name === 'set') return builtin ? physicalMode(words) : undefined;
  if (!['cd', 'chdir', 'pushd', 'popd'].includes(name)) return undefined;
  // sudo cd, env cd: cd is a builtin of the shell, so the command fails and the directory stays.
  if (!builtin) return [];
  const operands: Word[] = [];
  let options = true;
  /** cd -P resolves the path physically, cd -L logically; the last of them counts. */
  let physical: boolean | undefined;
  for (const word of words.slice(1)) {
    if (options && !word.dynamic && word.text === '--') {
      options = false;
      continue;
    }
    // cd -L, -P, -e and -@ change how links are followed, not which directory it is.
    if (options && !word.dynamic && name !== 'pushd' && name !== 'popd' && /^-[LPe@]+$/u.test(word.text)) {
      const last = word.text.match(/[LP]/gu)?.at(-1);
      if (last !== undefined) physical = last === 'P';
      continue;
    }
    if (options && !word.dynamic && word.text.length > 1 && /^[-+]/u.test(word.text)) {
      return unknownMove(`depcurfew does not read the option "${word.text}" of "${shown(words)}"`);
    }
    options = false;
    operands.push(word);
  }
  if (operands.length > 1) return unknownMove(`depcurfew does not read "${shown(words)}", which names more than one directory`);
  const operand = operands[0];
  if (name === 'popd') {
    return variables.dirStack ? unknownMove(`"${shown(words)}" goes back to a directory of DIRSTACK, which the command changes`) : [{ kind: 'pop', command: shown(words) }];
  }
  if (operand === undefined) {
    return name === 'pushd'
      ? unknownMove(`depcurfew does not read "${shown(words)}" without a directory, which swaps the top two directories of its stack`)
      : unknownMove(`"${shown(words)}" goes to the home directory`);
  }
  const unread = posixPath(operand, words);
  if (unread !== undefined) return unread;
  if (operand.text === '-') {
    if (name === 'pushd') return unknownMove(`depcurfew does not read "${shown(words)}"`);
    // cd - goes to $OLDPWD, which an assignment or unset on the line changes.
    return variables.oldPwd ? unknownMove(`"${shown(words)}" goes to the directory in OLDPWD, which the command sets or unsets`) : [{ kind: 'back', command: shown(words) }];
  }
  if (!isAbsolute(operand.text)) {
    // Shells other than bash take a relative directory from $PWD, which the command sets.
    if (variables.pwd) return unknownMove(`"${shown(words)}" is relative to the working directory, and the command sets PWD`);
    // CDPATH makes cd look for a relative directory in the directories it names first.
    if (variables.cdPath && !/^\.\.?(?:\/|$)/u.test(operand.text)) return unknownMove(`CDPATH is set, so "${shown(words)}" may go to a directory that CDPATH names`);
  }
  return [name === 'pushd' ? { kind: 'push', path: operand.text } : { kind: 'cd', path: operand.text, ...(physical === undefined ? {} : { physical }) }];
}

/** mkdir of a POSIX shell, PowerShell (mkdir, md) or cmd (mkdir, md): the directories it creates; undefined for another command. */
export function createdDirectories(words: readonly Word[], shell: Shell): { paths: string[]; parents: boolean } | undefined {
  const head = (words[0]?.text ?? '').toLowerCase();
  if (words[0]?.dynamic !== false || !(head === 'mkdir' || (shell !== 'posix' && head === 'md'))) return undefined;
  const paths: string[] = [];
  // PowerShell's mkdir and cmd's md create the directories above too, as mkdir -p does.
  let parents = shell !== 'posix';
  let options = true;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (word.dynamic) continue;
    if (options && word.text === '--') {
      options = false;
    } else if (options && shell === 'posix' && /^-[^-]/u.test(word.text)) {
      // One-letter options together; -m MODE takes the rest of the word or the next word.
      for (const [at, letter] of [...word.text.slice(1)].entries()) {
        if (letter === 'p') parents = true;
        if (letter === 'm') {
          if (at === word.text.length - 2) index += 1;
          break;
        }
      }
    } else if (options && shell === 'posix' && word.text.startsWith('--')) {
      if ('--parents'.startsWith(word.text) && word.text.length > 3) parents = true;
      if (word.text === '--mode') index += 1;
    } else if (options && shell !== 'posix' && /^[-/]/u.test(word.text) && word.text.length > 1) {
      // -Path is followed by the path; other parameters of New-Item and switches of md name no directory.
      if (/^-p(?:a(?:t(?:h)?)?)?$/iu.test(word.text)) {
        const value = words[++index];
        if (value !== undefined && !value.dynamic) paths.push(normalized(value.text));
      }
    } else {
      paths.push(shell === 'posix' ? word.text : normalized(word.text));
    }
  }
  return { paths, parents };
}

/** A path of PowerShell or cmd, which take \ as a separator on every system, with /. */
function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Parameters of Set-Location, Push-Location and Pop-Location by name and alias, with the parameter each stands for. */
const LOCATION_PARAMETERS: Readonly<Record<string, string>> = {
  path: 'path',
  literalpath: 'literalpath',
  pspath: 'literalpath',
  lp: 'literalpath',
  passthru: 'passthru',
  stackname: 'stackname',
};

/** A parameter as PowerShell resolves it: a name, an alias, or a prefix of only one of them; undefined when ambiguous or unknown. */
function locationParameter(given: string): string | undefined {
  const exact = LOCATION_PARAMETERS[given];
  if (exact !== undefined) return exact;
  const matches = new Set(Object.entries(LOCATION_PARAMETERS).flatMap(([name, parameter]) => (name.startsWith(given) ? [parameter] : [])));
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** The commands of PowerShell that change the location, by name and alias (cd.. and cd\ are functions with a path). */
const POWERSHELL_LOCATIONS: Readonly<Record<string, 'set' | 'push' | 'pop'>> = {
  'set-location': 'set',
  cd: 'set',
  chdir: 'set',
  sl: 'set',
  'push-location': 'push',
  pushd: 'push',
  'pop-location': 'pop',
  popd: 'pop',
};

/** Set-Location, Push-Location and Pop-Location: the moves, [] when nothing changes, undefined for another command. */
function powerShellChange(words: readonly Word[], builtin: boolean): Move[] | undefined {
  const head = (words[0]?.text ?? '').toLowerCase();
  const functions: Readonly<Record<string, string>> = { 'cd..': '..', 'cd\\': '/' };
  if (Object.hasOwn(functions, head)) return builtin ? [{ kind: 'cd', path: functions[head] as string }] : [];
  const kind = Object.hasOwn(POWERSHELL_LOCATIONS, head) ? POWERSHELL_LOCATIONS[head] : undefined;
  if (kind === undefined) return undefined;
  if (!builtin) return [];
  let path: Word | undefined;
  let literal = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] as Word;
    if (!word.dynamic && /^-[A-Za-z]/u.test(word.text)) {
      const colon = word.text.indexOf(':');
      const given = (colon === -1 ? word.text.slice(1) : word.text.slice(1, colon)).toLowerCase();
      const parameter = locationParameter(given);
      if (parameter === 'passthru') continue;
      if ((parameter === 'path' || parameter === 'literalpath') && kind !== 'pop') {
        const value = colon === -1 ? words[++index] : { text: word.text.slice(colon + 1), dynamic: false };
        if (value === undefined || path !== undefined) return unknownMove(`depcurfew does not read "${shown(words)}"`);
        path = value;
        literal = parameter === 'literalpath';
        continue;
      }
      return unknownMove(`depcurfew does not read the parameter "${word.text}" of "${shown(words)}"`);
    }
    if (path !== undefined || kind === 'pop') return unknownMove(`depcurfew does not read "${shown(words)}"`);
    path = word;
  }
  if (kind === 'pop') return [{ kind: 'pop', command: shown(words) }];
  // Push-Location alone pushes the location without changing it; Set-Location alone goes to the home directory.
  if (path === undefined) return kind === 'push' ? [{ kind: 'push', path: undefined }] : unknownMove(`"${shown(words)}" goes to the home directory`);
  const unread = posixPath(path, words);
  if (unread !== undefined) return unread;
  if (kind === 'set' && path.text === '-') return [{ kind: 'back', command: shown(words) }];
  if (path.text === '-' || path.text === '+') return unknownMove(`depcurfew does not read "${shown(words)}", which moves through the location history`);
  if (!literal && /[*?[]/u.test(path.text)) return unknownMove(`"${shown(words)}" has a wildcard, which PowerShell resolves to a matching directory`);
  // Env:, HKLM:\, C: (the current location of a drive), FileSystem::C:\x: other providers, or a drive's own location.
  if (/^[A-Za-z][A-Za-z0-9_.-]+:/u.test(path.text) || path.text.includes('::') || /^[A-Za-z]:$/u.test(path.text)) {
    return unknownMove(`depcurfew does not read the location "${path.text}" of "${shown(words)}", which may not be a directory`);
  }
  // PowerShell takes \ and / as separators on every system (decision D-119).
  const location = normalized(path.text);
  return [kind === 'push' ? { kind: 'push', path: location } : { kind: 'cd', path: location }];
}

/** cd, chdir, pushd and popd of cmd.exe: cd alone shows the directory, /d also changes the drive. */
function cmdChange(words: readonly Word[]): Move[] | undefined {
  const head = (words[0]?.text ?? '').toLowerCase();
  if (head === 'cd..' || head === 'chdir..') return [{ kind: 'cd', path: '..' }];
  if (!['cd', 'chdir', 'pushd', 'popd'].includes(head)) return undefined;
  if (head === 'popd') return [{ kind: 'pop', command: shown(words) }];
  const rest = words.slice(1);
  const drive = head !== 'pushd' && rest[0] !== undefined && !rest[0].dynamic && rest[0].text.toLowerCase() === '/d';
  const parts = drive ? rest.slice(1) : rest;
  if (parts.length === 0 || parts[0]?.text.startsWith('/') === true) return [];
  const expanded = parts.find((word) => word.dynamic);
  if (expanded !== undefined) return unknownMove(`${EXPANDS} "${shown(words)}"`);
  // With command extensions, cd takes the rest of the line as the path, spaces included.
  const path = normalized(parts.map((word) => word.text).join(' '));
  if (head !== 'pushd' && !drive && /^[A-Za-z]:/u.test(path)) return unknownMove(`"${shown(words)}" without /d changes the directory of that drive only`);
  return [head === 'pushd' ? { kind: 'push', path } : { kind: 'cd', path }];
}

/**
 * How a simple command changes the directory of the shell that runs it: undefined when it is no such command, [] when
 * it is one that changes nothing (sudo cd). `builtin`: no wrapper such as sudo or env runs it; `variables`: what the
 * command line sets of CDPATH, OLDPWD, PWD and DIRSTACK.
 */
export function directoryChange(words: readonly Word[], shell: Shell, builtin: boolean, variables: ShellVariables): Move[] | undefined {
  const first = words[0];
  if (first === undefined || first.dynamic) return undefined;
  if (shell === 'powershell') return powerShellChange(words, builtin);
  if (shell === 'cmd') return cmdChange(words);
  return posixChange(words, builtin, variables);
}

/** An install or an override whose directory is being worked out. */
export interface Placed {
  directory?: CommandDirectory;
}

/** A loop, function body, branch of if or case, or { … } group that is open while the commands of a line are read. */
interface Frame {
  kind: 'loop' | 'function' | 'branch' | 'group';
  /** The installs and overrides inside it, which become unknown when a loop or function changes directory. */
  placed: Placed[];
  /** Why the directory is unknown after it, when a command inside changed directory. */
  moved?: string;
  /** For a function body in ( … ): the depth of its subshell, which ends it. */
  scope?: number;
  /** A case statement, whose patterns end with a ) that closes no subshell. */
  case?: boolean;
  /** A { … } group: the directories when it starts, and whether it is part of a pipeline (so runs in a subshell). */
  start?: ShellDirectories;
  piped?: boolean;
}

/** What separates a simple command from the commands around it. */
export interface CommandBounds {
  /** The operators between the previous command and this one ((, ), &&, ;, a newline, …). */
  before: readonly string[];
  /** The operator that ends it; undefined at the end of the line. */
  after: string | undefined;
}

const LOOP_STARTS = new Set(['while', 'until', 'for', 'select']);
/** How many loops, functions, branches and groups nested in one another are followed; deeper, the directory is unknown. */
const MAX_FRAMES = 64;
const TOO_DEEP = `depcurfew does not follow loops, functions and branches nested more than ${MAX_FRAMES} levels deep`;

/**
 * The directories of the shell as the simple commands of one line run, in order (decision D-118): what the commands
 * change, the scope of subshells, and loops, functions and branches, inside which a change makes the directory
 * unknown. `moves` are the changes that reach the shell that runs the line (for eval and aliases).
 */
export class DirectoryWalk {
  private state = new ShellDirectories();
  private readonly scopes: ShellDirectories[] = [];
  private readonly frames: Frame[] = [];
  /** Installs in function bodies: they run where the function is called. */
  private readonly inFunctions: Placed[] = [];
  private pendingFunction = false;
  private lastWords: readonly Word[] = [];
  private changed = false;
  /** Frames opened beyond MAX_FRAMES, which are not followed. */
  private overflow = 0;
  readonly moves: Move[] = [];
  /** Installs and overrides of a trap set earlier on the line, which a later change of directory moves (decision D-119). */
  private readonly trapped: Placed[] = [];

  private readonly shell: Shell;

  constructor(shell: Shell) {
    this.shell = shell;
  }

  /** Where the next command runs, relative to the start of the line. */
  get place(): CommandDirectory {
    return this.state.place;
  }

  /** The operators and reserved words before a command: subshells, loops, functions, branches. */
  begin(words: readonly Word[], bounds: CommandBounds): void {
    if (this.shell === 'posix') {
      const operators = bounds.before;
      // name ( ) defines a function whose body follows.
      const named = this.lastWords.length === 1 || (this.lastWords.length === 2 && this.lastWords[0]?.text === 'function');
      const header = named && operators[0] === '(' && operators[1] === ')';
      if (header) this.pendingFunction = true;
      // In a case statement, a pattern ends with a ) that closes no subshell.
      const inCase = this.frames.at(-1)?.case === true;
      for (const operator of header ? operators.slice(2) : operators) {
        if (operator === ';;') this.branchEnd();
        else if (inCase) continue;
        else if (operator === '(') this.open();
        else if (operator === ')' && this.scopes.length > 0) this.close();
      }
      this.keywords(words, bounds);
    }
    this.lastWords = words;
  }

  private push(frame: Frame): void {
    if (this.frames.length >= MAX_FRAMES) this.overflow += 1;
    else this.frames.push(frame);
  }

  private open(): void {
    this.scopes.push(this.state.copy());
    if (this.pendingFunction) {
      this.push({ kind: 'function', placed: [], scope: this.scopes.length });
      this.pendingFunction = false;
    }
  }

  private close(): void {
    const depth = this.scopes.length;
    while (this.frames.at(-1)?.scope === depth) this.end(this.frames.pop() as Frame);
    this.state = this.scopes.pop() ?? this.state;
  }

  /** The reserved words a command starts with. */
  private keywords(words: readonly Word[], bounds: CommandBounds): void {
    const piped = (operator: string | undefined) => operator === '|' || operator === '|&';
    for (let index = 0; index < words.length; index++) {
      const word = words[index] as Word;
      if (word.dynamic) return;
      const text = word.text;
      if (LOOP_STARTS.has(text)) {
        this.push({ kind: 'loop', placed: [] });
        if (text === 'for' || text === 'select') return;
      } else if (text === 'if') {
        this.push({ kind: 'branch', placed: [] });
      } else if (text === 'case') {
        this.push({ kind: 'branch', placed: [], case: true });
        return;
      } else if (text === 'else' || text === 'elif') {
        this.branchEnd();
      } else if (text === 'done' || text === 'fi' || text === 'esac' || text === '}') {
        if (this.overflow > 0) {
          this.overflow -= 1;
          continue;
        }
        const kinds = text === 'done' ? ['loop'] : text === '}' ? ['function', 'group'] : ['branch'];
        const at = this.frames.findLastIndex((frame) => kinds.includes(frame.kind));
        if (at === -1) continue;
        for (const frame of this.frames.splice(at).reverse()) {
          this.end(frame);
          // { cd a; } | tee log: a group in a pipeline runs in a subshell, so its changes stay inside it.
          if (frame.kind === 'group' && frame.start !== undefined && (frame.piped === true || piped(bounds.after))) this.state = frame.start;
        }
      } else if (text === '{') {
        const group = this.pendingFunction ? {} : { start: this.state.copy(), piped: bounds.before.some(piped) };
        this.push({ kind: this.pendingFunction ? 'function' : 'group', placed: [], ...group });
        this.pendingFunction = false;
      } else if (text === 'function') {
        this.pendingFunction = true;
        index += 1;
      } else if (text !== 'then' && text !== 'do' && text !== '!') {
        return;
      }
    }
  }

  /** The end of one branch of if or case: a change inside it may not have happened. */
  private branchEnd(): void {
    const branch = this.frames.findLast((frame) => frame.kind === 'branch');
    if (branch?.moved === undefined) return;
    this.unknown(branch.moved);
    delete branch.moved;
  }

  private end(frame: Frame): void {
    if (frame.moved === undefined) return;
    if (frame.kind === 'loop' || frame.kind === 'function') {
      // A later round of the loop, or a later call, runs these after the change.
      for (const entry of frame.placed) entry.directory = { unknown: frame.moved };
    }
    if (frame.kind !== 'group') this.unknown(frame.moved);
  }

  private unknown(reason: string): void {
    const move: Move = { kind: 'unknown', reason };
    this.state.apply(move);
    if (this.scopes.length === 0) this.moves.push(move);
  }

  /**
   * Installs and overrides of the command just read, relative to the command: they now run where the shell is. Those
   * of a trap (`trapped`) run later, when the shell exits or gets a signal, so a later change of directory makes their
   * directory unknown (decision D-119).
   */
  placed(entries: readonly Placed[], trapped: (entry: Placed) => boolean = () => false): void {
    for (const entry of entries) {
      entry.directory = this.overflow > 0 ? { unknown: TOO_DEEP } : within(this.state.place, entry.directory ?? HERE);
      for (const frame of this.frames) frame.placed.push(entry);
      if (this.frames.some((frame) => frame.kind === 'function')) this.inFunctions.push(entry);
      if (trapped(entry)) this.trapped.push(entry);
    }
  }

  /** A change of directory: the installs and overrides of a trap set earlier run after it, so in a directory not known. */
  private later(): void {
    for (const entry of this.trapped.splice(0)) entry.directory = { unknown: 'it runs from a trap, when the shell exits or gets a signal, after the command changes directory' };
  }

  /** mkdir: the directories it creates where the shell is, so that a cd into one of them need not find it (decision D-119). */
  create(paths: readonly string[], parents: boolean): void {
    this.state.create(paths, parents);
  }

  /** The changes a command makes, applied where they reach: not from the background, not in loops, functions or pipelines. */
  changes(moves: readonly Move[], words: readonly Word[], bounds: CommandBounds): void {
    if (moves.length === 0) return;
    this.changed = true;
    const command = shown(words);
    // POSIX shells and PowerShell run a command in the background in a subshell or a job of its own; cmd's & does not.
    if (bounds.after === '&' && this.shell !== 'cmd') return;
    this.later();
    const piped = bounds.after === '|' || bounds.after === '|&' || bounds.before.includes('|') || bounds.before.includes('|&');
    if (piped) return this.unknown(`"${command}" runs in a pipeline, where it may or may not change the directory of the shell`);
    if (this.overflow > 0) return this.unknown(TOO_DEEP);
    const repeated = this.frames.findLast((frame) => frame.kind === 'loop' || frame.kind === 'function');
    if (repeated !== undefined) {
      const reason =
        repeated.kind === 'loop' ? `"${command}" runs in a loop, so later rounds start in another directory` : `"${command}" runs in a function, so the directory depends on where and how often it is called`;
      for (const frame of this.frames) if (frame.kind !== 'group') frame.moved ??= reason;
      return this.unknown(reason);
    }
    for (const frame of this.frames) if (frame.kind === 'branch') frame.moved ??= `"${command}" runs only in one branch of if or case, so later commands may run in either directory`;
    for (const move of moves) {
      this.state.apply(move);
      if (this.scopes.length === 0) this.moves.push(move);
    }
  }

  /** A change inside a command line that runs in the same PowerShell session, inside brackets: it may or may not run. */
  nestedChange(line: string): void {
    this.changed = true;
    this.later();
    const text = line.length > 120 ? `${line.slice(0, 120)}…` : line;
    this.unknown(`the location changes inside brackets ("${text.trim()}"), which may or may not run`);
  }

  /** The end of the line: installs in a function body run where it is called, which a change of directory makes unknown. */
  finish(): void {
    while (this.scopes.length > 0) this.close();
    for (const frame of this.frames.splice(0).reverse()) this.end(frame);
    if (!this.changed) return;
    for (const entry of this.inFunctions) if (entry.directory === undefined || !('unknown' in entry.directory)) entry.directory = { unknown: 'it is in a function body, which runs where the function is called' };
  }
}
