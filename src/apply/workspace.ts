// A buffer of edited files: generators read and edit text with LF line endings, and the original line endings,
// byte order mark and final newline are restored when the changes are collected. Nothing is written here, except by
// writeChanges, which writes all changes or none.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { MAX_FILE_SIZE } from '../detect/repository.ts';
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
  };
  if (code !== undefined && reasons[code] !== undefined) return reasons[code];
  return code ?? (error instanceof Error ? error.message : String(error));
}

/** Decodes UTF-8 strictly: a byte sequence that is not UTF-8 would otherwise become U+FFFD and be written back so. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class Workspace {
  readonly root: string;
  readonly #files = new Map<string, Entry>();

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  #load(file: string): Entry {
    const cached = this.#files.get(file);
    if (cached !== undefined) return cached;
    const path = join(this.root, file);
    let parent: string;
    try {
      parent = realpathSync(dirname(path));
    } catch {
      parent = this.root;
    }
    if (!isInside(this.root, parent)) throw new Error(`${file} is outside the repository`);
    let bytes: Buffer | undefined;
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new Error(`${file} is a symlink; depcurfew does not write through symlinks`);
      // The same limit as for reading configuration (Repository): a huge file would take as much memory several times over.
      if (stats.isFile() && stats.size > MAX_FILE_SIZE) throw new Error(`${file} is larger than 1 MiB, so depcurfew does not edit it`);
      bytes = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === undefined) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${file} cannot be read: ${fileSystemReason(error)}`);
    }
    let original: string | null = null;
    if (bytes !== undefined) {
      try {
        original = UTF8.decode(bytes);
      } catch {
        throw new Error(`${file} is not valid UTF-8, so depcurfew does not edit it; save it as UTF-8`);
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
  /** Temporary files that could not be removed, relative to the root. */
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

interface Staged {
  change: FileChange;
  path: string;
  temporary: string;
  /** The mode of the file it replaces; undefined for a new file. */
  mode: number | undefined;
}

let counter = 0;

/**
 * Writes `text` to a new temporary file next to `path`; the file is removed if writing fails. It replaces a file of
 * mode `mode`, or with undefined it becomes a new file, whose mode the umask decides (0666 narrowed by it), as for
 * any file a program creates.
 */
function stage(path: string, text: string, mode: number | undefined): string {
  counter += 1;
  const temporary = `${path}.depcurfew-${process.pid}-${Date.now()}-${counter}`;
  try {
    // Created with the final mode (the umask can only narrow it), so a file such as .npmrc with a token in it is
    // never readable by others, not even for a moment; for a file it replaces, chmod then sets that mode exactly.
    writeFileSync(temporary, text, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) chmodSync(temporary, mode);
  } catch (error) {
    // 'wx' fails when the name exists: that file is not ours.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(temporary, { force: true });
    throw error;
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
 * Writes each changed file through a temporary file and a rename, keeping the permissions of existing files. All
 * files or none: every temporary file is written first and only then are they renamed; if anything fails, the
 * temporary files are removed and the files already replaced get their old text back, and WriteFailed is thrown. On
 * Windows, renames and removals are tried again for a few seconds while another program holds the file.
 */
export function writeChanges(root: string, changes: readonly FileChange[], options: WriteOptions = {}): void {
  const staged: Staged[] = [];
  const created: string[] = [];
  const leftovers: string[] = [];
  const shown = (path: string) => relative(root, path).split(sep).join('/');
  /** Removes a temporary file; one that stays is named in the error. */
  const remove = (temporary: string) => {
    try {
      retried(() => rmSync(temporary, { force: true }), options);
    } catch {
      leftovers.push(shown(temporary));
    }
  };
  const details = () => ({ ...(options.platform === undefined ? {} : { platform: options.platform }), leftovers });
  let current = changes[0]?.file ?? '';
  try {
    for (const change of changes) {
      current = change.file;
      const path = join(root, change.file);
      const top = missingTop(dirname(path));
      // Recorded first, so that the directories are removed even when mkdirSync creates some of them and then fails.
      if (top !== undefined) created.push(top);
      mkdirSync(dirname(path), { recursive: true });
      const mode = change.before === null ? undefined : statSync(path).mode & 0o7777;
      staged.push({ change, path, temporary: stage(path, change.after, mode), mode });
    }
  } catch (error) {
    for (const entry of staged) remove(entry.temporary);
    removeDirectories(created, changes.map((change) => join(root, change.file)));
    throw new WriteFailed(current, error, [], details());
  }

  const renamed: Staged[] = [];
  try {
    for (const entry of staged) {
      current = entry.change.file;
      retried(() => renameSync(entry.temporary, entry.path), options);
      renamed.push(entry);
    }
  } catch (error) {
    for (const entry of staged.slice(renamed.length)) remove(entry.temporary);
    const unrestored: string[] = [];
    const backups: Record<string, string> = {};
    for (const entry of renamed.reverse()) {
      if (entry.change.before === null) {
        try {
          retried(() => rmSync(entry.path, { force: true }), options);
        } catch {
          unrestored.push(entry.change.file);
        }
        continue;
      }
      let backup: string | undefined;
      try {
        backup = stage(entry.path, entry.change.before, entry.mode);
        const from = backup;
        retried(() => renameSync(from, entry.path), options);
      } catch {
        unrestored.push(entry.change.file);
        // The temporary file with the earlier text stays, so the user can put it back.
        if (backup !== undefined) backups[entry.change.file] = shown(backup);
      }
    }
    removeDirectories(created, changes.map((change) => join(root, change.file)));
    throw new WriteFailed(current, error, unrestored.reverse(), { ...details(), backups });
  }
}
