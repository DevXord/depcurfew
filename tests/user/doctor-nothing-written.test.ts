// doctor --user when apply --user writes nothing for an installed tool because it is too old for every setting the
// user policy needs (D-107): a warning that says what stays unprotected and how to fix it, not a clean report with a
// notice; --strict fails on it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, shownUserFile } from '../support/user.ts';

const cleanup: string[] = [];
afterAll(() => {
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
});

function machine(npm: string) {
  const environment = fakeMachine({ npm: { npm } }, cleanup);
  const policy = userPolicyPath(environment);
  mkdirSync(join(policy, '..'), { recursive: true });
  writeFileSync(policy, '{ "version": 1, "cooldown": { "minimum": "3d" }, "installScripts": { "default": "deny" } }\n');
  return environment;
}

describe('doctor --user with a tool too old for the user policy', () => {
  it('warns that the policy does not protect it, with what to update to', async () => {
    const environment = machine('10.9.9');
    const report = runUserDoctor({ environment });
    const found = report.findings.filter((finding) => finding.rule === 'user-config-drift');
    const file = shownUserFile('npm', environment, [10, 9, 9]);
    expect(found).toEqual([
      {
        rule: 'user-config-drift',
        level: 'warning',
        location: { file },
        message: `npm 10.9.9 is too old for the user policy: it lacks an allow-list for install scripts and min-release-age (added in 11.10.0), so depcurfew apply --user writes nothing to ${file} and the user policy does not protect npm: the install scripts of dependencies still run and new versions install without the release-age delay`,
        fix: 'Update npm to 11.16.0 or later (npm install -g npm@11.16.0), then run depcurfew apply --user; or pass the installed version with --for npm@<version> if 10.9.9 is not it',
      },
    ]);
    expect(report.notices.map((notice) => notice.message).filter((message) => message.includes('does not write it'))).toEqual([]);

    let stdout = '';
    const io = { stdout: (text: string) => (stdout += text), stderr: () => undefined };
    const dependencies = { fetch: () => Promise.reject(new Error('no network')), now: () => new Date(), stdin: () => Promise.resolve(''), userEnvironment: () => environment };
    expect(await run(['doctor', '--user'], io, dependencies as never)).toBe(EXIT_OK);
    expect(stdout).not.toMatch(/^No problems found/mu);
    expect(await run(['doctor', '--user', '--strict'], io, dependencies as never)).toBe(EXIT_FAILURE);
  });

  it('says what stays unprotected when only part of the policy cannot be written', () => {
    const environment = machine('11.12.0');
    const file = shownUserFile('npm', environment, [11, 12, 0]);
    const found = runUserDoctor({ environment }).findings.filter((finding) => finding.rule === 'user-config-drift' && finding.message.startsWith('npm 11.12.0'));
    expect(found.map((finding) => finding.message)).toEqual([
      `npm 11.12.0 is too old for part of the user policy: it lacks an allow-list for install scripts, so depcurfew apply --user leaves that out of ${file} and the user policy does not fully protect npm: the install scripts of dependencies still run`,
    ]);
  });
});
