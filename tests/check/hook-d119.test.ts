// Findings of the last verification of 1.3.0 in the Claude Code hook (decision D-119): a change of directory can only
// tighten the check (the policies of the working directory apply to every install too), a cd to a directory that does
// not exist or is a file leaves the directory unknown, cd -P and set -P are resolved through symlinks, and the scanner's
// fixes ($'…', --no- abbreviations, env -C, find -execdir, traps, PowerShell paths with \) reach the decision.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_OK, run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

const policy = (document: object) => JSON.stringify({ version: 1, ...document });

/**
 * The verifier's repository P: a git repository whose root policy allows releases older than an hour, pkgs/strict with
 * a policy of 90 days and pkgs/other without one. @types/node@26.6.6 was published 17 hours before NOW.
 */
function repository(root: object = { cooldown: { minimum: '1h' } }): string {
  const created = mkdtempSync(join(tmpdir(), 'depcurfew-d119-'));
  temporary.push(created);
  mkdirSync(join(created, '.git'));
  write(created, {
    'depcurfew.json': policy(root),
    'package.json': '{"name":"root","private":true}',
    'pkgs/strict/depcurfew.json': policy({ cooldown: { minimum: '90d' } }),
    'pkgs/strict/package.json': '{"name":"strict","private":true}',
    'pkgs/strict/sub/package.json': '{"name":"sub","private":true}',
    'pkgs/other/package.json': '{"name":"other","private":true}',
  });
  return created;
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, cwd: string, projectDir: string | undefined, tool = 'Bash'): Promise<Output> {
  let stdout = '';
  const stdin = JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: recordedFetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => projectDir,
  });
  expect(code).toBe(EXIT_OK);
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const STRICT = 'pkgs/strict/depcurfew.json requires 90 days';
const INSTALL = 'npm install @types/node@26.6.6';

describe('a change of directory can only tighten the check (H1)', () => {
  it.each([
    [`cd ../nope; ${INSTALL}`],
    [`cd /nonexistent-depcurfew-d119; ${INSTALL}`],
    [`cd ../other || ${INSTALL}`],
    [`cd ../other; ${INSTALL}`],
    [`cd ../../..; ${INSTALL}`],
    [`npm --prefix ../other install @types/node@26.6.6`],
  ])('denies %s from pkgs/strict with the policy of the working directory', async (command) => {
    const root = repository();
    const answer = await hook(command, join(root, 'pkgs', 'strict'), root);
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(STRICT);
  });

  it('says that the policy of the working directory applies too', async () => {
    const root = repository();
    const answer = await hook(`cd ../other && ${INSTALL}`, join(root, 'pkgs', 'strict'), root);
    expect(answer.permissionDecisionReason).toContain(
      'The policy of the working directory (pkgs/strict/depcurfew.json) also applies to what the command installs in pkgs/other, so that changing directory never relaxes the check; the stricter answer counts.',
    );
  });

  it.each([
    [`cd nope; cd pkgs/strict; ${INSTALL}`, '"nope", which is not an existing directory'],
    [`cd package.json; ${INSTALL}`, '"package.json", which is not an existing directory'],
    [`cd nope/../pkgs/strict && ${INSTALL}`, '"nope/../pkgs/strict", which is not an existing directory'],
    [`cd pkgs/strict; OLDPWD=$PWD; cd -; ${INSTALL}`, 'OLDPWD'],
  ])('asks about %s, whose directory it cannot tell', async (command, reason) => {
    const root = repository();
    const answer = await hook(command, root, root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain(reason);
  });

  it('tells the agent to change only to a directory that exists', async () => {
    const root = repository();
    const answer = await hook(`cd nope && ${INSTALL}`, root, root);
    expect(answer.permissionDecisionReason).toBe(
      `depcurfew cannot vouch for what this command installs:\n- depcurfew cannot tell which directory "${INSTALL}" runs in: the command changes to "nope", which is not an existing directory, so the shell may stay where it was. Fix: Change only to a directory that exists (or create it with mkdir earlier in the same command), so depcurfew checks the install with the policy that applies there`,
    );
  });

  it('takes a directory that mkdir creates earlier in the command', async () => {
    const root = repository();
    expect(await hook(`mkdir -p fresh/app && cd fresh/app && ${INSTALL}`, root, root)).toEqual({});
    expect((await hook(`mkdir -p pkgs/strict/new && cd pkgs/strict/new && ${INSTALL}`, root, root)).permissionDecision).toBe('deny');
  });

  it.skipIf(process.platform === 'win32')('resolves cd -P and set -P through symlinks, as bash does', async () => {
    const root = repository();
    symlinkSync(join(root, 'pkgs', 'strict', 'sub'), join(root, 'l'), 'junction');
    // cd l/.. is the root logically; cd -P l/.. is pkgs/strict.
    expect(await hook(`cd l/.. && ${INSTALL}`, root, root)).toEqual({});
    for (const command of [`cd -P l/.. && ${INSTALL}`, `set -P; cd l/..; ${INSTALL}`, `set -o physical; cd l && cd .. && ${INSTALL}`, `cd -P l && cd .. && ${INSTALL}`]) {
      const answer = await hook(command, root, root);
      expect(answer.permissionDecision, command).toBe('deny');
      expect(answer.permissionDecisionReason, command).toContain(STRICT);
    }
  });
});

describe('the scanner fixes reach the decision', () => {
  it.each([
    [`trap $'${INSTALL}' EXIT`],
    [`eval $'${INSTALL}'`],
    [`bash -c $'${INSTALL}'`],
    [`$'np\\x6d' install @types/node@26.6.6`],
  ])('denies %s from pkgs/strict ($\'…\', H4)', async (command) => {
    const root = repository();
    expect((await hook(command, join(root, 'pkgs', 'strict'), root)).permissionDecision).toBe('deny');
  });

  it('asks about npm ci --no-ignore-script where install scripts are denied (M1)', async () => {
    const root = repository({ installScripts: { default: 'deny' } });
    for (const command of ['npm ci --no-ignore-script', 'npm ci --no-ign', 'npm install --no-ignore-scrip lodash@4.17.21']) {
      const answer = await hook(command, root, root);
      expect(answer.permissionDecision, command).toBe('ask');
      expect(answer.permissionDecisionReason, command).toContain('lets dependency install scripts run that depcurfew.json restricts');
    }
  });

  it('checks env -C and env --chdir in that directory, and asks about find -execdir and a trap before cd (M2)', async () => {
    const root = repository();
    for (const command of [`env -C pkgs/strict ${INSTALL}`, `env --chdir=pkgs/strict ${INSTALL}`]) {
      expect((await hook(command, root, root)).permissionDecisionReason, command).toContain(STRICT);
    }
    const find = await hook(`find pkgs -name package.json -execdir ${INSTALL} \\;`, root, root);
    expect(find.permissionDecision).toBe('ask');
    expect(find.permissionDecisionReason).toContain(`find -execdir runs "${INSTALL}" in the directory of each file it finds`);
    const trap = await hook(`trap '${INSTALL}' EXIT; cd pkgs/strict`, root, root);
    expect(trap.permissionDecision).toBe('ask');
    expect(trap.permissionDecisionReason).toContain('runs from a trap');
  });

  it.each([['cd pkgs\\strict; npm install @types/node@26.6.6'], ['Set-Location pkgs\\strict; npm install @types/node@26.6.6']])(
    'denies %s in PowerShell, which takes \\ as a separator (V5)',
    async (command) => {
      const root = repository();
      const answer = await hook(command, root, root, 'PowerShell');
      expect(answer.permissionDecision).toBe('deny');
      expect(answer.permissionDecisionReason).toContain(STRICT);
    },
  );

  it('reads an alias that expands itself quickly (H2)', async () => {
    const root = repository();
    const start = performance.now();
    expect(await hook(`alias a='${'a;'.repeat(40)}'; a`, root, root)).toEqual({});
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('an unreadable hook event (V7)', () => {
  it('ends the error with its code', async () => {
    let stderr = '';
    const code = await run(['check', '--hook', 'claude-code'], { stdout: () => undefined, stderr: (text) => (stderr += text) }, {
      fetch: recordedFetch,
      now: () => NOW,
      stdin: async () => 'not json',
      home: () => HOME,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/^error: cannot read the hook event: [^\n]+ \(hook-event-unreadable\)\n {2}fix: Claude Code sends the PreToolUse event/u);
  });
});
