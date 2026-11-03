// Read-only access to a repository: never leaves its root (also through symlinks), skips oversized files and
// collects warnings instead of throwing. Nothing in the repository is executed.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isInside } from '../paths.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { DetectionWarning } from './types.ts';

export const MAX_FILE_SIZE = 1024 * 1024;

/** Lockfiles are often larger than configuration files. */
export const MAX_LOCKFILE_SIZE = 64 * 1024 * 1024;

/** The names of lockfiles in the knowledge base (project.lockfiles of every tool), and the pattern of named pylock files. */
const LOCKFILE_NAMES: ReadonlySet<string> = new Set(
  knowledgeBase.flatMap((tool) => (tool.project === undefined ? [] : evidenceOf(tool.project.lockfiles).flatMap((entry) => entry.value.flatMap((version) => [...version.value])))),
);
const LOCKFILE_PATTERNS: readonly RegExp[] = knowledgeBase.flatMap((tool) => {
  const pattern = tool.extra?.['lockfilePattern'] === undefined ? undefined : evidenceOf(tool.extra['lockfilePattern'])[0]?.value;
  return typeof pattern === 'string' ? [new RegExp(pattern, 'u')] : [];
});

/**
 * The most a read of the file takes: the limit of lockfiles for a file named as a lockfile of a tool (in any directory),
 * the limit of configuration files otherwise. Every reader of a lockfile then uses the same limit, so that a lockfile a
 * lockfile rule reads is not reported as too large by another reader (decision D-166).
 */
export function readLimitFor(path: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return LOCKFILE_NAMES.has(name) || LOCKFILE_PATTERNS.some((pattern) => pattern.test(name)) ? MAX_LOCKFILE_SIZE : MAX_FILE_SIZE;
}

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
  /** Whether each directory (an absolute path) is its own real path: no symlink on the way from the file system root. */
  readonly #plain = new Map<string, boolean>();

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  warn(code: string, message: string, files: readonly string[], line?: number): void {
    const key = `${code}\0${message}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.warnings.push({ code, message, files: [...files], ...(line === undefined ? {} : { line }) });
  }

  /** A file that exists but cannot be read, e.g. without read permission; unreadable-config reports it. */
  #unreadable(path: string, error: unknown): void {
    this.warn('unreadable-file', `cannot read ${path} (${fileError(error)})`, [path]);
  }


  /**
   * Whether a directory (absolute and normalized) inside the root is its own real path, with no symlink on the way: the
   * root is, and a directory under it is when its parent is and it is no symlink itself (one lstat each, remembered). A
   * directory outside the root (reached through ..) never is: a path there is resolved in full, and only what leads
   * back inside is used, so nothing outside is remembered, listed or read (decision D-161).
   */
  #isPlain(directory: string): boolean {
    if (directory === this.root) return true;
    if (!isInside(this.root, directory)) return false;
    let plain = this.#plain.get(directory);
    if (plain === undefined) {
      try {
        plain = this.#isPlain(dirname(directory)) && lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() === false;
      } catch {
        plain = false;
      }
      this.#plain.set(directory, plain);
    }
    return plain;
  }

  /**
   * The real path of a repository-relative path with what stat says about it, or undefined if it is missing or leads
   * outside. A path that is not a symlink, in a directory with no symlink on the way, is its own real path: it is not
   * resolved again segment by segment (decision D-157). One that ends with a separator is: lstat follows a symlink there.
   * A missing path costs one lstat without an exception. With `read`, for a file whose content is read next, the path
   * is resolved in full anyway: a directory remembered as plain may have been replaced with a symlink since (decision
   * D-161), and one realpath per file read costs little next to the lookups the shortcut saves.
   */
  #resolve(path: string, report: boolean, read = false): { real: string; stats: Stats } | undefined {
    const full = join(this.root, path);
    let own: Stats | undefined;
    try {
      own = lstatSync(full, { throwIfNoEntry: false });
    } catch (error) {
      if (report && !MISSING.has(String((error as NodeJS.ErrnoException).code))) this.#unreadable(path, error);
      return undefined;
    }
    if (own === undefined) return undefined;
    let real: string;
    if (full === this.root || (!read && !own.isSymbolicLink() && !full.endsWith(sep) && this.#isPlain(dirname(full)))) real = full;
    else {
      try {
        real = realpathSync(full);
      } catch {
        return undefined;
      }
    }
    if (!isInside(this.root, real)) {
      if (report) this.warn('outside-repository', `${path} points outside the repository and was not read`, [path]);
      return undefined;
    }
    return { real, stats: real === full ? own : statSync(real) };
  }

  isFile(path: string): boolean {
    return this.#resolve(path, true)?.stats.isFile() === true;
  }

  /** Whether the path exists in the repository as something other than a regular file or a directory (a named pipe, a socket, a device). */
  isSpecialFile(path: string): boolean {
    const stats = this.#resolve(path, false)?.stats;
    return stats !== undefined && !stats.isFile() && !stats.isDirectory();
  }

  /**
   * The text of a file, without a byte order mark; undefined (with a warning when useful) if it cannot be read. The
   * limit is that of lockfiles for a lockfile and that of configuration files for the rest (readLimitFor).
   */
  readText(path: string, limit = readLimitFor(path)): string | undefined {
    const resolved = this.#resolve(path, true, true);
    if (resolved === undefined) return undefined;
    const { real, stats } = resolved;
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
    const resolved = this.#resolve(path, true, true);
    if (resolved === undefined || !resolved.stats.isFile()) return undefined;
    const { real } = resolved;
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

  /**
   * Names of the files in a directory (following symlinks only inside the repository). With `accept`, only the names it
   * accepts, and only those are resolved and stat-ed (decision D-157): a directory of many files costs one readdir.
   */
  listFiles(path: string, accept?: (name: string) => boolean): string[] {
    return this.#entries(path, accept).filter((entry) => entry.isFile).map((entry) => entry.name);
  }

  /** Names of the subdirectories of a directory, skipping node_modules, .git and symlinks that lead outside; `accept` as in listFiles. */
  listDirectories(path: string, accept?: (name: string) => boolean): string[] {
    return this.#entries(path, (name) => !SKIPPED_DIRECTORIES.has(name) && (accept === undefined || accept(name)))
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name);
  }

  /**
   * The real path of a file or directory of the repository, or undefined if it is missing or leads outside. A directory
   * known to have no symlink on the way, such as one just listed, costs nothing; the walk of workspace patterns keys
   * the directories it visited by it, so that a symlink back up does not make it walk them again (decision D-161).
   */
  realPath(path: string): string | undefined {
    const full = join(this.root, path);
    if (full === this.root || this.#plain.get(full) === true) return full;
    return this.#resolve(path, false)?.real;
  }

  /**
   * The entries of a directory whose names `accept` accepts, sorted by name; nothing else is resolved. An entry that is
   * not a symlink is what readdir says it is, inside the directory and so inside the repository; a symlink is resolved
   * like any path. A directory already known to have no symlink on the way, which is always one inside the root
   * (decision D-161), is not resolved again.
   */
  #entries(path: string, accept?: (name: string) => boolean): { name: string; isFile: boolean; isDirectory: boolean }[] {
    const full = join(this.root, path);
    const real = full === this.root || this.#plain.get(full) === true ? full : this.#resolve(path, false)?.real;
    if (real === undefined) return [];
    let found: Dirent[];
    try {
      found = readdirSync(real, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const entry of (accept === undefined ? found : found.filter((item) => accept(item.name))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const { name } = entry;
      if (!entry.isSymbolicLink()) {
        // Its path under a directory with no symlink on the way is its real path.
        if (real === full && entry.isDirectory()) this.#plain.set(join(full, name), true);
        entries.push({ name, isFile: entry.isFile(), isDirectory: entry.isDirectory() });
        continue;
      }
      const target = this.#resolve(path === '.' ? name : `${path}/${name}`, false);
      if (target !== undefined) entries.push({ name, isFile: target.stats.isFile(), isDirectory: target.stats.isDirectory() });
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
