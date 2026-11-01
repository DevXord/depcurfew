// depcurfew init --json and init --user --json (decision D-122): stdout holds one JSON document with the file written
// (or why not), the projects and tools, and every warning and note with its code, level, location, message and fix;
// stderr stays empty and the exit codes are those of the text. The text gives every warning and note its level word,
// its code and its fix, from the same source.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { INIT_CODES } from '../../src/cli/init-codes.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { fakeMachine, shownPolicy } from '../support/user.ts';

const REPOS = fileURLToPath(new URL('../fixtures/repos/', import.meta.url));
const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(files: Record<string, string> = {}, fixture?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-init-json-'));
  temporary.push(root);
  if (fixture !== undefined) cpSync(join(REPOS, fixture), root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function exec(argv: string[], environment?: UserEnvironment): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-01T12:00:00Z'),
    stdin: () => Promise.resolve(''),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

interface Entry {
  code: string;
  level: string;
  location: { file: string; line?: number };
  message: string;
  fix: string;
}

interface InitDocument {
  schemaVersion: number;
  policy: string | null;
  written: boolean;
  action: string | null;
  projects: string[];
  tools: { tool: string; name: string; directory: string; supported: boolean }[] | null;
  warnings: Entry[];
  notices: Entry[];
  errors: Entry[];
}

async function json(argv: string[], environment?: UserEnvironment): Promise<{ code: number; document: InitDocument }> {
  const result = await exec([...argv, '--json'], environment);
  expect(result.stderr).toBe('');
  return { code: result.code, document: JSON.parse(result.stdout) as InitDocument };
}

describe('init --json', () => {
  it('prints the file it wrote, the tools and no warnings for a plain repository', async () => {
    const root = directory({}, 'pnpm11-dependabot');
    const { code, document } = await json(['init', root]);
    expect(code).toBe(EXIT_OK);
    expect(document).toEqual({
      schemaVersion: 1,
      policy: join(root, 'depcurfew.json'),
      written: true,
      action: 'create',
      projects: [],
      tools: [
        { tool: 'pnpm', name: 'pnpm', directory: '.', supported: true },
        { tool: 'dependabot', name: 'Dependabot', directory: '.', supported: true },
      ],
      warnings: [],
      notices: [],
      errors: [],
    });
    expect(Object.keys(document)).toEqual(['schemaVersion', 'policy', 'written', 'action', 'projects', 'tools', 'warnings', 'notices', 'errors']);
    expect(readFileSync(join(root, 'depcurfew.json'), 'utf8')).toBe(renderPolicy(DEFAULT_POLICY));
    const again = await json(['init', root, '--force']);
    expect(again).toMatchObject({ code: EXIT_OK, document: { written: true, action: 'overwrite' } });
  });

  it('prints an error that keeps it from writing as the errors of other commands, with the same exit codes', async () => {
    const root = directory({ 'depcurfew.json': '{ "version": 1 }\n' });
    const file = join(root, 'depcurfew.json');
    const { code, document } = await json(['init', root]);
    expect(code).toBe(EXIT_FAILURE);
    // The same fields in the same order as when it writes.
    expect(Object.keys(document)).toEqual(['schemaVersion', 'policy', 'written', 'action', 'projects', 'tools', 'warnings', 'notices', 'errors']);
    expect(document).toEqual({
      schemaVersion: 1,
      policy: file,
      written: false,
      action: null,
      projects: [],
      tools: [],
      warnings: [],
      notices: [],
      errors: [{ code: 'policy-exists', level: 'error', location: { file }, message: `${file} already exists`, fix: 'Pass --force to overwrite it with the default policy, or edit it by hand' }],
    });
    expect(readFileSync(file, 'utf8')).toBe('{ "version": 1 }\n');
    const missing = join(root, 'missing');
    const absent = await json(['init', missing]);
    expect(absent.code).toBe(EXIT_USAGE);
    expect(absent.document).toMatchObject({ policy: null, written: false, errors: [{ code: 'directory-not-found', level: 'error', location: { file: missing }, fix: 'Pass the path of an existing directory' }] });
    // A usage error is the document of every command's usage errors.
    const usage = await exec(['init', '--json', root, root]);
    expect(usage.code).toBe(EXIT_USAGE);
    expect(JSON.parse(usage.stdout)).toEqual({ schemaVersion: 1, errors: [{ code: 'usage', level: 'error', message: "too many arguments for 'init'", fix: "Run 'depcurfew init --help' for usage" }] });
  });

  it('gives every warning and note its code, level, location, message and fix, as the text does', async () => {
    const root = directory({
      'frontend/package.json': '{ "name": "frontend", "private": true }\n',
      'frontend/.npmrc': 'save-exact=true\nmin-release-age=10\n',
      'backend/pyproject.toml': '[project]\nname = "backend"\nversion = "1.0.0"\n',
      'backend/uv.lock': 'version = 1\n',
      'vendor/package.json': '{ "name": "vendor", "private": true }\n',
      'vendor/.git': 'gitdir: ../.git/modules/vendor\n',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n',
    });
    const { code, document } = await json(['init', root]);
    expect(code).toBe(EXIT_OK);
    const written = readFileSync(join(root, 'depcurfew.json'), 'utf8');
    const lineOf = (key: string) => written.split('\n').findIndex((line) => line.startsWith(`  "${key}"`)) + 1;
    expect(document.projects).toEqual(['backend', 'frontend']);
    expect(document.tools).toEqual([
      { tool: 'uv', name: 'uv', directory: 'backend', supported: true },
      { tool: 'npm', name: 'npm', directory: 'frontend', supported: true },
    ]);
    expect(document.warnings).toEqual([
      {
        code: 'project-left-out',
        level: 'warning',
        location: { file: 'vendor' },
        message: 'vendor is not in projects: it is a separate git repository (it has a .git of its own, as a git submodule does), whose files belong to that repository',
        fix: 'Run depcurfew init in vendor for it',
      },
    ]);
    expect(document.notices.map((entry) => [entry.code, entry.level, entry.location])).toEqual([
      ['projects-listed', 'note', { file: 'depcurfew.json', line: lineOf('projects') }],
      ['cooldown-kept', 'note', { file: 'frontend/.npmrc', line: 2 }],
      ['python-builds-denied', 'note', { file: 'depcurfew.json', line: lineOf('installScripts') + 1 }],
      ['tool-only-in-ci', 'note', { file: '.github/workflows/ci.yml' }],
    ]);
    expect(document.notices[1]?.message).toBe('cooldown.minimum is 10d instead of 3d, to keep the longest release-age delay already set: min-release-age=10 in frontend/.npmrc (line 2)');
    expect(document.notices[3]).toMatchObject({
      message: 'Bun is seen only in a CI setup step (.github/workflows/ci.yml), so depcurfew apply does not configure it',
      fix: 'Add "bun" to targets in depcurfew.json if it installs packages for this project',
    });
    for (const entry of [...document.warnings, ...document.notices]) {
      expect(Object.keys(entry)).toEqual(['code', 'level', 'location', 'message', 'fix']);
      expect(entry.fix).toMatch(/^[A-Z]/u);
      expect(entry.message).not.toMatch(/\.$/u);
    }

    // The text: the same messages, each with its level word, code and fix, from the same source.
    const text = await exec(['init', root, '--force']);
    expect(text.code).toBe(EXIT_OK);
    expect(text.stderr).toBe('');
    for (const entry of [...document.warnings, ...document.notices]) expect(text.stdout).toContain(`${entry.level}: ${entry.message} (${entry.code})\n  fix: ${entry.fix}\n`);
    for (const line of text.stdout.split('\n').filter((item) => item !== '' && !item.startsWith('  fix: '))) {
      expect(line).toMatch(/^(?:Overwrote .+ with the default policy\.|Detected tools: .+\.|(?:warning|note): .+ \([a-z-]+\))$/u);
    }
  });

  it('documents every code of init in the README, and the exit codes in its help', async () => {
    for (const code of Object.keys(INIT_CODES)) expect(README, code).toContain(`- \`${code}\`: `);
    const help = (await exec(['init', '--help'])).stdout;
    expect(help).toContain('--json');
    expect(help).toMatch(/^ {2}0 {2}.+$/mu);
    expect(help).toMatch(/^ {2}1 {2}.+$/mu);
    expect(help).toMatch(/^ {2}2 {2}a usage error, such as an unknown option or a missing directory$/mu);
  });
});

describe('init --user --json', () => {
  it('prints the user policy it wrote and the delay it kept, with its place', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    writeFileSync(join(machine.home, '.npmrc'), 'save-exact=true\nmin-release-age=7\n');
    const { code, document } = await json(['init', '--user'], machine);
    expect(code).toBe(EXIT_OK);
    expect(document).toEqual({
      schemaVersion: 1,
      policy: shownPolicy(machine),
      written: true,
      action: 'create',
      projects: [],
      tools: null,
      warnings: [],
      notices: [
        {
          code: 'cooldown-kept',
          level: 'note',
          location: { file: '~/.npmrc', line: 2 },
          message: 'cooldown.minimum is 7d instead of 3d, to keep the longest release-age delay already set: min-release-age=7 in ~/.npmrc (line 2)',
          fix: expect.stringMatching(/^Leave cooldown\.minimum as it is to keep that delay, or lower it in .+ before you run depcurfew apply --user$/u),
        },
      ],
      errors: [],
    });
    const text = await exec(['init', '--user', '--force'], machine);
    expect(text.stdout).toContain(`note: ${document.notices[0]?.message ?? ''} (cooldown-kept)\n  fix: ${document.notices[0]?.fix ?? ''}\n`);
  });

  it('prints the errors of init --user as a document', async () => {
    const machine = fakeMachine({}, temporary);
    const policy = userPolicyPath(machine);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, '{ "version": 1 }\n');
    const { code, document } = await json(['init', '--user'], machine);
    expect(code).toBe(EXIT_FAILURE);
    expect(document).toMatchObject({ policy: shownPolicy(machine), written: false, action: null, tools: null, errors: [{ code: 'policy-exists', level: 'error', location: { file: shownPolicy(machine) } }] });
    const homeless = await json(['init', '--user'], { ...machine, home: join(machine.root, 'nowhere') });
    expect(homeless.code).toBe(EXIT_FAILURE);
    expect(homeless.document.errors.map((error) => error.code)).toEqual(['home-missing']);
    // --user takes no directory: a usage error, as a document.
    const usage = await exec(['init', '--user', '--json', machine.root], machine);
    expect(usage.code).toBe(EXIT_USAGE);
    expect(JSON.parse(usage.stdout)).toMatchObject({ schemaVersion: 1, errors: [{ code: 'usage' }] });
  });
});
