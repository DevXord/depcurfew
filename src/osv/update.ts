// depcurfew osv update (decision D-150): downloads the public export of OSV.dev for each ecosystem, keeps the records of
// the OpenSSF malicious-packages database that are not withdrawn, and writes the local data that check, the hook,
// depcurfew mcp and doctor read. The request is one GET of the export file, the same for everyone; no package name and
// nothing about the project is sent. The export goes to a temporary file in the directory of the local data, is read
// there (src/osv/zip.ts) and removed; the new data replaces the old file with a rename, so a failed or partial download
// leaves the old data as it was.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { values } from '../apply/facts.ts';
import { osvEcosystem } from '../check/osv.ts';
import { requestSignal, type FetchLike } from '../check/registry.ts';
import { osv as facts } from '../knowledge/osv.ts';
import type { OsvExportKnowledge } from '../knowledge/types.ts';
import { OSV_DATA_FORMAT, OSV_DATA_FORMAT_VERSION, osvDataFile, readRecord, renderDataFile, type OsvDataEcosystem, type OsvDataRecord } from './data.ts';
import { readEntries, sizeText, withFileSource, ZIP_LIMITS, ZipError, type ZipLimits } from './zip.ts';

/** Largest export downloaded: npm's was 210 MiB on 2026-11-03 (dataExport). */
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
/** Time for the download of one export, from the request to the last byte. */
export const OSV_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
/** A temporary file of a download this old was left by a run that ended without removing it. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;
/** The ending of temporary files in the directory of the local data. */
const PARTIAL = '.part';

/** The codes of the errors of depcurfew osv update. */
export type OsvUpdateCode = 'osv-download-failed' | 'osv-export-unreadable' | 'osv-data-not-written' | 'osv-cache-missing';

export type OsvUpdateResult =
  | {
      ecosystem: OsvDataEcosystem;
      status: 'updated';
      /** The file written. */
      file: string;
      url: string;
      downloadedAt: string;
      exportedAt: string | null;
      /** MAL- records kept, left out as withdrawn, and left out because they cannot be read or name no version of a package of the ecosystem. */
      records: number;
      withdrawn: number;
      skipped: number;
      /** The size of the export downloaded. */
      bytes: number;
    }
  | { ecosystem: OsvDataEcosystem; status: 'failed'; file: string; url: string; code: OsvUpdateCode; message: string; fix: string };

export interface OsvUpdateOptions {
  /** The directory of the local data. */
  directory: string;
  ecosystems: readonly OsvDataEcosystem[];
  fetch: FetchLike;
  now: () => Date;
  signal?: AbortSignal;
  /** Largest export; MAX_EXPORT_BYTES when left out. */
  maxBytes?: number;
  timeoutMs?: number;
  zipLimits?: ZipLimits;
}

function exportFact(): OsvExportKnowledge {
  const fact = values(facts.dataExport)[0];
  if (fact === undefined) throw new Error('the knowledge base has no OSV.dev export fact');
  return fact;
}

/** The URL of the export of an ecosystem of depcurfew; undefined when the knowledge base has no folder for it. */
export function osvExportUrl(ecosystem: string): string | undefined {
  const fact = exportFact();
  const folder = Object.hasOwn(fact.folders, ecosystem) ? fact.folders[ecosystem] : undefined;
  return folder === undefined ? undefined : `${fact.url}${fact.archivePath.replace('{folder}', encodeURIComponent(folder))}`;
}

/** The host the exports come from, for messages. */
export function osvExportHost(): string {
  return new URL(exportFact().url).host;
}

/** Whether an entry of the export is a record of the malicious-packages database: MAL-<id>.json at the top. */
function isMaliciousEntry(name: string): boolean {
  const [before, after] = exportFact().recordEntry.split('{id}');
  const prefix = values(facts.malicious)[0]?.idPrefix ?? 'MAL-';
  return name.startsWith(`${before ?? ''}${prefix}`) && name.endsWith(after ?? '') && !name.includes('/') && !name.includes('\\');
}

class DownloadError extends Error {}

/** Removes temporary files of downloads that ended long ago without removing them. */
function removeAbandoned(directory: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('.') || !name.endsWith(PARTIAL)) continue;
    const path = join(directory, name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > ABANDONED_MS) rmSync(path, { force: true });
    } catch {
      // Another run may have removed it.
    }
  }
}

/** Downloads the export to `path`: its size and Last-Modified, or a DownloadError that says why not. */
async function download(url: string, path: string, options: OsvUpdateOptions): Promise<{ bytes: number; lastModified: string | null }> {
  const host = new URL(url).host;
  const limit = options.maxBytes ?? MAX_EXPORT_BYTES;
  const signal = requestSignal(options.timeoutMs ?? OSV_EXPORT_TIMEOUT_MS, options.signal);
  const failed = (error: unknown): never => {
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (error instanceof DownloadError) throw error;
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new DownloadError(timedOut ? `${host} did not send it in time` : `${host} cannot be reached (${error instanceof Error ? error.message : String(error)})`);
  };
  let response: Response;
  try {
    // A redirect is not followed: the export must come from where the knowledge base says.
    response = await options.fetch(url, { headers: { accept: 'application/zip' }, redirect: 'manual', signal });
  } catch (error) {
    return failed(error);
  }
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    await response.body?.cancel();
    let origin: string | undefined;
    try {
      origin = new URL(location, url).origin;
    } catch {
      // A location that is not a URL never reaches a message (decision D-142).
    }
    throw new DownloadError(`${host} redirected to ${origin ?? 'a location that is not a URL'}, which depcurfew does not follow`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadError(`${host} answered HTTP ${response.status}`);
  }
  const tooLarge = `it is larger than ${sizeText(limit)}, more than depcurfew downloads`;
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (declared > limit) {
    await response.body?.cancel();
    throw new DownloadError(tooLarge);
  }
  const lastModified = response.headers.get('last-modified');
  const exported = lastModified === null || Number.isNaN(Date.parse(lastModified)) ? null : new Date(Date.parse(lastModified)).toISOString();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  let bytes = 0;
  try {
    if (response.body === null) throw new DownloadError(`${host} sent no file`);
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        return failed(error);
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new DownloadError(tooLarge);
      }
      for (let written = 0; written < chunk.value.byteLength; ) {
        const { bytesWritten } = await file.write(chunk.value, written, chunk.value.byteLength - written);
        if (bytesWritten === 0) throw new Error('the disk takes no more data');
        written += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  if (!Number.isNaN(declared) && bytes !== declared) throw new DownloadError(`${host} sent ${bytes} of its ${declared} bytes`);
  return { bytes, lastModified: exported };
}

/** The local data of an ecosystem from the export at `path`. */
function buildData(path: string, ecosystem: OsvDataEcosystem, limits: ZipLimits): { packages: Map<string, OsvDataRecord[]>; records: number; withdrawn: number; skipped: number } {
  const packages = new Map<string, OsvDataRecord[]>();
  const ids = new Map<string, Set<string>>();
  let records = 0;
  let withdrawn = 0;
  let skipped = 0;
  withFileSource(path, (source) =>
    readEntries(
      source,
      isMaliciousEntry,
      (_entry, data) => {
        let document: unknown;
        try {
          document = JSON.parse(data.toString('utf8')) as unknown;
        } catch {
          skipped += 1;
          return;
        }
        const record = readRecord(document, ecosystem);
        if (record.status === 'withdrawn') withdrawn += 1;
        if (record.status === 'skipped') skipped += 1;
        if (record.status !== 'kept') return;
        records += 1;
        for (const [name, affected] of record.packages) {
          // One entry per record and package, also when the export holds a record twice.
          const seen = ids.get(name) ?? new Set<string>();
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          ids.set(name, seen);
          const list = packages.get(name) ?? [];
          list.push([record.id, affected.versions, affected.ranges]);
          packages.set(name, list);
        }
      },
      limits,
    ),
  );
  return { packages, records, withdrawn, skipped };
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'the disk is full';
  if (code === 'EROFS') return 'the file system is read-only';
  return error instanceof Error ? error.message : String(error);
}

/** Updates the local data of one ecosystem. */
async function updateOne(ecosystem: OsvDataEcosystem, options: OsvUpdateOptions): Promise<OsvUpdateResult> {
  const name = osvEcosystem(ecosystem) ?? ecosystem;
  const file = osvDataFile(options.directory, ecosystem);
  const url = osvExportUrl(ecosystem) ?? '';
  const kept = existsAsFile(file) ? `the local data for ${name} in ${file} was kept as it was` : `there is still no local data for ${name}`;
  const failure = (code: OsvUpdateCode, message: string, fix: string): OsvUpdateResult => ({ ecosystem, status: 'failed', file, url, code, message: `${message}; ${kept}`, fix });
  if (url === '') return failure('osv-export-unreadable', `depcurfew does not know where OSV.dev exports the data for ${name}`, 'Update depcurfew');
  try {
    mkdirSync(options.directory, { recursive: true });
  } catch (error) {
    return failure('osv-data-not-written', `depcurfew cannot create the directory ${options.directory} for the local OSV.dev data: ${reasonOf(error)}`, notWrittenFix(options.directory));
  }
  removeAbandoned(options.directory, options.now());
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const archive = join(options.directory, `.${ecosystem}.${suffix}.zip${PARTIAL}`);
  const written = join(options.directory, `.${ecosystem}.${suffix}.jsonl${PARTIAL}`);
  try {
    let downloaded: { bytes: number; lastModified: string | null };
    try {
      downloaded = await download(url, archive, options);
    } catch (error) {
      if (error instanceof DownloadError) {
        return failure('osv-download-failed', `the OSV.dev export for ${name} cannot be downloaded from ${url}: ${error.message}`, `Run depcurfew osv update again when ${osvExportHost()} can be reached; it needs HTTPS access to it`);
      }
      if (options.signal?.aborted === true) throw error;
      return failure('osv-data-not-written', `depcurfew cannot write the OSV.dev export for ${name} to ${options.directory}: ${reasonOf(error)}`, notWrittenFix(options.directory));
    }
    const downloadedAt = options.now().toISOString();
    let built: ReturnType<typeof buildData>;
    try {
      built = buildData(archive, ecosystem, options.zipLimits ?? ZIP_LIMITS);
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      return failure(
        'osv-export-unreadable',
        `the OSV.dev export for ${name} from ${url} is not a zip file depcurfew reads: ${error.message}`,
        'Run depcurfew osv update again; if it fails the same way, OSV.dev changed its export and a newer depcurfew may read it',
      );
    }
    const { packages, records, withdrawn, skipped } = built;
    const header = { format: OSV_DATA_FORMAT, formatVersion: OSV_DATA_FORMAT_VERSION, ecosystem, osvEcosystem: name, url, downloadedAt, exportedAt: downloaded.lastModified, records, withdrawn } as const;
    try {
      writeFileSync(written, renderDataFile(header, packages), { flag: 'wx', mode: 0o644 });
      // The rename replaces the old data at once: a reader sees the old file or the new one, never a part.
      renameSync(written, file);
    } catch (error) {
      return failure('osv-data-not-written', `depcurfew cannot write the local OSV.dev data for ${name} to ${file}: ${reasonOf(error)}`, notWrittenFix(options.directory));
    }
    return { ecosystem, status: 'updated', file, url, downloadedAt, exportedAt: downloaded.lastModified, records, withdrawn, skipped, bytes: downloaded.bytes };
  } finally {
    rmSync(archive, { force: true });
    rmSync(written, { force: true });
  }
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function notWrittenFix(directory: string): string {
  return `Make ${directory} writable for this user and free some disk space, or set XDG_CACHE_HOME (LOCALAPPDATA on Windows) to a directory that is, then run depcurfew osv update again`;
}

/** Updates the local data of each ecosystem in turn; one that fails does not stop the others. */
export async function updateOsvData(options: OsvUpdateOptions): Promise<OsvUpdateResult[]> {
  const results: OsvUpdateResult[] = [];
  for (const ecosystem of options.ecosystems) results.push(await updateOne(ecosystem, options));
  return results;
}
