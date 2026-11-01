// CI runs the tests on Linux and Windows with every supported Node.js line, and no job of the CI and action test
// workflows can hang for the six hours GitHub allows by default.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);

interface Job {
  'runs-on': string;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown[]> };
  defaults?: { run?: { shell?: string } };
  steps: { run?: string; if?: string }[];
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
    expect(runs).toEqual(['npm ci', 'npm run build', 'node tests/runtime/smoke.mjs']);
  });
});

describe('workflows that run on every push', () => {
  it.each(['ci.yml', 'action-test.yml'])('%s limits how long every job may run', (name) => {
    for (const [id, job] of Object.entries(read(name).jobs)) expect(job['timeout-minutes'], `${name}: ${id}`).toBeGreaterThan(0);
  });
});
