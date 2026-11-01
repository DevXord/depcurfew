// The parts of the Model Context Protocol and of JSON-RPC 2.0 that depcurfew mcp speaks: the names come from the
// knowledge base (environment.mcp), the limits are depcurfew's own. A message is one line of JSON; anything a client
// sends is untrusted, so a line is checked for its size and its nesting before it is parsed.
import { isRecord, values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type {
  Fact,
  McpCancellationKnowledge,
  McpErrorCodesKnowledge,
  McpLifecycleKnowledge,
  McpRevisionsKnowledge,
  McpStatelessKnowledge,
  McpStdioKnowledge,
  McpToolsKnowledge,
} from '../knowledge/types.ts';

export { isRecord };

function first<T>(fact: Fact<T>, name: string): T {
  const value = values(fact)[0];
  if (value === undefined) throw new Error(`the knowledge base has no MCP ${name} fact`);
  return value;
}

export interface McpFacts {
  revisions: McpRevisionsKnowledge;
  lifecycle: McpLifecycleKnowledge;
  stateless: McpStatelessKnowledge;
  tools: McpToolsKnowledge;
  cancellation: McpCancellationKnowledge;
  codes: McpErrorCodesKnowledge;
  stdio: McpStdioKnowledge;
}

let cached: McpFacts | undefined;

/** The protocol facts depcurfew mcp needs, read once. */
export function mcpFacts(): McpFacts {
  const mcp = environment.mcp;
  cached ??= {
    revisions: first(mcp.revisions, 'revisions'),
    lifecycle: first(mcp.lifecycle, 'lifecycle'),
    stateless: first(mcp.stateless, 'stateless'),
    tools: first(mcp.tools, 'tools'),
    cancellation: first(mcp.cancellation, 'cancellation'),
    codes: first(mcp.errorCodes, 'error codes'),
    stdio: first(mcp.stdio, 'stdio'),
  };
  return cached;
}

/** Every revision the server serves, newest first: the modern ones, then the legacy ones. */
export function supportedVersions(): string[] {
  const { revisions } = mcpFacts();
  return [...revisions.modern, ...revisions.legacy];
}

export function isModern(version: string): boolean {
  return mcpFacts().revisions.modern.includes(version);
}

/** Whether a revision has a field or feature that arrived in `since` (revisions are dates, so they sort as text). */
export function hasSince(version: string, since: string): boolean {
  return version >= since;
}

export type RequestId = string | number;

/** A request id as MCP allows it: a string or an integer, never null. */
export function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** A key for a request id, so that the string "1" and the number 1 stay apart. */
export function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC error response; without an id when the id of the request could not be read (as the 2025-11-25 and later schemas allow). */
export function errorResponse(id: RequestId | undefined, error: RpcError): Record<string, unknown> {
  return id === undefined ? { jsonrpc: '2.0', error } : { jsonrpc: '2.0', id, error };
}

export function resultResponse(id: RequestId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Text from the client in an error message (a method or tool name): short and on one line. */
export function quoted(text: string): string {
  return JSON.stringify(text.length > 100 ? `${text.slice(0, 99)}…` : text);
}

/** Whether a JSON text nests arrays and objects deeper than `limit`; counted outside strings, in one pass. */
export function nestedDeeperThan(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === 0x5c) escaped = true;
      else if (character === 0x22) inString = false;
    } else if (character === 0x22) {
      inString = true;
    } else if (character === 0x7b || character === 0x5b) {
      depth++;
      if (depth > limit) return true;
    } else if (character === 0x7d || character === 0x5d) {
      depth--;
    }
  }
  return false;
}
