// Decision D-160 in the Claude Code hook: the packages a download command names before its subcommand (pnpm
// --package=x dlx y, npm --package=x exec y, yarn -p x dlx y, bun --package=x x y) and among the arguments of npm exec
// are checked; a known malicious exact version is denied also in a command that a word the shell expands leaves
// unreadable, with that reason after it; and the reason says when specs past the first 10,000 were not looked up in
// the local OSV.dev data, on every path. A version the local data does not list gets the answer it got before.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_LISTED_SPECS } from '../../src/check/listed.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { call, cleanUp, initialized } from '../mcp/support.ts';
import { packument, pypiPage } from '../support/osv.ts';
import { localData } from '../support/osv-data.ts';
import { buildZip, malRecord } from '../support/zip.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
  cleanUp();
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d160-home-'));
temporary.push(HOME);

let shared: string | undefined;
/** The local data: cutekitten-test 1.0.1 (npm), wallet-tracking 1.0.0 (PyPI) and intercom/intercom-php 5.0.2 (Packagist). */
async function data(): Promise<string> {
  const zip = (records: readonly string[]) => buildZip(records.map((record) => ({ name: `${(JSON.parse(record) as { id: string }).id}.json`, data: record })));
  shared ??= await localData(temporary, NOW, {
    npm: zip([malRecord('MAL-2026-18458', 'npm', 'cutekitten-test', { versions: ['1.0.1'] })]),
    pypi: zip([malRecord('MAL-2026-18443', 'PyPI', 'wallet-tracking', { versions: ['1.0.0'] })]),
    packagist: zip([malRecord('MAL-2026-3637', 'Packagist', 'intercom/intercom-php', { versions: ['5.0.2'] })]),
  });
  return shared;
}

/** The public registry: kitten, filler-N and cutekitten-test (1.0.0 and 1.0.1, both old enough) and wallet-tracking; nothing else answers. */
function registry(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (url.includes('osv.dev')) throw new Error(`asked ${url}`);
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (/^(?:filler-\d+|cutekitten-test|kitten)$/u.test(name)) return new Response(JSON.stringify(packument(name, ['1.0.0', '1.0.1'])), { status: 200 });
    if (url === 'https://pypi.org/simple/wallet-tracking/') return new Response(JSON.stringify(pypiPage('wallet-tracking', ['1.0.0', '2.0.0'])), { status: 200 });
    throw new TypeError('fetch failed');
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '1h' } });
const INVALID = JSON.stringify({ version: 1, cooldown: { minimum: 'soon' } });
const NPM_PROJECT = { 'package.json': '{"name":"x","version":"1.0.0"}', 'depcurfew.json': POLICY };
const PYTHON_PROJECT = { 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n', 'depcurfew.json': POLICY };
const COMPOSER_PROJECT = { 'composer.json': '{"name":"a/b"}', 'depcurfew.json': POLICY };

interface Answer {
  decision: string | undefined;
  reason: string;
  stdout: string;
}

async function hook(command: string, files: Record<string, string>, osv: string | undefined, fetch: FetchLike = registry()): Promise<Answer> {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d160-'));
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
  if (stdout.trim() === '') return { decision: undefined, reason: '', stdout };
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  return { decision: output['permissionDecision'], reason: output['permissionDecisionReason'] ?? '', stdout };
}

const KITTEN = 'cutekitten-test@1.0.1 is a known malicious version: OSV.dev lists it as MAL-2026-18458 (https://osv.dev/vulnerability/MAL-2026-18458)';
const FIX = 'Do not install it; pick another package or version. If it is installed anywhere already, remove it and read the record on OSV.dev for what it does';
const DENY_HEAD = 'depcurfew blocked this command because it installs a known malicious version, which OSV.dev lists:\n';
const ALSO = 'depcurfew also cannot vouch for the rest of this command:\n';
const WRITE_OUT = 'Write the package names out in the command, so depcurfew can check them';
const SMALLER = 'Install the packages in smaller groups, so depcurfew can check each of them';
const UNLISTED = `the command names ${MAX_LISTED_SPECS + 1} packages, and only the first ${MAX_LISTED_SPECS} could be looked up in the local OSV.dev data`;
const fillers = (count: number) => Array.from({ length: count }, (_, index) => `filler-${index}@1.0.0`).join(' ');

describe('the packages of a download command named before its subcommand or among the arguments of npm exec', () => {
  it.each([
    ['pnpm --package=cutekitten-test@1.0.1 dlx kitten', 'cutekitten-test@1.0.1'],
    ['pnpm --package cutekitten-test@1.0.1 dlx kitten', 'cutekitten-test@1.0.1'],
    ['pnpm --package=kitten@1.0.0 --package cutekitten-test@1.0.1 dlx kitten', 'cutekitten-test@1.0.1'],
    ["pnpm --package cutekitten-test@1.0.1 -c dlx 'kitten hi'", 'cutekitten-test@1.0.1'],
    ['npm --package=cutekitten-test@1.0.1 exec kitten', 'cutekitten-test@1.0.1'],
    ['npm --package cutekitten-test@1.0.1 x kitten', 'cutekitten-test@1.0.1'],
    ['npm exec kitten --package=cutekitten-test@1.0.1', 'cutekitten-test@1.0.1'],
    ['yarn -p cutekitten-test@1.0.1 dlx kitten', 'cutekitten-test@1.0.1'],
    ['yarn --package=cutekitten-test@1.0.1 dlx kitten', 'cutekitten-test@1.0.1'],
    ['bun --package=cutekitten-test@1.0.1 x kitten', 'cutekitten-test@1.0.1'],
  ])('%s is denied', async (command, spec) => {
    const answer = await hook(command, NPM_PROJECT, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toBe(`${DENY_HEAD}- ${spec}: ${KITTEN}. Fix: ${FIX}\nChoose another package or version.`);
  });

  it('also with an invalid depcurfew.json, without the registry', async () => {
    const fetch = registry();
    const answer = await hook('pnpm --package cutekitten-test@1.0.1 dlx kitten', { ...NPM_PROJECT, 'depcurfew.json': INVALID }, await data(), fetch);
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(`- cutekitten-test@1.0.1: ${KITTEN}`);
    expect(fetch.urls).toEqual([]);
  });

  it('checks the package, not the command, and goes through for an old version the data does not list', async () => {
    for (const command of ['pnpm --package=cutekitten-test@1.0.0 dlx kitten', 'npm exec kitten --package=cutekitten-test@1.0.0', 'yarn -p cutekitten-test@1.0.0 dlx kitten']) {
      const fetch = registry();
      const listed = await hook(command, NPM_PROJECT, await data(), fetch);
      expect(listed.decision, command).toBeUndefined();
      expect(fetch.urls, command).toEqual(['https://registry.npmjs.org/cutekitten-test']);
      expect((await hook(command, NPM_PROJECT, undefined)).stdout, command).toBe(listed.stdout);
    }
  });

  it('asks about npm exec with a word the shell expands among its arguments', async () => {
    const answer = await hook('npm exec kitten "$X"', NPM_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toBe(
      'depcurfew cannot vouch for what this command installs:\n- npm exec kitten $X: "$X" is expanded by the shell, and npm exec reads the options among its arguments up to --. Fix: Put -- before the command that npm exec or npm x runs (npm exec -- <command> …), so npm does not read its arguments as its own options',
    );
    expect((await hook('npm exec -- kitten "$X"', NPM_PROJECT, await data())).decision).toBeUndefined();
  });
});

describe('a known malicious exact version next to a word the shell expands', () => {
  it.each([
    ['npm i cutekitten-test@1.0.1 "$X"', 'npm i cutekitten-test@1.0.1 $X: "$X" is expanded by the shell'],
    ['npm i cutekitten-test@1.0.1 *', 'npm i cutekitten-test@1.0.1 *: "*" is expanded by the shell'],
    ['npm i cutekitten-test@1.0.1 {a,b}', 'npm i cutekitten-test@1.0.1 {a,b}: "{a,b}" is expanded by the shell'],
    ['npm i cutekitten-test@1.0.1 $(true)', 'npm i cutekitten-test@1.0.1 $(true): "$(true)" is expanded by the shell'],
    ['npm i cutekitten-test@1.0.1 --foo=$X', 'npm i cutekitten-test@1.0.1 --foo=$X: "--foo=$X" is expanded by the shell'],
    ['npm i "$X" cutekitten-test@1.0.1', 'npm i $X cutekitten-test@1.0.1: "$X" is expanded by the shell'],
  ])('%s is denied, and the reason says why the rest was not checked', async (command, reason) => {
    const fetch = registry();
    const answer = await hook(command, NPM_PROJECT, await data(), fetch);
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toBe(`${DENY_HEAD}- cutekitten-test@1.0.1: ${KITTEN}. Fix: ${FIX}\nChoose another package or version.\n${ALSO}- ${reason}. Fix: ${WRITE_OUT}`);
    expect(fetch.urls).toEqual([]);
  });

  it.each([
    ['pip install wallet-tracking==1.0.0 $X', PYTHON_PROJECT, 'MAL-2026-18443'],
    ['uv pip install "$X" wallet_tracking==1.0', PYTHON_PROJECT, 'MAL-2026-18443'],
    ['composer require intercom/intercom-php:5.0.2 $X', COMPOSER_PROJECT, 'MAL-2026-3637'],
    ['composer require intercom/intercom-php v5.0.2 "$X"', COMPOSER_PROJECT, 'MAL-2026-3637'],
  ])('%s is denied', async (command, files, id) => {
    const answer = await hook(command, files, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason).toContain(`OSV.dev lists it as ${id}`);
    expect(answer.reason).toContain(`${ALSO}- `);
    expect(answer.reason).toContain('is expanded by the shell');
  });

  it('with an invalid depcurfew.json too', async () => {
    const answer = await hook('npm i cutekitten-test@1.0.1 "$X"', { ...NPM_PROJECT, 'depcurfew.json': INVALID }, await data());
    expect(answer.decision).toBe('deny');
    expect(answer.reason.startsWith(`${DENY_HEAD}- cutekitten-test@1.0.1: ${KITTEN}. Fix: ${FIX}\nChoose another package or version.\n`)).toBe(true);
    expect(answer.reason).toContain('depcurfew cannot check the rest of this command: depcurfew.json is invalid');
  });

  it('gives a version the data does not list the answer it got before', async () => {
    for (const [command, files] of [
      ['npm i cutekitten-test@1.0.0 "$X"', NPM_PROJECT],
      ['npm i cutekitten-test@1.0.0 *', { ...NPM_PROJECT, 'depcurfew.json': INVALID }],
      ['pip install wallet-tracking==2.0.0 $X', PYTHON_PROJECT],
      ['composer require intercom/intercom-php:5.0.1 $X', COMPOSER_PROJECT],
    ] as const) {
      const without = await hook(command, files, undefined);
      const listed = await hook(command, files, await data());
      expect(without.decision, command).toBe('ask');
      expect(listed.stdout, command).toBe(without.stdout);
    }
  });
});

describe(`the reason says when specs past the first ${MAX_LISTED_SPECS} were not looked up`, () => {
  it('in a command left out for --registry', async () => {
    const fetch = registry();
    const answer = await hook(`npm i --registry=https://npm.evil.example ${fillers(MAX_LISTED_SPECS)} cutekitten-test@1.0.1`, NPM_PROJECT, await data(), fetch);
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toContain(': --registry may point the package manager at another registry, which depcurfew does not look up. Fix: ');
    expect(answer.reason.endsWith(`\n- ${UNLISTED}. Fix: ${SMALLER}`)).toBe(true);
    expect(fetch.urls).toEqual([]);
  });

  it('in a command a word the shell expands leaves unreadable', async () => {
    const answer = await hook(`npm i ${fillers(MAX_LISTED_SPECS)} cutekitten-test@1.0.1 "$X"`, NPM_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toContain('"$X" is expanded by the shell. Fix: ');
    expect(answer.reason.endsWith(`\n- ${UNLISTED}. Fix: ${SMALLER}`)).toBe(true);
  });

  it('with more than 50 packages, next to the reason for those', async () => {
    const answer = await hook(`npm i ${fillers(MAX_LISTED_SPECS)} cutekitten-test@1.0.1`, NPM_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toContain(
      `\n- the command names ${MAX_LISTED_SPECS + 1} packages and depcurfew checks at most 50 in one command; the first 50 were checked. Fix: ${SMALLER}\n- ${UNLISTED}. Fix: ${SMALLER}`,
    );
  });

  it('with an invalid depcurfew.json', async () => {
    const fetch = registry();
    const answer = await hook(`npm i ${fillers(MAX_LISTED_SPECS)} cutekitten-test@1.0.1`, { ...NPM_PROJECT, 'depcurfew.json': INVALID }, await data(), fetch);
    expect(answer.decision).toBe('ask');
    expect(answer.reason.startsWith('depcurfew cannot check this command: depcurfew.json is invalid; cooldown.minimum: invalid duration "soon"')).toBe(true);
    expect(answer.reason.endsWith(`\n- ${UNLISTED}. Fix: ${SMALLER}`)).toBe(true);
    expect(answer.reason.split('\n')).toHaveLength(2);
    expect(fetch.urls).toEqual([]);
  });

  it('after a listed version it denies, also with an invalid depcurfew.json', async () => {
    const command = `npm i cutekitten-test@1.0.1 ${fillers(MAX_LISTED_SPECS)}`;
    const invalid = await hook(command, { ...NPM_PROJECT, 'depcurfew.json': INVALID }, await data());
    expect(invalid.decision).toBe('deny');
    expect(invalid.reason).toContain(`\nChoose another package or version.\n${ALSO}- ${UNLISTED}. Fix: ${SMALLER}\ndepcurfew cannot check the rest of this command: depcurfew.json is invalid`);
    const valid = await hook(command, NPM_PROJECT, await data());
    expect(valid.decision).toBe('deny');
    expect(valid.reason.endsWith(`\n- ${UNLISTED}. Fix: ${SMALLER}`)).toBe(true);
  });

  it(`says nothing of it with ${MAX_LISTED_SPECS} specs`, async () => {
    const answer = await hook(`npm i --registry=https://npm.evil.example ${fillers(MAX_LISTED_SPECS)}`, NPM_PROJECT, await data());
    expect(answer.decision).toBe('ask');
    expect(answer.reason).not.toContain('could be looked up');
  });
});

describe('depcurfew check and check_packages say it too, where only the versions named exactly are looked up', () => {
  async function check(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const osv = await data();
    const code = await run(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
      fetch: registry(),
      now: () => NOW,
      stdin: async () => '',
      home: () => HOME,
      osvData: () => osv,
    });
    return { code, stdout, stderr };
  }
  const specs = [...fillers(MAX_LISTED_SPECS).split(' '), 'cutekitten-test@1.0.1'];
  const NOTICE = {
    level: 'warning',
    code: 'too-many-packages',
    message: `the check names ${MAX_LISTED_SPECS + 1} package specs, and only the first ${MAX_LISTED_SPECS} could be looked up in the local OSV.dev data`,
    fix: `Check the packages in groups of at most ${MAX_LISTED_SPECS}`,
  };

  it('check --json with an invalid depcurfew.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d160-check-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'depcurfew.json'), INVALID);
    const result = await check(['check', '--json', '--dir', directory, ...specs]);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.stdout) as { packages: unknown[]; notices: unknown[]; errors: { code: string }[] };
    expect(document.packages).toEqual([]);
    expect(document.notices).toEqual([NOTICE]);
    expect(document.errors.map((error) => error.code)).toEqual(['policy-invalid']);
    // As text, the warning follows the error on stderr.
    const text = await check(['check', '--dir', directory, ...specs]);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain(`\nwarning: ${NOTICE.message} (too-many-packages)\n  fix: ${NOTICE.fix}\n`);
    // Within the limit, nothing is said.
    const within = await check(['check', '--json', '--dir', directory, ...specs.slice(1)]);
    expect((JSON.parse(within.stdout) as { notices: unknown[]; packages: unknown[] }).notices).toEqual([]);
    expect((JSON.parse(within.stdout) as { packages: { spec: string }[] }).packages.map((report) => report.spec)).toEqual(['cutekitten-test@1.0.1']);
  });

  it('check_packages with more than 50 specs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-d160-mcp-'));
    temporary.push(directory);
    writeFileSync(join(directory, 'depcurfew.json'), POLICY);
    const client = await initialized(directory, '2025-11-25', { argv: ['mcp', '--dir', directory], fetch: registry(), osvData: await data(), now: NOW });
    try {
      client.send(call(1, 'check_packages', { packages: ['cutekitten-test@1.0.1', ...specs.slice(0, -1), 'kitten@1.0.0'] }));
      const answer = (await client.next())['result'] as { structuredContent: { notices: { code: string; message: string }[]; packages: { spec: string }[] } };
      expect(answer.structuredContent.packages.map((report) => report.spec)).toEqual(['cutekitten-test@1.0.1']);
      expect(answer.structuredContent.notices[0]).toMatchObject({
        code: 'too-many-packages',
        message: `packages lists ${MAX_LISTED_SPECS + 2} package specs, and check_packages checks at most 50 in one call: only the versions the first ${MAX_LISTED_SPECS} of them name exactly were looked up, in the local OSV.dev data`,
      });
    } finally {
      await client.close();
    }
  });
});
