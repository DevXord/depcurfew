// Decision D-192: the lines doctor quotes show secrets as <redacted>, as the diff of apply does. config-drift quoted the
// lines of a file as they were: npmAuthToken of a .yarnrc.yml in flow style, a token in a .npmrc line that a lone CR
// joins to a managed setting, and a token of a minified composer.json went into the text, JSON and SARIF of doctor, the
// log and job summary of the GitHub Action, and doctor --user (found by the review of 1.6.0, already in 1.5.2).
// Composer keys a token by its host ("github-oauth": {"github.com": "…"}), so no line shows on its own that it is one:
// apply --dry-run and doctor hide it by its place in the JSON document.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAction } from '../../src/action.ts';
import { redactText } from '../../src/apply/diff.ts';
import type { CheckDependencies } from '../../src/cli/check.ts';
import { run } from '../../src/cli/run.ts';
import { DEFAULT_POLICY, renderPolicy } from '../../src/policy/defaults.ts';
import type { UserEnvironment } from '../../src/user/locate.ts';
import { userPolicyPath } from '../../src/user/policy-path.ts';
import { cpuNow } from '../support/cpu-time.ts';
import { fakeMachine, userFileOf } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d192-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function cli(argv: string[], environment?: UserEnvironment): Promise<string> {
  let output = '';
  const dependencies: CheckDependencies = {
    fetch: () => Promise.reject(new Error('no network in tests')),
    now: () => new Date('2026-11-09T12:00:00Z'),
    stdin: () => Promise.resolve(''),
    ...(environment === undefined ? {} : { userEnvironment: () => environment }),
  };
  await run(argv, { stdout: (text) => (output += text), stderr: (text) => (output += text) }, dependencies);
  return output;
}

/** Everything doctor, apply --dry-run and the GitHub Action print for the repository. */
async function outputs(root: string): Promise<string> {
  const printed = await Promise.all([['doctor', root], ['doctor', '--json', root], ['doctor', '--sarif', root], ['apply', '--dry-run', root], ['apply', '--dry-run', '--json', root]].map((argv) => cli(argv)));
  let log = '';
  let summary = '';
  runAction({ GITHUB_WORKSPACE: root }, { log: (text) => (log += text), summary: (text) => (summary += text) });
  return [...printed, log, summary].join('\n');
}

const NPM = JSON.stringify({ name: 'app', version: '1.0.0' });
const YARN = JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'yarn@4.10.3' });
const POLICY = (targets: string[]) => JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, targets });

describe('secrets in what doctor, apply and the Action print (decision D-192)', () => {
  it('npmAuthToken of a .yarnrc.yml in flow style', async () => {
    const root = repository({ 'package.json': YARN, 'yarn.lock': '', '.yarnrc.yml': '{nodeLinker: node-modules, npmAuthToken: "npm_LEAKYTOKEN123", npmMinimalAgeGate: 60}\n', 'depcurfew.json': POLICY(['yarn']) });
    const printed = await outputs(root);
    expect(printed).toContain('config-drift');
    expect(printed).toContain('npmAuthToken: <redacted>');
    expect(printed).not.toContain('LEAKYTOKEN');
  });

  it('a token in a .npmrc line that a lone CR joins to a managed setting', async () => {
    const root = repository({ 'package.json': NPM, '.npmrc': 'min-release-age=1\r//registry.npmjs.org/:_authToken=npm_LEAKYTOKEN123\n', 'depcurfew.json': POLICY(['npm']) });
    const printed = await outputs(root);
    expect(printed).toContain('config-drift');
    expect(printed).toContain('_authToken=<redacted>');
    expect(printed).not.toContain('LEAKYTOKEN');
  });

  it('a token under a quoted key that holds slashes and a colon, in pnpm-workspace.yaml', async () => {
    const pnpm = JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@10.20.0' });
    for (const workspace of ['{minimumReleaseAge: 1, "//registry.npmjs.org/:_authToken": npm_LEAKYTOKEN123}\n', 'minimumReleaseAge: 1\n"//registry.npmjs.org/:_authToken": npm_LEAKYTOKEN123\n']) {
      const printed = await outputs(repository({ 'package.json': pnpm, 'pnpm-workspace.yaml': workspace, 'depcurfew.json': POLICY(['pnpm']) }));
      expect(printed, workspace).toContain('config-drift');
      expect(printed, workspace).not.toContain('LEAKYTOKEN');
    }
  });

  it('Composer tokens under their host, in a minified and in a formatted composer.json', async () => {
    const credentials = {
      'github-oauth': { 'github.com': 'ghp_LEAKYTOKEN1' },
      'gitlab-oauth': { 'gitlab.example.org': 'LEAKYTOKEN2' },
      'gitlab-token': { 'gitlab.com': { username: 'me', token: 'LEAKYTOKEN3' } },
      bearer: { 'repo.example.org': 'LEAKYTOKEN4' },
      'bitbucket-oauth': { 'bitbucket.org': { 'consumer-key': 'LEAKYTOKEN5', 'consumer-secret': 'LEAKYTOKEN6' } },
      'custom-headers': { 'repo.example.org': ['API-TOKEN: LEAKYTOKEN7'] },
      'client-certificate': { 'repo.example.org': { local_cert: '/path/to/certificate', passphrase: 'LEAKYTOKEN8' } },
      'forgejo-token': { 'forgejo.example.org': { username: 'me', token: 'LEAKYTOKEN9' } },
      'http-basic': { 'repo.example.org': { username: 'me', password: 'LEAKYTOKEN10' } },
    };
    const manifest = {
      name: 'acme/app',
      require: { 'monolog/monolog': '^3.0' },
      repositories: [{ type: 'composer', url: 'https://repo.example.org', options: { http: { header: ['API-TOKEN: LEAKYTOKEN11'] } } }],
      config: credentials,
    };
    for (const text of [JSON.stringify(manifest), `${JSON.stringify(manifest, null, 4)}\n`]) {
      const printed = await outputs(repository({ 'composer.json': text, 'depcurfew.json': POLICY(['composer']) }));
      expect(printed).toContain('<redacted>');
      expect(printed).not.toContain('LEAKYTOKEN');
    }
  });

  it('doctor --user and apply --user --dry-run', async () => {
    const machine = fakeMachine({ npm: { npm: '11.21.1' } }, temporary);
    const policy = userPolicyPath(machine);
    mkdirSync(dirname(policy), { recursive: true });
    writeFileSync(policy, renderPolicy(DEFAULT_POLICY));
    const npmrc = userFileOf('npm', machine);
    mkdirSync(dirname(npmrc), { recursive: true });
    writeFileSync(npmrc, 'min-release-age=1\r//registry.npmjs.org/:_authToken=npm_LEAKYTOKEN123\n');
    const printed = (await Promise.all([['doctor', '--user'], ['doctor', '--user', '--json'], ['apply', '--user', '--dry-run'], ['apply', '--user', '--dry-run', '--json']].map((argv) => cli(argv, machine)))).join('\n');
    expect(printed).toContain('user-config-drift');
    expect(printed).toContain('_authToken=<redacted>');
    expect(printed).not.toContain('LEAKYTOKEN');
  });
});

describe('redactText (decision D-192)', () => {
  it('keeps the lines, JSON valid, references to variables and the values that are no secret', () => {
    const text = '{\n  // a comment with "github-oauth": "x"\n  "name": "acme/\\"app\\"",\n  "npmAuthToken": "${NPM_TOKEN}",\n  "_authToken": "npm_LEAKY\\"TOKEN",\n  "config": { "github-oauth": { "github.com": "ghp_LEAKY" }, "sort-packages": true }\n}\n';
    const redacted = redactText('composer.json', text);
    expect(redacted.split('\n')).toHaveLength(text.split('\n').length);
    expect(JSON.parse(redacted.replace(/^\s*\/\/.*$/mu, ''))).toEqual({ name: 'acme/"app"', npmAuthToken: '${NPM_TOKEN}', _authToken: '<redacted>', config: { 'github-oauth': { 'github.com': '<redacted>' }, 'sort-packages': true } });
    // A string without its closing quote ends with its line, so the next line stays.
    expect(redactText('auth.json', '{"bearer": {"h": "LEAKY\n}}\n')).toBe('{"bearer": {"h": "<redacted>"\n}}\n');
    // Other files line by line, as before.
    expect(redactText('.npmrc', 'a=1\r//r/:_authToken=LEAKY\nfund=false\n')).toBe('a=1\r//r/:_authToken=<redacted>\nfund=false\n');
  });

  it('reads deeply nested JSON in linear time', () => {
    const text = `${'['.repeat(50_000)}"x"${']'.repeat(50_000)}`;
    const start = cpuNow();
    expect(redactText('composer.json', text)).toBe(text);
    expect(cpuNow() - start).toBeLessThan(2000);
  });
});
