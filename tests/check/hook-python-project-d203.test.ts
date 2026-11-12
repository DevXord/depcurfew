// Decision D-203: in check, the Claude Code hook and depcurfew mcp, "." and ".[extras]" name the project itself only when
// the packages are installed in the directory of the policy that applies or in one of its projects. Until 1.6.0 the hook
// denied "pip install -e '.[dev]'" in the project under sources.directory "deny", and let "cd vendor/evil && pip install
// -e ." through as "the project itself", while "pip install -e ./vendor/evil" was denied. Elsewhere "." is a local
// directory, which sources.directory decides; a directory the hook cannot tell names no project either.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSpec, type CheckOptions } from '../../src/check/index.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { PopularNames } from '../../src/check/similar.ts';
import { checkDocument } from '../../src/cli/check.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../../src/cli/run.ts';
import { policy } from './support.ts';

const NOW = new Date('2026-11-11T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix = 'depcurfew-d203-'): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(created);
  return created;
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

const DENY_DIRECTORIES = { cooldown: { minimum: '1d' }, installScripts: { default: 'deny' }, sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'deny' }, projects: ['packages/api'] };
const project = (name: string) => `[project]\nname = "${name}"\nversion = "1.0"\n`;

/** A git repository with a policy at the root, a listed project packages/api and a vendored package vendor/evil. */
function repository(document: object | null = DENY_DIRECTORIES): string {
  const root = directory();
  mkdirSync(join(root, '.git'));
  write(root, {
    ...(document === null ? {} : { 'depcurfew.json': JSON.stringify({ version: 1, ...document }) }),
    'pyproject.toml': project('app'),
    'packages/api/pyproject.toml': project('api'),
    'vendor/evil/pyproject.toml': project('evil'),
  });
  return root;
}

/** Nothing is looked up: "." is never sent to an index. */
const offline: FetchLike = () => Promise.reject(new Error('no network in tests'));

type Output = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };

async function hook(command: string, root: string, options: { cwd?: string; tool?: string } = {}): Promise<Output> {
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: options.tool ?? 'Bash', tool_input: { command }, cwd: options.cwd ?? root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: offline,
    now: () => NOW,
    stdin: async () => event,
    home: () => root,
    projectDir: () => root,
    osvData: () => undefined,
  });
  expect(code).toBe(EXIT_OK);
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput: Output }).hookSpecificOutput;
}

const LOCAL = 'it installs from a local directory';

describe('the hook: "." and ".[extras]" in the directory of the policy or of one of its projects (decision D-203)', () => {
  it.each([
    "pip install -e '.[dev]'",
    'pip install -e ".[dev,docs]"',
    "pip install '.[dev]'",
    "pip install -e './[dev]'",
    "uv pip install -e '.[dev]'",
    "python -m pip install -e '.[dev]'",
    'pip install -e .',
    'pip install .',
    // bash takes the backslash off, so pip gets .[dev] and the shell expands nothing.
    'pip install -e .\\[dev]',
  ])('is the project itself under sources.directory "deny": %s', async (command) => {
    const answer = await hook(command, repository());
    expect(answer.permissionDecision).toBeUndefined();
    expect(answer.additionalContext).toContain('it is the project itself');
  });

  it('is the project in a directory the policy lists under projects', async () => {
    const root = repository();
    expect((await hook("cd packages/api && pip install -e '.[dev]'", root)).permissionDecision).toBeUndefined();
    expect((await hook('pip install -e .', root, { cwd: join(root, 'packages', 'api') })).permissionDecision).toBeUndefined();
    expect((await hook("uv --directory packages/api pip install -e '.[dev]'", root)).permissionDecision).toBeUndefined();
  });

  it('reads the Windows form with a backslash in PowerShell', async () => {
    const root = repository();
    const answer = await hook('pip install -e .\\[dev]', root, { tool: 'PowerShell' });
    expect(answer.permissionDecision).toBeUndefined();
    expect(answer.additionalContext).toContain('it is the project itself');
    expect((await hook('cd vendor\\evil; pip install -e .\\[dev]', root, { tool: 'PowerShell' })).permissionDecision).toBe('deny');
  });

  it('keeps asking about an unquoted -e .[dev], which the shell may expand', async () => {
    const answer = await hook('pip install -e .[dev]', repository());
    expect(answer.permissionDecision).toBe('ask');
    expect(answer.permissionDecisionReason).toContain('"-e .[dev]" is expanded by the shell');
  });
});

describe('the hook: "." in any other directory is a local directory (decision D-203)', () => {
  it.each([
    'cd vendor/evil && pip install -e .',
    "cd vendor/evil && pip install -e '.[dev]'",
    'cd vendor/evil; uv pip install -e .',
    'cd vendor && cd evil && pip install .',
    'pushd vendor/evil && pip install -e .',
    'uv --directory vendor/evil pip install -e .',
  ])('denies %s under sources.directory "deny"', async (command) => {
    const answer = await hook(command, repository());
    expect(answer.permissionDecision).toBe('deny');
    expect(answer.permissionDecisionReason).toContain(LOCAL);
    expect(answer.permissionDecisionReason).toContain('sources.directory');
  });

  it('denies it from the working directory as well, as pip install -e ./vendor/evil from the root', async () => {
    const root = repository();
    expect((await hook('pip install -e ./vendor/evil', root)).permissionDecision).toBe('deny');
    expect((await hook('pip install -e .', root, { cwd: join(root, 'vendor', 'evil') })).permissionDecision).toBe('deny');
  });

  it('denies it outside the project and in a directory the hook cannot tell', async () => {
    const root = repository();
    const outside = directory('depcurfew-d203-outside-');
    write(outside, { 'pyproject.toml': project('outside') });
    expect((await hook(`cd ${outside} && pip install -e .`, root)).permissionDecision).toBe('deny');
    expect((await hook('cd "$DIR" && pip install -e .', root)).permissionDecision).toBe('deny');
  });

  it('names the directory "." is and the directory of depcurfew.json', async () => {
    const root = repository();
    const reason = (await hook('cd vendor/evil && pip install -e .', root)).permissionDecisionReason;
    expect(reason).toContain('"." is vendor/evil, which is not the directory of depcurfew.json (.) or of one of its projects');
    mkdirSync(join(root, 'packages', 'api', 'sub'));
    const nested = (await hook('pip install -e .', root, { cwd: join(root, 'packages', 'api', 'sub') })).permissionDecisionReason;
    expect(nested).toContain('"." is packages/api/sub, which is not');
    const unknown = (await hook('cd "$DIR" && pip install -e .', root)).permissionDecisionReason;
    expect(unknown).toContain('"." is a directory depcurfew cannot tell');
  });

  it('names the project directory without a depcurfew.json', async () => {
    const answer = await hook('cd vendor/evil && pip install -e .', repository(null));
    // The default policy allows local directories, so the hook only warns.
    expect(answer.permissionDecision).toBeUndefined();
    expect(answer.additionalContext).toContain('"." is vendor/evil, which is not the project directory (.)');
  });

  it('only warns where the policy allows local directories', async () => {
    const answer = await hook('cd vendor/evil && pip install -e .', repository({ cooldown: { minimum: '1d' } }));
    expect(answer.permissionDecision).toBeUndefined();
    expect(answer.additionalContext).toContain(LOCAL);
    expect(answer.additionalContext).not.toContain('it is the project itself');
  });
});

type Document = { packages: { spec: string; kind: string; findings: { level: string; code: string; message: string; fix: string }[] }[] };

async function checkJson(root: string, ...argv: string[]): Promise<{ code: number; document: Document }> {
  let stdout = '';
  const code = await run(['check', '--json', ...argv], { stdout: (text) => (stdout += text), stderr: () => undefined }, { fetch: offline, now: () => NOW, stdin: async () => '', home: () => root, osvData: () => undefined });
  return { code, document: JSON.parse(stdout) as Document };
}

describe('depcurfew check and depcurfew mcp (decision D-203)', () => {
  it('check: pypi:.[dev] is the project in the directory of depcurfew.json, a local directory below it', async () => {
    const root = repository();
    const here = await checkJson(root, '--dir', root, 'pypi:.[dev]');
    expect(here.code).toBe(EXIT_OK);
    expect(here.document.packages[0]).toMatchObject({ spec: 'pypi:.[dev]', kind: 'workspace', findings: [{ level: 'warning', code: 'unchecked-source' }] });
    const vendored = await checkJson(root, '--dir', join(root, 'vendor', 'evil'), 'pypi:.');
    expect(vendored.code).toBe(EXIT_FAILURE);
    expect(vendored.document.packages[0]).toMatchObject({ spec: 'pypi:.', kind: 'directory', findings: [{ level: 'error', code: 'forbidden-source' }] });
    expect(vendored.document.packages[0]?.findings[0]?.message).toContain('sources.directory');
    // Paths are shown from --dir, as in the rest of the output of check.
    expect(vendored.document.packages[0]?.findings[0]?.message).toContain('"." is the directory the packages are installed in, which is not the directory of ../../depcurfew.json (../..) or of one of its projects');
    expect((await checkJson(root, '--dir', join(root, 'packages', 'api'), 'pypi:.')).document.packages[0]?.kind).toBe('workspace');
  });

  it('check_packages of depcurfew mcp: the same for its directory argument', async () => {
    const root = repository();
    const settings = { cwd: root, project: root, audience: 'agent' as const, registry: undefined, home: root, fetch: offline, now: NOW, scriptBodies: false };
    const at = async (dir: string | undefined) => (await checkDocument(['pypi:.[dev]'], { ...settings, dir })).document.packages[0];
    expect(await at(undefined)).toMatchObject({ kind: 'workspace' });
    expect(await at('packages/api')).toMatchObject({ kind: 'workspace' });
    expect(await at('vendor/evil')).toMatchObject({ kind: 'directory', findings: [{ level: 'error', code: 'forbidden-source' }] });
    expect((await at('vendor/evil'))?.findings[0]?.message).toContain('"." is vendor/evil, which is not the directory of depcurfew.json (.) or of one of its projects');
  });
});

describe('checkSpec of the library (decision D-203)', () => {
  const options = (overrides: Partial<CheckOptions> = {}): CheckOptions => ({
    policy: policy(DENY_DIRECTORIES),
    fetch: offline,
    now: NOW,
    registry: 'https://registry.npmjs.org/',
    popular: new PopularNames([]),
    popularPython: new PopularNames([]),
    ...overrides,
  });

  it('takes pypi:.[dev] for the project itself, as pypi:.', async () => {
    for (const spec of ['pypi:.', 'pypi:.[dev]', 'pypi:./[dev,docs]']) {
      expect(await checkSpec(spec, options()), spec).toMatchObject({ kind: 'workspace', findings: [{ level: 'warning', code: 'unchecked-source' }] });
    }
    for (const spec of ['pypi:.[]', 'pypi:..[dev]', 'pypi:./sub[dev]']) {
      expect(await checkSpec(spec, options()), spec).toMatchObject({ kind: 'directory', findings: [{ level: 'error', code: 'forbidden-source' }] });
    }
  });

  it('takes them for a local directory with projectRoot: false', async () => {
    const report = await checkSpec('pypi:.[dev]', options({ projectRoot: false }));
    expect(report).toMatchObject({ kind: 'directory', findings: [{ level: 'error', code: 'forbidden-source' }] });
    expect(report.findings[0]?.fix).toContain('sources.directory');
  });
});
