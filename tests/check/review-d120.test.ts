// Fixes from the last verification of 1.3.0 (decision D-120): workspace patterns of package.json that took minutes to
// match (H3), the package sources of Poetry, PDM and Pipenv and uv's explicit indexes, which were not reported (M3),
// and a package missing from the checked index while the install may take it from another one (V9).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { MAX_WORKSPACE_PATTERN_LENGTH, MAX_WORKSPACE_PATTERNS, npmLocalPrefix } from '../../src/check/registry-settings.ts';
import { appliedPolicy, checkApplied } from '../../src/cli/check.ts';
import type { CheckRequest } from '../../src/check/findings.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { recordedFetch } from './support.ts';

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

function directory(prefix = 'depcurfew-d120-'): string {
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

async function exec(argv: string[], options: { stdin?: string; projectDir?: string; fetch?: FetchLike } = {}): Promise<Result> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => NOW,
    stdin: async () => options.stdin ?? '',
    home: () => HOME,
    projectDir: () => options.projectDir,
  });
  return { code, stdout, stderr };
}

function event(command: string, cwd: string): string {
  return JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
}

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, cwd: string, projectDir: string, args: string[] = []): Promise<Output> {
  const result = await exec(['check', '--hook', 'claude-code', ...args], { stdin: event(command, cwd), projectDir });
  expect(result.code).toBe(EXIT_OK);
  return result.stdout === '' ? {} : (JSON.parse(result.stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

/** The fix a person gets for the last finding of one request in `root`, checked as the hook checks it there. */
async function fixFor(root: string, request: CheckRequest): Promise<string | undefined> {
  const result = appliedPolicy(root, { registry: undefined, home: HOME, project: root });
  if (!result.ok) throw new Error(result.error.message);
  const { reports } = await checkApplied([request], result.applied, { fetch: recordedFetch, now: NOW });
  return reports[0]?.findings.at(-1)?.fix;
}

function elapsed(action: () => void): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

/** A directory `depth` levels below `root`, each named `name`, with a package.json of its own at the bottom. */
function deepPackage(root: string, depth: number, name = 'd'): string {
  const deep = join(root, ...Array.from({ length: depth }, () => name));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'package.json'), '{}');
  return deep;
}

describe('workspace patterns made to take long (H3)', () => {
  it('matches a pattern of many ** against a deep directory in well under a second', () => {
    const root = directory();
    const deep = deepPackage(root, 18);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: [`${'**/'.repeat(18)}zzz`] }));
    let found: ReturnType<typeof npmLocalPrefix> | undefined;
    expect(elapsed(() => (found = npmLocalPrefix(deep)))).toBeLessThan(1000);
    expect(found).toEqual({ prefix: expect.stringMatching(/[/\\]d$/u) });
    // The same pattern ending in the name of the directory still makes the root the prefix, as npm's glob does.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: [`${'**/'.repeat(18)}d`] }));
    expect(npmLocalPrefix(deep)).toEqual({ prefix: expect.not.stringMatching(/[/\\]d$/u), workspace: expect.stringMatching(/[/\\]d$/u) });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['**/d/**/d/d', 'x/**'] }));
    expect(npmLocalPrefix(deep).workspace).toMatch(/[/\\]d$/u);
  });

  it('answers the hook quickly for that package.json', async () => {
    const root = repository({ cooldown: { minimum: '3d' } });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: [`${'**/'.repeat(18)}zzz`] }));
    const deep = deepPackage(root, 18);
    const start = performance.now();
    expect(await hook('npm install lodash', deep, root)).toEqual({});
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it.each([
    ['one pattern of 1 MiB', () => [`${'**/'.repeat(349_000)}zzz`]],
    ['more patterns than depcurfew reads', () => Array.from({ length: 60_000 }, (_, index) => `**/p${index}/**`)],
    ['the most patterns, each as long as depcurfew reads, of ** and short names', () =>
      Array.from({ length: MAX_WORKSPACE_PATTERNS }, () => `${'**/d/'.repeat(MAX_WORKSPACE_PATTERN_LENGTH / 5 - 1)}zzzz`)],
    ['the most patterns of stars against long names', () =>
      Array.from({ length: MAX_WORKSPACE_PATTERNS }, () => `**/${'*d'.repeat(120)}x/**/${'*d'.repeat(120)}x/**/${'*d'.repeat(120)}x`)],
  ])('matches %s against an 18-deep directory in under a second', (_, patterns) => {
    const root = directory();
    const deep = deepPackage(root, 18, 'd'.repeat(180));
    const text = JSON.stringify({ workspaces: patterns() });
    expect(text.length).toBeLessThanOrEqual(1024 * 1024);
    writeFileSync(join(root, 'package.json'), text);
    let found: ReturnType<typeof npmLocalPrefix> | undefined;
    expect(elapsed(() => (found = npmLocalPrefix(deep)))).toBeLessThan(1000);
    expect(found?.prefix).toMatch(/d$/u);
    expect(found?.workspace).toBeUndefined();
  });

  it('matches the most patterns against a directory of many short names in under a second', () => {
    const root = directory();
    const deep = deepPackage(root, 900);
    const patterns = Array.from({ length: MAX_WORKSPACE_PATTERNS }, () => `${'**/d/'.repeat(MAX_WORKSPACE_PATTERN_LENGTH / 5 - 1)}zzzz`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: patterns }));
    expect(elapsed(() => expect(npmLocalPrefix(deep).workspace).toBeUndefined())).toBeLessThan(1000);
  });

  it('keeps the nearer directory beyond the limits, says so, and reports a registry the .npmrc of the workspace root sets', async () => {
    const patterns = [...Array.from({ length: MAX_WORKSPACE_PATTERNS }, (_, index) => `other/p${index}`), 'app'];
    const root = repository(
      { cooldown: { minimum: '3d' } },
      { 'sub/package.json': JSON.stringify({ name: 'sub', workspaces: patterns }), 'sub/.npmrc': 'registry=https://evil.example/\n', 'sub/app/package.json': '{"name":"app"}' },
    );
    expect(npmLocalPrefix(join(root, 'sub', 'app'))).toEqual({
      prefix: expect.stringMatching(/app$/u),
      unsure: [{ root: expect.stringMatching(/sub$/u), reason: `it lists more than ${MAX_WORKSPACE_PATTERNS} patterns` }],
    });
    const answer = await hook('npm install lodash', join(root, 'sub', 'app'), root);
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('- lodash: the install would use the registry https://evil.example/ from sub/.npmrc (line 1); depcurfew checked https://registry.npmjs.org/');
    expect(answer.additionalContext).toContain(
      `- the workspaces of sub/package.json were not matched: it lists more than ${MAX_WORKSPACE_PATTERNS} patterns; depcurfew cannot tell whether npm takes sub for the workspace root, so a registry the .npmrc there sets counts as one depcurfew did not check`,
    );
    const checked = await exec(['check', '--json', '--dir', join(root, 'sub', 'app'), 'lodash']);
    expect(checked.code).toBe(EXIT_FAILURE);
    const notices = (JSON.parse(checked.stdout) as { notices: { code: string; location?: { file: string }; message: string; fix?: string }[] }).notices;
    expect(notices).toContainEqual({
      level: 'note',
      code: 'config-not-read',
      location: { file: '../package.json' },
      message: `the workspaces of ../package.json were not matched: it lists more than ${MAX_WORKSPACE_PATTERNS} patterns; depcurfew cannot tell whether npm takes .. for the workspace root, so a registry the .npmrc there sets counts as one depcurfew did not check`,
      fix: `Keep the workspaces of ../package.json to at most ${MAX_WORKSPACE_PATTERNS} patterns of at most ${MAX_WORKSPACE_PATTERN_LENGTH} characters (a glob such as packages/* covers many directories), so that depcurfew can tell which .npmrc npm reads`,
    });
    // A pattern longer than depcurfew reads is said as such.
    writeFileSync(join(root, 'sub', 'package.json'), JSON.stringify({ name: 'sub', workspaces: [`${'x/'.repeat(MAX_WORKSPACE_PATTERN_LENGTH)}app`, 'app'] }));
    expect(npmLocalPrefix(join(root, 'sub', 'app')).unsure?.[0]?.reason).toBe(`a pattern in it is longer than ${MAX_WORKSPACE_PATTERN_LENGTH} characters`);
  });
});

/** pyproject.toml of a project with `extra` after its [project] table. */
const pyproject = (extra: string) => `[project]\nname = "app"\n\n${extra}`;

describe('the package sources of Poetry, PDM and Pipenv (M3)', () => {
  it('asks about a primary or supplemental Poetry source, but not about the index depcurfew checked or an explicit source', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'pyproject.toml': pyproject('[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple/"\npriority = "primary"\n') });
    const primary = await hook('poetry add requests', root, root);
    expect(primary.permissionDecision).toBe('ask');
    expect(primary.permissionDecisionReason).toContain('- pypi:requests: the install would use the index https://pypi.corp.example/simple/ from pyproject.toml (line 4); depcurfew checked https://pypi.org/simple/');
    expect(await fixFor(root, { spec: 'pypi:requests', tool: 'poetry' })).toBe(
      'Before installing it, check the package in the index that pyproject.toml names; if you trust that index, pass --index https://pypi.corp.example/simple/ to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
    );
    expect((await hook('poetry add requests', root, root, ['--index', 'https://pypi.corp.example/simple'])).permissionDecisionReason ?? '').not.toContain('the install');
    // No priority is primary too, and so is a value Poetry 2 does not know (default of Poetry 1.x), in any case.
    for (const priority of ['', 'priority = "default"\n', 'priority = "Primary"\n']) {
      writeFileSync(join(root, 'pyproject.toml'), pyproject(`[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple/"\n${priority}`));
      expect((await hook('poetry add requests', root, root)).permissionDecisionReason).toContain('the install would use the index https://pypi.corp.example/simple/ from pyproject.toml (line 4)');
    }
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple/"\npriority = "supplemental"\n'));
    expect((await hook('poetry add requests', root, root)).permissionDecisionReason).toContain(
      '- pypi:requests: the install may also take it from https://pypi.corp.example/simple/ that pyproject.toml (line 4) adds; depcurfew checked only https://pypi.org/simple/',
    );
    // PyPI named as a primary source (without a URL, as Poetry wants it) is the index depcurfew checked.
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.poetry.source]]\nname = "PyPI"\npriority = "primary"\n\n[[tool.poetry.source]]\nname = "torch"\nurl = "https://download.pytorch.org/whl/cpu"\npriority = "explicit"\n'));
    expect((await hook('poetry add requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    // Other tools do not read Poetry's sources.
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple/"\n'));
    expect((await hook('pip install requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    expect((await hook('uv add requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
  });

  it('asks about a package that a Poetry dependency pins to an explicit source', async () => {
    const root = repository(
      { cooldown: { minimum: '3d' } },
      {
        'pyproject.toml': pyproject(
          '[tool.poetry.dependencies]\nrequests = { version = "*", source = "corp" }\n\n[tool.poetry.group.docs.dependencies]\nMid_Py = [{ version = "<2", python = "<3.9", source = "corp" }, { version = "^2", python = ">=3.9" }]\n\n[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple/"\npriority = "explicit"\n',
        ),
      },
    );
    const pinned = await hook('poetry add requests', root, root);
    expect(pinned.permissionDecision).toBe('ask');
    expect(pinned.permissionDecisionReason).toContain(
      '- pypi:requests: the install would use the index https://pypi.corp.example/simple/ from pyproject.toml (line 10), to which pyproject.toml (line 5) pins it; depcurfew checked https://pypi.org/simple/',
    );
    expect(await fixFor(root, { spec: 'pypi:requests', tool: 'poetry' })).toBe(
      'Before installing it, check the package in the index that pyproject.toml pins it to: depcurfew checks one index for every Python package of a command, so it cannot vouch for one that comes from another; depcurfew check --index https://pypi.corp.example/simple/ pypi:requests checks it there',
    );
    // A dependency of a group, by its normalized name; a package that is not pinned comes from PyPI.
    expect((await hook('poetry add mid.py', root, root)).permissionDecisionReason).toContain(
      '- pypi:mid.py: pypi:mid-py does not exist in https://pypi.org/simple/, but pyproject.toml (line 8) pins it to the index https://pypi.corp.example/simple/ set in pyproject.toml (line 10), which depcurfew did not check',
    );
    expect((await hook('poetry add ruff', root, root)).permissionDecisionReason ?? '').not.toContain('pins it');
  });

  it('asks about a PDM source, which adds an index, unless it is named pypi and is the index depcurfew checked', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'pyproject.toml': pyproject('[[tool.pdm.source]]\nname = "private"\nurl = "https://pypi.corp.example/simple"\nverify_ssl = true\n') });
    expect((await hook('pdm add requests', root, root)).permissionDecisionReason).toContain(
      '- pypi:requests: the install may also take it from https://pypi.corp.example/simple that pyproject.toml (line 4) adds; depcurfew checked only https://pypi.org/simple/',
    );
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.pdm.source]]\nname = "pypi"\nurl = "https://pypi.corp.example/simple"\n'));
    expect((await hook('pdm add requests', root, root)).permissionDecisionReason).toContain('- pypi:requests: the install would use the index https://pypi.corp.example/simple from pyproject.toml (line 4)');
    expect((await hook('pdm add requests', root, root, ['--index', 'https://pypi.corp.example/simple/'])).permissionDecisionReason ?? '').not.toContain('the install');
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.pdm.source]]\nname = "pypi"\nurl = "https://pypi.org/simple"\n'));
    expect((await hook('pdm add requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.pdm.source]]\nname = "pypi"\nurl = "https://pypi.org/simple"\ntype = "find_links"\n'));
    expect((await hook('pdm add requests', root, root)).permissionDecisionReason).toContain('the install may also take it from https://pypi.org/simple that pyproject.toml (line 4) adds');
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[[tool.pdm.source]]\nname = "local"\nurl = "file:///${PROJECT_ROOT}/packages"\ntype = "find_links"\n'));
    expect((await hook('pdm add requests', root, root)).permissionDecisionReason).toContain('the install may also take it from the places that pyproject.toml (line 4) adds');
  });

  it('asks about the first Pipfile source, which is the default index, and a package pinned to another', async () => {
    const pipfile = (first: string, extra = '') =>
      `[[source]]\nurl = "${first}"\nverify_ssl = true\nname = "pypi"\n\n[[source]]\nurl = "https://pypi.corp.example/simple"\nverify_ssl = true\nname = "corp"\n\n[packages]\nmid-py = { version = "*", index = "corp" }\nrequests = "*"\n${extra}`;
    const root = repository({ cooldown: { minimum: '3d' } }, { Pipfile: pipfile('https://pypi.org/simple') });
    expect((await hook('pipenv install requests', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    const pinned = await hook('pipenv install mid-py', root, root);
    expect(pinned.permissionDecision).toBe('ask');
    expect(pinned.permissionDecisionReason).toContain(
      '- pypi:mid-py: pypi:mid-py does not exist in https://pypi.org/simple/, but Pipfile (line 12) pins it to the index https://pypi.corp.example/simple set in Pipfile (line 6), which depcurfew did not check',
    );
    writeFileSync(join(root, 'Pipfile'), pipfile('https://pypi.mirror.example/simple'));
    expect((await hook('pipenv install requests', root, root)).permissionDecisionReason).toContain('- pypi:requests: the install would use the index https://pypi.mirror.example/simple from Pipfile (line 1)');
    // install_search_all_sources makes pipenv install look in every source.
    writeFileSync(join(root, 'Pipfile'), pipfile('https://pypi.org/simple', '\n[pipenv]\ninstall_search_all_sources = true\n'));
    expect((await hook('pipenv install requests', root, root)).permissionDecisionReason).toContain(
      '- pypi:requests: the install may also take it from https://pypi.corp.example/simple that Pipfile (line 6) adds',
    );
  });
});

describe("uv's explicit indexes (M3)", () => {
  it('asks about a package that tool.uv.sources pins to an explicit index, also one defined in uv.toml', async () => {
    // A cooldown the recorded ruff passes, so that no denial hides the question.
    const root = repository(
      { cooldown: { minimum: '1d' } },
      { 'pyproject.toml': pyproject('[tool.uv.sources]\nrequests = { index = "corp" }\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\nexplicit = true\n') },
    );
    const pinned = await hook('uv add requests', root, root);
    expect(pinned.permissionDecision).toBe('ask');
    expect(pinned.permissionDecisionReason).toContain(
      '- pypi:requests: the install would use the index https://pypi.corp.example/simple from pyproject.toml (line 7), to which pyproject.toml (line 5) pins it; depcurfew checked https://pypi.org/simple/',
    );
    expect((await hook('uv add requests', root, root, ['--index', 'https://pypi.corp.example/simple'])).permissionDecisionReason ?? '').not.toContain('the install');
    expect((await hook('uv add ruff', root, root)).permissionDecisionReason ?? '').not.toContain('the install');
    // A list of sources by environment marker, and an index of uv.toml.
    writeFileSync(join(root, 'pyproject.toml'), pyproject('[tool.uv.sources]\nruff = [\n  { index = "cpu", marker = "sys_platform == \'darwin\'" },\n  { git = "https://github.com/astral-sh/ruff" },\n]\n'));
    writeFileSync(join(root, 'uv.toml'), '[[index]]\nname = "cpu"\nurl = "https://download.pytorch.org/whl/cpu"\nexplicit = true\n');
    expect((await hook('uv add ruff requests', root, root)).permissionDecisionReason).toContain(
      '- pypi:ruff: the install would use the index https://download.pytorch.org/whl/cpu from uv.toml (line 1), to which pyproject.toml (line 5) pins it; depcurfew checked https://pypi.org/simple/',
    );
    expect((await hook('uv add ruff requests', root, root)).permissionDecisionReason).not.toContain('pypi:requests');
  });
});

describe('a package missing from the checked registry or index while the install may take it from another (V9)', () => {
  it('asks instead of denying when uv adds an index and the version is not on PyPI', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'uv.toml': '[[index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n' });
    const version = await hook('uv add requests==2.31.0', root, root);
    expect(version.permissionDecision).toBe('ask');
    expect(version.permissionDecisionReason).toMatch(
      /- pypi:requests==2\.31\.0: no version of pypi:requests matches "==2\.31\.0"[^\n]* in https:\/\/pypi\.org\/simple\/, but it may come from the index https:\/\/pypi\.corp\.example\/simple that uv\.toml \(line 1\) adds, which depcurfew did not check\. Fix:/u,
    );
    writeFileSync(join(root, 'uv.toml'), 'extra-index-url = ["https://pypi.corp.example/simple"]\n');
    expect((await hook('uv add requests==2.31.0', root, root)).permissionDecisionReason).toContain('in https://pypi.org/simple/, but it may come from the places that uv.toml (line 1) adds, which depcurfew did not check');
    writeFileSync(join(root, 'uv.toml'), '[[index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n');
    const missing = await hook('uv add mid-py', root, root);
    expect(missing.permissionDecision).toBe('ask');
    expect(missing.permissionDecisionReason).toContain(
      '- pypi:mid-py: pypi:mid-py does not exist in https://pypi.org/simple/, but it may come from the index https://pypi.corp.example/simple that uv.toml (line 1) adds, which depcurfew did not check. Fix:',
    );
    writeFileSync(join(root, 'uv.toml'), 'index-url = "${CORP_INDEX}"\n');
    expect((await hook('uv add mid-py', root, root)).permissionDecisionReason).toContain(
      'pypi:mid-py does not exist in https://pypi.org/simple/, but it may come from the index set in uv.toml (line 1), which depcurfew did not check',
    );
    // A setting that names the index depcurfew checked changes nothing: the package is missing where the install looks.
    writeFileSync(join(root, 'uv.toml'), 'index-url = "https://pypi.org/simple"\n');
    expect((await hook('uv add mid-py', root, root)).permissionDecision).toBe('deny');
  });

  it('asks instead of denying when an .npmrc depcurfew does not take names another registry', async () => {
    const root = repository({ cooldown: { minimum: '3d' } }, { 'sub/package.json': '{}', 'sub/.npmrc': 'registry=https://npm.corp.example/\n' });
    const missing = await hook('npm install corp-only-package lodash@99.0.0', join(root, 'sub'), root);
    expect(missing.permissionDecision).toBe('ask');
    expect(missing.permissionDecisionReason).toContain(
      '- corp-only-package: corp-only-package does not exist in https://registry.npmjs.org/, but it may come from the registry https://npm.corp.example/ set in sub/.npmrc (line 1), which depcurfew did not check',
    );
    expect(missing.permissionDecisionReason).toContain(
      '- lodash@99.0.0: no version of lodash matches "99.0.0" in https://registry.npmjs.org/, but it may come from the registry https://npm.corp.example/ set in sub/.npmrc (line 1), which depcurfew did not check',
    );
    const checked = await exec(['check', '--json', '--dir', join(root, 'sub'), 'corp-only-package']);
    expect(checked.code).toBe(EXIT_FAILURE);
    expect((JSON.parse(checked.stdout) as { packages: { findings: unknown[] }[] }).packages[0]?.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'corp-only-package does not exist in https://registry.npmjs.org/, but it may come from the registry https://npm.corp.example/ set in .npmrc (line 1), which depcurfew did not check',
        fix: 'Before installing it, check the package in the registry that .npmrc names; if you trust that registry, pass --registry https://npm.corp.example/ to depcurfew check in the hook command (.claude/settings.json), to depcurfew mcp, or on the command line',
      },
    ]);
    // Without such a setting a missing package still breaks the policy.
    expect((await hook('npm install corp-only-package', root, root)).permissionDecision).toBe('deny');
  });
});
