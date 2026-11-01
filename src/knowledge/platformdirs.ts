// platformdirs on macOS: the library Poetry and PDM ask for their user config directory, without an override
// (decision D-101). Shared by poetry.ts and pdm.ts, whose facts carry the source.
import type { LibraryDirectories, UserDirectory } from './types.ts';

export const PLATFORMDIRS_CHANGELOG = 'https://github.com/tox-dev/platformdirs/blob/4.14.2/docs/changelog.rst';

export const PLATFORMDIRS_NOTE =
  'The macOS user_config_dir by platformdirs version, read from the code at the tags: before 4.6.0 always ~/Library/Application Support/<app> (4.5.1 macos.py has no XDG support); 4.6.0 "Honor XDG environment variables on macOS" (#375): a non-empty XDG_CONFIG_HOME wins, a relative one too (os.environ.get("XDG_CONFIG_HOME", "").strip() in _xdg.py), and otherwise the config directory is user_data_dir, so a non-empty XDG_DATA_HOME gives $XDG_DATA_HOME/<app>; 4.9.6 "Fix macOS XDG variables leaking across user_config_dir, user_data_dir, and user_state_dir" (#473; 4.9.4 still returns user_data_dir); 4.11.8 "Ignore relative paths in XDG Base Directory environment variables and use the existing platform fallback" (#540, _xdg_dir with posixpath.isabs); the same in 4.14.2. A relative value is used as it is, so the tool reads it from the directory each command runs in.';

/** The macOS config directories platformdirs gives an app, by its version. */
export function platformdirsMacos(app: string): LibraryDirectories {
  const appSupport: UserDirectory = { from: 'home', path: `Library/Application Support/${app}` };
  const config = (absolute: boolean): UserDirectory => ({ from: absolute ? { env: 'XDG_CONFIG_HOME', absolute: true } : { env: 'XDG_CONFIG_HOME', relativeToCwd: true }, path: app });
  return {
    library: 'platformdirs',
    platforms: ['darwin'],
    directories: [
      { since: '0.0.0', value: [appSupport] },
      { since: '4.6.0', value: [config(false), { from: { env: 'XDG_DATA_HOME', relativeToCwd: true }, path: app }, appSupport] },
      { since: '4.9.6', value: [config(false), appSupport] },
      { since: '4.11.8', value: [config(true), appSupport] },
    ],
  };
}
