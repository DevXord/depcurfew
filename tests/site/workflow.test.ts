// The Pages workflow (decision D-132) builds the site with npm run site and deploys it with the official Pages
// actions, only for a published release or by hand, with pages and id-token permissions only in the deploy job.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string;
  'runs-on': string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  environment?: { name: string; url?: string };
  steps: Step[];
}

const text = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const workflow = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; concurrency?: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, Job> };
const build = workflow.jobs['build'] as Job;
const deploy = workflow.jobs['deploy'] as Job;
const action = (job: Job, name: string) => job.steps.find((step) => step.uses?.startsWith(`actions/${name}@`));

describe('Pages workflow', () => {
  it('runs only for a published release and by hand, never on push or pull requests', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['release', 'workflow_dispatch']);
    expect(workflow.on['release']).toEqual({ types: ['published'] });
  });

  it('reads contents only, except the deploy job, which gets pages and id-token and nothing else', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(deploy.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'deploy']);
  });

  it('builds with the npm of packageManager, without credentials or a package cache', () => {
    const pinned = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { packageManager: string }).packageManager.replace(/^npm@/u, '');
    const runs = build.steps.map((step) => step.run ?? '');
    expect(runs.indexOf(`npm install -g npm@${pinned}`)).toBeGreaterThan(-1);
    expect(runs.indexOf(`npm install -g npm@${pinned}`)).toBeLessThan(runs.indexOf('npm ci'));
    expect(runs.indexOf('npm ci')).toBeLessThan(runs.indexOf('npm run site'));
    expect(action(build, 'checkout')?.with).toMatchObject({ 'persist-credentials': false });
    expect(action(build, 'setup-node')?.with).toMatchObject({ 'package-manager-cache': false, 'node-version': 24 });
  });

  it('uploads the output folder of npm run site and deploys it to the github-pages environment', () => {
    const upload = build.steps.findIndex((step) => step.uses?.startsWith('actions/upload-pages-artifact@'));
    expect(upload).toBeGreaterThan(build.steps.findIndex((step) => step.run === 'npm run site'));
    expect(build.steps[upload]?.with).toEqual({ path: 'dist-site' });
    expect(deploy.needs).toBe('build');
    expect(deploy.environment).toEqual({ name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' });
    expect(action(deploy, 'configure-pages')).toBeDefined();
    expect(action(deploy, 'deploy-pages')?.id).toBe('deployment');
    expect(deploy.steps.at(-1)).toBe(action(deploy, 'deploy-pages'));
  });

  it('pins the Pages actions to the commits of their releases', () => {
    expect(text).toContain('actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0');
    expect(text).toContain('actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0');
    expect(text).toContain('actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1');
  });

  it('lets one deployment finish before the next and limits how long every job may run', () => {
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false });
    for (const [id, job] of Object.entries(workflow.jobs)) expect(job['timeout-minutes'], id).toBeGreaterThan(0);
  });
});
