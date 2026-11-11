// The release workflow publishes only through trusted publishing and staging: no npm token, the narrowest
// permissions, stable version tags, and every check before staging. One job builds, checks and packs without the
// right to an OIDC token; the other runs no code of the repository and stages the very file the first one packed
// (decision D-175). Before anything is staged, CHANGELOG.md has to start with the section of the version, CI has to
// have passed on the tagged commit, and a fresh build of the tag on another runner has to give the same file
// (decision D-199).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string | number>;
}

interface Job {
  needs?: string | string[];
  permissions: Record<string, string>;
  'timeout-minutes'?: number;
  outputs?: Record<string, string>;
  steps: Step[];
}

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const text = readFileSync(new URL('release.yml', WORKFLOWS), 'utf8');
const workflow = parse(text) as { on: { push: { tags: string[] } }; permissions: Record<string, string>; jobs: Record<string, Job> };
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { packageManager: string };
const pinned = manifest.packageManager.replace(/^npm@/u, '');
const build = workflow.jobs['build'] as Job;
const rebuild = workflow.jobs['rebuild'] as Job;
const ciPassed = workflow.jobs['ci-passed'] as Job;
const stage = workflow.jobs['stage'] as Job;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runsOf = (job: Job) => job.steps.map((step) => step.run ?? '').join('\n');
const action = (job: Job, name: string) => job.steps.find((step) => step.uses?.startsWith(`${name}@`));
const actionIndex = (job: Job, name: string) => job.steps.findIndex((step) => step.uses?.startsWith(`${name}@`));
const needsOf = (job: Job) => [job.needs ?? []].flat();

describe('release workflow', () => {
  it('runs on stable version tags only', () => {
    expect(workflow.on.push.tags).toEqual(['v[0-9]+.[0-9]+.[0-9]+']);
  });

  it('has a build job, a rebuild job after it, a job that waits for CI, and a stage job after all three', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'rebuild', 'ci-passed', 'stage']);
    expect(needsOf(build)).toEqual([]);
    expect(needsOf(rebuild)).toEqual(['build']);
    expect(needsOf(ciPassed)).toEqual([]);
    expect(needsOf(stage).sort()).toEqual(['build', 'ci-passed', 'rebuild']);
  });

  it('has no permissions by default, only the stage job may ask for an OIDC token, and only ci-passed may read workflow runs', () => {
    expect(workflow.permissions).toEqual({});
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(rebuild.permissions).toEqual({ contents: 'read' });
    expect(ciPassed.permissions).toEqual({ actions: 'read' });
    expect(stage.permissions).toEqual({ 'id-token': 'write' });
  });

  it('uses no secrets or npm token', () => {
    expect(text).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/u);
  });

  it('stages the packed file with provenance instead of publishing directly', () => {
    expect(runsOf(stage)).toContain('npm stage publish "./$TARBALL" --provenance');
    for (const job of [build, rebuild, ciPassed]) expect(runsOf(job)).not.toContain('npm stage publish');
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

  it('checks before npm ci that CHANGELOG.md starts with the section of the tag (decision D-199)', () => {
    const runs = build.steps.map((step) => step.run ?? '');
    const changelog = runs.findIndex((run) => run.includes("grep -n -m 1 '^## ' CHANGELOG.md"));
    expect(changelog).toBeGreaterThan(-1);
    expect(changelog).toBeLessThan(runs.indexOf('npm ci'));
    expect(build.steps[changelog]?.env).toEqual({ TAG: '${{ github.ref_name }}' });
    expect(runs[changelog]).toContain('"## ${TAG#v}"');
    expect(runs[changelog]).toContain('::error file=CHANGELOG.md');
  });

  it('installs the npm of packageManager in every job that uses npm, before it does', () => {
    for (const [job, first] of [[build, 'npm ci'], [rebuild, 'npm ci'], [stage, 'npm stage publish']] as const) {
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
    expect(build.outputs).toEqual({ tarball: '${{ steps.pack.outputs.tarball }}', integrity: '${{ steps.pack.outputs.integrity }}', shasum: '${{ steps.pack.outputs.shasum }}' });
    expect(action(stage, 'actions/download-artifact')?.with).toMatchObject({ name: '${{ needs.build.outputs.tarball }}', 'digest-mismatch': 'error' });
    const check = stage.steps.findIndex((step) => step.env?.['INTEGRITY'] === '${{ needs.build.outputs.integrity }}');
    expect(stage.steps[check]?.run).toContain('createHash("sha512")');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(stage.steps.findIndex((step) => step.run?.includes('npm stage publish')));
  });

  it('stages only the file that the fresh build of the rebuild job gave too (decision D-199)', () => {
    expect(rebuild.outputs).toEqual({ integrity: '${{ steps.pack.outputs.integrity }}' });
    const check = stage.steps.find((step) => step.env?.['INTEGRITY'] === '${{ needs.build.outputs.integrity }}');
    expect(check?.env?.['REBUILT']).toBe('${{ needs.rebuild.outputs.integrity }}');
    expect(check?.run).toContain('[ "$REBUILT" != "$INTEGRITY" ]');
  });

  it('gives the approver the file name, shasum and integrity of the staged file (decision D-199)', () => {
    const publish = stage.steps.findIndex((step) => step.run?.includes('npm stage publish'));
    const summary = stage.steps.findIndex((step) => step.run?.includes('"$GITHUB_STEP_SUMMARY"'));
    expect(summary).toBeGreaterThan(publish);
    expect(stage.steps[summary]?.env).toEqual({
      TARBALL: '${{ needs.build.outputs.tarball }}',
      SHASUM: '${{ needs.build.outputs.shasum }}',
      INTEGRITY: '${{ needs.build.outputs.integrity }}',
    });
    for (const shown of ['$TARBALL', '$SHASUM', '$INTEGRITY', 'npm stage view', 'npm stage download', 'npm stage reject']) expect(stage.steps[summary]?.run).toContain(shown);
  });

  it('uses only outputs that the jobs and steps it names set', () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const json = JSON.stringify(job);
      for (const [, other = '', name = ''] of json.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/gu)) {
        expect(needsOf(job), `${id}: needs.${other}`).toContain(other);
        expect(Object.keys(workflow.jobs[other]?.outputs ?? {}), `${id}: needs.${other}.outputs.${name}`).toContain(name);
      }
      for (const [, step = '', name = ''] of json.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/gu)) {
        const source = job.steps.find((candidate) => candidate.id === step)?.run ?? '';
        expect(source, `${id}: steps.${step}.outputs.${name}`).toMatch(new RegExp(`echo "${name}=.*" >> "\\$GITHUB_OUTPUT"`, 'u'));
      }
    }
  });

  it('disables the package manager cache and keeps no credentials in the checkouts', () => {
    const setups = steps.filter((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setups).toHaveLength(3);
    for (const setup of setups) expect(setup.with).toMatchObject({ 'package-manager-cache': false, 'node-version': 24 });
    expect(action(stage, 'actions/setup-node')?.with).toMatchObject({ 'registry-url': 'https://registry.npmjs.org' });
    for (const job of [build, rebuild]) expect(action(job, 'actions/checkout')?.with).toMatchObject({ 'persist-credentials': false });
  });
});

describe('the ci-passed job (decision D-199)', () => {
  const step = ciPassed.steps[0];

  it('runs no action and no code of the repository, only gh with the token of the run', () => {
    expect(ciPassed.steps).toHaveLength(1);
    expect(step?.uses).toBeUndefined();
    expect(step?.env?.['GH_TOKEN']).toBe('${{ github.token }}');
    expect(step?.run).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b|\.\//u);
  });

  it('waits for ci.yml and action-test.yml, which run on pushes to main and can be run by hand, on the tagged commit', () => {
    expect(step?.run).toContain('for workflow in ci.yml action-test.yml; do');
    for (const name of ['ci.yml', 'action-test.yml']) {
      const on = (parse(readFileSync(new URL(name, WORKFLOWS), 'utf8')) as { on: Record<string, { branches?: string[] } | null> }).on;
      expect(on, name).toHaveProperty('workflow_dispatch');
      expect(on, name).toHaveProperty('push');
      expect(on['push']?.branches ?? ['main'], name).toContain('main');
    }
    expect(step?.run).toContain('gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow/runs" -f head_sha="$GITHUB_SHA"');
    // Runs of pull requests test a merge with the base branch, not the commit itself.
    expect(step?.env?.['VERDICT']).toContain('select(.event == "push" or .event == "workflow_dispatch")');
  });

  it('gives up with an error before the time limit of the job ends', () => {
    const limit = Number(step?.env?.['LIMIT']);
    expect(limit).toBeGreaterThan(0);
    expect(limit / 60).toBeLessThan(ciPassed['timeout-minutes'] ?? 0);
    expect(Number(step?.env?.['INTERVAL'])).toBeGreaterThan(0);
  });
});

describe('the rebuild job (decision D-199)', () => {
  const verify = (parse(readFileSync(new URL('verify-release.yml', WORKFLOWS), 'utf8')) as { jobs: { verify: Job } }).jobs.verify;
  /** The commands from installing npm to the build, which have to be those of the Verify release workflow. */
  const recipe = (job: Job) => {
    const runs = job.steps.map((step) => step.run ?? '');
    return runs.slice(runs.findIndex((run) => run.startsWith('npm install -g npm@')), runs.indexOf('npm run build') + 1);
  };

  it('builds the tag again from a fresh checkout, with the commands of the Verify release workflow', () => {
    expect(recipe(rebuild)).toEqual([`npm install -g npm@${pinned}`, 'npm ci', 'npm run build']);
    expect(recipe(rebuild)).toEqual(recipe(verify));
    expect(action(rebuild, 'actions/checkout')?.with).toEqual({ 'persist-credentials': false });
    expect(action(rebuild, 'actions/setup-node')?.with).toEqual({ 'node-version': 24, 'package-manager-cache': false });
  });

  it('packs the fresh build, and when it differs downloads the file of the build job and names the files that differ', () => {
    const pack = rebuild.steps.findIndex((step) => step.id === 'pack');
    expect(rebuild.steps[pack]?.run).toContain('npm pack --json --pack-destination "$RUNNER_TEMP/rebuilt"');
    expect(rebuild.steps[pack]?.env).toMatchObject({ TARBALL: '${{ needs.build.outputs.tarball }}', INTEGRITY: '${{ needs.build.outputs.integrity }}' });
    const download = actionIndex(rebuild, 'actions/download-artifact');
    expect(rebuild.steps[download]?.if).toBe("steps.pack.outputs.same != 'true'");
    expect(rebuild.steps[download]?.with).toMatchObject({ name: '${{ needs.build.outputs.tarball }}', 'digest-mismatch': 'error' });
    const compare = rebuild.steps.findIndex((step) => step.run?.includes('diff -rq'));
    expect(compare).toBe(rebuild.steps.length - 1);
    expect([pack, download, compare]).toEqual([pack, pack + 1, pack + 2]);
    expect(rebuild.steps[compare]?.run).toContain('::error::');
  });
});
