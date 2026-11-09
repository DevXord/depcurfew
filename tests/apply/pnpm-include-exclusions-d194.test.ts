// Decision D-194: the cooldown exceptions of pnpm 12.15+ are read from the file that `include` in pnpm-workspace.yaml
// gives minimumReleaseAgeExclude to, the file apply writes them to. apply commented out the list there without the
// warning exclusion-dropped, and init did not carry it into cooldown.exclude (pnpm/pnpm has 33 exceptions in
// .config/pnpm; found by the review of 1.6.0, already in 1.5.2).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { run } from '../../src/cli/run.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICIES = '.config/pnpm/policies.yaml';
const FILES = {
  'package.json': JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@12.18.0' }),
  'pnpm-workspace.yaml': `include:\n  ./${POLICIES}: "*"\n`,
  [POLICIES]: 'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - "@pnpm/*"\n  - typescript\n',
};

function repository(policy?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d194-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  if (policy !== undefined) writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, targets: ['pnpm'], ...policy }));
  return root;
}

async function init(root: string): Promise<number> {
  const dependencies: CheckDependencies = { fetch: () => Promise.reject(new Error('no network in tests')), now: () => new Date('2026-11-09T12:00:00Z'), stdin: async () => '' };
  return run(['init', root], { stdout: () => {}, stderr: () => {} }, dependencies);
}

describe('pnpm exceptions in a file of include (decision D-194)', () => {
  it('apply warns with exclusion-dropped when it comments them out', () => {
    const report = applyProject(repository({ cooldown: { minimum: '3d' } }), { write: false });
    expect(report.warningDetails.filter((warning) => warning.code === 'exclusion-dropped').map((warning) => [warning.location, warning.message])).toEqual([
      [
        { file: POLICIES, line: 2 },
        `pnpm: minimumReleaseAgeExclude in ${POLICIES} (line 2) exempts @pnpm/* and typescript from the release-age delay, but cooldown.exclude in depcurfew.json does not; depcurfew apply comments them out, so pnpm delays them like every other package`,
      ],
    ]);
  });

  it('init carries them into cooldown.exclude, and apply then keeps them where they are', async () => {
    const root = repository();
    expect(await init(root)).toBe(0);
    const policy = JSON.parse(readFileSync(join(root, 'depcurfew.json'), 'utf8')) as { cooldown: { exclude: string[] } };
    expect(policy.cooldown.exclude).toEqual(['@pnpm/*', 'typescript']);
    const report = applyProject(root);
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('exclusion-dropped');
    expect(readFileSync(join(root, POLICIES), 'utf8')).toMatch(/minimumReleaseAgeExclude:\n {2}- "@pnpm\/\*"\n {2}- typescript\n/u);
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });
});
