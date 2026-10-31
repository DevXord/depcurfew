// The user policy, which `--user` reads (decision D-087): a depcurfew.json in the user's configuration directory,
// so that it applies outside any project. This is depcurfew's own location, not a package manager fact.
import { posix, win32 } from 'node:path';
import { POLICY_FILE } from '../policy/defaults.ts';

export interface UserEnvironment {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

const DIRECTORY = 'depcurfew';

/** $XDG_CONFIG_HOME (when absolute) or ~/.config on Linux and macOS; %APPDATA% or the profile's roaming folder on Windows. */
export function userPolicyPath({ platform, home, env }: UserEnvironment): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base = appData !== undefined && win32.isAbsolute(appData) ? appData : win32.join(home, 'AppData', 'Roaming');
    return win32.join(base, DIRECTORY, POLICY_FILE);
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(home, '.config');
  return posix.join(base, DIRECTORY, POLICY_FILE);
}
