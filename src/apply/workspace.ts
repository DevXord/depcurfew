// A buffer of edited files: generators read and edit text with LF line endings, and the original line endings,
// byte order mark and final newline are restored when the changes are collected. Nothing is written here, except by
// writeChanges, which writes all changes or none.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
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
    if (parent !== this.root && !parent.startsWith(this.root + sep)) throw new Error(`${file} is outside the repository`);
    let bytes: Buffer | undefined;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`${file} is a symlink; depcurfew does not write through symlinks`);
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

/**
 * A file could not be written. writeChanges has removed its temporary files and put back the files it had already
 * replaced, so nothing changed, except for the files in `unrestored`. The message says why, without the file name.
 */
export class WriteFailed extends Error {
  readonly file: string;
  /** Why, in plain words. */
  readonly reason: string;
  /** Files already replaced that could not be put back (normally none). */
  readonly unrestored: string[];

  constructor(file: string, error: unknown, unrestored: string[]) {
    const reason = fileSystemReason(error);
    super(unrestored.length === 0 ? reason : `${reason}; ${unrestored.join(', ')} had already been replaced and could not be put back`, { cause: error });
    this.file = file;
    this.reason = reason;
    this.unrestored = unrestored;
  }
}

interface Staged {
  change: FileChange;
  path: string;
  temporary: string;
  mode: number;
}

let counter = 0;

/** Writes `text` to a new temporary file next to `path`, created with `mode`; the file is removed if writing fails. */
function stage(path: string, text: string, mode: number): string {
  counter += 1;
  const temporary = `${path}.depcurfew-${process.pid}-${Date.now()}-${counter}`;
  try {
    // Created with the final mode (the umask can only narrow it), so a file such as .npmrc with a token in it is
    // never readable by others, not even for a moment; chmod then sets the mode exactly.
    writeFileSync(temporary, text, { flag: 'wx', mode });
    chmodSync(temporary, mode);
  } catch (error) {
    // 'wx' fails when the name exists: that file is not ours.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(temporary, { force: true });
    throw error;
  }
  return temporary;
}

/** Removes the directories mkdirSync created (`created`, the topmost of each) for `paths`, deepest first, if empty. */
function removeDirectories(created: readonly string[], paths: readonly string[]): void {
  const directories = new Set<string>();
  for (const top of created) {
    for (const path of paths) {
      for (let directory = dirname(path); directory === top || directory.startsWith(top + sep); directory = dirname(directory)) directories.add(directory);
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
 * temporary files are removed and the files already replaced get their old text back, and WriteFailed is thrown.
 */
export function writeChanges(root: string, changes: readonly FileChange[]): void {
  const staged: Staged[] = [];
  const created: string[] = [];
  let current = changes[0]?.file ?? '';
  try {
    for (const change of changes) {
      current = change.file;
      const path = join(root, change.file);
      const directory = mkdirSync(dirname(path), { recursive: true });
      if (directory !== undefined) created.push(directory);
      const mode = change.before === null ? 0o666 : statSync(path).mode & 0o7777;
      staged.push({ change, path, temporary: stage(path, change.after, mode), mode });
    }
  } catch (error) {
    for (const entry of staged) rmSync(entry.temporary, { force: true });
    removeDirectories(created, changes.map((change) => join(root, change.file)));
    throw new WriteFailed(current, error, []);
  }

  const renamed: Staged[] = [];
  try {
    for (const entry of staged) {
      current = entry.change.file;
      renameSync(entry.temporary, entry.path);
      renamed.push(entry);
    }
  } catch (error) {
    for (const entry of staged.slice(renamed.length)) rmSync(entry.temporary, { force: true });
    const unrestored: string[] = [];
    for (const entry of renamed.reverse()) {
      try {
        if (entry.change.before === null) rmSync(entry.path, { force: true });
        else renameSync(stage(entry.path, entry.change.before, entry.mode), entry.path);
      } catch {
        unrestored.push(entry.change.file);
      }
    }
    removeDirectories(created, changes.map((change) => join(root, change.file)));
    throw new WriteFailed(current, error, unrestored.reverse());
  }
}
