// One doctor run detects each directory once (decision D-157): without depcurfew.json the policy depcurfew init would
// write (decision D-149), the locked versions of known-malicious with local OSV.dev data (decision D-150), both runs of
// the rules and the projects share the detection of a directory. The report is the one of detecting each time, and no
// rule changes a detection it shares: every detection is frozen here, so a change would throw.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../src/check/registry.ts';
import { run } from '../../src/cli/run.ts';
import type { DetectOptions } from '../../src/detect/index.ts';
import { localData } from '../support/osv-data.ts';

/** Each call of detectProject (directory and projects), and whether doctor shares the detections. */
const state = vi.hoisted(() => ({ calls: [] as { root: string; projects: readonly string[] }[], shared: true }));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

vi.mock('../../src/detect/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/detect/index.ts')>();
  return {
    ...actual,
    detectProject: (root: string, tools?: Parameters<typeof actual.detectProject>[1], environment?: Parameters<typeof actual.detectProject>[2], options: DetectOptions = {}) => {
      state.calls.push({ root, projects: options.projects ?? [] });
      return deepFreeze(actual.detectProject(root, tools, environment, options));
    },
  };
});

vi.mock('../../src/detect/cache.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/detect/cache.ts')>();
  const { detectProject } = await import('../../src/detect/index.ts');
  class Switchable extends actual.Detections {
    override detect(...args: Parameters<InstanceType<typeof actual.Detections>['detect']>) {
      const [root, tools, options] = args;
      return state.shared ? super.detect(...args) : detectProject(root, tools, undefined, options);
    }
  }
  return { ...actual, Detections: Switchable };
});

const NOW = new Date('2026-11-02T18:00:00Z');
const temporary: string[] = [];
beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const never: FetchLike = async (url) => {
  throw new Error(`doctor asked ${url}`);
};

async function doctor(argv: string[], data: string | undefined): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(['doctor', ...argv], { stdout: (text) => (stdout += text), stderr: () => {} }, { fetch: never, now: () => NOW, stdin: async () => '', osvData: () => data });
  return { code, stdout };
}

function repository(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depcurfew-detect-once-')));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/** The calls of detectProject during `action`, as "directory projects", sorted. */
async function calls(root: string, action: () => Promise<unknown>): Promise<string[]> {
  state.calls = [];
  await action();
  return state.calls.map((call) => `${relative(root, call.root).split('\\').join('/') || '.'} ${JSON.stringify(call.projects)}`).sort();
}

const PACKAGE = '{"name": "app", "version": "1.0.0"}\n';

describe('doctor detects each directory once (decision D-157)', () => {
  it('without depcurfew.json: the root once without projects and once with those init would list, each project once', async () => {
    const root = repository({ 'a/package.json': PACKAGE, 'b/package.json': PACKAGE, 'c/pyproject.toml': '[project]\nname = "c"\n' });
    const data = await localData(temporary, NOW);
    for (const format of [[], ['--json'], ['--sarif']]) {
      expect(await calls(root, () => doctor([...format, root], data)), format.join(' ')).toEqual(['. ["a","b","c"]', '. []', 'a []', 'b []', 'c []']);
    }
    expect(await calls(root, () => doctor([root], undefined))).toEqual(['. ["a","b","c"]', '. []', 'a []', 'b []', 'c []']);
  });

  it('without depcurfew.json and without projects: the root once', async () => {
    const root = repository({ 'package.json': PACKAGE, 'docs/readme.txt': '' });
    const data = await localData(temporary, NOW);
    expect(await calls(root, () => doctor([root], data))).toEqual(['. []']);
  });

  it('with depcurfew.json and projects: the root once and each project once', async () => {
    const root = repository({ 'depcurfew.json': '{"version": 1, "cooldown": {"minimum": "3d"}, "projects": ["a", "b"]}\n', 'a/package.json': PACKAGE, 'b/package.json': PACKAGE });
    const data = await localData(temporary, NOW);
    expect(await calls(root, () => doctor(['--json', root], data))).toEqual(['. ["a","b"]', 'a []', 'b []']);
  });
});

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

function directories(path: string): string[] {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

/** Every repository of the fixtures of doctor, of its comparison with the default policy and of detection. */
const REPOSITORIES = [
  ...directories(join(FIXTURES, 'doctor')).flatMap((rule) => directories(join(FIXTURES, 'doctor', rule)).map((name) => join('doctor', rule, name, 'repo'))),
  ...directories(join(FIXTURES, 'doctor-default')).map((name) => join('doctor-default', name)),
  ...directories(join(FIXTURES, 'repos')).map((name) => join('repos', name)),
].filter((path) => existsSync(join(FIXTURES, path)));

describe('the report is the one of detecting each time (decision D-157)', () => {
  it('has the fixtures', () => {
    expect(REPOSITORIES.length).toBeGreaterThan(250);
  });

  it('for every fixture repository, with local OSV.dev data, in JSON and text', { timeout: 300_000 }, async () => {
    const data = await localData(temporary, NOW);
    const base = mkdtempSync(join(tmpdir(), 'depcurfew-detect-once-fixtures-'));
    temporary.push(base);
    for (const fixture of REPOSITORIES) {
      // A copy, so that the paths in the report are the same for both runs and nothing is written into the fixtures.
      const root = join(base, fixture.split(/[\\/]/u).join('_'));
      cpSync(join(FIXTURES, fixture), root, { recursive: true, verbatimSymlinks: true });
      for (const format of [['--json'], []]) {
        state.shared = false;
        const fresh = await doctor([...format, root], data);
        state.shared = true;
        const shared = await doctor([...format, root], data);
        expect(shared, `${fixture} ${format.join(' ')}`).toEqual(fresh);
      }
    }
  });
});
