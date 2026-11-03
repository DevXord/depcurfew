// depcurfew's user cache directory, where depcurfew osv update keeps its local copy of the OSV.dev data (decision D-150).
// This is depcurfew's own location, not a package manager fact. It follows the user cache directory of platformdirs
// 4.14.2 (user_cache_dir in src/platformdirs/_xdg.py, unix.py, macos.py and windows.py at the tag), which Python tools
// use: $XDG_CACHE_HOME when it is set to an absolute path (trimmed; a relative or empty one is ignored), else ~/.cache on
// Linux and ~/Library/Caches on macOS; %LOCALAPPDATA% on Windows (when absolute), else the profile's AppData\Local. As
// for the user policy (decision D-087), XDG_CACHE_HOME counts on macOS too.
//
// Other users who can write one of these directories can change the data that check, the hook, depcurfew mcp and
// doctor look versions up in (decision D-156): cacheWriteProblem finds such a directory on POSIX systems, so that osv
// update and the lookups can warn.
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface CacheEnvironment {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** The folder of depcurfew in the user cache directory. */
const DIRECTORY = 'depcurfew';
/** The folder of the local OSV.dev data in it. */
const OSV_DIRECTORY = 'osv';

/** The user cache directory of the platform (not depcurfew's folder in it); undefined as for userCacheDirectory. */
function userCacheBase({ platform, home, env }: CacheEnvironment): string | undefined {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim();
    if (local !== undefined && win32.isAbsolute(local)) return win32.normalize(local);
    return win32.isAbsolute(home) ? win32.join(home, 'AppData', 'Local') : undefined;
  }
  const xdg = env['XDG_CACHE_HOME']?.trim();
  if (xdg !== undefined && posix.isAbsolute(xdg)) return posix.resolve(xdg);
  if (!posix.isAbsolute(home)) return undefined;
  return platform === 'darwin' ? posix.join(home, 'Library', 'Caches') : posix.join(home, '.cache');
}

/** depcurfew's user cache directory; undefined when the home directory is not an absolute path and no variable names one. */
export function userCacheDirectory(environment: CacheEnvironment): string | undefined {
  const base = userCacheBase(environment);
  return base === undefined ? undefined : (environment.platform === 'win32' ? win32 : posix).join(base, DIRECTORY);
}

/** The directory of the local OSV.dev data; undefined when there is no user cache directory. */
export function osvDataDirectory(environment: CacheEnvironment): string | undefined {
  return osvDataDirectories(environment).at(-1);
}

/**
 * The directories other users must not be able to write, from the top: the user cache directory, depcurfew's folder in
 * it and the folder of the local OSV.dev data (decision D-156); none when there is no user cache directory.
 */
export function osvDataDirectories(environment: CacheEnvironment): string[] {
  const base = userCacheBase(environment);
  if (base === undefined) return [];
  const path = environment.platform === 'win32' ? win32 : posix;
  return [base, path.join(base, DIRECTORY), path.join(base, DIRECTORY, OSV_DIRECTORY)];
}

/** The user whose files these are, for the check of owners. */
export interface PosixUser {
  uid: number;
  /** The user's primary group. */
  gid: number;
}

/** The user of this process; undefined where there are no POSIX user ids (Windows). */
export function currentUser(): PosixUser | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return undefined;
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * A directory other users can write: every user may (its mode lets others write, sticky or not: they can still add
 * files), the members of its group may (a group other than the user's own primary group, which on systems with a
 * private group per user and umask 002 holds only the user), or it belongs to another user than the user and root.
 * `own` says whether it belongs to the user, who can then take the access away; `id` is the group or the owner.
 */
export interface CacheWriteProblem {
  directory: string;
  kind: 'everyone' | 'group' | 'owner';
  own: boolean;
  id?: number;
}

const OTHERS_WRITE = 0o002;
const GROUP_WRITE = 0o020;

/**
 * The first of `directories` (from the top) that other users can write, as CacheWriteProblem says; undefined when none
 * can be, on Windows, and for a directory that does not exist (yet) or cannot be read. Symbolic links are followed: the
 * directory the data is in counts, and the link itself is as safe as the directory above it.
 */
export function cacheWriteProblem(directories: readonly string[], user: PosixUser | undefined = currentUser()): CacheWriteProblem | undefined {
  if (user === undefined) return undefined;
  for (const directory of directories) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(directory, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (stats === undefined || !stats.isDirectory()) continue;
    const own = stats.uid === user.uid;
    if (!own && stats.uid !== 0) return { directory, kind: 'owner', own, id: stats.uid };
    if ((stats.mode & OTHERS_WRITE) !== 0) return { directory, kind: 'everyone', own };
    if ((stats.mode & GROUP_WRITE) !== 0 && stats.gid !== user.gid) return { directory, kind: 'group', own, id: stats.gid };
  }
  return undefined;
}
