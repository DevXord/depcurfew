// apply after the review of init and apply before 1.0.0 (decision D-075): pnpm before 10 cannot deny install
// scripts, Renovate's security exceptions stay in pnpm-workspace.yaml, files ignored by git are reported, project
// manifests are never created and tools seen only in CI are not configured.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { ignoredByGit, parseIgnoreFile, trackedFiles } from '../../src/apply/gitignore.ts';
import { Repository } from '../../src/detect/repository.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { buildReport } from '../../src/cli/explain.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-review-apply-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const codes = (root: string) => applyProject(root, { write: false }).warningDetails.map((warning) => warning.code);

describe('pnpm before 10 and installScripts "deny"', () => {
  const policy = '{"version": 1, "installScripts": {"default": "deny"}, "targets": ["pnpm"]}\n';

  it('writes an empty pnpm.onlyBuiltDependencies to package.json for pnpm 6.32.1 to 9, which blocks every install script', () => {
    const root = repo({ 'package.json': '{"name": "app", "packageManager": "pnpm@9.15.0"}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'depcurfew.json': policy });
    const report = applyProject(root);
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('scripts-not-enforceable');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({ name: 'app', packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependencies: [] } });
    expect(applyProject(root).changes).toEqual([]);
  });

  it('adds the allowed packages to the list there', () => {
    const allow = '{"version": 1, "installScripts": {"default": "deny", "allow": ["esbuild"]}, "targets": ["pnpm"]}\n';
    const root = repo({ 'package.json': '{"name": "app", "packageManager": "pnpm@8.15.9", "pnpm": {"onlyBuiltDependencies": ["sharp"]}}\n', 'depcurfew.json': allow });
    applyProject(root);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).pnpm).toEqual({ onlyBuiltDependencies: ['sharp', 'esbuild'] });
  });

  it('warns that pnpm before 6.32.1 runs every install script', () => {
    const root = repo({ 'package.json': '{"name": "app", "packageManager": "pnpm@6.30.0"}\n', 'depcurfew.json': policy });
    expect(applyProject(root, { write: false }).warningDetails).toEqual([
      {
        code: 'scripts-not-enforceable',
        tool: 'pnpm',
        message: 'pnpm 6.30.0 runs every dependency install script and has no allow-list, so "deny" cannot be enforced',
        fix: 'Require pnpm 6.32.1 or later, which reads pnpm.onlyBuiltDependencies in package.json, or 10.0.0, which blocks dependency install scripts by default',
      },
    ]);
  });

  it('says nothing for pnpm 10', () => {
    const root = repo({ 'package.json': '{"name": "app", "packageManager": "pnpm@10.34.9"}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'depcurfew.json': policy });
    expect(codes(root)).not.toContain('scripts-not-enforceable');
  });
});

describe("Renovate's security exceptions in pnpm-workspace.yaml", () => {
  const files = {
    'package.json': '{"name": "app", "packageManager": "pnpm@10.34.9"}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'renovate.json': '{\n  "extends": ["config:recommended"]\n}\n',
  };
  const workspace = [
    '# managed by depcurfew',
    'minimumReleaseAge: 4320',
    'minimumReleaseAgeExclude:',
    '  - webpack',
    '  # Renovate security update: undici@7.24.0',
    '  - undici@7.24.0',
    '  # Renovate security update: @next/env@16.0.10',
    "  - '@next/env@16.0.7 || 16.0.9 || 16.0.10'",
    '',
  ].join('\n');

  it('keeps them with their comments when the policy changes the list', () => {
    const root = repo({ ...files, 'pnpm-workspace.yaml': workspace, 'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d", "exclude": ["left-pad"]}}\n' });
    applyProject(root);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      [
        '# managed by depcurfew',
        'minimumReleaseAge: 4320',
        '# managed by depcurfew',
        'minimumReleaseAgeExclude:',
        '  - left-pad',
        '  # Renovate security update: undici@7.24.0',
        '  - undici@7.24.0',
        '  # Renovate security update: @next/env@16.0.10',
        "  - '@next/env@16.0.7 || 16.0.9 || 16.0.10'",
        '',
      ].join('\n'),
    );
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it('leaves the list alone when it holds the policy and the exceptions in another order', () => {
    const text = [
      'minimumReleaseAge: 4320',
      'minimumReleaseAgeExclude:',
      '  # Renovate security update: undici@7.24.0',
      '  - undici@7.24.0',
      '  - webpack',
      '',
    ].join('\n');
    const root = repo({ ...files, 'pnpm-workspace.yaml': text, 'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d", "exclude": ["webpack"]}}\n' });
    expect(applyProject(root, { write: false }).changes.map((change) => change.file)).not.toContain('pnpm-workspace.yaml');
    // A policy without exceptions keeps Renovate's and drops the rest.
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    applyProject(root);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      ['minimumReleaseAge: 4320', '# managed by depcurfew', 'minimumReleaseAgeExclude:', '  # Renovate security update: undici@7.24.0', '  - undici@7.24.0', ''].join('\n'),
    );
  });

  it('recognizes only the format Renovate writes', () => {
    const text = [
      'minimumReleaseAge: 4320',
      'minimumReleaseAgeExclude:',
      // Another package than the comment names, a range, and an entry without a comment are not Renovate's.
      '  # Renovate security update: undici@7.24.0',
      '  - left-pad@1.3.0',
      '  # Renovate security update: lodash@4.17.21',
      "  - 'lodash@>=4.17.21'",
      '  - axios@0.21.1',
      '',
    ].join('\n');
    const root = repo({ ...files, 'pnpm-workspace.yaml': text, 'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n' });
    applyProject(root);
    // The entries are replaced; the comment before the first entry stays, as every comment before a replaced list (D-074).
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      'minimumReleaseAge: 4320\n# managed by depcurfew\nminimumReleaseAgeExclude: []\n  # Renovate security update: undici@7.24.0\n',
    );
  });
});

describe('files ignored by git', () => {
  const poetry = {
    'pyproject.toml': '[project]\nname = "app"\nversion = "1.0.0"\n\n[tool.poetry]\npackage-mode = false\n',
    'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n',
  };

  it('warns with the rule, its line and what to do', () => {
    const root = repo({ ...poetry, '.gitignore': '# local settings\n/poetry.toml\n' });
    const warning = applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === 'file-ignored-by-git');
    expect(warning).toEqual({
      code: 'file-ignored-by-git',
      location: { file: '.gitignore', line: 2 },
      message:
        'poetry.toml matches the rule /poetry.toml in .gitignore (line 2), so git ignores it: what depcurfew apply writes there stays on this machine, and a fresh clone (CI included) does not get it',
      fix: 'Remove /poetry.toml from .gitignore, or add the file with git add -f poetry.toml, then commit it',
    });
  });

  it('follows negations, nested .gitignore files and .git/info/exclude', () => {
    const negated = repo({ ...poetry, '.gitignore': '*.toml\n!poetry.toml\n' });
    expect(codes(negated)).not.toContain('file-ignored-by-git');
    const excluded = repo({ ...poetry, '.git/info/exclude': 'poetry.toml\n' });
    expect(applyProject(excluded, { write: false }).warningDetails.find((entry) => entry.code === 'file-ignored-by-git')?.location).toEqual({ file: '.git/info/exclude', line: 1 });
    // A pattern the matcher does not read that might re-include the file: no warning rather than a wrong one.
    const unknown = repo({ ...poetry, '.gitignore': '*.toml\n![p]oetry.toml\n' });
    expect(codes(unknown)).not.toContain('file-ignored-by-git');
  });

  it('matches the usual gitignore patterns', () => {
    const root = repo({
      '.gitignore': '/build/\n*.log\n!keep.log\ndocs/**/draft.md\n\\#hash\n**/cache\n',
      'sub/.gitignore': 'local.toml\n',
    });
    const repository = new Repository(root);
    const ignored = (path: string) => ignoredByGit(repository, path).ignored;
    expect(ignored('build/x.toml')).toBe(true);
    expect(ignored('src/build/x.toml')).toBe(false);
    expect(ignored('a/b/c.log')).toBe(true);
    expect(ignored('keep.log')).toBe(false);
    expect(ignored('docs/draft.md')).toBe(true);
    expect(ignored('docs/a/b/draft.md')).toBe(true);
    expect(ignored('#hash')).toBe(true);
    expect(ignored('x/cache/y.json')).toBe(true);
    expect(ignored('sub/local.toml')).toBe(true);
    expect(ignored('local.toml')).toBe(false);
    expect(parseIgnoreFile('trailing   \n', '.gitignore', '')[0]?.pattern).toBe('trailing');
    // abc/** matches what is inside abc, not abc itself, so a file in it can be re-included.
    const inside = new Repository(repo({ '.gitignore': 'abc/**\n!abc/keep.toml\n' }));
    expect(ignoredByGit(inside, 'abc/x.toml').ignored).toBe(true);
    expect(ignoredByGit(inside, 'abc/keep.toml').ignored).toBe(false);
  });

  it('matches hostile patterns in linear time', () => {
    const root = repo({ '.gitignore': `${'*a'.repeat(5000)}b\n${'**/'.repeat(2000)}x\n` });
    const started = Date.now();
    expect(ignoredByGit(new Repository(root), `${'a'.repeat(200)}/${'a'.repeat(200)}.toml`).ignored).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('leaves out files git already tracks, read from the index', () => {
    // A version 2 index with the single entry poetry.toml (SHA-1), as git writes it.
    const name = Buffer.from('poetry.toml');
    const entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    entry.writeUInt32BE(0o100644, 24);
    entry.writeUInt16BE(name.length, 60);
    name.copy(entry, 62);
    const index = Buffer.concat([Buffer.from('DIRC'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), entry, Buffer.alloc(20)]);
    const root = repo({ ...poetry, '.gitignore': '/poetry.toml\n', 'poetry.toml': '[virtualenvs]\nin-project = true\n', '.git/index': index });
    expect([...(trackedFiles(new Repository(root)) ?? [])]).toEqual(['poetry.toml']);
    expect(codes(root)).not.toContain('file-ignored-by-git');
    // Without an index, a file that already exists may be tracked, and the message says so.
    const untracked = repo({ ...poetry, '.gitignore': '/poetry.toml\n', 'poetry.toml': '[virtualenvs]\nin-project = true\n' });
    expect(applyProject(untracked, { write: false }).warningDetails.find((entry) => entry.code === 'file-ignored-by-git')?.message).toContain('so git ignores it unless git already tracks it:');
  });
});

describe('project manifests and tools seen only in CI', () => {
  const workflow = [
    'name: ci',
    'on: push',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: denoland/setup-deno@v2',
    '      - uses: oven-sh/setup-bun@v2',
    '      - run: deno task test',
    '',
  ].join('\n');

  it('does not configure Bun set up only in CI of a Deno repository, and says so', () => {
    const root = repo({
      'deno.json': '{\n  "name": "@std/root",\n  "workspace": []\n}\n',
      '.github/workflows/ci.yml': workflow,
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}, "installScripts": {"default": "deny"}}\n',
    });
    const report = applyProject(root, { write: false });
    expect(report.changes.map((change) => change.file)).toEqual(['deno.json']);
    expect(report.warningDetails.find((warning) => warning.code === 'tool-only-in-ci')).toEqual({
      code: 'tool-only-in-ci',
      tool: 'bun',
      location: { file: '.github/workflows/ci.yml' },
      message:
        'Bun appears only in a CI setup step (.github/workflows/ci.yml); the repository has no package.json, lockfile or Bun configuration, so nothing is written for it',
      fix: 'If Bun installs packages for this project, add "bun" to targets in depcurfew.json and run depcurfew apply again',
    });
    expect(buildReport(root).policy).toMatchObject({ targets: { mode: 'auto', tools: ['deno'] } });
  });

  it('never creates package.json, deno.json, pyproject.toml or Pipfile, and names what is not written', () => {
    const root = repo({ 'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}, "installScripts": {"default": "deny"}, "targets": ["bun", "deno", "pdm", "pipenv"]}\n' });
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(report.changes.map((change) => change.file)).toEqual(['bunfig.toml']);
    for (const file of ['package.json', 'deno.json', 'pyproject.toml', 'Pipfile']) expect(existsSync(join(root, file)), file).toBe(false);
    const missing = report.warningDetails.filter((warning) => warning.code === 'manifest-missing');
    expect(missing).toEqual([
      {
        code: 'manifest-missing',
        tool: 'bun',
        location: { file: 'package.json' },
        message: 'Bun: there is no package.json, so trustedDependencies is not written; depcurfew does not create project manifests',
        fix: 'If Bun installs packages for this project, create package.json first, then run depcurfew apply again; otherwise remove "bun" from targets in depcurfew.json',
      },
      {
        code: 'manifest-missing',
        tool: 'deno',
        location: { file: 'deno.json' },
        message: 'Deno: there is no deno.json, so minimumDependencyAge is not written; depcurfew does not create project manifests',
        fix: 'If Deno installs packages for this project, create deno.json first, then run depcurfew apply again; otherwise remove "deno" from targets in depcurfew.json',
      },
      {
        code: 'manifest-missing',
        tool: 'pdm',
        location: { file: 'pyproject.toml' },
        message: 'PDM: there is no pyproject.toml, so exclude-newer and only-binary in [tool.pdm.resolution] are not written; depcurfew does not create project manifests',
        fix: 'If PDM installs packages for this project, create pyproject.toml first, then run depcurfew apply again; otherwise remove "pdm" from targets in depcurfew.json',
      },
      {
        code: 'manifest-missing',
        tool: 'pipenv',
        location: { file: 'Pipfile' },
        message: 'Pipenv: there is no Pipfile, so cool-down-period in [pipenv] is not written; depcurfew does not create project manifests',
        fix: 'If Pipenv installs packages for this project, create Pipfile first, then run depcurfew apply again; otherwise remove "pipenv" from targets in depcurfew.json',
      },
    ]);
    // Bun's built-in list is not replaced when nothing is written.
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('built-in-list-replaced');
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });
});
