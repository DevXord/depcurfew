// Where the knowledge base puts user-level configuration files, resolved as apply --user and doctor --user resolve them.
import { describe, expect, it } from 'vitest';
import { pip } from '../../src/knowledge/pip.ts';
import { parseVersion } from '../../src/apply/version.ts';
import { userFileFor, userFilePath } from '../../src/user/locate.ts';

function pipConfig(version: string, env: Record<string, string>, existing: readonly string[]): string | undefined {
  const file = userFileFor(pip, parseVersion(version));
  if (file === null) return undefined;
  return userFilePath(file, { platform: 'darwin', home: '/Users/ada', env, isDirectory: (path) => existing.includes(path) });
}

describe('pip user file on macOS', () => {
  const library = '/Users/ada/Library/Application Support/pip';

  it('uses ~/Library/Application Support/pip when it exists, else ~/.config/pip, before 26.2', () => {
    expect(pipConfig('26.1.1', { XDG_DATA_HOME: '/data' }, [library, '/data/pip'])).toBe(`${library}/pip.conf`);
    expect(pipConfig('26.1.1', {}, [])).toBe('/Users/ada/.config/pip/pip.conf');
  });

  it('uses $XDG_DATA_HOME/pip from 26.2 (platformdirs 4.10.0), and skips the Library folder while XDG_DATA_HOME is set', () => {
    expect(pipConfig('26.2.2', { XDG_DATA_HOME: '/data' }, [library, '/data/pip'])).toBe('/data/pip/pip.conf');
    expect(pipConfig('26.2.0', { XDG_DATA_HOME: '/data' }, [library])).toBe('/Users/ada/.config/pip/pip.conf');
    expect(pipConfig('26.2.2', { XDG_DATA_HOME: '  ' }, [library])).toBe(`${library}/pip.conf`);
    expect(pipConfig('26.2.2', {}, [])).toBe('/Users/ada/.config/pip/pip.conf');
  });
});
