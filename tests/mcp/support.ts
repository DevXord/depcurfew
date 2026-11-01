// A JSON-RPC session with depcurfew mcp over in-memory streams: the command runs in-process through run(), with the
// recorded registry responses (tests/fixtures/registry and tests/fixtures/pypi) and a fixed clock.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import type { McpLimits } from '../../src/mcp/server.ts';
import { recordedFetch } from '../check/support.ts';

export const NOW = new Date('2026-10-29T12:00:00Z');
export const MODERN = '2026-07-28';
export const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/** _meta of a modern request. */
export function modernMeta(version = MODERN): Record<string, unknown> {
  return { _meta: { [PROTOCOL_VERSION]: version, [CLIENT_CAPABILITIES]: {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } } };
}

/** Temporary directories, removed by cleanUp() in afterAll (also when a run filtered with -t skips the tests). */
const temporary: string[] = [];

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

export function cleanUp(): void {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** A project directory with a depcurfew.json, or without one when `policy` is undefined. */
export function project(policy?: object | string): string {
  const directory = temporaryDirectory('depcurfew-mcp-');
  if (policy !== undefined) writeFileSync(join(directory, 'depcurfew.json'), typeof policy === 'string' ? policy : JSON.stringify({ version: 1, ...policy }));
  return directory;
}

export interface SessionOptions {
  argv?: string[];
  fetch?: FetchLike;
  now?: Date;
  env?: Record<string, string | undefined>;
  cwd?: string;
  limits?: Partial<McpLimits>;
  output?: Writable;
}

export interface Session {
  /** Writes a message (JSON) or a raw line (a string, sent as it is, with a newline unless it has one). */
  send(message: unknown): void;
  /** Writes raw bytes. */
  write(bytes: string | Buffer): void;
  /** The next message the server writes. */
  next(): Promise<Record<string, unknown>>;
  /** Every message written so far. */
  messages: Record<string, unknown>[];
  /** Closes stdin and waits for the command to end. */
  close(): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The command's exit, without closing stdin. */
  exit: Promise<{ code: number; stdout: string; stderr: string }>;
  /** Every line of stdout that is not one JSON value (must stay empty). */
  garbage: string[];
}

export function session(directory: string, options: SessionOptions = {}): Session {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  const messages: Record<string, unknown>[] = [];
  const garbage: string[] = [];
  const waiting: ((message: Record<string, unknown>) => void)[] = [];
  let read = 0;
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        garbage.push(line);
        continue;
      }
      while (waiting.length > 0 && read < messages.length) (waiting.shift() as (message: Record<string, unknown>) => void)(messages[read++] as Record<string, unknown>);
    }
  });
  let stdout = '';
  let stderr = '';
  const exit = run(options.argv ?? ['mcp', '--dir', directory], { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, {
    fetch: options.fetch ?? recordedFetch,
    now: () => options.now ?? NOW,
    stdin: async () => '',
    home: () => directory,
    mcpProcess: () => ({ input, output, env: options.env ?? {}, cwd: options.cwd ?? directory, ...(options.limits === undefined ? {} : { limits: options.limits }) }),
  }).then((code) => ({ code, stdout, stderr }));
  return {
    send(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message);
      input.write(line.endsWith('\n') ? line : `${line}\n`);
    },
    write(bytes) {
      input.write(bytes);
    },
    next() {
      if (read < messages.length) return Promise.resolve(messages[read++] as Record<string, unknown>);
      return new Promise((resolve) => waiting.push(resolve));
    },
    messages,
    garbage,
    exit,
    async close() {
      input.end();
      return exit;
    },
  };
}

/** A legacy session after initialize with `version`. */
export async function initialized(directory: string, version = '2025-11-25', options: SessionOptions = {}): Promise<Session> {
  const client = session(directory, options);
  client.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await client.next();
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return client;
}

/** A tools/call request. */
export function call(id: number | string, name: string, args?: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }), ...extra } };
}

/** A fetch that never answers until its signal aborts; `signals` collects what it was given. */
export function hangingFetch(): { fetch: FetchLike; signals: AbortSignal[]; started: Promise<void> } {
  const signals: AbortSignal[] = [];
  let started: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      signals.push(init.signal);
      started();
      init.signal.addEventListener('abort', () => reject(init.signal.reason as Error), { once: true });
    });
  return { fetch, signals, started: startedPromise };
}
