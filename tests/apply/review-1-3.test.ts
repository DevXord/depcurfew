// apply and the npm a repository runs without a pinned npm (decision D-105): the npm of the declared Node.js versions,
// the npm CI jobs and Dockerfiles install, and root CI jobs that install in a project's directory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICY = { version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, targets: 'auto' };

function repository(files: Record<string, string>, policy: object = POLICY): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-apply-review-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries({ ...files, 'depcurfew.json': `${JSON.stringify(policy, null, 2)}\n` })) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

const PACKAGE = '{\n  "name": "app",\n  "private": true\n}\n';
const LOCK = '{ "name": "app", "lockfileVersion": 3, "requires": true, "packages": {} }\n';

describe('npm without a pin', () => {
  it('writes no strict-allow-scripts for npm 10 and says that it cannot block scripts', () => {
    const directory = repository({ 'package.json': PACKAGE, 'package-lock.json': LOCK, '.nvmrc': '22.11.0\n' });
    const report = applyProject(directory, { write: true });
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).not.toContain('strict-allow-scripts');
    expect(report.warningDetails.filter((warning) => warning.code === 'scripts-not-enforceable')).toEqual([
      {
        code: 'scripts-not-enforceable',
        tool: 'npm',
        location: { file: '.nvmrc', line: 1 },
        message: 'npm 10.9.0 (which Node.js 22.11.0 in .nvmrc comes with) runs every dependency install script and has no allow-list, so "deny" cannot be enforced there',
        fix: 'Install npm 11.16.0 or later before packages are installed there (npm install -g npm@11.16.0), or move to a Node.js release that comes with it; npm 12 blocks dependency scripts by default',
      },
    ]);
  });

  it('configures for the pinned npm alone', () => {
    const directory = repository({ 'package.json': '{\n  "name": "app",\n  "private": true,\n  "packageManager": "npm@12.2.1"\n}\n', 'package-lock.json': LOCK, '.nvmrc': '24.18.0\n' });
    const report = applyProject(directory, { write: true });
    expect(readFileSync(join(directory, '.npmrc'), 'utf8')).not.toContain('strict-allow-scripts');
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('strict-allow-scripts-from-node');
  });
});

describe('root CI jobs that install in a project (tarball test 2)', () => {
  it('count for the npm of the project, in apply and in doctor', () => {
    const workflow = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22.11.0\n      - run: npm ci\n        working-directory: frontend\n';
    const directory = repository({ 'frontend/package.json': PACKAGE, 'frontend/package-lock.json': LOCK, '.github/workflows/ci.yml': workflow }, { ...POLICY, projects: ['frontend'] });
    const report = applyProject(directory, { write: true });
    expect(report.warningDetails.filter((warning) => warning.code === 'scripts-not-enforceable')).toEqual([
      expect.objectContaining({
        project: 'frontend',
        message: 'frontend: npm 10.9.0 (which Node.js 22.11.0 in GitHub Actions (.github/workflows/ci.yml, job build) comes with) runs every dependency install script and has no allow-list, so "deny" cannot be enforced there',
      }),
    ]);
    // Node.js 22.11.0 of the job is no npm 22.11.0 that the job installs.
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('strict-allow-scripts-from-node');
    const doctor = runDoctor(directory);
    expect(doctor.findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
    expect(doctor.findings.filter((finding) => finding.rule === 'manager-version-too-old').map((finding) => [finding.location, finding.level])).toEqual([[{ file: '.github/workflows/ci.yml', line: 8 }, 'error']]);
  });
});
