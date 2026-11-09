// Decision D-189: the Claude Code hook looks the package of `npx <name>`, `npm exec <name>` and `npm x <name>` up in
// the registry also when node_modules/.bin of the project has a program of that name, as up to 1.5.2. The skip of
// D-185 trusted the files where the agent runs, but npm moves or turns off its search for a local program in many
// ordinary ways (another host or root, global mode, --prefix after the name, package= from the environment or .npmrc,
// a pipeline that removes the program, a nested change of directory, a bin npm normalizes), and then downloads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d189-home-'));
temporary.push(HOME);

function registry(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike & { urls: string[] };
  fetch.urls = urls;
  return fetch;
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d189-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const LOCAL = {
  'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
  'depcurfew.json': JSON.stringify({ version: 1, cooldown: { minimum: '1d' } }),
  'node_modules/.bin/vitest': '#!/bin/sh\n',
  'empty/package.json': JSON.stringify({ name: 'empty', version: '1.0.0' }),
};

async function lookups(command: string, root: string, tool = 'Bash'): Promise<string[]> {
  const fetch = registry();
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: () => {}, stderr: () => {} }, { fetch, now: () => NOW, stdin: async () => event, home: () => HOME, projectDir: () => root, osvData: () => undefined });
  expect(code).toBe(0);
  return fetch.urls;
}

describe('npx of a name the project has in node_modules/.bin (decision D-189)', () => {
  it('is looked up in the registry', async () => {
    const root = project(LOCAL);
    for (const command of [
      'npx vitest run',
      'npm exec vitest',
      'npm x vitest',
      'ssh buildhost npx vitest',
      'docker run --rm node:22 npx vitest',
      'sudo -i npx vitest',
      'npx -g vitest',
      'npm exec vitest --prefix empty',
      'npm_config_package=evil npx vitest',
      'npx vitest | mv node_modules nm',
      'npx vitest & rm -rf node_modules',
    ]) {
      expect(await lookups(command, root), command).toContain('https://registry.npmjs.org/vitest');
    }
    expect(await lookups('cmd /c "cd /d empty && npx vitest"', root, 'PowerShell')).toContain('https://registry.npmjs.org/vitest');
  });

  it('is looked up whatever the bin of the project package.json looks like', async () => {
    for (const bin of [['bin/vitest'], { './vitest': 'cli.js' }, { 'tools/vitest': 'cli.js' }]) {
      const root = project({ ...LOCAL, 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', bin }) });
      expect(await lookups('npx vitest', root), JSON.stringify(bin)).toContain('https://registry.npmjs.org/vitest');
    }
  });
});
