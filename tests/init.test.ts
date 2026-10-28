import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../src/cli/run.ts';
import { parsePolicy } from '../src/policy/validate.ts';

const EXPECTED = readFileSync(new URL('fixtures/init/depgate.json', import.meta.url), 'utf8');

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

describe('depgate init', () => {
  let directory: string;
  let policyFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'depgate-init-'));
    policyFile = join(directory, 'depgate.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates depgate.json with the default policy', async () => {
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
    expect(result.stderr).toBe(`depgate: ${policyFile} already exists; pass --force to overwrite it.\n`);
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
    expect(result).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `depgate: directory not found: ${missing}\n` });
  });

  it('fails when the target is a file, not a directory', async () => {
    const file = join(directory, 'file.txt');
    writeFileSync(file, '');
    const result = await exec('init', file);
    expect(result).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `depgate: not a directory: ${file}\n` });
  });

  it('reports a write error', async () => {
    mkdirSync(policyFile);
    const result = await exec('init', directory, '--force');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(new RegExp(`^depgate: cannot write ${policyFile.replaceAll('\\', '\\\\')}: `));
  });

  it('reports the tools it detects', async () => {
    cpSync(fileURLToPath(new URL('fixtures/repos/pnpm11-dependabot', import.meta.url)), directory, { recursive: true });
    const result = await exec('init', directory);
    expect(result.stdout).toBe(`Created ${policyFile} with the default policy.\nDetected tools: pnpm, Dependabot.\n`);
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
    const result = await exec('init', '--help');
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/^ {2}init {2,}Create a default policy file \(depgate\.json\)$/m);
    expect(result.stdout).toMatch(/^ {2}--force {2,}Overwrite an existing depgate\.json$/m);
  });
});
