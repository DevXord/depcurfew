// The files of the organization repository depcurfew/depcurfew.github.io (decision D-139), kept in site/org-repo/:
// its Pages workflow builds the site of the latest release of the main repository, named once in SOURCE_REPOSITORY,
// with npm run site -- --versions, once a day and by hand, and deploys it with the official Pages actions, with pages
// and id-token permissions only in the deploy job. This repository has no Pages workflow of its own.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { parse } from 'yaml';
import { repositoryUrl } from '../../scripts/site/versions.ts';
import { files } from './pages.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

  it('finds the latest release with the workflow token, then checks out the main repository at its tag with every tag and no credentials', () => {
    const find = index(build, (step) => step.id === 'release');
    const checkout = index(build, (step) => step.uses?.startsWith('actions/checkout@') === true);
    expect(index(build, (step) => step.uses?.startsWith('actions/setup-node@') === true)).toBeLessThan(find);
    expect(find).toBeGreaterThan(-1);
    expect(build.steps[find]?.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' });
    expect(checkout).toBeGreaterThan(find);
    expect(build.steps[checkout]?.with).toEqual({ repository: '${{ env.SOURCE_REPOSITORY }}', ref: '${{ steps.release.outputs.tag }}', 'fetch-depth': 0, 'persist-credentials': false });
    expect(action(build, 'setup-node')?.with).toEqual({ 'node-version': 24, 'package-manager-cache': false });
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

describe('finding the latest release', () => {
  // The script of the step, run by Node.js with fetch replaced by recorded answers of the GitHub API.
  const script = /node -e '([\s\S]*?)'\s*$/u.exec(build.steps.find((step) => step.id === 'release')?.run ?? '')?.[1] ?? '';
  let directory = '';
  let stub = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'depcurfew-org-release-'));
    stub = join(directory, 'stub.mjs');
    writeFileSync(
      stub,
      [
        "import { writeFileSync } from 'node:fs';",
        'globalThis.fetch = async (url, init) => {',
        '  writeFileSync(process.env.STUB_REQUEST, JSON.stringify({ url: String(url), headers: init?.headers ?? {} }));',
        '  const status = Number(process.env.STUB_STATUS);',
        '  return { ok: status === 200, status, url: String(url), json: async () => JSON.parse(process.env.STUB_RELEASES) };',
        '};',
        '',
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
  });

  type Release = { tag_name: string; draft?: boolean; prerelease?: boolean };
  const release = (tag_name: string, extra: Partial<Release> = {}): Release => ({ tag_name, draft: false, prerelease: false, ...extra });

  function run(releases: Release[], status = 200) {
    const output = join(directory, 'output');
    const request = join(directory, 'request.json');
    rmSync(output, { force: true });
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, '-e', script], {
      encoding: 'utf8',
      // SystemRoot, which Node.js needs on Windows, and nothing else of the environment of the tests.
      env: { PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }), SOURCE_REPOSITORY: source, GITHUB_TOKEN: 'token-of-the-test', GITHUB_OUTPUT: output, STUB_REQUEST: request, STUB_STATUS: String(status), STUB_RELEASES: JSON.stringify(releases) },
    });
    return { status: result.status, stderr: result.stderr, output: readFileSync(output, 'utf8'), request: existsSync(request) ? (JSON.parse(readFileSync(request, 'utf8')) as { url: string; headers: Record<string, string> }) : undefined };
  }

  it('is a script of the step', () => {
    expect(script).toContain('fetch(');
    // The script is what the shell passes to Node.js: it parses as it is.
    expect(() => new Script(script)).not.toThrow();
  });

  it('asks the GitHub API for the releases of the main repository with the workflow token', () => {
    const result = run([release('v1.4.0')]);
    expect(result.request?.url).toBe(`https://api.github.com/repos/${source}/releases?per_page=100`);
    expect(result.request?.headers).toEqual({ accept: 'application/vnd.github+json', authorization: 'Bearer token-of-the-test' });
    expect(result.output).toBe('tag=v1.4.0\n');
  });

  it('takes the highest version among the published full releases, never a draft, a pre-release or another tag', () => {
    const result = run([
      release('v1.3.0'),
      release('v1.10.0'),
      release('v1.9.0'),
      release('v2.0.0', { draft: true }),
      release('v2.0.0-rc.1', { prerelease: true }),
      release('nightly'),
      release('v3.0.0\ntag=v0.0.1'),
    ]);
    expect(result.status).toBe(0);
    expect(result.output).toBe('tag=v1.10.0\n');
  });

  it('takes the highest pre-release when there is no full release', () => {
    const result = run([release('v1.0.0-rc.2', { prerelease: true }), release('v1.0.0-rc.10', { prerelease: true }), release('v1.0.0-beta.3', { prerelease: true }), release('v1.0.0', { draft: true })]);
    expect(result.status).toBe(0);
    expect(result.output).toBe('tag=v1.0.0-rc.10\n');
  });

  it('fails with an error annotation when there is no release or the API answers with an error', () => {
    for (const result of [run([release('v1.0.0', { draft: true })]), run([], 403)]) {
      expect(result.status).toBe(1);
      expect(result.output).toBe('');
      expect(result.stderr).toMatch(/^::error::/mu);
    }
    expect(run([], 403).stderr).toContain('HTTP 403');
  });
});

describe('README of depcurfew/depcurfew.github.io', () => {
  const readme = readFileSync(new URL('site/org-repo/README.md', ROOT), 'utf8');

  it('says what the repository is, where its content comes from and how it updates', () => {
    expect(readme).toMatch(/^# depcurfew\.github\.io\n/u);
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
