// Reads package documents from the npm registry with a time limit and a size limit. No credentials are sent, so
// packages of private registries cannot be looked up.
import { isRecord, values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface VersionDocument {
  version: string;
  scripts?: Record<string, unknown>;
  deprecated?: unknown;
}

export interface Packument {
  name: string;
  distTags: Readonly<Record<string, string>>;
  /** Publish time per version. */
  time: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, VersionDocument>>;
}

export type Lookup = { status: 'found'; packument: Packument } | { status: 'not-found' } | { status: 'error'; reason: string };

export const TIMEOUT_MS = 15_000;
export const MAX_DOCUMENT_SIZE = 64 * 1024 * 1024;

function api() {
  const fact = values(environment.npmRegistry.api)[0];
  if (fact === undefined) throw new Error('the knowledge base has no npm registry fact');
  return fact;
}

export function defaultRegistry(): string {
  return api().url;
}

/** The URL of a package document; the slash of a scoped name is escaped. */
export function packumentUrl(registry: string, name: string): string {
  const escaped = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  return new URL(escaped, registry.endsWith('/') ? registry : `${registry}/`).href;
}

export async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declared > limit) throw new Error(`the document is larger than ${limit / (1024 * 1024)} MiB`);
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`the document is larger than ${limit / (1024 * 1024)} MiB`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function strings(value: unknown): Record<string, string> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
}

function toPackument(document: unknown, name: string): Packument | undefined {
  if (!isRecord(document)) return undefined;
  const fields = api();
  const versions: Record<string, VersionDocument> = {};
  const entries = document[fields.versionsField];
  for (const [version, entry] of Object.entries(isRecord(entries) ? entries : {})) {
    if (!isRecord(entry)) continue;
    const scripts = entry[fields.scriptsField];
    versions[version] = {
      version,
      ...(isRecord(scripts) ? { scripts } : {}),
      ...(fields.deprecatedField in entry ? { deprecated: entry[fields.deprecatedField] } : {}),
    };
  }
  return { name: typeof document['name'] === 'string' ? document['name'] : name, distTags: strings(document[fields.distTagsField]), time: strings(document[fields.timeField]), versions };
}

export async function fetchPackument(name: string, options: { registry: string; fetch: FetchLike; timeoutMs?: number; maxBytes?: number }): Promise<Lookup> {
  const notFound = values(environment.npmRegistry.notFoundStatus)[0];
  let response: Response;
  try {
    response = await options.fetch(packumentUrl(options.registry, name), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'the registry did not answer in time' : `the registry cannot be reached (${error instanceof Error ? error.message : String(error)})`;
    return { status: 'error', reason };
  }
  if (response.status === notFound) return { status: 'not-found' };
  if (!response.ok) return { status: 'error', reason: `the registry answered HTTP ${response.status}` };
  try {
    const packument = toPackument(JSON.parse(await readLimited(response, options.maxBytes ?? MAX_DOCUMENT_SIZE)) as unknown, name);
    return packument === undefined ? { status: 'error', reason: 'the registry answered something that is not a package document' } : { status: 'found', packument };
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}
