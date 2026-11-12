// The local OSV.dev data has files for the ecosystems depcurfew osv update downloads only (npm, pypi, packagist). For any
// other name, such as an ecosystem a later depcurfew or a program using the library knows (crates, nuget), or a name
// with a path in it, LocalOsvData answers "missing" before it touches a file: it never reads a file of the cache
// directory that osv update did not write, nor one outside it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalOsvData, OSV_DATA_ECOSYSTEMS, OSV_DATA_FORMAT, OSV_DATA_FORMAT_VERSION } from '../../src/osv/data.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A file in the format osv update writes, with no package lines, for the ecosystem name `ecosystem`. */
function dataFile(ecosystem: string): string {
  const header = { format: OSV_DATA_FORMAT, formatVersion: OSV_DATA_FORMAT_VERSION, ecosystem, osvEcosystem: ecosystem, export: 'test', downloadedAt: '2026-11-12T00:00:00.000Z', exportedAt: null, records: 0 };
  return `${JSON.stringify(header)}\n`;
}

function cache(): { parent: string; directory: string } {
  const parent = mkdtempSync(join(tmpdir(), 'depcurfew-e30-'));
  temporary.push(parent);
  const directory = join(parent, 'osv');
  mkdirSync(directory);
  return { parent, directory };
}

describe('LocalOsvData for an ecosystem osv update does not download (E30)', () => {
  it('answers missing for crates and nuget even when a file of that name is in the directory', () => {
    const { directory } = cache();
    for (const ecosystem of ['crates', 'nuget']) writeFileSync(join(directory, `${ecosystem}.jsonl`), dataFile(ecosystem));
    const local = new LocalOsvData(directory);
    for (const ecosystem of ['crates', 'nuget']) {
      expect(local.state(ecosystem), ecosystem).toEqual({ status: 'missing', file: '' });
      expect(local.exists(ecosystem), ecosystem).toBe(false);
      expect(local.lookup({ ecosystem, name: 'serde', version: '1.0.0' }), ecosystem).toBeUndefined();
    }
    expect(local.any()).toBe(false);
  });

  it('never reads a file outside the directory for a name with a path in it', () => {
    const { parent, directory } = cache();
    // Read as a file, a directory would make the state "unreadable": the answer shows no file was opened.
    mkdirSync(join(parent, 'outside.jsonl'));
    writeFileSync(join(parent, 'npm.jsonl'), dataFile('../npm'));
    const local = new LocalOsvData(directory);
    for (const ecosystem of ['../outside', '../npm', '..', '', '__proto__', 'constructor', 'NPM']) {
      expect(local.state(ecosystem), JSON.stringify(ecosystem)).toEqual({ status: 'missing', file: '' });
    }
  });

  it('still reads the file of each ecosystem osv update downloads', () => {
    const { directory } = cache();
    for (const ecosystem of OSV_DATA_ECOSYSTEMS) writeFileSync(join(directory, `${ecosystem}.jsonl`), dataFile(ecosystem));
    const local = new LocalOsvData(directory);
    for (const ecosystem of OSV_DATA_ECOSYSTEMS) {
      expect(local.state(ecosystem), ecosystem).toMatchObject({ status: 'ready', file: join(directory, `${ecosystem}.jsonl`), records: 0 });
    }
  });
});
