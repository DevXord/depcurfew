// A buffer of edited files: generators read and edit text with LF line endings, and the original line endings,
// byte order mark and final newline are restored when the changes are collected. Nothing is written here.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
    let original: string | null = null;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`${file} is a symlink; depcurfew does not write through symlinks`);
      original = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
      const after = restoreStyle(entry.body, entry.style);
      if (after !== entry.original) changes.push({ file, before: entry.original, after });
    }
    return changes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
}

/** Writes each changed file through a temporary file and a rename, keeping the permissions of existing files. */
export function writeChanges(root: string, changes: readonly FileChange[]): void {
  for (const change of changes) {
    const path = join(root, change.file);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.depcurfew-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, change.after, { flag: 'wx' });
    if (change.before !== null) chmodSync(temporary, statSync(path).mode);
    renameSync(temporary, path);
  }
}
