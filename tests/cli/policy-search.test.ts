// Where apply, doctor and explain work when no directory is given: the nearest directory with depcurfew.json, from
// the current one up to the root of the repository. A directory given on the command line is taken as it is.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectDirectory } from '../../src/cli/directory.ts';
import { run } from '../../src/cli/run.ts';
import { findPolicyDirectory } from '../../src/policy/file.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** outer/depcurfew.json, outer/repo/{.git, depcurfew.json?}, outer/repo/src/deep. */
function layout(options: { repoPolicy: boolean; git: 'directory' | 'file' }): { outer: string; repo: string; deep: string } {
  const outer = mkdtempSync(join(tmpdir(), 'depcurfew-search-'));
  temporary.push(outer);
  const repo = join(outer, 'repo');
  const deep = join(repo, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(outer, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "9d" } }\n');
  if (options.git === 'directory') mkdirSync(join(repo, '.git'));
  else writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/repo\n');
  if (options.repoPolicy) writeFileSync(join(repo, 'depcurfew.json'), '{ "version": 1 }\n');
  return { outer, repo, deep };
}

describe('findPolicyDirectory', () => {
  it('finds depcurfew.json in a parent directory of the repository', () => {
    const { repo, deep } = layout({ repoPolicy: true, git: 'directory' });
    expect(findPolicyDirectory(deep)).toBe(repo);
    expect(findPolicyDirectory(repo)).toBe(repo);
  });

  it.each([['directory' as const], ['file' as const]])('stops at the root of the repository (.git as a %s)', (git) => {
    const { deep } = layout({ repoPolicy: false, git });
    expect(findPolicyDirectory(deep)).toBeUndefined();
  });
});

describe('projectDirectory', () => {
  it('without a directory, works on the nearest parent with depcurfew.json and says so', () => {
    const { repo, deep } = layout({ repoPolicy: true, git: 'directory' });
    expect(projectDirectory(undefined, 'doctor', deep)).toEqual({
      ok: true,
      directory: repo,
      notice: 'using ../../depcurfew.json from a parent directory, so depcurfew doctor works on ../..; paths are relative to it',
    });
    expect(projectDirectory(undefined, 'doctor', repo)).toEqual({ ok: true, directory: repo });
  });

  it('without depcurfew.json up to the root of the repository, works on the current directory', () => {
    const { deep } = layout({ repoPolicy: false, git: 'directory' });
    expect(projectDirectory(undefined, 'apply', deep)).toEqual({ ok: true, directory: deep });
  });

  it('takes a directory given on the command line as it is', () => {
    const { repo, deep } = layout({ repoPolicy: true, git: 'directory' });
    expect(projectDirectory('src/deep', 'doctor', repo)).toEqual({ ok: true, directory: deep });
  });
});

describe('check', () => {
  it('does not use a depcurfew.json above the root of the repository', async () => {
    const { deep } = layout({ repoPolicy: false, git: 'directory' });
    let stdout = '';
    await run(['check', '--json', '--dir', deep, 'pypi:x'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
      fetch: async () => new Response('Not Found', { status: 404 }),
      now: () => new Date('2026-10-30T12:00:00Z'),
      stdin: async () => '',
      home: () => deep,
    });
    expect(JSON.parse(stdout)).toMatchObject({ policy: null, notices: [{ message: expect.stringContaining('no depcurfew.json found') }] });
  });

  it('uses the depcurfew.json of the repository from a subdirectory', async () => {
    const { repo, deep } = layout({ repoPolicy: true, git: 'directory' });
    let stdout = '';
    await run(['check', '--json', '--dir', deep, 'pypi:x'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
      fetch: async () => new Response('Not Found', { status: 404 }),
      now: () => new Date('2026-10-30T12:00:00Z'),
      stdin: async () => '',
      home: () => deep,
    });
    expect(JSON.parse(stdout)).toMatchObject({ policy: join(repo, 'depcurfew.json'), notices: [] });
  });
});
