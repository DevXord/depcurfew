// Decision D-162 in the Claude Code hook: npm subcommands are read as npm resolves them (abbreviations and camelCase,
// deref in lib/utils/cmd-list.js), so npm exe, npm installTest, npm ini and npm cre get the answer of npm exec, npm
// install-test and npm init: a known malicious version is denied with its record and a version newer than the policy
// allows is denied from the registry. An abbreviation npm finds more than one command for runs nothing and gets no
// decision. Bun's aliases a and c are bun add and bun create.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { cleanUp } from '../mcp/support.ts';
import { packument } from '../support/osv.ts';
import { localData } from '../support/osv-data.ts';
import { buildZip, malRecord } from '../support/zip.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d162-home-'));
temporary.push(HOME);

let shared: string | undefined;
/** The local data: cutekitten-test 1.0.1 and create-kitten 1.0.1 (npm). */
async function data(): Promise<string> {
  const zip = (records: readonly string[]) => buildZip(records.map((record) => ({ name: `${(JSON.parse(record) as { id: string }).id}.json`, data: record })));
  shared ??= await localData(temporary, NOW, {
    npm: zip([malRecord('MAL-2026-18458', 'npm', 'cutekitten-test', { versions: ['1.0.1'] }), malRecord('MAL-2026-90162', 'npm', 'create-kitten', { versions: ['1.0.1'] })]),
  });
  return shared;
}

/** The registry: kitten, cutekitten-test and create-kitten, with 1.0.0 long ago and 1.0.1 published an hour before the clock. */
function registry(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (!/^(?:cutekitten-test|create-kitten|kitten)$/u.test(name)) throw new TypeError('fetch failed');
    const document = packument(name, ['1.0.0', '1.0.1']) as { time: Record<string, string> };
    document.time['1.0.1'] = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    return new Response(JSON.stringify(document), { status: 200 });
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

const PROJECT = { 'package.json': '{"name":"x","version":"1.0.0"}', 'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '7d' } }) };

interface Answer {
  decision: string | undefined;
  reason: string;
}

async function hook(command: string, osv: string | undefined, fetch: FetchLike = registry()): Promise<Answer> {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d162-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(PROJECT)) writeFileSync(join(root, file), text);
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch,
    now: () => NOW,
    stdin: async () => event,
    home: () => HOME,
    projectDir: () => root,
    osvData: () => osv,
  });
  expect(code).toBe(0);
  if (stdout.trim() === '') return { decision: undefined, reason: '' };
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  return { decision: output['permissionDecision'], reason: output['permissionDecisionReason'] ?? '' };
}

const record = (spec: string, id: string) => `- ${spec}: ${spec} is a known malicious version: OSV.dev lists it as ${id} (https://osv.dev/vulnerability/${id})`;

const SPELLINGS: [string, string, string][] = [
  ['npm exec cutekitten-test@1.0.1', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['npm exe cutekitten-test@1.0.1', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['npm --package=cutekitten-test@1.0.1 exe kitten', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['npm exe -c "npm i cutekitten-test@1.0.1"', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['npm installTest cutekitten-test@1.0.1', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['npm ini kitten@1.0.1', 'create-kitten@1.0.1', 'MAL-2026-90162'],
  ['npm cre kitten@1.0.1', 'create-kitten@1.0.1', 'MAL-2026-90162'],
  ['bun a cutekitten-test@1.0.1', 'cutekitten-test@1.0.1', 'MAL-2026-18458'],
  ['bun c kitten@1.0.1', 'create-kitten@1.0.1', 'MAL-2026-90162'],
];

describe('npm subcommands as npm resolves them, in the hook', () => {
  it.each(SPELLINGS)('%s is denied with the record of the version', async (command, spec, id) => {
    const answer = await hook(command, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(record(spec, id));
  });

  it.each(SPELLINGS)('%s is denied when the registry says the version is too new', async (command, spec) => {
    const fetch = registry();
    const answer = await hook(command, undefined, fetch);
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(`${spec} was published 1 hour ago; depcurfew.json requires 1 week. Fix: Wait until ${spec} is 1 week old`);
    expect(fetch.urls).toContain(`https://registry.npmjs.org/${spec.replace(/@1\.0\.1$/u, '')}`);
  });

  it.each([
    ['npm ini kitten', 'create-kitten'],
    ['npm cre kitten', 'create-kitten'],
  ])('%s checks the version npm init would run', async (command, name) => {
    const answer = await hook(command, undefined);
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(`${name}@1.0.1`);
  });

  it.each(['npm ex cutekitten-test@1.0.1', 'npm install- cutekitten-test@1.0.1', 'npm a cutekitten-test@1.0.1'])(
    '%s gets no decision: npm finds more than one command for it and runs nothing',
    async (command) => {
      const fetch = registry();
      expect(await hook(command, await data(), fetch)).toEqual({ decision: undefined, reason: '' });
      expect(fetch.urls).toEqual([]);
    },
  );
});
