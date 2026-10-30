// Reading and writing files in apply (D-074): all files or none are written, a temporary file never has wider
// permissions than the file it replaces, a file that is not UTF-8 is not edited, and lines apply does not change
// keep their own line endings.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { restoreStyle, detectStyle, toLf } from '../../src/apply/text.ts';
import { Workspace, WriteFailed, writeChanges } from '../../src/apply/workspace.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(files: Record<string, string | Buffer> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-workspace-'));
  temporary.push(directory);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  return directory;
}

describe('writeChanges writes all files or none', () => {
  it('puts back the files it replaced and removes the ones it created when a rename fails', () => {
    const directory = scratch({ '.npmrc': 'save-exact=true\n', 'package.json': '{}\n' });
    // A directory where a file is to be replaced: the rename fails (EISDIR) after the other files were renamed.
    mkdirSync(join(directory, 'renovate.json', 'inner'), { recursive: true });
    const changes = [
      { file: '.npmrc', before: 'save-exact=true\n', after: 'save-exact=true\nmin-release-age=3\n' },
      { file: 'bunfig.toml', before: null, after: '[install]\n' },
      { file: 'renovate.json', before: '{}\n', after: '{ "minimumReleaseAge": "3 days" }\n' },
    ];
    let failure: unknown;
    try {
      writeChanges(directory, changes);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WriteFailed);
    expect((failure as WriteFailed).file).toBe('renovate.json');
    expect((failure as WriteFailed).unrestored).toEqual([]);
    expect((failure as WriteFailed).message).toBe('it is a directory');
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toBe('save-exact=true\n');
    expect(existsSync(join(directory, 'bunfig.toml'))).toBe(false);
    expect(readdirSync(directory).sort()).toEqual(['.npmrc', 'package.json', 'renovate.json']);
  });

  it('removes its temporary files and the directories it created when a file cannot be staged', () => {
    const directory = scratch({ '.npmrc': 'a=1\n', blocker: 'a file where a directory is needed\n' });
    const changes = [
      { file: '.npmrc', before: 'a=1\n', after: 'a=2\n' },
      { file: 'new/dir/file.yml', before: null, after: 'a: 1\n' },
      { file: 'blocker/file.yml', before: null, after: 'a: 1\n' },
    ];
    expect(() => writeChanges(directory, changes)).toThrow(WriteFailed);
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toBe('a=1\n');
    expect(readdirSync(directory).sort()).toEqual(['.npmrc', 'blocker']);
  });
});

describe('Workspace reads UTF-8 only', () => {
  it('refuses a file that is not valid UTF-8 instead of replacing its bytes', () => {
    const directory = scratch({ '.npmrc': Buffer.from('# Konfiguracja \xe9\xe8\nsave-exact=true\n', 'latin1') });
    const workspace = new Workspace(directory);
    expect(() => workspace.read('.npmrc')).toThrow('.npmrc is not valid UTF-8, so depcurfew does not edit it; save it as UTF-8');
  });

  it('keeps a byte order mark', () => {
    const directory = scratch({ '.npmrc': '﻿a=1\n' });
    const workspace = new Workspace(directory);
    workspace.edit('.npmrc', (body) => `${body}b=2\n`);
    expect(workspace.changes()).toEqual([{ file: '.npmrc', before: '﻿a=1\n', after: '﻿a=1\nb=2\n' }]);
  });

  it('says in plain words why a file cannot be read', () => {
    const directory = scratch();
    mkdirSync(join(directory, '.npmrc'));
    expect(() => new Workspace(directory).read('.npmrc')).toThrow('.npmrc cannot be read: it is a directory');
  });
});

describe('mixed line endings', () => {
  it('keeps the line ending of every line apply does not change', () => {
    const original = 'save-exact=true\r\nfund=false\naudit=false\n';
    const body = `${toLf(original)}\nmin-release-age=3\n`;
    expect(restoreStyle(body, detectStyle(original), original)).toBe('save-exact=true\r\nfund=false\naudit=false\n\nmin-release-age=3\n');
  });

  it('gives a changed line the ending of the line it replaces', () => {
    const original = 'a=1\r\nb=2\nc=3\r\n';
    expect(restoreStyle('a=1\nb=5\nc=3\n', detectStyle(original), original)).toBe('a=1\r\nb=5\nc=3\r\n');
  });

  it('keeps a missing final newline', () => {
    const original = 'a=1\r\nb=2';
    expect(restoreStyle('a=1\nb=2\nc=3\n', detectStyle(original), original)).toBe('a=1\r\nb=2\r\nc=3');
    const mixed = 'a=1\r\nb=2\nc=3';
    expect(restoreStyle('a=1\nb=2\nc=3\nd=4\n', detectStyle(mixed), mixed)).toBe('a=1\r\nb=2\nc=3\nd=4');
  });

  it('writes the file unchanged when nothing changed', () => {
    const directory = scratch({ '.npmrc': 'a=1\r\nb=2\n' });
    const workspace = new Workspace(directory);
    workspace.edit('.npmrc', (body) => body);
    expect(workspace.changes()).toEqual([]);
  });
});
