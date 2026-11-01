// Fixes from the final review of 1.3.0 for check, the Claude Code hook and depcurfew mcp (decision D-113): which
// .npmrc npm reads (its local prefix) and the registry settings of Yarn, Bun and uv, hook events that cannot be read,
// agent fixes that change configuration, configuration files that are not regular files, invisible characters in the
// hook's JSON, documents with too many versions, lookups shared by two policies and usage errors.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentFix } from '../../src/check/hook.ts';
import { checkSpec } from '../../src/check/index.ts';
import { checkPythonSpec } from '../../src/check/python.ts';
import { tooManyMembers, type FetchLike } from '../../src/check/registry.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { npmLocalPrefix } from '../../src/check/registry-settings.ts';
import { appliedPolicy, checkApplied } from '../../src/cli/check.ts';
import type { CheckRequest } from '../../src/check/findings.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { policy, recordedFetch } from './support.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix = 'depcurfew-d113-'): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(created);
  return created;
}

/** A project with depcurfew.json and package.json in a git repository; `files` are written relative to it. */
function repository(document: object = {}, files: Record<string, string> = {}): string {
  const root = directory();
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...document }));
  writeFileSync(join(root, 'package.json'), '{"name":"root","private":true}');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(argv: string[], options: { stdin?: string; projectDir?: string; home?: string; fetch?: FetchLike } = {}): Promise<Result> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => NOW,
    stdin: async () => options.stdin ?? '',
    home: () => options.home ?? HOME,
    projectDir: () => options.projectDir,
  });
  return { code, stdout, stderr };
}

function event(command: string, cwd: string, tool = 'Bash'): string {
  return JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd });
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
const output = (stdout: string): Output => (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;

async function hook(command: string, cwd: string, projectDir: string, options: { home?: string; fetch?: FetchLike; args?: string[] } = {}): Promise<Output> {
  const { args = [], ...rest } = options;
  const result = await exec(['check', '--hook', 'claude-code', ...args], { stdin: event(command, cwd), projectDir, ...rest });
  expect(result.code).toBe(EXIT_OK);
  return result.stdout === '' ? {} : output(result.stdout);
}

/** The fix a person gets for the last finding of one request in `root`, checked as the hook checks it there. */
async function fixFor(root: string, request: CheckRequest): Promise<string | undefined> {
  const result = appliedPolicy(root, { registry: undefined, home: HOME, project: root });
  if (!result.ok) throw new Error(result.error.message);
  const { reports } = await checkApplied([request], result.applied, { fetch: recordedFetch, now: NOW });
  return reports[0]?.findings.at(-1)?.fix;
}

describe('the .npmrc npm reads: its local prefix (A3, P2)', () => {
  it('asks when a directory of its own (package.json and .npmrc) points the install at another registry', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'sub/package.json': '{"name":"sub"}', 'sub/.npmrc': '# planted\nregistry=https://evil.example/\n' });
    const answer = await hook('npm install lodash', join(root, 'sub'), root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('- lodash: the install would use the registry https://evil.example/ from sub/.npmrc (line 2); depcurfew checked https://registry.npmjs.org/');
    // The agent is told to leave the registry to the user, not to change a file.
    expect(answer.permissionDecisionReason).toContain("Where the install gets its packages from is the user's setting");
    // check --dir and its JSON say the same, as an error that fails the check; paths are relative to the directory checked.
    const checked = await exec(['check', '--json', '--dir', join(root, 'sub'), 'lodash']);
    expect(checked.code).toBe(EXIT_FAILURE);
    const finding = (JSON.parse(checked.stdout) as { packages: { findings: { code: string; message: string; fix: string }[] }[] }).packages[0]?.findings.at(-1);
    // The fix for a person says how to make depcurfew check that registry, if they trust it.
    expect(finding).toEqual({
      level: 'error',
      code: 'unverified',
      message: 'the install would use the registry https://evil.example/ from .npmrc (line 2); depcurfew checked https://registry.npmjs.org/',
      fix: 'Before installing it, check the package in the registry that .npmrc names; if you trust that registry, pass --registry https://evil.example/ to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
    });
  });

  it('says nothing about such a setting when it names the registry depcurfew checked, but does about a variable', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'sub/package.json': '{}', 'sub/.npmrc': 'registry=https://user:token@NPM.Company.example/\n' });
    // Scheme and host in any case, credentials and trailing slashes do not matter.
    expect((await exec(['check', '--dir', join(root, 'sub'), '--registry', 'https://npm.company.example', 'lodash'])).code).toBe(EXIT_OK);
    const answer = await exec(['check', '--hook', 'claude-code', '--registry', 'https://npm.company.example/'], { stdin: event('npm install lodash', join(root, 'sub')), projectDir: root });
    expect(answer.stdout).not.toContain('the install would');
    writeFileSync(join(root, 'sub', '.npmrc'), 'registry=${NPM_REGISTRY}\n');
    const variable = (await hook('npm install lodash', join(root, 'sub'), root)).permissionDecisionReason;
    expect(variable).toContain('- lodash: the install would use the registry set in sub/.npmrc (line 1), whose value depcurfew cannot read; depcurfew checked https://registry.npmjs.org/');
    const json = JSON.parse((await exec(['check', '--json', '--dir', join(root, 'sub'), 'lodash'])).stdout) as { packages: { findings: { fix: string }[] }[] };
    expect(json.packages[0]?.findings.at(-1)?.fix).toContain('pass --registry <its URL> to depcurfew check');
  });

  it('asks about a scope registry and a dist-tag of such an .npmrc only for the packages they apply to', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'sub/package.json': '{}', 'sub/.npmrc': '@acme:registry=https://evil.example/\ntag=next\n' });
    const scoped = await hook('pnpm add @acme/ui lodash@4.17.21', join(root, 'sub'), root);
    expect(scoped.permissionDecision).toBe('ask');
    expect(scoped.permissionDecisionReason).toContain('- @acme/ui: the install would use the registry for @acme https://evil.example/ from sub/.npmrc (line 1)');
    // The name of the scope is not sent to the public registry, which the install does not use for it.
    expect(scoped.permissionDecisionReason).not.toContain('is not in https://registry.npmjs.org/');
    expect(scoped.permissionDecisionReason).not.toContain('- lodash@4.17.21');
    const fix = JSON.parse((await exec(['check', '--json', '--dir', join(root, 'sub'), '@acme/ui'])).stdout) as { packages: { findings: { fix: string }[] }[] };
    expect(fix.packages[0]?.findings.at(-1)?.fix).toBe(
      'Before installing it, check the package in the registry that .npmrc names; if you trust that registry, set @acme:registry=https://evil.example/ in the .npmrc next to depcurfew.json',
    );
    const tagged = await hook('npm install lodash', join(root, 'sub'), root);
    expect(tagged.permissionDecisionReason).toContain('- lodash: the install would pick the version by the dist-tag "next" set in sub/.npmrc (line 2); depcurfew checked the version that latest names');
    // pnpm does not take tag= from .npmrc, and an exact version needs no tag.
    expect(await hook('npm install lodash@4.17.21', join(root, 'sub'), root)).toEqual({});
    // The dist-tag and the scope registry depcurfew used anyway change nothing.
    writeFileSync(join(root, 'sub', '.npmrc'), '@acme:registry=https://registry.npmjs.org\ntag=latest\n');
    const same = (await hook('npm install @acme/ui lodash', join(root, 'sub'), root)).permissionDecisionReason ?? '';
    expect(same).not.toContain('the install would');
    expect(same).toContain('@acme/ui is not in https://registry.npmjs.org/');
  });

  it("takes the .npmrc of a directory listed in projects, so that a project's private scope is not looked up in the public registry", async () => {
    const root = repository(
      { cooldown: { minimum: '3d' }, projects: ['frontend'] },
      { 'frontend/package.json': '{"name":"frontend"}', 'frontend/.npmrc': '@acme:registry=https://npm.acme.example/\nregistry=https://npm.mirror.example/\n' },
    );
    const answer = await hook('npm install @acme/ui lodash', join(root, 'frontend', 'src'), root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('@acme packages come from https://npm.acme.example/ (.npmrc)');
    expect(answer.permissionDecisionReason).toContain('npm packages were looked up in https://npm.mirror.example/ (registry= in frontend/.npmrc, line 2), not in the public npm registry.');
    const checked = await exec(['check', '--dir', join(root, 'frontend'), '@acme/ui']);
    expect(checked.stdout).toContain('@acme packages come from https://npm.acme.example/ (.npmrc)');
  });

  it('takes the .npmrc of the workspace root for a workspace package, as npm does', async () => {
    const root = repository({}, { '.npmrc': 'registry=https://npm.mirror.example/\n', 'packages/app/package.json': '{"name":"app"}' });
    writeFileSync(join(root, 'package.json'), '{"name":"root","private":true,"workspaces":["packages/*"]}');
    expect(npmLocalPrefix(join(root, 'packages', 'app'))).toEqual({ prefix: expect.stringMatching(/depcurfew-d113-/u), workspace: expect.stringMatching(/app$/u) });
    const result = await exec(['check', '--dir', join(root, 'packages', 'app'), 'lodash']);
    expect(result.stderr).toContain('note: npm packages were looked up in https://npm.mirror.example/ (registry= in ../../.npmrc, line 1)');
    // Not a workspace: npm reads no .npmrc of the root there, so neither does depcurfew.
    writeFileSync(join(root, 'package.json'), '{"name":"root","private":true,"workspaces":["!packages/app","packages/*"]}');
    expect((await exec(['check', '--dir', join(root, 'packages', 'app'), 'lodash'])).stderr).not.toContain('npm.mirror.example');
  });

  it('finds the local prefix as npm does: the nearest package.json or node_modules, else the directory itself', () => {
    const root = directory();
    mkdirSync(join(root, 'a', 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    expect(npmLocalPrefix(join(root, 'a', 'b', 'c')).prefix).toMatch(/[/\\]a$/u);
    writeFileSync(join(root, 'a', 'b', 'package.json'), '{}');
    expect(npmLocalPrefix(join(root, 'a', 'b', 'c')).prefix).toMatch(/[/\\]b$/u);
  });
});

describe("the registry settings of Yarn, Bun and uv, which depcurfew does not read (A3)", () => {
  it('asks when .yarnrc.yml sets npmRegistryServer or a scope registry, for packages Yarn installs', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { '.yarnrc.yml': 'npmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.example"\n' });
    const scoped = await hook('yarn add @acme/ui lodash', root, root);
    expect(scoped.permissionDecisionReason).toBe(
      "depcurfew cannot vouch for what this command installs:\n- @acme/ui: the install would use the registry for @acme https://npm.acme.example from .yarnrc.yml (line 3); depcurfew checked https://registry.npmjs.org/. Fix: Do not install it before it is checked. Where the install gets its packages from is the user's setting, not the agent's: tell the user, and do not change that file, .npmrc or depcurfew.json yourself",
    );
    expect(await fixFor(root, { spec: '@acme/ui', tool: 'yarn' })).toBe(
      'Before installing it, check the package in the registry that .yarnrc.yml names; if you trust that registry, set @acme:registry=https://npm.acme.example in the .npmrc next to depcurfew.json',
    );
    writeFileSync(join(root, '.yarnrc.yml'), 'npmRegistryServer: "https://npm.corp.example"\n');
    expect((await hook('yarn add lodash', join(root, 'src'), root)).permissionDecisionReason).toContain(
      '- lodash: the install would use the registry https://npm.corp.example from .yarnrc.yml (line 1); depcurfew checked https://registry.npmjs.org/',
    );
    expect(await fixFor(root, { spec: 'lodash', tool: 'yarn' })).toBe(
      'Before installing it, check the package in the registry that .yarnrc.yml names; if you trust that registry, pass --registry https://npm.corp.example to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
    );
    // With that registry given to depcurfew, the company repository gets no question.
    expect(await hook('yarn add lodash', root, root, { args: ['--registry', 'https://NPM.corp.example/'] })).toEqual({});
    // npm does not read .yarnrc.yml.
    expect(await hook('npm install lodash', root, root)).toEqual({});
    writeFileSync(join(root, '.yarnrc.yml'), 'npmRegistryServer: "${NPM_REGISTRY}"\n');
    expect((await hook('yarn add lodash', root, root, { args: ['--registry', 'https://npm.corp.example'] })).permissionDecisionReason).toContain(
      'the install would use the registry set in .yarnrc.yml (line 1), whose value depcurfew cannot read',
    );
  });

  it('asks when bunfig.toml sets the registry or a scope registry, for packages Bun installs, unless it is the one depcurfew checked', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'bunfig.toml': '[install]\nregistry = "https://npm.corp.example/"\n' });
    expect((await hook('bun add lodash', root, root)).permissionDecisionReason).toContain('- lodash: the install would use the registry https://npm.corp.example/ from bunfig.toml (line 2)');
    expect(await hook('bun add lodash', root, root, { args: ['--registry', 'https://npm.corp.example'] })).toEqual({});
    // A table with the URL and a token compares by its URL; the token is not shown.
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nregistry = { url = "https://npm.corp.example/", token = "secret" }\n');
    expect(await hook('bun add lodash', root, root, { args: ['--registry', 'https://npm.corp.example'] })).toEqual({});
    expect((await hook('bun add lodash', root, root, { args: ['--registry', 'https://npm.other.example'] })).permissionDecisionReason).not.toContain('secret');
    writeFileSync(join(root, 'bunfig.toml'), '[install.scopes]\nacme = { url = "https://npm.acme.example/" }\n');
    const scoped = await hook('bun add @acme/ui lodash', root, root);
    expect(scoped.permissionDecisionReason).toContain('- @acme/ui: the install would use the registry for @acme https://npm.acme.example/ from bunfig.toml (line 2)');
    expect(scoped.permissionDecisionReason).not.toContain('- lodash:');
    writeFileSync(join(root, 'bunfig.toml'), '[install]\nregistry = 42\n');
    expect((await hook('bun add lodash', root, root)).permissionDecisionReason).toContain('whose value depcurfew cannot read');
  });

  it('asks when uv takes another index from pyproject.toml or uv.toml, but not for an explicit index or the index depcurfew checked', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'pyproject.toml': '[project]\nname = "app"\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n' });
    // An index without default = true is asked before PyPI: it adds a source, whatever --index says.
    const added = await hook('uv add requests', root, root);
    expect(added.permissionDecision).toBe('ask');
    expect(added.permissionDecisionReason).toContain(
      '- pypi:requests: the install may also take it from https://pypi.corp.example/simple that pyproject.toml (line 4) adds; depcurfew checked only https://pypi.org/simple/',
    );
    expect(await fixFor(root, { spec: 'pypi:requests', tool: 'uv' })).toBe(
      'Before installing it, check the package in every index that pyproject.toml adds: depcurfew checks one index, so it cannot vouch for a package from the others',
    );
    // A default index replaces PyPI: the one depcurfew checked changes nothing, another one has a remedy.
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "app"\n\n[[tool.uv.index]]\nname = "pypi"\nurl = "https://PyPI.org/simple"\ndefault = true\n');
    expect((await hook('uv add requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "app"\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\ndefault = true\n');
    expect((await hook('uv add requests', root, root)).permissionDecisionReason).toContain(
      '- pypi:requests: the install would use the index https://pypi.corp.example/simple from pyproject.toml (line 4); depcurfew checked https://pypi.org/simple/',
    );
    expect(await fixFor(root, { spec: 'pypi:requests', tool: 'uv' })).toBe(
      'Before installing it, check the package in the index that pyproject.toml names; if you trust that index, pass --index https://pypi.corp.example/simple to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
    );
    expect((await hook('uv add requests', root, root, { args: ['--index', 'https://pypi.corp.example/simple/'] })).permissionDecisionReason ?? '').not.toContain('the install');
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "app"\n\n[[tool.uv.index]]\nname = "torch"\nurl = "https://download.pytorch.org/whl/cpu"\nexplicit = true\n');
    expect((await hook('uv add requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    writeFileSync(join(root, 'uv.toml'), 'index-url = "https://pypi.corp.example/simple"\n');
    expect((await hook('uv pip install requests', root, root)).permissionDecisionReason).toContain('from uv.toml (line 1)');
    writeFileSync(join(root, 'uv.toml'), 'index-url = "${CORP_INDEX}"\nextra-index-url = ["https://pypi.org/simple"]\n');
    const reason = (await hook('uv pip install requests', root, root)).permissionDecisionReason ?? '';
    expect(reason).toContain('the install would use the index set in uv.toml (line 1), whose value depcurfew cannot read');
    // pip does not read uv's files.
    expect((await hook('pip install requests', root, root)).permissionDecisionReason ?? '').not.toContain('uv.toml');
  });

  it('reports a list that adds indexes even when it holds the index depcurfew checked', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'uv.toml': 'extra-index-url = ["https://pypi.org/simple"]\n' });
    expect((await hook('uv pip install requests', root, root)).permissionDecisionReason).toContain('the install may also take it from the places that uv.toml (line 1) adds');
  });
});

describe('hook events that cannot be read (T1)', () => {
  it.each([
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['a string', '"text"'],
    ['tool_input as a string', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'npm i fresh-pkg' })],
    ['a command that is not a string', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 123 } })],
    ['cmd in place of command', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { cmd: 'npm i fresh-pkg' } })],
    ['a PowerShell call without a command', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: {} })],
    ['a Monitor call with neither command nor ws', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { url: 'x' } })],
    ['no tool_name', JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'npm i fresh-pkg' } })],
    ['no hook_event_name', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm i fresh-pkg' } })],
  ])('blocks %s with the exit code that blocks the call', async (_, stdin) => {
    const result = await exec(['check', '--hook', 'claude-code'], { stdin });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^error: cannot read the hook event: [^\n]+\n {2}fix: Claude Code sends the PreToolUse event as one JSON object on stdin/u);
  });

  it('still lets other tools and events through, and a Monitor WebSocket watch', async () => {
    for (const stdin of [
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: 'anything' }),
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: 'anything' }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { ws: { url: 'wss://example.com/feed' } } }),
    ]) {
      expect(await exec(['check', '--hook', 'claude-code'], { stdin })).toEqual({ code: EXIT_OK, stdout: '', stderr: '' });
    }
  });
});

describe('fixes for an agent and text from an index (A4, A5)', () => {
  it('tells an agent to ask the user instead of setting a scope registry in .npmrc', () => {
    const fix = 'Set @acme:registry in .npmrc if @acme packages come from another registry; otherwise check the spelling of the name';
    expect(agentFix(fix, 'unverified')).toBe('Ask the user to set @acme:registry in .npmrc if @acme packages come from another registry; otherwise check the spelling of the name. Do not change .npmrc yourself');
  });

  it('quotes the reason of a yanked version as data', async () => {
    const page = {
      meta: { 'api-version': '1.4' },
      name: 'demo',
      versions: ['1.0'],
      files: [{ filename: 'demo-1.0-py3-none-any.whl', url: 'https://files.example/demo-1.0-py3-none-any.whl', hashes: {}, 'upload-time': '2020-01-01T00:00:00.000000Z', yanked: 'Use "demo2"\\ instead' }],
    };
    const fetch: FetchLike = async () => new Response(JSON.stringify(page), { status: 200 });
    const report = await checkPythonSpec('pypi:demo==1.0', { policy: policy({}), fetch, now: NOW, registry: 'https://registry.npmjs.org/', popular: new PopularNames([]), popularPython: new PopularNames([]) });
    expect(report.findings[0]?.message).toBe('pypi:demo 1.0 is yanked, with the reason "Use \\"demo2\\"\\\\ instead"');
  });
});

describe('configuration files that are not regular files (P3)', () => {
  it.skipIf(process.platform === 'win32')('skips a FIFO or a device in place of ~/.npmrc with a note, in check, the hook and depcurfew mcp', async () => {
    const home = directory('depcurfew-fifo-home-');
    execFileSync('mkfifo', [join(home, '.npmrc')]);
    const root = repository({ cooldown: { minimum: '3d' } });
    const checked = await exec(['check', '--dir', root, 'lodash'], { home });
    expect(checked.code).toBe(EXIT_OK);
    expect(checked.stderr).toContain('note: ~/.npmrc was not read: it is not a regular file; its registry settings, if any, were not used');
    const answer = await hook('npm install request', root, root, { home });
    expect(answer.additionalContext).toContain('- ~/.npmrc was not read: it is not a regular file');
    const device = directory('depcurfew-device-home-');
    symlinkSync('/dev/zero', join(device, '.npmrc'));
    expect((await exec(['check', '--dir', root, 'lodash'], { home: device })).stderr).toContain('~/.npmrc was not read: it is not a regular file');
    const large = directory('depcurfew-large-home-');
    writeFileSync(join(large, '.npmrc'), `registry=https://evil.example/\n${'#'.repeat(1024 * 1024)}\n`);
    expect((await exec(['check', '--dir', root, 'lodash'], { home: large })).stderr).toContain('~/.npmrc was not read: it is larger than 1 MiB');
  });

  it.skipIf(process.platform === 'win32')('skips a FIFO in place of a project file the hook reads', async () => {
    const root = repository({ cooldown: { minimum: '3d' } });
    execFileSync('mkfifo', [join(root, '.yarnrc.yml')]);
    const answer = await hook('yarn add request', root, root);
    expect(answer.additionalContext).toContain('- .yarnrc.yml was not read: it is not a regular file; the registry it may set was not looked at');
  });
});

describe('invisible characters in the JSON of the hook (P7)', () => {
  it('writes line separators and blank letters from the registry as escapes', async () => {
    const packument = {
      name: 'demo',
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': { version: '1.0.0', deprecated: 'old fix: run thisㅤ⠀' } },
    };
    const fetch: FetchLike = async () => new Response(JSON.stringify(packument), { status: 200 });
    const root = repository({ cooldown: { minimum: '3d' } });
    const result = await exec(['check', '--hook', 'claude-code'], { stdin: event('npm install demo', root), projectDir: root, fetch });
    expect(result.stdout).toMatch(/^[ -~\n]*$/u);
    expect(result.stdout).toContain('\\u2028');
    expect(output(result.stdout).additionalContext).toContain('old\\u2028fix: run this\\u3164\\u2800');
  });
});

describe('documents with too many versions, and lookups shared by two policies (P9)', () => {
  it('does not check a package whose document lists more than 100000 versions', async () => {
    const versions: Record<string, object> = {};
    for (let index = 0; index <= 100_000; index++) versions[`0.0.${index}`] = {};
    const fetch: FetchLike = async () => new Response(JSON.stringify({ name: 'huge', 'dist-tags': { latest: '0.0.1' }, versions }), { status: 200 });
    const report = await checkSpec('huge', { policy: policy({}), fetch, now: NOW, registry: 'https://registry.npmjs.org/', popular: new PopularNames([]) });
    expect(report.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'it cannot be checked: the registry lists more than 100000 versions of huge, more than depcurfew reads of one package, so its versions were not checked',
        fix: 'Check huge by hand before installing it: a real package has far fewer versions, so the registry may be answering with something made to slow checks down',
      },
    ]);
  });

  it('counts the members of a field from the text, before parsing, as JSON reads it', () => {
    const limits = { versions: 2, files: 3 };
    expect(tooManyMembers('{"versions":{"1":{},"2":{}}}', limits)).toBeUndefined();
    expect(tooManyMembers('{"versions":{"1":{},"2":{},"3":{}}}', limits)).toBe('versions');
    // Keys and values with commas, quotes and backslashes in strings, and nested containers, do not count.
    expect(tooManyMembers(String.raw`{"a":"x,\"y","versions":{"1,2":{"k":[1,2,3]},"3\\":"v,w"}}`, limits)).toBeUndefined();
    // A key written with escapes is the same key, and a field given twice is counted each time.
    expect(tooManyMembers(String.raw`{"versions":{"1":1,"2":2,"3":3}}`, limits)).toBe('versions');
    expect(tooManyMembers('{"versions":{},"versions":{"1":1,"2":2,"3":3}}', limits)).toBe('versions');
    // Arrays count their elements; empty containers have none.
    expect(tooManyMembers('{"files":[{"a":1},{"b":[1,2]},"c"],"versions":[]}', limits)).toBeUndefined();
    expect(tooManyMembers('{"files":[1,2,3,4]}', limits)).toBe('files');
    expect(tooManyMembers('[1,2,3]', limits)).toBeUndefined();
  });

  it('fetches each document once when the hook checks against two policies', async () => {
    const root = repository({ cooldown: { minimum: '3d' } });
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '5d' } }));
    const asked: string[] = [];
    const counting: FetchLike = async (url, init) => {
      asked.push(url);
      return recordedFetch(url, init);
    };
    await hook('npm install lodash esbuild', join(root, 'sub'), root, { fetch: counting });
    expect(asked.sort()).toEqual(['https://registry.npmjs.org/esbuild', 'https://registry.npmjs.org/lodash']);
  });
});

describe('usage errors (A6, T16, T20b)', () => {
  it('prints an unknown hook with --json as a JSON document on stdout', async () => {
    const result = await exec(['check', '--hook', 'nope', '--json']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      errors: [{ code: 'usage', level: 'error', message: "unknown hook 'nope'; the hooks are claude-code", fix: "Run 'depcurfew check --help' for usage" }],
    });
    expect((await exec(['check', '--hook', 'cursor'])).stderr).toBe("error: unknown hook 'cursor'; the hooks are claude-code (usage)\n  fix: Run 'depcurfew check --help' for usage\n");
  });

  it('writes text usage errors with their level and code, and a missing option value plainly', async () => {
    expect((await exec(['bogus'])).stderr).toBe("error: unknown command 'bogus' (usage)\n  fix: Run 'depcurfew --help' for usage\n");
    const missing = await exec(['doctor', '--fail-on']);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.stderr).toBe("error: option '--fail-on' needs a value: --fail-on <level> (usage)\n  fix: Run 'depcurfew doctor --help' for its options\n");
    const json = await exec(['doctor', '--json', '--fail-on']);
    expect(JSON.parse(json.stdout)).toMatchObject({ errors: [{ code: 'usage', message: "option '--fail-on' needs a value: --fail-on <level>" }] });
  });

  it('refuses a --registry or --index that is not an http:// or https:// URL as a usage error', async () => {
    const registry = await exec(['check', '--registry', 'not-a-url', 'lodash']);
    expect(registry.code).toBe(EXIT_USAGE);
    expect(registry.stderr).toBe("error: --registry takes the http:// or https:// URL of an npm registry, such as https://registry.npmjs.org/, not 'not-a-url' (usage)\n  fix: Run 'depcurfew check --help' for usage\n");
    const index = await exec(['check', '--json', '--index', 'ftp://pypi.example/', 'pypi:requests']);
    expect(index.code).toBe(EXIT_USAGE);
    expect(JSON.parse(index.stdout)).toMatchObject({ errors: [{ code: 'usage', message: "--index takes the http:// or https:// URL of a Python package index, such as https://pypi.org/simple/, not 'ftp://pypi.example/'" }] });
    expect((await exec(['mcp', '--registry', 'nope'])).code).toBe(EXIT_USAGE);
  });
});
