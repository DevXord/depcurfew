// Decision D-184: npx, npm exec and npm x pick the version of a package they download with min-release-age alone
// (libnpmexec asks pacote for the manifest with `before`), and only npm install and the other commands of Arborist read
// min-release-age-exclude. apply says so with the warning exclude-ignored-by-exec when it writes the exceptions for
// npm, in a project and with --user.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { validatePolicy } from '../../src/policy/validate.ts';
import { planUserApply } from '../../src/user/apply.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d184-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  return root;
}

const npmProject = (npm: string, exclude: readonly string[]) => ({
  'package.json': JSON.stringify({ name: 'app', version: '1.0.0', packageManager: `npm@${npm}` }),
  'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '7d', exclude } }),
});

const warnings = (root: string) => applyProject(root, { write: false }).warningDetails.filter((entry) => entry.code === 'exclude-ignored-by-exec');

describe('apply and min-release-age-exclude under npx (decision D-184)', () => {
  it('warns once that npx, npm exec and npm x do not read the exceptions it writes', () => {
    const found = warnings(repo(npmProject('11.21.1', ['depcurfew', '@acme/*'])));
    expect(found).toEqual([
      {
        code: 'exclude-ignored-by-exec',
        message:
          'npm: npx, npm exec and npm x pick the version of a package they download with the release-age delay alone and do not read min-release-age-exclude, so they still hold new versions of depcurfew and @acme/* back for cooldown.minimum',
        fix: 'Install such a package with npm install, which reads min-release-age-exclude, and run it from node_modules/.bin: npx runs it from there without downloading it',
        tool: 'npm',
      },
    ]);
  });

  it('names at most three patterns', () => {
    const [found] = warnings(repo(npmProject('11.21.1', ['a', 'b', 'c', 'd', 'e'])));
    expect(found?.message).toContain('so they still hold new versions of a, b, c and 2 more back for cooldown.minimum');
  });

  it('says nothing without exceptions, without npm, or for an npm that has no exception list', () => {
    expect(warnings(repo(npmProject('11.21.1', [])))).toEqual([]);
    expect(warnings(repo(npmProject('11.16.0', ['depcurfew'])))).toEqual([]);
    const pnpm = repo({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@10.30.0' }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '7d', exclude: ['depcurfew'] }, targets: ['pnpm'] }),
    });
    expect(warnings(pnpm)).toEqual([]);
  });

  it('warns with apply --user too, where ~/.npmrc gets the exceptions', () => {
    const result = validatePolicy({ version: 1, cooldown: { minimum: '7d', exclude: ['depcurfew'] }, targets: ['npm'] });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-d184-user-'));
    temporary.push(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const planned = planUserApply(result.policy, { environment: { platform, home, env: { PATH: join(root, 'bin') } }, versions: { npm: [11, 21, 1] } });
    expect(planned.report.warningDetails.filter((entry) => entry.code === 'exclude-ignored-by-exec').map((entry) => entry.tool)).toEqual(['npm']);
  });
});
