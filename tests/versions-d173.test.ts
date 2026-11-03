// Tool versions in CI and Dockerfiles, mise, matrix values, explain and messages (decision D-173): the versions a
// repository installs with setup-pdm, pip, pipx, uv tool install, the uv image, mise and setup-node's mise.toml, the
// npm npm install -g npm@<range> installs, matrix values in expressions with more text, explain as apply sees the
// cooldown, Deno's allowScripts before 2.6.0, ENV values in RUN, PIP_CONFIG_FILE, CI versions of projects and the npm
// of Node.js 24 in apply.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { detectProject } from '../src/detect/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d173-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function repository(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d173-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

async function exec(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await run(argv, { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch: async () => new Response('{}', { status: 404 }),
    now: () => new Date('2026-11-03T12:00:00Z'),
    stdin: async () => '',
    home: () => HOME,
  });
  return { code, stdout };
}

interface Finding {
  rule: string;
  level: string;
  location?: { file?: string; line?: number };
  message: string;
  fix?: string;
}

async function findings(root: string, rule?: string): Promise<Finding[]> {
  const found = (JSON.parse((await exec('doctor', '--json', root)).stdout) as { findings: Finding[] }).findings;
  return rule === undefined ? found : found.filter((finding) => finding.rule === rule);
}

const POLICY = {
  version: 1,
  cooldown: { minimum: '3d', exclude: [], securityUpdates: 'bypass' },
  installScripts: { default: 'deny', allow: [], deny: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
  targets: 'auto',
  doctor: { failOn: 'warning' },
};
const NPMRC =
  '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nmin-release-age=3\nstrict-allow-scripts=true\nallow-git=none\nallow-remote=none\nallow-file=all\nallow-directory=all\n# <<< depcurfew managed block\n';
const workflow = (steps: string, extra = '') => `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
const npmRepository = (files: Record<string, string | object>) =>
  repository({ 'package.json': { name: 'app', version: '1.0.0', private: true }, 'depcurfew.json': POLICY, '.npmrc': NPMRC, ...files });

const PDM_PROJECT = {
  'pyproject.toml': '[project]\nname = "etl"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n\n[tool.pdm]\ndistribution = false\n',
  'pdm.lock': '[metadata]\ngroups = ["default"]\nstrategy = ["inherit_metadata"]\nlock_version = "4.5.0"\ncontent_hash = "sha256:0"\n',
};
const PIPENV_PROJECT = {
  Pipfile: '[[source]]\nurl = "https://pypi.org/simple"\nverify_ssl = true\nname = "pypi"\n\n[packages]\nflask = "==3.1.2"\n',
  'Pipfile.lock': { _meta: { hash: { sha256: '0' }, 'pipfile-spec': 6, requires: {}, sources: [] }, default: {}, develop: {} },
};
const UV_PROJECT = {
  'pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n',
  'uv.lock': 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n\n[[package]]\nname = "api"\nversion = "0.1.0"\nsource = { virtual = "." }\n',
};
const versionsOf = (root: string, id: string) => detectProject(root).packageManagers.find((manager) => manager.id === id)?.versions ?? [];

describe('Python tool versions CI jobs and Dockerfiles install', () => {
  it('reads the PDM version of pdm-project/setup-pdm, and doctor finds it too old', async () => {
    const root = repository({
      ...PDM_PROJECT,
      '.github/workflows/ci.yml': workflow('      - uses: pdm-project/setup-pdm@v4\n        with:\n          version: 2.20.1\n      - run: pdm install --frozen-lockfile\n'),
      'depcurfew.json': POLICY,
    });
    expect(versionsOf(root, 'pdm')).toEqual([{ version: '2.20.1', source: 'github-actions', file: '.github/workflows/ci.yml', line: 8, job: 'build', step: 6 }]);
    applyProject(root);
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => finding.message)).toEqual([expect.stringMatching(/^PDM 2\.20\.1 in GitHub Actions \(\.github\/workflows\/ci\.yml\) does not support /u)]);
    expect(old[0]?.level).toBe('error');
  });

  it('takes version: head of setup-pdm for no version', () => {
    const root = repository({ ...PDM_PROJECT, '.github/workflows/ci.yml': workflow('      - uses: pdm-project/setup-pdm@v4\n        with:\n          version: head\n') });
    expect(versionsOf(root, 'pdm')).toEqual([]);
  });

  it.each([
    ['pip', 'python -m pip install pipenv==2025.0.4', 'pipenv', '2025.0.4'],
    ['pip with --user', 'pip install --user pipenv==2025.0.4', 'pipenv', '2025.0.4'],
    ['pipx', 'pipx install pipenv==2025.0.4', 'pipenv', '2025.0.4'],
    ['pipx for PDM', 'pipx install pdm==2.20.1', 'pdm', '2.20.1'],
    ['uv tool install for PDM', 'uv tool install pdm==2.20.1', 'pdm', '2.20.1'],
    ['pip for uv', 'pip install uv==0.8.22', 'uv', '0.8.22'],
    ['pipx for uv', 'pipx install uv==0.8.22', 'uv', '0.8.22'],
  ])('reads the version a CI step installs with %s', (_case, command, tool, version) => {
    const project = tool === 'pdm' ? PDM_PROJECT : tool === 'pipenv' ? PIPENV_PROJECT : UV_PROJECT;
    const root = repository({ ...project, '.github/workflows/ci.yml': workflow(`      - run: ${command}\n`) });
    expect(versionsOf(root, tool)).toEqual([{ version, source: 'github-actions', file: '.github/workflows/ci.yml', line: 6, job: 'build' }]);
  });

  it('doctor finds a Pipenv a CI job installs with pip too old for cool-down-period', async () => {
    const root = repository({
      ...PIPENV_PROJECT,
      '.github/workflows/ci.yml': workflow('      - run: python -m pip install pipenv==2025.0.4\n      - run: pipenv install --deploy\n'),
      'depcurfew.json': POLICY,
    });
    applyProject(root);
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => finding.message)).toEqual([expect.stringMatching(/^Pipenv 2025\.0\.4 in GitHub Actions \(\.github\/workflows\/ci\.yml\) does not support /u)]);
  });

  it.each([
    ['COPY --from the distroless image', 'FROM python:3.12-slim\nCOPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/\nRUN uv sync --locked\n', 2, '0.8.22'],
    ['COPY --from a derived image', 'FROM python:3.12-slim\nCOPY --from=ghcr.io/astral-sh/uv:0.8.22-python3.12-bookworm /usr/local/bin/uv /bin/\n', 2, '0.8.22'],
    ['FROM a derived image', 'FROM ghcr.io/astral-sh/uv:0.8.22-python3.12-bookworm-slim\nRUN uv sync --locked\n', 1, '0.8.22'],
    ['a minor version tag', 'FROM python:3.12-slim\nCOPY --from=ghcr.io/astral-sh/uv:0.8 /uv /bin/\n', 2, '0.8'],
  ])('reads the uv version of the official uv image from %s', (_case, dockerfile, line, version) => {
    const root = repository({ ...UV_PROJECT, Dockerfile: dockerfile });
    expect(versionsOf(root, 'uv')).toEqual([{ version, source: 'dockerfile', file: 'Dockerfile', line, stage: '0' }]);
  });

  it.each([
    ['latest', 'COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/\n'],
    ['a base name', 'COPY --from=ghcr.io/astral-sh/uv:debian /usr/local/bin/uv /bin/\n'],
    ['a digest', 'COPY --from=ghcr.io/astral-sh/uv@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /bin/\n'],
    ['another image', 'COPY --from=example.com/astral-sh/uv:0.8.22 /uv /bin/\n'],
  ])('reads no uv version from %s', (_case, copy) => {
    const root = repository({ ...UV_PROJECT, Dockerfile: `FROM python:3.12-slim\n${copy}` });
    expect(versionsOf(root, 'uv')).toEqual([]);
  });

  it('doctor finds the uv a Dockerfile copies from the uv image too old for the delay apply writes', async () => {
    const root = repository({
      ...UV_PROJECT,
      Dockerfile: 'FROM python:3.12-slim\nCOPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/\nCOPY uv.lock pyproject.toml ./\nRUN uv sync --locked\n',
      'depcurfew.json': POLICY,
    });
    applyProject(root);
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => [finding.location, finding.message])).toEqual([[{ file: 'Dockerfile', line: 2 }, expect.stringMatching(/^uv 0\.8\.22 in Dockerfile does not support /u)]]);
  });

  it('expands an ENV value in a later RUN line of the stage', () => {
    const root = repository({
      'pyproject.toml': '[tool.poetry]\nname = "app"\nversion = "0.1.0"\n',
      'poetry.lock': '# This file is automatically @generated by Poetry 2.5.1 and should not be changed by hand.\npackage = []\n\n[metadata]\nlock-version = "2.1"\npython-versions = ">=3.12"\ncontent-hash = "0"\n',
      Dockerfile: 'FROM python:3.12-slim AS builder\nENV POETRY_VERSION=2.0.1\nARG PDM=ignored\nRUN pip install "poetry==${POETRY_VERSION}"\nFROM builder\nRUN pipx install poetry==$POETRY_VERSION\n',
    });
    expect(versionsOf(root, 'poetry')).toEqual([
      { version: '2.0.1', source: 'dockerfile', file: 'Dockerfile', line: 4, stage: 'builder' },
      { version: '2.0.1', source: 'dockerfile', file: 'Dockerfile', line: 6, stage: '1' },
    ]);
  });

  it('expands an ARG default, with ENV winning over an ARG of the same name, and keeps a variable without a value as written', () => {
    const root = repository({
      'pyproject.toml': '[tool.poetry]\nname = "app"\nversion = "0.1.0"\n',
      Dockerfile: 'FROM python:3.12-slim\nARG POETRY_VERSION=1.8.4\nRUN pip install poetry==${POETRY_VERSION}\nENV POETRY_VERSION=2.1.0\nRUN pip install poetry==${POETRY_VERSION}\nRUN pip install poetry==${UNSET}\n',
    });
    expect(versionsOf(root, 'poetry').map((declaration) => ('version' in declaration ? declaration.version : undefined))).toEqual(['1.8.4', '2.1.0', '==${UNSET}']);
  });

  it('expands a variable of the env of the job and of the step in a run step, the step winning', () => {
    const root = repository({
      'pyproject.toml': '[tool.poetry]\nname = "app"\nversion = "0.1.0"\n',
      '.github/workflows/ci.yml': workflow('      - run: pipx install poetry==$POETRY_VERSION\n      - run: pip install "poetry==${POETRY_VERSION}"\n        env:\n          POETRY_VERSION: 2.1.0\n', '    env:\n      POETRY_VERSION: 2.0.1\n'),
    });
    expect(versionsOf(root, 'poetry').map((declaration) => ('version' in declaration ? declaration.version : undefined))).toEqual(['2.0.1', '2.1.0']);
  });

  it('expands an ARG in npm install -g npm@${NPM_VERSION}, so the npm is one depcurfew knows', () => {
    const root = npmRepository({ Dockerfile: 'FROM node:22\nARG NPM_VERSION=11.17.0\nRUN npm install -g npm@${NPM_VERSION} && npm ci\n' });
    expect(detectProject(root).dockerfiles[0]?.stages[0]?.commands.map((command) => [command.kind, command.version])).toEqual([
      ['upgrade', '11.17.0'],
      ['install', undefined],
    ]);
  });
});

describe('npm install -g npm@<range> installs the newest release of the range', () => {
  const ci = (node: string, upgrade: string) =>
    npmRepository({ '.github/workflows/ci.yml': workflow(`      - uses: actions/setup-node@v6\n        with:\n          node-version: ${node}\n      - run: npm install -g npm@${upgrade}\n      - run: npm ci\n`) });

  it('npm@11 after Node.js 22 is the newest 11.x depcurfew knows, not 11.0.0', async () => {
    expect(await findings(ci('22', '11'), 'manager-version-too-old')).toEqual([]);
  });

  it('npm@latest is the latest npm depcurfew knows, so doctor neither warns nor says it cannot tell', async () => {
    const root = ci('22', 'latest');
    const found = await findings(root);
    expect(found.filter((finding) => finding.rule === 'manager-version-too-old')).toEqual([]);
    const report = applyProject(root, { write: false });
    expect(report.warningDetails.filter((warning) => /cannot tell which version/u.test(warning.message))).toEqual([]);
  });

  it('npm@10 is the newest 10.x, and the warning names it', async () => {
    const found = await findings(ci('22', '10'), 'manager-version-too-old');
    expect(found).toHaveLength(1);
    expect(found[0]?.level).toBe('warning');
    expect(found[0]?.message).toMatch(/npm 10\.9\.9/u);
    expect(found[0]?.message).not.toMatch(/10\.0\.0/u);
  });

  it('npm@latest on a Node.js npm 11 and 12 do not run on installs the newest npm that does', async () => {
    const found = await findings(ci('20.10.0', 'latest'), 'manager-version-too-old');
    expect(found.map((finding) => finding.message)).toContainEqual(expect.stringMatching(/npm 10\.9\.9/u));
  });

  it('a range no npm release depcurfew knows satisfies is a version it cannot tell', async () => {
    const found = await findings(ci('22', '^13'), 'manager-version-too-old');
    expect(found).toEqual([]);
    const notices = JSON.parse((await exec('doctor', '--json', ci('22', '^13'))).stdout) as { notices: { message: string }[] };
    expect(notices.notices.map((notice) => notice.message)).toContainEqual(expect.stringMatching(/npm version "\^13"/u));
  });
});

describe('mise', () => {
  it('reads node from [tools] of mise.toml, with .mise.toml over mise.toml', () => {
    const plain = repository({ 'package.json': { name: 'app' }, 'mise.toml': '[tools]\nnode = "20"\npython = "3.12"\n' });
    expect(detectProject(plain).node.versions).toEqual([{ version: '20', source: 'mise', file: 'mise.toml', line: 2 }]);
    const both = repository({ 'package.json': { name: 'app' }, 'mise.toml': '[tools]\nnode = "20"\n', '.mise.toml': '[tools]\nnode = { version = "22" }\n' });
    expect(detectProject(both).node.versions).toEqual([{ version: '22', source: 'mise', file: '.mise.toml', line: 2 }]);
    const list = repository({ 'package.json': { name: 'app' }, '.config/mise.toml': '[tools]\nnode = ["24", "22"]\n' });
    expect(detectProject(list).node.versions).toEqual([{ version: '24', source: 'mise', file: '.config/mise.toml', line: 2 }]);
  });

  it('doctor checks the npm of the Node.js mise.toml declares', async () => {
    const root = npmRepository({ 'mise.toml': '[tools]\nnode = "20"\n' });
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => [finding.location?.file, finding.message])).toEqual([['mise.toml', expect.stringMatching(/^Node\.js 20 in mise \(mise\.toml\) can come with npm 9\.6\.4 to 10\.8\.2/u)]]);
    expect((await findings(root, 'runtime-end-of-life')).map((finding) => finding.location?.file)).toEqual(['mise.toml']);
  });

  it('setup-node reads tools.node of the mise.toml node-version-file names', async () => {
    const root = npmRepository({
      'mise.toml': '[tools]\nnode = "22"\n',
      '.github/workflows/ci.yml': workflow('      - uses: actions/setup-node@v6\n        with:\n          node-version-file: mise.toml\n      - run: npm ci\n'),
    });
    expect(detectProject(root).node.versions).toContainEqual(expect.objectContaining({ version: '22', versionFile: 'mise.toml', source: 'github-actions' }));
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => finding.message)).toContainEqual(expect.stringMatching(/^Node\.js 22 from mise\.toml in GitHub Actions/u));
  });

  it('jdx/mise-action sets up the Node.js of mise.toml for the steps after it, or of its mise_toml input', async () => {
    const root = npmRepository({
      'mise.toml': '[tools]\nnode = "22"\n',
      '.github/workflows/ci.yml': workflow('      - uses: jdx/mise-action@v5\n      - run: npm ci\n'),
    });
    expect(detectProject(root).node.versions).toContainEqual({ version: '22', versionFile: 'mise.toml', source: 'github-actions', file: '.github/workflows/ci.yml', line: 6, job: 'build', step: 6, reader: 'mise' });
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => finding.message)).toContainEqual(expect.stringMatching(/^Node\.js 22 from mise\.toml in GitHub Actions \(\.github\/workflows\/ci\.yml, job build\) can come with npm 10/u));
    const inline = npmRepository({ '.github/workflows/ci.yml': workflow("      - uses: jdx/mise-action@v5\n        with:\n          mise_toml: |\n            [tools]\n            node = '24.19.0'\n      - run: npm ci\n") });
    expect(detectProject(inline).node.versions).toContainEqual(expect.objectContaining({ version: '24.19.0', versionFile: 'the mise_toml input', reader: 'mise' }));
    const off = npmRepository({ 'mise.toml': '[tools]\nnode = "22"\n', '.github/workflows/ci.yml': workflow('      - uses: jdx/mise-action@v5\n        with:\n          install: false\n      - run: npm ci\n') });
    expect(detectProject(off).node.versions.filter((declaration) => declaration.source === 'github-actions')).toEqual([]);
  });
});

describe('matrix values in an expression with more text', () => {
  it('expands ${{ matrix.node }}.x for every value of the matrix', async () => {
    const root = npmRepository({ '.github/workflows/ci.yml': workflow("      - uses: actions/setup-node@v6\n        with:\n          node-version: ${{ matrix.node }}.x\n      - run: npm ci\n", '    strategy:\n      matrix:\n        node: [20, 22]\n') });
    expect(detectProject(root).node.versions.map((declaration) => ('version' in declaration ? [declaration.version, declaration.matrix, declaration.line] : undefined))).toEqual([
      ['20.x', 'node', 7],
      ['22.x', 'node', 7],
    ]);
    const old = await findings(root, 'manager-version-too-old');
    expect(old.map((finding) => finding.message)).toContainEqual(expect.stringMatching(/^Node\.js 22\.x \(matrix\.node\) in GitHub Actions/u));
  });

  it('expands ${{ matrix.cfg.node }} from the objects of the matrix list and of include, without what exclude removes', () => {
    const root = npmRepository({
      '.github/workflows/ci.yml': workflow(
        '      - uses: actions/setup-node@v6\n        with:\n          node-version: v${{ matrix.cfg.node }}\n      - run: npm ci\n',
        '    strategy:\n      matrix:\n        cfg:\n          - { node: 20 }\n          - { node: 22, os: linux }\n          - { node: 24 }\n        exclude:\n          - cfg: { node: 24 }\n        include:\n          - cfg: { node: 26 }\n',
      ),
    });
    expect(detectProject(root).node.versions.map((declaration) => ('version' in declaration ? [declaration.version, declaration.matrix] : undefined))).toEqual([
      ['v20', 'cfg.node'],
      ['v22', 'cfg.node'],
      ['v26', 'cfg.node'],
    ]);
  });

  it('keeps a fromJSON matrix as one it cannot read', () => {
    const root = npmRepository({ '.github/workflows/ci.yml': workflow("      - uses: actions/setup-node@v6\n        with:\n          node-version: ${{ matrix.node }}.x\n      - run: npm ci\n", "    strategy:\n      matrix:\n        node: ${{ fromJSON('[20, 22]') }}\n") });
    expect(detectProject(root).node.versions.map((declaration) => ('version' in declaration ? declaration.version : undefined))).toEqual(['${{ matrix.node }}.x']);
  });
});

describe('explain shows the cooldown as apply writes it', () => {
  it('a Bundler too old for the cooldown cannot apply it, and its warning is not filed under installScripts', async () => {
    const root = repository({
      Gemfile: 'source "https://rubygems.org"\n\ngem "rails", "~> 8.1.0"\n',
      'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (8.1.0)\n\nPLATFORMS\n  x86_64-linux\n\nDEPENDENCIES\n  rails (~> 8.1.0)\n\nBUNDLED WITH\n   2.6.9\n',
      'depcurfew.json': POLICY,
    });
    const explain = JSON.parse((await exec('explain', '--json', root)).stdout) as {
      policy: { cooldown: { tools: { tool: string; ok: boolean; reason?: string }[] }; installScripts: { tools: { tool: string; warnings: { code: string }[] }[] } };
    };
    expect(explain.policy.installScripts.tools.find((entry) => entry.tool === 'bundler')?.warnings.map((warning) => warning.code)).not.toContain('version-too-old');
    expect(explain.policy.cooldown.tools.find((entry) => entry.tool === 'bundler')).toEqual({ tool: 'bundler', ok: false, reason: expect.stringMatching(/^Bundler 2\.6\.9 does not support cooldown \(added in 4\.0\.13\)/u) });
    expect((await exec('explain', root)).stdout).toMatch(/Bundler: cannot apply: Bundler 2\.6\.9 does not support cooldown/u);
  });

  it('a Deno too old for minimumDependencyAge cannot apply it', async () => {
    const root = repository({
      'deno.json': { imports: {}, nodeModulesDir: 'auto' },
      '.github/workflows/ci.yml': workflow('      - uses: denoland/setup-deno@v2\n        with:\n          deno-version: v2.5.6\n      - run: deno install --frozen\n'),
      'depcurfew.json': POLICY,
    });
    const explain = JSON.parse((await exec('explain', '--json', root)).stdout) as { policy: { cooldown: { tools: { tool: string; ok: boolean; reason?: string }[] } } };
    expect(explain.policy.cooldown.tools.find((entry) => entry.tool === 'deno')).toEqual({ tool: 'deno', ok: false, reason: expect.stringMatching(/^Deno 2\.5\.6 does not support minimumDependencyAge \(added in 2\.6\.0\)/u) });
  });
});

describe('Deno before 2.6.0 does not read allowScripts', () => {
  it('config-drift and apply do not say that allowScripts lets a package run its scripts', async () => {
    const root = repository({
      'deno.json': { imports: { sharp: 'npm:sharp@^0.34.4' }, nodeModulesDir: 'auto', allowScripts: ['npm:sharp'] },
      'deno.lock': { version: '5', specifiers: { 'npm:sharp@^0.34.4': '0.34.4' }, npm: { 'sharp@0.34.4': { integrity: 'sha512-x', scripts: true } }, workspace: { dependencies: ['npm:sharp@^0.34.4'] } },
      '.github/workflows/ci.yml': workflow('      - uses: denoland/setup-deno@v2\n        with:\n          deno-version: v2.5.6\n      - run: deno install --frozen\n'),
      'depcurfew.json': POLICY,
    });
    const found = await findings(root);
    expect(found.filter((finding) => /lets sharp run install scripts/u.test(finding.message))).toEqual([]);
    const drift = found.filter((finding) => finding.rule === 'config-drift');
    expect(drift.map((finding) => finding.message)).toEqual([expect.stringMatching(/^allowScripts in deno\.json lists sharp, which depcurfew\.json does not allow; Deno 2\.5\.6 does not read allowScripts \(added in 2\.6\.0\)/u)]);
    const report = applyProject(root, { write: false });
    const outside = report.warningDetails.filter((warning) => warning.code === 'allow-list-entry-outside-policy');
    expect(outside.map((warning) => warning.message)).toEqual([expect.stringMatching(/^Deno: allowScripts in deno\.json \(line \d+\) lists sharp, which depcurfew\.json does not allow; Deno 2\.5\.6 does not read allowScripts/u)]);
  });
});

describe('PIP_CONFIG_FILE that names the pip.conf of the repository', () => {
  const pipProject = (extra: Record<string, string>) =>
    repository({ 'requirements.txt': 'flask==3.1.2\n', 'pip.conf': '[global]\nonly-binary = :all:\n', 'depcurfew.json': POLICY, ...extra });

  it.each([
    ['a Dockerfile ENV', { Dockerfile: 'FROM python:3.13-slim\nWORKDIR /app\nCOPY pip.conf requirements.txt ./\nENV PIP_CONFIG_FILE=/app/pip.conf\nRUN pip install -r requirements.txt\n' }],
    ['the env of a CI job', { '.github/workflows/ci.yml': workflow('      - run: pip install -r requirements.txt\n', '    env:\n      PIP_CONFIG_FILE: pip.conf\n') }],
    ['the env of a CI step with the workspace', { '.github/workflows/ci.yml': workflow('      - run: pip install -r requirements.txt\n        env:\n          PIP_CONFIG_FILE: ${{ github.workspace }}/pip.conf\n') }],
  ])('is no python-config-ignored warning when %s sets it', async (_case, extra) => {
    const found = await findings(pipProject(extra), 'python-config-ignored');
    expect(found.filter((finding) => finding.location?.file === 'pip.conf')).toEqual([]);
  });

  it('still warns when PIP_CONFIG_FILE names another file', async () => {
    const found = await findings(pipProject({ Dockerfile: 'FROM python:3.13-slim\nCOPY requirements.txt ./\nENV PIP_CONFIG_FILE=/etc/pip-other.conf\nRUN pip install -r requirements.txt\n' }), 'python-config-ignored');
    expect(found.filter((finding) => finding.location?.file === 'pip.conf')).toHaveLength(1);
  });
});

describe('a project uses the version a root CI job pins for it', () => {
  it('apply reads the uv a job pins with working-directory set to the project', () => {
    const root = repository({
      'depcurfew.json': { ...POLICY, projects: ['backend'] },
      'backend/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n',
      'backend/uv.lock': UV_PROJECT['uv.lock'],
      '.github/workflows/ci.yml': workflow('      - uses: astral-sh/setup-uv@v7\n        with:\n          version: 0.13.2\n      - run: uv sync --locked\n', '    defaults:\n      run:\n        working-directory: backend\n'),
    });
    const report = applyProject(root, { write: false });
    expect(report.warningDetails.filter((warning) => warning.code === 'version-not-pinned' && warning.tool === 'uv')).toEqual([]);
  });

  it('but not one a job pins for several directories', () => {
    const root = repository({
      'depcurfew.json': { ...POLICY, projects: ['backend'] },
      'backend/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n',
      'backend/uv.lock': UV_PROJECT['uv.lock'],
      '.github/workflows/ci.yml': workflow('      - uses: astral-sh/setup-uv@v7\n        with:\n          version: 0.13.2\n      - run: uv sync --locked\n        working-directory: backend\n      - run: uv sync --locked\n        working-directory: tools\n'),
    });
    const report = applyProject(root, { write: false });
    expect(report.warningDetails.filter((warning) => warning.code === 'version-not-pinned' && warning.tool === 'uv')).toHaveLength(1);
  });
});

describe('apply and doctor on the npm of Node.js 24 from .nvmrc', () => {
  it('apply names the settings that npm lacks, as doctor does', async () => {
    const root = repository({
      'package.json': { name: 'app', version: '1.0.0', private: true },
      'package-lock.json': { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0' } } },
      '.nvmrc': '24\n',
      'depcurfew.json': POLICY,
    });
    const report = applyProject(root);
    const warning = report.warningDetails.find((entry) => entry.code === 'version-in-use-too-old');
    expect(warning).toMatchObject({ tool: 'npm', location: { file: '.nvmrc', line: 1 } });
    expect(warning?.message).toMatch(/^npm 11\.3\.0 to 11\.19\.1 \(with Node\.js 24 in \.nvmrc\) includes npm releases that do not support min-release-age and allow-git \(added in 11\.10\.0\)/u);
    const doctor = await findings(root, 'manager-version-too-old');
    expect(doctor.map((finding) => [finding.location?.file, finding.message])).toEqual([['.nvmrc', expect.stringMatching(/not all of which support min-release-age/u)]]);
  });
});
