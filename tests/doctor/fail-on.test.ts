// doctor.failOn in depcurfew.json and doctor --fail-on (decision D-112): which findings make depcurfew doctor exit
// with 1. The option wins over the policy, the policy over the default "error"; a policy without the section keeps
// its exit codes. Notes never fail.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, shownPolicy } from '../support/user.ts';

const DOCTOR = fileURLToPath(new URL('../fixtures/doctor/', import.meta.url));
const FAILING = 'bot-cooldown-mismatch/fires-dependabot-shorter';
const WARNING_ONLY = 'bot-cooldown-mismatch/fires-security-recheck';
const NOTE_ONLY = 'bot-cooldown-mismatch/fires-renovate-unreadable-preset';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A copy of a doctor fixture with this depcurfew.json (or none). */
function repository(fixture: string, policy?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-fail-on-'));
  temporary.push(root);
  cpSync(join(DOCTOR, fixture, 'repo'), root, { recursive: true });
  if (policy !== undefined) writeFileSync(join(root, 'depcurfew.json'), typeof policy === 'string' ? policy : `${JSON.stringify(policy, null, 2)}\n`);
  return root;
}

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

const WARNING_POLICY = { version: 1, doctor: { failOn: 'warning' } };
const POLICY_LINE = 'doctor.failOn is "warning" in depcurfew.json, so warnings count as failures and depcurfew doctor exits with 1';
const POLICY_FIX = 'fix: Set doctor.failOn to "error" in depcurfew.json, or pass --fail-on error, to fail on errors only';

describe('doctor.failOn in depcurfew.json', () => {
  it('"warning" makes a warning fail doctor, in every output format', async () => {
    const root = repository(WARNING_ONLY, WARNING_POLICY);
    for (const format of [[], ['--json'], ['--sarif']]) {
      const result = await exec(['doctor', ...format, root]);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe('');
    }
  });

  it('says in the text where the setting comes from and how to fail on errors only', async () => {
    const result = await exec(['doctor', repository(WARNING_ONLY, WARNING_POLICY)]);
    const lines = result.stdout.split('\n');
    expect(lines.slice(0, 3)).toEqual(['0 errors, 1 warning, 0 notes', POLICY_LINE, `  ${POLICY_FIX}`]);
    expect(result.stdout).not.toContain('--strict');
  });

  it('reports the setting in JSON, with where it came from, without changing the schema version', async () => {
    const document = JSON.parse((await exec(['doctor', '--json', repository(WARNING_ONLY, WARNING_POLICY)])).stdout);
    expect(document).toMatchObject({ schemaVersion: 1, strict: true, failOn: 'warning', failOnFrom: 'policy', summary: { error: 0, warning: 1 } });
  });

  it('"error", an empty section or no section keep failing on errors only', async () => {
    for (const [policy, from] of [
      [{ version: 1, doctor: { failOn: 'error' } }, 'policy'],
      [{ version: 1, doctor: {} }, 'policy'],
      [{ version: 1 }, 'default'],
      [undefined, 'default'],
    ] as const) {
      const root = repository(WARNING_ONLY, policy);
      const result = await exec(['doctor', '--json', root]);
      expect(result.code).toBe(EXIT_OK);
      expect(JSON.parse(result.stdout)).toMatchObject({ strict: false, failOn: 'error', failOnFrom: from });
      const text = await exec(['doctor', root]);
      expect(text.code).toBe(EXIT_OK);
      expect(text.stdout).not.toContain('count as failures');
    }
  });

  it('never fails on notes, and still fails on errors', async () => {
    const note = await exec(['doctor', '--json', repository(NOTE_ONLY, WARNING_POLICY)]);
    expect(JSON.parse(note.stdout).summary).toMatchObject({ error: 0, warning: 0, note: 1 });
    expect(note.code).toBe(EXIT_OK);
    expect((await exec(['doctor', repository(FAILING, WARNING_POLICY)])).code).toBe(EXIT_FAILURE);
  });

  it('counts as "error" when depcurfew.json is invalid, which fails doctor anyway', async () => {
    const root = repository(WARNING_ONLY, { version: 1, doctor: { failOn: 'warnings' } });
    const result = await exec(['doctor', '--json', root]);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout);
    expect(document).toMatchObject({ policy: 'invalid', failOn: 'error', failOnFrom: 'default', strict: false });
    const invalid = document.findings.find((finding: { rule: string }) => finding.rule === 'invalid-policy');
    expect(invalid.message).toContain('doctor.failOn: must be one of "error", "warning", got "warnings"; did you mean "warning"?');
    // The option still decides with an invalid policy.
    expect(JSON.parse((await exec(['doctor', '--json', '--fail-on', 'warning', root])).stdout)).toMatchObject({ failOn: 'warning', failOnFrom: 'option' });
  });
});

describe('doctor --fail-on', () => {
  it('overrides the policy in both directions', async () => {
    const strictPolicy = repository(WARNING_ONLY, WARNING_POLICY);
    const relaxed = await exec(['doctor', '--json', '--fail-on', 'error', strictPolicy]);
    expect(relaxed.code).toBe(EXIT_OK);
    expect(JSON.parse(relaxed.stdout)).toMatchObject({ strict: false, failOn: 'error', failOnFrom: 'option' });
    expect((await exec(['doctor', '--fail-on=error', strictPolicy])).stdout).not.toContain('count as failures');

    const plain = repository(WARNING_ONLY);
    const strict = await exec(['doctor', '--json', '--fail-on', 'warning', plain]);
    expect(strict.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(strict.stdout)).toMatchObject({ strict: true, failOn: 'warning', failOnFrom: 'option' });
  });

  it('names the option in the text', async () => {
    const result = await exec(['doctor', '--fail-on', 'warning', repository(WARNING_ONLY, WARNING_POLICY)]);
    expect(result.stdout.split('\n').slice(1, 3)).toEqual([
      '--fail-on warning: warnings count as failures, so depcurfew doctor exits with 1',
      '  fix: Pass --fail-on error instead of --fail-on warning to fail on errors only',
    ]);
  });

  it('keeps --strict as --fail-on warning', async () => {
    const result = await exec(['doctor', '--strict', repository(WARNING_ONLY)]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout.split('\n').slice(1, 3)).toEqual([
      '--strict: warnings count as failures, so depcurfew doctor exits with 1',
      '  fix: Pass --fail-on error instead of --strict to fail on errors only',
    ]);
    const document = JSON.parse((await exec(['doctor', '--json', '--strict', repository(WARNING_ONLY)])).stdout);
    expect(document).toMatchObject({ strict: true, failOn: 'warning', failOnFrom: 'option' });
    expect((await exec(['doctor', '--strict', '--fail-on', 'warning', repository(WARNING_ONLY)])).code).toBe(EXIT_FAILURE);
  });

  it('is a usage error with --strict and --fail-on error, or with another value, also as JSON', async () => {
    const root = repository(WARNING_ONLY);
    const conflict = await exec(['doctor', '--strict', '--fail-on', 'error', root]);
    expect(conflict).toEqual({
      code: EXIT_USAGE,
      stdout: '',
      stderr: "depcurfew: '--strict' and '--fail-on error' cannot be used together: --strict means --fail-on warning, so pass only one of them\nRun 'depcurfew doctor --help' for usage.\n",
    });
    const value = await exec(['doctor', '--fail-on', 'warnings', root]);
    expect(value.code).toBe(EXIT_USAGE);
    expect(value.stderr).toBe("depcurfew: --fail-on takes error (only errors fail) or warning (warnings fail too), not 'warnings'\nRun 'depcurfew doctor --help' for usage.\n");
    const json = await exec(['doctor', '--json', '--fail-on', 'never', root]);
    expect(json.code).toBe(EXIT_USAGE);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).errors[0]).toMatchObject({ code: 'usage', message: "--fail-on takes error (only errors fail) or warning (warnings fail too), not 'never'" });
    expect((await exec(['explain', '--fail-on', 'warning', root])).code).toBe(EXIT_USAGE);
  });

  it('is described in the help with the exit codes', async () => {
    const help = (await exec(['doctor', '--help'])).stdout.replaceAll(/\s+/gu, ' ');
    expect(help).toMatch(/--fail-on <level> Which findings make doctor exit with 1: error \(only errors, the default\) or warning \(warnings too; notes never fail\); overrides doctor\.failOn in depcurfew\.json/u);
    expect(help).toContain('doctor.failOn');
    expect(help).toMatch(/ 1 at least one finding with level error, or with level warning when doctor\.failOn in depcurfew\.json or --fail-on is warning/u);
  });
});

describe('doctor --user and doctor.failOn in the user policy', () => {
  function machine(policy: unknown): UserEnvironment & { root: string } {
    const created = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    // An environment variable that points npm at another configuration file is a warning of user-environment-overrides.
    const environment = { ...created, env: { ...created.env, NPM_CONFIG_USERCONFIG: join(created.root, 'other.npmrc') } };
    const path = userPolicyPath(environment);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(policy)}\n`);
    return environment;
  }

  it('follows doctor.failOn of the user policy, and --fail-on wins', async () => {
    const environment = machine(WARNING_POLICY);
    const result = await exec(['doctor', '--user'], environment);
    expect(result.code).toBe(EXIT_FAILURE);
    const file = shownPolicy(environment);
    expect(result.stdout).toContain(`\ndoctor.failOn is "warning" in ${file}, so warnings count as failures and depcurfew doctor exits with 1\n`);
    expect(result.stdout).toContain(`\n  fix: Set doctor.failOn to "error" in ${file}, or pass --fail-on error, to fail on errors only\n`);
    expect(JSON.parse((await exec(['doctor', '--user', '--json'], environment)).stdout)).toMatchObject({ failOn: 'warning', failOnFrom: 'policy', strict: true });
    expect((await exec(['doctor', '--user', '--fail-on', 'error'], environment)).code).toBe(EXIT_OK);
  });

  it('fails on errors only without the section', async () => {
    const environment = machine({ version: 1 });
    const result = await exec(['doctor', '--user', '--json'], environment);
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ failOn: 'error', failOnFrom: 'default', strict: false });
    expect((await exec(['doctor', '--user', '--fail-on', 'warning'], environment)).code).toBe(EXIT_FAILURE);
  });
});
