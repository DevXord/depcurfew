// --osv of depcurfew check, the Claude Code hook and depcurfew mcp (decision D-129): the version the install picks is
// looked up in OSV.dev, a MAL- record is an error that names it and links its page, OSV.dev out of reach leaves the
// package unverified (the hook asks), and nothing goes to OSV.dev without the option.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_IS_THE_USERS } from '../../src/check/hook.ts';
import { OSV_RETRY_FIX } from '../../src/check/osv.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from '../../src/cli/run.ts';
import { call, cleanUp, initialized } from '../mcp/support.ts';
import { osvFetch, packument, pypiPage, unreachableOsv, withDocuments, type OsvFetch } from '../support/osv.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-home-'));
  temporary.push(HOME);
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});

/** The registry documents of the packages the OSV.dev recordings name, which tests/fixtures/registry does not hold. */
const DOCUMENTS = {
  'https://registry.npmjs.org/cutekitten-test': packument('cutekitten-test', ['1.0.0', '1.0.1']),
  'https://registry.npmjs.org/lodash': packument('lodash', ['4.17.21', '4.18.1']),
  'https://pypi.org/simple/wallet-tracking/': pypiPage('wallet-tracking', ['1.0.0']),
};
const registry = withDocuments(DOCUMENTS);

function project(policy: object = { cooldown: { minimum: '3d' } }): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-osv-'));
  temporary.push(directory);
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }));
  return directory;
}

async function exec(argv: string[], fetch: FetchLike, stdin = '', projectDir?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch,
    now: () => NOW,
    stdin: async () => stdin,
    home: () => HOME,
    projectDir: () => projectDir,
  });
  return { code, stdout, stderr };
}

const event = (command: string, cwd: string) => JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

const MALWARE_MESSAGE = 'cutekitten-test@1.0.1 is a known malicious version: OSV.dev lists it as MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const MALWARE_FIX = 'Do not install it; pick another package or version. If it is installed anywhere already, remove it and read the record on OSV.dev for what it does';

describe('depcurfew check --osv', () => {
  it('reports a version with a MAL- record as an error that names the record and links it', async () => {
    const fetch = osvFetch(registry);
    const result = await exec(['check', '--osv', '--dir', project(), 'cutekitten-test@1.0.1'], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe(`cutekitten-test@1.0.1:\n  error: ${MALWARE_MESSAGE}\n    fix: ${MALWARE_FIX}\n\n1 package: 1 with errors, 0 with warnings\n`);
    expect(fetch.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]]);
  });

  it('looks up the version the spec picks, not the spec', async () => {
    const fetch = osvFetch(registry);
    // cutekitten-test without a version installs latest, 1.0.1.
    const result = await exec(['check', '--osv', '--json', '--dir', project(), 'cutekitten-test'], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(fetch.requests).toEqual([[{ package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' }]]);
    const document = JSON.parse(result.stdout) as { schemaVersion: number; packages: { version: string; findings: { code: string; level: string; message: string; fix: string }[] }[] };
    expect(document.schemaVersion).toBe(1);
    expect(document.packages[0]).toMatchObject({ version: '1.0.1', findings: [{ level: 'error', code: 'known-malicious', message: MALWARE_MESSAGE, fix: MALWARE_FIX }] });
    expect(result.stderr).toBe('');
  });

  it('passes a version whose OSV.dev records are vulnerabilities, not malware', async () => {
    const result = await exec(['check', '--osv', '--dir', project(), 'lodash@4.17.21'], osvFetch(registry));
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('lodash@4.17.21: ok');
  });

  it('checks Python packages in the ecosystem PyPI', async () => {
    const fetch = osvFetch(registry);
    const result = await exec(['check', '--osv', '--json', '--dir', project(), 'pypi:wallet-tracking==1.0.0'], fetch);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(fetch.requests).toEqual([[{ package: { name: 'wallet-tracking', ecosystem: 'PyPI' }, version: '1.0.0' }]]);
    const document = JSON.parse(result.stdout) as { packages: { findings: { code: string; message: string }[] }[] };
    expect(document.packages[0]?.findings).toEqual([
      expect.objectContaining({
        code: 'known-malicious',
        message: 'pypi:wallet-tracking==1.0.0 is a known malicious version: OSV.dev lists it as MAL-2026-18443 (https://osv.dev/vulnerability/MAL-2026-18443)',
      }),
    ]);
  });

  it('sends one batch for every package of the run, and nothing for a package without a version', async () => {
    const fetch = osvFetch(registry);
    await exec(['check', '--osv', '--dir', project(), 'cutekitten-test@1.0.1', 'lodash@4.17.21', 'this-package-does-not-exist-xyz-123', 'git+https://example.com/x.git'], fetch);
    expect(fetch.requests).toEqual([
      [
        { package: { name: 'cutekitten-test', ecosystem: 'npm' }, version: '1.0.1' },
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.21' },
      ],
    ]);
  });

  it('sends nothing to OSV.dev without --osv', async () => {
    const fetch = osvFetch(registry);
    const result = await exec(['check', '--dir', project(), 'cutekitten-test@1.0.1'], fetch);
    expect(result.code).toBe(EXIT_OK);
    expect(fetch.requests).toEqual([]);
  });

  it('leaves the package unverified, never clean, when OSV.dev cannot be reached', async () => {
    const result = await exec(['check', '--osv', '--json', '--dir', project(), 'lodash@4.17.21'], unreachableOsv(registry));
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as { packages: { findings: { code: string; level: string; message: string; fix: string }[] }[] };
    expect(document.packages[0]?.findings).toEqual([
      {
        level: 'error',
        code: 'unverified',
        message: 'it was not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)',
        fix: OSV_RETRY_FIX,
      },
    ]);
  });

  it('describes --osv in the help of check, doctor and mcp', async () => {
    for (const command of ['check', 'doctor', 'mcp']) {
      const result = await exec([command, '--help'], registry);
      expect(result.stdout, command).toContain('--osv');
      expect(result.stdout, command).toContain('api.osv.dev');
    }
  });
});

describe('the Claude Code hook with --osv', () => {
  it('denies an install of a version with a MAL- record', async () => {
    const directory = project();
    const result = await exec(['check', '--hook', 'claude-code', '--osv'], osvFetch(registry), event('npm install cutekitten-test@1.0.1', directory), directory);
    expect(result.code).toBe(EXIT_OK);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
      `depcurfew blocked this command because it breaks the project's supply-chain policy (depcurfew.json):\n- cutekitten-test@1.0.1: ${MALWARE_MESSAGE}. Fix: ${MALWARE_FIX}\n${POLICY_IS_THE_USERS}`,
    );
  });

  it('asks when OSV.dev cannot be reached, and tells the agent not to install before the check', async () => {
    const directory = project();
    const result = await exec(['check', '--hook', 'claude-code', '--osv'], unreachableOsv(registry), event('npm install lodash@4.17.21', directory), directory);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(output.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('it was not checked for known malicious versions in OSV.dev: api.osv.dev cannot be reached (fetch failed)');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Fix: Do not install it before it is checked: try again later, and tell the user if api.osv.dev stays out of reach');
  });

  it('lets the same install through to the usual prompts without --osv, and sends nothing', async () => {
    const directory = project();
    const fetch = osvFetch(registry);
    const result = await exec(['check', '--hook', 'claude-code'], fetch, event('npm install cutekitten-test@1.0.1', directory), directory);
    expect(result).toEqual({ code: EXIT_OK, stdout: '', stderr: '' });
    expect(fetch.requests).toEqual([]);
  });

  it('asks OSV.dev once for an install checked with two policies', async () => {
    const directory = project();
    const nested = join(directory, 'pkg');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nested);
    writeFileSync(join(nested, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '7d' } }));
    const fetch = osvFetch(registry);
    const result = await exec(['check', '--hook', 'claude-code', '--osv'], fetch, event('npm install cutekitten-test@1.0.1', nested), directory);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(fetch.requests).toHaveLength(1);
  });
});

describe('depcurfew mcp --osv', () => {
  type Message = Record<string, unknown>;
  const structured = (message: Message) => (message['result'] as Record<string, unknown>)['structuredContent'] as Record<string, unknown>;

  it('reports a version with a MAL- record in check_packages', async () => {
    const directory = project();
    const fetch: OsvFetch = osvFetch(registry);
    const client = await initialized(directory, '2025-11-25', { argv: ['mcp', '--dir', directory, '--osv'], fetch });
    client.send(call(1, 'check_packages', { packages: ['cutekitten-test@1.0.1'] }));
    const answer = await client.next();
    const packages = structured(answer)['packages'] as { findings: { code: string; level: string; message: string; fix: string }[] }[];
    expect(packages[0]?.findings).toEqual([{ level: 'error', code: 'known-malicious', message: MALWARE_MESSAGE, fix: MALWARE_FIX }]);
    expect(fetch.requests).toHaveLength(1);
    await client.close();
  });

  it('names the OSV.dev endpoint in explain_policy with --osv, and null without', async () => {
    const directory = project();
    for (const [argv, expected] of [
      [['mcp', '--dir', directory, '--osv'], 'https://api.osv.dev/v1/querybatch'],
      [['mcp', '--dir', directory], null],
    ] as const) {
      const client = await initialized(directory, '2025-11-25', { argv: [...argv], fetch: registry });
      client.send(call(1, 'explain_policy', {}));
      const lookups = structured(await client.next())['lookups'] as Record<string, unknown>;
      expect(lookups['osv']).toBe(expected);
      await client.close();
    }
  });

  it('sends nothing to OSV.dev without --osv', async () => {
    const directory = project();
    const fetch = osvFetch(registry);
    const client = await initialized(directory, '2025-11-25', { argv: ['mcp', '--dir', directory], fetch });
    client.send(call(1, 'check_packages', { packages: ['cutekitten-test@1.0.1'] }));
    const packages = structured(await client.next())['packages'] as { findings: unknown[] }[];
    expect(packages[0]?.findings).toEqual([]);
    expect(fetch.requests).toEqual([]);
    await client.close();
  });
});

describe('usage of --osv', () => {
  it('is a usage error with doctor --user, which reads no lockfile', async () => {
    const result = await exec(['doctor', '--user', '--osv', '--json'], registry);
    expect(result.code).toBe(EXIT_USAGE);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      errors: [{ code: 'usage', level: 'error', message: "--osv checks the lockfiles of a project and doctor --user reads none; run depcurfew doctor --osv in the project", fix: "Run 'depcurfew doctor --help' for usage" }],
    });
  });
});
