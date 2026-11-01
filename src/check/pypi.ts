// Reads a project's page from a Python package index in the JSON form of the simple repository API, with a time
// limit and a size limit. The page lists files, not releases: the version of each file comes from its name, which
// for a wheel is {name}-{version}-… and for a source distribution {name}-{version}.<archive>. Files that pip and uv
// do not install from an index (eggs, Windows installers) are left out. No credentials are sent.
import { isRecord, values } from '../apply/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type { PypiIndexKnowledge } from '../knowledge/types.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { compareVersions, parseVersion } from './pep440.ts';
import { fetchSameOrigin, MAX_DOCUMENT_SIZE, readLimited, requestSignal, type FetchLike } from './registry.ts';

export interface PypiFile {
  filename: string;
  /** wheel: installs without running package code; sdist: built when installed. */
  kind: 'wheel' | 'sdist';
  uploadedAt?: string;
  /** false, or the reason given for yanking it ('' when none was given). */
  yanked: false | string;
}

export interface PypiProject {
  name: string;
  /** The project status marker; active when the index gives none. */
  status: string;
  statusReason?: string;
  /** The installable files of each version, by the version as the index lists it, in the order of the page. */
  releases: ReadonlyMap<string, readonly PypiFile[]>;
}

export type PypiLookup = { status: 'found'; project: PypiProject } | { status: 'not-found' } | { status: 'error'; reason: string; fix?: string };

function api(): PypiIndexKnowledge {
  const fact = values(environment.pypiIndex.api)[0];
  if (fact === undefined) throw new Error('the knowledge base has no Python package index fact');
  return fact;
}

export function defaultIndex(): string {
  return api().url;
}

/** The URL of a project's page: the normalized name followed by a slash. */
export function projectUrl(index: string, name: string): string {
  return new URL(`${encodeURIComponent(normalizePythonName(name))}/`, index.endsWith('/') ? index : `${index}/`).href;
}

function sdistExtensions(): readonly string[] {
  return values(environment.python.sourceDistributionExtensions)[0] ?? [];
}

function wheelExtension(): string {
  return values(environment.python.wheelExtension)[0] ?? '.whl';
}

/** The version and kind of a distribution file of the project with this normalized name; undefined for other files. */
export function fileVersion(filename: string, name: string): { version: string; kind: 'wheel' | 'sdist' } | undefined {
  const lower = filename.toLowerCase();
  const wheel = wheelExtension();
  if (lower.endsWith(wheel)) {
    // {distribution}-{version}(-{build tag})?-{python tag}-{abi tag}-{platform tag}.whl, no dash inside a part.
    const parts = filename.slice(0, -wheel.length).split('-');
    if (parts.length < 5 || parts.length > 6 || normalizePythonName(parts[0] ?? '') !== name) return undefined;
    return { version: parts[1] ?? '', kind: 'wheel' };
  }
  const extension = sdistExtensions().find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) return undefined;
  const stem = filename.slice(0, -extension.length);
  // Older source distributions keep dashes in the name, so the name is whatever part before a dash matches.
  for (let dash = stem.indexOf('-'); dash !== -1; dash = stem.indexOf('-', dash + 1)) {
    if (normalizePythonName(stem.slice(0, dash)) === name && parseVersion(stem.slice(dash + 1)) !== undefined) return { version: stem.slice(dash + 1), kind: 'sdist' };
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toProject(document: unknown, requested: string): PypiProject | undefined {
  const fields = api();
  if (!isRecord(document) || !Array.isArray(document[fields.filesField]) || !Array.isArray(document[fields.versionsField])) return undefined;
  const name = normalizePythonName(text(document['name']) ?? requested);
  const listed = (document[fields.versionsField] as unknown[]).filter((version): version is string => typeof version === 'string');
  /** The listed version a file's version stands for: the same text, else an equal version (1.0 and 1.0.0). */
  const listedAs = (version: string): string => {
    if (listed.includes(version)) return version;
    const parsed = parseVersion(version);
    const equal = parsed === undefined ? undefined : listed.find((candidate) => {
      const other = parseVersion(candidate);
      return other !== undefined && compareVersions(other, parsed) === 0;
    });
    return equal ?? version;
  };
  const releases = new Map<string, PypiFile[]>();
  for (const entry of document[fields.filesField] as unknown[]) {
    if (!isRecord(entry)) continue;
    const filename = text(entry[fields.filenameField]);
    const found = filename === undefined ? undefined : fileVersion(filename, name);
    if (filename === undefined || found === undefined) continue;
    const yanked = entry[fields.yankedField];
    const uploadedAt = text(entry[fields.uploadTimeField]);
    const file: PypiFile = {
      filename,
      kind: found.kind,
      ...(uploadedAt === undefined ? {} : { uploadedAt }),
      yanked: typeof yanked === 'string' ? yanked : yanked === true ? '' : false,
    };
    const version = listedAs(found.version);
    releases.set(version, [...(releases.get(version) ?? []), file]);
  }
  const status = document[fields.statusField];
  const value = isRecord(status) ? text(status[fields.statusValueField]) : undefined;
  const reason = isRecord(status) ? text(status[fields.statusReasonField]) : undefined;
  return { name, status: value ?? 'active', ...(reason === undefined ? {} : { statusReason: reason }), releases };
}

export async function fetchProject(name: string, options: { index: string; fetch: FetchLike; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal | undefined }): Promise<PypiLookup> {
  const fields = api();
  let response: Response;
  try {
    const fetched = await fetchSameOrigin(
      projectUrl(options.index, name),
      { headers: { accept: fields.accept }, signal: requestSignal(options.timeoutMs, options.signal) },
      options.fetch,
      'index',
    );
    if ('reason' in fetched) return { status: 'error', reason: fetched.reason, fix: fetched.fix };
    response = fetched.response;
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'the index did not answer in time' : `the index cannot be reached (${error instanceof Error ? error.message : String(error)})`;
    return { status: 'error', reason };
  }
  if (response.status === fields.notFoundStatus) return { status: 'not-found' };
  if (!response.ok) return { status: 'error', reason: `the index answered HTTP ${response.status}` };
  try {
    const project = toProject(JSON.parse(await readLimited(response, options.maxBytes ?? MAX_DOCUMENT_SIZE)) as unknown, name);
    return project === undefined ? { status: 'error', reason: 'the index answered something that is not a project page' } : { status: 'found', project };
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}
