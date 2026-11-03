// depcurfew's user cache directory, where depcurfew osv update keeps its local copy of the OSV.dev data (decision D-150).
// This is depcurfew's own location, not a package manager fact. It follows the user cache directory of platformdirs
// 4.14.2 (user_cache_dir in src/platformdirs/_xdg.py, unix.py, macos.py and windows.py at the tag), which Python tools
// use: $XDG_CACHE_HOME when it is set to an absolute path (trimmed; a relative or empty one is ignored), else ~/.cache on
// Linux and ~/Library/Caches on macOS; %LOCALAPPDATA% on Windows (when absolute), else the profile's AppData\Local. As
// for the user policy (decision D-087), XDG_CACHE_HOME counts on macOS too.
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

/** depcurfew's user cache directory; undefined when the home directory is not an absolute path and no variable names one. */
export function userCacheDirectory({ platform, home, env }: CacheEnvironment): string | undefined {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']?.trim();
    if (local !== undefined && win32.isAbsolute(local)) return win32.join(local, DIRECTORY);
    return win32.isAbsolute(home) ? win32.join(home, 'AppData', 'Local', DIRECTORY) : undefined;
  }
  const xdg = env['XDG_CACHE_HOME']?.trim();
  if (xdg !== undefined && posix.isAbsolute(xdg)) return posix.join(xdg, DIRECTORY);
  if (!posix.isAbsolute(home)) return undefined;
  return platform === 'darwin' ? posix.join(home, 'Library', 'Caches', DIRECTORY) : posix.join(home, '.cache', DIRECTORY);
}

/** The directory of the local OSV.dev data; undefined when there is no user cache directory. */
export function osvDataDirectory(environment: CacheEnvironment): string | undefined {
  const base = userCacheDirectory(environment);
  if (base === undefined) return undefined;
  return (environment.platform === 'win32' ? win32 : posix).join(base, OSV_DIRECTORY);
}
