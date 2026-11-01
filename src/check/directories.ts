// Which directory each install of a command line runs in, for the install guard (decision D-118). A command line may
// change directory before it installs (cd pkgs/strict && npm i x), and the hook checks the install with the policy of
// that directory. The scanner in command.ts reads the commands; this module knows the commands that change directory
// and how far a change reaches:
//
// - POSIX shells: cd, pushd, popd and dirs -c (bash) and chdir (zsh), with cd - and popd going back. A subshell ( … ), a
//   command substitution, sh -c and the other shells a command starts end the change; eval and an alias run in the
//   shell itself. A command in the background or in a pipeline runs in a subshell. sudo, env and the other wrappers
//   cannot run cd, which is a builtin of the shell, so it changes nothing there.
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
// (relative cd) and DIRSTACK (popd) set or unset on the line make those changes unknown (decision D-119), and so does a
// builtin that may set a variable whose name the shell builds (decision D-123).
//
// The stack of pushd is followed as bash keeps it (decision D-123, bash manual "Directory Stack Builtins"): pushd dir,
// pushd -n dir (only the stack), pushd without a directory (swaps the top two), pushd +N and -N (rotate), popd, popd -n,
// popd +N and -N (remove one), dirs -c (empties it); a popd or pushd that finds no directory fails and changes nothing.
// What was on the stack before the command line is not known. The stack is shared between the copies a subshell makes
// and holds at most MAX_STACK directories known to depcurfew. A directory that cd - or popd leave, or that cd /path
// leaves behind, must have been entered for OLDPWD and the stack to be as followed, so the hook checks it too
// (`assumes`). A trap on DEBUG, ERR, RETURN or a signal that changes directory, a file run with . or source, and a
// function whose body changes directory make the directory of every later command unknown (`lasting`).
import { isAbsolute, posix } from 'node:path';
import type { Word } from './command.ts';

/**
 * Where a command runs, relative to the directory the command line starts in: the directories it changes to, in order
 * (an absolute one starts over). `localPrefix`: npm --prefix names npm's local prefix, whose .npmrc npm reads without
 * looking for a package.json above it. `entered`: the indexes of the steps that the shell changes to (cd, pushd,
 * Set-Location), which fail and leave the shell where it was when the directory does not exist, so the hook checks that
 * it does (decision D-119); a directory that a mkdir earlier on the line creates is left out. `physical`: the indexes of
 * the steps resolved through symlinks (cd -P, set -P), as the system resolves them. `assumes`: directories the shell
 * changed to earlier on the line and left again (cd -, popd, cd /path), each of which must exist for this directory to
 * be right, as a change that fails leaves OLDPWD and the stack of pushd as they were (decision D-123); the hook checks
 * their entered steps too.
 */
export interface KnownDirectory {
  steps: readonly string[];
  localPrefix?: true;
  entered?: readonly number[];
  physical?: readonly number[];
  assumes?: readonly KnownDirectory[];
}

/** A directory as KnownDirectory gives it, or why it cannot be told. */
export type CommandDirectory = KnownDirectory | { unknown: string };

/** The directory the command line starts in. */
export const HERE: CommandDirectory = { steps: [] };

/** The most changes of directory one command line may make before the directory counts as unknown. */
const MAX_STEPS = 64;
/** The most directories on the stack of pushd that depcurfew follows; below them the stack is unknown (decision D-123). */
const MAX_STACK = 64;
/** The most directories that an install's directory assumes were entered (`assumes`); more make it unknown. */
const MAX_ASSUMED = 16;

/** Why a relative directory that the shell finds when it gets to it (pushd -n) cannot be followed, by the variables of the line. */
export interface RelativeDoubt {
  variables: ShellVariables;
}

/**
 * A change of directory by one command (decision D-123 for the stack): cd; cd - (`back`, with `push` for pushd -);
 * pushd dir (`keep`: pushd -n, which only puts dir on the stack; no path: Push-Location alone, which pushes the location
 * without changing it); pushd without a directory (`swap`); pushd +N or -N (`rotate`, `fromRight` for -N); popd with
 * +N or -N (`count`); dirs -c (`clear`); set -P or set +P (`mode`), which make later changes resolve the path physically
 * or not. `physical`: cd -P or cd -L chose. `stack`: the stack of pushd is unknown too. `lasting`: the directory of every
 * later command is unknown, whatever changes it later. `doubt`: the variables of the line, for a directory pushd -n put
 * on the stack, which the shell finds relative to where it is when it gets to it.
 */
export type Move =
  | { kind: 'cd'; path: string; physical?: boolean }
  | { kind: 'back'; command: string; push?: true }
  | { kind: 'push'; path: string | undefined; keep?: true }
  | { kind: 'swap'; command: string; doubt?: RelativeDoubt }
  | { kind: 'rotate'; command: string; count: number; fromRight: boolean; keep: boolean; doubt?: RelativeDoubt }
  | { kind: 'pop'; command: string; count?: number; fromRight?: boolean; keep?: boolean; doubt?: RelativeDoubt }
  | { kind: 'clear' }
  | { kind: 'mode'; physical: boolean }
  | { kind: 'unknown'; reason: string; stack?: true; lasting?: true };

/** Indexes of steps after `offset` more steps, from `from` on. */
function shifted(indexes: readonly number[] | undefined, offset: number, from = 0): number[] {
  return (indexes ?? []).filter((index) => index >= from).map((index) => index + offset);
}

/** A directory with its entered and physical steps and what it assumes, each left out when empty. */
function directoryOf(steps: readonly string[], entered: readonly number[], physical: readonly number[], local: { localPrefix?: true }, assumes: readonly KnownDirectory[] = []): CommandDirectory {
  return {
    steps,
    ...local,
    ...(entered.length === 0 ? {} : { entered }),
    ...(physical.length === 0 ? {} : { physical }),
    ...(assumes.length === 0 ? {} : { assumes }),
  };
}

/** Whether a directory is the one it is relative to, with nothing to check: within() then gives the other one as it is. */
function bare(directory: KnownDirectory): boolean {
  return directory.steps.length === 0 && directory.localPrefix !== true && directory.assumes === undefined && directory.entered === undefined && directory.physical === undefined;
}

function withoutAssumes(directory: CommandDirectory): CommandDirectory {
  if ('unknown' in directory || directory.assumes === undefined) return directory;
  const { assumes: _assumes, ...own } = directory;
  return own;
}

/** `inner`, a directory relative to `outer`, as a directory relative to where `outer` is relative to. */
export function within(outer: CommandDirectory, inner: CommandDirectory): CommandDirectory {
  if ('unknown' in inner) return inner;
  // The same directory: the same object, so that installs placed in one directory share it (decision D-123).
  if (bare(inner)) return outer;
  const restart = inner.steps.findLastIndex((step) => isAbsolute(step));
  // The command runs in the directory of `outer` itself (npm --prefix sub): npm's local prefix stays the one given.
  const own = inner.steps.length === 0 && !('unknown' in outer) ? outer.localPrefix === true : inner.localPrefix === true;
  const local = own ? { localPrefix: true as const } : {};
  // What `inner` assumes is relative to `outer` too; what `outer` assumes still holds.
  const assumes: KnownDirectory[] = 'unknown' in outer ? [] : [...(outer.assumes ?? [])];
  const base = withoutAssumes(outer);
  for (const assumed of inner.assumes ?? []) {
    const placed = within(base, assumed);
    if ('unknown' in placed) return placed;
    assumes.push(placed);
  }
  if (restart !== -1) return directoryOf(inner.steps.slice(restart), shifted(inner.entered, -restart, restart), shifted(inner.physical, -restart, restart), local, assumes);
  if ('unknown' in outer) return outer;
  const steps = [...outer.steps, ...inner.steps];
  if (steps.length > MAX_STEPS) return { unknown: `depcurfew follows at most ${MAX_STEPS} changes of directory in one command` };
  const offset = outer.steps.length;
  return directoryOf(steps, [...shifted(outer.entered, 0), ...shifted(inner.entered, offset)], [...shifted(outer.physical, 0), ...shifted(inner.physical, offset)], local, assumes);
}

/** Whether a directory is the one the command line starts in, as it is written. */
export function isHere(directory: CommandDirectory | undefined): boolean {
  return directory === undefined || (!('unknown' in directory) && directory.steps.length === 0 && directory.localPrefix !== true && (directory.assumes?.length ?? 0) === 0);
}

/** Reserved words that may stand before a command. */
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc', 'time']);

const GOES_BACK = 'goes back to a directory from before this command, which depcurfew cannot see';
const EXPANDS = 'the shell expands the directory of';
const STACK_FULL = `depcurfew follows at most ${MAX_STACK} directories on the stack of pushd`;
const TOO_MANY_LEFT = `the command leaves more than ${MAX_ASSUMED} directories with cd -, popd or cd /path, and depcurfew checks at most ${MAX_ASSUMED} of them`;

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

/** An entry of the stack of pushd: a directory the shell was in, or a path that pushd -n put there as it was written. */
type StackEntry = { directory: CommandDirectory } | { path: string };

/** What lies below the directories on the stack that depcurfew knows: nothing (dirs -c), or what it cannot tell. */
type StackBottom = 'empty' | 'before' | { unknown: string };

/** The stack of pushd, shared between the copies a subshell makes (decision D-123): the top first, `depth` known entries. */
type Stack = { readonly entry: StackEntry; readonly below: Stack; readonly depth: number } | { readonly bottom: StackBottom };

const BEFORE: Stack = { bottom: 'before' };
const EMPTY: Stack = { bottom: 'empty' };

function pushed(stack: Stack, entry: StackEntry): Stack {
  const depth = 'entry' in stack ? stack.depth + 1 : 1;
  // Beyond MAX_STACK the directories below the new one are not followed.
  if (depth > MAX_STACK) return { entry, below: { bottom: { unknown: STACK_FULL } }, depth: 1 };
  return { entry, below: stack, depth };
}

/** The known entries of a stack, the top first, and what lies below them. */
function entriesOf(stack: Stack): { entries: StackEntry[]; bottom: StackBottom } {
  const entries: StackEntry[] = [];
  let current = stack;
  while ('entry' in current) {
    entries.push(current.entry);
    current = current.below;
  }
  return { entries, bottom: current.bottom };
}

function stackOf(entries: readonly StackEntry[], bottom: StackBottom): Stack {
  let stack: Stack = { bottom };
  for (let index = entries.length - 1; index >= 0; index--) stack = pushed(stack, entries[index] as StackEntry);
  return stack;
}

/** Directories an install's directory assumes were entered: a list shared between copies, the latest first. */
type Assumed = { readonly directory: KnownDirectory; readonly key: string; readonly next: Assumed | undefined; readonly size: number } | undefined;

/** Whether `assumed` is checked anyway as part of `directory`: the same steps from the start, entered and resolved alike. */
function covered(directory: KnownDirectory, assumed: KnownDirectory): boolean {
  if (assumed.steps.length > directory.steps.length) return false;
  for (let index = 0; index < assumed.steps.length; index++) if (assumed.steps[index] !== directory.steps[index]) return false;
  const prefix = (indexes: readonly number[] | undefined) => (indexes ?? []).filter((index) => index < assumed.steps.length).join(',');
  return (assumed.entered ?? []).every((index) => directory.entered?.includes(index) === true) && prefix(assumed.physical) === prefix(directory.physical);
}

/** The directories of a shell while a command line runs: where it is, where cd - goes, and the stack of pushd. */
export class ShellDirectories {
  place: CommandDirectory = HERE;
  /** undefined: cd - would go to a directory from before the command line. */
  previous: CommandDirectory | undefined;
  stack: Stack = BEFORE;
  /** set -P or set -o physical: cd resolves the path through symlinks. */
  physical = false;
  /** The directories a mkdir on the line creates (keyOf), shared by every scope: the file system is the same. */
  created = new Set<string>();
  /** Directories the shell left with cd -, popd or cd /path, which must have been entered (decision D-123). */
  assumed: Assumed;
  /** More than MAX_ASSUMED of them. */
  overflow = false;
  /** Why the directory of every later command is unknown (decision D-123). */
  lasting: string | undefined;

  copy(): ShellDirectories {
    const copy = new ShellDirectories();
    copy.place = this.place;
    copy.previous = this.previous;
    copy.stack = this.stack;
    copy.physical = this.physical;
    copy.created = this.created;
    copy.assumed = this.assumed;
    copy.overflow = this.overflow;
    copy.lasting = this.lasting;
    return copy;
  }

  /** The directory a change to `path` enters, which must exist unless a mkdir on the line creates it (decision D-119). */
  private enter(from: CommandDirectory, path: string, physical: boolean): CommandDirectory {
    const target = within(from, { steps: [path] });
    const key = physical ? undefined : keyOf(target);
    const created = key !== undefined && this.created.has(key);
    return within(from, { steps: [path], ...(created ? {} : { entered: [0] }), ...(physical ? { physical: [0] } : {}) });
  }

  /** The shell leaves `directory` other than by a path from it: for OLDPWD and the stack to be as followed, it must have been entered. */
  private leave(directory: CommandDirectory): void {
    if ('unknown' in directory || (directory.entered?.length ?? 0) === 0) return;
    const { assumes: _assumes, ...own } = directory;
    const key = JSON.stringify(own);
    for (let node = this.assumed; node !== undefined; node = node.next) if (node.key === key) return;
    const size = (this.assumed?.size ?? 0) + 1;
    if (size > MAX_ASSUMED) this.overflow = true;
    else this.assumed = { directory: own, key, next: this.assumed, size };
  }

  /** Where an entry of the stack takes the shell: a path from pushd -n is found from where the shell is, as cd finds it. */
  private target(entry: StackEntry, from: CommandDirectory, command: string, doubt: RelativeDoubt | undefined): CommandDirectory {
    if ('directory' in entry) return entry.directory;
    const reason = doubt === undefined ? undefined : relativeDoubt(entry.path, doubt.variables, command);
    return reason === undefined ? this.enter(from, entry.path, this.physical) : { unknown: reason };
  }

  /** The shell changes to `place`, which is not a path from `from`, as cd -, popd and a rotation of the stack do. */
  private jump(from: CommandDirectory, place: CommandDirectory): void {
    this.leave(from);
    this.place = place;
    this.previous = from;
  }

  private unknownStack(reason: string): void {
    this.stack = { bottom: { unknown: reason } };
  }

  apply(move: Move): void {
    const from = this.place;
    if (this.lasting !== undefined) {
      this.place = { unknown: this.lasting };
      return;
    }
    switch (move.kind) {
      case 'mode':
        this.physical = move.physical;
        return;
      case 'clear':
        this.stack = EMPTY;
        return;
      case 'cd':
        if (isAbsolute(move.path)) this.leave(from);
        this.place = this.enter(from, move.path, move.physical ?? this.physical);
        this.previous = from;
        return;
      case 'back':
        if (move.push === true) {
          // pushd - pushes the directory it leaves only when cd - succeeds, which depends on OLDPWD from before the line.
          if (this.previous === undefined) this.unknownStack(`"${move.command}" ${GOES_BACK}`);
          else this.stack = pushed(this.stack, { directory: from });
        }
        this.jump(from, this.previous ?? { unknown: `"${move.command}" ${GOES_BACK}` });
        return;
      case 'push':
        // pushd -n dir puts dir on the stack as written, without looking at it; Push-Location alone pushes the location.
        if (move.keep === true && move.path !== undefined) {
          this.stack = pushed(this.stack, { path: move.path });
          return;
        }
        this.stack = pushed(this.stack, { directory: from });
        if (move.path === undefined) return;
        if (isAbsolute(move.path)) this.leave(from);
        this.place = this.enter(from, move.path, this.physical);
        this.previous = from;
        return;
      case 'swap':
        return this.swap(from, move);
      case 'rotate':
        return this.rotate(from, move);
      case 'pop':
        return this.pop(from, move);
      case 'unknown':
        // A cd that depcurfew cannot read may also fail, which leaves OLDPWD as it was: cd - goes where it cannot tell.
        this.place = { unknown: move.reason };
        this.previous = { unknown: move.reason };
        if (move.stack === true) this.unknownStack(move.reason);
        if (move.lasting === true) this.lasting = move.reason;
        return;
    }
  }

  /** pushd without a directory: the top two directories change places, and the shell changes to the other one. */
  private swap(from: CommandDirectory, move: Extract<Move, { kind: 'swap' }>): void {
    const stack = this.stack;
    if ('bottom' in stack) {
      // An empty stack: "no other directory", and nothing changes.
      if (stack.bottom === 'empty') return;
      const reason = typeof stack.bottom === 'string' ? `"${move.command}" swaps with a directory from before this command, which depcurfew cannot see` : stack.bottom.unknown;
      this.place = { unknown: reason };
      this.unknownStack(reason);
      return;
    }
    this.stack = pushed(stack.below, { directory: from });
    this.jump(from, this.target(stack.entry, from, move.command, move.doubt));
  }

  /** pushd +N and -N: the stack, with the current directory on top, turns until its Nth directory is on top. */
  private rotate(from: CommandDirectory, move: Extract<Move, { kind: 'rotate' }>): void {
    const { entries, bottom } = entriesOf(this.stack);
    const reason = typeof bottom === 'object' ? bottom.unknown : `"${move.command}" turns a stack that holds directories from before this command, which depcurfew cannot see`;
    const unknown = () => {
      if (!move.keep) this.place = { unknown: reason };
      this.unknownStack(reason);
    };
    // -N counts from the bottom, which only a stack that dirs -c emptied shows.
    if (move.fromRight && bottom !== 'empty') return unknown();
    const count = move.fromRight ? entries.length - move.count : move.count;
    // Beyond the stack: an error that changes nothing, or a directory depcurfew does not know.
    if (count < 0 || count > entries.length) return bottom === 'empty' ? undefined : unknown();
    // +0 changes to the current directory itself.
    if (count === 0) {
      if (!move.keep) this.previous = from;
      return;
    }
    const all: StackEntry[] = [{ directory: from }, ...entries];
    // Below a stack depcurfew does not know to the bottom, the directories turned under it are out of reach.
    const turned = bottom === 'empty' ? [...all.slice(count), ...all.slice(0, count)] : all.slice(count);
    const [top, ...rest] = turned as [StackEntry, ...StackEntry[]];
    this.stack = stackOf(rest, bottom === 'empty' ? 'empty' : bottom);
    if (!move.keep) this.jump(from, this.target(top, from, move.command, move.doubt));
  }

  /** popd, popd -n and popd +N or -N: one directory leaves the stack; when it is the top, the shell changes to the next one. */
  private pop(from: CommandDirectory, move: Extract<Move, { kind: 'pop' }>): void {
    const { entries, bottom } = entriesOf(this.stack);
    const count = move.count ?? 0;
    const fromRight = move.fromRight === true;
    const before = typeof bottom === 'object' ? bottom.unknown : `"${move.command}" ${GOES_BACK}`;
    if (fromRight && bottom !== 'empty') {
      // Which directory -N removes depends on how deep the stack is; it may be the top.
      if (move.keep !== true) this.place = { unknown: before };
      this.unknownStack(before);
      return;
    }
    const top = fromRight ? count === entries.length : count === 0;
    if (top) {
      const [next] = entries;
      if (next === undefined) {
        // An empty stack: popd fails and the shell stays where it is.
        if (bottom === 'empty') return;
        if (move.keep !== true) this.place = { unknown: before };
        this.unknownStack(before);
        return;
      }
      this.stack = 'entry' in this.stack ? this.stack.below : this.stack;
      if (move.keep !== true) this.jump(from, this.target(next, from, move.command, move.doubt));
      return;
    }
    // +N and -N other than the top remove a directory without changing to it.
    const index = fromRight ? entries.length - count : count;
    if (index < 1 || index > entries.length) return;
    this.stack = stackOf([...entries.slice(0, index - 1), ...entries.slice(index)], bottom);
  }

  /** The directories this directory assumes were entered, besides its own steps, and why it is unknown. */
  assumptions(): { list: readonly KnownDirectory[] } | { unknown: string } {
    if (this.overflow) return { unknown: TOO_MANY_LEFT };
    const list: KnownDirectory[] = [];
    for (let node = this.assumed; node !== undefined; node = node.next) list.push(node.directory);
    // In the order the shell left them.
    return { list: list.reverse() };
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

/** `directory` with the directories it assumes were entered, those it checks anyway left out (decision D-123). */
export function assuming(directory: CommandDirectory, assumed: readonly KnownDirectory[]): CommandDirectory {
  if ('unknown' in directory || assumed.length === 0) return directory;
  const own = directory.assumes ?? [];
  const list = [...own, ...assumed.filter((entry) => !covered(directory, entry) && !own.includes(entry))];
  if (list.length === own.length) return directory;
  if (list.length > MAX_ASSUMED) return { unknown: TOO_MANY_LEFT };
  return { ...directory, assumes: list };
}

/**
 * Variables the command line sets that change where cd goes: CDPATH, OLDPWD (cd -), PWD and DIRSTACK (popd).
 * `dynamic`: why a variable whose name the shell builds may be set, which may be any of them (decision D-123).
 */
export interface ShellVariables {
  cdPath: boolean;
  oldPwd: boolean;
  pwd: boolean;
  dirStack: boolean;
  dynamic?: string;
}

/**
 * A name as written on a line, but not as an expansion ($OLDPWD, ${PWD}, ${#DIRSTACK}): set, unset, exported or read
 * into, also by ${OLDPWD:=…} and ${OLDPWD=…}, which assign it.
 */
function named(line: string, name: string): boolean {
  return new RegExp(`(?<!\\$\\{?[#!]?)\\b${name}\\b|\\$\\{${name}:?=`, 'u').test(line);
}

/** The variables a command line names that change where cd goes; CDPATH counts wherever it is named. */
export function shellVariables(line: string): ShellVariables {
  return { cdPath: /\bCDPATH\b/u.test(line), oldPwd: named(line, 'OLDPWD'), pwd: named(line, 'PWD'), dirStack: named(line, 'DIRSTACK') };
}

/** Builtins that declare variables, whose operands name them. */
const DECLARERS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
/** Builtins whose operands name variables they read into or unset, or are arithmetic that may assign one. */
const NAMERS = new Set(['read', 'mapfile', 'readarray', 'unset', 'let']);
/** Operators of [[ … ]] whose operands bash evaluates as arithmetic, which may assign a variable. */
const ARITHMETIC_TESTS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Every builtin dynamicAssignment looks at. */
const ASSIGNERS = new Set([...DECLARERS, ...NAMERS, 'printf', 'wait', 'getopts', '[[']);

/** Why a command may set a variable whose name the shell builds (decision D-123). */
export function builtName(command: string): string {
  return `"${command}" may set a variable whose name the shell builds, such as OLDPWD, which changes where cd -, popd and a relative cd go`;
}

/**
 * Whether a builtin may set a variable whose name is not written out (decision D-123): declare, typeset, local, export
 * and readonly with a name the shell expands (declare "${X}PWD=…") or with -i (whose values are arithmetic), printf -v
 * with such a name (or a word the shell expands where -v may stand), read, mapfile, readarray, unset and let with a word
 * the shell expands, getopts with such a name, wait with a word the shell expands (wait -p), and [[ … -eq … ]] with one
 * (arithmetic, which may assign). Returns why, or undefined.
 */
export function dynamicAssignment(words: readonly Word[]): string | undefined {
  const head = words[0];
  if (head === undefined || head.dynamic || !ASSIGNERS.has(head.text)) return undefined;
  const rest = words.slice(1);
  const why = builtName(shown(words));
  if (DECLARERS.has(head.text)) {
    for (const word of rest) {
      if (!word.dynamic) {
        if (/^[-+][A-Za-z]*i/u.test(word.text)) return why;
        continue;
      }
      const equals = word.text.indexOf('=');
      if (!IDENTIFIER.test(equals === -1 ? word.text : word.text.slice(0, equals))) return why;
    }
    return undefined;
  }
  if (head.text === 'printf') {
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index] as Word;
      if (word.dynamic) return why;
      if (word.text === '-v') {
        if (rest[index + 1]?.dynamic === true) return why;
        index += 1;
        continue;
      }
      if (!word.text.startsWith('-v')) return undefined;
    }
    return undefined;
  }
  if (NAMERS.has(head.text) || head.text === 'wait') return rest.some((word) => word.dynamic) ? why : undefined;
  if (head.text === 'getopts') return rest[1]?.dynamic === true ? why : undefined;
  if (head.text === '[[') return rest.some((word) => !word.dynamic && ARITHMETIC_TESTS.has(word.text)) && rest.some((word) => word.dynamic) ? why : undefined;
  return undefined;
}

/** Why a relative directory cannot be followed: PWD (other shells) or CDPATH set on the line, or a name the shell builds. */
function relativeDoubt(path: string, variables: ShellVariables, command: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  if (variables.dynamic !== undefined) return variables.dynamic;
  // Shells other than bash take a relative directory from $PWD, which the command sets.
  if (variables.pwd) return `"${command}" is relative to the working directory, and the command sets PWD`;
  // CDPATH makes cd look for a relative directory in the directories it names first.
  if (variables.cdPath && !/^\.\.?(?:\/|$)/u.test(path)) return `CDPATH is set, so "${command}" may go to a directory that CDPATH names`;
  return undefined;
}

/** The shells whose command lines the scanner reads. */
type Shell = 'posix' | 'powershell' | 'cmd';

/** Why a directory cannot be told, as one move; `stack`: the stack of pushd is unknown too. */
function unknownMove(reason: string, stack = false): Move[] {
  return [{ kind: 'unknown', reason, ...(stack ? { stack: true as const } : {}) }];
}

/** Whether the path of a POSIX cd or pushd is written out: not expanded, not relative to a home directory. */
function posixPath(word: Word, words: readonly Word[], stack = false): Move[] | undefined {
  if (word.dynamic || word.input === true) return unknownMove(`${EXPANDS} "${shown(words)}"`, stack);
  if (word.text === '') return unknownMove(`depcurfew does not read "${shown(words)}", which names no directory`, stack);
  if (word.text === '~') return unknownMove(`"${shown(words)}" goes to the home directory`, stack);
  if (word.text.startsWith('~')) return unknownMove(`"${shown(words)}" is relative to a home directory, which depcurfew does not look at`, stack);
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

/** +N or -N of pushd, popd and dirs, as bash reads it (legal_number); undefined for another word. */
function stackIndex(text: string): { count: number; fromRight: boolean } | undefined {
  const match = /^([+-])(\d{1,9})$/u.exec(text);
  return match === null ? undefined : { count: Number(match[2]), fromRight: match[1] === '-' };
}

/** Why the stack of pushd cannot be read: DIRSTACK set on the line, or a variable whose name the shell builds. */
function stackDoubt(words: readonly Word[], variables: ShellVariables): string | undefined {
  if (variables.dynamic !== undefined) return variables.dynamic;
  return variables.dirStack ? `"${shown(words)}" goes back to a directory of DIRSTACK, which the command changes` : undefined;
}

/**
 * dirs: -c empties the stack, other options only print it (bash's dirs_builtin reads -l, -c, -v, -p, -- and +N or -N,
 * and stops at anything else with a usage error).
 */
function dirsChange(words: readonly Word[]): Move[] {
  let clear = false;
  for (const word of words.slice(1)) {
    if (word.dynamic) return unknownMove(`depcurfew does not read "${shown(words)}", which may empty the stack of pushd`, true);
    if (word.text === '--') break;
    if (word.text === '-c') clear = true;
    else if (!['-l', '-v', '-p'].includes(word.text) && stackIndex(word.text) === undefined) return [];
  }
  return clear ? [{ kind: 'clear' }] : [];
}

/**
 * popd as bash reads it (popd_builtin): -n, --, +N or -N, the last of them counting; any other word is a usage error
 * that changes nothing. An empty word ends the options.
 */
function popdChange(words: readonly Word[], variables: ShellVariables): Move[] {
  let keep = false;
  let index: { count: number; fromRight: boolean } | undefined;
  for (const word of words.slice(1)) {
    if (word.dynamic) return unknownMove(`${EXPANDS} "${shown(words)}"`, true);
    if (word.text === '-n') keep = true;
    else if (word.text === '--') break;
    else if (word.text === '') return unknownMove(`depcurfew does not read "${shown(words)}"`, true);
    else {
      const found = stackIndex(word.text);
      if (found === undefined) return [];
      index = found;
    }
  }
  const doubt = stackDoubt(words, variables);
  if (doubt !== undefined) return unknownMove(doubt, true);
  return [{ kind: 'pop', command: shown(words), ...(index === undefined ? {} : index), ...(keep ? { keep: true } : {}), doubt: { variables } }];
}

/**
 * pushd as bash reads it (pushd_builtin): -- first means no options; -n only changes the stack; - is cd -; +N or -N
 * rotates the stack; a word that is no option is the directory. Without a directory (and without -n) it swaps the top
 * two. An unknown option is a usage error that changes nothing.
 */
function pushdChange(words: readonly Word[], variables: ShellVariables): Move[] {
  const rest = words.slice(1);
  const skip = rest[0]?.dynamic === false && rest[0].text === '--';
  let keep = false;
  let rotate: { count: number; fromRight: boolean } | undefined;
  let operands: Word[] = skip ? rest.slice(1) : rest;
  if (!skip) {
    let at = 0;
    for (; at < rest.length; at++) {
      const word = rest[at] as Word;
      if (word.dynamic) return unknownMove(`${EXPANDS} "${shown(words)}"`, true);
      if (word.text === '-n') keep = true;
      else if (word.text === '--') {
        at += 1;
        break;
      } else if (word.text === '-') break;
      else if (/^[+-]/u.test(word.text)) {
        const found = stackIndex(word.text);
        if (found === undefined) return [];
        rotate = found;
      } else break;
    }
    operands = rest.slice(at);
    if (rest.length === 0) operands = [];
    else if (rotate === undefined && operands.length === 0 && keep) return [];
  }
  const doubt = stackDoubt(words, variables);
  if (rotate !== undefined) return doubt !== undefined ? unknownMove(doubt, true) : [{ kind: 'rotate', command: shown(words), ...rotate, keep, doubt: { variables } }];
  if (operands.length === 0) return doubt !== undefined ? unknownMove(doubt, true) : [{ kind: 'swap', command: shown(words), doubt: { variables } }];
  if (operands.length > 1) return unknownMove(`depcurfew does not read "${shown(words)}", which names more than one directory`, true);
  const operand = operands[0] as Word;
  const unread = posixPath(operand, words, true);
  if (unread !== undefined) return unread;
  if (operand.text === '-') {
    // pushd - is cd - that also pushes the directory it leaves.
    if (variables.oldPwd || variables.dynamic !== undefined) return unknownMove(variables.dynamic ?? `"${shown(words)}" goes to the directory in OLDPWD, which the command sets or unsets`, true);
    return keep ? unknownMove(`depcurfew does not read "${shown(words)}"`, true) : [{ kind: 'back', command: shown(words), push: true }];
  }
  // pushd -n dir stores dir as written; the shell finds it when popd gets to it.
  if (keep) return [{ kind: 'push', path: operand.text, keep: true }];
  const relative = relativeDoubt(operand.text, variables, shown(words));
  if (relative !== undefined) return unknownMove(relative, true);
  return [{ kind: 'push', path: operand.text }];
}

/** cd, pushd, popd, dirs and chdir of bash and zsh: the moves, [] when nothing changes, undefined for another command. */
function posixChange(words: readonly Word[], builtin: boolean, variables: ShellVariables): Move[] | undefined {
  const name = words[0]?.text ?? '';
  if (name === 'set') return builtin ? physicalMode(words) : undefined;
  if (!['cd', 'chdir', 'pushd', 'popd', 'dirs'].includes(name)) return undefined;
  // sudo cd, env cd: cd is a builtin of the shell, so the command fails and the directory stays.
  if (!builtin) return [];
  if (name === 'dirs') return dirsChange(words);
  if (name === 'popd') return popdChange(words, variables);
  if (name === 'pushd') return pushdChange(words, variables);
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
    if (options && !word.dynamic && /^-[LPe@]+$/u.test(word.text)) {
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
  if (operand === undefined) return unknownMove(`"${shown(words)}" goes to the home directory`);
  const unread = posixPath(operand, words);
  if (unread !== undefined) return unread;
  if (operand.text === '-') {
    // cd - goes to $OLDPWD, which an assignment or unset on the line changes.
    if (variables.dynamic !== undefined) return unknownMove(variables.dynamic);
    return variables.oldPwd ? unknownMove(`"${shown(words)}" goes to the directory in OLDPWD, which the command sets or unsets`) : [{ kind: 'back', command: shown(words) }];
  }
  const relative = relativeDoubt(operand.text, variables, shown(words));
  if (relative !== undefined) return unknownMove(relative);
  return [{ kind: 'cd', path: operand.text, ...(physical === undefined ? {} : { physical }) }];
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
    // A function may be called by any later command, also one depcurfew takes for a program (decision D-123).
    if (frame.kind === 'function') this.unknown(frame.moved, true);
    else if (frame.kind !== 'group') this.unknown(frame.moved);
  }

  /** The directory is unknown from here on; the stack of pushd too, as the change may have pushed or popped (decision D-123). */
  private unknown(reason: string, lasting = false): void {
    const move: Move = { kind: 'unknown', reason, stack: true, ...(lasting ? { lasting: true as const } : {}) };
    this.state.apply(move);
    if (this.scopes.length === 0) this.moves.push(move);
  }

  /** The directories the shell left that must have been entered, for the installs placed now; the same list while nothing changes. */
  private assumed: { state: ShellDirectories['assumed']; overflow: boolean; result: ReturnType<ShellDirectories['assumptions']> } | undefined;

  private assumptions(): ReturnType<ShellDirectories['assumptions']> {
    const { assumed, overflow } = this.state;
    const cached = this.assumed;
    if (cached !== undefined && cached.state === assumed && cached.overflow === overflow) return cached.result;
    const result = this.state.assumptions();
    this.assumed = { state: assumed, overflow, result };
    return result;
  }

  /** The last directory placed, with what it assumes, so that installs placed in one directory share one object. */
  private lastPlaced: { place: CommandDirectory; assumed: readonly KnownDirectory[]; result: CommandDirectory } | undefined;

  /**
   * Installs and overrides of the command just read, relative to the command: they now run where the shell is. Those
   * of a trap (`trapped`) run later, when the shell exits or gets a signal, so a later change of directory makes their
   * directory unknown (decision D-119). Each assumes the directories the shell left on the way (decision D-123).
   */
  placed(entries: readonly Placed[], trapped: (entry: Placed) => boolean = () => false): void {
    for (const entry of entries) {
      entry.directory = this.where(entry.directory);
      for (const frame of this.frames) frame.placed.push(entry);
      if (this.frames.some((frame) => frame.kind === 'function')) this.inFunctions.push(entry);
      if (trapped(entry)) this.trapped.push(entry);
    }
  }

  /** Where an install or override relative to the command runs, relative to the start of the line. */
  private where(directory: CommandDirectory | undefined): CommandDirectory {
    if (this.overflow > 0) return { unknown: TOO_DEEP };
    if (this.state.lasting !== undefined) return { unknown: this.state.lasting };
    const assumed = this.assumptions();
    if ('unknown' in assumed) return assumed;
    const place = within(this.state.place, directory ?? HERE);
    const last = this.lastPlaced;
    if (last !== undefined && last.place === place && last.assumed === assumed.list) return last.result;
    const result = assuming(place, assumed.list);
    this.lastPlaced = { place, assumed: assumed.list, result };
    return result;
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
    // A trap that changes directory before later commands, or a file run in this shell: wherever it stands (decision D-123).
    const lasting = moves.find((move) => move.kind === 'unknown' && move.lasting === true);
    if (lasting !== undefined) {
      this.state.apply(lasting);
      if (this.scopes.length === 0) this.moves.push(lasting);
      return;
    }
    const piped =bounds.after === '|' || bounds.after === '|&' || bounds.before.includes('|') || bounds.before.includes('|&');
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
