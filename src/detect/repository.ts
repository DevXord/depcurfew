// Read-only access to a repository: never leaves its root (also through symlinks), skips oversized files and
// collects warnings instead of throwing. Nothing in the repository is executed.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isInside } from '../paths.ts';
import type { DetectionWarning } from './types.ts';

export const MAX_FILE_SIZE = 1024 * 1024;

/** Directories never searched for workspace packages or configuration. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0] ?? message;
}

/** A file system error without the absolute path, e.g. "EACCES: permission denied". */
function fileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = errorMessage(error);
  return code !== undefined && message.startsWith(`${code}: `) ? (message.split(', ', 1)[0] ?? code) : (code ?? 'unknown error');
}

/** Errors that mean the path does not exist, as opposed to a file that exists but cannot be read. */
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export class Repository {
  readonly root: string;
  readonly warnings: DetectionWarning[] = [];
  /** Repository-relative paths of the files that were read, for the log of what doctor checked. */
  readonly read = new Set<string>();
  readonly #warned = new Set<string>();
  readonly #parsed = new Map<(text: string) => unknown, Map<string, unknown>>();

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  warn(code: string, message: string, files: readonly string[]): void {
    const key = `${code}\0${message}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.warnings.push({ code, message, files: [...files] });
  }

  /** A file that exists but cannot be read, e.g. without read permission; unreadable-config reports it. */
  #unreadable(path: string, error: unknown): void {
    this.warn('unreadable-file', `cannot read ${path} (${fileError(error)})`, [path]);
  }


  /** The real path of a repository-relative path, or undefined if it is missing or leads outside. */
  #resolve(path: string, report: boolean): string | undefined {
    const full = join(this.root, path);
    try {
      lstatSync(full);
    } catch (error) {
      if (report && !MISSING.has(String((error as NodeJS.ErrnoException).code))) this.#unreadable(path, error);
      return undefined;
    }
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      return undefined;
    }
    if (!isInside(this.root, real)) {
      if (report) this.warn('outside-repository', `${path} points outside the repository and was not read`, [path]);
      return undefined;
    }
    return real;
  }

  isFile(path: string): boolean {
    const real = this.#resolve(path, true);
    return real !== undefined && statSync(real).isFile();
  }

  /** Whether the path exists in the repository as something other than a regular file or a directory (a named pipe, a socket, a device). */
  isSpecialFile(path: string): boolean {
    const real = this.#resolve(path, false);
    if (real === undefined) return false;
    const stats = statSync(real);
    return !stats.isFile() && !stats.isDirectory();
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
    let text: string;
    try {
      text = readFileSync(real, 'utf8');
    } catch (error) {
      this.#unreadable(path, error);
      return undefined;
    }
    this.read.add(path);
    return text.startsWith('﻿') ? text.slice(1) : text;
  }

  /** The first bytes of a file, e.g. to recognize a lockfile format without reading a large file. */
  readHead(path: string, bytes = 4096): string | undefined {
    const real = this.#resolve(path, true);
    if (real === undefined || !statSync(real).isFile()) return undefined;
    const buffer = Buffer.alloc(bytes);
    let descriptor: number;
    try {
      descriptor = openSync(real, 'r');
    } catch (error) {
      this.#unreadable(path, error);
      return undefined;
    }
    try {
      const head = buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0)).toString('utf8');
      this.read.add(path);
      return head;
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

  /** Like parse, but each file is read and parsed once per parser: several rules read the same file. */
  parseOnce<T>(path: string, parser: (text: string) => T): T | undefined {
    let cache = this.#parsed.get(parser);
    if (cache === undefined) {
      cache = new Map();
      this.#parsed.set(parser, cache);
    }
    if (!cache.has(path)) cache.set(path, this.parse(path, parser));
    return cache.get(path) as T | undefined;
  }

  relative(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }
}

/** Joins repository-relative paths with `/`, treating `.` as the root. */
export function joinPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
}
