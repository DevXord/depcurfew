// doctor --user (decision D-087): drift from the user policy, weakening values in user files and environment variables
// that override them, with a temporary home directory and PATH.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { renderPolicy, DEFAULT_POLICY } from '../../src/policy/defaults.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { loadUserPolicy } from '../../src/user/policy.ts';
import { canSymlink } from '../support/platform.ts';
import { platform, shownPolicy } from '../support/user.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { dirname } from 'node:path';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function machine(options: { policy?: boolean; env?: Record<string, string> } = {}): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-doctor-'));
  temporary.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const pkg = join(root, 'lib', 'node_modules', 'npm');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'npm', version: '11.21.1', bin: { npm: 'bin/npm-cli.js' } }));
  writeFileSync(join(pkg, 'bin', 'npm-cli.js'), '');
  if (canSymlink()) symlinkSync(join(pkg, 'bin', 'npm-cli.js'), join(bin, 'npm'));
  if (options.policy !== false) {
    const policy = userPolicyPath({ platform, home, env: {} });
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, renderPolicy(DEFAULT_POLICY));
  }
  return { platform, home, env: { PATH: bin, ...options.env } };
}

const rules = (report: ReturnType<typeof runUserDoctor>) => report.findings.map((finding) => finding.rule);

describe.skipIf(!canSymlink())('doctor --user', () => {
  it('reports a user file that does not match the user policy, and nothing once apply --user wrote it', () => {
    const environment = machine();
    const before = runUserDoctor({ environment });
    expect(before.findings).toEqual([
      {
        rule: 'user-config-drift',
        level: 'warning',
        location: { file: '~/.npmrc' },
        message: '~/.npmrc does not exist, so the user policy is not applied there',
        fix: 'Run depcurfew apply --user --dry-run to see the difference, then depcurfew apply --user',
      },
    ]);
    writeUserChanges(planUserApply(loadUserPolicy(environment).policy, { environment }));
    expect(runUserDoctor({ environment }).findings).toEqual([]);
  });

  it('reports a value in the user file that weakens every project, with its line', () => {
    const environment = machine();
    writeUserChanges(planUserApply(loadUserPolicy(environment).policy, { environment }));
    writeFileSync(join(environment.home, '.npmrc'), `save-exact=true\ndangerously-allow-all-scripts=true\n`, { flag: 'a' });
    const report = runUserDoctor({ environment });
    const weakens = report.findings.filter((finding) => finding.rule === 'user-config-weakens');
    expect(weakens).toHaveLength(1);
    expect(weakens[0]?.location.file).toBe('~/.npmrc');
    expect(weakens[0]?.location.line).toBeGreaterThan(1);
    expect(weakens[0]?.message).toContain('dangerously-allow-all-scripts = "true" in ~/.npmrc runs every dependency install script');
  });

  it('reports environment variables that move or override the user file, in any case for npm', () => {
    const environment = machine({ env: { NPM_CONFIG_USERCONFIG: '/tmp/other-npmrc' } });
    const report = runUserDoctor({ environment });
    const found = report.findings.find((finding) => finding.rule === 'user-environment-overrides');
    expect(found).toMatchObject({ level: 'warning', location: { file: 'environment' } });
    expect(found?.message).toBe('NPM_CONFIG_USERCONFIG is set in the environment (npm): makes npm read another user file');
    expect(found?.fix).toContain('Unset NPM_CONFIG_USERCONFIG');
    expect(found?.location).toEqual({ file: 'environment', variable: 'NPM_CONFIG_USERCONFIG' });
  });

  it('runs the checks that need no user policy when there is none', () => {
    const environment = machine({ policy: false, env: { npm_config_min_release_age: '0' } });
    const report = runUserDoctor({ environment });
    expect(report.policy).toBe('missing');
    expect(report.notices[0]?.message).toContain(`no user policy at ${shownPolicy(environment)}`);
    expect(rules(report)).toEqual(['user-environment-overrides']);
  });

  it('prints JSON and SARIF on the command line', async () => {
    const environment = machine();
    let stdout = '';
    const dependencies: CheckDependencies = { fetch: () => Promise.reject(new Error('offline')), now: () => new Date(), stdin: () => Promise.resolve(''), userEnvironment: () => environment };
    const code = await run(['doctor', '--user', '--json'], { stdout: (text) => (stdout += text), stderr: () => undefined }, dependencies);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, policy: 'valid', summary: { warning: 1, error: 0 } });
    stdout = '';
    await run(['doctor', '--user', '--sarif'], { stdout: (text) => (stdout += text), stderr: () => undefined }, dependencies);
    const sarif = JSON.parse(stdout) as { runs: { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string }[] }[] };
    expect(sarif.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toEqual([
      'user-policy-invalid',
      'user-config-unreadable',
      'user-config-drift',
      'user-config-weakens',
      'user-environment-overrides',
    ]);
    expect(sarif.runs[0]?.results.map((result) => result.ruleId)).toEqual(['user-config-drift']);
  });
});
