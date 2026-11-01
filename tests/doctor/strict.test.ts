// depcurfew doctor --strict: warnings fail too (exit code 1), notes never do; without --strict nothing changes.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { fakeMachine } from '../support/user.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const FAILING = join(DOCTOR, 'bot-cooldown-mismatch/fires-dependabot-shorter/repo');
const WARNING_ONLY = join(DOCTOR, 'bot-cooldown-mismatch/fires-security-recheck/repo');
const NOTE_ONLY = join(DOCTOR, 'bot-cooldown-mismatch/fires-renovate-unreadable-preset/repo');
const CLEAN = join(DOCTOR, 'bot-cooldown-mismatch/passes-consistent/repo');

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

async function exec(argv: string[], environment?: UserEnvironment): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-01T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

describe('depcurfew doctor --strict', () => {
  it('fails on warnings, in every output format', async () => {
    expect((await exec(['doctor', WARNING_ONLY])).code).toBe(EXIT_OK);
    for (const format of [[], ['--json'], ['--sarif']]) {
      const result = await exec(['doctor', '--strict', ...format, WARNING_ONLY]);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe('');
    }
  });

  it('says in the text why it fails, so the exit code is not a mystery', async () => {
    const result = await exec(['doctor', '--strict', WARNING_ONLY]);
    expect(result.stdout).toContain('--strict: warnings count as failures, so depcurfew doctor exits with 1\n');
    expect((await exec(['doctor', WARNING_ONLY])).stdout).not.toContain('--strict');
  });

  it('does not fail on notes or a clean result', async () => {
    const note = await exec(['doctor', '--strict', '--json', NOTE_ONLY]);
    expect(JSON.parse(note.stdout).summary).toMatchObject({ error: 0, warning: 0, note: 1 });
    expect(note.code).toBe(EXIT_OK);
    expect((await exec(['doctor', '--strict', CLEAN])).code).toBe(EXIT_OK);
  });

  it('still fails on errors', async () => {
    expect((await exec(['doctor', '--strict', FAILING])).code).toBe(EXIT_FAILURE);
  });

  it('reports the mode in JSON without changing the schema version', async () => {
    const result = await exec(['doctor', '--strict', '--json', WARNING_ONLY]);
    const document = JSON.parse(result.stdout);
    expect(document.schemaVersion).toBe(1);
    expect(document.strict).toBe(true);
    expect(JSON.parse((await exec(['doctor', '--json', WARNING_ONLY])).stdout).strict).toBe(false);
  });

  it('works with --user', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    // An environment variable that points npm at another configuration file is a warning of user-environment-overrides.
    const environment: UserEnvironment = { ...machine, env: { ...machine.env, NPM_CONFIG_USERCONFIG: join(machine.root, 'other.npmrc') } };
    const plain = await exec(['doctor', '--user', '--json'], environment);
    const summary = JSON.parse(plain.stdout).summary;
    expect(summary.error).toBe(0);
    expect(summary.warning).toBeGreaterThan(0);
    expect(plain.code).toBe(EXIT_OK);
    expect((await exec(['doctor', '--user', '--strict'], environment)).code).toBe(EXIT_FAILURE);
  });

  it('reports a usage error with --sarif as a SARIF run that did not succeed, with nothing on stderr', async () => {
    const result = await exec(['doctor', '--sarif', '--jsn', CLEAN]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe('');
    const sarif = JSON.parse(result.stdout) as { runs: { invocations: { executionSuccessful: boolean; toolExecutionNotifications: { message: { text: string } }[] }[] }[] };
    expect(sarif.runs[0]?.invocations[0]?.executionSuccessful).toBe(false);
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.message.text).toContain("unknown option '--jsn'");
  });

  it('is a doctor option only', async () => {
    const result = await exec(['explain', '--strict', CLEAN]);
    expect(result.code).toBe(EXIT_USAGE);
  });

  it('describes the exit codes in the help', async () => {
    const help = (await exec(['doctor', '--help'])).stdout;
    expect(help).toContain('--strict');
    expect(help).toMatch(/1 +at least one finding with level error, or with --strict level warning/u);
  });
});
