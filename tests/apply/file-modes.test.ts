// apply creates a new file with the mode the umask gives, as any program does, and keeps the mode of a file it
// replaces (D-074); with umask 077 a new .npmrc is not writable by others, who could add script-shell= to it. It edits
// no file larger than 1 MiB, the limit for reading configuration.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { Workspace, writeChanges } from '../../src/apply/workspace.ts';
import { windows } from '../support/platform.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-modes-'));
  temporary.push(directory);
  return directory;
}

function withUmask<T>(mask: number, action: () => T): T {
  const previous = process.umask(mask);
  try {
    return action();
  } finally {
    process.umask(previous);
  }
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(windows)('modes of the files apply writes', () => {
  it.each([
    [0o077, 0o600],
    [0o022, 0o644],
    [0o002, 0o664],
  ])('creates new files with umask %o as %o', (mask, expected) => {
    const directory = scratch();
    withUmask(mask, () =>
      writeChanges(directory, [
        { file: '.npmrc', before: null, after: 'min-release-age=7\n' },
        { file: 'sub/bunfig.toml', before: null, after: '[install]\n' },
      ]),
    );
    expect(mode(join(directory, '.npmrc'))).toBe(expected);
    expect(mode(join(directory, 'sub/bunfig.toml'))).toBe(expected);
  });

  it('keeps the mode of a file it replaces, whatever the umask', () => {
    const directory = scratch();
    writeFileSync(join(directory, '.npmrc'), 'save-exact=true\n', { mode: 0o640 });
    writeFileSync(join(directory, 'renovate.json'), '{}\n', { mode: 0o644 });
    withUmask(0o077, () =>
      writeChanges(directory, [
        { file: '.npmrc', before: 'save-exact=true\n', after: 'save-exact=true\nmin-release-age=7\n' },
        { file: 'renovate.json', before: '{}\n', after: '{"minimumReleaseAge": "7 days"}\n' },
      ]),
    );
    expect(mode(join(directory, '.npmrc'))).toBe(0o640);
    expect(mode(join(directory, 'renovate.json'))).toBe(0o644);
  });

  it('applies a policy under umask 077 without a file others may write', () => {
    const directory = scratch();
    writeFileSync(join(directory, 'package.json'), '{ "name": "app", "packageManager": "npm@11.19.1" }\n');
    writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm"] }\n');
    const report = withUmask(0o077, () => applyProject(directory));
    expect(report.changes.map((change) => change.file)).toEqual(['.npmrc']);
    expect(mode(join(directory, '.npmrc'))).toBe(0o600);
  });
});

describe('files larger than 1 MiB', () => {
  it('are not edited, with a reason', () => {
    const directory = scratch();
    writeFileSync(join(directory, '.npmrc'), `# ${'x'.repeat(1024 * 1024)}\n`);
    expect(() => new Workspace(directory).read('.npmrc')).toThrow('.npmrc is larger than 1 MiB, so depcurfew does not edit it');
    writeFileSync(join(directory, 'package.json'), '{ "name": "app", "packageManager": "npm@11.19.1" }\n');
    writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm"] }\n');
    const report = applyProject(directory, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.failures).toEqual([{ tool: 'npm', file: '.npmrc', message: '.npmrc is larger than 1 MiB, so depcurfew does not edit it' }]);
  });
});
