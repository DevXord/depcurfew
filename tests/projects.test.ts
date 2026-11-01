// projects in depcurfew.json (decision D-100): several independent projects in one repository, the bots configured
// from the root. The before-and-after test of apply runs on tests/fixtures/repos/multi-project with the other fixtures;
// these tests cover what can go wrong with the listed directories and what the other commands say about them.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProject, planRepository } from '../src/apply/index.ts';
import { relocateText } from '../src/apply/projects.ts';
import { EXIT_FAILURE, EXIT_OK, run } from '../src/cli/run.ts';
import { renderText, RULES, runDoctor, toSarif } from '../src/doctor/index.ts';
import { findPolicyDirectory } from '../src/policy/file.ts';
import type { ResolvedPolicy } from '../src/policy/schema.ts';
import { parsePolicy } from '../src/policy/validate.ts';
import { loadUserPolicy } from '../src/user/policy.ts';
import { windows } from './support/platform.ts';

const FIXTURE = fileURLToPath(new URL('fixtures/repos/multi-project', import.meta.url));
const POLICY = readFileSync(new URL('fixtures/expected/multi-project/depcurfew.json', import.meta.url), 'utf8');

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

/** The resolved policy of a valid depcurfew.json. */
function policyOf(text: string): ResolvedPolicy {
  const result = parsePolicy(text);
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  return result.policy;
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'depcurfew-projects-'));
  cpSync(FIXTURE, directory, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writePolicy(changes: Record<string, unknown> = {}): void {
  writeFileSync(join(directory, 'depcurfew.json'), `${JSON.stringify({ ...(JSON.parse(POLICY) as object), ...changes }, null, 2)}\n`);
}

function read(file: string): string {
  return readFileSync(join(directory, file), 'utf8');
}

describe('apply with projects', () => {
  it('configures each project in its own directory and the bots once, from the root, waiting as long as every project', async () => {
    writePolicy();
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe('');
    const document = JSON.parse(result.stdout) as { changes: { file: string; diff: string }[]; warnings: { project?: string; location?: { file: string } }[] };
    expect(document.changes.map((change) => change.file)).toEqual(['.github/dependabot.yml', 'backend/pyproject.toml', 'frontend/.npmrc', 'frontend/package.json']);
    expect(document.changes[2]?.diff).toContain('+++ b/frontend/.npmrc');
    expect(document.warnings.find((warning) => warning.location !== undefined)).toMatchObject({ project: 'backend', location: { file: 'backend/uv.lock' } });
    // npm rounds 36h up to 2 days in frontend, so Dependabot waits 2 days for every entry.
    expect(read('.github/dependabot.yml').match(/default-days: 2/gu)).toHaveLength(2);
    expect(read('frontend/.npmrc')).toContain('min-release-age=2');
    expect(read('backend/pyproject.toml')).toContain('exclude-newer = "36 hours"');
    const snapshot = ['.github/dependabot.yml', 'backend/pyproject.toml', 'frontend/.npmrc', 'frontend/package.json'].map(read);
    const second = await exec('apply', directory);
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toBe('No files changed; what depcurfew could not apply is listed below.\n');
    expect(['.github/dependabot.yml', 'backend/pyproject.toml', 'frontend/.npmrc', 'frontend/package.json'].map(read)).toEqual(snapshot);
  });

  it('names project files relative to the root in the text output', async () => {
    writePolicy();
    const result = await exec('apply', '--dry-run', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('--- /dev/null\n+++ b/frontend/.npmrc\n');
    expect(result.stderr).toContain('warning: uv: backend/uv.lock records exclude-newer, so it is out of date after this change (lockfile-out-of-date)\n  fix: Run uv lock and commit backend/uv.lock;');
    expect(result.stderr).toContain('warning: backend: uv has no setting for git dependencies');
  });

  it('writes nothing and reports every listed directory that cannot be used', async () => {
    mkdirSync(join(directory, 'deck'));
    writeFileSync(join(directory, 'deck', 'depcurfew.json'), '{ "version": 1 }\n');
    writeFileSync(join(directory, 'notes.md'), 'notes\n');
    writePolicy({ projects: ['frontend', 'backend', 'shared', 'deck', 'notes.md'] });
    const before = read('.github/dependabot.yml');
    const result = await exec('apply', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as { written: boolean; changes: unknown[]; errors: { code: string; location: { file: string; line?: number }; message: string; fix: string }[] };
    expect(document.written).toBe(false);
    expect(document.changes).toEqual([]);
    expect(document.errors).toEqual([
      {
        code: 'project-not-found',
        level: 'error',
        location: { file: 'depcurfew.json', line: 25 },
        message: 'the project directory shared listed in projects does not exist',
        fix: 'Create shared, or correct or remove "shared" from projects in depcurfew.json',
      },
      {
        code: 'project-has-policy',
        level: 'error',
        location: { file: 'deck/depcurfew.json' },
        message: 'deck/depcurfew.json is a second policy for deck, which projects in the depcurfew.json of the repository root already covers',
        fix: 'Remove deck/depcurfew.json (move what it sets into the depcurfew.json of the root), or remove "deck" from projects in depcurfew.json and run depcurfew in deck on its own',
      },
      {
        code: 'project-not-a-directory',
        level: 'error',
        location: { file: 'depcurfew.json', line: 27 },
        message: 'notes.md is a file, so the project directory notes.md listed in projects is not a directory',
        fix: 'List the directory of the project, not a file in it, or remove "notes.md" from projects in depcurfew.json',
      },
    ]);
    expect(read('.github/dependabot.yml')).toBe(before);
    const text = await exec('apply', directory);
    expect(text.stderr).toContain('error: depcurfew.json (line 25): the project directory shared listed in projects does not exist (project-not-found)\n  fix: Create shared,');
    expect(text.stderr).toContain('depcurfew: nothing written because of the errors above.\n');
  });

  it('gives the line of the entry in projects, not of the same name elsewhere in depcurfew.json', async () => {
    writeFileSync(
      join(directory, 'depcurfew.json'),
      '{\n  "version": 1,\n  "cooldown": { "minimum": "3d", "exclude": ["shared"] },\n  "projects": [\n    "frontend",\n    "shared"\n  ]\n}\n',
    );
    const report = planRepository(directory, policyOf(read('depcurfew.json')));
    expect(report.problems?.map((problem) => [problem.code, problem.location])).toEqual([['project-not-found', { file: 'depcurfew.json', line: 6 }]]);
    const text = await exec('apply', directory);
    expect(text.stderr).toContain('error: depcurfew.json (line 6): the project directory shared listed in projects does not exist (project-not-found)\n  fix: Create shared,');
  });

  it.skipIf(windows)('refuses a project reached through a symlink, also one that leads out of the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'depcurfew-projects-outside-'));
    try {
      writeFileSync(join(outside, 'package.json'), '{ "name": "outside" }\n');
      symlinkSync(outside, join(directory, 'elsewhere'));
      symlinkSync(join(directory, 'frontend'), join(directory, 'web'));
      writePolicy({ projects: ['elsewhere', 'web'] });
      const report = planRepository(directory, policyOf(read('depcurfew.json')));
      expect(report.problems?.map((problem) => [problem.code, problem.message])).toEqual([
        ['project-symlink', 'the project directory elsewhere listed in projects is a symlink that leads outside the repository; depcurfew does not follow symlinks to projects, so the files it writes stay in the repository'],
        ['project-symlink', 'the project directory web listed in projects is a symlink; depcurfew does not follow symlinks to projects, so the files it writes stay in the repository'],
      ]);
      expect(() => applyProject(directory)).not.toThrow();
      expect(readFileSync(join(outside, 'package.json'), 'utf8')).toBe('{ "name": "outside" }\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a project that is a workspace package of the root', () => {
    writeFileSync(join(directory, 'package.json'), '{ "name": "root", "private": true, "workspaces": ["frontend"] }\n');
    writePolicy();
    const report = planRepository(directory, policyOf(read('depcurfew.json')));
    expect(report.problems).toEqual([
      expect.objectContaining({
        code: 'project-in-workspace',
        message: 'the project directory frontend listed in projects is a workspace package of the repository root (declared in package.json), which the configuration of the root already covers',
      }),
    ]);
  });

  it('with listed targets, configures each package manager only where it is used and says when none uses it', () => {
    writePolicy({ targets: ['npm', 'uv', 'pnpm', 'dependabot'] });
    const report = planRepository(directory, policyOf(read('depcurfew.json')));
    expect(report.changes.map((change) => change.file)).toEqual(['.github/dependabot.yml', 'backend/pyproject.toml', 'frontend/.npmrc', 'frontend/package.json']);
    expect(report.warningDetails.filter((warning) => warning.code === 'target-not-found')).toEqual([
      {
        code: 'target-not-found',
        tool: 'pnpm',
        message: 'pnpm is listed in targets, but neither the repository root nor a directory in projects uses it, so nothing is written for it',
        fix: 'Add the directory of the pnpm project to projects in depcurfew.json, or remove "pnpm" from targets',
      },
    ]);
  });

  it('warns about a listed directory in which nothing is found', () => {
    mkdirSync(join(directory, 'docs'));
    writePolicy({ projects: ['frontend', 'backend', 'docs'] });
    const report = planRepository(directory, policyOf(read('depcurfew.json')));
    expect(report.warningDetails.find((warning) => warning.code === 'nothing-to-configure')).toEqual({
      code: 'nothing-to-configure',
      project: 'docs',
      message: 'docs: no tools to configure: depcurfew found no supported package manager there',
      fix: 'Check that "docs" in projects in depcurfew.json is the directory of the project, with its manifest and lockfile; depcurfew explain shows what it detects',
    });
  });

  it('says that targets leaves out the package manager of a project, naming the project once', () => {
    writePolicy({ targets: ['uv', 'dependabot'] });
    const report = planRepository(directory, policyOf(read('depcurfew.json')));
    expect(report.warningDetails.filter((warning) => warning.code === 'nothing-to-configure')).toEqual([
      {
        code: 'nothing-to-configure',
        project: 'frontend',
        message: 'frontend: no tools to configure: frontend uses npm, but targets in depcurfew.json does not list it',
        fix: 'Add "npm" to targets in depcurfew.json to configure frontend, or remove "frontend" from projects if depcurfew should leave it alone',
      },
    ]);
  });
});

describe('doctor with projects', () => {
  it('checks every project with the policy of the root and names its files from the root, in text, JSON and SARIF', async () => {
    writePolicy();
    const report = runDoctor(directory);
    expect(report.findings.map((finding) => [finding.rule, finding.location.file])).toEqual([
      ['config-drift', '.github/dependabot.yml'],
      ['config-drift', 'backend/pyproject.toml'],
      ['config-drift', 'depcurfew.json'],
      ['config-drift', 'frontend/package.json'],
      // Without frontend/.npmrc nothing makes npm 11.19.1 block dependency install scripts (decision D-105).
      ['manager-version-too-old', 'frontend/package.json'],
    ]);
    expect(report.findings[2]?.message).toBe('frontend/.npmrc is missing; depcurfew apply would create it with the settings from depcurfew.json');
    expect(report.findings[4]).toMatchObject({
      message: 'npm 11.19.1 in packageManager (frontend/package.json) does not support blocking dependency install scripts without strict-allow-scripts (since 12.0.0)',
      fix: 'Set strict-allow-scripts=true in frontend/.npmrc, which depcurfew apply writes for this repository, or require npm 12.0.0 or later in packageManager',
    });
    expect(report.checked?.tools).toEqual([
      { id: 'dependabot', name: 'Dependabot' },
      { id: 'npm', name: 'npm', version: '11.19.1', versionFrom: 'frontend/package.json', project: 'frontend' },
      { id: 'uv', name: 'uv', version: '0.13.6', versionFrom: 'backend/pyproject.toml', project: 'backend' },
    ]);
    expect(report.checked?.files).toEqual(['.github/dependabot.yml', 'backend/pyproject.toml', 'backend/uv.lock', 'depcurfew.json', 'frontend/package-lock.json', 'frontend/package.json']);
    // Each rule once, its result over every directory.
    expect(report.checked?.rules.map((rule) => rule.rule)).toEqual(RULES.map((rule) => rule.id));
    expect(report.checked?.rules.find((rule) => rule.rule === 'config-drift')).toMatchObject({ result: 'problems', errors: 4 });
    expect(renderText(report, RULES)).toContain('npm 11.19.1 (frontend/package.json) in frontend');
    const sarif = JSON.stringify(toSarif(report, RULES, '0.0.0'));
    expect(sarif).toContain('"uri":"frontend/package.json"');

    await exec('apply', directory);
    const clean = await exec('doctor', directory);
    expect(clean.code).toBe(EXIT_OK);
    expect(clean.stdout).toMatch(/^No problems found\.\n/u);
  });

  it('reports a listed directory that cannot be used as invalid-project instead of stopping', async () => {
    writePolicy({ projects: ['frontend', 'backend', 'shared'] });
    const result = await exec('doctor', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    const document = JSON.parse(result.stdout) as { findings: { rule: string; location: { file: string } }[] };
    expect(document.findings.filter((finding) => finding.rule === 'invalid-project')).toEqual([
      {
        rule: 'invalid-project',
        level: 'error',
        location: { file: 'depcurfew.json', line: 25 },
        message: 'the project directory shared listed in projects does not exist',
        fix: 'Create shared, or correct or remove "shared" from projects in depcurfew.json',
      },
    ]);
    // The other projects are still checked.
    expect(document.findings.some((finding) => finding.location.file === 'frontend/package.json')).toBe(true);
  });

  it('takes the policy as an option instead of reading depcurfew.json', () => {
    const policy = policyOf(POLICY);
    const report = runDoctor(directory, { policy });
    expect(report.policy).toBe('valid');
    expect(report.checked?.tools.map((tool) => tool.project)).toEqual([undefined, 'frontend', 'backend']);
    expect(runDoctor(directory, { policy: null }).policy).toBe('missing');
  });
});

describe('explain with projects', () => {
  it('describes the root and every project, with paths from the root', async () => {
    writePolicy();
    const result = await exec('explain', '--json', directory);
    expect(result.code).toBe(EXIT_OK);
    const document = JSON.parse(result.stdout) as {
      schemaVersion: number;
      policy: { targets: unknown; cooldown: { tools: { tool: string }[] } };
      projects: { directory: string; project: { packageManagers: { id: string; evidence: { file: string }[] }[] }; targets: unknown }[];
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.policy.targets).toEqual({ mode: 'auto', tools: ['dependabot'] });
    expect(document.policy.cooldown.tools.map((entry) => entry.tool)).toEqual(['npm', 'uv', 'dependabot']);
    expect(document.projects.map((entry) => [entry.directory, entry.targets])).toEqual([
      ['frontend', { mode: 'auto', tools: ['npm'] }],
      ['backend', { mode: 'auto', tools: ['uv'] }],
    ]);
    expect(document.projects[0]?.project.packageManagers[0]?.evidence).toEqual([
      { kind: 'lockfile', file: 'frontend/package-lock.json' },
      { kind: 'packageManager', file: 'frontend/package.json' },
    ]);
    const text = await exec('explain', directory);
    expect(text.stdout).toContain('\nProject frontend:\n  Package managers:\n    npm\n');
    expect(text.stdout).toContain('  targets: uv (detected)\n');
  });

  it('shows a listed directory that cannot be used, as an error with exit code 1 like apply', async () => {
    writePolicy({ projects: ['frontend', 'shared'] });
    const result = await exec('explain', '--json', directory);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe('');
    const document = JSON.parse(result.stdout) as { projects: unknown[]; errors: unknown[] };
    expect(document.projects[1]).toEqual({
      directory: 'shared',
      project: null,
      error: {
        code: 'project-not-found',
        level: 'error',
        location: { file: 'depcurfew.json', line: 24 },
        message: 'the project directory shared listed in projects does not exist',
        fix: 'Create shared, or correct or remove "shared" from projects in depcurfew.json',
      },
    });
    expect(document.errors).toEqual([
      {
        code: 'project-not-found',
        level: 'error',
        location: { file: 'depcurfew.json', line: 24 },
        message: 'the project directory shared listed in projects does not exist',
        fix: 'Create shared, or correct or remove "shared" from projects in depcurfew.json',
      },
    ]);
    const text = await exec('explain', directory);
    expect(text.code).toBe(EXIT_FAILURE);
    expect(text.stdout).toContain('Project shared: cannot be used\n');
  });

  it('gives no nothing-detected warning for a root that holds only the projects it lists', async () => {
    writePolicy();
    const result = await exec('explain', '--json', directory);
    const document = JSON.parse(result.stdout) as { project: { warnings: { code: string }[] } };
    expect(document.project.warnings.map((warning) => warning.code)).toEqual([]);
    expect((await exec('explain', directory)).stdout).toMatch(/^Warnings: none$/mu);
    // Without projects the warning stays, with what to do.
    rmSync(join(directory, 'depcurfew.json'));
    const plain = JSON.parse((await exec('explain', '--json', directory)).stdout) as { project: { warnings: unknown[] } };
    expect(plain.project.warnings).toEqual([
      {
        code: 'nothing-detected',
        level: 'warning',
        message: 'no package.json, deno.json, pyproject.toml, requirements.txt or lockfile found',
        files: [],
        fix: 'Run depcurfew explain in the directory of the project, or list the directories of the projects under projects in depcurfew.json',
      },
    ]);
  });

  it('has an empty projects list without projects', async () => {
    const result = await exec('explain', '--json', directory);
    expect((JSON.parse(result.stdout) as { projects: unknown }).projects).toEqual([]);
  });
});

describe('init with projects', () => {
  it('lists the direct subdirectories with a manifest when the root has none, and says so', async () => {
    mkdirSync(join(directory, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'x', 'package.json'), '{}\n');
    mkdirSync(join(directory, '.cache'));
    writeFileSync(join(directory, '.cache', 'package.json'), '{}\n');
    mkdirSync(join(directory, 'docs'));
    const result = await exec('init', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(
      'projects lists backend and frontend: the root has no manifest or lockfile, these directories do, so depcurfew configures each as a project of its own and the bots from the root; edit projects in depcurfew.json if that is not right.\n',
    );
    expect(result.stdout).toContain('Detected tools: Dependabot, uv (backend), npm (frontend).\n');
    const written = parsePolicy(read('depcurfew.json'));
    expect(written).toMatchObject({ ok: true, policy: { projects: ['backend', 'frontend'] } });
  });

  it('keeps the longest delay a project already sets', async () => {
    writeFileSync(join(directory, 'frontend', '.npmrc'), 'min-release-age=10\n');
    const result = await exec('init', directory);
    expect(result.stdout).toContain('cooldown.minimum is 10d instead of 3d, to keep the longest release-age delay already set: min-release-age: 10 in frontend/.npmrc (line 1).\n');
    expect(parsePolicy(read('depcurfew.json'))).toMatchObject({ ok: true, policy: { cooldown: { minimum: { text: '10d' } } } });
  });

  it('leaves out a directory with its own depcurfew.json, which apply would refuse, and says why', async () => {
    mkdirSync(join(directory, 'deck'));
    writeFileSync(join(directory, 'deck', 'package.json'), '{ "name": "deck", "private": true }\n');
    writeFileSync(join(directory, 'deck', 'depcurfew.json'), '{ "version": 1 }\n');
    const result = await exec('init', directory);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('projects lists backend and frontend:');
    expect(result.stdout).toContain(
      'deck is not in projects: deck/depcurfew.json is a policy of its own, and two policies for the same files are refused; run depcurfew in deck on its own, or move what deck/depcurfew.json sets into depcurfew.json, remove it and add "deck" to projects.\n',
    );
    expect(parsePolicy(read('depcurfew.json'))).toMatchObject({ ok: true, policy: { projects: ['backend', 'frontend'] } });
    const apply = await exec('apply', '--dry-run', directory);
    expect(apply.code).toBe(EXIT_OK);
  });

  it('adds no projects when the root has a manifest', async () => {
    writeFileSync(join(directory, 'package.json'), '{ "name": "root", "private": true }\n');
    const result = await exec('init', directory);
    expect(result.stdout).not.toContain('projects lists');
    expect(read('depcurfew.json')).not.toContain('"projects"');
  });
});

describe('the policy of a repository with projects', () => {
  it('is found from a project directory, by check and the hook too', () => {
    mkdirSync(join(directory, '.git'));
    writePolicy();
    expect(findPolicyDirectory(join(directory, 'frontend'))).toBe(directory);
  });

  it('is refused in the user policy, which configures the tools of a machine', () => {
    const home = mkdtempSync(join(tmpdir(), 'depcurfew-projects-home-'));
    try {
      const environment = { home, platform: 'linux' as const, env: { XDG_CONFIG_HOME: join(home, '.config') } };
      mkdirSync(join(home, '.config', 'depcurfew'), { recursive: true });
      writeFileSync(join(home, '.config', 'depcurfew', 'depcurfew.json'), '{ "version": 1, "projects": ["web"] }\n');
      expect(() => loadUserPolicy(environment as never)).toThrow(expect.objectContaining({ issues: [expect.stringMatching(/^projects: has no meaning in the user policy/u)] }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('relocateText', () => {
  it('names whole file paths of a project from the root, never the end of a longer path or depcurfew.json', () => {
    expect(relocateText('min-release-age in .npmrc, not in packages/a/.npmrc; see depcurfew.json and .npmrc.', 'web', ['.npmrc', 'depcurfew.json'])).toBe(
      'min-release-age in web/.npmrc, not in packages/a/.npmrc; see depcurfew.json and web/.npmrc.',
    );
  });
});
