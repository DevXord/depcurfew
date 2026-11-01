// Where a tool keeps its user-level configuration, from the knowledge base (`user.files`): the first location for the
// platform, and in it the first directory that applies (an environment variable that is set, the home directory).
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { evidenceOf } from '../knowledge/facts.ts';
import type { LibraryDirectories, ToolKnowledge, UserDirectory, UserFile, UserLocation, UserPlatform, Versioned } from '../knowledge/types.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';

export interface UserEnvironment {
  platform: NodeJS.Platform;
  /** HOME on Linux and macOS, USERPROFILE on Windows: what os.homedir() returns. */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The current directory, against which a tool resolves a relative XDG_CONFIG_HOME (relativeToCwd); process.cwd() by default. */
  cwd?: string;
  /** Whether a directory exists; replaceable in tests. */
  isDirectory?: (path: string) => boolean;
}

const paths = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The platform family a location names; anything that is not Windows or macOS counts as Linux. */
export function platformFamily(platform: NodeJS.Platform): UserPlatform {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
}

/** The value of a versioned fact for a version: the last entry it has reached, or the latest for an unknown version. */
function versioned<T>(entries: Versioned<T>, version: Version | undefined): T | undefined {
  let chosen: T | undefined;
  for (const entry of entries) {
    const since = parseVersion(entry.since);
    if (version === undefined || since === undefined || compareVersions(since, version) <= 0) chosen = entry.value;
  }
  return chosen;
}

/** The directories of the file on the platforms a library decides, for a version of the library. */
function withLibrary(file: UserFile, library: LibraryDirectories, directories: readonly UserDirectory[]): UserFile {
  return {
    ...file,
    locations: file.locations.map((location) =>
      location.platforms.some((platform) => library.platforms.includes(platform)) ? { ...location, directories } : location,
    ),
  };
}

/**
 * The user file of the version in use (the latest known one when the version is unknown); null when there is none.
 * Where a library the tool calls decides the directories (platformdirs for Poetry and PDM on macOS), its version
 * picks them; without it the directories are those of `files` (where the docs say).
 */
export function userFileFor(tool: ToolKnowledge, version: Version | undefined, libraryVersion?: Version): UserFile | null {
  const fact = tool.user?.files;
  if (fact === undefined) return null;
  const chosen = versioned(evidenceOf(fact)[0]?.value ?? [], version) ?? null;
  const library = tool.user?.libraryDirectories === undefined ? undefined : evidenceOf(tool.user.libraryDirectories)[0]?.value;
  if (chosen === null || library === undefined || libraryVersion === undefined) return chosen;
  const directories = versioned(library.directories, libraryVersion);
  return directories === undefined ? chosen : withLibrary(chosen, library, directories);
}

/** A user file as each range of versions of the library would place it, oldest first; empty when no library decides it. */
export function libraryVariants(tool: ToolKnowledge, version: Version | undefined): { library: string; since: string; until?: string; file: UserFile }[] {
  const file = userFileFor(tool, version);
  const library = tool.user?.libraryDirectories === undefined ? undefined : evidenceOf(tool.user.libraryDirectories)[0]?.value;
  if (file === null || library === undefined) return [];
  return library.directories.map((entry, index) => {
    const until = library.directories[index + 1]?.since;
    return { library: library.library, since: entry.since, ...(until === undefined ? {} : { until }), file: withLibrary(file, library, entry.value) };
  });
}

/** An environment variable that names the directory of a user file with a relative path. */
export interface RelativeDirectory {
  variable: string;
  value: string;
  /** The user file below the relative directory, as relative as the variable (cfg/pip/pip.conf). */
  file: string;
  /**
   * When the knowledge base records that the tool resolves the value against the directory each command runs in
   * (relativeToCwd): the absolute path of the file it reads from the current directory.
   */
  path?: string;
}

type Directory = { path: string } | { relative: Omit<RelativeDirectory, 'file' | 'path'>; directory: string; fromCwd: boolean } | undefined;

function directoryOf(directory: UserDirectory, environment: UserEnvironment): Directory {
  const path = paths(environment.platform);
  if (directory.unlessEnv !== undefined && (environment.env[directory.unlessEnv]?.trim() ?? '') !== '') return undefined;
  let base: string | undefined;
  if (directory.from === 'home') {
    base = environment.home;
  } else {
    const value = environment.env[directory.from.env]?.trim();
    // A tool that takes any value that is set (Corepack's ??) reads an empty one as a relative path.
    if (value === undefined || (value === '' && directory.from.emptyCounts !== true)) return undefined;
    if (!path.isAbsolute(value)) {
      // With `absolute` the knowledge base records that the tool skips a relative value, and with `relativeToCwd` that
      // it reads from the directory each command runs in. Without either, nobody knows where the tool looks then. Either
      // way there is no one place for apply --user to write to.
      if (directory.from.absolute === true) return undefined;
      const below = directory.path === '' ? value : path.join(value, ...directory.path.split('/'));
      return { relative: { variable: directory.from.env, value }, directory: below, fromCwd: directory.from.relativeToCwd === true };
    }
    base = value;
  }
  const joined = directory.path === '' ? base : path.join(base, ...directory.path.split('/'));
  if (directory.ifExists === true && !(environment.isDirectory ?? isDirectory)(joined)) return undefined;
  return { path: joined };
}

/**
 * Where the user file is on this platform: its absolute path; or `relative` when the variable that decides it is set
 * to a relative path whose meaning to the tool is unknown; undefined when no location applies.
 */
export function locateUserFile(file: { locations: readonly UserLocation[] }, environment: UserEnvironment): { path: string } | { relative: RelativeDirectory } | undefined {
  const family = platformFamily(environment.platform);
  const location = file.locations.find((candidate) => candidate.platforms.includes(family));
  if (location === undefined) return undefined;
  const module = paths(environment.platform);
  for (const directory of location.directories) {
    const base = directoryOf(directory, environment);
    if (base === undefined) continue;
    if (!('relative' in base)) return { path: module.join(base.path, location.file) };
    const file = module.join(base.directory, location.file);
    return { relative: { ...base.relative, file, ...(base.fromCwd ? { path: module.resolve(environment.cwd ?? process.cwd(), file) } : {}) } };
  }
  return undefined;
}

/** The absolute path of the user file on this platform, or undefined when no location applies or it is unknown. */
export function userFilePath(file: { locations: readonly UserLocation[] }, environment: UserEnvironment): string | undefined {
  const located = locateUserFile(file, environment);
  return located === undefined || 'relative' in located ? undefined : located.path;
}

/** A path for messages: under the home directory it starts with ~/, with / as the separator. */
export function shownPath(path: string, environment: UserEnvironment): string {
  const module = paths(environment.platform);
  const inside = module.relative(environment.home, path);
  if (inside === '' || inside.startsWith('..') || module.isAbsolute(inside)) return path;
  return `~/${inside.split(module.sep).join('/')}`;
}
