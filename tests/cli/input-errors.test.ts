// What every command says when it cannot start: a directory that does not exist or is a file, and a depcurfew.json
// that cannot be read. Text gets a message with the code and what to do, --json (and --sarif) a document on stdout
// with nothing on stderr, never a stack trace. Tests may run as root, which reads any file whatever its mode, so the
// read error is simulated in node:fs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAILURE, EXIT_USAGE, run } from '../../src/cli/run.ts';

const failing = vi.hoisted(() => ({ suffix: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
    if (failing.suffix !== undefined && String(path).endsWith(failing.suffix)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${String(path)}'`), { code: 'EACCES', errno: -13, syscall: 'open', path: String(path) });
    }
    return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, readFileSync, default: { ...fs, readFileSync } };
});

const temporary: string[] = [];
afterEach(() => {
  failing.suffix = undefined;
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-input-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1 }\n');
  writeFileSync(join(directory, 'package.json'), '{ "name": "app", "packageManager": "npm@12.2.1" }\n');
  return directory;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch: async () => new Response('{"error":"Not found"}', { status: 404 }),
    now: () => new Date('2026-10-30T12:00:00Z'),
    stdin: async () => '',
    home: () => tmpdir(),
  });
  return { code, stdout, stderr };
}

describe('a depcurfew.json that cannot be read', () => {
  const unreadable = () => {
    const directory = project();
    // The directory's own name and the file, whatever form of the temporary directory's path is read (8.3 names on Windows).
    failing.suffix = join(basename(directory), 'depcurfew.json');
    return directory;
  };
  // The reading layer names the error code and leaves out the absolute path (decision D-076).
  const message = (_directory: string) => 'cannot read depcurfew.json (EACCES: permission denied)';
  const fix = 'Make depcurfew.json a regular file inside the repository that the user running depcurfew can read';

  it('apply reports it with its code and what to do', async () => {
    const directory = unreadable();
    expect(await exec('apply', directory)).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `error: ${message(directory)} (policy-unreadable)\n  fix: ${fix}\n` });
  });

  it('apply --json reports it as JSON', async () => {
    const directory = unreadable();
    const result = await exec('apply', '--json', directory);
    expect([result.code, result.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(JSON.parse(result.stdout)).toMatchObject({ policy: 'invalid', errors: [{ code: 'policy-unreadable', level: 'error', location: { file: 'depcurfew.json' }, message: message(directory), fix }] });
  });

  it('doctor reports it as an invalid-policy finding in every format', async () => {
    const directory = unreadable();
    const text = await exec('doctor', directory);
    expect([text.code, text.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(text.stdout).toContain(`depcurfew.json\n  error ${message(directory)} (invalid-policy)\n    fix: ${fix}\n`);
    const json = await exec('doctor', '--json', directory);
    expect([json.code, json.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(JSON.parse(json.stdout)).toMatchObject({ policy: 'invalid', findings: [{ rule: 'invalid-policy', message: message(directory), fix }], errors: [] });
    const sarif = await exec('doctor', '--sarif', directory);
    expect([sarif.code, sarif.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(JSON.parse(sarif.stdout)).toMatchObject({ runs: [{ results: [{ ruleId: 'invalid-policy' }] }] });
  });

  it('check reports it with its code, and --json as JSON', async () => {
    const directory = unreadable();
    // Relative to the directory check works on, as in apply --json.
    const file = 'depcurfew.json';
    expect(await exec('check', '--dir', directory, 'lodash')).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `error: ${message(directory)} (policy-unreadable)\n  fix: ${fix}\n` });
    const json = await exec('check', '--json', '--dir', directory, 'lodash');
    expect([json.code, json.stderr]).toEqual([EXIT_FAILURE, '']);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      policy: file,
      packages: [],
      notices: [],
      errors: [{ code: 'policy-unreadable', level: 'error', location: { file }, message: message(directory), fix }],
    });
  });

  it('explain lists it as the problem of the policy', async () => {
    const directory = unreadable();
    const result = await exec('explain', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(result.stdout)).toMatchObject({
      policy: { file: 'depcurfew.json', valid: false, issues: [message(directory)] },
      errors: [{ code: 'policy-unreadable', level: 'error', location: { file: 'depcurfew.json' }, message: message(directory), fix }],
    });
  });
});

describe('a directory that does not exist or is a file', () => {
  const missing = join(tmpdir(), 'depcurfew-input-missing', 'x');
  const notFound = { code: 'directory-not-found', level: 'error', location: { file: missing }, message: `directory not found: ${missing}`, fix: 'Pass the path of an existing directory' };

  it.each([['apply'], ['doctor'], ['explain'], ['init']])('%s reports it as a usage error with its code', async (command) => {
    expect(await exec(command, missing)).toEqual({ code: EXIT_USAGE, stdout: '', stderr: `error: directory not found: ${missing} (directory-not-found)\n  fix: Pass the path of an existing directory\n` });
  });

  it('check --dir reports it as a usage error', async () => {
    expect(await exec('check', '--dir', missing, 'pypi:foo')).toEqual({ code: EXIT_USAGE, stdout: '', stderr: `error: directory not found: ${missing} (directory-not-found)\n  fix: Pass the path of an existing directory\n` });
  });

  it('check --dir with a file reports that it is not a directory', async () => {
    const file = join(project(), 'package.json');
    expect(await exec('check', '--dir', file, 'pypi:foo')).toEqual({
      code: EXIT_USAGE,
      stdout: '',
      stderr: `error: not a directory: ${file} (not-a-directory)\n  fix: Pass the directory of the project, not a file in it\n`,
    });
  });

  it('check --json prints a document with the error', async () => {
    const result = await exec('check', '--json', '--dir', missing, 'pypi:foo');
    expect([result.code, result.stderr]).toEqual([EXIT_USAGE, '']);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, policy: null, packages: [], notices: [], errors: [notFound] });
  });

  it('apply --json prints a document with the error', async () => {
    const result = await exec('apply', '--json', missing);
    expect([result.code, result.stderr]).toEqual([EXIT_USAGE, '']);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      policy: null,
      dryRun: false,
      written: false,
      changes: [],
      warnings: [],
      snippets: [],
      errors: [notFound],
      notices: [],
      summary: { changes: 0, warnings: 0, errors: 1 },
    });
  });

  it('doctor --json prints a document with the error, counted in the summary', async () => {
    const result = await exec('doctor', '--json', missing);
    expect([result.code, result.stderr]).toEqual([EXIT_USAGE, '']);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, policy: null, findings: [], notices: [], strict: false, failOn: 'error', failOnFrom: 'default', errors: [notFound], summary: { error: 1, warning: 0, note: 0 } });
  });

  it('doctor --sarif prints a run that did not succeed, with the error as a notification', async () => {
    const result = await exec('doctor', '--sarif', missing);
    expect([result.code, result.stderr]).toEqual([EXIT_USAGE, '']);
    const sarif = JSON.parse(result.stdout) as { runs: { invocations: unknown[]; results: unknown[] }[] };
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(sarif.runs[0]?.invocations).toEqual([
      {
        executionSuccessful: false,
        toolExecutionNotifications: [{ level: 'error', message: { text: `directory not found: ${missing}. Fix: Pass the path of an existing directory` }, descriptor: { id: 'directory-not-found' } }],
      },
    ]);
  });

  it('explain --json prints a document with the error', async () => {
    const result = await exec('explain', '--json', missing);
    expect([result.code, result.stderr]).toEqual([EXIT_USAGE, '']);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, project: null, policy: null, projects: [], notices: [], errors: [notFound] });
  });

  it('documents the exit code in the help of every command that takes a directory', async () => {
    for (const command of ['init', 'apply', 'doctor', 'explain', 'check']) {
      expect((await exec(command, '--help')).stdout, command).toMatch(/^ {2}2 {2}a usage error, such as an unknown option or a missing directory$/mu);
    }
  });

  it('reports a path through a file as not found', async () => {
    const file = join(project(), 'package.json');
    const result = await exec('doctor', '--json', join(file, 'inner'));
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: [{ code: 'directory-not-found' }] });
  });
});
