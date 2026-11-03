// A scope that the .npmrc depcurfew takes assigns to another registry (decision D-168): the finding names the file
// and the line and the registry depcurfew asks (not "the public registry", also with --registry), and says how to have
// depcurfew check the package there; with --registry naming that registry, the package is looked up there.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentFix, UNREAD_REGISTRY_IS_THE_USERS } from '../../src/check/hook.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `depcurfew-d168-scope-${prefix}-`));
  temporary.push(path);
  return path;
}

function project(npmrc: string): string {
  const root = directory('project');
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
  writeFileSync(join(root, 'package.json'), '{"name":"root","private":true}');
  writeFileSync(join(root, '.npmrc'), npmrc);
  return root;
}

function recording(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string, init: Parameters<FetchLike>[1]) => {
    urls.push(url);
    return recordedFetch(url, init);
  }) as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

interface Finding {
  code: string;
  message: string;
  fix: string;
}

async function check(argv: string[], fetch: FetchLike, home = directory('home'), env: Record<string, string> = {}): Promise<Finding[][]> {
  let stdout = '';
  await run(['check', '--json', ...argv], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch,
    now: () => NOW,
    stdin: async () => '',
    home: () => home,
    projectDir: () => undefined,
    osvData: () => undefined,
    userEnvironment: () => ({ platform: process.platform, home, env }),
  });
  return (JSON.parse(stdout) as { packages: { findings: Finding[] }[] }).packages.map((entry) => entry.findings);
}

describe('a scope registry of the .npmrc that depcurfew takes', () => {
  it('names the file, the line and the registry depcurfew asks, and how to have depcurfew check the package', async () => {
    const root = project('# GitHub Packages\n@acme:registry=https://npm.pkg.github.com\n');
    const fetch = recording();
    const [findings] = await check(['--dir', root, '@acme/ui'], fetch);
    expect(fetch.urls).toEqual([]);
    expect(findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: '@acme packages come from https://npm.pkg.github.com (@acme:registry= in .npmrc, line 2); depcurfew asks https://registry.npmjs.org/, so it did not look the package up there',
        fix: 'Before installing it, check the package in https://npm.pkg.github.com yourself; if you trust that registry, pass --registry https://npm.pkg.github.com to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line, and depcurfew looks the package up there',
      },
    ]);
    // An agent is told that the registry is the user's setting, not to change the hook command.
    expect(agentFix(findings?.[0]?.fix ?? '', 'unverified')).toBe(UNREAD_REGISTRY_IS_THE_USERS);
  });

  it('names the registry --registry gives, and looks the package up there when it is the scope registry', async () => {
    const root = project('@types:registry=https://npm.pkg.github.com/\n');
    const other = await check(['--dir', root, '--registry', 'https://npm.corp.example/', '@types/node'], recording());
    expect(other[0]?.[0]?.message).toBe('@types packages come from https://npm.pkg.github.com/ (@types:registry= in .npmrc, line 1); depcurfew asks https://npm.corp.example/, so it did not look the package up there');
    const fetch = recording();
    const same = await check(['--dir', root, '--registry', 'https://NPM.pkg.github.com', '@types/node'], fetch);
    expect(fetch.urls.map((url) => new URL(url).host)).toEqual(['npm.pkg.github.com']);
    expect(same[0]?.map((finding) => finding.code)).not.toContain('unverified');
  });

  it('is the registry of its packages, which a registry of every package from the environment does not reach', async () => {
    const root = project('@types:registry=https://npm.pkg.github.com/\n');
    const env = { NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' };
    const [scoped] = await check(['--dir', root, '@types/node'], recording(), directory('home'), env);
    expect(scoped?.map((finding) => finding.message)).toEqual([
      '@types packages come from https://npm.pkg.github.com/ (@types:registry= in .npmrc, line 1); depcurfew asks https://registry.npmjs.org/, so it did not look the package up there',
    ]);
    // With --registry naming the scope's registry, the package is looked up there, whatever the environment sets for others.
    const fetch = recording();
    const [checked] = await check(['--dir', root, '--registry', 'https://npm.pkg.github.com/', '@types/node'], fetch, directory('home'), env);
    expect(fetch.urls.map((url) => new URL(url).host)).toEqual(['npm.pkg.github.com']);
    expect(checked?.map((finding) => finding.code)).not.toContain('unverified');
  });

  it('names ~/.npmrc for a scope it assigns', async () => {
    const home = directory('home');
    writeFileSync(join(home, '.npmrc'), '@corp:registry=https://npm.corp.example/\n');
    const root = project('fund=false\n');
    const [findings] = await check(['--dir', root, '@corp/tool'], recording(), home);
    expect(findings?.[0]?.message).toBe('@corp packages come from https://npm.corp.example/ (@corp:registry= in ~/.npmrc, line 1); depcurfew asks https://registry.npmjs.org/, so it did not look the package up there');
  });
});
