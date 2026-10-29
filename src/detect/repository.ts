// Read-only access to a repository: never leaves its root (also through symlinks), skips oversized files and
// collects warnings instead of throwing. Nothing in the repository is executed.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DetectionWarning } from './types.ts';

export const MAX_FILE_SIZE = 1024 * 1024;

/** Directories never searched for workspace packages or configuration. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0] ?? message;
}

export class Repository {
  readonly root: string;
  readonly warnings: DetectionWarning[] = [];
  readonly #warned = new Set<string>();

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  warn(code: string, message: string, files: readonly string[]): void {
    const key = `${code}\0${message}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.warnings.push({ code, message, files: [...files] });
  }

  #inside(real: string): boolean {
    return real === this.root || real.startsWith(this.root + sep);
  }

  /** The real path of a repository-relative path, or undefined if it is missing or leads outside. */
  #resolve(path: string, report: boolean): string | undefined {
    const full = join(this.root, path);
    try {
      lstatSync(full);
    } catch {
      return undefined;
    }
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      return undefined;
    }
    if (!this.#inside(real)) {
      if (report) this.warn('outside-repository', `${path} points outside the repository and was not read`, [path]);
      return undefined;
    }
    return real;
  }

  isFile(path: string): boolean {
    const real = this.#resolve(path, true);
    return real !== undefined && statSync(real).isFile();
  }

  /** The text of a file, without a byte order mark; undefined (with a warning when useful) if it cannot be read. */
  readText(path: string, limit = MAX_FILE_SIZE): string | undefined {
    const real = this.#resolve(path, true);
    if (real === undefined) return undefined;
    const stats = statSync(real);
    if (!stats.isFile()) return undefined;
    if (stats.size > limit) {
      this.warn('file-too-large', `${path} is larger than ${limit / (1024 * 1024)} MiB and was not read`, [path]);
      return undefined;
    }
    const text = readFileSync(real, 'utf8');
    return text.startsWith('﻿') ? text.slice(1) : text;
  }

  /** The first bytes of a file, e.g. to recognise a lockfile format without reading a large file. */
  readHead(path: string, bytes = 4096): string | undefined {
    const real = this.#resolve(path, true);
    if (real === undefined || !statSync(real).isFile()) return undefined;
    const buffer = Buffer.alloc(bytes);
    const descriptor = openSync(real, 'r');
    try {
      return buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0)).toString('utf8');
    } finally {
      closeSync(descriptor);
    }
  }

  /** Names of the files in a directory (following symlinks only inside the repository). */
  listFiles(path: string): string[] {
    return this.#entries(path).filter((entry) => entry.isFile).map((entry) => entry.name);
  }

  /** Names of the subdirectories of a directory, skipping node_modules, .git and symlinks that lead outside. */
  listDirectories(path: string): string[] {
    return this.#entries(path)
      .filter((entry) => entry.isDirectory && !SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name);
  }

  #entries(path: string): { name: string; isFile: boolean; isDirectory: boolean }[] {
    const real = this.#resolve(path, false);
    if (real === undefined) return [];
    let names: string[];
    try {
      names = readdirSync(real).sort();
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const target = this.#resolve(path === '.' ? name : `${path}/${name}`, false);
      if (target === undefined) continue;
      const stats = statSync(target);
      entries.push({ name, isFile: stats.isFile(), isDirectory: stats.isDirectory() });
    }
    return entries;
  }

  /** Parses a file with the given parser, reporting failures as warnings. */
  parse<T>(path: string, parser: (text: string) => T): T | undefined {
    const text = this.readText(path);
    if (text === undefined) return undefined;
    try {
      return parser(text);
    } catch (error) {
      this.warn('invalid-file', `cannot parse ${path}: ${errorMessage(error)}`, [path]);
      return undefined;
    }
  }

  relative(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }
}

/** Joins repository-relative paths with `/`, treating `.` as the root. */
export function joinPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
}
