// Decision D-201 in the Claude Code hook: bunx and bun x run the package after an option of npm, pnpm or Yarn and its
// value in Bun 1.4.4 (`bunx --before lodash evil-pkg` runs evil-pkg), and Bun 1.3.0 to 1.4.3 the word after the
// option, so both are checked; bun add takes a value after --cpu, --os and --linker, so `bun add --cpu x64 left-pad`
// checks left-pad and not a made-up x64; and --minimum-release-age-excludes, which exempts packages from the
// release-age delay for one command (Bun 1.4.4), makes the hook ask. The same in PowerShell.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';

const NOW = new Date('2026-11-11T12:00:00Z');
const temporary: string[] = [];
let HOME = '';
let ROOT = '';
// Made in beforeAll, which Vitest skips, as it skips afterAll, when a -t filter leaves no test of the file.
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d201-home-'));
  temporary.push(HOME);
  ROOT = mkdtempSync(join(tmpdir(), 'depcurfew-d201-'));
  temporary.push(ROOT);
  mkdirSync(join(ROOT, '.git'));
  writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true, packageManager: 'bun@1.4.4' }));
  writeFileSync(join(ROOT, 'bunfig.toml'), '[install]\nminimumReleaseAge = 259200\n');
  writeFileSync(join(ROOT, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' } }));
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** Packages published long before NOW; evil-pkg was published an hour before it; every other name is unknown. */
const OLD = new Set(['lodash', 'left-pad', 'typescript', 'linux', 'cowsay']);

function packument(name: string, time: string): unknown {
  return { name, 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': time }, versions: { '1.0.0': { name, version: '1.0.0' } } };
}

/** The registry URLs the hook asks and its decision and reason for `command`. */
async function hook(command: string, tool = 'Bash'): Promise<{ urls: string[]; decision: string | undefined; reason: string; context: string }> {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (name === 'evil-pkg') return new Response(JSON.stringify(packument(name, '2026-11-11T11:00:00.000Z')), { status: 200 });
    if (OLD.has(name)) return new Response(JSON.stringify(packument(name, '2026-01-01T00:00:00.000Z')), { status: 200 });
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike;
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: ROOT });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch, now: () => NOW, stdin: async () => event, home: () => HOME, projectDir: () => ROOT, osvData: () => undefined });
  expect(code).toBe(0);
  if (stdout.trim() === '') return { urls, decision: undefined, reason: '', context: '' };
  const output = (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string | undefined> }).hookSpecificOutput;
  return { urls, decision: output['permissionDecision'], reason: output['permissionDecisionReason'] ?? '', context: output['additionalContext'] ?? '' };
}

const url = (name: string) => `https://registry.npmjs.org/${name}`;

describe('bunx and bun x with an option of npm, pnpm or Yarn and its value (decision D-201)', () => {
  it.each(['bunx --before lodash evil-pkg', 'bunx --tag lodash evil-pkg', 'bun x --before lodash evil-pkg', 'bunx --shell lodash evil-pkg', 'bunx --os linux evil-pkg', 'bunx --node-arg lodash evil-pkg'])(
    '%s looks up evil-pkg and is denied',
    async (command) => {
      const answer = await hook(command);
      expect(answer.urls).toContain(url('evil-pkg'));
      expect(answer.decision).toBe('deny');
      expect(answer.reason).toContain('evil-pkg');
    },
  );

  it('reads an option that the value of a skipped option would hide, as Bun does', async () => {
    const registry = await hook('bunx --before --registry=https://npm.evil.example lodash');
    expect(registry.decision).toBe('ask');
    expect(registry.reason).toContain('--registry');
    const trust = await hook('bunx --tag --trust lodash');
    expect(trust.decision).toBe('ask');
    expect(trust.reason).toContain('--trust');
  });
});

describe('bun add reads the values of --cpu, --os and --linker (decision D-201)', () => {
  it.each(['bun add --cpu x64 left-pad', 'bun add --os linux left-pad', 'bun add --linker hoisted left-pad'])('%s checks left-pad only', async (command) => {
    const answer = await hook(command);
    expect(answer.urls).toEqual([url('left-pad')]);
    expect(answer.decision).toBeUndefined();
  });
});

describe('--minimum-release-age-excludes makes the hook ask (decision D-201)', () => {
  it.each(['bun add left-pad --minimum-release-age-excludes lodash', 'bun add left-pad --minimum-release-age-excludes=lodash', 'bun update --minimum-release-age-excludes lodash', 'bun install --minimum-release-age-excludes left-pad,typescript'])(
    '%s',
    async (command) => {
      const answer = await hook(command);
      expect(answer.decision).toBe('ask');
      expect(answer.reason).toContain('--minimum-release-age-excludes');
      expect(answer.reason).toContain('changes the release-age delay of 3 days that depcurfew.json requires');
      expect(answer.reason).not.toContain('is not a package spec');
    },
  );

  it('checks the packages it exempts', async () => {
    expect((await hook('bun install --minimum-release-age-excludes left-pad,typescript')).urls.sort()).toEqual([url('left-pad'), url('typescript')]);
    // An exempted package that is younger than the delay is what the option lets in.
    expect((await hook('bun add left-pad --minimum-release-age-excludes evil-pkg')).decision).toBe('deny');
  });
});

describe('the same in PowerShell (decision D-201)', () => {
  it('denies bunx with a skipped option before a young package, reads bun add --cpu and asks about the exceptions', async () => {
    for (const command of ['bunx --before lodash evil-pkg', 'bunx.exe --tag lodash evil-pkg', '& bunx.cmd --before lodash evil-pkg', 'bun x --before lodash evil-pkg']) {
      const answer = await hook(command, 'PowerShell');
      expect(answer.urls, command).toContain(url('evil-pkg'));
      expect(answer.decision, command).toBe('deny');
    }
    const cpu = await hook('bun add --cpu x64 left-pad', 'PowerShell');
    expect(cpu.urls).toEqual([url('left-pad')]);
    expect(cpu.decision).toBeUndefined();
    const excludes = await hook('bun add left-pad --minimum-release-age-excludes lodash', 'PowerShell');
    expect(excludes.decision).toBe('ask');
    expect(excludes.reason).toContain('--minimum-release-age-excludes');
  });
});

describe('a value that Bun 1.4.4 reads for an option, and older Bun as a package, that the registry lacks (decision D-201)', () => {
  it.each([
    ['bun add --libc musl left-pad', 'musl', '--libc'],
    ['bunx --before 2026-01-01 cowsay', '2026-01-01', '--before'],
    ['bunx --tag beta cowsay', 'beta', '--tag'],
  ])('%s only warns about %s', async (command, value, option) => {
    const answer = await hook(command);
    expect(answer.urls).toContain(url(value));
    expect(answer.decision).toBeUndefined();
    expect(answer.reason).toBe('');
    expect(answer.context).toContain(
      `- ${value}: ${value} is not in the registry: Bun 1.4.4 reads it as the value of ${option}; Bun before 1.4.4 would try to install it and fail. Fix: Write ${option}=${value} in one word, so that every Bun reads it as the value`,
    );
  });

  it('still denies a package after the value, and a value that is a package too young for the policy', async () => {
    const after = await hook('bunx --before 2026-01-01 evil-pkg');
    expect(after.decision).toBe('deny');
    expect(after.reason).toContain('evil-pkg');
    expect(after.reason).not.toContain('2026-01-01');
    const young = await hook('bun add --libc evil-pkg left-pad');
    expect(young.decision).toBe('deny');
    expect(young.reason).toContain('evil-pkg');
    // The same name as a package of its own is a made-up name.
    expect((await hook('bun add --libc musl musl')).decision).toBe('deny');
    expect((await hook('bun add musl')).decision).toBe('deny');
  });

  it('warns about each missing exception of --minimum-release-age-excludes and still asks', async () => {
    const answer = await hook('bun add left-pad --minimum-release-age-excludes made-up-a,lodash');
    expect(answer.decision).toBe('ask');
    expect(answer.reason).toContain('--minimum-release-age-excludes');
    expect(answer.reason).not.toContain('does not exist in the registry');
  });
});
