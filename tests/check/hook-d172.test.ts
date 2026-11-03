// Decision D-172 in the Claude Code hook: npm link with package specs is checked like an install, with a name the
// registry does not have as a warning, since npm link then takes the package linked globally or fails; an install
// after a here-document that bash ends at a delimiter split by a backslash-newline, and one under a command name that
// hash -p gives npm, are checked, a known malicious version there denied; a rebinding depcurfew does not read asks;
// pipx inject and pipx runpip are checked, pipx install-all asks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { packument, pypiPage } from '../support/osv.ts';
import { localData } from '../support/osv-data.ts';
import { buildZip, malRecord } from '../support/zip.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d172-home-'));
temporary.push(HOME);

let shared: string | undefined;
/** The local data: cutekitten-test 1.0.1 (npm) and wallet-tracking 1.0.0 (PyPI). */
async function data(): Promise<string> {
  const zip = (records: readonly string[]) => buildZip(records.map((record) => ({ name: `${(JSON.parse(record) as { id: string }).id}.json`, data: record })));
  shared ??= await localData(temporary, NOW, {
    npm: zip([malRecord('MAL-2026-18458', 'npm', 'cutekitten-test', { versions: ['1.0.1'] })]),
    pypi: zip([malRecord('MAL-2026-18443', 'PyPI', 'wallet-tracking', { versions: ['1.0.0'] })]),
  });
  return shared;
}

/** The registry: kitten and cutekitten-test (old enough), fresh-kitten (published six hours ago), wallet-tracking on PyPI; others are not found. */
function registry(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (url.includes('osv.dev')) throw new Error(`asked ${url}`);
    if (url === 'https://pypi.org/simple/wallet-tracking/') return new Response(JSON.stringify(pypiPage('wallet-tracking', ['1.0.0', '2.0.0'])), { status: 200 });
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (name === 'kitten' || name === 'cutekitten-test') return new Response(JSON.stringify(packument(name, ['1.0.0', '1.0.1'])), { status: 200 });
    if (name === 'fresh-kitten') {
      const document = packument(name, ['1.0.0']) as { time: Record<string, string> };
      document.time['1.0.0'] = '2026-11-02T12:00:00.000Z';
      return new Response(JSON.stringify(document), { status: 200 });
    }
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '1d' } });
const NPM_PROJECT = { 'package.json': '{"name":"x","version":"1.0.0"}', 'depcurfew.json': POLICY };
const PYTHON_PROJECT = { 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n', 'depcurfew.json': POLICY };

interface Answer {
  decision: string | undefined;
  reason: string;
  context: string | undefined;
}

async function hook(command: string, files: Record<string, string>, osv: string | undefined, fetch: FetchLike = registry()): Promise<Answer> {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d172-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
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
  if (stdout.trim() === '') return { decision: undefined, reason: '', context: undefined };
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  return { decision: output['permissionDecision'], reason: output['permissionDecisionReason'] ?? '', context: output['additionalContext'] };
}

const KITTEN = 'cutekitten-test@1.0.1 is a known malicious version: OSV.dev lists it as MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const DENY_HEAD = 'depcurfew blocked this command because it installs a known malicious version, which OSV.dev lists:\n';

describe('npm link with package specs', () => {
  it('denies a known malicious version, as for npm install', async () => {
    for (const command of ['npm link cutekitten-test@1.0.1', 'npm ln cutekitten-test@1.0.1']) {
      const answer = await hook(command, NPM_PROJECT, await data());
      expect(answer.decision, command).toBe('deny');
      expect(answer.reason, command).toContain(`${DENY_HEAD}- cutekitten-test@1.0.1: ${KITTEN}`);
    }
  });

  it('denies a version younger than the policy allows, as for npm install', async () => {
    const answer = await hook('npm link fresh-kitten', NPM_PROJECT, undefined);
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain('- fresh-kitten: fresh-kitten@1.0.0 was published 6 hours ago; depcurfew.json requires 1 day');
  });

  it('looks the package up and goes through for one old enough', async () => {
    const fetch = registry();
    const answer = await hook('npm link kitten', NPM_PROJECT, undefined, fetch);
    expect(answer.decision).toBeUndefined();
    expect(fetch.urls).toEqual(['https://registry.npmjs.org/kitten']);
  });

  it('only warns about a name the registry does not have: npm link takes the global link of that name or fails', async () => {
    const answer = await hook('npm link my-local-lib', NPM_PROJECT, undefined);
    expect(answer.decision).toBeUndefined();
    expect(answer.reason).toBe('');
    expect(answer.context).toContain(
      '- my-local-lib: my-local-lib is not in the registry, so npm link installs nothing from it: it links the package of that name that is linked globally (npm link in its folder) or fails. Fix: Nothing to do if my-local-lib is your own package linked with npm link in its folder; otherwise check the spelling of the name',
    );
    // npm install of the same name is still denied.
    expect((await hook('npm install my-local-lib', NPM_PROJECT, undefined)).decision).toBe('deny');
  });

  it('does not look up a directory', async () => {
    const fetch = registry();
    const answer = await hook('npm link ../lib', NPM_PROJECT, undefined, fetch);
    expect(answer.decision).toBeUndefined();
    expect(fetch.urls).toEqual([]);
  });
});

describe('an install the scanner used to leave out', () => {
  it('denies a known malicious version after a here-document that bash ends at a delimiter split by a backslash-newline', async () => {
    const answer = await hook('cat <<EOF\nx\nEO\\\nF\nnpm i cutekitten-test@1.0.1', NPM_PROJECT, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(`- cutekitten-test@1.0.1: ${KITTEN}`);
  });

  it('denies a known malicious version under a command name that hash -p or BASH_CMDS gives npm', async () => {
    for (const command of ['hash -p /usr/bin/npm foo; foo i cutekitten-test@1.0.1', 'BASH_CMDS[foo]=/usr/bin/npm; foo i cutekitten-test@1.0.1']) {
      const answer = await hook(command, NPM_PROJECT, await data());
      expect(answer.decision, command).toBe('deny');
      expect(answer.reason, command).toContain(`- cutekitten-test@1.0.1: ${KITTEN}`);
    }
  });

  it('asks about a rebinding it does not read', async () => {
    const answer = await hook('BASH_CMDS+=([foo]=/usr/bin/npm); foo i kitten', NPM_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toBe(
      'depcurfew cannot vouch for what this command installs:\n- BASH_CMDS+=([foo]=/usr/bin/npm); foo i kitten: "BASH_CMDS+=" may set BASH_CMDS in a way depcurfew does not read, and a command name may then run a package manager. Fix: Run the package manager by its name, without hash -p, BASH_CMDS or BASH_ALIASES giving a command name another program, so depcurfew can check the command',
    );
  });

  it('denies a known malicious version that pipx inject or pipx runpip installs', async () => {
    for (const command of ['pipx inject ruff wallet-tracking==1.0.0', 'pipx runpip ruff install wallet-tracking==1.0.0']) {
      const answer = await hook(command, PYTHON_PROJECT, await data());
      expect(answer.decision, command).toBe('deny');
      expect(answer.reason, command).toContain('wallet-tracking==1.0.0');
    }
  });

  it('denies a known malicious version that pipx inject names next to a file of packages, which it asks about', async () => {
    const answer = await hook('pipx inject ruff wallet-tracking==1.0.0 -r reqs.txt', PYTHON_PROJECT, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain('wallet-tracking==1.0.0');
    expect(answer.reason).toContain(
      'depcurfew also cannot vouch for the rest of this command:\n- pipx inject ruff wallet-tracking==1.0.0 -r reqs.txt: -r installs the packages a file lists, which depcurfew does not read. Fix: Name the packages in the command instead of in a file',
    );
  });

  it('asks about pipx install-all', async () => {
    const answer = await hook('pipx install-all spec.json', PYTHON_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toBe(
      'depcurfew cannot vouch for what this command installs:\n- pipx install-all spec.json: pipx install-all installs the packages a file lists, which depcurfew does not read. Fix: Name the packages in the command instead of in a file (pipx install <name>, pipx inject <environment> <name>), so depcurfew can check each of them',
    );
  });
});
