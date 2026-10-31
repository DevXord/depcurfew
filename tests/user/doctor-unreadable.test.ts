// doctor --user for a user file the process may not read (EACCES), and keys whose values are credentials. Tests may
// run as root, which reads any file, so the error is injected into node:fs for one path instead of relying on chmod.
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolKnowledge } from '../../src/knowledge/types.ts';
import { runUserDoctor } from '../../src/user/doctor.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { platform } from '../support/user.ts';

const fs = vi.hoisted(() => ({ openSync: undefined as unknown as typeof import('node:fs').openSync }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fs.openSync = actual.openSync;
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const temporary: string[] = [];
afterEach(() => {
  vi.mocked(openSync).mockImplementation(fs.openSync);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** npm 11.21.1 as a shim with its package next to it, no user policy, and a ~/.npmrc. */
function machine(npmrc: string): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-eacces-'));
  temporary.push(root);
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'bin', 'node_modules', 'npm'), { recursive: true });
  writeFileSync(join(root, 'bin', 'npm'), '#!/bin/sh\n');
  writeFileSync(join(root, 'bin', 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '11.21.1', bin: { npm: 'bin/npm-cli.js' } }));
  writeFileSync(join(root, 'home', '.npmrc'), npmrc);
  return { platform, home: join(root, 'home'), env: { PATH: join(root, 'bin') } };
}

describe('doctor --user', () => {
  it('reports a user file it may not read as an error instead of passing', () => {
    const environment = machine('dangerously-allow-all-scripts=true\n');
    const denied = join(environment.home, '.npmrc');
    vi.mocked(openSync).mockImplementation(((path: Parameters<typeof openSync>[0], ...rest: unknown[]) => {
      if (String(path) === denied) throw Object.assign(new Error(`EACCES: permission denied, open '${denied}'`), { code: 'EACCES' });
      return (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof openSync);
    expect(runUserDoctor({ environment }).findings).toEqual([
      {
        rule: 'user-config-unreadable',
        level: 'error',
        location: { file: '~/.npmrc' },
        message: '~/.npmrc cannot be read (EACCES), so depcurfew cannot check it',
        fix: 'Make ~/.npmrc readable for the user that runs depcurfew; npm may read it',
      },
    ]);
  });

  it('never prints the value of a credential key', () => {
    const environment = machine('//registry.example.com/:_authToken=npm_SECRET\n');
    const npm = knowledgeBase.find((tool) => tool.id === 'npm') as ToolKnowledge;
    const user = npm.user as NonNullable<ToolKnowledge['user']>;
    const weakening = { ...user.weakening, value: [{ key: '//registry.example.com/:_authToken', values: 'any', effect: 'sends a token' }] } as typeof user.weakening;
    const tools = [{ ...npm, user: { ...user, weakening } }];
    const [finding] = runUserDoctor({ environment, tools }).findings;
    expect(finding?.message).toContain('//registry.example.com/:_authToken in ~/.npmrc (npm) sends a token');
    expect(JSON.stringify(finding)).not.toContain('npm_SECRET');
  });
});
