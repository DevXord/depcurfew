import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../src/cli/run.ts';

const repo = (name: string) => fileURLToPath(new URL(`fixtures/repos/${name}`, import.meta.url));
const expected = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/expected/${name}/detect.json`, import.meta.url), 'utf8'));

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('depcurfew explain --json', () => {
  it('prints the detection of a repository without a policy', async () => {
    const result = await exec('explain', '--json', repo('pnpm10-monorepo'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, project: expected('pnpm10-monorepo'), policy: null, projects: [], notices: [], errors: [] });
  });

  describe('with a policy', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'depcurfew-explain-'));
      cpSync(repo('pnpm11-dependabot'), directory, { recursive: true });
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('converts the cooldown for every detected tool when targets is auto', async () => {
      writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '36h' } }));
      const result = await exec('explain', directory, '--json');
      expect(result.code).toBe(EXIT_OK);
      expect(JSON.parse(result.stdout).policy).toEqual({
        file: 'depcurfew.json',
        valid: true,
        targets: { mode: 'auto', tools: ['pnpm', 'dependabot'] },
        cooldown: {
          minimum: '36h',
          tools: [
            { tool: 'pnpm', ok: true, unit: 'minutes', value: 2160, exact: true },
            { tool: 'dependabot', ok: true, unit: 'days', value: 2, exact: false },
          ],
        },
      });
    });

    it('uses the listed targets and reports tools that cannot take the cooldown', async () => {
      writeFileSync(
        join(directory, 'depcurfew.json'),
        JSON.stringify({ version: 1, cooldown: { minimum: '1w' }, targets: ['npm', 'renovate'] }),
      );
      const result = await exec('explain', directory, '--json');
      expect(JSON.parse(result.stdout).policy).toEqual({
        file: 'depcurfew.json',
        valid: true,
        targets: { mode: 'listed', tools: ['npm', 'renovate'] },
        cooldown: {
          minimum: '1w',
          tools: [
            { tool: 'npm', ok: true, unit: 'days', value: 7, exact: true },
            { tool: 'renovate', ok: true, unit: 'duration-string', value: '7 days', exact: true },
          ],
        },
      });
    });

    it('reports a detected tool that cannot take the cooldown instead of shortening it', async () => {
      writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '13w' } }));
      const json = await exec('explain', directory, '--json');
      expect(json.code).toBe(EXIT_OK);
      expect(JSON.parse(json.stdout).policy.cooldown.tools).toEqual([
        { tool: 'pnpm', ok: true, unit: 'minutes', value: 131040, exact: true },
        { tool: 'dependabot', ok: false, reason: 'Dependabot accepts at most 90 days, but 13w needs 91 days' },
      ]);
      const text = await exec('explain', directory);
      expect(text.stdout).toContain('    Dependabot: cannot apply: Dependabot accepts at most 90 days, but 13w needs 91 days\n');
    });

    it('reports an invalid policy and exits with 1', async () => {
      writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3 days' } }));
      const result = await exec('explain', directory, '--json');
      expect(result.code).toBe(EXIT_FAILURE);
      expect(JSON.parse(result.stdout).policy).toEqual({
        file: 'depcurfew.json',
        valid: false,
        issues: ['cooldown.minimum: invalid duration "3 days": spaces are not allowed; write "3d"'],
      });
      // The same error as apply --json and check --json give, next to the policy section that explain had before.
      expect(JSON.parse(result.stdout).errors).toEqual([
        {
          code: 'policy-invalid',
          level: 'error',
          location: { file: 'depcurfew.json' },
          message: 'depcurfew.json is invalid',
          fix: 'Fix these problems in depcurfew.json; an editor that reads its $schema shows them as you type',
          issues: ['cooldown.minimum: invalid duration "3 days": spaces are not allowed; write "3d"'],
        },
      ]);
      const apply = await exec('apply', directory, '--json');
      expect(JSON.parse(apply.stdout).errors).toEqual(JSON.parse(result.stdout).errors);
    });

    it('prints a readable summary without --json', async () => {
      writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '36h' } }));
      const result = await exec('explain', directory);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toBe(
        [
          'Package managers:',
          '  pnpm',
          '    versions: 11.2.0 (package.json, packageManager)',
          '    evidence: pnpm-lock.yaml (lockfile), package.json (packageManager), pnpm-workspace.yaml (config)',
          '    config files: pnpm-workspace.yaml',
          'Node.js versions: none declared',
          'Bots:',
          '  Dependabot: .github/dependabot.yml',
          'Workspaces: none',
          '.npmrc files: none',
          'GitHub Actions workflows: none',
          'Dockerfiles: none',
          'Warnings: none',
          '',
          'Policy (depcurfew.json):',
          '  targets: pnpm, Dependabot (detected)',
          '  cooldown 36h:',
          '    pnpm: 2160 minutes',
          '    Dependabot: 2 days (rounded up)',
          '',
        ].join('\n'),
      );
    });
  });

  it('prints warnings in the readable summary', async () => {
    const result = await exec('explain', repo('conflicting-lockfiles'));
    expect(result.stdout).toContain(
      [
        'Warnings:',
        '  multiple-lockfiles: lockfiles of several package managers: package-lock.json, yarn.lock',
        '    fix: Remove the lockfiles of the package managers the project does not use',
        '  package-manager-mismatch: packageManager names pnpm, but no pnpm lockfile exists',
        '    fix: Commit the lockfile of the package manager that packageManager in package.json names, or correct packageManager',
        '  yarn-classic-unsupported: Yarn Classic (1.x) is not supported; depcurfew configures Yarn 2 and later',
        '    fix: Move to Yarn 2 or later, or to another package manager depcurfew configures',
      ].join('\n'),
    );
    const json = JSON.parse((await exec('explain', '--json', repo('conflicting-lockfiles'))).stdout) as { project: { warnings: unknown[] } };
    expect(json.project.warnings[0]).toEqual({
      code: 'multiple-lockfiles',
      level: 'warning',
      location: { file: 'package-lock.json' },
      message: 'lockfiles of several package managers: package-lock.json, yarn.lock',
      files: ['package-lock.json', 'yarn.lock'],
      fix: 'Remove the lockfiles of the package managers the project does not use',
    });
    expect(result.stdout).toContain('  Yarn Classic (not supported)\n');
    expect(result.stdout).toContain('Policy: no depcurfew.json\n');
  });

  it.skipIf(process.platform === 'win32')('says that an .npmrc which is a named pipe exists but was not read, and doctor fails closed on it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-explain-'));
    try {
      writeFileSync(join(directory, 'package.json'), '{"name": "app", "packageManager": "npm@11.21.1"}\n');
      execFileSync('mkfifo', [join(directory, '.npmrc')]);
      const text = await exec('explain', directory);
      expect(text.stdout).toContain('.npmrc files: .npmrc (not a regular file, not read)\n');
      expect(text.stdout).toContain('  not-a-regular-file: .npmrc exists but is not a regular file (a named pipe, socket or device), so depcurfew did not read it\n');
      const json = JSON.parse((await exec('explain', '--json', directory)).stdout) as { project: { npmrcFiles: string[]; warnings: { code: string; files: string[] }[] } };
      expect(json.project.npmrcFiles).toEqual([]);
      expect(json.project.warnings).toContainEqual(expect.objectContaining({ code: 'not-a-regular-file', files: ['.npmrc'] }));
      const doctor = await exec('doctor', '--json', directory);
      expect(doctor.code).toBe(EXIT_FAILURE);
      expect(JSON.parse(doctor.stdout).findings).toContainEqual(
        expect.objectContaining({ rule: 'unreadable-config', level: 'error', location: { file: '.npmrc' }, fix: 'Replace it with a regular file, or remove it; npm and pnpm read .npmrc as a file' }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses listed targets even when they are not detected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-explain-'));
    try {
      writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '1d' }, targets: ['dependabot'] }));
      writeFileSync(join(directory, 'package.json'), '{}');
      const json = await exec('explain', '--json', directory);
      expect(JSON.parse(json.stdout).policy.cooldown).toEqual({
        minimum: '1d',
        tools: [{ tool: 'dependabot', ok: true, unit: 'days', value: 1, exact: true }],
      });
      const text = await exec('explain', directory);
      expect(text.stdout).toContain('  targets: Dependabot (listed)\n  cooldown 1d:\n    Dependabot: 1 day\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('documents explain and --json in the help', async () => {
    const result = await exec('--help');
    expect(result.stdout).toMatch(/^ {2}explain {2,}Describe the repository and the policy values for each tool$/m);
    expect(result.stdout).toMatch(/^explain \[directory\]:\n {2}--json {2,}Print the result as JSON$/m);
  });

  it('fails when the directory does not exist', async () => {
    const result = await exec('explain', join(tmpdir(), 'depcurfew-missing-directory'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/^error: directory not found: .+ \(directory-not-found\)\n {2}fix: /u);
  });

  it('accepts at most one directory', async () => {
    const result = await exec('explain', repo('npm-basic'), repo('npm-basic'));
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("too many arguments for 'explain'");
  });
});
