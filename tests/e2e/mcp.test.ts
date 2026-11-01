// The built executable as an MCP server over real pipes: one JSON message per line on stdout and nothing else, a
// quiet end when stdout closes, and a prompt one on SIGINT and SIGTERM, as Claude Code stops stdio servers.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { bin: Record<string, string> };
const binPath = fileURLToPath(new URL(pkg.bin['depcurfew'] ?? '', root));
const { FORCE_COLOR: _force, NO_COLOR: _no, CLAUDE_PROJECT_DIR: _project, ...plainEnv } = process.env;

let directory = '';
beforeAll(() => {
  if (!existsSync(binPath)) throw new Error(`${binPath} does not exist. Run \`npm test\` (it builds first) or \`npm run build\`.`);
  directory = mkdtempSync(join(tmpdir(), 'depcurfew-mcp-e2e-'));
  writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' } }));
});
afterAll(() => {
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
});

const lines = (...messages: object[]) => messages.map((message) => `${JSON.stringify(message)}\n`).join('');
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } };

describe('built depcurfew mcp', () => {
  it('answers a session on stdout, one message per line, and exits with 0 when stdin closes', () => {
    const input = lines(
      initialize,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'explain_policy', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } },
    );
    const result = spawnSync(process.execPath, [binPath, 'mcp', '--dir', directory], { input, encoding: 'utf8', env: plainEnv });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const messages = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(messages.map((message) => message.id).sort()).toEqual([1, 2, 3, 4]);
    expect(messages.find((message) => message.id === 3)?.result['structuredContent']).toMatchObject({ policy: 'depcurfew.json', values: { cooldown: { minimum: '3d' } } });
  });

  it('ends quietly with 0 when stdout is closed', async () => {
    const child = spawn(process.execPath, [binPath, 'mcp', '--dir', directory], { env: plainEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.stdin.end(lines(initialize, { jsonrpc: '2.0', id: 2, method: 'ping' }));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)('stops at once on %s', async (signal) => {
    const child = spawn(process.execPath, [binPath, 'mcp', '--dir', directory], { env: plainEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    const answered = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.stdin.write(lines(initialize));
    await answered;
    const started = Date.now();
    child.kill(signal);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
