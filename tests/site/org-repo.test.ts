// The files of the organization repository depcurfew/depcurfew.github.io (decisions D-139 and D-178), kept in
// site/org-repo/: its Pages workflow builds the site from the main branch of the main repository, named once in
// SOURCE_REPOSITORY, with every tag and npm run site -- --versions, once a day and by hand, and deploys it with the
// official Pages actions, with pages and id-token permissions only in the deploy job. This repository has no Pages
// workflow of its own.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { repositoryUrl } from '../../scripts/site/versions.ts';
import { files } from './pages.ts';
import { describe, expect, it } from 'vitest';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  needs?: string;
  'runs-on': string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  environment?: { name: string; url?: string };
  steps: Step[];
}

const ROOT = new URL('../../', import.meta.url);
const text = readFileSync(new URL('site/org-repo/.github/workflows/pages.yml', ROOT), 'utf8');
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};
const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { repository: unknown };
const source = workflow.env?.['SOURCE_REPOSITORY'] ?? '';
const build = workflow.jobs['build'] as Job;
const deploy = workflow.jobs['deploy'] as Job;
const action = (job: Job, name: string) => job.steps.find((step) => step.uses?.startsWith(`actions/${name}@`));
const index = (job: Job, predicate: (step: Step) => boolean) => job.steps.findIndex(predicate);

describe('Pages workflow of depcurfew/depcurfew.github.io', () => {
  it('runs once a day and by hand, never on a push or a pull request', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const schedule = workflow.on['schedule'] as { cron: string }[];
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.cron).toMatch(/^([1-9]|[1-5]\d) ([0-9]|1\d|2[0-3]) \* \* \*$/u);
  });

  it('gives the workflow no permissions, the build job contents read and the deploy job pages and id-token only', () => {
    expect(workflow.permissions).toEqual({});
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(deploy.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['build', 'deploy']);
  });

  it('names the main repository once, as the repository field of package.json does', () => {
    expect(Object.keys(workflow.env ?? {})).toEqual(['SOURCE_REPOSITORY']);
    expect(`https://github.com/${source}`).toBe(repositoryUrl(manifest.repository));
    expect(text.split('\n').filter((line) => line.includes(source))).toEqual([`  SOURCE_REPOSITORY: ${source}`]);
  });

  it('checks out the main branch of the main repository with every tag and no credentials, without a token or the GitHub API', () => {
    const checkout = index(build, (step) => step.uses?.startsWith('actions/checkout@') === true);
    expect(index(build, (step) => step.uses?.startsWith('actions/setup-node@') === true)).toBeLessThan(checkout);
    expect(build.steps[checkout]?.with).toEqual({ repository: '${{ env.SOURCE_REPOSITORY }}', ref: 'main', 'fetch-depth': 0, 'persist-credentials': false });
    expect(action(build, 'setup-node')?.with).toEqual({ 'node-version': 24, 'package-manager-cache': false });
    expect(text).not.toMatch(/github\.token|GITHUB_TOKEN|api\.github\.com/u);
    expect(build.steps.every((step) => step.env === undefined)).toBe(true);
  });

  it('installs the npm of packageManager, runs npm ci without scripts, builds the earlier versions too and uploads dist-site', () => {
    const runs = build.steps.map((step) => step.run ?? '');
    const npm = runs.findIndex((run) => run.includes('npm install -g "npm@$version"'));
    const checkout = index(build, (step) => step.uses?.startsWith('actions/checkout@') === true);
    expect(npm).toBeGreaterThan(checkout);
    expect(runs[npm]).toContain(`version="$(node -p 'require("./package.json").packageManager`);
    expect(runs.indexOf('npm ci --ignore-scripts')).toBeGreaterThan(npm);
    expect(runs.indexOf('npm run site -- --versions')).toBeGreaterThan(runs.indexOf('npm ci --ignore-scripts'));
    const upload = index(build, (step) => step.uses?.startsWith('actions/upload-pages-artifact@') === true);
    expect(upload).toBeGreaterThan(runs.indexOf('npm run site -- --versions'));
    expect(build.steps[upload]?.with).toEqual({ path: 'dist-site' });
    expect(build.steps.at(-1)).toBe(build.steps[upload]);
  });

  it('deploys the artifact to the github-pages environment', () => {
    expect(deploy.needs).toBe('build');
    expect(deploy.environment).toEqual({ name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' });
    expect(action(deploy, 'configure-pages')).toBeDefined();
    expect(action(deploy, 'deploy-pages')?.id).toBe('deployment');
    expect(deploy.steps.at(-1)).toBe(action(deploy, 'deploy-pages'));
    expect(deploy.steps).toHaveLength(2);
  });

  it('pins every action to the commit of its release, as the workflows of this repository do', () => {
    const uses = text.split('\n').filter((line) => /^\s*(-\s+)?uses:/u.test(line)).map((line) => line.replace(/^\s*(-\s+)?uses:\s*/u, ''));
    expect(uses.sort()).toEqual(
      [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
        'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0',
        'actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0',
        'actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1',
      ].sort(),
    );
  });

  it('lets one deployment finish before the next and limits how long every job may run', () => {
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false });
    for (const [id, job] of Object.entries(workflow.jobs)) expect(job['timeout-minutes'], id).toBeGreaterThan(0);
  });
});

describe('README of depcurfew/depcurfew.github.io', () => {
  const readme = readFileSync(new URL('site/org-repo/README.md', ROOT), 'utf8');

  it('says what the repository is, where its content comes from and how it updates', () => {
    expect(readme).toMatch(/^# depcurfew\.github\.io\n/u);
    expect(readme).toContain('It checks out the main branch of the main repository with every tag');
    expect(readme).toContain('every page of the root says so in a banner');
    for (const part of ['https://depcurfew.github.io/', `https://github.com/${source}`, 'SOURCE_REPOSITORY', 'npm run site -- --versions', '.github/workflows/pages.yml', 'site/org-repo/']) expect(readme, part).toContain(part);
  });
});

describe('this repository', () => {
  it('has no Pages workflow of its own, so the documentation has one copy', () => {
    expect(existsSync(new URL('.github/workflows/pages.yml', ROOT))).toBe(false);
  });

  it('keeps only the README and the workflow in site/org-repo/', () => {
    expect(files(fileURLToPath(new URL('site/org-repo/', ROOT)))).toEqual(['.github/workflows/pages.yml', 'README.md']);
  });
});
