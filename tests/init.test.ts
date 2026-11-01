import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../src/cli/run.ts';
import { parsePolicy } from '../src/policy/validate.ts';

const EXPECTED = readFileSync(new URL('fixtures/init/depcurfew.json', import.meta.url), 'utf8');

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

describe('depcurfew init', () => {
  let directory: string;
  let policyFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'depcurfew-init-'));
    policyFile = join(directory, 'depcurfew.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates depcurfew.json with the default policy', async () => {
    const result = await exec('init', directory);
    expect(result).toEqual({
      code: EXIT_OK,
      stdout: `Created ${policyFile} with the default policy.\nDetected tools: none.\n`,
      stderr: '',
    });
    expect(readFileSync(policyFile, 'utf8')).toBe(EXPECTED);
  });

  it('writes a policy that passes validation', async () => {
    await exec('init', directory);
    expect(parsePolicy(readFileSync(policyFile, 'utf8'))).toMatchObject({ ok: true });
  });

  it('refuses to overwrite an existing policy file', async () => {
    writeFileSync(policyFile, '{ "version": 1 }\n');
    const result = await exec('init', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`error: ${policyFile} already exists (policy-exists)\n  fix: Pass --force to overwrite it with the default policy, or edit it by hand\n`);
    expect(readFileSync(policyFile, 'utf8')).toBe('{ "version": 1 }\n');
  });

  it('overwrites an existing policy file with --force', async () => {
    writeFileSync(policyFile, '{ "version": 1 }\n');
    const result = await exec('init', '--force', directory);
    expect(result).toEqual({
      code: EXIT_OK,
      stdout: `Overwrote ${policyFile} with the default policy.\nDetected tools: none.\n`,
      stderr: '',
    });
    expect(readFileSync(policyFile, 'utf8')).toBe(EXPECTED);
  });

  it('is idempotent with --force', async () => {
    await exec('init', directory);
    await exec('init', directory, '--force');
    expect(readFileSync(policyFile, 'utf8')).toBe(EXPECTED);
  });

  it('fails when the directory does not exist', async () => {
    const missing = join(directory, 'missing');
    const result = await exec('init', missing);
    expect(result).toEqual({ code: EXIT_USAGE, stdout: '', stderr: `error: directory not found: ${missing} (directory-not-found)\n  fix: Pass the path of an existing directory\n` });
  });

  it('fails when the target is a file, not a directory', async () => {
    const file = join(directory, 'file.txt');
    writeFileSync(file, '');
    const result = await exec('init', file);
    expect(result).toEqual({ code: EXIT_USAGE, stdout: '', stderr: `error: not a directory: ${file} (not-a-directory)\n  fix: Pass the directory of the project, not a file in it\n` });
  });

  it('says what to do when depcurfew.json is a directory, with or without --force', async () => {
    mkdirSync(policyFile);
    for (const argv of [[directory, '--force'], [directory]]) {
      const result = await exec('init', ...argv);
      expect(result).toEqual({
        code: EXIT_FAILURE,
        stdout: '',
        stderr: `error: ${policyFile} is a directory, not a file (cannot-write)\n  fix: Remove or rename the directory ${policyFile}, then run depcurfew init again\n`,
      });
    }
  });

  it('reports any other write error with its reason and what to do', async () => {
    const readOnly = join(directory, 'read-only');
    mkdirSync(readOnly, { mode: 0o555 });
    const result = await exec('init', readOnly);
    // root may write anyway; then there is nothing to report.
    if (result.code === EXIT_OK) return;
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(new RegExp(`^error: cannot write ${join(readOnly, 'depcurfew.json').replaceAll('\\', '\\\\')}: EACCES[^\\n]* \\(cannot-write\\)\\n  fix: Make sure you can write to the directory, then run depcurfew init again\\n$`, 'u'));
  });

  it('reports the tools it detects', async () => {
    cpSync(fileURLToPath(new URL('fixtures/repos/pnpm11-dependabot', import.meta.url)), directory, { recursive: true });
    const result = await exec('init', directory);
    expect(result.stdout).toBe(`Created ${policyFile} with the default policy.\nDetected tools: pnpm, Dependabot.\n`);
  });

  it('warns that the default policy blocks Python builds from source, and says to run doctor before apply', async () => {
    cpSync(fileURLToPath(new URL('fixtures/repos/uv-basic', import.meta.url)), directory, { recursive: true });
    const result = await exec('init', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(
      'note: installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for your platform stops installing; run depcurfew doctor before depcurfew apply to see the locked packages that have none, and add the ones you trust to installScripts.allow as pypi:<name>.\n',
    );
    // A requirements file lists no wheels, so doctor cannot tell; check asks the index (D-107).
    cpSync(fileURLToPath(new URL('fixtures/repos/pip-requirements', import.meta.url)), join(directory, 'pip'), { recursive: true });
    expect((await exec('init', join(directory, 'pip'))).stdout).toContain(
      'note: installScripts.default "deny" also blocks building Python packages from source, so a package without wheels for your platform stops installing; run depcurfew check pypi:<name> for each package the project installs to see whether it has wheels (doctor can tell only from a uv.lock, poetry.lock, pdm.lock or pylock.toml), and add the ones you trust to installScripts.allow as pypi:<name>.\n',
    );
    // Not for a project without Python tools.
    cpSync(fileURLToPath(new URL('fixtures/repos/pnpm11-dependabot', import.meta.url)), join(directory, 'js'), { recursive: true });
    expect((await exec('init', join(directory, 'js'))).stdout).not.toContain('Python');
  });

  it('lists a tool seen only in a CI setup step apart, as apply does not configure it', async () => {
    cpSync(fileURLToPath(new URL('fixtures/repos/deno-ci-bun', import.meta.url)), directory, { recursive: true });
    const result = await exec('init', directory);
    expect(result).toEqual({
      code: EXIT_OK,
      stdout:
        `Created ${policyFile} with the default policy.\n` +
        'Detected tools: Deno.\n' +
        'Bun is seen only in a CI setup step (.github/workflows/ci.yml), so depcurfew apply does not configure it; add "bun" to targets in depcurfew.json if it installs packages for this project.\n',
      stderr: '',
    });
  });

  it('keeps a longer release-age delay the repository already sets, and says where it is', async () => {
    writeFileSync(join(directory, 'package.json'), '{"name": "app", "packageManager": "npm@11.19.1"}\n');
    writeFileSync(join(directory, '.npmrc'), 'save-exact=true\nmin-release-age=14\n');
    mkdirSync(join(directory, '.github'));
    writeFileSync(
      join(directory, '.github/dependabot.yml'),
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 7\n',
    );
    const result = await exec('init', directory);
    expect(result).toEqual({
      code: EXIT_OK,
      stdout:
        `Created ${policyFile} with the default policy.\n` +
        'cooldown.minimum is 14d instead of 3d, to keep the longest release-age delay already set: min-release-age=14 in .npmrc (line 2).\n' +
        'Detected tools: npm, Dependabot.\n',
      stderr: '',
    });
    const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { cooldown: { minimum: string } };
    expect(policy.cooldown.minimum).toBe('14d');
    expect(parsePolicy(readFileSync(policyFile, 'utf8'))).toMatchObject({ ok: true });
  });

  it('rounds a delay up to whole minutes and keeps the default when existing delays are shorter', async () => {
    writeFileSync(join(directory, 'package.json'), '{"name": "app"}\n');
    writeFileSync(join(directory, 'bun.lock'), '{}\n');
    writeFileSync(join(directory, 'bunfig.toml'), '[install]\nminimumReleaseAge = 345601\n');
    await exec('init', directory);
    expect((JSON.parse(readFileSync(policyFile, 'utf8')) as { cooldown: { minimum: string } }).cooldown.minimum).toBe('5761m');
    writeFileSync(join(directory, 'bunfig.toml'), '[install]\nminimumReleaseAge = 86400\n');
    const result = await exec('init', directory, '--force');
    expect(result.stdout).toBe(`Overwrote ${policyFile} with the default policy.\nDetected tools: Bun.\n`);
    expect(readFileSync(policyFile, 'utf8')).toBe(EXPECTED);
  });

  it('accepts at most one directory', async () => {
    const result = await exec('init', directory, directory);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("too many arguments for 'init'");
  });
});

describe('command options', () => {
  it('rejects an option that belongs to another command', async () => {
    const result = await exec('doctor', '--force');
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("option '--force' is not supported by 'doctor'");
  });

  it('documents init and --force in the help', async () => {
    const result = await exec('--help');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/^ {2}init {2,}Create a default policy file \(depcurfew\.json\)$/m);
    expect(result.stdout).toMatch(/^ {2}--force {2,}Overwrite an existing depcurfew\.json$/m);
  });

  it('describes init, its options and exit codes in depcurfew init --help', async () => {
    const result = await exec('init', '--help');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/^Usage: depcurfew init \[directory\] \[options\]$/m);
    expect(result.stdout).toMatch(/^ {2}--force {2,}Overwrite an existing depcurfew\.json$/m);
    expect(result.stdout).toMatch(/^Exit codes:$/m);
  });
});
