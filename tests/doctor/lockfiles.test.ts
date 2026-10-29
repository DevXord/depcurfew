// Lockfile reading details that the rule fixtures do not cover: name@spec splitting and unsupported versions.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';
import { splitSpec } from '../../src/doctor/lockfiles.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-lockfiles-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(directory, file), text);
  return directory;
}

const POLICY = '{ "version": 1, "sources": { "git": "deny" }, "targets": "auto" }\n';

describe('lockfiles', () => {
  it.each([
    ['esbuild@0.21.5', { name: 'esbuild', spec: '0.21.5' }],
    ['@scope/pkg@1.0.0', { name: '@scope/pkg', spec: '1.0.0' }],
    ['foo@git+ssh://git@github.com/o/r.git#abc', { name: 'foo', spec: 'git+ssh://git@github.com/o/r.git#abc' }],
    ['@s/p@git+https://example.com/p.git#abc', { name: '@s/p', spec: 'git+https://example.com/p.git#abc' }],
  ])('splits %s', (key, expected) => {
    expect(splitSpec(key)).toEqual(expected);
  });

  it('reports an npm lockfile version 1 as not checked', () => {
    const directory = repository({
      'package.json': '{ "name": "x", "packageManager": "npm@12.2.1" }\n',
      'package-lock.json': '{ "name": "x", "lockfileVersion": 1, "dependencies": {} }\n',
      'depcurfew.json': POLICY,
    });
    expect(runDoctor(directory).notices).toContainEqual({
      message: 'lockfile-forbidden-source could not check package-lock.json: it has no "packages" section (lockfileVersion 1 is not read)',
      file: 'package-lock.json',
    });
  });

  it('reports an old pnpm lockfile version as not checked', () => {
    const directory = repository({
      'package.json': '{ "name": "x", "packageManager": "pnpm@11.2.0" }\n',
      'pnpm-lock.yaml': "lockfileVersion: '6.0'\n",
      'depcurfew.json': POLICY,
    });
    expect(runDoctor(directory).notices).toContainEqual({
      message: 'lockfile-forbidden-source could not check pnpm-lock.yaml: its lockfileVersion 6.0 is not read; depcurfew reads 9.0',
      file: 'pnpm-lock.yaml',
    });
  });

  it('reports a lockfile that does not parse as an error of unreadable-config', () => {
    const directory = repository({
      'package.json': '{ "name": "x", "packageManager": "npm@12.2.1" }\n',
      'package-lock.json': '{ "lockfileVersion": 3, ',
      'depcurfew.json': POLICY,
    });
    const report = runDoctor(directory);
    const findings = report.findings.filter((item) => item.rule === 'unreadable-config');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'error', location: { file: 'package-lock.json' } });
    expect(findings[0]?.message).toMatch(/^cannot parse package-lock\.json: .+; depcurfew cannot check it$/u);
    expect(report.notices.some((item) => item.file === 'package-lock.json')).toBe(false);
  });
});
