// Reads package documents from the npm registry with a time limit and a size limit. No credentials are sent, so
// packages of private registries cannot be looked up. Redirects are followed only within the same origin: a registry
// that sends depcurfew to another origin (another host, port or scheme) could answer for any name, so the package is
// reported as not checked. Link-local addresses (where cloud metadata services answer) are never asked; no registry
// lives there.
import { isRecord, values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect?: 'manual' }) => Promise<Response>;

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

/** `fix` says what to do when the generic advice (try again later) does not fit. */
export type Lookup = { status: 'found'; packument: Packument } | { status: 'not-found' } | { status: 'error'; reason: string; fix?: string };

export const TIMEOUT_MS = 15_000;
export const MAX_DOCUMENT_SIZE = 64 * 1024 * 1024;
/** Redirects followed within the same origin before giving up. */
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Whether a host is a link-local address written out (169.254.0.0/16, fe80::/10), where cloud metadata services answer. */
export function isLinkLocal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/u.test(bare)) return true;
  // IPv4 written inside IPv6 (::ffff:169.254.169.254, which the URL parser writes as ::ffff:a9fe:a9fe).
  if (/^::ffff:(?:169\.254\.|a9fe:)/u.test(bare)) return true;
  return /^fe[89ab][0-9a-f]?:/u.test(bare);
}

export type Fetched = { response: Response } | { reason: string; fix: string };

/**
 * Fetches `url`, following redirects only to the same origin and at most MAX_REDIRECTS times; `what` names the server
 * in reasons (registry, index).
 */
export async function fetchSameOrigin(url: string, init: { headers: Record<string, string>; signal: AbortSignal }, fetch: FetchLike, what: string): Promise<Fetched> {
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (isLinkLocal(current.hostname)) {
      return {
        reason: `${current.origin} is a link-local address, where cloud metadata services answer and no ${what} lives, so depcurfew does not ask it`,
        fix: `Check where the ${what} URL comes from and set the URL of the real ${what}; install nothing from this one`,
      };
    }
    const response = await fetch(current.href, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return { response };
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      if (next.hostname === current.hostname) {
        const change = next.protocol === current.protocol ? 'another port of the same host' : `the same host over ${next.protocol.slice(0, -1)} instead of ${current.protocol.slice(0, -1)}`;
        return {
          reason: `the ${what} redirected to ${next.origin}, ${change}, which depcurfew does not follow, as it follows redirects only within one origin`,
          fix: `Use ${next.origin} in the ${what} URL if you trust it, so that depcurfew asks it directly`,
        };
      }
      return {
        reason: `the ${what} redirected to ${next.origin}, another host, which depcurfew does not follow: that host could answer for any package`,
        fix: `Set the ${what} URL to the host that serves the packages if you trust it, or check the package there yourself before installing it`,
      };
    }
    if (redirects >= MAX_REDIRECTS) return { reason: `the ${what} redirected more than ${MAX_REDIRECTS} times`, fix: `Check the ${what} URL; it keeps redirecting` };
    current = next;
  }
}

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
    const fetched = await fetchSameOrigin(
      packumentUrl(options.registry, name),
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) },
      options.fetch,
      'registry',
    );
    if ('reason' in fetched) return { status: 'error', reason: fetched.reason, fix: fetched.fix };
    response = fetched.response;
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
