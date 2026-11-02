// Reads a package's tagged releases from the v2 metadata of Packagist.org (decision D-133), with a time limit and a
// size limit: p2/<vendor>/<name>.json, whose list of versions is minified (each entry holds only what changed since
// the previous one) and is expanded as composer/metadata-minifier does. Only the fields check reads are kept: the
// version, its normal form, the release time the author set, the time Packagist published it, the type and whether
// the package is abandoned. Requests go to Packagist.org only, without credentials.
import { isRecord, values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { PackagistApiKnowledge } from '../knowledge/types.ts';
import { normalizeVersion } from './composer-version.ts';
import { fetchSameOrigin, readError, readLimited, requestSignal, tooManyVersions, type FetchLike } from './registry.ts';

/**
 * The largest answer, the most versions and the longest version of one package depcurfew reads from Packagist
 * (decision D-136): every version is read, ordered and compared, so a larger answer costs seconds of CPU per package
 * in the hook, which checks up to 50. The largest package of Packagist.org, aws/aws-sdk-php, had 2551 versions in
 * 1.6 MB on 2026-11-02, none longer than 12 characters; an answer beyond a limit leaves the package unverified, never
 * passed, since Composer may pick a version depcurfew left out.
 */
export const MAX_PACKAGIST_SIZE = 16 * 1024 * 1024;
export const MAX_PACKAGIST_VERSIONS = 10_000;
export const MAX_PACKAGIST_VERSION_LENGTH = 255;

export interface PackagistVersion {
  /** As the package's tag writes it: v7.3.4 or 3.9.0. */
  version: string;
  /** Composer's normal form: 7.3.4.0. */
  normalized: string;
  /** The release time the package author set. */
  time?: string;
  /** When Packagist published the version, which the author cannot influence. */
  publishedTime?: string;
  /** library when the metadata names none. */
  type: string;
  /** true, or the package its author suggests instead. */
  abandoned?: true | string;
}

export interface PackagistPackage {
  name: string;
  versions: readonly PackagistVersion[];
}

/**
 * What to do when Packagist redirects (to another origin, to something that is not a URL, or too often), for a person:
 * depcurfew asks Packagist only and has no setting for another repository (decision D-142).
 */
export const PACKAGIST_REDIRECT_FIX =
  'Run depcurfew check again later; while repo.packagist.org redirects, check the package on packagist.org by hand before installing it: depcurfew asks only Packagist and follows no redirect away from it';

const NOT_METADATA = 'Packagist answered something that is not package metadata';

export type PackagistLookup = { status: 'found'; package: PackagistPackage } | { status: 'not-found' } | { status: 'error'; reason: string; fix?: string };

export function packagistApi(): PackagistApiKnowledge {
  const composer = knowledgeBase.find((tool) => tool.id === 'composer');
  const fact = composer?.extra?.['packagistApi'];
  const value = fact === undefined ? undefined : (values(fact)[0] as PackagistApiKnowledge | undefined);
  if (value === undefined) throw new Error('the knowledge base has no Packagist API fact');
  return value;
}

/** The repository Composer uses by default, which depcurfew asks about Composer packages. */
export function packagistUrl(): string {
  return packagistApi().url;
}

/** The URL of the metadata of a package's tagged releases; the name is vendor/name in lower case. */
export function metadataUrl(name: string, dev = false): string {
  const api = packagistApi();
  const encoded = name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${api.url.replace(/\/+$/u, '')}${api.metadataPath.replace('{name}', `${encoded}${dev ? api.devSuffix : ''}`)}`;
}

/** The page of a package on packagist.org. */
export function packagePage(name: string): string {
  return packagistApi().packagePage.replace('{name}', name);
}

/** The fields of a version that check reads, by their key in the metadata. */
function readFields(api: PackagistApiKnowledge): readonly string[] {
  return [api.versionField, api.normalizedField, api.timeField, api.publishedField, api.typeField, api.abandonedField];
}

/**
 * The versions of a minified list, as MetadataMinifier::expand builds them: the first entry is whole, each later one
 * changes the keys it holds (a key whose value is the unset marker is removed), and while the version built so far has
 * no key at all the next entry is taken whole again. Only the keys check reads are kept; `keys` counts all of them, so
 * that an empty version is told apart. undefined when an entry is not an object.
 */
export function expandVersions(entries: readonly unknown[], minified: boolean, api: PackagistApiKnowledge = packagistApi()): Record<string, unknown>[] | undefined {
  const fields = readFields(api);
  const expanded: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {};
  let keys = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    if (!minified || keys.size === 0) {
      current = {};
      keys = new Set(Object.keys(entry));
      for (const field of fields) if (Object.hasOwn(entry, field)) current[field] = entry[field];
    } else {
      for (const [key, value] of Object.entries(entry)) {
        if (value === api.unsetValue) {
          keys.delete(key);
          delete current[key];
        } else {
          keys.add(key);
          if (fields.includes(key)) current[key] = value;
        }
      }
    }
    expanded.push({ ...current });
  }
  return expanded;
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);

/** A time as Composer reads it: a string, or an integer of seconds since 1970 (ArrayLoader). */
function time(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return new Date(value * 1000).toISOString();
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A version of the metadata as check reads it; undefined when it has no version Composer can read. */
function toVersion(entry: Record<string, unknown>, api: PackagistApiKnowledge): PackagistVersion | undefined {
  const version = text(entry[api.versionField]);
  if (version === undefined) return undefined;
  const normalized = text(entry[api.normalizedField]) ?? normalizeVersion(version);
  if (normalized === undefined) return undefined;
  const released = time(entry[api.timeField]);
  const published = time(entry[api.publishedField]);
  const type = typeof entry[api.typeField] === 'string' && entry[api.typeField] !== '' ? (entry[api.typeField] as string).toLowerCase() : 'library';
  const abandoned = entry[api.abandonedField];
  return {
    version,
    normalized,
    ...(released === undefined ? {} : { time: released }),
    ...(published === undefined ? {} : { publishedTime: published }),
    type,
    ...(abandoned === true ? { abandoned: true as const } : typeof abandoned === 'string' && abandoned !== '' ? { abandoned } : {}),
  };
}

/** Whether a version entry has a version or normal form longer than depcurfew reads (decision D-136). */
function tooLong(entry: Record<string, unknown>, api: PackagistApiKnowledge): boolean {
  return [entry[api.versionField], entry[api.normalizedField]].some((value) => typeof value === 'string' && value.length > MAX_PACKAGIST_VERSION_LENGTH);
}

/**
 * The package of a metadata document; undefined when the document is not package metadata, 'too many' beyond the
 * versions depcurfew reads, 'too long' for a version longer than it reads: Composer may pick that one, so the package is
 * not checked at all rather than without it (decision D-136).
 */
export function toPackage(document: unknown, name: string): PackagistPackage | 'too many' | 'too long' | undefined {
  const api = packagistApi();
  if (!isRecord(document) || !isRecord(document[api.packagesField])) return undefined;
  const packages = document[api.packagesField] as Record<string, unknown>;
  const list = Object.hasOwn(packages, name) ? packages[name] : undefined;
  if (!Array.isArray(list)) return undefined;
  if (list.length > MAX_PACKAGIST_VERSIONS) return 'too many';
  const expanded = expandVersions(list, document[api.minifiedField] === api.minifiedValue, api);
  if (expanded === undefined) return undefined;
  if (expanded.some((entry) => tooLong(entry, api))) return 'too long';
  const versions = expanded.flatMap((entry) => toVersion(entry, api) ?? []);
  return { name, versions };
}

export async function fetchPackage(name: string, options: { fetch: FetchLike; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal | undefined }): Promise<PackagistLookup> {
  const api = packagistApi();
  let response: Response;
  try {
    const fetched = await fetchSameOrigin(metadataUrl(name), { headers: { accept: 'application/json' }, signal: requestSignal(options.timeoutMs, options.signal) }, options.fetch, 'repository');
    // The fixes of fetchSameOrigin name a URL to set, which depcurfew has none of for Packagist.
    if ('reason' in fetched) return { status: 'error', reason: fetched.reason, fix: PACKAGIST_REDIRECT_FIX };
    response = fetched.response;
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'Packagist did not answer in time' : `Packagist cannot be reached (${error instanceof Error ? error.message : String(error)})`;
    return { status: 'error', reason };
  }
  if (response.status === api.notFoundStatus) {
    await response.body?.cancel();
    return { status: 'not-found' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: 'error', reason: `Packagist answered HTTP ${response.status}` };
  }
  try {
    const body = await readLimited(response, options.maxBytes ?? MAX_PACKAGIST_SIZE);
    const found = toPackage(JSON.parse(body) as unknown, name);
    if (found === 'too many') return tooManyVersions(name, 'repository', `${MAX_PACKAGIST_VERSIONS} versions`);
    if (found === 'too long') {
      return {
        status: 'error',
        reason: `Packagist lists a version of ${name} longer than ${MAX_PACKAGIST_VERSION_LENGTH} characters, more than depcurfew reads, so its versions were not checked`,
        fix: `Check ${name} by hand before installing it: real versions are far shorter, so the repository may be answering with something made to slow checks down`,
      };
    }
    return found === undefined ? { status: 'error', reason: NOT_METADATA } : { status: 'found', package: found };
  } catch (error) {
    return { status: 'error', reason: readError(error, NOT_METADATA) };
  }
}
