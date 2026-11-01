// doctor --user reports every place of a user file that does not match the user policy, as config-drift does for a
// project file (decision D-122): changed lines next to each other are one finding, places further apart one each, at
// most five per file, the last with how many more places differ.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { run } from '../../src/cli/run.ts';
import { userDriftFindings } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { canSymlink } from '../support/platform.ts';
import { fakeMachine, shownPolicy } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

async function exec(argv: string[], environment: UserEnvironment): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-01T12:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

interface Drift {
  rule: string;
  location: { file: string; line?: number };
  message: string;
}

/** npm 11.21.1 with the default user policy written by apply --user, then ~/.npmrc edited by `edit`. */
async function edited(edit: (text: string) => string): Promise<{ machine: UserEnvironment; drift: Drift[]; text: string }> {
  const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
  expect((await exec(['init', '--user'], machine)).code).toBe(0);
  expect((await exec(['apply', '--user'], machine)).code).toBe(0);
  const npmrc = join(machine.home, '.npmrc');
  writeFileSync(npmrc, edit(readFileSync(npmrc, 'utf8')));
  const json = await exec(['doctor', '--user', '--json'], machine);
  const findings = (JSON.parse(json.stdout) as { findings: Drift[] }).findings;
  const text = await exec(['doctor', '--user'], machine);
  return { machine, drift: findings.filter((finding) => finding.rule === 'user-config-drift'), text: text.stdout };
}

const lineOf = (text: string, start: string): number => text.split('\n').findIndex((line) => line.startsWith(start)) + 1;

describe.skipIf(!canSymlink())('doctor --user and a user file that differs in several places (V6)', () => {
  it('reports each place apart from the others with its line, as config-drift does in a project', async () => {
    const { machine, drift, text } = await edited((npmrc) => npmrc.replace('min-release-age=3', 'min-release-age=1').replace('allow-directory=all', 'allow-directory=none'));
    const npmrc = readFileSync(join(machine.home, '.npmrc'), 'utf8');
    const head = `~/.npmrc does not match the user policy (${shownPolicy(machine)}): `;
    expect(drift).toEqual([
      { rule: 'user-config-drift', level: 'warning', location: { file: '~/.npmrc', line: 2 }, message: `${head}\`min-release-age=1\` should be \`min-release-age=3\``, fix: expect.any(String) },
      {
        rule: 'user-config-drift',
        level: 'warning',
        location: { file: '~/.npmrc', line: lineOf(npmrc, 'allow-directory=') },
        message: `${head}\`allow-directory=none\` should be \`allow-directory=all\``,
        fix: 'Run depcurfew apply --user --dry-run to see the difference, then depcurfew apply --user',
      },
    ]);
    expect(lineOf(npmrc, 'allow-directory=')).toBe(7);
    // The text lists both under the file, each with its line.
    expect(text).toContain(`~/.npmrc\n  2: warning ${head}\`min-release-age=1\` should be \`min-release-age=3\` (user-config-drift)\n`);
    expect(text).toContain(`  7: warning ${head}\`allow-directory=none\` should be \`allow-directory=all\` (user-config-drift)\n`);
  });

  it('keeps changed lines next to each other in one finding that names each of them', async () => {
    const { machine, drift } = await edited((npmrc) => npmrc.replace('allow-git=none', 'allow-git=all').replace('allow-remote=none', 'allow-remote=all'));
    expect(drift).toHaveLength(1);
    expect(drift[0]?.location).toEqual({ file: '~/.npmrc', line: 4 });
    expect(drift[0]?.message).toBe(`~/.npmrc does not match the user policy (${shownPolicy(machine)}): \`allow-git=all\` should be \`allow-git=none\`, \`allow-remote=all\` should be \`allow-remote=none\``);
  });

  it('gives at most five findings per file, the last with how many more places differ', () => {
    const block = (values: readonly string[]) => `# >>> depcurfew managed block\n${values.map((value, index) => `key${index}=${value}\nkeep${index}=x\n`).join('')}# <<< depcurfew managed block\n`;
    const after = block(['a', 'a', 'a', 'a', 'a', 'a', 'a']);
    const before = block(['b', 'b', 'b', 'b', 'b', 'b', 'b']);
    const findings = userDriftFindings({ file: '~/.npmrc', before, after }, '~/.config/depcurfew/depcurfew.json');
    expect(findings.map((finding) => finding.location)).toEqual([2, 4, 6, 8, 10].map((line) => ({ file: '~/.npmrc', line })));
    expect(findings[0]?.message).toBe('~/.npmrc does not match the user policy (~/.config/depcurfew/depcurfew.json): `key0=b` should be `key0=a`');
    expect(findings.at(-1)?.message).toBe(
      '~/.npmrc does not match the user policy (~/.config/depcurfew/depcurfew.json): `key4=b` should be `key4=a`; 2 more places in ~/.npmrc differ too (depcurfew apply --user --dry-run shows them)',
    );
    // A file that does not exist is one finding, as before.
    expect(userDriftFindings({ file: '~/.npmrc', before: null, after }, '~/.config/depcurfew/depcurfew.json')).toEqual([
      {
        rule: 'user-config-drift',
        level: 'warning',
        location: { file: '~/.npmrc' },
        message: '~/.npmrc does not exist, so the user policy is not applied there',
        fix: 'Run depcurfew apply --user --dry-run to see the difference, then depcurfew apply --user',
      },
    ]);
  });
});
