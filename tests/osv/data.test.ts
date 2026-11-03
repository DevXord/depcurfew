// Lookups in the local OSV.dev data (decision D-150): names compared as each registry compares them (npm as they are,
// PyPI after PEP 503, Packagist in lower case), versions matched as the OSV schema evaluates affected[] (the versions
// list; ranges with introduced, fixed, last_affected and limit), Packagist versions with or without a leading v, and
// withdrawn records never used. A file depcurfew did not write is not taken as an answer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataAgeDays, dataStaleness, LocalOsvData, osvDataFile, readRecord } from '../../src/osv/data.ts';
import { affects } from '../../src/osv/match.ts';
import { localData } from '../support/osv-data.ts';
import { buildZip, malRecord } from '../support/zip.ts';

const NOW = new Date('2026-11-02T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const zipOf = (...records: string[]) => buildZip(records.map((record) => ({ name: `${(JSON.parse(record) as { id: string }).id}.json`, data: record })));
const semver = (...events: Record<string, string>[]) => ({ ranges: [{ type: 'SEMVER', events }] });
const ecosystem = (...events: Record<string, string>[]) => ({ ranges: [{ type: 'ECOSYSTEM', events }] });

describe('the local OSV.dev data', () => {
  it('finds npm versions in the versions list and in SEMVER ranges with introduced 0, fixed, last_affected and limit', async () => {
    const directory = await localData(temporary, NOW, {
      npm: zipOf(
        malRecord('MAL-2026-1', 'npm', 'every-version', semver({ introduced: '0' })),
        malRecord('MAL-2026-2', 'npm', 'fixed-later', semver({ introduced: '1.2.0' }, { fixed: '1.4.0' })),
        malRecord('MAL-2026-3', 'npm', 'last-affected', semver({ introduced: '0' }, { last_affected: '2.0.0' })),
        malRecord('MAL-2026-4', 'npm', 'limited', semver({ introduced: '1.0.0' }, { limit: '1.5.0' })),
        malRecord('MAL-2026-5', 'npm', 'listed', { versions: ['3.1.4'] }),
        malRecord('MAL-2026-6', 'npm', '@scope/Name', { versions: ['1.0.0'] }),
      ),
    });
    const local = new LocalOsvData(directory);
    const ids = (name: string, version: string) => local.lookup({ ecosystem: 'npm', name, version });
    expect(ids('every-version', '0.0.1')).toEqual(['MAL-2026-1']);
    expect(ids('every-version', '9.9.9-beta.1')).toEqual(['MAL-2026-1']);
    expect([ids('fixed-later', '1.1.9'), ids('fixed-later', '1.2.0'), ids('fixed-later', '1.3.9'), ids('fixed-later', '1.4.0')]).toEqual([[], ['MAL-2026-2'], ['MAL-2026-2'], []]);
    expect([ids('last-affected', '2.0.0'), ids('last-affected', '2.0.1')]).toEqual([['MAL-2026-3'], []]);
    expect([ids('limited', '0.9.0'), ids('limited', '1.4.9'), ids('limited', '1.5.0')]).toEqual([[], ['MAL-2026-4'], []]);
    expect([ids('listed', '3.1.4'), ids('listed', '3.1.5')]).toEqual([['MAL-2026-5'], []]);
    // npm names are compared as they are.
    expect([ids('@scope/Name', '1.0.0'), ids('@scope/name', '1.0.0')]).toEqual([['MAL-2026-6'], []]);
    expect(ids('not-in-the-data', '1.0.0')).toEqual([]);
  });

  it('compares Python names after PEP 503 and versions as PEP 440 orders them', async () => {
    const directory = await localData(temporary, NOW, {
      pypi: zipOf(
        malRecord('MAL-2026-10', 'PyPI', 'wallet-tracking', { versions: ['1.0.0'] }),
        malRecord('MAL-2026-11', 'PyPI', 'Some_Package', ecosystem({ introduced: '1.0' }, { fixed: '1.0.post1' })),
      ),
    });
    const local = new LocalOsvData(directory);
    const ids = (name: string, version: string) => local.lookup({ ecosystem: 'pypi', name, version });
    expect(ids('Wallet_Tracking', '1.0.0')).toEqual(['MAL-2026-10']);
    expect(ids('wallet.tracking', '1.0')).toEqual(['MAL-2026-10']);
    expect([ids('some-package', '1.0.0'), ids('SOME.PACKAGE', '1.0.post1'), ids('some-package', '0.9')]).toEqual([['MAL-2026-11'], [], []]);
  });

  it('matches Packagist versions with or without a leading v and names in lower case', async () => {
    const directory = await localData(temporary, NOW, {
      packagist: zipOf(
        malRecord('MAL-2026-3637', 'Packagist', 'intercom/intercom-php', { versions: ['5.0.2'] }),
        malRecord('MAL-2026-20', 'Packagist', 'acme/tagged', ecosystem({ introduced: 'v2.0.0' }, { fixed: 'v2.1.0' })),
      ),
    });
    const local = new LocalOsvData(directory);
    const ids = (name: string, version: string) => local.lookup({ ecosystem: 'packagist', name, version });
    expect([ids('Intercom/Intercom-PHP', 'v5.0.2'), ids('intercom/intercom-php', '5.0.2'), ids('intercom/intercom-php', '5.0.1')]).toEqual([['MAL-2026-3637'], ['MAL-2026-3637'], []]);
    expect([ids('acme/tagged', '2.0.5'), ids('acme/tagged', 'v2.0.5'), ids('acme/tagged', '2.1.0')]).toEqual([['MAL-2026-20'], ['MAL-2026-20'], []]);
  });

  it('leaves out withdrawn records, other ids, other ecosystems and ranges of commits', async () => {
    const directory = await localData(temporary, NOW, {
      npm: buildZip([
        { name: 'MAL-2026-30.json', data: malRecord('MAL-2026-30', 'npm', 'withdrawn-one', semver({ introduced: '0' }), { withdrawn: '2026-10-01T00:00:00Z' }) },
        { name: 'GHSA-aaaa-bbbb-cccc.json', data: malRecord('GHSA-aaaa-bbbb-cccc', 'npm', 'vulnerable', semver({ introduced: '0' })) },
        { name: 'MAL-2026-31.json', data: malRecord('MAL-2026-31', 'PyPI', 'other-ecosystem', { versions: ['1.0.0'] }) },
        { name: 'MAL-2026-32.json', data: malRecord('MAL-2026-32', 'npm', 'commits', { ranges: [{ type: 'GIT', events: [{ introduced: '0' }] }] }) },
        { name: 'MAL-2026-33.json', data: 'not json' },
      ]),
    });
    const local = new LocalOsvData(directory);
    for (const name of ['withdrawn-one', 'vulnerable', 'other-ecosystem', 'commits']) expect(local.lookup({ ecosystem: 'npm', name, version: '1.0.0' }), name).toEqual([]);
    expect(local.state('npm')).toMatchObject({ status: 'ready', records: 0 });
  });

  it('finds every package of a large file by its binary search', async () => {
    const names = Array.from({ length: 500 }, (_, index) => `package-${String(index).padStart(3, '0')}`);
    const directory = await localData(temporary, NOW, { npm: zipOf(...names.map((name, index) => malRecord(`MAL-2026-${1000 + index}`, 'npm', name, { versions: ['1.0.0'] }))) });
    const local = new LocalOsvData(directory);
    names.forEach((name, index) => expect(local.lookup({ ecosystem: 'npm', name, version: '1.0.0' })).toEqual([`MAL-2026-${1000 + index}`]));
    expect(local.lookup({ ecosystem: 'npm', name: 'package-0005', version: '1.0.0' })).toEqual([]);
    expect(local.lookup({ ecosystem: 'npm', name: 'a', version: '1.0.0' })).toEqual([]);
    expect(local.lookup({ ecosystem: 'npm', name: 'zzz', version: '1.0.0' })).toEqual([]);
  });

  it('has no answer without a file, and does not take a file depcurfew did not write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depcurfew-osv-data-'));
    temporary.push(directory);
    const local = new LocalOsvData(directory);
    expect(local.lookup({ ecosystem: 'npm', name: 'cutekitten-test', version: '1.0.1' })).toBeUndefined();
    expect(local.any()).toBe(false);
    writeFileSync(osvDataFile(directory, 'npm'), '{"packages":{"cutekitten-test":[]}}\n');
    mkdirSync(osvDataFile(directory, 'pypi'));
    const other = new LocalOsvData(directory);
    expect(other.lookup({ ecosystem: 'npm', name: 'cutekitten-test', version: '1.0.1' })).toBeUndefined();
    expect(other.state('npm')).toMatchObject({ status: 'unreadable', reason: 'it is not a file that depcurfew osv update writes for npm' });
    expect(other.state('pypi')).toMatchObject({ status: 'unreadable', reason: 'it is not a regular file' });
    expect(new LocalOsvData(undefined).any()).toBe(false);
  });

  it('dates the data by the export, else by the download, and says when it is old', async () => {
    const withExport = new LocalOsvData(await localData(temporary, NOW));
    const ready = withExport.state('npm');
    if (ready.status !== 'ready') throw new Error('no data');
    expect(ready.exportedAt).toBe('2026-11-02T06:00:00.000Z');
    expect(dataStaleness(ready, new Date('2026-11-09T06:00:00Z'))).toBe('fresh');
    expect(dataStaleness(ready, new Date('2026-11-09T06:00:01Z'))).toBe('note');
    expect(dataStaleness(ready, new Date('2026-12-02T06:00:01Z'))).toBe('warning');
    expect(dataAgeDays(ready, new Date('2026-12-02T06:00:01Z'))).toBe(30);
    const withoutExport = new LocalOsvData(await localData(temporary, NOW, undefined, {})).state('npm');
    expect(withoutExport).toMatchObject({ status: 'ready', exportedAt: null, downloadedAt: NOW.toISOString() });
  });
});

describe('affected versions of a record', () => {
  it('evaluates ranges as the OSV schema does, also with several introduced events', () => {
    const range = ['SEMVER', 'introduced', '1.0.0', 'fixed', '1.1.0', 'introduced', '2.0.0', 'last_affected', '2.0.3'];
    const of = (version: string) => affects({ versions: [], ranges: [range] }, 'npm', version);
    expect(['0.9.0', '1.0.0', '1.0.9', '1.1.0', '1.9.9', '2.0.0', '2.0.3', '2.0.4'].map(of)).toEqual([false, true, true, false, false, true, true, false]);
  });

  it('uses a range that only says introduced 0 for any version, also one it cannot parse', () => {
    expect(affects({ versions: [], ranges: [['SEMVER', 'introduced', '0']] }, 'npm', 'not a version')).toBe(true);
    expect(affects({ versions: [], ranges: [['SEMVER', 'introduced', '1.0.0']] }, 'npm', 'not a version')).toBe(false);
    expect(affects({ versions: [], ranges: [['SEMVER', 'introduced', 'garbage']] }, 'npm', '1.0.0')).toBe(false);
  });

  it('keeps only ranges whose events the schema defines', () => {
    const kept = readRecord(JSON.parse(malRecord('MAL-2026-40', 'npm', 'x', { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { surprise: '1.0.0' }] }, { type: 'SEMVER', events: [{ introduced: '2.0.0' }] }] })), 'npm');
    expect(kept).toEqual({ status: 'kept', id: 'MAL-2026-40', packages: new Map([['x', { versions: [], ranges: [['SEMVER', 'introduced', '2.0.0']] }]]) });
    expect(readRecord({ id: 'MAL-2026-41 ; rm', affected: [] }, 'npm')).toEqual({ status: 'skipped' });
  });
});
