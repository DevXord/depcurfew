// Delays a repository already configures (decision D-075): init keeps the longest, apply warns when it shortens one
// that was set by hand.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configuredDelays, policyDuration } from '../../src/apply/delays.ts';
import { applyProject } from '../../src/apply/index.ts';
import { detectProject } from '../../src/detect/index.ts';
import { Repository } from '../../src/detect/repository.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-delays-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function delays(root: string) {
  return configuredDelays(new Repository(root), detectProject(root), knowledgeBase).map(({ tool, setting, minutes, location, managed }) => ({ tool, setting, minutes, location, managed }));
}

const PNPM10 = '{"name": "app", "packageManager": "pnpm@10.34.9"}\n';

describe('configured delays', () => {
  it('reads npm, Renovate and every Dependabot entry with their lines', () => {
    const root = repo({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      '.npmrc': 'save-exact=true\nmin-release-age=14\n',
      'renovate.json': '{\n  "extends": ["config:recommended"],\n  "minimumReleaseAge": "10 days"\n}\n',
      '.github/dependabot.yml':
        'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 7\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n    cooldown:\n      default-days: 30\n',
    });
    expect(delays(root)).toEqual([
      { tool: 'npm', setting: 'min-release-age', minutes: 14 * 1440, location: { file: '.npmrc', line: 2 }, managed: false },
      { tool: 'renovate', setting: 'minimumReleaseAge', minutes: 10 * 1440, location: { file: 'renovate.json', line: 3 }, managed: false },
      // github-actions is not an ecosystem depcurfew configures.
      { tool: 'dependabot', setting: 'default-days', minutes: 7 * 1440, location: { file: '.github/dependabot.yml', line: 8 }, managed: false },
    ]);
  });

  it('reads pnpm 10 from .npmrc only when pnpm-workspace.yaml does not set the delay', () => {
    const npmrc = { 'package.json': PNPM10, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", '.npmrc': 'minimum-release-age=10080\n' };
    expect(delays(repo(npmrc))).toEqual([{ tool: 'pnpm', setting: 'minimum-release-age', minutes: 10080, location: { file: '.npmrc', line: 1 }, managed: false }]);
    const both = repo({ ...npmrc, 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n' });
    expect(delays(both)).toEqual([{ tool: 'pnpm', setting: 'minimumReleaseAge', minutes: 1440, location: { file: 'pnpm-workspace.yaml', line: 1 }, managed: false }]);
    // pnpm 11 and later ignore the delay in .npmrc.
    const pnpm11 = repo({ ...npmrc, 'package.json': '{"name": "app", "packageManager": "pnpm@11.28.9"}\n' });
    expect(delays(pnpm11)).toEqual([]);
  });

  it('reads Yarn, Bun and Deno in their own units and forms', () => {
    const yarn = repo({ 'package.json': '{"name": "app", "packageManager": "yarn@4.18.1"}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'npmMinimalAgeGate: 7d\n' });
    expect(delays(yarn)).toMatchObject([{ tool: 'yarn', minutes: 10080 }]);
    const bun = repo({ 'package.json': '{"name": "app"}\n', 'bun.lock': '{}\n', 'bunfig.toml': '[install]\nminimumReleaseAge = 604800\n' });
    expect(delays(bun)).toMatchObject([{ tool: 'bun', minutes: 10080, location: { file: 'bunfig.toml', line: 2 } }]);
    const deno = repo({ 'deno.json': '{\n  "minimumDependencyAge": { "age": "P7D", "exclude": ["npm:left-pad"] }\n}\n' });
    expect(delays(deno)).toMatchObject([{ tool: 'deno', minutes: 10080, location: { file: 'deno.json', line: 2 } }]);
  });

  it('reads Python tools, but not a fixed date', () => {
    const uv = repo({ 'pyproject.toml': '[project]\nname = "app"\n\n[tool.uv]\nexclude-newer = "7 days"\n', 'uv.lock': 'version = 1\n' });
    expect(delays(uv)).toMatchObject([{ tool: 'uv', minutes: 10080, location: { file: 'pyproject.toml', line: 5 } }]);
    const date = repo({ 'pyproject.toml': '[project]\nname = "app"\n\n[tool.uv]\nexclude-newer = "2026-01-01T00:00:00Z"\n', 'uv.lock': 'version = 1\n' });
    expect(delays(date)).toEqual([]);
    const poetry = repo({ 'pyproject.toml': '[project]\nname = "app"\n\n[tool.poetry]\npackage-mode = false\n', 'poetry.toml': '[solver]\nmin-release-age = 10\n' });
    expect(delays(poetry)).toMatchObject([{ tool: 'poetry', minutes: 14400, location: { file: 'poetry.toml', line: 2 } }]);
    const pipenv = repo({ Pipfile: '[packages]\nrequests = "*"\n\n[pipenv]\ncool-down-period = "9d"\n' });
    expect(delays(pipenv)).toMatchObject([{ tool: 'pipenv', minutes: 9 * 1440, location: { file: 'Pipfile', line: 5 } }]);
    const pdm = repo({ 'pyproject.toml': '[project]\nname = "app"\n\n[tool.pdm.resolution]\nexclude-newer = "2w"\n', 'pdm.lock': '' });
    expect(delays(pdm)).toMatchObject([{ tool: 'pdm', minutes: 20160 }]);
  });

  it('tells values depcurfew wrote from values set by hand', () => {
    const root = repo({
      'package.json': '{"name": "app", "packageManager": "pnpm@11.28.9"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': '# managed by depcurfew\nminimumReleaseAge: 4320\n',
      '.github/dependabot.yml':
        'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n    # managed by depcurfew\n    cooldown:\n      default-days: 3\n',
    });
    expect(delays(root).map((delay) => delay.managed)).toEqual([true, true]);
    const npm = repo({
      'package.json': '{"name": "app"}\n',
      '.npmrc': '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nmin-release-age=3\n# <<< depcurfew managed block\n',
    });
    expect(delays(npm)).toMatchObject([{ tool: 'npm', managed: true }]);
  });

  it('writes a delay in the syntax of depcurfew.json, rounded up', () => {
    expect(policyDuration(20160)).toBe('14d');
    expect(policyDuration(90)).toBe('90m');
    expect(policyDuration(120)).toBe('2h');
    expect(policyDuration(4320.5)).toBe('4321m');
  });
});

describe('apply and a longer delay set by hand', () => {
  it('warns with the file, the line, both values and the cooldown.minimum that keeps it', () => {
    const root = repo({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      '.npmrc': 'save-exact=true\nmin-release-age=14\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n',
    });
    const report = applyProject(root, { write: false });
    expect(report.warningDetails.filter((warning) => warning.code === 'cooldown-shortened')).toEqual([
      {
        code: 'cooldown-shortened',
        tool: 'npm',
        location: { file: '.npmrc', line: 2 },
        message:
          'npm: min-release-age=14 in .npmrc (line 2) waits 2 weeks, longer than cooldown.minimum "3d" in depcurfew.json; depcurfew apply comments it out and writes min-release-age=3 in its managed block, so npm waits only 3 days',
        fix: 'To keep the longer delay, set cooldown.minimum to "14d" in depcurfew.json and run depcurfew apply again',
      },
    ]);
  });

  it('says nothing when the policy is at least as long, or when depcurfew wrote the value', () => {
    const files = {
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      '.npmrc': 'min-release-age=14\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "2w"}}\n',
    };
    const root = repo(files);
    expect(applyProject(root).warningDetails.map((warning) => warning.code)).not.toContain('cooldown-shortened');
    // The policy is shortened on purpose afterwards: the value inside the block is depcurfew's own.
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    expect(applyProject(root).warningDetails.map((warning) => warning.code)).not.toContain('cooldown-shortened');
    expect(readFileSync(join(root, '.npmrc'), 'utf8')).toContain('min-release-age=3\n');
  });

  it('warns when pnpm-workspace.yaml takes over from a longer delay in the .npmrc of pnpm 10', () => {
    const root = repo({
      'package.json': PNPM10,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.npmrc': 'minimum-release-age=10080\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n',
    });
    const warning = applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === 'cooldown-shortened');
    expect(warning?.message).toBe(
      'pnpm: minimum-release-age=10080 in .npmrc (line 1) waits 1 week, longer than cooldown.minimum "3d" in depcurfew.json; depcurfew apply writes minimumReleaseAge: 4320 to pnpm-workspace.yaml, which pnpm reads first, so pnpm waits only 3 days',
    );
    expect(warning?.location).toEqual({ file: '.npmrc', line: 1 });
  });

  it('keeps doctor quiet afterwards: the repository then follows the policy', () => {
    const root = repo({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      '.npmrc': 'min-release-age=14\n',
      'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}}\n',
    });
    applyProject(root);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });
});
