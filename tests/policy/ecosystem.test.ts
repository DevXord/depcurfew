// Policy names per registry (decision D-065): npm tools see names without a prefix, Python tools the pypi: names.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { applyProject } from '../../src/apply/index.ts';
import { policyFor } from '../../src/policy/ecosystem.ts';
import { ecosystemOf, patternsFor } from '../../src/policy/package-pattern.ts';
import { parsePolicy } from '../../src/policy/validate.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-ecosystem-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe('package names per registry', () => {
  it('tells the registry of a pattern by its prefix', () => {
    expect(ecosystemOf('esbuild')).toBe('npm');
    expect(ecosystemOf('@acme/*')).toBe('npm');
    expect(ecosystemOf('pypi:docopt')).toBe('pypi');
    expect(patternsFor(['esbuild', 'pypi:docopt', '@acme/*', 'pypi:acme-*'], 'npm')).toEqual(['esbuild', '@acme/*']);
    expect(patternsFor(['esbuild', 'pypi:docopt', '@acme/*', 'pypi:acme-*'], 'pypi')).toEqual(['docopt', 'acme-*']);
  });

  it('gives each registry its own view of the lists and leaves the rest alone', () => {
    const parsed = parsePolicy(
      JSON.stringify({
        version: 1,
        cooldown: { minimum: '3d', exclude: ['@acme/*', 'pypi:acme-lib'] },
        installScripts: { default: 'deny', allow: ['esbuild', 'pypi:docopt'] },
        sources: { git: 'deny' },
      }),
    );
    if (!parsed.ok) throw new Error('invalid policy');
    const npm = policyFor(parsed.policy, 'npm');
    const pypi = policyFor(parsed.policy, 'pypi');
    expect([npm.cooldown?.exclude, npm.installScripts?.allow]).toEqual([['@acme/*'], ['esbuild']]);
    expect([pypi.cooldown?.exclude, pypi.installScripts?.allow]).toEqual([['acme-lib'], ['docopt']]);
    expect([npm.sources, pypi.sources, pypi.cooldown?.minimum]).toEqual([{ git: 'deny' }, { git: 'deny' }, parsed.policy.cooldown?.minimum]);
  });

  it('keeps pypi: names out of npm configuration', () => {
    const root = project({
      'package.json': '{"name": "app", "packageManager": "pnpm@10.18.0"}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'depcurfew.json': JSON.stringify({
        version: 1,
        cooldown: { minimum: '1d', exclude: ['@acme/*', 'pypi:acme-lib'] },
        installScripts: { default: 'deny', allow: ['esbuild', 'pypi:docopt'] },
      }),
    });
    expect(applyProject(root).errors).toEqual([]);
    const written = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(written).toContain('@acme/*');
    expect(written).toContain('esbuild');
    expect(written).not.toMatch(/acme-lib|docopt|pypi/u);
  });

  it('gives Renovate a separate rule for Python packages and keeps the npm rule as it was', () => {
    const root = project({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      'renovate.json': '{}\n',
      'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d', exclude: ['@acme/*', 'pypi:acme-lib'] } }),
    });
    expect(applyProject(root).errors).toEqual([]);
    const config = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')) as { packageRules: unknown[] };
    expect(config.packageRules).toEqual([
      { description: 'depcurfew: packages excluded from minimumReleaseAge', matchPackageNames: ['@acme/*'], minimumReleaseAge: null },
      {
        description: 'depcurfew: Python packages excluded from minimumReleaseAge',
        matchDatasources: ['pypi'],
        matchPackageNames: ['acme-lib'],
        minimumReleaseAge: null,
      },
    ]);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('keeps npm exceptions away from Python packages in Renovate when the repository has Python', () => {
    const root = project({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      'pyproject.toml': '[project]\nname = "app"\nversion = "0.1.0"\n\n[tool.uv]\nrequired-version = "==0.13.6"\n',
      'uv.lock': 'version = 1\nrevision = 5\nrequires-python = ">=3.12"\n',
      'renovate.json': '{}\n',
      'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d', exclude: ['six'] } }),
    });
    expect(applyProject(root).errors).toEqual([]);
    const config = JSON.parse(readFileSync(join(root, 'renovate.json'), 'utf8')) as { packageRules: unknown[] };
    expect(config.packageRules).toEqual([
      { description: 'depcurfew: packages excluded from minimumReleaseAge', matchDatasources: ['!pypi'], matchPackageNames: ['six'], minimumReleaseAge: null },
    ]);
    expect(applyProject(root).changes).toEqual([]);
  });

  it('gives each Dependabot entry the exclusions of its registry', () => {
    const root = project({
      'package.json': '{"name": "app", "packageManager": "npm@11.19.1"}\n',
      '.github/dependabot.yml': [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: "/"',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: uv',
        '    directory: "/"',
        '    schedule:',
        '      interval: weekly',
        '',
      ].join('\n'),
      'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '3d', exclude: ['@acme/*', 'pypi:acme-lib'] } }),
    });
    expect(applyProject(root).errors).toEqual([]);
    const written = parseYaml(readFileSync(join(root, '.github/dependabot.yml'), 'utf8')) as { updates: { cooldown: unknown }[] };
    expect(written.updates.map((entry) => entry.cooldown)).toEqual([
      { 'default-days': 3, exclude: ['@acme/*'] },
      { 'default-days': 3, exclude: ['acme-lib'] },
    ]);
  });
});
