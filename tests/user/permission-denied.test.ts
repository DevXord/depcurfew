// init, apply and doctor --user when the process may not look at a path (EACCES). Tests may run as root, which reads
// any file, so the error is injected into node:fs for one path instead of relying on chmod.
import { lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, shownPolicy, shownUserFile, userFileOf } from '../support/user.ts';

const fs = vi.hoisted(() => ({
  openSync: undefined as unknown as typeof import('node:fs').openSync,
  lstatSync: undefined as unknown as typeof import('node:fs').lstatSync,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fs.openSync = actual.openSync;
  fs.lstatSync = actual.lstatSync;
  return { ...actual, openSync: vi.fn(actual.openSync), lstatSync: vi.fn(actual.lstatSync) };
});

const temporary: string[] = [];
afterEach(() => {
  vi.mocked(openSync).mockImplementation(fs.openSync);
  vi.mocked(lstatSync).mockImplementation(fs.lstatSync);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const denied = (path: string) => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', errno: -13, syscall: 'open', path });

/** Every call of `name` on `path` fails with EACCES; others go to node:fs. */
function deny(name: 'openSync' | 'lstatSync', path: string): void {
  const original = fs[name] as (...args: unknown[]) => unknown;
  (vi.mocked(name === 'openSync' ? openSync : lstatSync) as unknown as { mockImplementation: (f: (...args: unknown[]) => unknown) => void }).mockImplementation((...args: unknown[]) => {
    if (String(args[0]) === path) throw denied(path);
    return original(...args);
  });
}

async function exec(environment: UserEnvironment, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-10-31T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    userEnvironment: () => environment,
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

function withPolicy(environment: UserEnvironment): void {
  const path = userPolicyPath(environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] } }));
}

describe('init --user', () => {
  it('reports a user policy it may not look at as an error with a fix, not a crash', async () => {
    const environment = fakeMachine({}, temporary);
    deny('lstatSync', userPolicyPath(environment));
    const result = await exec(environment, 'init', '--user');
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).not.toContain('unexpected error');
    expect(result.stderr).toBe(
      `error: cannot look at ${shownPolicy(environment)}: permission denied (cannot-write)\n  fix: Make sure the user running depcurfew may open the directories on the way to ${shownPolicy(environment)}, then run depcurfew init --user again\n`,
    );
  });
});

describe('a user file the process may not read', () => {
  const PIP = { pip: '26.1' };

  it('apply --user says to make it readable, naming the file', async () => {
    const environment = fakeMachine({ python: PIP }, temporary);
    withPolicy(environment);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[global]\n');
    deny('openSync', path);
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const result = await exec(environment, 'apply', '--user', '--json');
    const document = JSON.parse(result.stdout) as { errors: { code: string; message: string; fix: string }[] };
    expect(document.errors).toEqual([
      {
        code: 'cannot-edit',
        level: 'error',
        tool: 'pip',
        location: { file: shown },
        message: `pip: cannot edit ${shown}: ${shown} cannot be read: permission denied`,
        fix: `Make ${shown} readable and writable for the user that runs depcurfew, then run depcurfew apply --user again`,
      },
    ]);
  });

  it('doctor --user next to a user policy gives the same fix', () => {
    const environment = fakeMachine({ python: PIP }, temporary);
    withPolicy(environment);
    const path = userFileOf('pip', environment, [26, 1, 0]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[global]\n');
    deny('openSync', path);
    const shown = shownUserFile('pip', environment, [26, 1, 0]);
    const findings = runUserDoctor({ environment }).findings.filter((finding) => finding.rule === 'user-config-unreadable');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix).toBe(`Make ${shown} readable and writable for the user that runs depcurfew, then run depcurfew apply --user again`);
  });
});
