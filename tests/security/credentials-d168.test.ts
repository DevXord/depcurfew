// Credentials in URLs never reach any output (decision D-168): a token alone as the user part of a URL
// (https://TOKEN@host, git+https://TOKEN@github.com), a password with an unencoded @ (the user part ends at the last @
// before the host, as WHATWG URL and pip read it), a line of .npmrc that a lone \r ends (npm reads \r as a line
// break) and the findings of doctor in a project, as doctor --user already hides them. Every command runs on one
// fixture full of such URLs (tests/fixtures/credentials) and none of its secrets may show up, in text, JSON, SARIF,
// diffs, the hook's answer or depcurfew mcp, nor in a URL that depcurfew asks.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpuNow } from '../support/cpu-time.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redactSecrets, unifiedDiff } from '../../src/apply/diff.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { safeJson } from '../../src/json-safe.ts';
import { printable, redactCredentials, withoutCredentials } from '../../src/printable.ts';
import { call, cleanUp, initialized } from '../mcp/support.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const FIXTURE = new URL('../fixtures/credentials/repo/', import.meta.url);
const SECRET = /SEKRET\d+/u;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `depcurfew-d168-credentials-${prefix}-`));
  temporary.push(path);
  return path;
}

/**
 * The fixture in a directory of its own, with the .npmrc that git cannot keep byte for byte (a lone \r ends the line
 * of fund=false for npm, so the token after it is a key of its own), and a home directory with a ~/.npmrc.
 */
function copy(): { root: string; home: string } {
  const root = directory('repo');
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, '.npmrc'), 'registry=https://SEKRET3@npm.corp.example/\nfund=false\r//npm.corp.example/:_authToken=SEKRET4\n@acme:registry=https://bob:to@SEKRET5@npm.acme.example/\n');
  writeFileSync(join(root, 'uv.toml'), 'index-url = "https://SEKRET9@pypi.corp.example/simple"\n');
  const home = directory('home');
  writeFileSync(join(home, '.npmrc'), '@home:registry=https://ada:pass@SEKRET10@npm.home.example/\n');
  mkdirSync(join(home, '.config', 'pip'), { recursive: true });
  writeFileSync(join(home, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://SEKRET11@pypi.home.example/simple\n');
  return { root, home };
}

/** A fetch that records what it is asked and answers 404. */
function recording(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

async function exec(argv: string[], home: string, fetch: FetchLike, options: { stdin?: string; projectDir?: string } = {}): Promise<string> {
  let stdout = '';
  let stderr = '';
  await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch,
    now: () => NOW,
    stdin: async () => options.stdin ?? '',
    home: () => home,
    projectDir: () => options.projectDir,
    osvData: () => undefined,
    userEnvironment: () => ({ platform: process.platform, home, env: {} }),
  });
  return `${stdout}\n${stderr}`;
}

function event(command: string, cwd: string): string {
  return JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
}

describe('the user part of a URL', () => {
  it('is removed up to the last @ before the host, as WHATWG URL and pip read it', () => {
    expect(withoutCredentials('https://alice:S3cret@Part2@registry.example.test/')).toBe('https://registry.example.test/');
    expect(withoutCredentials('--index-url https://__token__:a@b@pypi.example/simple and https://TOKEN@npm.example/')).toBe('--index-url https://pypi.example/simple and https://npm.example/');
    // The path, the query and the fragment end the authority, so an @ there is not a user part.
    expect(withoutCredentials('git+https://github.com/acme/lib.git@v1.0.0 https://host/a?b=c@d #e@f')).toBe('git+https://github.com/acme/lib.git@v1.0.0 https://host/a?b=c@d #e@f');
  });

  it('is shown as <redacted>, a token alone too, but not the login name of an ssh URL', () => {
    expect(redactCredentials('git+https://ghp_SEKRET@github.com/acme/lib.git@v1.0.0')).toBe('git+https://<redacted>@github.com/acme/lib.git@v1.0.0');
    expect(redactCredentials('@acme:registry=https://SEKRET@npm.fury.io/acme/')).toBe('@acme:registry=https://<redacted>@npm.fury.io/acme/');
    expect(redactCredentials('https://alice:S3cret@Part2@registry.example.test/')).toBe('https://<redacted>@registry.example.test/');
    expect(redactCredentials('git+ssh://git@github.com/a/b.git ssh://deploy@host/x')).toBe('git+ssh://git@github.com/a/b.git ssh://deploy@host/x');
    expect(redactCredentials('git+ssh://git:SEKRET@github.com/a/b.git')).toBe('git+ssh://<redacted>@github.com/a/b.git');
    // Twice gives the same.
    expect(redactCredentials(redactCredentials('https://a:b@c@host/'))).toBe('https://<redacted>@host/');
  });

  it('is hidden by printable and safeJson, which every command writes its output with', () => {
    expect(printable('see https://SEKRET@npm.example/')).toBe('see https://<redacted>@npm.example/');
    expect(safeJson({ registry: 'https://u:p@SEKRET@npm.example/', list: ['git+https://SEKRET@github.com/a/b'] })).toBe(
      '{"registry":"https://<redacted>@npm.example/","list":["git+https://<redacted>@github.com/a/b"]}',
    );
  });

  it('is found in linear time', () => {
    const texts = ['a+'.repeat(200_000), `${'x://'.repeat(100_000)}@`, `https://${'a@'.repeat(200_000)}`, `${'a'.repeat(400_000)}://`];
    for (const text of texts) {
      const start = cpuNow();
      redactCredentials(text);
      withoutCredentials(text);
      expect(cpuNow() - start).toBeLessThan(500);
    }
  });
});

describe('a line of .npmrc that a lone carriage return ends', () => {
  it('is redacted as the two lines npm reads', () => {
    expect(redactSecrets('fund=false\r//npm.corp.example/:_authToken=SEKRET4')).toBe('fund=false\r//npm.corp.example/:_authToken=<redacted>');
    expect(redactSecrets('save-exact=true\r')).toBe('save-exact=true\r');
    const diff = unifiedDiff('.npmrc', 'fund=false\r_authToken=SEKRET4\n', 'fund=false\r_authToken=SEKRET4\nmin-release-age=3\n', 3, { redact: true });
    expect(diff).not.toMatch(SECRET);
  });
});

describe('a repository full of URLs with credentials', () => {
  it('shows none of them in doctor, apply --dry-run, explain, check and the hook, and asks for none', async () => {
    const { root, home } = copy();
    const fetch = recording();
    const outputs = [
      await exec(['doctor', root], home, fetch),
      await exec(['doctor', '--json', root], home, fetch),
      await exec(['doctor', '--sarif', root], home, fetch),
      await exec(['apply', '--dry-run', root], home, fetch),
      await exec(['apply', '--dry-run', '--json', root], home, fetch),
      await exec(['explain', root], home, fetch),
      await exec(['explain', '--json', root], home, fetch),
      await exec(['check', '--dir', root, 'left-pad', '@acme/ui', '@home/x', 'pypi:requests'], home, fetch),
      await exec(['check', '--json', '--dir', root, 'left-pad', '@acme/ui', '@home/x', 'pypi:requests'], home, fetch),
      await exec(['check', '--json', '--dir', root, '--registry', 'https://u:p@SEKRET12@registry.example.test/', '--index', 'https://SEKRET13@pypi.example.test/simple', 'left-pad', 'pypi:requests'], home, fetch),
    ];
    for (const command of [
      'npm install --registry https://SEKRET14@npm.other.example/ lodash',
      'pip install --index-url https://a:b@SEKRET15@pypi.other.example/simple requests',
      'npm install git+https://SEKRET16@github.com/acme/x.git https://SEKRET17@cdn.example/x-1.0.0.tgz',
      'uv add requests',
    ]) {
      outputs.push(await exec(['check', '--hook', 'claude-code'], home, fetch, { stdin: event(command, root), projectDir: root }));
    }
    // Each command said something about the fixture, so that the assertions below are about real output.
    expect(outputs.join('\n')).toContain('<redacted>');
    expect(outputs.join('\n')).toContain('lockfile-forbidden-source');
    for (const output of outputs) expect(output).not.toMatch(SECRET);
    expect(fetch.urls.join('\n')).not.toMatch(SECRET);
  });

  it('shows none of them in the answers of depcurfew mcp', async () => {
    const { root } = copy();
    const client = await initialized(root);
    client.send(call(1, 'check_packages', { packages: ['left-pad', '@acme/ui', 'pypi:requests', 'git+https://SEKRET18@github.com/acme/x.git'] }));
    client.send(call(2, 'explain_policy', {}));
    const answers = [await client.next(), await client.next()];
    await client.close();
    expect(JSON.stringify(answers)).toContain('npm.corp.example');
    expect(JSON.stringify(answers)).not.toMatch(SECRET);
  });
});
