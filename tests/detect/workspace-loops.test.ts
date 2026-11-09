// Workspace patterns and symlinks that lead back up (decision D-161). Detection keyed each directory of the walk by the
// path that reached it, so `"workspaces": ["**"]` with two symlinks to the root (s0 -> ., s1 -> .) walked s0, s1,
// s0/s0, s0/s1 … until the path was too long: doctor and explain did not finish in 30 s. Each directory is now walked
// once per pattern segment by its real path, a directory whose real path is the root is never a workspace package, and
// one workspace declaration lists at most MAX_WORKSPACE_DIRECTORIES directories, with a notice when it stops there.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpuNow } from '../support/cpu-time.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { detectProject } from '../../src/detect/index.ts';
import { Repository } from '../../src/detect/repository.ts';
import { expandWorkspaces, MAX_WORKSPACE_DIRECTORIES } from '../../src/detect/workspaces.ts';
import { DETECTION_NOTICES, WARNING_FIXES } from '../../src/doctor/unreadable-warnings.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { canSymlink } from '../support/platform.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A new repository with a package.json of these workspaces and a package.json in each of `packages`. */
function repository(workspaces: readonly string[], packages: readonly string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depcurfew-workspace-loops-')));
  temporary.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces }));
  for (const directory of packages) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name: directory.replaceAll('/', '-'), version: '1.0.0' }));
  }
  return root;
}

const never: FetchLike = async (url) => {
  throw new Error(`asked ${url}`);
};

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; seconds: number }> {
  let stdout = '';
  const start = cpuNow();
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch: never, now: () => new Date('2026-11-02T18:00:00Z'), stdin: async () => '', osvData: () => undefined });
  return { code, stdout, seconds: (cpuNow() - start) / 1000 };
}

describe.skipIf(!canSymlink())('workspace patterns over symlinks that loop (decision D-161)', () => {
  it('** with two symlinks to the root: doctor --json and explain --json finish in well under 2 s', { timeout: 60_000 }, async () => {
    const root = repository(['**'], ['packages/a', 'packages/b/nested']);
    symlinkSync('.', join(root, 's0'), 'junction');
    symlinkSync('.', join(root, 's1'), 'junction');
    const explain = await cli('explain', '--json', root);
    expect(explain.seconds).toBeLessThan(2);
    expect((JSON.parse(explain.stdout) as { project: { workspaces: { packages: string[] } } }).project.workspaces.packages).toEqual(['packages/a', 'packages/b/nested']);
    const doctor = await cli('doctor', '--json', root);
    expect(doctor.seconds).toBeLessThan(2);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ schemaVersion: 1, policySource: 'default' });
  });

  it('**/* and several ** in one pattern, with loops deeper down, list each package once', () => {
    const root = repository(['**/*', 'packages/**/**', '**/x/**'], ['packages/a', 'packages/a/x/b']);
    symlinkSync('../..', join(root, 'packages', 'a', 'up'), 'junction');
    symlinkSync('..', join(root, 'packages', 'a', 'x', 'back'), 'junction');
    symlinkSync('.', join(root, 'self'), 'junction');
    const start = cpuNow();
    const detection = detectProject(root);
    expect((cpuNow() - start) / 1000).toBeLessThan(2);
    // up and self are the root, which is not a workspace package of itself; back is packages/a, listed once as packages/a.
    expect(detection.workspaces?.packages).toEqual(['packages/a', 'packages/a/x/b']);
    expect(detection.warnings.filter((warning) => warning.code === 'workspace-search-limit')).toEqual([]);
  });

  it('still finds a package reached only through a symlink inside the repository', () => {
    const root = repository(['packages/*'], ['libs/real']);
    mkdirSync(join(root, 'packages'));
    symlinkSync('../libs/real', join(root, 'packages', 'linked'), 'junction');
    expect(detectProject(root).workspaces?.packages).toEqual(['packages/linked']);
  });
});

describe('the number of directories one workspace declaration lists (decision D-161)', () => {
  it('is bounded, and the bound is named', () => {
    expect(MAX_WORKSPACE_DIRECTORIES).toBe(20_000);
  });

  it('stops at the bound with a warning that says where and what to do', () => {
    const root = repository(['**', 'more/*'], ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'more/p']);
    const repo = new Repository(root);
    const found = expandWorkspaces(repo, ['**', 'more/*'], ['package.json'], 'package.json', 4);
    // The walk is in name order: ., d1, d2, d3 are listed, then it stops; more/* is not walked either.
    expect(found).toEqual(['d1', 'd2', 'd3']);
    expect(repo.warnings).toEqual([
      {
        code: 'workspace-search-limit',
        message: 'the workspace patterns in package.json match more than 4 directories; depcurfew looked for workspace packages in the first 4 and not in the others',
        files: ['package.json'],
      },
    ]);
  });

  it('is a notice of doctor and has a fix in explain', () => {
    expect(DETECTION_NOTICES.has('workspace-search-limit')).toBe(true);
    expect(WARNING_FIXES['workspace-search-limit']).toBe(
      `Narrow the workspace patterns (for example packages/* instead of **), so that they match at most ${MAX_WORKSPACE_DIRECTORIES} directories and depcurfew finds every workspace package`,
    );
  });

  it('reaching it in a repository is a note of doctor, not an error', { timeout: 120_000 }, () => {
    const root = repository(['**'], []);
    for (let index = 0; index < MAX_WORKSPACE_DIRECTORIES; index++) mkdirSync(join(root, `d${index}`));
    const report = runDoctor(root);
    expect(report.notices.filter((notice) => notice.code === 'workspace-search-limit')).toEqual([
      expect.objectContaining({ level: 'note', file: 'package.json', message: expect.stringContaining(`match more than ${MAX_WORKSPACE_DIRECTORIES} directories`) }),
    ]);
    expect(report.findings.filter((finding) => finding.level === 'error')).toEqual([]);
  });
});
