// Large repositories cannot make detection and doctor much slower than in 1.4.1 (decision D-157). Before the fix every
// file of every top-level directory was resolved and stat-ed, each with one lstat per segment of its path, only to
// compare its name with the files of Cargo, Go modules, Maven, Gradle and NuGet (decision D-151), and doctor without
// depcurfew.json detected the root up to four times, every project twice, and compared every project init would list
// with the default policy (decision D-149). On the machine of the measurements the CLI took 6.9 s with 30,000 files in
// one directory (1.3 s in 1.4.1, 0.24 s now), 8.6 s with local OSV.dev data, 3.0 s with 500 directories of 20 files
// (0.6 s, 0.24 s), 13.6 s with 2,000 projects without a root manifest (0.4 s, 0.47 s) and 24 s with 20,000 top-level
// directories (4.9 s, 1.6 s). In these tests, without the start of the process, they take 4.2 s, 1.6 s, 12 s and 18 s
// before the fix; the limits leave a wide margin for slow CI machines.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import { detectProject } from '../../src/detect/index.ts';
import { Repository } from '../../src/detect/repository.ts';
import { localData } from '../support/osv-data.ts';
import { canSymlink } from '../support/platform.ts';

/** The paths given to lstatSync, statSync and realpathSync while `recording` is set. */
const touched = vi.hoisted(() => ({ recording: false, paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = <F extends (...args: never[]) => unknown>(original: F): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (touched.recording) touched.paths.push(String(path));
      return (original as unknown as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown as F;
  return { ...actual, lstatSync: record(actual.lstatSync), statSync: record(actual.statSync), realpathSync: Object.assign(record(actual.realpathSync), { native: record(actual.realpathSync.native) }) };
});

const NOW = new Date('2026-11-02T18:00:00Z');
// The file system of Windows runners is several times slower with tens of thousands of entries; the bounds catch a
// quadratic walk (5 to 20 times slower), not the speed of one file system.
const SLOW = process.platform === 'win32' ? 3 : 1;
const temporary: string[] = [];
// Removing tens of thousands of files takes longer than the default hook timeout on Windows runners.
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
}, 300_000);

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-detect-speed-'));
  temporary.push(directory);
  return directory;
}

/** Empty files `count` in `directory` (created), named f1, f2 … with the extension. */
function files(directory: string, count: number, extension = ''): void {
  mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= count; index++) writeFileSync(join(directory, `f${index}${extension}`), '');
}

const never: FetchLike = async (url) => {
  throw new Error(`doctor asked ${url}`);
};

/** depcurfew doctor --json on `root` as the CLI runs it, with the local OSV.dev data of `data` (none by default). */
async function doctor(root: string, data?: string): Promise<{ code: number; report: { policySource: string | null; findings: { rule: string }[]; notices: { code: string }[] }; seconds: number }> {
  let stdout = '';
  const start = performance.now();
  const code = await run(['doctor', '--json', root], { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch: never,
    now: () => NOW,
    stdin: async () => '',
    osvData: () => data,
  });
  return { code, report: JSON.parse(stdout) as never, seconds: (performance.now() - start) / 1000 };
}

describe('doctor on large repositories (decision D-157)', () => {
  it('30,000 files in one directory, without and with depcurfew.json and local OSV.dev data', { timeout: 120_000 }, async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"name": "root", "version": "1.0.0"}\n');
    files(join(root, 'assets'), 30_000, '.png');
    const plain = await doctor(root);
    expect(plain.report.policySource).toBe('default');
    expect(plain.seconds).toBeLessThan(2 * SLOW);
    const data = await localData(temporary, NOW);
    expect((await doctor(root, data)).seconds).toBeLessThan(2 * SLOW);
    writeFileSync(join(root, 'depcurfew.json'), '{"version": 1, "cooldown": {"minimum": "3d"}}\n');
    const withPolicy = await doctor(root, data);
    expect(withPolicy.report.policySource).toBe('file');
    expect(withPolicy.seconds).toBeLessThan(2 * SLOW);
  });

  it('500 top-level directories of 20 files', { timeout: 120_000 }, async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"name": "root", "version": "1.0.0"}\n');
    for (let index = 1; index <= 500; index++) files(join(root, `d${index}`), 20, '.txt');
    const result = await doctor(root);
    expect(result.report.policySource).toBe('default');
    expect(result.seconds).toBeLessThan(1 * SLOW);
  });

  it('2,000 projects without a root manifest', { timeout: 120_000 }, async () => {
    const root = scratch();
    for (let index = 1; index <= 2000; index++) {
      mkdirSync(join(root, `p${index}`));
      writeFileSync(join(root, `p${index}`, 'package.json'), `{"name": "p${index}", "version": "1.0.0"}\n`);
    }
    const result = await doctor(root, await localData(temporary, NOW));
    expect(result.report.policySource).toBe('default');
    expect(result.seconds).toBeLessThan(4 * SLOW);
  });

  it('20,000 top-level directories', { timeout: 180_000 }, async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"name": "root", "version": "1.0.0"}\n');
    for (let index = 1; index <= 20_000; index++) mkdirSync(join(root, `d${index}`));
    const result = await doctor(root);
    expect(result.report.policySource).toBe('default');
    expect(result.seconds).toBeLessThan(10 * SLOW);
  });
});

describe('names that cannot match (decision D-157)', () => {
  it('are neither resolved nor stat-ed by detection or doctor', async () => {
    // The real path, as detection resolves it (the temporary directory may lie behind a symlink, as on macOS).
    const root = realpathSync(scratch());
    writeFileSync(join(root, 'package.json'), '{"name": "root", "version": "1.0.0"}\n');
    files(join(root, 'assets'), 200, '.png');
    for (let index = 1; index <= 20; index++) files(join(root, `d${index}`), 5, '.txt');
    writeFileSync(join(root, 'd1', 'go.mod'), 'module example.com/x\n');
    const decoys = [...Array.from({ length: 200 }, (_, index) => join(root, 'assets', `f${index + 1}.png`)), ...Array.from({ length: 100 }, (_, index) => join(root, `d${Math.floor(index / 5) + 1}`, `f${(index % 5) + 1}.txt`))];
    touched.paths = [];
    touched.recording = true;
    try {
      expect(detectProject(root).botEcosystems).toEqual([{ id: 'gomod', files: ['d1/go.mod'] }]);
      expect((await doctor(root)).code).toBe(0);
    } finally {
      touched.recording = false;
    }
    expect(touched.paths.length).toBeGreaterThan(0);
    const seen = new Set(touched.paths);
    expect(decoys.filter((path) => seen.has(path))).toEqual([]);
  });
});

describe('the files of the bot-only ecosystems among many others (decision D-157)', () => {
  it('are found by name in a directory of 30,000 files, in seconds', { timeout: 60_000 }, () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{}\n');
    files(join(root, 'assets'), 30_000, '.csproj.txt');
    writeFileSync(join(root, 'assets', 'App.csproj'), '<Project />\n');
    writeFileSync(join(root, 'assets', 'nuget.config'), '<configuration />\n');
    files(join(root, 'go'), 10);
    writeFileSync(join(root, 'go', 'go.mod'), 'module example.com/x\n');
    const start = performance.now();
    const detection = detectProject(root);
    expect((performance.now() - start) / 1000).toBeLessThan(0.5 * SLOW);
    expect(detection.botEcosystems).toEqual([
      { id: 'gomod', files: ['go/go.mod'] },
      { id: 'nuget', files: ['assets/App.csproj', 'assets/nuget.config'] },
    ]);
  });
});

// Resolving a path without one lstat per segment (decision D-157) must not change what is read: a path with a symlink
// on the way is resolved in full and stays inside the repository, also after paths without one were resolved.
describe('Repository paths with and without symlinks on the way', () => {
  function layout(): { repo: string; outside: string } {
    const base = scratch();
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    mkdirSync(join(repo, 'real', 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.json'), '{"secret": true}\n');
    writeFileSync(join(repo, 'real', 'sub', 'file.json'), '{"inside": true}\n');
    writeFileSync(join(repo, 'package.json'), '{}\n');
    return { repo, outside };
  }

  it('reads files in plain directories, and through .. that stays inside', () => {
    const { repo } = layout();
    const repository = new Repository(repo);
    expect(repository.readText('real/sub/file.json')).toBe('{"inside": true}\n');
    expect(repository.readText('real/../package.json')).toBe('{}\n');
    expect(repository.isFile('real/sub')).toBe(false);
    expect(repository.listFiles('real/sub')).toEqual(['file.json']);
    expect(repository.listDirectories('real')).toEqual(['sub']);
    expect(repository.warnings).toEqual([]);
  });

  it('does not read a file outside through ..', () => {
    const { repo } = layout();
    const repository = new Repository(repo);
    expect(repository.readText('../outside/secret.json')).toBeUndefined();
    expect(repository.isFile('../outside/secret.json')).toBe(false);
    expect(repository.warnings.map((warning) => warning.code)).toEqual(['outside-repository']);
  });

  it.skipIf(!canSymlink())('does not read through a symlinked directory that leads outside, before or after plain paths', () => {
    const { repo, outside } = layout();
    symlinkSync(outside, join(repo, 'link'), 'junction');
    symlinkSync(outside, join(repo, 'real', 'link'), 'junction');
    const repository = new Repository(repo);
    expect(repository.readText('real/sub/file.json')).toBe('{"inside": true}\n');
    for (const path of ['link/secret.json', 'real/link/secret.json']) {
      expect(repository.readText(path), path).toBeUndefined();
      expect(repository.isFile(path), path).toBe(false);
    }
    expect(repository.listFiles('link')).toEqual([]);
    expect(repository.listFiles('real/link')).toEqual([]);
    expect(repository.listDirectories('real')).toEqual(['sub']);
    expect(repository.warnings.map((warning) => warning.message)).toEqual([
      'link/secret.json points outside the repository and was not read',
      'real/link/secret.json points outside the repository and was not read',
    ]);
  });

  it.skipIf(!canSymlink())('reads through a symlinked directory and a symlinked file that stay inside', () => {
    const { repo, outside } = layout();
    symlinkSync(join(repo, 'real'), join(repo, 'alias'), 'junction');
    symlinkSync(join(repo, 'real', 'sub', 'file.json'), join(repo, 'real', 'linked.json'));
    symlinkSync(join(outside, 'secret.json'), join(repo, 'real', 'secret.json'));
    const repository = new Repository(repo);
    expect(repository.readText('alias/sub/file.json')).toBe('{"inside": true}\n');
    expect(repository.readText('real/linked.json')).toBe('{"inside": true}\n');
    expect(repository.readText('real/secret.json')).toBeUndefined();
    expect(repository.listFiles('real')).toEqual(['linked.json']);
    expect(repository.listFiles('alias', (name) => name.endsWith('.json'))).toEqual(['linked.json']);
    expect(repository.listDirectories('.')).toEqual(['alias', 'real']);
    expect(repository.warnings.map((warning) => warning.message)).toEqual(['real/secret.json points outside the repository and was not read']);
  });

  it('lists only the names a filter accepts, sorted, as the full list filtered', () => {
    const { repo } = layout();
    files(join(repo, 'many'), 50, '.txt');
    mkdirSync(join(repo, 'many', 'f7.txt.d'));
    const repository = new Repository(repo);
    const accept = (name: string) => name.startsWith('f1');
    expect(repository.listFiles('many', accept)).toEqual(repository.listFiles('many').filter(accept));
    expect(repository.listFiles('many', accept)).toHaveLength(11);
    expect(repository.listDirectories('many', (name) => name.startsWith('f7'))).toEqual(['f7.txt.d']);
    expect(repository.listDirectories('many', (name) => name.startsWith('f1'))).toEqual([]);
  });
});
