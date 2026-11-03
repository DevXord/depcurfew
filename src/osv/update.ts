// depcurfew osv update (decision D-150): downloads the public export of OSV.dev for each ecosystem, keeps the records of
// the OpenSSF malicious-packages database that are not withdrawn, and writes the local data that check, the hook,
// depcurfew mcp and doctor read. The request is one GET of the export file, the same for everyone; no package name and
// nothing about the project is sent. The export goes to a temporary file in the directory of the local data, is read
// there (src/osv/zip.ts) and removed; the new data replaces the old file with a rename, so a failed or partial download
// leaves the old data as it was. What it keeps is limited (OSV_DATA_LIMITS, decision D-156), and an export with fewer
// than half of the records of the data it would replace is refused unless the user accepts it.
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { values } from '../apply/facts.ts';
import { osvEcosystem } from '../check/osv.ts';
import { requestSignal, type FetchLike } from '../check/registry.ts';
import { osv as facts } from '../knowledge/osv.ts';
import type { OsvExportKnowledge } from '../knowledge/types.ts';
import {
  compareNames,
  LocalOsvData,
  OSV_DATA_ECOSYSTEMS,
  OSV_DATA_FORMAT,
  OSV_DATA_FORMAT_VERSION,
  OSV_DATA_LIMITS,
  osvDataFile,
  packageLine,
  packageLineOverhead,
  readRecord,
  type OsvDataEcosystem,
  type OsvDataHeader,
  type OsvDataLimits,
} from './data.ts';
import { readEntries, sizeText, withFileSource, ZIP_LIMITS, ZipError, type ZipLimits } from './zip.ts';

/** Largest export downloaded: npm's was 210 MiB on 2026-11-03 (dataExport). */
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
/** Time for the download of one export, from the request to the last byte. */
export const OSV_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
/** A temporary file of a download this old was left by a run that ended without removing it. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;
/** The ending of temporary files in the directory of the local data. */
const PARTIAL = '.part';
/** The random part of the name of a temporary file, in bytes (twice as many hexadecimal digits). */
const RANDOM_BYTES = 6;
/** The names of the temporary files osv update writes: .<ecosystem>.<pid>.<12 hexadecimal digits>.zip.part or .jsonl.part. */
const TEMPORARY_NAME = new RegExp(`^\\.(?:${OSV_DATA_ECOSYSTEMS.join('|')})\\.[0-9]+\\.[0-9a-f]{${RANDOM_BYTES * 2}}\\.(?:zip|jsonl)\\.part$`, 'u');
/** The new export must have at least this share of the records of the data it replaces, unless the user accepts fewer. */
const KEPT_SHARE = 0.5;
/** Text written to the data file at once. */
const WRITE_CHUNK = 1024 * 1024;

/** The codes of the errors of depcurfew osv update. */
export type OsvUpdateCode = 'osv-download-failed' | 'osv-export-unreadable' | 'osv-export-shrunk' | 'osv-data-not-written' | 'osv-cache-missing';

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
      /** MAL- records left out because they hold more than depcurfew keeps (OSV_DATA_LIMITS, decision D-156). */
      tooLarge: number;
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
  /** What is kept; OSV_DATA_LIMITS when left out. */
  dataLimits?: Readonly<OsvDataLimits>;
  /** Replace the data also with an export that has fewer than half of its records (--accept-fewer, decision D-156). */
  acceptFewer?: boolean;
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

/**
 * Removes temporary files of downloads that ended long ago without removing them: only regular files with the names
 * osv update gives them (TEMPORARY_NAME), never another file of the directory (decision D-156).
 */
function removeAbandoned(directory: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMPORARY_NAME.test(name)) continue;
    const path = join(directory, name);
    try {
      const stats = lstatSync(path);
      if (stats.isFile() && now.getTime() - stats.mtimeMs > ABANDONED_MS) rmSync(path, { force: true });
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

/** The data kept would be larger than the limit of the data file (OSV_DATA_LIMITS.fileBytes). */
class DataTooLarge extends Error {}

/** The records kept for a package, each as its JSON text, and the length of its line in bytes (without the newline). */
interface KeptPackage {
  records: string[];
  bytes: number;
}

interface BuiltData {
  packages: Map<string, KeptPackage>;
  records: number;
  withdrawn: number;
  skipped: number;
  tooLarge: number;
  /** The bytes of the package lines with their newlines. */
  body: number;
}

/**
 * The local data of an ecosystem from the export at `path`, within `limits`: a record is kept whole for every package it
 * names, or left out and counted in tooLarge when it is past a limit of a record or would give one of its packages more
 * records or a longer line than allowed. Each record is kept as its JSON text, which takes a fraction of the memory of
 * its parsed lists. Throws DataTooLarge as soon as the lines kept are larger than the data file may be.
 */
function buildData(path: string, ecosystem: OsvDataEcosystem, zipLimits: ZipLimits, limits: Readonly<OsvDataLimits>): BuiltData {
  const built: BuiltData = { packages: new Map(), records: 0, withdrawn: 0, skipped: 0, tooLarge: 0, body: 0 };
  // One record per id, also when the export holds a record twice.
  const ids = new Set<string>();
  withFileSource(path, (source) =>
    readEntries(
      source,
      isMaliciousEntry,
      (_entry, data) => {
        let document: unknown;
        try {
          document = JSON.parse(data.toString('utf8')) as unknown;
        } catch {
          built.skipped += 1;
          return;
        }
        const record = readRecord(document, ecosystem, limits);
        if (record.status === 'withdrawn') built.withdrawn += 1;
        if (record.status === 'skipped') built.skipped += 1;
        if (record.status === 'too-large') built.tooLarge += 1;
        if (record.status !== 'kept' || ids.has(record.id)) return;
        // What the record adds to the line of each of its packages, checked for all of them before any line changes.
        const additions: { name: string; known: KeptPackage | undefined; text: string; bytes: number }[] = [];
        for (const [name, affected] of record.packages) {
          const known = built.packages.get(name);
          const text = JSON.stringify([record.id, affected.versions, affected.ranges]);
          const length = Buffer.byteLength(text);
          const bytes = known === undefined ? packageLineOverhead(name) + length : known.bytes + 1 + length;
          if ((known?.records.length ?? 0) >= limits.recordsPerPackage || bytes > limits.lineBytes) {
            built.tooLarge += 1;
            return;
          }
          additions.push({ name, known, text, bytes });
        }
        ids.add(record.id);
        built.records += 1;
        for (const { name, known, text, bytes } of additions) {
          built.body += known === undefined ? bytes + 1 : bytes - known.bytes;
          if (known === undefined) built.packages.set(name, { records: [text], bytes });
          else {
            known.records.push(text);
            known.bytes = bytes;
          }
        }
        if (built.body > limits.fileBytes) throw new DataTooLarge();
      },
      zipLimits,
    ),
  );
  return built;
}

/** Writes the data file at `path` (created, never overwritten), line by line, without one string of the whole file. */
function writeData(path: string, header: OsvDataHeader, packages: ReadonlyMap<string, KeptPackage>, names: readonly string[]): void {
  const fd = openSync(path, 'wx', 0o644);
  try {
    let chunk: string[] = [];
    let length = 0;
    const flush = () => {
      const bytes = Buffer.from(chunk.join(''), 'utf8');
      for (let written = 0; written < bytes.length; ) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count === 0) throw new Error('the disk takes no more data');
        written += count;
      }
      chunk = [];
      length = 0;
    };
    const add = (line: string) => {
      chunk.push(line, '\n');
      length += line.length + 1;
      if (length >= WRITE_CHUNK) flush();
    };
    add(JSON.stringify(header));
    for (const name of names) add(packageLine(name, packages.get(name)?.records ?? []));
    flush();
  } finally {
    closeSync(fd);
  }
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? noun : `${noun}s`}`;
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
    // Never writable by others, whatever the umask (decision D-156).
    mkdirSync(options.directory, { recursive: true, mode: 0o755 });
  } catch (error) {
    return failure('osv-data-not-written', `depcurfew cannot create the directory ${options.directory} for the local OSV.dev data: ${reasonOf(error)}`, notWrittenFix(options.directory));
  }
  removeAbandoned(options.directory, options.now());
  const suffix = `${process.pid}.${randomBytes(RANDOM_BYTES).toString('hex')}`;
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
    const now = options.now();
    const downloadedAt = now.toISOString();
    // An export is never written after its download (decision D-156): a Last-Modified after the download is not taken.
    const exportedAt = downloaded.lastModified !== null && Date.parse(downloaded.lastModified) <= now.getTime() ? downloaded.lastModified : null;
    const limits = options.dataLimits ?? OSV_DATA_LIMITS;
    const unreadable = (reason: string) =>
      failure('osv-export-unreadable', `the OSV.dev export for ${name} from ${url} ${reason}`, 'Run depcurfew osv update again; if it fails the same way, OSV.dev changed its export and a newer depcurfew may read it');
    const tooLarge = () => unreadable(`holds more than depcurfew keeps: its local data would be larger than ${sizeText(limits.fileBytes)}`);
    let built: BuiltData;
    try {
      built = buildData(archive, ecosystem, options.zipLimits ?? ZIP_LIMITS, limits);
    } catch (error) {
      if (error instanceof DataTooLarge) return tooLarge();
      if (!(error instanceof ZipError)) throw error;
      return unreadable(`is not a zip file depcurfew reads: ${error.message}`);
    }
    const { packages, records, withdrawn, skipped } = built;
    // Far fewer records than the data it would replace: a broken or truncated export, unless the user accepts it.
    const previous = new LocalOsvData(options.directory).state(ecosystem);
    if (options.acceptFewer !== true && previous.status === 'ready' && Number.isSafeInteger(previous.records) && records < previous.records * KEPT_SHARE) {
      return failure(
        'osv-export-shrunk',
        `the OSV.dev export for ${name} from ${url} has ${count(records, 'record')} of known malicious packages, fewer than half of the ${previous.records.toLocaleString('en-US')} in the local data it would replace`,
        `Run depcurfew osv update again once OSV.dev has written a new export; if OSV.dev did remove that many records, run depcurfew osv update --ecosystem ${ecosystem} --accept-fewer to replace the local data`,
      );
    }
    const names = [...packages.keys()].sort(compareNames);
    const header: OsvDataHeader = { format: OSV_DATA_FORMAT, formatVersion: OSV_DATA_FORMAT_VERSION, ecosystem, osvEcosystem: name, url, downloadedAt, exportedAt, records, withdrawn, packages: names.length };
    if (Buffer.byteLength(JSON.stringify(header)) + 1 + built.body > limits.fileBytes) return tooLarge();
    try {
      writeData(written, header, packages, names);
      // The rename replaces the old data at once: a reader sees the old file or the new one, never a part.
      renameSync(written, file);
    } catch (error) {
      return failure('osv-data-not-written', `depcurfew cannot write the local OSV.dev data for ${name} to ${file}: ${reasonOf(error)}`, notWrittenFix(options.directory));
    }
    return { ecosystem, status: 'updated', file, url, downloadedAt, exportedAt, records, withdrawn, skipped, tooLarge: built.tooLarge, bytes: downloaded.bytes };
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
