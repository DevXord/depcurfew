// unreadable-config for a file the process may not read (EACCES). Tests may run as root, which reads any file, so the
// error is injected into node:fs for one path instead of relying on chmod.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';

const fs = vi.hoisted(() => ({ readFileSync: undefined as unknown as typeof import('node:fs').readFileSync }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fs.readFileSync = actual.readFileSync;
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function denied(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', errno: -13, syscall: 'open', path });
}

/** Makes reading every path that ends with `name` fail with EACCES. */
function deny(name: string): void {
  vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
    if (String(path).endsWith(name)) throw denied(String(path));
    return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof readFileSync);
}

const temporary: string[] = [];
afterEach(() => {
  vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-eacces-'));
  temporary.push(root);
  writeFileSync(join(root, 'package.json'), '{ "name": "app", "private": true, "packageManager": "npm@11.19.1" }\n');
  writeFileSync(join(root, 'package-lock.json'), '{ "name": "app", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "app" } } }\n');
  writeFileSync(join(root, '.npmrc'), 'min-release-age=3\n');
  writeFileSync(join(root, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" } }\n');
  return root;
}

describe('a configuration file the process may not read', () => {
  it('is an unreadable-config error instead of a crash', () => {
    const root = repository();
    deny('.npmrc');
    const report = runDoctor(root);
    const findings = report.findings.filter((finding) => finding.rule === 'unreadable-config');
    expect(findings).toEqual([
      {
        rule: 'unreadable-config',
        level: 'error',
        location: { file: '.npmrc' },
        message: 'cannot read .npmrc (EACCES: permission denied); depcurfew cannot check it',
        fix: 'Make the file readable for the user that runs depcurfew, so that depcurfew can check it',
      },
    ]);
    expect(report.notices.some((notice) => notice.message.includes('.npmrc'))).toBe(false);
  });

  it('does not leak the absolute path of the machine', () => {
    const root = repository();
    deny('package.json');
    const report = runDoctor(root);
    expect(JSON.stringify(report)).not.toContain(root);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: 'unreadable-config', location: { file: 'package.json' }, message: 'cannot read package.json (EACCES: permission denied); depcurfew cannot check it' }),
    );
  });
});
