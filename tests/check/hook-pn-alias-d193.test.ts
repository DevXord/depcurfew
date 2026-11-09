// Decision D-193: the Claude Code hook reads pnpm's program pn as pnpm. The package pnpm installs pn next to pnpm since
// 11.0.0-beta.3 ("`pn` is `pnpm`"), and the hook let pn add, pn dlx, pn create and pn install --config.minimumReleaseAge=0
// through unchecked while it checks them with pnpm (found by the review of 1.6.0, already in 1.5.2).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { scanCommandLine } from '../../src/check/command.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d193-home-'));
temporary.push(HOME);
const ROOT = mkdtempSync(join(tmpdir(), 'depcurfew-d193-'));
temporary.push(ROOT);
mkdirSync(join(ROOT, '.git'));
writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', packageManager: 'pnpm@12.18.0' }));
writeFileSync(join(ROOT, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '1d' }, installScripts: { default: 'deny' } }));

/** The registry URLs the hook asks and its decision for `command`. */
async function hook(command: string, tool = 'Bash'): Promise<{ urls: string[]; decision: unknown }> {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike;
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: ROOT });
  await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch, now: () => NOW, stdin: async () => event, home: () => HOME, projectDir: () => ROOT, osvData: () => undefined });
  const output = stdout.trim() === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } });
  return { urls, decision: output.hookSpecificOutput?.permissionDecision };
}

describe("pnpm's program pn in the Claude Code hook (decision D-193)", () => {
  it('is read as pnpm: the same lookups and the same decision', async () => {
    for (const command of ['add lodahs', 'i lodahs', 'add -D lodahs@1.0.0', 'dlx lodahs', 'create vite', 'install --config.minimumReleaseAge=0', 'install --config.ignore-scripts=false', 'install']) {
      const pnpm = await hook(`pnpm ${command}`);
      const pn = await hook(`pn ${command}`);
      expect(pn, `pn ${command}`).toEqual(pnpm);
    }
    expect((await hook('pn add lodahs')).urls).toContain('https://registry.npmjs.org/lodahs');
    expect((await hook('pn create vite')).urls).toContain('https://registry.npmjs.org/create-vite');
    expect((await hook('pn install --config.minimumReleaseAge=0')).decision).toBe((await hook('pnpm install --config.minimumReleaseAge=0')).decision);
  });

  it('also as pn.cmd and pn.ps1 in PowerShell, and with a path', async () => {
    for (const command of ['pn.cmd add lodahs', '& pn.ps1 add lodahs', 'C:\\Users\\me\\AppData\\Roaming\\npm\\pn.cmd add lodahs']) {
      expect((await hook(command, 'PowerShell')).urls, command).toContain('https://registry.npmjs.org/lodahs');
    }
    expect((await hook('/usr/local/bin/pn add lodahs')).urls).toContain('https://registry.npmjs.org/lodahs');
  });

  it('scans pn as pnpm', () => {
    expect(scanCommandLine('pn add lodahs')).toEqual({ requests: [{ tool: 'pnpm', command: 'pn add lodahs', spec: 'lodahs' }] });
  });
});
