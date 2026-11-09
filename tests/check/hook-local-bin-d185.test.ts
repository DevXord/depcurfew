// Decision D-185 in the Claude Code hook: npx, npm exec and npm x without a package option run a program of the
// project when node_modules/.bin of npm's local prefix (or of the workspace the command runs in) or of a directory above
// it has a file of that name and no package.json there declares a bin of that name; they download nothing then, so the
// hook asks no registry about it. Anything else is checked as before: a version, a package option, a workspace option,
// a command before it on the line that may write files, a loop, a program that is not there.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { runsLocalBinary } from '../../src/check/local-binaries.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d185-home-'));
temporary.push(HOME);

/** A registry that has no package at all, and records what it was asked. */
function registry(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '1d' } });
const PACKAGE = JSON.stringify({ name: 'app', version: '1.0.0' });
/** A project whose node_modules/.bin has vitest and tsc, and a directory sub without a package.json. */
const PROJECT: Record<string, string> = {
  'package.json': PACKAGE,
  'depcurfew.json': POLICY,
  'node_modules/.bin/vitest': '#!/bin/sh\n',
  'node_modules/.bin/tsc': '#!/bin/sh\n',
  'sub/notes.txt': 'x\n',
};

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d185-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

interface Answer {
  decision: string | undefined;
  urls: string[];
}

async function hook(command: string, root: string, cwd = root): Promise<Answer> {
  const fetch = registry();
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch,
    now: () => NOW,
    stdin: async () => event,
    home: () => HOME,
    projectDir: () => root,
    osvData: () => undefined,
  });
  expect(code).toBe(0);
  if (stdout.trim() === '') return { decision: undefined, urls: fetch.urls };
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  return { decision: output['permissionDecision'], urls: fetch.urls };
}

const NOTHING: Answer = { decision: undefined, urls: [] };
const lookedUp = (name: string) => `https://registry.npmjs.org/${name}`;

describe('npx of a program in node_modules/.bin (decision D-185)', () => {
  it('asks no registry when npx, npm exec or npm x runs a program of the project', async () => {
    const root = project(PROJECT);
    for (const command of ['npx vitest run', 'npx --yes vitest run tests/a.test.ts', 'npx tsc --noEmit 2>&1 | head -20', 'npm exec vitest -- run', 'npm x tsc', 'cd sub && npx vitest']) {
      expect(await hook(command, root), command).toEqual(NOTHING);
    }
    expect(await hook('npx vitest', root, join(root, 'sub'))).toEqual(NOTHING);
  });

  it('checks the package as before when npx would download it', async () => {
    const root = project(PROJECT);
    for (const command of [
      'npx vitest@1 run',
      'npx -p vitest vitest',
      'npx --package=vitest vitest',
      'npx -w a vitest',
      'npx --ws vitest',
      'npm exec --workspace=a vitest',
      'npm exec vitest --workspaces',
      'npx --include-workspace-root vitest',
      'rm -rf node_modules && npx vitest',
      'echo x > notes.txt; npx vitest',
      'for i in 1 2; do npx vitest; done',
      'npx vitest; rm -rf node_modules; npx vitest',
      'npx rimraf node_modules && npx vitest',
      'npx eslint .',
    ]) {
      const answer = await hook(command, root);
      expect(answer.decision, command).toBe('deny');
      expect(answer.urls.some((url) => url === lookedUp('vitest') || url === lookedUp('eslint')), command).toBe(true);
    }
  });

  it('checks it when a package.json there declares a bin of that name, or cannot be read', async () => {
    const cases: Record<string, string>[] = [
      { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', bin: { vitest: 'cli.js' } }) },
      { 'package.json': JSON.stringify({ name: 'vitest', version: '1.0.0', bin: 'cli.js' }) },
      { 'package.json': JSON.stringify({ name: '@acme/vitest', version: '1.0.0', bin: './cli.js' }) },
      { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', directories: { bin: 'bin' } }) },
      { 'package.json': '{ not json' },
    ];
    for (const files of cases) {
      const answer = await hook('npx vitest', project({ ...PROJECT, ...files }));
      expect(answer.decision, files['package.json']).toBe('deny');
      expect(answer.urls).toContain(lookedUp('vitest'));
    }
  });

  it('checks it when the name is not a file of node_modules/.bin', async () => {
    const root = project({ 'package.json': PACKAGE, 'depcurfew.json': POLICY, 'node_modules/.bin/vitest/index.js': 'x\n' });
    expect((await hook('npx vitest', root)).urls).toContain(lookedUp('vitest'));
  });

  it.skipIf(process.platform === 'win32')('checks it when the program is a link to nothing', async () => {
    const root = project({ 'package.json': PACKAGE, 'depcurfew.json': POLICY, 'node_modules/.bin/.keep': '' });
    symlinkSync(join(root, 'node_modules', 'vitest', 'missing.js'), join(root, 'node_modules', '.bin', 'vitest'));
    expect((await hook('npx vitest', root)).urls).toContain(lookedUp('vitest'));
  });

  it('follows npm into the workspace the command runs in, and up from it', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces: ['packages/a'] }),
      'depcurfew.json': POLICY,
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'packages/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0' }),
      'packages/a/node_modules/.bin/vitest': '#!/bin/sh\n',
    });
    const a = join(root, 'packages', 'a');
    expect(await hook('npx vitest', root, a)).toEqual(NOTHING);
    expect(await hook('npx tsc', root, a)).toEqual(NOTHING);
    // From the root npm does not look into the workspace's own node_modules/.bin.
    expect((await hook('npx vitest', root)).urls).toContain(lookedUp('vitest'));
    // The bin of the workspace's package.json is run first, which installs its dependencies.
    const own = project({
      'package.json': JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces: ['packages/a'] }),
      'depcurfew.json': POLICY,
      'node_modules/.bin/vitest': '#!/bin/sh\n',
      'packages/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0', bin: { vitest: 'cli.js' } }),
    });
    expect((await hook('npx vitest', own, join(own, 'packages', 'a'))).urls).toContain(lookedUp('vitest'));
  });

  it('looks from the directory --prefix names', async () => {
    const tools = project({ 'package.json': PACKAGE, 'depcurfew.json': POLICY, 'tools/package.json': PACKAGE, 'tools/node_modules/.bin/vitest': '#!/bin/sh\n', 'empty/package.json': PACKAGE });
    expect(await hook('npx --prefix tools vitest', tools)).toEqual(NOTHING);
    // The working directory has no such program, nor has the directory --prefix names.
    expect((await hook('npx vitest', tools)).urls).toContain(lookedUp('vitest'));
    expect((await hook('npx --prefix empty vitest', tools)).urls).toContain(lookedUp('vitest'));
  });
});

describe('looking for the program in a hostile tree (decision D-185)', () => {
  it.skipIf(process.platform === 'win32')('stops after 256 directories up, and checks the package then, in well under a second', () => {
    const root = project({ 'node_modules/.bin/vitest': '#!/bin/sh\n' });
    const near = join(root, ...Array.from({ length: 40 }, () => 'd'));
    const far = join(root, ...Array.from({ length: 300 }, () => 'd'));
    mkdirSync(far, { recursive: true });
    // npm's local prefix is the nearest directory with a package.json or node_modules: the program is 300 levels above it.
    writeFileSync(join(far, 'package.json'), PACKAGE);
    const start = performance.now();
    expect(runsLocalBinary(near, 'vitest')).toBe(true);
    expect(runsLocalBinary(far, 'vitest')).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('reads a package.json of at most 1 MiB and refuses a larger one', () => {
    const big = project({ 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', description: 'x'.repeat(1024 * 1024) }), 'node_modules/.bin/vitest': '#!/bin/sh\n' });
    expect(runsLocalBinary(big, 'vitest')).toBe(false);
    const small = project({ 'package.json': PACKAGE, 'node_modules/.bin/vitest': '#!/bin/sh\n' });
    expect(runsLocalBinary(small, 'vitest')).toBe(true);
  });
});
