// Tarball URLs of private npm registries in package-lock.json (decision D-168): GitHub Packages
// (/download/@scope/name/<version>/<sha256>), GitLab and Artifactory (…/@scope/name/-/@scope/name-<version>.tgz), and
// any tarball below the registry the project's .npmrc sets for the package, which npm 12 installs as a registry
// package too (allow-remote: "Tarballs that share a hostname with the configured registry ... are still installed
// normally"). They are registry packages, known-malicious checks the version their URL names, and an entry whose
// package.json asks for it by version is never told to weaken the policy.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor/index.ts';
import { runDoctorWithOsv } from '../../src/doctor/osv.ts';
import { osvFetch } from '../support/osv.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/doctor/lockfile-forbidden-source/', import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function copy(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d168-tarballs-'));
  temporary.push(directory);
  cpSync(join(FIXTURES, name, 'repo'), directory, { recursive: true });
  return directory;
}

describe('tarballs of private npm registries', () => {
  it('are registry packages, whose name and version known-malicious reads from the URL', async () => {
    const root = copy('passes-npm-private-registries');
    const fetch = osvFetch();
    const report = await runDoctorWithOsv(root, {}, { fetch });
    expect(report.findings.filter((finding) => finding.rule === 'lockfile-forbidden-source')).toEqual([]);
    const asked = fetch.requests.flat().map((query) => `${query.package.name}@${query.version}`).sort();
    expect(asked).toEqual(['@acme/ui@3.2.1', '@jf/widget@2.1.0', '@lab/kit@1.4.0']);
    // The entries in a layout of the registry's own say which version they are not: they are not checked, as for npm.
    expect(report.findings.filter((finding) => finding.rule === 'known-malicious').map((finding) => finding.message)).toEqual([
      'known-malicious could not check 2 registry packages of package-lock.json, whose entries give no exact version that npm installs: @corp/tool (line 33) and left-pad (line 38)',
    ]);
  });

  it('report a version field that is not the version of the URL', async () => {
    const root = copy('passes-npm-private-registries');
    const lockfile = join(root, 'package-lock.json');
    writeFileSync(lockfile, readFileSync(lockfile, 'utf8').replace('"version": "3.2.1"', '"version": "3.2.0"'));
    const report = await runDoctorWithOsv(root, {}, { fetch: osvFetch() });
    expect(report.findings.find((finding) => finding.rule === 'known-malicious' && finding.message.includes('@acme/ui'))?.message).toContain(
      'package-lock.json has node_modules/@acme/ui as @acme/ui@3.2.0, but its resolved URL is the registry tarball of @acme/ui@3.2.1',
    );
  });

  it('on GitHub Packages, only on its host, and below the registry of .npmrc only at its origin and path', () => {
    const root = copy('passes-npm-private-registries');
    const lockfile = join(root, 'package-lock.json');
    const text = readFileSync(lockfile, 'utf8')
      .replace('https://npm.pkg.github.com/download/', 'https://npm.evil.example/download/')
      .replace('https://pkgs.corp.example/npm/blobs/', 'https://pkgs.corp.example/other/blobs/');
    writeFileSync(lockfile, text);
    const messages = runDoctor(root)
      .findings.filter((finding) => finding.rule === 'lockfile-forbidden-source')
      .map((finding) => finding.message);
    expect(messages).toEqual([
      'package-lock.json installs @acme/ui from a tarball URL (https://npm.evil.example/download/@acme/ui/3.2.1/5f1c0ab2e6f7d3c1a9b0e2f4d6c8a0b2c4d6e8f0a1b2c3d4e5f60718293a4b5c), which depcurfew.json denies',
      'package-lock.json installs @corp/tool from a tarball URL (https://pkgs.corp.example/other/blobs/sha256/7f3a9c0d), which depcurfew.json denies',
    ]);
  });
});
