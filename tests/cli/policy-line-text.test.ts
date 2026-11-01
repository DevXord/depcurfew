// The text of an error that keeps a command from starting names the line its location has, as the JSON document does
// (decision D-122): an invalid depcurfew.json in apply, check and explain, and apply --user with an invalid user policy.
// The line under the errors of apply that says nothing is written is a note.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { inputErrorLines } from '../../src/cli/directory.ts';
import { EXIT_FAILURE, run } from '../../src/cli/run.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { platform } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-policy-line-'));
  temporary.push(root);
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
    home: () => tmpdir(),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

// installScripts.default at line 6 is the problem.
const INVALID = '{\n  "version": 1,\n  "cooldown": {\n    "minimum": "3d"\n  },\n  "installScripts": { "default": "maybe" }\n}\n';
const ISSUE = '  installScripts.default: must be one of "allow", "deny", got "maybe"';
const FIX = '  fix: Fix these problems in depcurfew.json; an editor that reads its $schema shows them as you type';
const ERROR = ['error: depcurfew.json (line 6) is invalid (policy-invalid)', ISSUE, FIX].join('\n');

describe('an invalid depcurfew.json in text names its line (V7)', () => {
  const project = () => directory({ 'depcurfew.json': INVALID, 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n' });

  it('apply says depcurfew.json and the line, as apply --json does', async () => {
    const root = project();
    const text = await exec(['apply', root]);
    expect(text).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `${ERROR}\n` });
    const json = JSON.parse((await exec(['apply', '--json', root])).stdout) as { errors: { location: object }[] };
    expect(json.errors[0]?.location).toEqual({ file: 'depcurfew.json', line: 6 });
  });

  it('check says it too, and stops before looking anything up', async () => {
    const root = project();
    const text = await exec(['check', '--dir', root, 'pypi:requests']);
    expect(text).toEqual({ code: EXIT_FAILURE, stdout: '', stderr: `${ERROR}\n` });
  });

  it('explain shows it in its report', async () => {
    const result = await exec(['explain', project()]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toContain(`Policy (depcurfew.json): invalid\n${ERROR.split('\n').map((line) => `  ${line}`).join('\n')}\n`);
  });

  it('a policy found in a parent directory is named by its path, with the line', async () => {
    const root = project();
    // A parent directory counts inside a git repository (findPolicyDirectory).
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'sub'));
    const result = await exec(['check', '--dir', join(root, 'sub'), 'pypi:requests']);
    expect(result.stderr.split('\n')[0]).toMatch(/^error: \S*depcurfew\.json \(line 6\): depcurfew\.json is invalid \(policy-invalid\)$/u);
  });

  it('apply --user names the line of the user policy', async () => {
    const root = directory({});
    const home = join(root, 'home');
    mkdirSync(home);
    const environment: UserEnvironment = { platform, home, env: { PATH: join(root, 'bin') } };
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, INVALID);
    const result = await exec(['apply', '--user'], environment);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr.split('\n')[0]).toMatch(/^error: \S+depcurfew\.json \(line 6\) is invalid \(policy-invalid\)$/u);
  });
});

describe('inputErrorLines', () => {
  const error = { code: 'policy-invalid' as const, level: 'error' as const, message: 'depcurfew.json is invalid', fix: 'Fix it' };

  it('adds the line only when the location has one and the message does not name it', () => {
    expect(inputErrorLines({ ...error, location: { file: 'depcurfew.json' } })[0]).toBe('error: depcurfew.json is invalid (policy-invalid)');
    expect(inputErrorLines({ ...error, location: { file: 'depcurfew.json', line: 3 } })[0]).toBe('error: depcurfew.json (line 3) is invalid (policy-invalid)');
    expect(inputErrorLines({ ...error, location: { file: 'app/depcurfew.json', line: 3 } })[0]).toBe('error: app/depcurfew.json (line 3): depcurfew.json is invalid (policy-invalid)');
    expect(inputErrorLines({ ...error, message: 'invalid JSON at line 3, column 2', location: { file: 'depcurfew.json', line: 3 } })[0]).toBe('error: invalid JSON at line 3, column 2 (policy-invalid)');
  });
});

describe('the line of apply that says nothing is written', () => {
  it('is a note, in the form of the other notes', async () => {
    const root = directory({ 'depcurfew.json': '{ "version": 1, "cooldown": { "minimum": "3d" } }\n', 'package.json': '{ "name": "app", "packageManager": "npm@12.2.1" }\n', 'renovate.json': '{ "extends": [ }\n' });
    const dry = await exec(['apply', '--dry-run', root]);
    expect(dry.code).toBe(EXIT_FAILURE);
    expect(dry.stderr.endsWith('\nnote: apply would write nothing because of the errors above\n')).toBe(true);
    const real = await exec(['apply', root]);
    expect(real.stderr.endsWith('\nnote: nothing written because of the errors above\n')).toBe(true);
    expect(real.stderr).not.toMatch(/^depcurfew: /mu);
  });
});
