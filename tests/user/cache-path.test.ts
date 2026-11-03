// depcurfew's user cache directory, where depcurfew osv update keeps the local OSV.dev data (decision D-150): the user
// cache directory of platformdirs 4.14.2 on each platform.
import { describe, expect, it } from 'vitest';
import { osvDataDirectory, userCacheDirectory } from '../../src/user/cache-path.ts';

describe('the user cache directory', () => {
  it.each([
    ['Linux', { platform: 'linux' as const, home: '/home/ada', env: {} }, '/home/ada/.cache/depcurfew'],
    ['Linux with XDG_CACHE_HOME', { platform: 'linux' as const, home: '/home/ada', env: { XDG_CACHE_HOME: ' /var/cache/ada ' } }, '/var/cache/ada/depcurfew'],
    ['Linux with a relative XDG_CACHE_HOME, which is ignored', { platform: 'linux' as const, home: '/home/ada', env: { XDG_CACHE_HOME: 'cache' } }, '/home/ada/.cache/depcurfew'],
    ['macOS', { platform: 'darwin' as const, home: '/Users/ada', env: {} }, '/Users/ada/Library/Caches/depcurfew'],
    ['macOS with XDG_CACHE_HOME', { platform: 'darwin' as const, home: '/Users/ada', env: { XDG_CACHE_HOME: '/Users/ada/.cache' } }, '/Users/ada/.cache/depcurfew'],
    ['Windows', { platform: 'win32' as const, home: 'C:\\Users\\ada', env: { LOCALAPPDATA: 'D:\\Local' } }, 'D:\\Local\\depcurfew'],
    ['Windows without LOCALAPPDATA', { platform: 'win32' as const, home: 'C:\\Users\\ada', env: {} }, 'C:\\Users\\ada\\AppData\\Local\\depcurfew'],
  ])('%s', (_name, environment, expected) => {
    expect(userCacheDirectory(environment)).toBe(expected);
  });

  it('keeps the OSV.dev data in osv below it, and has none without an absolute home directory', () => {
    expect(osvDataDirectory({ platform: 'linux', home: '/home/ada', env: {} })).toBe('/home/ada/.cache/depcurfew/osv');
    expect(osvDataDirectory({ platform: 'win32', home: 'C:\\Users\\ada', env: {} })).toBe('C:\\Users\\ada\\AppData\\Local\\depcurfew\\osv');
    expect(osvDataDirectory({ platform: 'linux', home: '', env: {} })).toBeUndefined();
  });
});
