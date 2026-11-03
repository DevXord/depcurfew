// A minimal reader of zip files, for the export of OSV.dev that depcurfew osv update downloads (decision D-150).
// depcurfew takes no zip library, so this reads the central directory and inflates only the entries asked for, with
// node:zlib, into memory: nothing is ever written to disk. It is built for an archive from the network: every size,
// offset and count is checked against the file and against limits before anything is read or inflated, entries may
// not overlap, an entry may not inflate to more than it declares nor by more than a ratio (zip bombs), and its CRC-32
// must match. Encrypted entries, other compression methods than stored and deflated, archives on several disks and
// entries that need ZIP64 fields are refused; the ZIP64 end of the central directory is read, because the export of
// npm has more than 65,535 entries (src/knowledge/osv.ts, dataExport).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  override name = 'ZipError';
}

/** Where the bytes of an archive come from: a file or, in tests, a buffer. */
export interface ZipSource {
  size: number;
  /** Exactly `length` bytes at `offset`; the caller has checked that they lie in the archive. */
  read(offset: number, length: number): Uint8Array;
}

export interface ZipLimits {
  /** Most entries in the central directory. */
  entries: number;
  /** Largest central directory, in bytes. */
  centralDirectoryBytes: number;
  /** Largest compressed entry that is inflated. */
  entryCompressedBytes: number;
  /** Largest entry, inflated. */
  entryBytes: number;
  /** Most bytes an entry may inflate to per compressed byte. */
  ratio: number;
  /** Most bytes all the entries read may inflate to together. */
  totalBytes: number;
}

/**
 * The limits for the OSV.dev export. On 2026-11-03 the largest export (npm) had 231,076 entries, a central directory of
 * 15 MB, MAL- entries of at most 1.1 MB that inflate by at most 6.2 times (18.2 for any entry), 364 MB in all.
 */
export const ZIP_LIMITS: ZipLimits = {
  entries: 2_000_000,
  centralDirectoryBytes: 256 * 1024 * 1024,
  entryCompressedBytes: 32 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
  ratio: 100,
  totalBytes: 4 * 1024 * 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** The offset of its local header. */
  offset: number;
}

const END = 0x06054b50;
const END_LENGTH = 22;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_END = 0x06064b50;
const ZIP64_END_LENGTH = 56;
const CENTRAL = 0x02014b50;
const CENTRAL_LENGTH = 46;
const LOCAL = 0x04034b50;
const LOCAL_LENGTH = 30;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
/** General purpose flags: bit 0 encrypted, bit 6 strong encryption, bit 11 UTF-8 names. */
const ENCRYPTED = 0x0001;
const STRONG_ENCRYPTION = 0x0040;
const UTF8 = 0x0800;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** A size for messages: whole MiB as MiB, anything else in bytes. */
export function sizeText(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes >= mib && bytes % mib === 0 ? `${bytes / mib} MiB` : `${bytes} bytes`;
}

/** A buffer as a source. */
export function bufferSource(buffer: Uint8Array): ZipSource {
  return { size: buffer.byteLength, read: (offset, length) => buffer.subarray(offset, offset + length) };
}

/** The file at `path` as a source, for `use`; the file is closed afterwards. */
export function withFileSource<T>(path: string, use: (source: ZipSource) => T): T {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    return use({
      size,
      read(offset, length) {
        const buffer = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
          const count = readSync(fd, buffer, done, length - done, offset + done);
          if (count === 0) throw new ZipError('the zip file ended early');
          done += count;
        }
        return buffer;
      },
    });
  } finally {
    closeSync(fd);
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A 64-bit field as a number; larger than any file this reads, it is refused. */
function u64(data: DataView, at: number): number {
  const value = data.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('the end of the central directory is malformed: a ZIP64 field is out of range');
  return Number(value);
}

interface Directory {
  offset: number;
  size: number;
  entries: number;
  /** Where the record that follows the central directory starts: the central directory must end there. */
  end: number;
}

/** The end of central directory record (and its ZIP64 form when the record says so). */
function readEnd(source: ZipSource): Directory {
  if (source.size < END_LENGTH) throw new ZipError('the file is too short to be a zip file');
  const tail = Math.min(source.size, END_LENGTH + MAX_COMMENT);
  const bytes = source.read(source.size - tail, tail);
  const data = view(bytes);
  let at = -1;
  // The record is the last one whose comment ends the file.
  for (let index = tail - END_LENGTH; index >= 0; index--) {
    if (data.getUint32(index, true) === END && index + END_LENGTH + data.getUint16(index + 20, true) === tail) {
      at = index;
      break;
    }
  }
  if (at === -1) throw new ZipError('the file is not a zip file: it has no end of central directory record');
  const position = source.size - tail + at;
  const disk = data.getUint16(at + 4, true);
  const directoryDisk = data.getUint16(at + 6, true);
  const onDisk = data.getUint16(at + 8, true);
  const entries = data.getUint16(at + 10, true);
  const size = data.getUint32(at + 12, true);
  const offset = data.getUint32(at + 16, true);
  if (entries !== U16_MAX && size !== U32_MAX && offset !== U32_MAX) {
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== entries) throw new ZipError('the zip file spans several disks, which depcurfew does not read');
    return { offset, size, entries, end: position };
  }
  // ZIP64: the locator right before the record points to the ZIP64 end of central directory record.
  if (position < ZIP64_LOCATOR_LENGTH) throw new ZipError('the end of the central directory is malformed: the ZIP64 locator is missing');
  const locator = view(source.read(position - ZIP64_LOCATOR_LENGTH, ZIP64_LOCATOR_LENGTH));
  if (locator.getUint32(0, true) !== ZIP64_LOCATOR) throw new ZipError('the end of the central directory is malformed: the ZIP64 locator is missing');
  if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) throw new ZipError('the zip file spans several disks, which depcurfew does not read');
  const recordAt = u64(locator, 8);
  if (recordAt + ZIP64_END_LENGTH > position - ZIP64_LOCATOR_LENGTH) throw new ZipError('the end of the central directory is malformed: the ZIP64 record lies outside the file');
  const record = view(source.read(recordAt, ZIP64_END_LENGTH));
  if (record.getUint32(0, true) !== ZIP64_END) throw new ZipError('the end of the central directory is malformed: there is no ZIP64 record where the locator points');
  const disk64 = record.getUint32(16, true);
  const directoryDisk64 = record.getUint32(20, true);
  const onDisk64 = u64(record, 24);
  const entries64 = u64(record, 32);
  if (disk64 !== 0 || directoryDisk64 !== 0 || onDisk64 !== entries64) throw new ZipError('the zip file spans several disks, which depcurfew does not read');
  return { offset: u64(record, 48), size: u64(record, 40), entries: entries64, end: recordAt };
}

/** The entries of the central directory, checked against the file and the limits. */
export function readCentralDirectory(source: ZipSource, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
  const directory = readEnd(source);
  if (directory.entries > limits.entries) throw new ZipError(`the zip file has ${directory.entries} entries, more than the ${limits.entries} depcurfew reads`);
  if (directory.size > limits.centralDirectoryBytes) throw new ZipError(`the central directory of the zip file is larger than ${sizeText(limits.centralDirectoryBytes)}`);
  if (directory.offset + directory.size !== directory.end) throw new ZipError('the central directory is malformed: its offset and size do not end where the end record starts');
  const bytes = source.read(directory.offset, directory.size);
  const data = view(bytes);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < directory.entries; index++) {
    if (at + CENTRAL_LENGTH > bytes.byteLength || data.getUint32(at, true) !== CENTRAL) throw new ZipError(`the central directory is malformed: entry ${index + 1} of ${directory.entries} is missing or broken`);
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const crc = data.getUint32(at + 16, true);
    const compressedSize = data.getUint32(at + 20, true);
    const size = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const disk = data.getUint16(at + 34, true);
    const offset = data.getUint32(at + 42, true);
    const next = at + CENTRAL_LENGTH + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new ZipError(`the central directory is malformed: entry ${index + 1} of ${directory.entries} runs past its end`);
    const raw = bytes.subarray(at + CENTRAL_LENGTH, at + CENTRAL_LENGTH + nameLength);
    const name = Buffer.from(raw).toString((flags & UTF8) !== 0 ? 'utf8' : 'latin1');
    entries.push({ name, flags, method, crc, compressedSize, size, offset });
    // An entry whose size or offset is in a ZIP64 field, or on another disk: the export has none (dataExport).
    if (compressedSize === U32_MAX || size === U32_MAX || offset === U32_MAX || disk === U16_MAX) {
      throw new ZipError(`the entry ${JSON.stringify(name.slice(0, 100))} needs ZIP64 fields, which depcurfew does not read`);
    }
    if (disk !== 0) throw new ZipError('the zip file spans several disks, which depcurfew does not read');
    at = next;
  }
  if (at !== bytes.byteLength) throw new ZipError('the central directory is malformed: it holds more than its entries');
  return entries;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3), as zip files use; node:zlib has crc32 only from Node.js 20.15 and 22.2, so older ones compute it here. */
export function crc32(bytes: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
  if (typeof native === 'function') return native(bytes) >>> 0;
  return tableCrc32(bytes);
}

/** CRC-32 with a table, for Node.js without zlib.crc32. */
export function tableCrc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = (table[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inflates the entries `wanted` picks, in the order of the archive, and hands each to `use`. Every entry picked is
 * checked first: not encrypted, stored or deflated, within the limits, its data inside the file before the central
 * directory, and not overlapping another entry picked. Throws ZipError at the first problem.
 */
export function readEntries(source: ZipSource, wanted: (name: string) => boolean, use: (entry: ZipEntry, data: Buffer) => void, limits: ZipLimits = ZIP_LIMITS): void {
  const directory = readEnd(source);
  const picked = readCentralDirectory(source, limits)
    .filter((entry) => wanted(entry.name))
    .sort((a, b) => a.offset - b.offset);
  let total = 0;
  const shown = (entry: ZipEntry) => JSON.stringify(entry.name.slice(0, 100));
  for (const entry of picked) {
    if ((entry.flags & (ENCRYPTED | STRONG_ENCRYPTION)) !== 0) throw new ZipError(`the entry ${shown(entry)} is encrypted`);
    if (entry.method !== STORED && entry.method !== DEFLATED) throw new ZipError(`the entry ${shown(entry)} uses the compression method ${entry.method}; depcurfew reads only stored and deflated entries`);
    if (entry.method === STORED && entry.compressedSize !== entry.size) throw new ZipError(`the entry ${shown(entry)} is stored, but its sizes differ`);
    if (entry.compressedSize > limits.entryCompressedBytes || entry.size > limits.entryBytes) throw new ZipError(`the entry ${shown(entry)} is larger than ${sizeText(entry.size > limits.entryBytes ? limits.entryBytes : limits.entryCompressedBytes)}${entry.size > limits.entryBytes ? '' : ' compressed'}`);
    if (entry.size > limits.ratio * Math.max(entry.compressedSize, 1)) throw new ZipError(`the entry ${shown(entry)} inflates more than ${limits.ratio} times, as a zip bomb does`);
    total += entry.size;
    if (total > limits.totalBytes) throw new ZipError(`the entries read inflate to more than ${sizeText(limits.totalBytes)}`);
  }
  let previousEnd = 0;
  for (const entry of picked) {
    if (entry.offset < previousEnd) throw new ZipError(`the entry ${shown(entry)} overlaps another entry`);
    if (entry.offset + LOCAL_LENGTH > directory.offset) throw new ZipError(`the entry ${shown(entry)} lies outside the data of the zip file`);
    const header = view(source.read(entry.offset, LOCAL_LENGTH));
    if (header.getUint32(0, true) !== LOCAL) throw new ZipError(`the entry ${shown(entry)} has no local header where the central directory points`);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.offset + LOCAL_LENGTH + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > directory.offset) throw new ZipError(`the entry ${shown(entry)} lies outside the data of the zip file`);
    // The local header names the same file and is just as unencrypted, so that no other reader sees another archive.
    const localName = Buffer.from(source.read(entry.offset + LOCAL_LENGTH, nameLength)).toString((header.getUint16(6, true) & UTF8) !== 0 ? 'utf8' : 'latin1');
    if (localName !== entry.name) throw new ZipError(`the entry ${shown(entry)} has another name in its local header`);
    if ((header.getUint16(6, true) & (ENCRYPTED | STRONG_ENCRYPTION)) !== 0) throw new ZipError(`the entry ${shown(entry)} is encrypted`);
    previousEnd = end;
    const compressed = source.read(start, entry.compressedSize);
    let data: Buffer;
    if (entry.method === STORED) {
      data = Buffer.from(compressed);
    } else {
      try {
        // maxOutputLength stops the inflation at the declared size: a longer output is an error, not a buffer.
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
      } catch (error) {
        const tooLong = error instanceof RangeError || (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
        throw new ZipError(tooLong ? `the entry ${shown(entry)} inflates to more than its declared size` : `the entry ${shown(entry)} cannot be inflated`);
      }
    }
    if (data.byteLength !== entry.size) throw new ZipError(`the entry ${shown(entry)} does not inflate to its declared size`);
    if (crc32(data) !== entry.crc) throw new ZipError(`the entry ${shown(entry)} is damaged: its CRC-32 does not match`);
    use(entry, data);
  }
}
