// The release workflow publishes only through trusted publishing and staging: no npm token, the narrowest
// permissions, stable version tags, and every check before staging. One job builds, checks and packs without the
// right to an OIDC token; the other runs no code of the repository and stages the very file the first one packed
// (decision D-175).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  needs?: string | string[];
  permissions: Record<string, string>;
  'timeout-minutes'?: number;
  outputs?: Record<string, string>;
  steps: Step[];
}

const text = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const workflow = parse(text) as { on: { push: { tags: string[] } }; permissions: Record<string, string>; jobs: Record<string, Job> };
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { packageManager: string };
const pinned = manifest.packageManager.replace(/^npm@/u, '');
const build = workflow.jobs['build'] as Job;
const stage = workflow.jobs['stage'] as Job;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runsOf = (job: Job) => job.steps.map((step) => step.run ?? '').join('\n');
const action = (job: Job, name: string) => job.steps.find((step) => step.uses?.startsWith(`${name}@`));

describe('release workflow', () => {
  it('runs on stable version tags only', () => {
    expect(workflow.on.push.tags).toEqual(['v[0-9]+.[0-9]+.[0-9]+']);
  });

  it('has a build job and a stage job that runs after it', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'stage']);
    expect(stage.needs).toBe('build');
  });

  it('has no permissions by default, and only the stage job may ask for an OIDC token', () => {
    expect(workflow.permissions).toEqual({});
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(stage.permissions).toEqual({ 'id-token': 'write' });
  });

  it('uses no secrets or npm token', () => {
    expect(text).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/u);
  });

  it('stages the packed file with provenance instead of publishing directly', () => {
    expect(runsOf(stage)).toContain('npm stage publish "./$TARBALL" --provenance');
    expect(runsOf(build)).not.toContain('npm stage publish');
    expect(text).not.toMatch(/npm publish/u);
  });

  it('stages only a tag on a commit of main, and has a time limit', () => {
    expect(action(build, 'actions/checkout')?.with).toMatchObject({ 'fetch-depth': 0 });
    expect(runsOf(build)).toContain('git merge-base --is-ancestor HEAD origin/main');
    for (const job of Object.values(workflow.jobs)) expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('checks everything before it packs the package', () => {
    const runs = runsOf(build);
    const order = ['npm ci', 'npm test', 'npm run typecheck', 'npm run check:pkg', 'npm run build:action', 'node dist/cli.js doctor .', 'npm pack --json'];
    const positions = order.map((command) => runs.indexOf(command));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('installs the npm of packageManager in both jobs before it uses npm', () => {
    for (const [job, first] of [[build, 'npm ci'], [stage, 'npm stage publish']] as const) {
      const runs = job.steps.map((step) => step.run ?? '');
      const upgrade = runs.indexOf(`npm install -g npm@${pinned}`);
      expect(upgrade).toBeGreaterThan(-1);
      expect(upgrade).toBeLessThan(runs.findIndex((run) => run.includes(first)));
    }
  });

  it('runs no code of the repository in the stage job', () => {
    expect(stage.steps.map((step) => step.uses?.replace(/@.*/u, '')).filter((uses) => uses !== undefined)).toEqual(['actions/setup-node', 'actions/download-artifact']);
    expect(runsOf(stage)).not.toMatch(/npm (ci|install(?! -g npm@)|test|run|pack|exec)\b|npx |node dist\/|\.\/node_modules/u);
  });

  it('hands over one file, unarchived, with its SHA-512 checked before staging', () => {
    expect(action(build, 'actions/upload-artifact')?.with).toMatchObject({ archive: false, 'if-no-files-found': 'error' });
    expect(build.outputs).toEqual({ tarball: '${{ steps.pack.outputs.tarball }}', integrity: '${{ steps.pack.outputs.integrity }}' });
    expect(action(stage, 'actions/download-artifact')?.with).toMatchObject({ name: '${{ needs.build.outputs.tarball }}', 'digest-mismatch': 'error' });
    const check = stage.steps.findIndex((step) => step.env?.['INTEGRITY'] === '${{ needs.build.outputs.integrity }}');
    expect(stage.steps[check]?.run).toContain('createHash("sha512")');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(stage.steps.findIndex((step) => step.run?.includes('npm stage publish')));
  });

  it('disables the package manager cache and keeps no credentials in the checkout', () => {
    const setups = steps.filter((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setups).toHaveLength(2);
    for (const setup of setups) expect(setup.with).toMatchObject({ 'package-manager-cache': false, 'node-version': 24 });
    expect(action(stage, 'actions/setup-node')?.with).toMatchObject({ 'registry-url': 'https://registry.npmjs.org' });
    expect(action(build, 'actions/checkout')?.with).toMatchObject({ 'persist-credentials': false });
  });
});
