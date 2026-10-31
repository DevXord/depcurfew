// User files located from the knowledge base (user.files), per platform and environment.
import { describe, expect, it } from 'vitest';
import { npm } from '../../src/knowledge/npm.ts';
import type { ToolKnowledge, UserFile } from '../../src/knowledge/types.ts';
import { pip } from '../../src/knowledge/pip.ts';
import { locateUserFile, shownPath, userFileFor, userFilePath } from '../../src/user/locate.ts';

const xdgFile: UserFile = {
  format: 'yaml',
  locations: [
    { platforms: ['linux'], directories: [{ from: { env: 'XDG_CONFIG_HOME', absolute: true }, path: 'tool' }, { from: 'home', path: '.config/tool' }], file: 'config.yaml' },
    { platforms: ['darwin'], directories: [{ from: 'home', path: 'Library/Application Support/tool', ifExists: true }, { from: 'home', path: '.config/tool' }], file: 'config.yaml' },
    { platforms: ['win32'], directories: [{ from: { env: 'APPDATA' }, path: 'tool' }, { from: 'home', path: 'AppData/Roaming/tool' }], file: 'config.ini' },
  ],
};

describe('userFilePath', () => {
  it('finds ~/.npmrc for npm, and %HOME% before the profile on Windows', () => {
    const file = userFileFor(npm, undefined);
    expect(file).not.toBeNull();
    expect(userFilePath(file!, { platform: 'linux', home: '/home/ada', env: {} })).toBe('/home/ada/.npmrc');
    expect(userFilePath(file!, { platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe('C:\\Users\\Ada\\.npmrc');
    expect(userFilePath(file!, { platform: 'win32', home: 'C:\\Users\\Ada', env: { HOME: 'D:\\ada' } })).toBe('D:\\ada\\.npmrc');
  });

  it('uses an environment variable only when it is set, and an absolute one only where the tool requires it', () => {
    expect(userFilePath(xdgFile, { platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '/srv/cfg' } })).toBe('/srv/cfg/tool/config.yaml');
    expect(userFilePath(xdgFile, { platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: 'cfg' } })).toBe('/home/ada/.config/tool/config.yaml');
    expect(userFilePath(xdgFile, { platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '  ' } })).toBe('/home/ada/.config/tool/config.yaml');
    expect(userFilePath(xdgFile, { platform: 'win32', home: 'C:\\Users\\Ada', env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' } })).toBe('C:\\Users\\Ada\\AppData\\Roaming\\tool\\config.ini');
    expect(userFilePath(xdgFile, { platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe('C:\\Users\\Ada\\AppData\\Roaming\\tool\\config.ini');
  });

  it('does not guess a path from a relative value a tool may use: locateUserFile says so, and userFilePath has none', () => {
    const file = userFileFor(pip, [26, 1, 0]);
    expect(file).not.toBeNull();
    const linux = { platform: 'linux' as const, home: '/home/ada', env: { XDG_CONFIG_HOME: 'cfg' } };
    expect(locateUserFile(file!, linux)).toEqual({ relative: { variable: 'XDG_CONFIG_HOME', value: 'cfg' } });
    expect(userFilePath(file!, linux)).toBeUndefined();
    expect(locateUserFile(file!, { platform: 'win32', home: 'C:\\Users\\Ada', env: { APPDATA: 'Roaming' } })).toEqual({ relative: { variable: 'APPDATA', value: 'Roaming' } });
    expect(locateUserFile(file!, { ...linux, env: { XDG_CONFIG_HOME: '/srv/cfg' } })).toEqual({ path: '/srv/cfg/pip/pip.conf' });
  });

  it('takes a directory marked ifExists only when it exists', () => {
    const exists = (path: string) => path === '/Users/ada/Library/Application Support/tool';
    expect(userFilePath(xdgFile, { platform: 'darwin', home: '/Users/ada', env: {}, isDirectory: exists })).toBe('/Users/ada/Library/Application Support/tool/config.yaml');
    expect(userFilePath(xdgFile, { platform: 'darwin', home: '/Users/ada', env: {}, isDirectory: () => false })).toBe('/Users/ada/.config/tool/config.yaml');
  });

  it('shows paths under the home directory with ~/', () => {
    expect(shownPath('/home/ada/.config/tool/config.yaml', { platform: 'linux', home: '/home/ada', env: {} })).toBe('~/.config/tool/config.yaml');
    expect(shownPath('/srv/cfg/tool/config.yaml', { platform: 'linux', home: '/home/ada', env: {} })).toBe('/srv/cfg/tool/config.yaml');
    expect(shownPath('C:\\Users\\Ada\\.npmrc', { platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe('~/.npmrc');
  });
});

describe('userFileFor', () => {
  const versioned = {
    ...npm,
    user: {
      ...npm.user!,
      files: { status: 'verified', source: 'https://github.com/npm/cli', verifiedAt: '2026-10-31', value: [{ since: '0.0.0', value: xdgFile }, { since: '11.0.0', value: null }] },
    },
  } as ToolKnowledge;

  it('picks the file of the version in use, and the latest one when the version is unknown', () => {
    expect(userFileFor(versioned, [10, 5, 0])).toBe(xdgFile);
    expect(userFileFor(versioned, [11, 0, 0])).toBeNull();
    expect(userFileFor(versioned, undefined)).toBeNull();
  });
});
