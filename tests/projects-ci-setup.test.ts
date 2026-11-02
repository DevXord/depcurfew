// A package manager that only a CI setup step of the root shows, in a repository whose depcurfew.json lists projects
// (decision D-137). When the root holds no manifest of the manager's registry, or every install with it in the root's
// workflows runs in a listed directory, the step sets it up for the projects: it is no package manager of the root, so
// apply writes nothing for it there, doctor neither lists it nor compares the bots with it, and explain shows it apart.
// tests/fixtures/repos/projects-ci-setup (the root holds only .github) and projects-ci-setup-root-npm (the root is an npm
// project) are the repositories of the report; their plans are checked with the other fixtures.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { planRepository } from '../src/apply/index.ts';
import { EXIT_OK, run } from '../src/cli/run.ts';
import { detectProject } from '../src/detect/index.ts';
import { renderText, RULES, runDoctor } from '../src/doctor/index.ts';
import { parsePolicy } from '../src/policy/validate.ts';
import type { ResolvedPolicy } from '../src/policy/schema.ts';

const REPOS = fileURLToPath(new URL('fixtures/repos/', import.meta.url));
const EXPECTED = fileURLToPath(new URL('fixtures/expected/', import.meta.url));

async function exec(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-projects-ci-'));
  directories.push(directory);
  return directory;
}

/** A copy of a fixture repository with its policy, and `changes` written over it. */
function fixture(name: string, changes: Record<string, string> = {}): string {
  const directory = temporary();
  cpSync(join(REPOS, name), directory, { recursive: true });
  writeFileSync(join(directory, 'depcurfew.json'), readFileSync(join(EXPECTED, name, 'depcurfew.json'), 'utf8'));
  write(directory, changes);
  return directory;
}

function write(directory: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
}

function repository(files: Record<string, string>): string {
  const directory = temporary();
  write(directory, files);
  return directory;
}

function policyOf(directory: string): ResolvedPolicy {
  const result = parsePolicy(readFileSync(join(directory, 'depcurfew.json'), 'utf8'));
  if (!result.ok) throw new Error('invalid policy');
  return result.policy;
}

const WORKFLOW = (run: string, setup = '      - uses: pnpm/action-setup@v4\n') =>
  `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${setup}${run}`;

const tools = (directory: string) => (runDoctor(directory).checked?.tools ?? []).map(({ id, project }) => (project === undefined ? id : `${id} in ${project}`));

describe('a package manager the root CI sets up for the listed projects', () => {
  it('is no tool of the root for doctor, which compares the bots with the projects only', async () => {
    const directory = fixture('projects-ci-setup');
    const report = runDoctor(directory);
    expect(renderText(report, RULES)).toContain('  Tools: Dependabot, npm in web, pnpm 10.28.0 (app/package.json) in app\n');
    expect(report.findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch')).toEqual([]);
    // After apply nothing is left, also when warnings fail doctor.
    const policy = JSON.parse(readFileSync(join(directory, 'depcurfew.json'), 'utf8')) as object;
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ ...policy, doctor: { failOn: 'warning' } }));
    expect((await exec('apply', directory)).code).toBe(EXIT_OK);
    const doctor = await exec('doctor', directory);
    expect(doctor.stdout).toMatch(/^No problems found\./u);
    expect(doctor.code).toBe(EXIT_OK);
  });

  it('is shown by explain apart from the package managers of the root, and apply configures nothing for it there', async () => {
    const directory = fixture('projects-ci-setup');
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as {
      project: { packageManagers: unknown[]; ciForProjects?: unknown[] };
      policy: { targets: { tools: string[] } };
    };
    expect(document.project.packageManagers).toEqual([]);
    expect(document.project.ciForProjects).toEqual([{ id: 'pnpm', supported: true, evidence: [{ kind: 'ci', file: '.github/workflows/ci.yml' }], versions: [], configFiles: [] }]);
    expect(document.policy.targets.tools).toEqual(['dependabot']);
    const text = (await exec('explain', directory)).stdout;
    expect(text).toMatch(/^Package managers: none\nPackage managers set up in CI for projects:\n {2}pnpm\n {4}evidence: \.github\/workflows\/ci\.yml \(ci\)\nNode\.js versions: none declared\n/u);
    expect(planRepository(directory, policyOf(directory)).changes.map((change) => change.file)).toEqual(['web/.npmrc']);
  });

  it('gets no files at a root that is an npm project, and doctor and explain agree', async () => {
    const directory = fixture('projects-ci-setup-root-npm');
    expect(planRepository(directory, policyOf(directory)).changes.map((change) => change.file)).toEqual(['.npmrc', 'web/.npmrc']);
    expect(tools(directory)).toEqual(['npm', 'dependabot', 'npm in web', 'pnpm in app']);
    const report = runDoctor(directory);
    expect(report.findings.filter((finding) => finding.rule === 'bot-cooldown-mismatch' || finding.rule === 'config-drift').map((finding) => finding.message)).toEqual([
      '.npmrc is missing; depcurfew apply would create it with the settings from depcurfew.json',
      'web/.npmrc is missing; depcurfew apply would create it with the settings from depcurfew.json',
    ]);
    const document = JSON.parse((await exec('explain', '--json', directory)).stdout) as {
      project: { packageManagers: { id: string }[]; ciForProjects?: { id: string }[] };
      policy: { targets: { tools: string[] } };
    };
    expect(document.project.packageManagers.map((manager) => manager.id)).toEqual(['npm']);
    expect(document.project.ciForProjects?.map((manager) => manager.id)).toEqual(['pnpm']);
    expect(document.policy.targets.tools).toEqual(['npm', 'dependabot']);
    // A listed pnpm is configured where it is used, in app only.
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, targets: ['npm', 'pnpm', 'dependabot'], projects: ['web', 'app'] }));
    const listed = planRepository(directory, policyOf(directory));
    expect(listed.changes.map((change) => change.file)).toEqual(['.npmrc', 'web/.npmrc']);
    expect(listed.warningDetails.map((warning) => warning.code)).not.toContain('target-not-found');
  });

  it('keeps the check of the version its setup step installs', () => {
    const directory = fixture('projects-ci-setup', {
      '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n        working-directory: app\n', '      - uses: pnpm/action-setup@v4\n        with:\n          version: 9.15.0\n'),
    });
    expect(tools(directory)).toEqual(['dependabot', 'npm in web', 'pnpm in app']);
    expect(runDoctor(directory).findings.filter((finding) => finding.rule === 'manager-version-too-old')).toEqual([
      {
        rule: 'manager-version-too-old',
        level: 'error',
        location: { file: '.github/workflows/ci.yml', line: 9 },
        message: 'pnpm 9.15.0 in GitHub Actions (.github/workflows/ci.yml) does not support minimumReleaseAge (added in 10.16.0)',
        fix: 'Require pnpm 10.16.0 or later in GitHub Actions',
      },
    ]);
    const detection = detectProject(directory, undefined, undefined, { projects: ['web', 'app'] });
    expect(detection.ciForProjects?.[0]?.versions).toEqual([{ version: '9.15.0', source: 'github-actions', file: '.github/workflows/ci.yml', line: 9, job: 'build', step: 7 }]);
  });

  it('still gets tool-only-in-ci from apply when no project uses it', () => {
    const directory = fixture('projects-ci-setup');
    writeFileSync(join(directory, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, projects: ['web'] }));
    const report = planRepository(directory, policyOf(directory));
    expect(report.warningDetails.filter((warning) => warning.code === 'tool-only-in-ci')).toEqual([
      {
        code: 'tool-only-in-ci',
        tool: 'pnpm',
        location: { file: '.github/workflows/ci.yml' },
        message: 'pnpm appears only in a CI setup step (.github/workflows/ci.yml); the repository has no package.json, package.json5 and package.yaml, lockfile or pnpm configuration, so nothing is written for it',
        fix: 'If pnpm installs packages for this project, add "pnpm" to targets in depcurfew.json and run depcurfew apply again',
      },
    ]);
    expect(report.changes.map((change) => change.file)).toEqual(['web/.npmrc']);
  });
});

describe('where the root CI setup step stays a package manager of the root', () => {
  const managers = (directory: string, projects: readonly string[]) => {
    const detection = detectProject(directory, undefined, undefined, { projects });
    return { root: detection.packageManagers.map((manager) => `${manager.id}:${manager.evidence.map((item) => item.kind).join(',')}`), forProjects: (detection.ciForProjects ?? []).map((manager) => manager.id) };
  };
  const npmRoot = { 'package.json': '{ "name": "tools" }\n', 'package-lock.json': '{ "lockfileVersion": 3 }\n', 'app/package.json': '{ "name": "app" }\n' };

  it('without projects, as for Bun set up next to deno.json (deno-ci-bun)', () => {
    expect(managers(join(REPOS, 'projects-ci-setup'), [])).toEqual({ root: ['pnpm:ci'], forProjects: [] });
    expect(managers(join(REPOS, 'deno-ci-bun'), [])).toEqual({ root: ['bun:ci', 'deno:config,ci'], forProjects: [] });
  });

  it('when it installs at the root, installs nowhere depcurfew sees, or installs in a directory that is no project', () => {
    expect(managers(repository({ ...npmRoot, '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n') }), ['app'])).toEqual({ root: ['npm:lockfile', 'pnpm:ci'], forProjects: [] });
    expect(managers(repository({ ...npmRoot, '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm run build\n') }), ['app'])).toEqual({ root: ['npm:lockfile', 'pnpm:ci'], forProjects: [] });
    expect(managers(repository({ ...npmRoot, '.github/workflows/ci.yml': WORKFLOW('      - run: cd "$APP" && pnpm install\n') }), ['app'])).toEqual({ root: ['npm:lockfile', 'pnpm:ci'], forProjects: [] });
    const both = WORKFLOW('      - run: pnpm install\n        working-directory: app\n      - run: pnpm install\n        working-directory: docs\n');
    expect(managers(repository({ ...npmRoot, '.github/workflows/ci.yml': both }), ['app'])).toEqual({ root: ['npm:lockfile', 'pnpm:ci'], forProjects: [] });
  });

  it('when a Dockerfile of the root installs with it', () => {
    const files = { ...npmRoot, '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n        working-directory: app\n'), Dockerfile: 'FROM node:24\nCOPY . .\nRUN pnpm install\n' };
    expect(managers(repository(files), ['app'])).toEqual({ root: ['npm:lockfile', 'pnpm:ci'], forProjects: [] });
  });

  it('when the root has anything else of it, such as its lockfile', () => {
    const files = { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'app/package.json': '{ "name": "app" }\n', '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n        working-directory: app\n') };
    expect(managers(repository(files), ['app'])).toEqual({ root: ['pnpm:lockfile,ci'], forProjects: [] });
  });
});

describe('where the root CI setup step is for the projects', () => {
  const managers = (files: Record<string, string>, projects: readonly string[]) => {
    const detection = detectProject(repository(files), undefined, undefined, { projects });
    return { root: detection.packageManagers.map((manager) => manager.id), forProjects: (detection.ciForProjects ?? []).map((manager) => manager.id), warnings: detection.warnings.map((warning) => warning.code) };
  };

  it('when every install with it runs in a listed directory or below it, also after a literal cd', () => {
    const run = '      - run: pnpm install\n        working-directory: app/site\n      - run: cd web && pnpm install --frozen-lockfile\n';
    const files = { 'package.json': '{ "name": "tools" }\n', 'package-lock.json': '{ "lockfileVersion": 3 }\n', '.github/workflows/ci.yml': WORKFLOW(run) };
    expect(managers(files, ['app', 'web'])).toEqual({ root: ['npm'], forProjects: ['pnpm'], warnings: [] });
    // Bun next to deno.json, which is a manifest of the same registry.
    const bun = { 'deno.json': '{}\n', '.github/workflows/ci.yml': WORKFLOW('      - run: bun install\n        working-directory: app\n', '      - uses: oven-sh/setup-bun@v2\n') };
    expect(managers(bun, ['app'])).toEqual({ root: ['deno'], forProjects: ['bun'], warnings: [] });
  });

  it('as without the step, so that a root package.json without a lockfile is npm', () => {
    const files = { 'package.json': '{ "name": "tools" }\n', '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n        working-directory: app\n') };
    expect(managers(files, ['app'])).toEqual({ root: ['npm'], forProjects: ['pnpm'], warnings: ['package-manager-assumed'] });
  });

  it('when the root has no manifest of its registry, wherever the installs run', () => {
    const pnpm = { 'pyproject.toml': '[project]\nname = "docs"\n[tool.uv]\n', '.github/workflows/ci.yml': WORKFLOW('      - run: pnpm install\n') };
    expect(managers(pnpm, ['app'])).toEqual({ root: ['uv'], forProjects: ['pnpm'], warnings: [] });
    const uv = { '.github/workflows/ci.yml': WORKFLOW('      - run: uv sync\n        working-directory: api\n', '      - uses: astral-sh/setup-uv@v7\n') };
    expect(managers(uv, ['api'])).toEqual({ root: [], forProjects: ['uv'], warnings: ['nothing-detected'] });
  });
});
