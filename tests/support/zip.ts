// Builds small zip files in tests, for the reader of the OSV.dev export (src/osv/zip.ts, decision D-150), so that no zip
// file has to be committed. Each entry can be stored or deflated; the options make the archive wrong in the ways the
// reader must refuse (flags, method, sizes, CRC, offsets) and can write the ZIP64 end of the central directory, as the
// export of npm has.
import { deflateRawSync } from 'node:zlib';
import { tableCrc32 } from '../../src/osv/zip.ts';

export interface TestEntry {
  name: string;
  data: string | Buffer;
  method?: 'stored' | 'deflated';
  /** General purpose flags of both headers (bit 0: encrypted). */
  flags?: number;
  /** A compression method number written as it is, instead of the one of `method`. */
  methodNumber?: number;
  /** The uncompressed size written to the central directory instead of the real one. */
  declaredSize?: number;
  /** The CRC-32 written instead of the real one. */
  crc?: number;
  /** The name in the local header, when it differs. */
  localName?: string;
}

export interface ZipOptions {
  /** Write the ZIP64 end of central directory record and locator, with 0xffff entries in the classic record. */
  zip64?: boolean;
  /** The number of entries written to the end record instead of the real one. */
  declaredEntries?: number;
  /** Added to the offset of the central directory in the end record. */
  offsetShift?: number;
  /** Point the second entry of the central directory at the local header of the first. */
  overlap?: boolean;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

/** A zip file with the entries, in their order. */
export function buildZip(entries: readonly TestEntry[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = (entry.method ?? 'deflated') === 'deflated';
    const compressed = deflated ? deflateRawSync(data) : data;
    const method = entry.methodNumber ?? (deflated ? 8 : 0);
    const flags = entry.flags ?? 0;
    const crc = entry.crc ?? tableCrc32(data);
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(localName.length),
      u16(0),
      localName,
      compressed,
    ]);
    offsets.push(offset);
    const entryOffset = options.overlap === true && centrals.length === 1 ? (offsets[0] as number) : offset;
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(entry.declaredSize ?? data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(entryOffset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const count = options.declaredEntries ?? entries.length;
  const directoryOffset = offset + (options.offsetShift ?? 0);
  const tail: Buffer[] = [];
  if (options.zip64 === true) {
    const recordOffset = offset + directory.length;
    tail.push(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(directory.length), u64(directoryOffset)]));
    tail.push(Buffer.concat([u32(0x07064b50), u32(0), u64(recordOffset), u32(1)]));
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)]));
  } else {
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(directory.length), u32(directoryOffset), u16(0)]));
  }
  return Buffer.concat([...locals, directory, ...tail]);
}

/** A MAL- record of the OSV schema for one package. */
export function malRecord(id: string, ecosystem: string, name: string, affected: { versions?: string[]; ranges?: { type: string; events: Record<string, string>[] }[] }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: '1.7.3',
    id,
    modified: '2026-10-01T00:00:00Z',
    summary: `Malicious code in ${name} (${ecosystem})`,
    affected: [{ package: { ecosystem, name }, ...affected }],
    ...extra,
  });
}
