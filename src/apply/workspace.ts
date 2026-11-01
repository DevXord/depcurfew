// A buffer of edited files: generators read and edit text with LF line endings, and the original line endings,
// byte order mark and final newline are restored when the changes are collected. Nothing is written here, except by
// writeChanges, which writes all changes or none.
import { closeSync, fchmodSync, fchownSync, lchownSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { MAX_FILE_SIZE } from '../detect/repository.ts';
import { readLimited } from '../read-limited.ts';
import { isInside } from '../paths.ts';
import { detectStyle, restoreStyle, toLf, type TextStyle } from './text.ts';

export interface FileChange {
  /** Repository-relative path with `/` separators. */
  file: string;
  /** null for a new file. */
  before: string | null;
  after: string;
}

interface Entry {
  original: string | null;
  style: TextStyle;
  body: string;
}

/**
 * The codes of the errors writeChanges throws itself, when a directory on the way to a file leads out of the root (a
 * symlink put in place after apply looked at it) or is no longer the directory the file was staged in.
 */
export const OUTSIDE = 'DEPCURFEW_OUTSIDE_ROOT';
export const CHANGED = 'DEPCURFEW_DIRECTORY_CHANGED';

/** Why a file system call failed, in plain words; the error code when there are none. */
export function fileSystemReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = {
    EACCES: 'permission denied',
    EPERM: 'operation not permitted',
    EROFS: 'the file system is read-only',
    ENOSPC: 'no space left on the device',
    EDQUOT: 'the disk quota is exceeded',
    EISDIR: 'it is a directory',
    ENOTDIR: 'a part of its path is not a directory',
    EEXIST: 'a file of the same name is in the way',
    EBUSY: 'the file is busy',
    ENAMETOOLONG: 'its name is too long',
    [OUTSIDE]: 'a directory on its path is a symlink that leads outside the directory depcurfew writes to',
    [CHANGED]: 'a directory on its path changed while depcurfew was writing',
  };
  if (code !== undefined && reasons[code] !== undefined) return reasons[code];
  return code ?? (error instanceof Error ? error.message : String(error));
}

/** Decodes UTF-8 strictly: a byte sequence that is not UTF-8 would otherwise become U+FFFD and be written back so. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface WorkspaceOptions {
  /** How messages name a file of the workspace (its root-relative path by default), e.g. ~/.npmrc for apply --user. */
  name?: (file: string) => string;
}

/**
 * Why the workspace could not read a file, for a fix that fits (apply --user): `part` is the part of its path that is
 * not a directory, named as messages name files; `code` the error code of a file that cannot be read.
 */
export type FileProblem =
  | { kind: 'symlink' | 'too-large' | 'not-utf8' | 'directory' | 'not-a-file' | 'outside' }
  | { kind: 'unreadable'; code: string | undefined }
  | { kind: 'not-a-directory'; part: string };

export class Workspace {
  readonly root: string;
  readonly #files = new Map<string, Entry>();
  readonly #problems = new Map<string, FileProblem>();
  readonly #name: (file: string) => string;

  constructor(root: string, options: WorkspaceOptions = {}) {
    this.root = realpathSync(root);
    this.#name = options.name ?? ((file) => file);
  }

  /** Why a file could not be read, after reading it failed with an error; undefined when it did not. */
  problem(file: string): FileProblem | undefined {
    return this.#problems.get(file);
  }

  /** Records why the file cannot be read and returns the error to throw. */
  #fail(file: string, problem: FileProblem, message: string): Error {
    this.#problems.set(file, problem);
    return new Error(message);
  }

  /** Why the file cannot be looked at: a part of its path that is a file rather than a directory, or the reason. */
  #statFailure(file: string, error: unknown): Error {
    return (
      ((error as NodeJS.ErrnoException).code === 'ENOTDIR' ? this.#notADirectory(file) : undefined) ??
      this.#fail(file, { kind: 'unreadable', code: codeOf(error) }, `${this.#name(file)} cannot be read: ${fileSystemReason(error)}`)
    );
  }

  /**
   * A part of the file's path that exists but is not a directory, so the file can be neither read nor created. POSIX
   * says so with ENOTDIR; Windows reports the file as missing, so a missing file is checked this way too.
   */
  #notADirectory(file: string): Error | undefined {
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++) {
      const part = parts.slice(0, count).join('/');
      let stats;
      try {
        stats = lstatSync(join(this.root, part), { throwIfNoEntry: false });
      } catch {
        return undefined;
      }
      if (stats === undefined) return undefined;
      if (!stats.isDirectory() && !stats.isSymbolicLink()) return this.#fail(file, { kind: 'not-a-directory', part: this.#name(part) }, `${this.#name(part)} is not a directory`);
    }
    return undefined;
  }

  #load(file: string): Entry {
    const cached = this.#files.get(file);
    if (cached !== undefined) return cached;
    const name = this.#name(file);
    const path = join(this.root, file);
    let parent: string;
    try {
      parent = realpathSync(dirname(path));
    } catch {
      parent = this.root;
    }
    if (!isInside(this.root, parent)) throw this.#fail(file, { kind: 'outside' }, `${name} is outside the repository`);
    let bytes: Buffer | undefined;
    let stats;
    try {
      stats = lstatSync(path, { throwIfNoEntry: false });
    } catch (error) {
      throw this.#statFailure(file, error);
    }
    const symlink = () => this.#fail(file, { kind: 'symlink' }, `${name} is a symlink; depcurfew does not write through symlinks`);
    if (stats?.isSymbolicLink() === true) throw symlink();
    if (stats === undefined) {
      const blocked = this.#notADirectory(file);
      if (blocked !== undefined) throw blocked;
    } else {
      // The same limit as for reading configuration (Repository): a huge file would take as much memory several times
      // over. readLimited also refuses a FIFO or a device instead of waiting on it, and a symlink put in place meanwhile.
      const read = readLimited(path, MAX_FILE_SIZE, { noFollow: true });
      if (read.ok) bytes = read.bytes;
      else if (read.problem === 'symlink') throw symlink();
      else if (read.problem === 'too-large') throw this.#fail(file, { kind: 'too-large' }, `${name} is larger than 1 MiB, so depcurfew does not edit it`);
      else if (read.problem === 'not-a-file') {
        const directory = stats.isDirectory();
        throw this.#fail(file, { kind: directory ? 'directory' : 'not-a-file' }, `${name} cannot be read: ${directory ? 'it is a directory' : 'it is not a regular file'}`);
      } else if (read.problem === 'unreadable') throw this.#fail(file, { kind: 'unreadable', code: read.error.code }, `${name} cannot be read: ${fileSystemReason(read.error)}`);
    }
    let original: string | null = null;
    if (bytes !== undefined) {
      try {
        original = UTF8.decode(bytes);
      } catch {
        throw this.#fail(file, { kind: 'not-utf8' }, `${name} is not valid UTF-8, so depcurfew does not edit it; save it as UTF-8`);
      }
    }
    const entry: Entry = { original, style: detectStyle(original ?? ''), body: toLf(original ?? '') };
    this.#files.set(file, entry);
    return entry;
  }

  exists(file: string): boolean {
    const entry = this.#load(file);
    return entry.original !== null || entry.body !== '';
  }

  read(file: string): string {
    return this.#load(file).body;
  }

  /** Applies an edit to the file's text (LF line endings); a missing file starts empty. */
  edit(file: string, change: (body: string) => string): void {
    const entry = this.#load(file);
    entry.body = change(entry.body);
  }

  changes(): FileChange[] {
    const changes: FileChange[] = [];
    for (const [file, entry] of this.#files) {
      if (entry.original === null && entry.body === '') continue;
      const after = restoreStyle(entry.body, entry.style, entry.original ?? undefined);
      if (after !== entry.original) changes.push({ file, before: entry.original, after });
    }
    return changes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
}

/** How writeChanges treats the file system: process.platform and a real wait by default, both replaceable in tests. */
export interface WriteOptions {
  platform?: NodeJS.Platform;
  /** Waits this many milliseconds, synchronously. */
  sleep?: (milliseconds: number) => void;
  /**
   * How errors name a file (`file` is relative to `root`, with `/`): the root-relative path by default, ~/.npmrc for
   * apply --user, whose files are in several roots.
   */
  name?: (root: string, file: string) => string;
  /**
   * The owner to give a new file or directory at this absolute path, or undefined to leave it to the running user:
   * apply and init --user, run by root in the home directory of another user, give what they create there to that user.
   */
  ownerOfNew?: (path: string) => Owner | undefined;
  /** Called once every temporary file is written, before the first rename (tests change the file system there). */
  staged?: () => void;
}

/** The changes of one workspace root, for writeChangeSets. */
export interface ChangeSet {
  root: string;
  changes: readonly FileChange[];
}

/**
 * Codes with which Windows refuses to replace or remove a file that another process holds open for a moment: an
 * antivirus scanner, the search indexer, an editor or a sync client. npm's file system layer (graceful-fs) tries
 * renames again on them too. EBUSY also means busy elsewhere; EPERM and EACCES only on Windows, where a read-only file
 * gives EPERM as well.
 */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Growing waits between attempts on Windows: 3.27 seconds in all. */
const RETRY_DELAYS = [10, 20, 40, 80, 160, 320, 640, 1000, 1000];

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Whether an error means that another program holds the file (or, on Windows, that it is read-only). */
function isBusy(error: unknown, platform: NodeJS.Platform): boolean {
  const code = codeOf(error);
  return code === 'EBUSY' || (platform === 'win32' && code !== undefined && BUSY.has(code));
}

/** Runs a file system call; on Windows it is tried again, with growing waits, while another program holds the file. */
function retried<T>(call: () => T, options: WriteOptions): T {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return call();
  for (const delay of RETRY_DELAYS) {
    try {
      return call();
    } catch (error) {
      if (!isBusy(error, platform)) throw error;
      (options.sleep ?? wait)(delay);
    }
  }
  return call();
}

/**
 * A file could not be written. writeChanges has removed its temporary files and put back the files it had already
 * replaced, so nothing changed, except for the files in `unrestored` (whose earlier text is in `backups` when it could
 * be written) and the temporary files in `leftovers`. The message says why, without the file name.
 */
export class WriteFailed extends Error {
  readonly file: string;
  /** Why, in plain words. */
  readonly reason: string;
  /** Files already replaced that could not be put back (normally none). */
  readonly unrestored: string[];
  /** For files in `unrestored`: the temporary file, next to it, that holds its earlier text. */
  readonly backups: Readonly<Record<string, string>>;
  /** Temporary files that could not be removed, named like `file` (relative to the root, or as WriteOptions.name says). */
  readonly leftovers: string[];
  /** Another program holds the file, or (on Windows) it is read-only. */
  readonly busy: boolean;
  readonly platform: NodeJS.Platform;

  constructor(file: string, error: unknown, unrestored: string[], details: { platform?: NodeJS.Platform; backups?: Record<string, string>; leftovers?: string[] } = {}) {
    const reason = fileSystemReason(error);
    const backups = details.backups ?? {};
    const leftovers = details.leftovers ?? [];
    const kept = unrestored.filter((entry) => backups[entry] !== undefined);
    const where =
      kept.length === 0
        ? ''
        : unrestored.length === 1
          ? ` (its earlier text is in ${backups[kept[0] as string] as string})`
          : ` (${kept.map((entry) => `the earlier text of ${entry} is in ${backups[entry] as string}`).join(', ')})`;
    const parts = [
      reason,
      ...(unrestored.length === 0 ? [] : [`${unrestored.join(', ')} had already been replaced and could not be put back${where}`]),
      ...(leftovers.length === 0 ? [] : [`the temporary file${leftovers.length === 1 ? '' : 's'} ${leftovers.join(', ')} could not be removed`]),
    ];
    super(parts.join('; '), { cause: error });
    this.file = file;
    this.reason = reason;
    this.unrestored = unrestored;
    this.backups = backups;
    this.leftovers = leftovers;
    this.platform = details.platform ?? process.platform;
    this.busy = isBusy(error, this.platform);
  }
}

/** The owner a replaced file keeps when depcurfew runs as root, or a new file gets (WriteOptions.ownerOfNew). */
export interface Owner {
  uid: number;
  gid: number;
}

interface Item {
  root: string;
  change: FileChange;
  path: string;
  /** The file as errors name it. */
  name: string;
}

interface Staged extends Item {
  temporary: string;
  /** The real path of the file's directory when it was staged, inside the real path of the root. */
  directory: string;
  /** The mode of the file it replaces; undefined for a new file. */
  mode: number | undefined;
  /**
   * The owner to set: of the file it replaces when that has to be set (running as root), or for a new file the one
   * WriteOptions.ownerOfNew names; undefined otherwise.
   */
  owner: Owner | undefined;
}

let counter = 0;

/**
 * The owner to give the file that replaces one with these stats. Only root can give a file away, and only then does
 * a replaced file change hands: sudo depcurfew apply --user with HOME kept would otherwise leave ~/.npmrc to root, and
 * the user could no longer read their own configuration. POSIX only; Windows has no such owners.
 */
function ownerToKeep(path: string): Owner | undefined {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return undefined;
  // The file itself, not what a symlink put in its place since it was read points to.
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) return undefined;
  return stats.uid === process.getuid() && stats.gid === process.getgid?.() ? undefined : { uid: stats.uid, gid: stats.gid };
}

/** The owner WriteOptions.ownerOfNew names for a new file, by the real path of its directory. */
function newOwner(path: string, ownerOfNew: WriteOptions['ownerOfNew']): Owner | undefined {
  return ownerOfNew === undefined ? undefined : ownerOfNew(join(realpathSync(dirname(path)), basename(path)));
}

/**
 * Writes `text` to a new temporary file next to `path`; the file is removed if writing fails. It replaces a file of
 * mode `mode` (and owner `owner`, see ownerToKeep), or with undefined it becomes a new file, whose mode the umask
 * decides (0666 narrowed by it), as for any file a program creates, and whose owner is `owner` when given.
 */
function stage(path: string, text: string, mode: number | undefined, owner?: Owner): string {
  counter += 1;
  const temporary = `${path}.depcurfew-${process.pid}-${Date.now()}-${counter}`;
  let descriptor: number | undefined;
  try {
    // Created with the final mode (the umask can only narrow it), so a file such as .npmrc with a token in it is
    // never readable by others, not even for a moment; for a file it replaces, chmod then sets that mode exactly,
    // after chown, which may clear the set-user-ID and set-group-ID bits. Both work on the open file: by its name,
    // root would follow a symlink that the owner of the directory put there meanwhile, and give away another file.
    descriptor = openSync(temporary, 'wx', mode ?? 0o666);
    writeFileSync(descriptor, text);
    if (owner !== undefined) fchownSync(descriptor, owner.uid, owner.gid);
    if (mode !== undefined) fchmodSync(descriptor, mode);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
    // 'wx' fails when the name exists: that file is not ours.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return temporary;
}

/**
 * The topmost directory that does not exist on the way to `directory`, which mkdirSync with recursive creates; undefined
 * when `directory` exists. Worked out here rather than taken from what mkdirSync returns: on Windows that is the
 * namespaced form (\\?\C:\...), which no other path apply works with is inside.
 */
function missingTop(directory: string): string | undefined {
  let top: string | undefined;
  for (let current = directory; lstatSync(current, { throwIfNoEntry: false }) === undefined; current = dirname(current)) {
    top = current;
    if (dirname(current) === current) break;
  }
  return top;
}

function writeError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}

/**
 * The real path of `directory`, which must lie inside `realRoot` (the real path of the root): a directory on the way
 * that became a symlink after apply looked at it (the directory of a project swapped for a link out of the
 * repository) would otherwise take the file outside. Throws an error with the code OUTSIDE.
 */
function realInside(realRoot: string, directory: string): string {
  const real = realpathSync(directory);
  if (!isInside(realRoot, real)) throw writeError(OUTSIDE, directory);
  return real;
}

/**
 * Whether the directory of a staged file is still the one it was staged in; throws an error with the code OUTSIDE
 * when it now leads out of the root, or CHANGED when it leads elsewhere inside it. Checked right before each rename.
 */
function checkUnchanged(realRoot: string, entry: Staged): void {
  const now = realInside(realRoot, dirname(entry.path));
  if (now !== entry.directory) throw writeError(CHANGED, dirname(entry.path));
}

/** Whether checkUnchanged passes, for putting a file back: one whose directory changed is left alone. */
function unchanged(realRoot: string, entry: Staged): boolean {
  try {
    checkUnchanged(realRoot, entry);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `directory` and the directories above it that are missing, one level at a time, and gives each one it
 * creates to the owner `ownerOfNew` names for its real path, so that a directory a symlink led elsewhere (out of the
 * home directory) is not given away. Each is checked with lstat after mkdir: a directory that root just made, not a
 * symlink that the owner of the parent put there meanwhile; lchown does not follow a symlink either, so a swap between
 * the check and lchown gives away the link at most, never what it points to. Without an owner it is mkdir -p.
 */
function makeDirectories(directory: string, ownerOfNew: WriteOptions['ownerOfNew']): void {
  if (ownerOfNew === undefined) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  const missing: string[] = [];
  for (let current = directory; lstatSync(current, { throwIfNoEntry: false }) === undefined; current = dirname(current)) {
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  const changed = (level: string) => Object.assign(new Error(`${level} changed while it was created`), { code: 'EEXIST' });
  for (const level of missing) {
    try {
      mkdirSync(level);
    } catch (error) {
      // Made by another program meanwhile: used as mkdir -p would, but not given away, as it is not ours.
      if (codeOf(error) === 'EEXIST' && lstatSync(level).isDirectory()) continue;
      throw error;
    }
    const made = lstatSync(level);
    const uid = process.getuid?.();
    if (!made.isDirectory() || (uid !== undefined && made.uid !== uid)) throw changed(level);
    const owner = ownerOfNew(realpathSync(level));
    if (owner === undefined) continue;
    lchownSync(level, owner.uid, owner.gid);
    const given = lstatSync(level);
    if (!given.isDirectory() || given.ino !== made.ino || given.dev !== made.dev) throw changed(level);
  }
}

/** Removes the directories apply created (`created`, the topmost of each) for `paths`, deepest first, if empty. */
function removeDirectories(created: readonly string[], paths: readonly string[]): void {
  const directories = new Set<string>();
  for (const top of created) {
    for (const path of paths) {
      for (let directory = dirname(path); isInside(top, directory); directory = dirname(directory)) {
        directories.add(directory);
        if (directory === top) break;
      }
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty, or already gone.
    }
  }
}

/**
 * Writes each changed file through a temporary file and a rename, keeping the permissions of existing files (and,
 * when running as root, their owner). All files or none: every temporary file is written first and only then are they
 * renamed; if anything fails, the temporary files are removed and the files already replaced get their old text back,
 * and WriteFailed is thrown. On Windows, renames and removals are tried again for a few seconds while another program
 * holds the file.
 */
export function writeChanges(root: string, changes: readonly FileChange[], options: WriteOptions = {}): void {
  writeChangeSets([{ root, changes }], options);
}

/** writeChanges for the changes of several workspace roots at once (apply --user): all files of all roots, or none. */
export function writeChangeSets(sets: readonly ChangeSet[], options: WriteOptions = {}): void {
  const nameOf = options.name ?? ((_root: string, file: string) => file);
  const items: Item[] = sets.flatMap((set) => set.changes.map((change) => ({ root: set.root, change, path: join(set.root, change.file), name: nameOf(set.root, change.file) })));
  const paths = items.map((item) => item.path);
  const staged: Staged[] = [];
  const created: string[] = [];
  const leftovers: string[] = [];
  const shown = (item: Item, path: string) => nameOf(item.root, relative(item.root, path).split(sep).join('/'));
  /** Removes a temporary file; one that stays is named in the error. */
  const remove = (entry: Staged) => {
    try {
      retried(() => rmSync(entry.temporary, { force: true }), options);
    } catch {
      leftovers.push(shown(entry, entry.temporary));
    }
  };
  const details = () => ({ ...(options.platform === undefined ? {} : { platform: options.platform }), leftovers });
  const realRoots = new Map<string, string>();
  const realRoot = (root: string): string => {
    let real = realRoots.get(root);
    if (real === undefined) {
      // init --user writes into a directory it creates: the real path of the part that exists, and the rest as given.
      const top = missingTop(root);
      real = top === undefined ? realpathSync(root) : join(realpathSync(dirname(top)), relative(dirname(top), root));
      realRoots.set(root, real);
    }
    return real;
  };
  let current = items[0]?.name ?? '';
  try {
    for (const item of items) {
      current = item.name;
      const top = missingTop(dirname(item.path));
      // Nothing is created through a directory that leads out of the root: the deepest one that exists is checked first.
      const existing = top === undefined ? dirname(item.path) : dirname(top);
      // Above the root only when the root itself is created (init --user): nothing of the root to leave then.
      if (isInside(item.root, existing)) realInside(realRoot(item.root), existing);
      // Recorded first, so that the directories are removed even when mkdirSync creates some of them and then fails.
      if (top !== undefined) created.push(top);
      makeDirectories(dirname(item.path), options.ownerOfNew);
      const directory = realInside(realRoot(item.root), dirname(item.path));
      const stats = item.change.before === null ? undefined : statSync(item.path);
      const mode = stats === undefined ? undefined : stats.mode & 0o7777;
      const owner = stats === undefined ? newOwner(item.path, options.ownerOfNew) : ownerToKeep(item.path);
      staged.push({ ...item, temporary: stage(item.path, item.change.after, mode, owner), directory, mode, owner });
    }
    options.staged?.();
  } catch (error) {
    for (const entry of staged) remove(entry);
    removeDirectories(created, paths);
    throw new WriteFailed(current, error, [], details());
  }

  const renamed: Staged[] = [];
  try {
    for (const entry of staged) {
      current = entry.name;
      checkUnchanged(realRoot(entry.root), entry);
      retried(() => renameSync(entry.temporary, entry.path), options);
      renamed.push(entry);
    }
  } catch (error) {
    for (const entry of staged.slice(renamed.length)) remove(entry);
    const unrestored: string[] = [];
    const backups: Record<string, string> = {};
    for (const entry of renamed.reverse()) {
      // A file is put back only where it was written, never through a directory that changed meanwhile.
      if (!unchanged(realRoot(entry.root), entry)) {
        unrestored.push(entry.name);
        continue;
      }
      if (entry.change.before === null) {
        try {
          retried(() => rmSync(entry.path, { force: true }), options);
        } catch {
          unrestored.push(entry.name);
        }
        continue;
      }
      let backup: string | undefined;
      try {
        backup = stage(entry.path, entry.change.before, entry.mode, entry.owner);
        const from = backup;
        retried(() => renameSync(from, entry.path), options);
      } catch {
        unrestored.push(entry.name);
        // The temporary file with the earlier text stays, so the user can put it back.
        if (backup !== undefined) backups[entry.name] = shown(entry, backup);
      }
    }
    removeDirectories(created, paths);
    throw new WriteFailed(current, error, unrestored.reverse(), { ...details(), backups });
  }
}
