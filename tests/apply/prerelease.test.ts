// A pinned prerelease (npm@11.0.0-pre.1, pnpm@10.26.0-rc.1) is a version that comes before its release, as in semver
// and in manager-version-too-old: apply and every doctor rule read it with the same function, instead of apply taking
// it for no pinned version and configuring for the latest release.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyProject } from '../../src/apply/index.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion } from '../../src/apply/version.ts';
import { detectProject } from '../../src/detect/index.ts';
import { lowestVersion } from '../../src/doctor/version-range.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(packageManager: string, policy: object): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-prerelease-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'app', private: true, packageManager }));
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return directory;
}

describe('parseVersion and compareVersions', () => {
  it('reads a prerelease and ignores build metadata', () => {
    expect(parseVersion('11.0.0-pre.1')).toEqual([11, 0, 0, 'pre.1']);
    expect(parseVersion('v4.10.2-rc.1+sha.5')).toEqual([4, 10, 2, 'rc.1']);
    expect(parseVersion('10.16.0+build.5')).toEqual([10, 16, 0]);
    expect(parseVersion('2025-07-01')).toBeUndefined();
    expect(parseVersion('^11.0.0')).toBeUndefined();
    expect(formatVersion([11, 0, 0, 'pre.1'])).toBe('11.0.0-pre.1');
    expect(formatVersion([11, 0, 0])).toBe('11.0.0');
  });

  it('orders a prerelease before its release and prereleases as semver does', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1-0', '1.0.1'];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort((a, b) => compareVersions(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0]))).toEqual(ordered);
    expect(compareVersions([11, 10, 0, 'rc.1'], [11, 9, 9])).toBeGreaterThan(0);
  });

  it('gives the same order as manager-version-too-old reads ranges', () => {
    const exact = lowestVersion('11.0.0-pre.1');
    expect(exact).toEqual({ kind: 'exact', version: [11, 0, 0], prerelease: 'pre.1' });
    expect(parseVersion('11.0.0-pre.1')).toEqual([11, 0, 0, 'pre.1']);
  });

  it('takes a pinned prerelease as the pinned version', () => {
    const manager = detectProject(project('pnpm@10.26.0-rc.1', {})).packageManagers.find((entry) => entry.id === 'pnpm');
    expect(manager === undefined ? undefined : pinnedVersion(manager)).toEqual([10, 26, 0, 'rc.1']);
  });
});

describe('apply with a pinned prerelease', () => {
  const policy = { cooldown: { minimum: '3d' }, installScripts: { default: 'deny' } };
  const codes = (directory: string) => applyProject(directory, { write: false }).warningDetails.map((warning) => warning.code);

  it('configures npm 11.0.0-pre.1 as a version before 11.0.0, not as the latest npm', () => {
    const pre = applyProject(project('npm@11.0.0-pre.1', policy), { write: false });
    expect(pre.warningDetails.map((warning) => warning.code)).not.toContain('version-not-pinned');
    expect(pre.warningDetails.map((warning) => warning.code)).toEqual(codes(project('npm@11.0.0', policy)));
    expect(pre.warningDetails.find((warning) => warning.code === 'scripts-not-enforceable')?.message).toContain('npm 11.0.0-pre.1');
  });

  it('writes no pnpm 11 setting for pnpm 10.26.0-rc.1', () => {
    const report = applyProject(project('pnpm@10.26.0-rc.1', policy), { write: false });
    const written = report.changes.map((change) => change.after).join('\n');
    expect(written).toContain('minimumReleaseAge');
    expect(written).not.toContain('minimumReleaseAgeStrict');
    expect(report.warningDetails.map((warning) => warning.code)).not.toContain('version-not-pinned');
  });
});
