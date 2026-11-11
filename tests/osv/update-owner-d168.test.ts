// depcurfew osv update run as root in the home directory of another user (sudo with HOME kept, decision D-168): what
// it creates there belongs to the owner of the home directory, as with init and apply --user (decision D-093), so that
// the user's own osv update and lookups can use it, and the directories stay writable by that user alone.
import { chownSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { exportFetch, standardExports } from '../support/osv-data.ts';
import { asRoot } from '../support/platform.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `depcurfew-d168-osv-${prefix}-`));
  temporary.push(path);
  return path;
}

async function update(home: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(['osv', 'update', '--ecosystem', 'packagist', '--json'], { stdout: (text) => (stdout += text), stderr: () => undefined }, {
    fetch: exportFetch(standardExports()),
    now: () => NOW,
    stdin: async () => '',
    userEnvironment: () => ({ platform: 'linux', home, env }),
  });
  return { code, stdout };
}

describe('osv update as root in the home directory of another user', () => {
  it.skipIf(!asRoot)('gives the directories and the data file it creates to the owner of the home directory', async () => {
    const home = directory('home');
    mkdirSync(join(home, '.cache'));
    chownSync(home, 65534, 65534);
    const result = await update(home);
    expect(result.code).toBe(0);
    // The user's own lookups read the data as that user: no warning that another user can change it.
    expect((JSON.parse(result.stdout) as { warnings: unknown[] }).warnings).toEqual([]);
    // ~/.cache existed (root's here) and stays as it was; what osv update made is the user's.
    expect(statSync(join(home, '.cache')).uid).toBe(0);
    for (const path of [join(home, '.cache', 'depcurfew'), join(home, '.cache', 'depcurfew', 'osv'), join(home, '.cache', 'depcurfew', 'osv', 'packagist.jsonl')]) {
      const stats = statSync(path);
      expect({ path, uid: stats.uid, gid: stats.gid }).toEqual({ path, uid: 65534, gid: 65534 });
      expect(stats.mode & 0o022).toBe(0);
    }
    // A second run replaces the data file with one of the same owner.
    expect((await update(home)).code).toBe(0);
    expect(statSync(join(home, '.cache', 'depcurfew', 'osv', 'packagist.jsonl')).uid).toBe(65534);
  });

  it.skipIf(!asRoot)('leaves to root what it creates outside the home directory (an absolute XDG_CACHE_HOME elsewhere)', async () => {
    const home = directory('home');
    chownSync(home, 65534, 65534);
    const cache = directory('cache');
    expect((await update(home, { XDG_CACHE_HOME: cache })).code).toBe(0);
    expect(statSync(join(cache, 'depcurfew', 'osv', 'packagist.jsonl')).uid).toBe(0);
  });
});
