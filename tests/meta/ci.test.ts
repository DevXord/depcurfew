// CI runs the tests on Linux and Windows with every supported Node.js line, runs the tests that need root as root
// (decision D-199), and no job of the CI and action test workflows can hang for the six hours GitHub allows by default.
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);
const WORKFLOWS = new URL('.github/workflows/', ROOT);

interface Step {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on': string;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown[]> };
  defaults?: { run?: { shell?: string } };
  env?: Record<string, string>;
  steps: Step[];
}

const read = (name: string) => parse(readFileSync(new URL(name, WORKFLOWS), 'utf8')) as { jobs: Record<string, Job> };

describe('CI workflow', () => {
  const test = read('ci.yml').jobs['test'] as Job;

  it('tests on Linux and Windows with Node.js 22, 24 and 26, and lets every combination finish', () => {
    expect(test['runs-on']).toBe('${{ matrix.os }}');
    expect(test.strategy?.matrix).toEqual({ os: ['ubuntu-latest', 'windows-latest'], node: [22, 24, 26] });
    expect(test.strategy?.['fail-fast']).toBe(false);
    expect(test.defaults?.run?.shell).toBe('bash');
    expect(test.steps.find((step) => step.run === 'npm test')?.if).toBeUndefined();
  });

  it('runs the checks that do not depend on the system on Linux only', () => {
    for (const command of ['npm run typecheck', 'npm run check:pkg', 'npm run build:action']) {
      expect(test.steps.find((step) => step.run?.includes(command))?.if, command).toBe("runner.os == 'Linux'");
    }
  });
});

describe('runtime smoke test job', () => {
  const runtime = read('ci.yml').jobs['runtime'] as Job & { strategy: { matrix: { node: string[] } } };

  it('builds once, then runs the smoke test of the built CLI on each Node.js version', () => {
    expect(runtime.strategy['fail-fast']).toBe(false);
    expect(runtime.strategy.matrix.node.length).toBeGreaterThan(0);
    const runs = runtime.steps.map((step) => step.run).filter((run) => run !== undefined);
    expect(runs.slice(-3)).toEqual(['npm ci', 'npm run build', 'node tests/runtime/smoke.mjs']);
  });

  it('runs on the oldest Node.js that engines in package.json allows (decision D-103)', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { engines: { node: string } };
    const oldest = /^>=(\d+\.\d+\.\d+)$/u.exec(pkg.engines.node)?.[1];
    expect(oldest).toBeDefined();
    expect(runtime.strategy.matrix.node).toContain(oldest);
  });
});

/** The test files, with / as separator, without the fixtures (which are repositories, not tests). */
function testFiles(): string[] {
  return readdirSync(new URL('tests/', ROOT), { recursive: true, encoding: 'utf8' })
    .map((path) => `tests/${path.split(sep).join('/')}`)
    .filter((path) => /\.(?:ts|mts|js|mjs)$/u.test(path) && !path.startsWith('tests/fixtures/'));
}

const source = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
/** A test file that takes asRoot, the gate of the tests that need root, from tests/support/platform.ts. */
const IMPORTS_AS_ROOT = /\bimport\s*\{[^}]*\basRoot\b[^}]*\}\s*from\s*'(?:\.\.\/)+support\/platform\.ts'/u;
/** A comparison of the user id with 0: a root gate of its own, which the root job would not know about. */
const COMPARES_UID_WITH_ZERO = /getuid\??\.?\(\)\s*[!=]={1,2}\s*0\b|\b0\s*[!=]={1,2}\s*process\.getuid/u;

describe('root-only tests job (decision D-199)', () => {
  const root = read('ci.yml').jobs['root'] as Job;
  const listed = (root.env?.['ROOT_TESTS'] ?? '').split(/\s+/u).filter((path) => path !== '');
  const runs = root.steps.map((step) => step.run ?? '');

  it('runs on Linux with Node.js 24, from a checkout without credentials, and has a time limit', () => {
    expect(root['runs-on']).toBe('ubuntu-latest');
    expect(root['timeout-minutes']).toBeGreaterThan(0);
    expect(root.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toEqual({ 'persist-credentials': false });
    expect(root.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with).toEqual({ 'node-version': 24, 'package-manager-cache': false });
  });

  it('lists every test file that imports asRoot, and no other', () => {
    const gated = testFiles().filter((path) => !path.startsWith('tests/support/') && IMPORTS_AS_ROOT.test(source(path)));
    expect(gated.length).toBeGreaterThan(0);
    expect(listed).toEqual([...gated].sort());
  });

  it('is the only root gate: no test file outside tests/support compares the user id with 0', () => {
    const own = 'tests/meta/ci.test.ts';
    expect(testFiles().filter((path) => !path.startsWith('tests/support/') && path !== own && COMPARES_UID_WITH_ZERO.test(source(path)))).toEqual([]);
    expect(source('tests/support/platform.ts')).toMatch(/export const asRoot = /u);
  });

  it('runs those files with sudo, through the absolute path of node and with the JSON reporter of Vitest', () => {
    const tests = runs.findIndex((run) => run.includes('sudo "$(command -v node)" node_modules/vitest/vitest.mjs run $ROOT_TESTS '));
    expect(tests).toBeGreaterThan(runs.indexOf('npm ci'));
    expect(runs[tests]).toContain('test "$(sudo id -u)" = 0');
    expect(runs[tests]).toContain('--reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/root-tests.json"');
  });

  it('fails when a listed file ran no test or a test was skipped, left as a todo or failed, and runs nothing after that', () => {
    const check = runs.indexOf('node tests/support/root-report.ts "$RUNNER_TEMP/root-tests.json" $ROOT_TESTS');
    expect(check).toBeGreaterThan(runs.findIndex((run) => run.includes('node_modules/vitest/vitest.mjs')));
    // The tests leave files of root in the checkout (the cache of Vitest), so no step of the runner user follows.
    expect(check).toBe(root.steps.length - 1);
  });
});

describe('npm in CI', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { packageManager: string };
  const pinned = manifest.packageManager.replace(/^npm@/u, '');

  // Node.js 22 comes with npm 10, which ignores the settings of .npmrc it does not know (decision D-099).
  it.each([
    ['ci.yml', 'test'],
    ['ci.yml', 'runtime'],
    ['ci.yml', 'root'],
    ['release.yml', 'build'],
    ['release.yml', 'rebuild'],
  ])('%s installs the npm of packageManager before npm ci in the job %s', (name, id) => {
    const steps = (read(name).jobs[id] as Job).steps.map((step) => step.run ?? '');
    const upgrade = steps.indexOf(`npm install -g npm@${pinned}`);
    expect(upgrade, name).toBeGreaterThan(-1);
    expect(upgrade).toBeLessThan(steps.indexOf('npm ci'));
  });
});

describe('workflows that run on every push', () => {
  it.each(['ci.yml', 'action-test.yml'])('%s limits how long every job may run', (name) => {
    for (const [id, job] of Object.entries(read(name).jobs)) expect(job['timeout-minutes'], `${name}: ${id}`).toBeGreaterThan(0);
  });
});
