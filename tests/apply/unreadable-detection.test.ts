// apply says when detection could not read a file that shows which tools the project uses (too large, a symlink out
// of the repository, no read permission), not only when it could not parse one: otherwise apply configures nothing,
// says "no supported package manager" and exits with 0 while doctor reports the file as an error.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-unreadable-detection-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
  return directory;
}

describe('apply and files detection cannot read', () => {
  it('warns about a package.json over the size limit', () => {
    const directory = project();
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'npm@11.19.1', description: 'x'.repeat(1024 * 1024) }));
    const warnings = applyProject(directory, { write: false }).warningDetails;
    expect(warnings).toContainEqual({
      code: 'file-unreadable',
      location: { file: 'package.json' },
      message: 'package.json is larger than 1 MiB and was not read; depcurfew cannot tell which tools it configures',
      fix: 'Make the file smaller than the limit, or check its settings by hand, then run depcurfew apply again',
    });
  });

  it('warns about a manifest that is a symlink out of the repository', () => {
    const directory = project();
    const outside = mkdtempSync(join(tmpdir(), 'depcurfew-unreadable-outside-'));
    temporary.push(outside);
    writeFileSync(join(outside, 'package.json'), '{ "name": "x", "packageManager": "npm@11.19.1" }');
    symlinkSync(join(outside, 'package.json'), join(directory, 'package.json'));
    expect(applyProject(directory, { write: false }).warningDetails).toContainEqual({
      code: 'file-unreadable',
      location: { file: 'package.json' },
      message: 'package.json points outside the repository and was not read; depcurfew cannot tell which tools it configures',
      fix: 'Replace the symlink with a regular file inside the repository, then run depcurfew apply again',
    });
  });

  it('keeps the advice for a file that does not parse', () => {
    const directory = project();
    writeFileSync(join(directory, 'package.json'), '{ "name": ');
    const warning = applyProject(directory, { write: false }).warningDetails.find((entry) => entry.code === 'file-unreadable');
    expect(warning?.fix).toBe('Fix the syntax error in package.json, then run depcurfew apply again');
  });
});
