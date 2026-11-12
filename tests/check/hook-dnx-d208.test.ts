// Decision D-208 (amends D-077): dnx is the tool runner of the .NET SDK. The SDK places dnx and dnx.cmd next to dotnet
// since 10.0.100 (they run `dotnet dnx`, a hidden alias of `dotnet tool exec`), while Deno's own alias is dx and a
// Deno dnx is only one a user made. Up to 1.6.0 the hook read every dnx line as deno x: it sent NuGet IDs and the
// URLs of private feeds to registry.npmjs.org and denied real .NET tools as made-up npm names. Now dnx gets no
// decision, like dotnet tool exec, except when the word right after it is an npm: or jsr: spec, which a NuGet ID
// cannot be (it matches ^\w+([.-]\w+)*$), so the line is read as deno x.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { loadPolicyIfPresent } from '../../src/apply/index.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { environment } from '../../src/knowledge/environment.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { CommandLineKnowledge, SharedRunKnowledge } from '../../src/knowledge/types.ts';
import { cpuNow } from '../support/cpu-time.ts';

const NOW = new Date('2026-11-11T12:00:00Z');
const temporary: string[] = [];
// The directories are made in beforeAll, which vitest skips together with afterAll when -t matches no test here.
let HOME = '';
let DOTNET = '';
let DENO = '';
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d208-home-'));
  temporary.push(HOME);
  // A .NET repository and a Deno one: the reading must not depend on the files where the agent runs (D-189).
  DOTNET = project({ 'depcurfew.json': POLICY, 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n', '.config/dotnet-tools.json': { version: 1, isRoot: true, tools: {} } });
  DENO = project({ 'depcurfew.json': POLICY, 'deno.json': { imports: {} } });
});
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICY = {
  version: 1,
  cooldown: { minimum: '3d' },
  installScripts: { default: 'deny' },
  sources: { git: 'deny', remoteTarball: 'deny' },
};

function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d208-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

/** The registry URLs the hook asks and its decision for `command`. */
async function hook(command: string, root: string, tool = 'Bash'): Promise<{ urls: string[]; decision: unknown; reason: unknown }> {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response('{"error":"Not found"}', { status: 404 });
  }) as unknown as FetchLike;
  let stdout = '';
  const event = JSON.stringify({ session_id: 't', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: root });
  const code = await run(['check', '--hook', 'claude-code'], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch, now: () => NOW, stdin: async () => event, home: () => HOME, projectDir: () => root, osvData: () => undefined });
  expect(code).toBe(0);
  const output = stdout.trim() === '' ? {} : (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } });
  return { urls, decision: output.hookSpecificOutput?.permissionDecision, reason: output.hookSpecificOutput?.permissionDecisionReason };
}

const DOTNET_FORMS = [
  'dnx dotnetsay',
  'dotnet dnx dotnetsay',
  'dnx Contoso.SampleMcpServer@0.0.1-beta --yes',
  'dnx --source https://api.nuget.org/v3/index.json dotnetsay',
  'dnx --add-source ./local-feed Contoso.Internal.Tool',
  'dnx Contoso.Internal.Tool --source https://nuget.contoso.example/v3/index.json',
  'dnx Contoso.Internal.Tool --add-source ./local-feed',
  'dnx -p dotnetsay dotnetsay',
  '/usr/share/dotnet/dnx dotnetsay',
  'dotnet tool exec dotnetsay',
];

describe('dnx of the .NET SDK in the Claude Code hook (decision D-208)', () => {
  it('sends no request and gives no decision, in a .NET and in a Deno repository', async () => {
    for (const root of [DOTNET, DENO]) {
      for (const command of DOTNET_FORMS) {
        expect(await hook(command, root), command).toEqual({ urls: [], decision: undefined, reason: undefined });
      }
    }
  });

  it('also as dnx.cmd and dnx under PowerShell', async () => {
    for (const command of ['dnx.cmd dotnetsay', 'dnx dotnetsay', '& dnx.cmd Contoso.SampleMcpServer@0.0.1-beta --yes', 'C:\\Program Files\\dotnet\\dnx.cmd dotnetsay', 'dotnet.exe dnx dotnetsay']) {
      expect(await hook(command, DOTNET, 'PowerShell'), command).toEqual({ urls: [], decision: undefined, reason: undefined });
    }
  });

  it('also in PowerShell statements depcurfew does not read, and where dnx is only a word', async () => {
    for (const command of [
      'Start-Process dnx dotnetsay',
      'Start-Process dnx -ArgumentList dotnetsay',
      'dnx $tool',
      '& "$env:ProgramFiles\\dotnet\\dnx.cmd" dotnetsay',
      'Start-Process dotnet -ArgumentList "dnx dotnetsay"',
      'Start-Process git -ArgumentList "log --grep dnx"',
    ]) {
      expect(await hook(command, DOTNET, 'PowerShell'), command).toEqual({ urls: [], decision: undefined, reason: undefined });
    }
  });

  it('still looks up npm: after dnx in PowerShell', async () => {
    expect((await hook('Start-Process dnx npm:evil-pkg', DENO, 'PowerShell')).urls).toEqual(['https://registry.npmjs.org/evil-pkg']);
    expect((await hook('dnx npm:$pkg', DENO, 'PowerShell')).decision).toBe('ask');
    expect((await hook('Start-Process dnx -ArgumentList npm:evil-pkg', DENO, 'PowerShell')).decision).toBe('ask');
  });

  it('still checks a package manager command after it', async () => {
    const { urls, decision } = await hook('dnx dotnetsay && npm install lodahs', DOTNET);
    expect(urls).toEqual(['https://registry.npmjs.org/lodahs']);
    expect(decision).toBe('deny');
  });

  it('reads dnx npm:<package> and dnx jsr:<package> as deno x, a self-made Deno alias', async () => {
    const npm = await hook('dnx npm:evil-pkg', DENO);
    expect(npm.urls).toEqual(['https://registry.npmjs.org/evil-pkg']);
    expect(npm.decision).toBe('deny');
    expect(await hook('dnx npm:evil-pkg', DENO)).toEqual(await hook('deno x npm:evil-pkg', DENO));
    expect(await hook('dnx npm:evil-pkg/evil-bin --yes', DENO)).toEqual(await hook('deno x npm:evil-pkg/evil-bin --yes', DENO));
    const jsr = await hook('dnx jsr:@std/path', DENO);
    expect(jsr.decision).toBe('ask');
    expect(jsr).toEqual(await hook('deno x jsr:@std/path', DENO));
    expect((await hook('dnx.cmd npm:evil-pkg', DENO, 'PowerShell')).urls).toEqual(['https://registry.npmjs.org/evil-pkg']);
  });

  it('keeps the lookups of deno x, dx and denox', async () => {
    for (const command of ['deno x evil-pkg', 'dx evil-pkg', 'denox evil-pkg', 'dx npm:evil-pkg', 'dx -p evil-pkg evil-bin', 'denox --package evil-pkg evil-bin']) {
      const { urls, decision } = await hook(command, DENO);
      expect(urls, command).toEqual(['https://registry.npmjs.org/evil-pkg']);
      expect(decision, command).toBe('deny');
    }
  });
});

describe('scanCommandLine for dnx (decision D-208)', () => {
  it('gives no request for the .NET forms', () => {
    for (const command of DOTNET_FORMS) expect(scanCommandLine(command), command).toEqual({ requests: [] });
    expect(scanCommandLine('dnx.cmd dotnetsay', { shell: 'powershell' })).toEqual({ requests: [] });
  });

  it('reads dnx npm: and dnx jsr: as deno x', () => {
    expect(scanCommandLine('dnx npm:create-vite my-app')).toEqual({ requests: [{ tool: 'deno', command: 'dnx npm:create-vite my-app', spec: 'npm:create-vite' }] });
    expect(scanCommandLine('dnx jsr:@std/http/file-server')).toEqual({ requests: [{ tool: 'deno', command: 'dnx jsr:@std/http/file-server', spec: 'jsr:@std/http/file-server' }] });
  });

  it('does not take a later dnx word for a command', () => {
    expect(scanCommandLine('grep dnx notes.txt')).toEqual({ requests: [] });
    expect(scanCommandLine('grep dnx npm install lodahs').requests.map((request) => request.spec)).toEqual(['lodahs']);
    expect(scanCommandLine('strace dnx npm:evil-pkg').requests.map((request) => request.spec)).toEqual(['npm:evil-pkg']);
  });
  // The words of a PowerShell statement depcurfew does not read lose their dots at both ends in one pass, not with a
  // regular expression that tries every dot as a start: \.+$ took 8 s of CPU time on a word of 80,000 dots between
  // two letters (CodeQL js/polynomial-redos; decisions D-200 and D-208).
  it('reads a PowerShell statement with a word of many dots in linear time', () => {
    const line = `Start-Process a${'.'.repeat(50_000)}a npm:x`;
    const start = cpuNow();
    const scan = scanCommandLine(line, { shell: 'powershell' });
    expect((cpuNow() - start) / 1000).toBeLessThan(1);
    expect(scan.requests).toEqual([]);
  });
});

describe('dnx in CI (decision D-208)', () => {
  const workflow = (command: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;
  const findings = (command: string) => {
    const root = project({ 'depcurfew.json': POLICY, 'deno.json': { imports: {} }, '.github/workflows/ci.yml': workflow(command) });
    return runDoctor(root, { policy: loadPolicyIfPresent(root) ?? null }).findings.filter((finding) => finding.rule === 'ci-weakens-policy');
  };

  it('a dnx step no longer counts as Deno', () => {
    expect(findings('dnx dotnet-tool --allow-scripts --yes')).toEqual([]);
  });

  it('deno and dx steps still do', () => {
    expect(findings('deno install --allow-scripts').length).toBeGreaterThan(0);
    expect(findings('dx --allow-scripts npm:x').length).toBeGreaterThan(0);
  });
});

describe('the facts behind it (decision D-208)', () => {
  const deno = knowledgeBase.find((tool) => tool.id === 'deno');
  const commandLine = deno?.extra?.['commandLine'];
  const facts = (commandLine?.status === 'verified' ? commandLine.value : undefined) as CommandLineKnowledge | undefined;

  it("dnx is no longer one of Deno's run commands", () => {
    expect(facts?.run.map((entry) => entry.command.join(' '))).toEqual(['deno x', 'dx', 'denox']);
    expect(facts?.commandOptions?.map((entry) => entry.command.join(' '))).toEqual(['deno x', 'dx', 'denox']);
  });

  it('Deno keeps dnx for npm: and jsr: specs only', () => {
    const shared = deno?.extra?.['sharedRuns'];
    expect(shared?.status).toBe('verified');
    expect(shared?.status === 'verified' ? (shared.value as SharedRunKnowledge[]) : undefined).toEqual([{ command: ['dnx'], runs: ['deno', 'x'], prefixes: ['npm:', 'jsr:'] }]);
  });

  it('the .NET SDK places dnx next to dotnet since 10.0.100', () => {
    const runner = environment.botOnlyEcosystems.nuget.toolRunner;
    expect(runner?.status).toBe('verified');
    expect(runner?.status === 'verified' ? runner.value : undefined).toMatchObject({ executables: ['dnx'], since: '10.0.100', product: '.NET SDK' });
    expect(runner?.status === 'verified' ? runner.source : '').toMatch(/^https:\/\/github\.com\/dotnet\/sdk\/blob\/v10\.0\.100\//u);
  });
});
