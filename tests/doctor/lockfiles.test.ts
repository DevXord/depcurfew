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

  it('marks only the copy a package declares with a URL, found the way Node resolves it', () => {
    const url = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
    const lock = {
      name: 'x',
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', dependencies: { a: '1.0.0', b: '1.0.0' } },
        'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', dependencies: { 'left-pad': url } },
        'node_modules/a/node_modules/left-pad': { version: '1.3.0', resolved: url },
        'node_modules/b': { version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz', dependencies: { 'left-pad': '^1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0', resolved: url },
      },
    };
    const text = `${JSON.stringify(lock, null, 2)}\n`;
    const directory = repository({
      'package.json': '{ "name": "x", "packageManager": "npm@11.21.1" }\n',
      'package-lock.json': text,
      'depcurfew.json': '{ "version": 1, "sources": { "remoteTarball": "deny" }, "targets": "auto" }\n',
    });
    const nested = text.split('\n').findIndex((line) => line.includes('"node_modules/a/node_modules/left-pad": {')) + 1;
    const findings = runDoctor(directory).findings.filter((finding) => finding.rule === 'lockfile-forbidden-source');
    // b reaches the hoisted left-pad through a range, so only a's own copy comes from the URL.
    expect(findings.map((finding) => finding.location.line)).toEqual([nested]);
    expect(findings[0]?.message).toContain('installs left-pad from a tarball URL');
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
