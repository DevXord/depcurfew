// The local copy of the OSV.dev data of known malicious packages (decision D-150): one file per ecosystem in depcurfew's
// user cache directory, which depcurfew osv update writes from the public export of OSV.dev and check, the Claude Code
// hook, depcurfew mcp and doctor read without network access. It keeps only the records of the OpenSSF
// malicious-packages database (ids starting with MAL-) that are not withdrawn, by package name as the registry
// compares names (PyPI after PEP 503, Packagist in lower case, npm as it is), each with its id and the versions and
// ranges of its affected[] entries for that package.
//
// The file is JSON Lines: a header, then one line per package, [name, records], sorted by name. A lookup reads the file
// and parses only the lines of a binary search, because parsing the whole file of npm (17 MB, 222,666 packages on
// 2026-11-03) takes most of a second, too long for a hook that runs before every install command. A file depcurfew did
// not write, or one it cannot read, is never taken as an answer: the versions are then not looked up in it.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, values } from '../apply/facts.ts';
import { osvEcosystem, type OsvPackage } from '../check/osv.ts';
import { osv as facts } from '../knowledge/osv.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { affectedFields, affects } from './match.ts';

/** What the file is, so that no other file is taken for one. */
export const OSV_DATA_FORMAT = 'depcurfew-osv-malicious';
/** The version of the layout of the file; another one is not read. */
export const OSV_DATA_FORMAT_VERSION = 1;
/** The ecosystems osv update downloads, in this order. */
export const OSV_DATA_ECOSYSTEMS = ['npm', 'pypi', 'packagist'] as const;
export type OsvDataEcosystem = (typeof OSV_DATA_ECOSYSTEMS)[number];
/** Largest file read: the file of npm was 17 MB on 2026-11-03; a much larger one is not one depcurfew wrote. */
export const MAX_OSV_DATA_BYTES = 512 * 1024 * 1024;
/** Longest record id kept, as for the answers of the API (decision D-135). */
const MAX_ID_LENGTH = 100;
/** Longest version or event value kept; versions of the three ecosystems are far shorter. */
const MAX_VERSION_LENGTH = 256;
/** Longest header line read. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Local data older than this many days gives a note; older than the second, a warning. */
export const OSV_DATA_NOTE_DAYS = 7;
export const OSV_DATA_WARNING_DAYS = 30;
const NEWLINE = 0x0a;

/** One record for one package: its id, its versions and its ranges ([type, event, version, event, version, ...]). */
export type OsvDataRecord = [id: string, versions: string[], ranges: string[][]];

/** The first line of the file of one ecosystem. */
export interface OsvDataHeader {
  format: typeof OSV_DATA_FORMAT;
  formatVersion: typeof OSV_DATA_FORMAT_VERSION;
  /** The ecosystem of depcurfew (npm, pypi, packagist) and the name OSV.dev gives it. */
  ecosystem: string;
  osvEcosystem: string;
  /** The export it was made from. */
  url: string;
  /** When depcurfew downloaded the export (ISO 8601). */
  downloadedAt: string;
  /** When OSV.dev wrote the export (its Last-Modified), or null when the answer did not say. */
  exportedAt: string | null;
  /** The MAL- records kept, and those left out because they are withdrawn. */
  records: number;
  withdrawn: number;
  /** The lines that follow: one per package. */
  packages: number;
}

/** The file of the data of an ecosystem in the directory of the local data. */
export function osvDataFile(directory: string, ecosystem: string): string {
  return join(directory, `${ecosystem}.jsonl`);
}

/** A package name as the registry of the ecosystem compares it. */
export function comparedPackageName(ecosystem: string, name: string): string {
  if (ecosystem === 'pypi') return normalizePythonName(name);
  if (ecosystem === 'packagist') return name.toLowerCase();
  return name;
}

/** The order of the package lines: by UTF-16 code units, as JavaScript compares strings. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The text of the file: the header, then the packages sorted by name. */
export function renderDataFile(header: Omit<OsvDataHeader, 'packages'>, packages: ReadonlyMap<string, readonly OsvDataRecord[]>): string {
  const names = [...packages.keys()].sort(compareNames);
  const lines = [JSON.stringify({ ...header, packages: names.length })];
  for (const name of names) lines.push(JSON.stringify([name, packages.get(name)]));
  return `${lines.join('\n')}\n`;
}

function idPattern(): RegExp {
  return new RegExp(values(facts.ids)[0]?.pattern ?? '^[a-zA-Z0-9:_.-]+$', 'u');
}

function malwarePrefix(): string {
  return values(facts.malicious)[0]?.idPrefix ?? 'MAL-';
}

/** Whether a text is an id of a MAL- record, as the OSV schema writes ids. */
export function isMaliciousId(id: unknown, pattern: RegExp = idPattern()): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && id.startsWith(malwarePrefix()) && pattern.test(id);
}

const isVersionText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_LENGTH;

/** What a record says about one ecosystem: its id and, by package name, its versions and ranges. */
export type ReadRecord = { status: 'kept'; id: string; packages: Map<string, { versions: string[]; ranges: string[][] }> } | { status: 'withdrawn' } | { status: 'skipped' };

/**
 * The affected versions of a MAL- record for the packages of `ecosystem` (depcurfew's), or why it is not kept: it is
 * withdrawn, or it is no MAL- record of that ecosystem. Only ranges of type SEMVER and ECOSYSTEM whose every event is
 * one of the four the schema defines are kept; other ranges and malformed parts are left out.
 */
export function readRecord(record: unknown, ecosystem: string): ReadRecord {
  const fields = affectedFields();
  const withdrawnField = values(facts.withdrawn)[0]?.field ?? 'withdrawn';
  const name = osvEcosystem(ecosystem);
  if (!isRecord(record) || !isMaliciousId(record['id']) || name === undefined) return { status: 'skipped' };
  if (record[withdrawnField] !== undefined && record[withdrawnField] !== null) return { status: 'withdrawn' };
  const affected = record[fields.affectedField];
  const packages = new Map<string, { versions: string[]; ranges: string[][] }>();
  const eventNames = new Set(Object.values(fields.events));
  for (const entry of Array.isArray(affected) ? affected : []) {
    if (!isRecord(entry)) continue;
    const pkg = entry[fields.packageField];
    if (!isRecord(pkg) || pkg[fields.ecosystemField] !== name || typeof pkg[fields.nameField] !== 'string' || pkg[fields.nameField] === '') continue;
    const key = comparedPackageName(ecosystem, pkg[fields.nameField] as string);
    const versions = (Array.isArray(entry[fields.versionsField]) ? (entry[fields.versionsField] as unknown[]) : []).filter(isVersionText);
    const ranges: string[][] = [];
    for (const range of Array.isArray(entry[fields.rangesField]) ? (entry[fields.rangesField] as unknown[]) : []) {
      if (!isRecord(range) || typeof range[fields.typeField] !== 'string' || !fields.versionRangeTypes.includes(range[fields.typeField] as string)) continue;
      const events = range[fields.eventsField];
      if (!Array.isArray(events) || events.length === 0) continue;
      const flat: string[] = [range[fields.typeField] as string];
      let usable = true;
      for (const event of events) {
        const keys = isRecord(event) ? Object.keys(event) : [];
        const kind = keys[0];
        const value = kind === undefined || !isRecord(event) ? undefined : event[kind];
        if (keys.length !== 1 || kind === undefined || !eventNames.has(kind) || !isVersionText(value)) {
          usable = false;
          break;
        }
        flat.push(kind, value);
      }
      if (usable) ranges.push(flat);
    }
    if (versions.length === 0 && ranges.length === 0) continue;
    const known = packages.get(key);
    if (known === undefined) packages.set(key, { versions, ranges });
    else packages.set(key, { versions: [...known.versions, ...versions], ranges: [...known.ranges, ...ranges] });
  }
  if (packages.size === 0) return { status: 'skipped' };
  return { status: 'kept', id: record['id'] as string, packages };
}

/** The state of the local data of one ecosystem. */
export type OsvDataState =
  | { status: 'missing'; file: string }
  | { status: 'unreadable'; file: string; reason: string }
  | { status: 'ready'; file: string; downloadedAt: string; exportedAt: string | null; records: number };

type Ready = Extract<OsvDataState, { status: 'ready' }>;

interface Loaded {
  state: OsvDataState;
  /** The bytes of the file, and where its package lines start. */
  bytes?: Buffer;
  body?: number;
}

/** Looks versions up in the local data; reads the file of an ecosystem once, when it is first needed. */
export class LocalOsvData {
  readonly #loaded = new Map<string, Loaded>();
  /** The directory of the local data; undefined when depcurfew has no user cache directory. */
  readonly directory: string | undefined;

  constructor(directory: string | undefined) {
    this.directory = directory;
  }

  #load(ecosystem: string): Loaded {
    const known = this.#loaded.get(ecosystem);
    if (known !== undefined) return known;
    const result = readDataFile(this.directory, ecosystem);
    this.#loaded.set(ecosystem, result);
    return result;
  }

  /** Whether the file of an ecosystem exists, readable or not. */
  exists(ecosystem: string): boolean {
    return this.state(ecosystem).status !== 'missing';
  }

  /** Whether the file of any ecosystem exists: without one, depcurfew osv update was never run (or failed every time). */
  any(): boolean {
    return OSV_DATA_ECOSYSTEMS.some((ecosystem) => this.exists(ecosystem));
  }

  state(ecosystem: string): OsvDataState {
    return this.#load(ecosystem).state;
  }

  /**
   * The ids of the MAL- records of the local data that affect the version, each once; undefined when there is no
   * readable data for its ecosystem. A package line that cannot be read makes the data of the ecosystem unreadable.
   */
  lookup(pkg: OsvPackage): string[] | undefined {
    const loaded = this.#load(pkg.ecosystem);
    if (loaded.state.status !== 'ready' || loaded.bytes === undefined || loaded.body === undefined) return undefined;
    const name = comparedPackageName(pkg.ecosystem, pkg.name);
    let records: unknown;
    try {
      records = findLine(loaded.bytes, loaded.body, name);
    } catch {
      const unreadable: Loaded = { state: { status: 'unreadable', file: loaded.state.file, reason: 'a line of it is not one depcurfew osv update writes' } };
      this.#loaded.set(pkg.ecosystem, unreadable);
      return undefined;
    }
    if (!Array.isArray(records)) return [];
    const pattern = idPattern();
    const found = new Set<string>();
    for (const record of records) {
      if (!Array.isArray(record) || !isMaliciousId(record[0], pattern)) continue;
      const versions = Array.isArray(record[1]) ? (record[1] as unknown[]).filter(isVersionText) : [];
      const ranges = Array.isArray(record[2]) ? (record[2] as unknown[]).filter((range): range is string[] => Array.isArray(range) && range.every(isVersionText)) : [];
      if (affects({ versions, ranges }, pkg.ecosystem, pkg.version)) found.add(record[0]);
    }
    return [...found];
  }
}

/**
 * The records of the package line for `name`, found by a binary search over the lines from `body` on; undefined when
 * there is none. Throws when a line it reads is not [name, records].
 */
function findLine(bytes: Buffer, body: number, name: string): unknown {
  let low = body;
  let high = bytes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    // The start of the line that holds `middle`: after the newline before it (low is always the start of a line).
    const start = Math.max(low, bytes.lastIndexOf(NEWLINE, middle - 1) + 1);
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 || newline >= high ? high : newline;
    const line = JSON.parse(bytes.toString('utf8', start, end)) as unknown;
    if (!Array.isArray(line) || line.length !== 2 || typeof line[0] !== 'string' || !Array.isArray(line[1])) throw new Error('not a package line');
    const order = compareNames(line[0], name);
    if (order === 0) return line[1];
    if (order < 0) low = end + 1;
    else high = start;
  }
  return undefined;
}

/** Reads the file of an ecosystem: missing, unreadable with the reason, or ready with its bytes. */
function readDataFile(directory: string | undefined, ecosystem: string): Loaded {
  if (directory === undefined) return { state: { status: 'missing', file: '' } };
  const file = osvDataFile(directory, ecosystem);
  let size: number;
  try {
    const stats = statSync(file, { throwIfNoEntry: false });
    if (stats === undefined) return { state: { status: 'missing', file } };
    if (!stats.isFile()) return { state: { status: 'unreadable', file, reason: 'it is not a regular file' } };
    size = stats.size;
  } catch (error) {
    return { state: { status: 'unreadable', file, reason: reasonOf(error) } };
  }
  if (size > MAX_OSV_DATA_BYTES) return { state: { status: 'unreadable', file, reason: `it is larger than ${MAX_OSV_DATA_BYTES / (1024 * 1024)} MiB` } };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { state: { status: 'unreadable', file, reason: reasonOf(error) } };
  }
  const notOurs: Loaded = { state: { status: 'unreadable', file, reason: `it is not a file that depcurfew osv update writes for ${osvEcosystem(ecosystem) ?? ecosystem}` } };
  const newline = bytes.indexOf(NEWLINE);
  if (newline === -1 || newline > MAX_HEADER_BYTES || bytes[bytes.length - 1] !== NEWLINE) return notOurs;
  let header: unknown;
  try {
    header = JSON.parse(bytes.toString('utf8', 0, newline)) as unknown;
  } catch {
    return notOurs;
  }
  if (!isRecord(header) || header['format'] !== OSV_DATA_FORMAT || header['ecosystem'] !== ecosystem) return notOurs;
  if (header['formatVersion'] !== OSV_DATA_FORMAT_VERSION) {
    return { state: { status: 'unreadable', file, reason: `it has the format version ${JSON.stringify(header['formatVersion'])}, and this depcurfew reads ${OSV_DATA_FORMAT_VERSION}` } };
  }
  const { downloadedAt, exportedAt, records } = header;
  const time = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  if (!time(downloadedAt) || !(exportedAt === null || time(exportedAt)) || typeof records !== 'number') return notOurs;
  return { state: { status: 'ready', file, downloadedAt, exportedAt, records }, bytes, body: newline + 1 };
}

function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return error instanceof Error ? error.message : String(error);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long ago, in milliseconds, OSV.dev wrote the export of the local data (else when depcurfew downloaded it). */
function dataAgeMs(state: Ready, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(state.exportedAt ?? state.downloadedAt));
}

/** The age in whole days of the local data, for messages. */
export function dataAgeDays(state: Ready, now: Date): number {
  return Math.floor(dataAgeMs(state, now) / DAY_MS);
}

/** The date of the local data for messages: 2026-11-03. */
export function dataDate(state: Ready): string {
  return new Date(Date.parse(state.exportedAt ?? state.downloadedAt)).toISOString().slice(0, 10);
}

/** How old the local data is: fresh, old enough for a note (older than OSV_DATA_NOTE_DAYS) or for a warning. */
export function dataStaleness(state: Ready, now: Date): 'fresh' | 'note' | 'warning' {
  const age = dataAgeMs(state, now);
  return age > OSV_DATA_WARNING_DAYS * DAY_MS ? 'warning' : age > OSV_DATA_NOTE_DAYS * DAY_MS ? 'note' : 'fresh';
}
