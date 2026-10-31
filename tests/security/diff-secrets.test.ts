// What apply shows of the files it edits: a diff (--dry-run, and changes[].diff in --json) never shows a token or a
// password from the file, whether the line is context, removed or added, and a file name cannot forge diff lines. The
// files written keep every byte. JSON output escapes C1 and bidirectional controls, which JSON.stringify keeps.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redactSecrets, unifiedDiff } from '../../src/apply/diff.ts';
import { run } from '../../src/cli/run.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { safeJson } from '../../src/json-safe.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { windows } from '../support/platform.ts';
import { fakeMachine } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

async function exec(argv: string[], environment?: UserEnvironment): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-10-31T00:00:00Z'),
    stdin: () => Promise.resolve(''),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, dependencies);
  return { code, stdout, stderr };
}

// The last three lines are the context of the block apply adds at the end.
const NPMRC = [
  'save-exact=true',
  '//registry.example.org/:_authToken=${NPM_TOKEN}',
  '_auth = dXNlcjpzZWNyZXQ=',
  '//npm.example.com:8443/repo/:_password=c2VjcmV0',
  'registry=https://ada:hunter2@npm.example.com/',
  '//registry.npmjs.org/:_authToken=npm_SECRET1',
  '',
].join('\n');

describe('redactSecrets', () => {
  it('hides npmrc auth values, also under a //host/: prefix, and the user and password of URLs', () => {
    expect(NPMRC.split('\n').map(redactSecrets)).toEqual([
      'save-exact=true',
      // A reference to an environment variable is not a secret, and shows where the token comes from.
      '//registry.example.org/:_authToken=${NPM_TOKEN}',
      '_auth = <redacted>',
      '//npm.example.com:8443/repo/:_password=<redacted>',
      'registry=https://<redacted>@npm.example.com/',
      '//registry.npmjs.org/:_authToken=<redacted>',
      '',
    ]);
    expect(redactSecrets('_authToken=npm_SECRET2')).toBe('_authToken=<redacted>');
  });

  it('hides tokens and passwords in YAML and TOML user files too, and leaves other keys alone', () => {
    expect(redactSecrets('  npmAuthToken: "npm_SECRET"')).toBe('  npmAuthToken: <redacted>');
    expect(redactSecrets('npmAuthIdent: ada:hunter2')).toBe('npmAuthIdent: <redacted>');
    expect(redactSecrets('token = "bun_SECRET"')).toBe('token = <redacted>');
    expect(redactSecrets('password = "hunter2"')).toBe('password = <redacted>');
    expect(redactSecrets('"@acme" = { token = "bun_SECRET", url = "https://npm.acme.example/" }')).toBe('"@acme" = { token = <redacted>, url = "https://npm.acme.example/" }');
    expect(redactSecrets('npmScopes: { acme: { npmAuthToken: npm_SECRET } }')).toBe('npmScopes: { acme: { npmAuthToken: <redacted> } }');
    expect(redactSecrets('index-url = https://__token__:pypi-SECRET@pypi.example.com/simple')).toBe('index-url = https://<redacted>@pypi.example.com/simple');
    expect(redactSecrets('min-release-age=3')).toBe('min-release-age=3');
    expect(redactSecrets('auth-type=web')).toBe('auth-type=web');
    expect(redactSecrets('"dependencies": { "a": "git+ssh://git@github.com/a/b.git" }')).toBe('"dependencies": { "a": "git+ssh://git@github.com/a/b.git" }');
  });
});

describe('unifiedDiff', () => {
  it('redacts secrets in context, removed and added lines when asked to', () => {
    const before = '//r.example/:_authToken=npm_KEPT\n_password=OLD\nsave-exact=true\n';
    const after = '//r.example/:_authToken=npm_KEPT\n_password=NEW\nsave-exact=true\nmin-release-age=3\n';
    const diff = unifiedDiff('.npmrc', before, after, 3, { redact: true });
    expect(diff).not.toMatch(/npm_KEPT|OLD|NEW/u);
    expect(diff).toContain('\n //r.example/:_authToken=<redacted>\n-_password=<redacted>\n+_password=<redacted>\n save-exact=true\n+min-release-age=3\n');
    // Without the option the diff is exact, for callers of the library that need it.
    expect(unifiedDiff('.npmrc', before, after)).toContain('\n+_password=NEW\n');
  });

  it('shows control characters in the file name of the headers as text', () => {
    const diff = unifiedDiff('evil\n+++ b/forged\u001b[2K', null, 'x\n');
    expect(diff.split('\n').slice(0, 2)).toEqual(['--- /dev/null', '+++ b/evil\\x0a+++ b/forged\\x1b[2K']);
  });

  it('names a file with an absolute path as it is, without a/ and b/', () => {
    expect(unifiedDiff('/tmp/cfg/uv/uv.toml', null, 'x\n').split('\n').slice(0, 2)).toEqual(['--- /dev/null', '+++ /tmp/cfg/uv/uv.toml']);
    expect(unifiedDiff('/tmp/cfg/uv/uv.toml', 'a\n', 'b\n').split('\n').slice(0, 2)).toEqual(['--- /tmp/cfg/uv/uv.toml', '+++ /tmp/cfg/uv/uv.toml']);
    expect(unifiedDiff('C:\\cfg\\uv\\uv.toml', 'a\n', 'b\n').split('\n').slice(0, 2)).toEqual(['--- C:\\cfg\\uv\\uv.toml', '+++ C:\\cfg\\uv\\uv.toml']);
    expect(unifiedDiff('~/.npmrc', 'a\n', 'b\n').split('\n').slice(0, 2)).toEqual(['--- a/~/.npmrc', '+++ b/~/.npmrc']);
  });
});

describe('apply output', () => {
  it('prints no token of a project .npmrc in --dry-run or --json, and writes the file unchanged otherwise', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-secrets-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'package.json'), '{ "name": "demo", "packageManager": "npm@11.21.1" }\n');
    writeFileSync(join(directory, '.npmrc'), NPMRC);
    writeFileSync(join(directory, 'depcurfew.json'), '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm"] }\n');
    const dry = await exec(['apply', '--dry-run', directory]);
    expect(dry.stdout).toContain('+++ b/.npmrc\n');
    expect(dry.stdout).not.toMatch(/SECRET|c2VjcmV0|dXNlcjpzZWNyZXQ|hunter2/u);
    expect(dry.stdout).toContain(' //registry.npmjs.org/:_authToken=<redacted>\n');
    const json = await exec(['apply', '--dry-run', '--json', directory]);
    expect(json.stdout).not.toMatch(/SECRET|c2VjcmV0|dXNlcjpzZWNyZXQ|hunter2/u);
    await exec(['apply', directory]);
    expect(readFileSync(join(directory, '.npmrc'), 'utf8').startsWith(NPMRC)).toBe(true);
  });

  it.skipIf(windows)('apply --user --dry-run to a pipe escapes control characters in the paths of the diff headers', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const config = join(machine.root, 'cfg\n+++ b/forged\u001b[2K');
    const environment: UserEnvironment = { ...machine, home: machine.home, env: { ...machine.env, XDG_CONFIG_HOME: config } };
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["pnpm"] }');
    const result = await exec(['apply', '--user', '--dry-run', '--for', 'pnpm@11.28.10'], environment);
    expect(result.stdout).not.toContain('\u001b');
    const headers = result.stdout.split('\n').filter((line) => line.startsWith('+++') || line.startsWith('---'));
    expect(headers).toHaveLength(2);
    expect(headers[1]).toContain('cfg\\x0a+++ b/forged\\x1b[2K');
  });

  it('apply --user --dry-run shows control and bidirectional characters of a user file as text in every diff line', async () => {
    const environment = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["npm"] }');
    writeFileSync(join(environment.home, '.npmrc'), 'registry=https://r.example.com/\u001b]0;PWNED\u0007\nsave-exact=true \u001b[2J‮\n');
    const result = await exec(['apply', '--user', '--dry-run'], environment);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/u);
    expect(result.stdout).toContain('\n registry=https://r.example.com/\\x1b]0;PWNED\\x07\n');
    expect(result.stdout).toContain('\n save-exact=true \\x1b[2J\\u202e\n');
  });

  it.skipIf(windows)('apply --user --dry-run names a user file outside the home directory by its absolute path in the headers', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const config = join(machine.root, 'cfg');
    const environment: UserEnvironment = { ...machine, env: { ...machine.env, XDG_CONFIG_HOME: config } };
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["pnpm"] }');
    const result = await exec(['apply', '--user', '--dry-run', '--for', 'pnpm@11.28.10'], environment);
    expect(result.stdout.split('\n').slice(0, 2)).toEqual(['--- /dev/null', `+++ ${join(config, 'pnpm', 'config.yaml')}`]);
  });

  it.skipIf(windows)('apply --json escapes C1 and bidirectional controls in paths', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const config = join(machine.root, 'cfg\u202e\u0085');
    const environment: UserEnvironment = { ...machine, env: { ...machine.env, XDG_CONFIG_HOME: config } };
    const policy = userPolicyPath(environment);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, '{ "version": 1, "cooldown": { "minimum": "3d" }, "targets": ["pnpm"] }');
    const result = await exec(['apply', '--user', '--dry-run', '--json', '--for', 'pnpm@11.28.10'], environment);
    expect(result.stdout).not.toMatch(/[\u0080-\u009f\u202e]/u);
    expect(result.stdout).toContain('cfg\\u202e\\u0085');
    expect((JSON.parse(result.stdout) as { changes: { file: string }[] }).changes[0]?.file).toContain('cfg\u202e\u0085');
  });
});

describe('safeJson', () => {
  it('escapes C1 controls, bidirectional controls and line separators, and stays JSON', () => {
    const value = { name: 'a\u0085b\u202ec\u2066d\u061ce\u200ff\u2028g', plain: 'zażółć' };
    const text = safeJson(value, 2);
    expect(text).toBe('{\n  "name": "a\\u0085b\\u202ec\\u2066d\\u061ce\\u200ff\\u2028g",\n  "plain": "zażółć"\n}');
    expect(JSON.parse(text)).toEqual(value);
  });
});
