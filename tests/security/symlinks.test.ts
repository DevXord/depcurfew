// depcurfew never reads or writes through a symlink that leads outside the repository (decision P2 of the review
// before 1.0.0): depcurfew.json, init --force, the action's SARIF file and its directory input. A symlink to a file
// inside the repository may be read, but editing it is a reported error, never a crash or a silent pass.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runAction } from '../../src/action.ts';
import { applyProject, loadPolicy, PolicyError } from '../../src/apply/index.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { canSymlink } from '../support/platform.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const SECRET = '{"auths": {"registry": "s3cr3t-token"}}\n';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-symlinks-'));
  temporary.push(directory);
  return directory;
}

/** A repository next to a directory outside it that holds a secret file. */
function layout(): { repo: string; outside: string } {
  const root = scratch();
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.json'), SECRET);
  writeFileSync(join(repo, 'package.json'), '{"name": "app", "packageManager": "npm@11.19.1"}\n');
  return { repo, outside };
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

describe('depcurfew.json behind a symlink', () => {
  it.skipIf(!canSymlink())('is not read when the symlink leads outside the repository', async () => {
    const { repo, outside } = layout();
    symlinkSync(join(outside, 'secret.json'), join(repo, 'depcurfew.json'));
    expect(() => loadPolicy(repo)).toThrow(PolicyError);
    expect(() => loadPolicy(repo)).toThrow('depcurfew.json points outside the repository and was not read');
    expect(() => runDoctor(repo)).toThrow('depcurfew.json points outside the repository and was not read');
    for (const command of [['doctor'], ['apply', '--dry-run'], ['explain'], ['explain', '--json']]) {
      const result = await exec(...command, repo);
      expect(`${result.stdout}${result.stderr}`, command.join(' ')).not.toContain('auths');
      expect(`${result.stdout}${result.stderr}`, command.join(' ')).not.toContain('s3cr3t');
    }
    expect((await exec('doctor', repo)).code).toBe(EXIT_FAILURE);
  });

  it.skipIf(!canSymlink())('is read when the symlink stays inside the repository', () => {
    const { repo } = layout();
    mkdirSync(join(repo, 'config'));
    writeFileSync(join(repo, 'config', 'policy.json'), '{"version": 1, "cooldown": {"minimum": "2d"}}\n');
    symlinkSync(join('config', 'policy.json'), join(repo, 'depcurfew.json'));
    expect(loadPolicy(repo).cooldown?.minimum.text).toBe('2d');
  });

  it('is refused when it is larger than 1 MiB', () => {
    const { repo } = layout();
    writeFileSync(join(repo, 'depcurfew.json'), `{"version": 1, "x": "${'a'.repeat(1024 * 1024)}"}`);
    expect(() => loadPolicy(repo)).toThrow('depcurfew.json is larger than 1 MiB and was not read');
  });
});

describe('init --force', () => {
  it.skipIf(!canSymlink())('does not overwrite the target of a symlink', async () => {
    const { repo, outside } = layout();
    symlinkSync(join(outside, 'secret.json'), join(repo, 'depcurfew.json'));
    const result = await exec('init', '--force', repo);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain(`error: ${join(repo, 'depcurfew.json')} is a symlink; depcurfew does not write through symlinks (cannot-write)\n  fix: Replace the symlink with a regular file, or run depcurfew init in the directory it points to\n`);
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe(SECRET);
  });

  it('still overwrites a regular depcurfew.json', async () => {
    const { repo } = layout();
    writeFileSync(join(repo, 'depcurfew.json'), '{"version": 1}\n');
    const result = await exec('init', '--force', repo);
    expect(result.code).toBe(EXIT_OK);
    expect(readFileSync(join(repo, 'depcurfew.json'), 'utf8')).toContain('"cooldown"');
  });
});

describe('editing a symlink inside the repository', () => {
  it.skipIf(!canSymlink())('is an error for apply and doctor, not a crash', () => {
    const root = scratch();
    cpSync(join(DOCTOR, 'bot-cooldown-mismatch/fires-dependabot-shorter/repo'), root, { recursive: true });
    mkdirSync(join(root, 'config'));
    cpSync(join(root, '.github/dependabot.yml'), join(root, 'config/dependabot.yml'));
    rmSync(join(root, '.github/dependabot.yml'));
    symlinkSync(join('..', 'config', 'dependabot.yml'), join(root, '.github/dependabot.yml'));
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');

    const plan = applyProject(root, { write: false });
    expect(plan.errors).toContain('Dependabot: cannot edit .github/dependabot.yml: .github/dependabot.yml is a symlink; depcurfew does not write through symlinks');

    const report = runDoctor(root);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: 'unreadable-config', level: 'error', location: { file: '.github/dependabot.yml' } }),
    );
  });

  it.skipIf(!canSymlink())('reports a file once even when it can neither be read nor edited', () => {
    const { repo, outside } = layout();
    writeFileSync(join(outside, 'npmrc'), 'min-release-age=0\n');
    symlinkSync(join(outside, 'npmrc'), join(repo, '.npmrc'));
    writeFileSync(join(repo, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    const findings = runDoctor(repo).findings.filter((finding) => finding.rule === 'unreadable-config');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toEqual({ file: '.npmrc' });
  });

  it.skipIf(!canSymlink())('fails doctor when a symlinked manager config weakens the policy', () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"name": "app", "packageManager": "pnpm@11.1.0"}\n');
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'ws.yaml'), 'minimumReleaseAge: 0\n');
    symlinkSync(join('config', 'ws.yaml'), join(root, 'pnpm-workspace.yaml'));
    const report = runDoctor(root);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: 'unreadable-config', level: 'error', location: { file: 'pnpm-workspace.yaml' } }),
    );
  });
});

describe('GitHub Action', () => {
  function workspace(): string {
    const root = scratch();
    cpSync(join(DOCTOR, 'bot-cooldown-mismatch/passes-consistent/repo'), root, { recursive: true });
    return root;
  }

  it.skipIf(!canSymlink())('does not write SARIF through a symlinked file', () => {
    const root = workspace();
    const { outside } = layout();
    symlinkSync(join(outside, 'secret.json'), join(root, 'depcurfew.sarif'));
    const outputs = runAction({ GITHUB_WORKSPACE: root }, { log: () => undefined, summary: () => undefined });
    expect(outputs.failure).toBe('cannot write the SARIF file depcurfew.sarif: depcurfew.sarif is a symlink; depcurfew does not write through symlinks');
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe(SECRET);
  });

  it('does not write SARIF into a symlinked directory', () => {
    const root = workspace();
    const { outside } = layout();
    symlinkSync(outside, join(root, 'reports'), 'junction');
    const outputs = runAction({ GITHUB_WORKSPACE: root, INPUT_SARIF_FILE: 'reports/secret.json' }, { log: () => undefined, summary: () => undefined });
    expect(outputs.failure).toBe('cannot write the SARIF file reports/secret.json: reports is a symlink; depcurfew does not write through symlinks');
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe(SECRET);
  });

  it('checks names that start with two dots as names inside the workspace', () => {
    const root = workspace();
    const { outside } = layout();
    symlinkSync(outside, join(root, '..out'), 'junction');
    const outputs = runAction({ GITHUB_WORKSPACE: root, INPUT_SARIF_FILE: '..out/secret.json' }, { log: () => undefined, summary: () => undefined });
    expect(outputs.failure).toBe('cannot write the SARIF file ..out/secret.json: ..out is a symlink; depcurfew does not write through symlinks');
    expect(readFileSync(join(outside, 'secret.json'), 'utf8')).toBe(SECRET);
  });

  it('refuses a directory input that is a symlink leading outside the workspace', () => {
    const root = workspace();
    const { repo } = layout();
    symlinkSync(repo, join(root, 'sub'), 'junction');
    const outputs = runAction({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: 'sub' }, { log: () => undefined, summary: () => undefined });
    expect(outputs.failure).toBe('directory "sub" is not a directory inside the workspace');
  });
});
