// Packages whose install scripts depcurfew knows (decision D-127): apply warns, with the text and places of doctor,
// when a denied package that takes its binary from an optional dependency (esbuild) meets npm leaving optional
// dependencies out. apply needs no lockfile for that: the denial in the policy is enough.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const FIXTURES = fileURLToPath(new URL('../fixtures/doctor/lockfile-install-scripts/', import.meta.url));

function project(files: Record<string, string>, deny: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-optional-'));
  temporary.push(directory);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, installScripts: { default: 'deny', allow: [], deny }, targets: 'auto' }));
  return directory;
}

const optionalWarnings = (directory: string) => applyProject(directory, { write: false }).warningDetails.filter((warning) => warning.code === 'deny-needs-optional-dependencies');

describe('deny-needs-optional-dependencies', () => {
  it('says what doctor says, at the same places', () => {
    const repo = join(FIXTURES, 'fires-denied-esbuild-omit-optional', 'repo');
    const fromDoctor = runDoctor(repo).findings.filter((finding) => finding.rule === 'lockfile-install-scripts');
    const fromApply = optionalWarnings(repo);
    expect(fromApply.map(({ location, message, fix }) => ({ location, message, fix }))).toEqual(
      fromDoctor.map(({ location, message, fix }) => ({ location, message, fix })).sort((a, b) => (a.location?.file === '.npmrc' ? -1 : b.location?.file === '.npmrc' ? 1 : 0)),
    );
    expect(fromApply.every((warning) => warning.tool === 'npm')).toBe(true);
  });

  it('warns for a pattern of installScripts.deny that covers esbuild, and for optional=false', () => {
    const directory = project({ 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n', '.npmrc': 'optional=false\n' }, ['esb*']);
    expect(optionalWarnings(directory).map((warning) => [warning.location, warning.message])).toEqual([
      [{ file: '.npmrc', line: 1 }, 'esbuild is in installScripts.deny, so it can take its binary only from its optional dependencies, but optional=false in .npmrc (line 1) leaves them out, so esbuild cannot find its binary after such an install'],
    ]);
  });

  it('reads omit[] lists, and keeps quiet when include=optional keeps them or the denied package needs none', () => {
    const npm = { 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n' };
    expect(optionalWarnings(project({ ...npm, '.npmrc': 'omit[]=dev\nomit[]=optional\n' }, ['esbuild'])).map((warning) => warning.location)).toEqual([{ file: '.npmrc', line: 2 }]);
    expect(optionalWarnings(project({ ...npm, '.npmrc': 'omit=optional\ninclude=optional\n' }, ['esbuild']))).toEqual([]);
    expect(optionalWarnings(project({ ...npm, '.npmrc': 'omit=dev\n' }, ['esbuild']))).toEqual([]);
    expect(optionalWarnings(project({ ...npm, '.npmrc': 'omit=optional\n' }, ['fsevents']))).toEqual([]);
  });

  it('finds a Dockerfile install that leaves them out with NPM_CONFIG_OMIT', () => {
    const directory = project(
      {
        'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n',
        Dockerfile: 'FROM debian:13\nENV NPM_CONFIG_OMIT=optional\nRUN npm ci\n',
      },
      ['esbuild'],
    );
    expect(optionalWarnings(directory).map((warning) => [warning.location, warning.fix])).toEqual([
      [
        { file: 'Dockerfile', line: 3 },
        'Remove --omit=optional, --no-optional, npm_config_omit=optional and npm_config_optional=false from that install, or add --include=optional to it; or move esbuild from installScripts.deny to installScripts.allow in depcurfew.json after reviewing its install script',
      ],
    ]);
  });
});
