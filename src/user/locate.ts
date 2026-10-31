// Where a tool keeps its user-level configuration, from the knowledge base (`user.files`): the first location for the
// platform, and in it the first directory that applies (an environment variable that is set, the home directory).
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { evidenceOf } from '../knowledge/facts.ts';
import type { ToolKnowledge, UserDirectory, UserFile, UserPlatform } from '../knowledge/types.ts';
import { compareVersions, parseVersion, type Version } from '../apply/version.ts';

export interface UserEnvironment {
  platform: NodeJS.Platform;
  /** HOME on Linux and macOS, USERPROFILE on Windows: what os.homedir() returns. */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
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

/** The user file of the version in use (the latest known one when the version is unknown); null when there is none. */
export function userFileFor(tool: ToolKnowledge, version: Version | undefined): UserFile | null {
  const fact = tool.user?.files;
  if (fact === undefined) return null;
  const entries = evidenceOf(fact)[0]?.value ?? [];
  let chosen: UserFile | null = null;
  for (const entry of entries) {
    const since = parseVersion(entry.since);
    if (version === undefined || since === undefined || compareVersions(since, version) <= 0) chosen = entry.value;
  }
  return chosen;
}

/** An environment variable that names the directory of a user file with a relative path. */
export interface RelativeDirectory {
  variable: string;
  value: string;
}

type Directory = { path: string } | { relative: RelativeDirectory } | undefined;

function directoryOf(directory: UserDirectory, environment: UserEnvironment): Directory {
  const path = paths(environment.platform);
  let base: string | undefined;
  if (directory.from === 'home') {
    base = environment.home;
  } else {
    const value = environment.env[directory.from.env]?.trim();
    if (value === undefined || value === '') return undefined;
    if (!path.isAbsolute(value)) {
      // With `absolute` the knowledge base records that the tool skips a relative value. Without it, nobody knows
      // where the tool looks then (from the directory each command runs in?), so the location cannot be worked out.
      return directory.from.absolute === true ? undefined : { relative: { variable: directory.from.env, value } };
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
export function locateUserFile(file: UserFile, environment: UserEnvironment): { path: string } | { relative: RelativeDirectory } | undefined {
  const family = platformFamily(environment.platform);
  const location = file.locations.find((candidate) => candidate.platforms.includes(family));
  if (location === undefined) return undefined;
  for (const directory of location.directories) {
    const base = directoryOf(directory, environment);
    if (base === undefined) continue;
    return 'relative' in base ? base : { path: paths(environment.platform).join(base.path, location.file) };
  }
  return undefined;
}

/** The absolute path of the user file on this platform, or undefined when no location applies or it is unknown. */
export function userFilePath(file: UserFile, environment: UserEnvironment): string | undefined {
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
