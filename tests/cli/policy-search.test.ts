// Where apply, doctor and explain work when no directory is given: the nearest directory with depcurfew.json, from
// the current one up to the root of the repository. A directory given on the command line is taken as it is.
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectDirectory } from '../../src/cli/directory.ts';
import { run } from '../../src/cli/run.ts';
import { findPolicyDirectory } from '../../src/policy/file.ts';
import { windows } from '../support/platform.ts';

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

describe('findPolicyDirectory outside a git repository', () => {
  it('uses depcurfew.json of the directory itself, but not of a parent: in a shared directory such as /tmp anyone may put one there', () => {
    const outer = mkdtempSync(join(tmpdir(), 'depcurfew-search-'));
    temporary.push(outer);
    const deep = join(outer, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(outer, 'depcurfew.json'), '{ "version": 1 }\n');
    expect(findPolicyDirectory(outer)).toBe(outer);
    expect(findPolicyDirectory(deep)).toBeUndefined();
    expect(projectDirectory(undefined, 'apply', deep)).toEqual({ ok: true, directory: deep });
  });
});

describe('findPolicyDirectory and planted files (from the security review before 1.0.0)', () => {
  /** shared/{.git, depcurfew.json} planted by someone else, and the user's project shared/victim/project. */
  function planted(): { shared: string; project: string } {
    const shared = mkdtempSync(join(tmpdir(), 'depcurfew-shared-'));
    temporary.push(shared);
    const project = join(shared, 'victim', 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(shared, '.git'), '');
    writeFileSync(join(shared, 'depcurfew.json'), '{ "version": 1, "sources": { "git": "allow" } }\n');
    return { shared, project };
  }

  it.skipIf(windows)('does not take depcurfew.json from a parent directory others may write to, such as /tmp', () => {
    const { shared, project } = planted();
    chmodSync(shared, 0o777);
    expect(findPolicyDirectory(project)).toBeUndefined();
    expect(projectDirectory(undefined, 'apply', project)).toEqual({ ok: true, directory: project });
    chmodSync(shared, 0o755);
    expect(findPolicyDirectory(project)).toBe(shared);
  });

  it.skipIf(windows || process.getuid?.() !== 0)('does not take depcurfew.json from a parent directory of another user', () => {
    const { shared, project } = planted();
    chownSync(shared, 65534, 65534);
    expect(findPolicyDirectory(project)).toBeUndefined();
  });

  it('still takes depcurfew.json from the directory itself, whoever may write its parent', () => {
    const { shared, project } = planted();
    if (!windows) chmodSync(shared, 0o777);
    writeFileSync(join(project, 'depcurfew.json'), '{ "version": 1 }\n');
    expect(findPolicyDirectory(project)).toBe(project);
  });

  it('skips directories in node_modules: a dependency does not bring its own policy', () => {
    const { repo } = layout({ repoPolicy: true, git: 'directory' });
    const dependency = join(repo, 'node_modules', 'dep');
    mkdirSync(join(dependency, 'lib'), { recursive: true });
    mkdirSync(join(dependency, '.git'));
    writeFileSync(join(dependency, 'depcurfew.json'), '{ "version": 1, "sources": { "git": "allow" } }\n');
    expect(findPolicyDirectory(join(dependency, 'lib'))).toBe(repo);
    expect(findPolicyDirectory(dependency)).toBe(repo);
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
