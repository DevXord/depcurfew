// The release workflow publishes only through trusted publishing and staging: no npm token, the narrowest
// permissions, stable version tags, and every check before staging.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const workflow = parse(text) as {
  on: { push: { tags: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, { permissions: Record<string, string>; 'timeout-minutes'?: number; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }>;
};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runs = steps.map((step) => step.run ?? '').join('\n');

describe('release workflow', () => {
  it('runs on stable version tags only', () => {
    expect(workflow.on.push.tags).toEqual(['v[0-9]+.[0-9]+.[0-9]+']);
  });

  it('has no permissions by default and only contents: read and id-token: write in its job', () => {
    expect(workflow.permissions).toEqual({});
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('uses no secrets or npm token', () => {
    expect(text).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/u);
  });

  it('stages with provenance instead of publishing directly', () => {
    expect(runs).toContain('npm stage publish --provenance');
    expect(runs).not.toMatch(/npm publish/u);
  });

  it('stages only a tag on a commit of main, and has a time limit', () => {
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toMatchObject({ 'fetch-depth': 0 });
    expect(runs.indexOf('git merge-base --is-ancestor HEAD origin/main')).toBeGreaterThan(-1);
    expect(runs.indexOf('git merge-base --is-ancestor HEAD origin/main')).toBeLessThan(runs.indexOf('npm stage publish'));
    for (const job of Object.values(workflow.jobs)) expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('checks everything before staging', () => {
    const order = ['npm ci', 'npm test', 'npm run typecheck', 'npm run check:pkg', 'npm run build:action', 'node dist/cli.js doctor .', 'npm stage publish'];
    const positions = order.map((command) => runs.indexOf(command));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('disables the package manager cache and keeps no credentials in the checkout', () => {
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with).toMatchObject({ 'package-manager-cache': false, 'node-version': 24 });
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toMatchObject({ 'persist-credentials': false });
  });
});
