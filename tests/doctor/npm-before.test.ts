// npmrc-overrides-policy and before= dates that depend on today's date, which the fixtures cannot pin.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(npm: string, npmrc: string, policy?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-before-'));
  temporary.push(root);
  writeFileSync(join(root, 'package.json'), `{ "name": "app", "private": true, "packageManager": "npm@${npm}" }\n`);
  writeFileSync(join(root, 'package-lock.json'), '{ "name": "app", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "app" } } }\n');
  writeFileSync(join(root, '.npmrc'), npmrc);
  if (policy !== undefined) writeFileSync(join(root, 'depcurfew.json'), policy);
  return root;
}

const findings = (root: string) => runDoctor(root).findings.filter((finding) => finding.rule === 'npmrc-overrides-policy');

describe('before= in .npmrc', () => {
  it('is an error when the date is more recent than the delay', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
    const root = repository('12.2.1', 'min-release-age=3\nbefore=2026-10-29\n');
    expect(findings(root)).toEqual([
      {
        rule: 'npmrc-overrides-policy',
        level: 'error',
        location: { file: '.npmrc', line: 2 },
        message: 'before=2026-10-29 in .npmrc takes the place of min-release-age (npm 12.2.1 uses before when both are set in the same file), so npm installs versions published up to 2026-10-29, less than 3 days ago',
        fix: 'Remove the before line from .npmrc, so that min-release-age applies',
      },
    ]);
  });

  it('compares with the policy delay when there is a policy', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
    const root = repository('12.2.1', 'before=2026-10-20\n', '{ "version": 1, "cooldown": { "minimum": "2w" } }\n');
    expect(findings(root).map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: 'error',
        message: 'before=2026-10-20 in .npmrc takes the place of min-release-age (npm 12.2.1 uses before when both are set in the same file), so npm installs versions published up to 2026-10-20, less than 2 weeks ago',
      },
    ]);
  });

  it('is left to config-drift in npm 11.10 to 11.14 until min-release-age is written', () => {
    const root = repository('11.12.0', 'before=2026-01-01\n', '{ "version": 1, "cooldown": { "minimum": "3d" } }\n');
    expect(findings(root)).toEqual([]);
  });

  it('is not checked before npm 11.10, which has no min-release-age', () => {
    const root = repository('11.9.0', 'min-release-age=3\nbefore=2099-01-01\n');
    expect(findings(root)).toEqual([]);
  });
});
