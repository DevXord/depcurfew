// Registry and index settings of the machine (decision D-168): check, the hook and depcurfew mcp read them as the
// tools do, in their order, and treat them like the settings of files they do not take: one that points the install at
// another registry or index than the one depcurfew asks makes the package unverified with the setting named, and the
// package is not looked up at all, so that its name does not reach a registry the install does not use. npm:
// npm_config_registry and npm_config_@scope:registry in any case, npm_config_userconfig (another user file in place of
// ~/.npmrc) and the global npmrc below npm's prefix; pip: PIP_INDEX_URL, PIP_EXTRA_INDEX_URL and the user pip.conf (or
// the file PIP_CONFIG_FILE names); uv: UV_DEFAULT_INDEX, UV_INDEX_URL, UV_INDEX and the user uv.toml (or UV_CONFIG_FILE).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { call, cleanUp, initialized, project as mcpProject } from '../mcp/support.ts';
import { recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `depcurfew-d168-machine-${prefix}-`));
  temporary.push(path);
  return path;
}

function write(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A project with depcurfew.json and package.json. */
function project(): string {
  const root = directory('project');
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
  writeFileSync(join(root, 'package.json'), '{"name":"root","private":true}');
  return root;
}

/** recordedFetch, recording every URL. */
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
  level: string;
  message: string;
  fix: string;
}

interface Machine {
  env?: Record<string, string>;
  home?: string;
  platform?: NodeJS.Platform;
}

async function check(argv: string[], machine: Machine = {}, fetch: FetchLike = recordedFetch): Promise<{ code: number; findings: Finding[][] }> {
  let stdout = '';
  const home = machine.home ?? directory('home');
  const code = await run(['check', '--json', ...argv], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch,
    now: () => NOW,
    stdin: async () => '',
    home: () => home,
    projectDir: () => undefined,
    osvData: () => undefined,
    userEnvironment: () => ({ platform: machine.platform ?? process.platform, home, env: machine.env ?? {} }),
  });
  const document = JSON.parse(stdout) as { packages: { findings: Finding[] }[] };
  return { code, findings: document.packages.map((entry) => entry.findings) };
}

async function hook(command: string, root: string, machine: Machine = {}, fetch: FetchLike = recordedFetch): Promise<{ permissionDecision?: string; permissionDecisionReason?: string }> {
  let stdout = '';
  const home = machine.home ?? directory('home');
  await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch,
    now: () => NOW,
    stdin: async () => JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }),
    home: () => home,
    projectDir: () => root,
    osvData: () => undefined,
    userEnvironment: () => ({ platform: machine.platform ?? process.platform, home, env: machine.env ?? {} }),
  });
  return stdout === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
}

const PUBLIC_NPM = 'https://registry.npmjs.org/';
const hosts = (fetch: { urls: string[] }) => fetch.urls.map((url) => new URL(url).host);

describe('npm registries in the environment', () => {
  it('does not look a package up in the public registry when npm_config_registry names another, in any case npm reads', async () => {
    for (const name of ['NPM_CONFIG_REGISTRY', 'npm_config_registry', 'Npm_Config_Registry']) {
      const fetch = recording();
      const result = await check(['--dir', project(), 'corp-internal-tool'], { env: { [name]: 'https://npm.corp.example/' } }, fetch);
      expect(fetch.urls).toEqual([]);
      expect(result.code).toBe(1);
      expect(result.findings[0]).toEqual([
        {
          level: 'error',
          code: 'unverified',
          message: `the install would use the registry https://npm.corp.example/ from ${name} in the environment; depcurfew asks ${PUBLIC_NPM}, so it did not look the package up there`,
          fix: `Before installing it, check the package in the registry that ${name} names; if you trust that registry, pass --registry https://npm.corp.example/ to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line`,
        },
      ]);
    }
  });

  it('checks the package when --registry names the same registry, and ignores an empty value as npm does', async () => {
    const fetch = recording();
    const same = await check(['--dir', project(), '--registry', 'https://npm.corp.example', 'lodash'], { env: { NPM_CONFIG_REGISTRY: 'https://NPM.corp.example/' } }, fetch);
    expect(hosts(fetch)).toEqual(['npm.corp.example']);
    expect(same.findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
    const empty = await check(['--dir', project(), 'lodash'], { env: { npm_config_registry: '' } });
    expect(empty.findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
  });

  it('does not look up a package of a scope that npm_config_@scope:registry assigns, and looks up the others', async () => {
    const fetch = recording();
    const result = await check(['--dir', project(), '@corp/thing', 'lodash'], { env: { 'npm_config_@corp:registry': 'https://npm.corp.example/' } }, fetch);
    expect(fetch.urls.some((url) => url.includes('corp'))).toBe(false);
    expect(hosts(fetch)).toEqual(['registry.npmjs.org']);
    expect(result.findings[0]?.[0]?.message).toBe(
      `the install would use the registry for @corp https://npm.corp.example/ from npm_config_@corp:registry in the environment; depcurfew asks ${PUBLIC_NPM}, so it did not look the package up there`,
    );
    expect(result.findings[1]?.map((finding) => finding.code)).not.toContain('unverified');
  });

  it('asks in the hook instead of denying a private package as a made-up name', async () => {
    const root = project();
    const fetch = recording();
    const answer = await hook('npm install corp-internal-tool', root, { env: { NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' } }, fetch);
    expect(fetch.urls).toEqual([]);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('- corp-internal-tool: the install would use the registry https://npm.corp.example/ from NPM_CONFIG_REGISTRY in the environment');
    expect(answer.permissionDecisionReason).toContain("Where the install gets its packages from is the user's setting");
  });

  it('reads the user file npm_config_userconfig names in place of ~/.npmrc', async () => {
    const home = directory('home');
    write(join(home, '.npmrc'), 'registry=https://home.example/\n');
    const other = write(join(directory('elsewhere'), 'corp.npmrc'), '; corporate\nregistry=https://npm.corp.example/\n');
    const fetch = recording();
    const result = await check(['--dir', project(), 'lodash'], { home, env: { NPM_CONFIG_USERCONFIG: other } }, fetch);
    // npm does not read ~/.npmrc then, so depcurfew does not take its registry either.
    expect(fetch.urls).toEqual([]);
    expect(result.findings[0]?.[0]?.message).toBe(`the install would use the registry https://npm.corp.example/ from ${other} (line 2); depcurfew asks ${PUBLIC_NPM}, so it did not look the package up there`);
    // When it names ~/.npmrc itself (npm exports it so to the commands it runs), ~/.npmrc is read as before.
    const own = await check(['--dir', project(), 'lodash'], { home, env: { npm_config_userconfig: join(home, '.npmrc') } }, recording());
    expect(own.findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
  });

  it('reads the global npmrc below npm prefix, unless a file npm reads first sets the same key', async () => {
    const prefix = directory('prefix');
    write(join(prefix, 'etc', 'npmrc'), 'registry=https://global.example/\n@g:registry=https://global.example/\n');
    const fetch = recording();
    const result = await check(['--dir', project(), 'lodash', '@g/x'], { env: { PREFIX: prefix } }, fetch);
    expect(fetch.urls).toEqual([]);
    expect(result.findings[0]?.[0]?.message).toBe(`the install would use the registry https://global.example/ from ${join(prefix, 'etc', 'npmrc')} (line 1); depcurfew asks ${PUBLIC_NPM}, so it did not look the package up there`);
    expect(result.findings[1]?.[0]?.message).toContain(`the registry for @g https://global.example/ from ${join(prefix, 'etc', 'npmrc')} (line 2)`);
    // ~/.npmrc sets registry, which beats the global file; @g:registry still comes from it.
    const home = directory('home');
    write(join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    const user = await check(['--dir', project(), 'lodash', '@g/x'], { home, env: { PREFIX: prefix } });
    expect(user.findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
    expect(user.findings[1]?.[0]?.code).toBe('unverified');
    // npm_config_globalconfig names the file itself.
    const named = write(join(directory('global'), 'npmrc'), 'registry=https://named.example/\n');
    const configured = await check(['--dir', project(), 'lodash'], { env: { PREFIX: prefix, npm_config_globalconfig: named } }, recording());
    expect(configured.findings[0]?.[0]?.message).toContain(`https://named.example/ from ${named} (line 1)`);
  });

  it('reads them in depcurfew mcp from the environment of the server', async () => {
    const root = mcpProject({ cooldown: { minimum: '3d' } });
    const fetch = recording();
    const client = await initialized(root, '2025-11-25', { env: { NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' }, fetch });
    client.send(call(1, 'check_packages', { packages: ['corp-internal-tool'] }));
    const answer = (await client.next())['result'] as { structuredContent: { packages: { findings: Finding[] }[] } };
    await client.close();
    expect(fetch.urls).toEqual([]);
    expect(answer.structuredContent.packages[0]?.findings[0]?.message).toContain('from NPM_CONFIG_REGISTRY in the environment');
  });
});

/** The platform whose paths this machine's temporary files have: Windows on Windows runners, else Linux. */
const NAMED_PLATFORM: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';

describe('Python indexes of the machine', () => {
  it('does not look a package up on PyPI when PIP_INDEX_URL names another index', async () => {
    const fetch = recording();
    const result = await check(['--dir', project(), 'pypi:corp-internal-lib'], { env: { PIP_INDEX_URL: 'https://pypi.corp.example/simple' } }, fetch);
    expect(fetch.urls).toEqual([]);
    expect(result.findings[0]).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'the install would use the index https://pypi.corp.example/simple from PIP_INDEX_URL in the environment; depcurfew asks https://pypi.org/simple/, so it did not look the package up there',
        fix: 'Before installing it, check the package in the index that PIP_INDEX_URL names; if you trust that index, pass --index https://pypi.corp.example/simple to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
      },
    ]);
    // pip reads PIP_ in upper case followed by the rest in any case; pip_index_url sets nothing on Linux and macOS.
    const lower = await check(['--dir', project(), 'pypi:requests'], { env: { pip_index_url: 'https://pypi.corp.example/simple' }, platform: 'linux' });
    expect(lower.findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
    // Windows finds a variable in any case, so pip reads it there.
    const windows = await check(['--dir', project(), 'pypi:corp-internal-lib'], { env: { pip_index_url: 'https://pypi.corp.example/simple' }, platform: 'win32' }, recording());
    expect(windows.findings[0]?.map((finding) => finding.code)).toContain('unverified');
  });

  it('looks a package up on PyPI when PIP_EXTRA_INDEX_URL only adds an index, and says so', async () => {
    const fetch = recording();
    const result = await check(['--dir', project(), 'pypi:requests'], { env: { PIP_EXTRA_INDEX_URL: 'https://pypi.corp.example/simple' } }, fetch);
    expect(hosts(fetch)).toEqual(['pypi.org']);
    expect(result.findings[0]?.at(-1)?.message).toBe('the install may also take it from https://pypi.corp.example/simple that PIP_EXTRA_INDEX_URL in the environment adds; depcurfew checked only https://pypi.org/simple/');
  });

  it('reads index-url in [global] and [install] of the user pip.conf, or the file PIP_CONFIG_FILE names instead', async () => {
    const home = directory('home');
    write(join(home, '.config', 'pip', 'pip.conf'), '[global]\ntimeout = 60\n[install]\nindex_url: https://pypi.corp.example/simple\n');
    const fetch = recording();
    const result = await check(['--dir', project(), 'pypi:requests'], { home, platform: 'linux' }, fetch);
    expect(fetch.urls).toEqual([]);
    expect(result.findings[0]?.[0]?.message).toBe('the install would use the index https://pypi.corp.example/simple from ~/.config/pip/pip.conf (line 4); depcurfew asks https://pypi.org/simple/, so it did not look the package up there');
    // An index in [download] is not used by pip install.
    write(join(home, '.config', 'pip', 'pip.conf'), '[download]\nindex-url = https://pypi.corp.example/simple\n');
    expect((await check(['--dir', project(), 'pypi:requests'], { home, platform: 'linux' })).findings[0]?.map((finding) => finding.code)).not.toContain('unverified');
    // With PIP_CONFIG_FILE naming an existing file, pip does not read the user file.
    write(join(home, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://pypi.corp.example/simple\n');
    const named = write(join(directory('pip'), 'pip.conf'), '[global]\nextra-index-url =\n    https://extra.example/simple\n');
    // The file is named by a path of this machine, so the platform of this machine reads it (a Windows path is not
    // absolute on Linux).
    const replaced = await check(['--dir', project(), 'pypi:requests'], { home, platform: NAMED_PLATFORM, env: { PIP_CONFIG_FILE: named } });
    expect(replaced.findings[0]?.at(-1)?.message).toBe(`the install may also take it from https://extra.example/simple that ${named} (line 2) adds; depcurfew checked only https://pypi.org/simple/`);
  });

  it('reads the indexes of uv in the environment and in the user uv.toml for packages uv installs', async () => {
    const root = project();
    const fetch = recording();
    const replaced = await hook('uv add requests', root, { env: { UV_DEFAULT_INDEX: 'https://pypi.corp.example/simple' } }, fetch);
    expect(fetch.urls).toEqual([]);
    expect(replaced.permissionDecision).toBe('ask');
    expect(replaced.permissionDecisionReason).toContain('the install would use the index https://pypi.corp.example/simple from UV_DEFAULT_INDEX in the environment');
    const added = await hook('uv add requests', root, { env: { UV_INDEX: 'corp=https://pypi.corp.example/simple https://other.example/simple' } });
    expect(added.permissionDecisionReason).toContain('the install may also take it from the places that UV_INDEX in the environment adds');
    // pip does not read the variables of uv.
    expect((await hook('pip install requests', root, { env: { UV_DEFAULT_INDEX: 'https://pypi.corp.example/simple' } })).permissionDecision).toBeUndefined();
    const home = directory('home');
    write(join(home, '.config', 'uv', 'uv.toml'), '[[index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\ndefault = true\n');
    const user = await hook('uv add requests', root, { home, platform: 'linux' }, recording());
    expect(user.permissionDecisionReason).toContain('the install would use the index https://pypi.corp.example/simple from ~/.config/uv/uv.toml (line 1)');
    // UV_CONFIG_FILE names the configuration file uv reads in place of the user file.
    const named = write(join(directory('uv'), 'uv.toml'), 'index-url = "https://named.example/simple"\n');
    const configured = await hook('uv add requests', root, { home, platform: NAMED_PLATFORM, env: { UV_CONFIG_FILE: named } });
    expect(configured.permissionDecisionReason).toContain(`https://named.example/simple from ${named} (line 1)`);
    expect(configured.permissionDecisionReason).not.toContain('~/.config/uv/uv.toml');
  });
});
