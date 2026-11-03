// The zip reader of depcurfew osv update (decision D-150): it reads the central directory, inflates only the entries
// asked for into memory, and refuses an archive that is malformed, encrypted, compressed another way, or built to
// exhaust memory, each with a clear message. The archives are built in the test (tests/support/zip.ts).
import { describe, expect, it } from 'vitest';
import { bufferSource, crc32, readCentralDirectory, readEntries, tableCrc32, ZIP_LIMITS, ZipError, type ZipLimits } from '../../src/osv/zip.ts';
import { buildZip, type TestEntry } from '../support/zip.ts';

function read(zip: Buffer, wanted: (name: string) => boolean = () => true, limits: ZipLimits = ZIP_LIMITS): Record<string, string> {
  const found: Record<string, string> = {};
  readEntries(bufferSource(zip), wanted, (entry, data) => (found[entry.name] = data.toString('utf8')), limits);
  return found;
}

function refused(zip: Buffer, limits: ZipLimits = ZIP_LIMITS): string {
  try {
    read(zip, () => true, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(ZipError);
    return (error as Error).message;
  }
  throw new Error('the archive was read');
}

const MAL = (id: string): TestEntry => ({ name: `${id}.json`, data: JSON.stringify({ id }) });

describe('the zip reader', () => {
  it('reads stored and deflated entries', () => {
    const zip = buildZip([
      { name: 'MAL-2026-1.json', data: '{"id":"MAL-2026-1"}', method: 'stored' },
      { name: 'MAL-2026-2.json', data: '{"id":"MAL-2026-2"}'.repeat(20), method: 'deflated' },
    ]);
    expect(read(zip)).toEqual({ 'MAL-2026-1.json': '{"id":"MAL-2026-1"}', 'MAL-2026-2.json': '{"id":"MAL-2026-2"}'.repeat(20) });
  });

  it('inflates only the entries asked for', () => {
    const zip = buildZip([MAL('MAL-2026-1'), { name: 'GHSA-xxxx-yyyy-zzzz.json', data: '{"id":"GHSA-xxxx-yyyy-zzzz"}' }]);
    expect(Object.keys(read(zip, (name) => name.startsWith('MAL-')))).toEqual(['MAL-2026-1.json']);
    expect(readCentralDirectory(bufferSource(zip)).map((entry) => entry.name)).toEqual(['MAL-2026-1.json', 'GHSA-xxxx-yyyy-zzzz.json']);
  });

  it('reads the ZIP64 end of the central directory, which the export of npm needs for more than 65,535 entries', () => {
    const zip = buildZip([MAL('MAL-2026-1'), MAL('MAL-2026-2')], { zip64: true });
    expect(Object.keys(read(zip))).toEqual(['MAL-2026-1.json', 'MAL-2026-2.json']);
  });

  it('computes CRC-32 as zip files do, with and without zlib.crc32', () => {
    const data = Buffer.from('123456789');
    expect(tableCrc32(data)).toBe(0xcbf43926);
    expect(crc32(data)).toBe(0xcbf43926);
  });

  it.each([
    ['not a zip file', Buffer.from('this is not a zip file at all'), 'the file is not a zip file: it has no end of central directory record'],
    ['too short', Buffer.from('PK'), 'the file is too short to be a zip file'],
    ['a central directory whose offset is wrong', buildZip([MAL('MAL-2026-1')], { offsetShift: 3 }), 'the central directory is malformed: its offset and size do not end where the end record starts'],
    ['an end record with fewer entries than the central directory', buildZip([MAL('MAL-2026-1'), MAL('MAL-2026-2')], { declaredEntries: 1 }), 'the central directory is malformed: it holds more than its entries'],
    ['an end record with more entries than the central directory', buildZip([MAL('MAL-2026-1')], { declaredEntries: 2 }), 'the central directory is malformed: entry 2 of 2 is missing or broken'],
  ])('refuses %s', (_name, zip, message) => {
    expect(refused(zip)).toBe(message);
  });

  it('refuses an encrypted entry', () => {
    expect(refused(buildZip([{ ...MAL('MAL-2026-1'), flags: 1 }]))).toBe('the entry "MAL-2026-1.json" is encrypted');
  });

  it('refuses a compression method other than stored and deflated', () => {
    expect(refused(buildZip([{ ...MAL('MAL-2026-1'), methodNumber: 12 }]))).toBe('the entry "MAL-2026-1.json" uses the compression method 12; depcurfew reads only stored and deflated entries');
  });

  it('refuses an entry that inflates by more than the ratio of a zip bomb', () => {
    const bomb = { name: 'MAL-2026-1.json', data: Buffer.alloc(1024 * 1024, 0x20) };
    expect(refused(buildZip([bomb]))).toBe(`the entry "MAL-2026-1.json" inflates more than ${ZIP_LIMITS.ratio} times, as a zip bomb does`);
  });

  it('refuses an entry that inflates to more than it declares, without inflating the rest', () => {
    const entry = { name: 'MAL-2026-1.json', data: 'x'.repeat(5000), declaredSize: 100 };
    expect(refused(buildZip([entry]))).toBe('the entry "MAL-2026-1.json" inflates to more than its declared size');
  });

  it('refuses more entries than the limit, before reading any', () => {
    const zip = buildZip([MAL('MAL-2026-1'), MAL('MAL-2026-2'), MAL('MAL-2026-3')]);
    expect(refused(zip, { ...ZIP_LIMITS, entries: 2 })).toBe('the zip file has 3 entries, more than the 2 depcurfew reads');
  });

  it('refuses entries larger than the limits, and more inflated bytes in all than the limit', () => {
    const zip = buildZip([MAL('MAL-2026-1'), MAL('MAL-2026-2')]);
    expect(refused(zip, { ...ZIP_LIMITS, entryBytes: 10 })).toBe('the entry "MAL-2026-1.json" is larger than 10 bytes');
    expect(refused(zip, { ...ZIP_LIMITS, totalBytes: 30 })).toMatch(/^the entries read inflate to more than /u);
  });

  it('refuses a damaged entry, overlapping entries and a local header that names another file', () => {
    expect(refused(buildZip([{ ...MAL('MAL-2026-1'), crc: 1 }]))).toBe('the entry "MAL-2026-1.json" is damaged: its CRC-32 does not match');
    expect(refused(buildZip([MAL('MAL-2026-1'), MAL('MAL-2026-2')], { overlap: true }))).toBe('the entry "MAL-2026-2.json" overlaps another entry');
    expect(refused(buildZip([{ ...MAL('MAL-2026-1'), localName: 'MAL-2026-9.json' }]))).toBe('the entry "MAL-2026-1.json" has another name in its local header');
  });
});
