// doctor after the 1.3.0 review (decision D-105): notices instead of a silent "passed" for versions it cannot read,
// large matrices in bounded time, and the tester's repository (tests/fixtures/repos/node-npm-scripts) after apply.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-doctor-review-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

const PACKAGE = '{ "name": "app", "private": true }\n';
const LOCK = '{ "name": "app", "lockfileVersion": 3, "requires": true, "packages": {} }\n';
const POLICY = '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": "auto" }\n';

function setupNodeSteps(count: number, version: string): string {
  return Array.from({ length: count }, () => `      - uses: actions/setup-node@v4\n        with:\n          node-version: ${version}\n      - run: npm ci\n`).join('');
}

describe('runtime-end-of-life notices', () => {
  it('says which versions it cannot read instead of passing them in silence', () => {
    const directory = repository({
      'package.json': PACKAGE,
      'package-lock.json': LOCK,
      '.nvmrc': 'lts/-9\n',
      Dockerfile: 'FROM node:something-new\nRUN npm ci\n',
    });
    const report = runDoctor(directory, { policy: null });
    expect(report.findings.filter((finding) => finding.rule === 'runtime-end-of-life')).toEqual([]);
    expect(report.notices).toEqual(
      expect.arrayContaining([
        { message: 'runtime-end-of-life cannot tell whether Node.js lts/-9 in .nvmrc is past its end of life: it is not a version or a range depcurfew can read', file: '.nvmrc' },
        { message: 'runtime-end-of-life cannot tell whether Node.js (node:something-new) in Dockerfile is past its end of life: depcurfew does not know the tag something-new', file: 'Dockerfile' },
      ]),
    );
  });
});

describe('large matrices', () => {
  it('checks at most 256 values of a matrix key and says so, in bounded time (2000 values x 150 setup steps)', () => {
    const values = Array.from({ length: 2000 }, (_, index) => `"18.${index}.0"`).join(', ');
    const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [${values}]\n    steps:\n${setupNodeSteps(150, '${{ matrix.node }}')}`;
    const directory = repository({ 'depcurfew.json': POLICY, 'package.json': PACKAGE, 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow });
    const start = performance.now();
    const report = runDoctor(directory);
    expect(performance.now() - start).toBeLessThan(20_000);
    const reason = 'the matrix lists more than 256 values for node, which depcurfew does not check';
    expect(report.notices.map((notice) => notice.message)).toEqual(
      expect.arrayContaining([
        `manager-version-too-old cannot tell which npm or pip comes with Node.js \${{ matrix.node }} (matrix.node) in GitHub Actions (.github/workflows/ci.yml, job test): ${reason}`,
        `runtime-end-of-life cannot tell whether Node.js \${{ matrix.node }} (matrix.node) in GitHub Actions (.github/workflows/ci.yml, job test) is past its end of life: ${reason}`,
      ]),
    );
  });

  it('checks 200 values x 200 setup steps in bounded time', () => {
    const values = Array.from({ length: 200 }, (_, index) => `"22.${index}.0"`).join(', ');
    const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [${values}]\n    steps:\n${setupNodeSteps(200, '${{ matrix.node }}')}`;
    const directory = repository({ 'depcurfew.json': POLICY, 'package.json': PACKAGE, 'package-lock.json': LOCK, '.github/workflows/ci.yml': workflow });
    const start = performance.now();
    const report = runDoctor(directory);
    expect(performance.now() - start).toBeLessThan(20_000);
    expect(report.findings.some((finding) => finding.rule === 'manager-version-too-old')).toBe(true);
  });
});

describe('the npm the declared Node.js brings, after following doctor and apply (tarball test 1)', () => {
  it('reports the npm of the Dockerfile that cannot block scripts, and the scripts it runs, until it is replaced', () => {
    const fixture = fileURLToPath(new URL('../fixtures/repos/node-npm-scripts/', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-node-npm-'));
    temporary.push(directory);
    cpSync(fixture, directory, { recursive: true });
    writeFileSync(join(directory, 'depcurfew.json'), readFileSync(new URL('../fixtures/expected/node-npm-scripts/depcurfew.json', import.meta.url), 'utf8'));
    applyProject(directory, { write: true });
    expect(readFileSync(join(directory, 'frontend/.npmrc'), 'utf8')).toContain('strict-allow-scripts=true\n');
    const after = runDoctor(directory);
    expect(after.findings.map((finding) => [finding.rule, finding.location.file, finding.message])).toEqual([
      ['manager-version-too-old', 'frontend/Dockerfile', 'npm 11.15.0 in frontend/Dockerfile (frontend/Dockerfile) does not support strict-allow-scripts (since 11.16.0)'],
      ['lockfile-install-scripts', 'frontend/package-lock.json', 'core-js has install scripts and npm runs them by default, but depcurfew.json does not allow it'],
    ]);
    // Following the fix: npm 11.16.0 in the Dockerfile reads strict-allow-scripts, so the script no longer runs.
    const dockerfile = join(directory, 'frontend/Dockerfile');
    writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace('npm@11.15.0', 'npm@11.16.0'));
    expect(applyProject(directory, { write: true }).changes).toEqual([]);
    const fixed = runDoctor(directory);
    expect(fixed.findings.map((finding) => [finding.rule, finding.level, finding.message])).toEqual([
      ['lockfile-install-scripts', 'warning', 'core-js has install scripts that npm will not run because strict-allow-scripts in frontend/.npmrc stops the install until they are allowed; the package may need them'],
    ]);
  });
});
