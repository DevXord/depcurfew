// Decision D-183: the local OSV.dev data that depcurfew osv update writes to depcurfew's user cache directory is
// exported as defaultOsvData(), the LocalOsvData that check, the hook, depcurfew mcp and doctor use, so that another
// program (agentcurfew's rule mcp-package) looks versions up in it without copying how that directory is found; it is
// undefined when nothing was downloaded.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultOsvData, LocalOsvData, updateOsvData } from '../../src/index.ts';
import { osvDataDirectories, osvDataDirectory } from '../../src/user/cache-path.ts';
import { currentEnvironment } from '../../src/user/environment.ts';
import { exportFetch, standardExports } from '../support/osv-data.ts';

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const VARIABLES = ['XDG_CACHE_HOME', 'LOCALAPPDATA'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  const cache = mkdtempSync(join(tmpdir(), 'depcurfew-d183-cache-'));
  temporary.push(cache);
  for (const name of VARIABLES) process.env[name] = cache;
});
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('defaultOsvData (decision D-183)', () => {
  it('is undefined before depcurfew osv update wrote anything', () => {
    expect(defaultOsvData()).toBeUndefined();
  });

  it('reads the data osv update wrote to the user cache directory', async () => {
    const directory = osvDataDirectory(currentEnvironment());
    expect(directory).toBeDefined();
    const results = await updateOsvData({ directory: directory as string, ecosystems: ['npm', 'pypi'], fetch: exportFetch(standardExports()), now: () => NOW });
    expect(results.map((result) => result.status)).toEqual(['updated', 'updated']);
    const data = defaultOsvData();
    expect(data).toBeInstanceOf(LocalOsvData);
    expect(data?.directory).toBe(directory);
    expect(data?.lookup({ ecosystem: 'npm', name: 'left-pad', version: '9.9.9' })).toEqual(['MAL-2026-90001']);
    expect(data?.lookup({ ecosystem: 'pypi', name: 'wallet-tracking', version: '1.0.0' })).toEqual(['MAL-2026-18443']);
    // An ecosystem without data has no answer at all, as for the CLI.
    expect(data?.lookup({ ecosystem: 'packagist', name: 'intercom/intercom-php', version: '5.0.2' })).toBeUndefined();
  });

  it('guards the directories of the user cache, as the CLI does (decision D-156)', async () => {
    const directories = osvDataDirectories(currentEnvironment());
    await updateOsvData({ directory: directories.at(-1) as string, ecosystems: ['npm'], fetch: exportFetch(standardExports()), now: () => NOW });
    expect(defaultOsvData()?.writeProblem()).toBeUndefined();
  });
});
