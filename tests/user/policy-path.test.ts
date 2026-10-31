// Where the user policy lives (decision D-087): $XDG_CONFIG_HOME/depcurfew/depcurfew.json or ~/.config/depcurfew on
// Linux and macOS, %APPDATA%\depcurfew\depcurfew.json on Windows.
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userPolicyPath } from '../../src/user/policy-path.ts';

describe('userPolicyPath', () => {
  it('uses ~/.config on Linux and macOS', () => {
    expect(userPolicyPath({ platform: 'linux', home: '/home/ada', env: {} })).toBe('/home/ada/.config/depcurfew/depcurfew.json');
    expect(userPolicyPath({ platform: 'darwin', home: '/Users/ada', env: {} })).toBe('/Users/ada/.config/depcurfew/depcurfew.json');
  });

  it('follows an absolute XDG_CONFIG_HOME and ignores a relative one, as the XDG specification says', () => {
    expect(userPolicyPath({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '/srv/config' } })).toBe('/srv/config/depcurfew/depcurfew.json');
    expect(userPolicyPath({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: 'config' } })).toBe('/home/ada/.config/depcurfew/depcurfew.json');
    expect(userPolicyPath({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '' } })).toBe('/home/ada/.config/depcurfew/depcurfew.json');
  });

  it('uses %APPDATA% on Windows, else the roaming folder in the profile', () => {
    expect(userPolicyPath({ platform: 'win32', home: 'C:\\Users\\Ada', env: { APPDATA: 'D:\\Roaming' } })).toBe('D:\\Roaming\\depcurfew\\depcurfew.json');
    expect(userPolicyPath({ platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe('C:\\Users\\Ada\\AppData\\Roaming\\depcurfew\\depcurfew.json');
  });

  it('returns paths in the platform style', () => {
    expect(posix.isAbsolute(userPolicyPath({ platform: 'linux', home: '/root', env: {} }))).toBe(true);
    expect(win32.isAbsolute(userPolicyPath({ platform: 'win32', home: 'C:\\Users\\Ada', env: {} }))).toBe(true);
  });
});
