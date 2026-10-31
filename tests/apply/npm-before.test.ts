// apply and before= in .npmrc: from npm 11.15.0 before takes the place of the min-release-age apply writes, and npm
// 11.10 to 11.14 stop with an error when both are set. before is the user's setting, so it stays, with a warning.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(npm: string, npmrc: string): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-npm-before-'));
  temporary.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', packageManager: `npm@${npm}` }));
  writeFileSync(join(root, '.npmrc'), npmrc);
  writeFileSync(join(root, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" } }\n');
  return root;
}

const warning = (root: string) => applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === 'before-overrides-cooldown');

describe('apply with before= in .npmrc', () => {
  it('warns that npm 11.15 and later use before instead of the delay, and keeps the line', () => {
    const root = repo('11.19.1', 'save-exact=true\nbefore=2099-12-31\n');
    expect(warning(root)).toEqual({
      code: 'before-overrides-cooldown',
      location: { file: '.npmrc', line: 2 },
      message: 'before=2099-12-31 in .npmrc (line 2) takes the place of min-release-age (npm 11.19.1 uses before when both are set in the same file), so the release-age delay depcurfew apply writes has no effect',
      fix: 'Remove the before line from .npmrc, so that min-release-age applies',
      tool: 'npm',
    });
    applyProject(root);
    expect(readFileSync(join(root, '.npmrc'), 'utf8')).toContain('\nbefore=2099-12-31\n');
  });

  it('warns that npm 11.10 to 11.14 stop with an error next to it', () => {
    expect(warning(repo('11.12.0', 'before=2024-01-01\n'))?.message).toBe(
      'npm 11.12.0 stops with an error when before and min-release-age are both set, and .npmrc sets before=2024-01-01 (line 1), so every npm command fails once depcurfew apply writes min-release-age',
    );
  });

  it('says nothing without before, or for npm without min-release-age', () => {
    expect(warning(repo('11.19.1', 'save-exact=true\n'))).toBeUndefined();
    expect(warning(repo('10.9.4', 'before=2024-01-01\n'))).toBeUndefined();
  });
});
