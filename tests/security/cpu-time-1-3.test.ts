// Repository content cannot make doctor or explain run for minutes (decision D-121): a CI run step or a Dockerfile RUN
// of 1 MiB with tens of thousands of cd, export and NAME=value commands took 68 s and 85 s, because each command
// rebuilt the directory and copied every variable set before it; 32768 [tool.pdm.dev-dependencies] keys of one group
// took 5.4 s, and explain on 1600 projects 16.7 s. Before the fixes these tests ran into their timeouts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createContext, recordSettings } from '../../src/apply/generators/context.ts';
import { loadPolicyIfPresent } from '../../src/apply/index.ts';
import { Workspace } from '../../src/apply/workspace.ts';
import { parseToml } from '../../src/detect/toml.ts';
import { runDoctor } from '../../src/doctor/index.ts';
import { pdmHash } from '../../src/doctor/locked-settings.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';

const MIB = 1024 * 1024;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, sources: { git: 'deny' }, targets: 'auto' });

function repository(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'depcurfew-cpu-1-3-'));
  temporary.push(directory);
  for (const [file, text] of Object.entries({ 'depcurfew.json': POLICY, ...files })) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
  return directory;
}

function seconds(action: () => void): number {
  const start = performance.now();
  action();
  return (performance.now() - start) / 1000;
}

/** The prefix and lines after it, as many as fit in `size` bytes with the suffix (the most depcurfew reads is 1 MiB). */
function fill(prefix: string, line: (index: number) => string, size: number, suffix = ''): string {
  const lines: string[] = [prefix];
  let length = prefix.length + suffix.length;
  for (let index = 0; ; index++) {
    const text = line(index);
    if (length + text.length > size) break;
    lines.push(text);
    length += text.length;
  }
  lines.push(suffix);
  return lines.join('');
}

/** Runs doctor on the repository and checks that it read every file: none was too large. */
function doctorSeconds(root: string): number {
  let report: ReturnType<typeof runDoctor> | undefined;
  const time = seconds(() => (report = runDoctor(root)));
  expect(report?.notices.filter((notice) => notice.code === 'file-too-large')).toEqual([]);
  expect(report?.findings.filter((finding) => finding.rule === 'unreadable-config')).toEqual([]);
  return time;
}

const SETUP = '    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n';
const HEAD = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
/** A workflow of one job whose last run step is as long as 1 MiB allows. */
const workflow = (line: (index: number) => string) => fill(`${HEAD}${SETUP}      - run: |\n`, (index) => `          ${line(index)}\n`, MIB);
/** cd, export and NAME=value npm install, a third each. */
const mixed = (index: number) => (index % 3 === 0 ? 'cd a' : index % 3 === 1 ? `export V${index}=1` : `A${index}=1 npm install`);

describe('a CI run step or a Dockerfile RUN of 1 MiB', () => {
  it.each([
    ['cd commands', (index: number) => (index % 2 === 0 ? 'cd a' : 'cd ../b')],
    ['export and NAME=value npm install', (index: number) => (index % 2 === 0 ? `export V${index}=1` : 'A=1 npm install')],
    ['cd, export and installs', mixed],
  ])('takes doctor less than 2 s on a workflow of %s', { timeout: 120_000 }, (_name, line) => {
    const text = workflow(line);
    expect(text.length).toBeGreaterThan(MIB - 100);
    const root = repository({ 'package.json': '{}', '.github/workflows/ci.yml': text });
    expect(doctorSeconds(root)).toBeLessThan(2);
  });

  // A quarter of a MiB (11000 variables, 6500 steps): the YAML parser alone takes about 1.4 s for 1 MiB of such small
  // entries, and doctor reads the file twice.
  it('takes doctor less than 2 s on a workflow with thousands of env entries and steps', { timeout: 120_000 }, () => {
    const env = fill(`${HEAD}    env:\n`, (index) => `      V${index}: x\n`, MIB / 8, SETUP);
    const text = fill(env, () => '      - run: npm ci\n', MIB / 4);
    const root = repository({ 'package.json': '{}', '.github/workflows/ci.yml': text });
    expect(doctorSeconds(root)).toBeLessThan(2);
  });

  it.each([
    ['cd commands', (index: number) => (index % 2 === 0 ? 'cd a && ' : 'cd ../b && ')],
    ['export and NAME=value npm install', (index: number) => (index % 2 === 0 ? `export V${index}=1 && ` : 'A=1 npm install && ')],
    ['cd, export and installs', (index: number) => `${mixed(index)} && \\\n`],
  ])('takes doctor less than 2 s on a Dockerfile RUN of %s', { timeout: 120_000 }, (_name, line) => {
    const text = fill('FROM node:24\nRUN ', line, MIB, 'true\n');
    expect(text.length).toBeGreaterThan(MIB - 100);
    const root = repository({ 'package.json': '{}', Dockerfile: text });
    expect(doctorSeconds(root)).toBeLessThan(2);
  });

  it('takes doctor less than 2 s on a Dockerfile with thousands of ENV and stages', { timeout: 120_000 }, () => {
    const env = fill('FROM node:24 AS base\n', (index) => `ENV V${index}=1\n`, MIB / 2);
    const text = fill(env, (index) => (index % 2 === 0 ? 'FROM base\n' : 'RUN npm ci\n'), MIB);
    const root = repository({ 'package.json': '{}', Dockerfile: text });
    expect(doctorSeconds(root)).toBeLessThan(2);
  });
});

describe('the lockfiles of uv and PDM', () => {
  const PROJECT = '[project]\nname = "x"\nversion = "1"\n';
  const pdm = knowledgeBase.find((tool) => tool.id === 'pdm');

  it('computes the PDM hash of 32768 [tool.pdm.dev-dependencies] keys of one group in less than 1 s', { timeout: 120_000 }, () => {
    // dev, d-ev, d_ev, d-_ev …: every key normalizes to the same group, each with one requirement (5.4 s before).
    const keys = Array.from({ length: 32768 }, (_, index) => `"d${index.toString(2).replace(/0/gu, '-').replace(/1/gu, '_')}ev" = ["a"]\n`).join('');
    const pyproject = `${PROJECT}\n[tool.pdm.dev-dependencies]\n${keys}`;
    expect(pyproject.length).toBeGreaterThan(MIB / 2);
    if (pdm === undefined) throw new Error('PDM is not in the knowledge base');
    const lock = parseToml('[metadata]\ncontent_hash = "sha256:00"\n');
    const document = parseToml(pyproject);
    expect(seconds(() => expect(pdmHash(pdm, lock, document)).toEqual({ matches: false, line: 2 }))).toBeLessThan(1);
    // doctor as a whole, which reads the file several times.
    const root = repository({ 'pyproject.toml': pyproject, 'pdm.lock': '[metadata]\ncontent_hash = "sha256:00"\n' });
    let found: string[] = [];
    expect(seconds(() => (found = runDoctor(root).findings.map((finding) => finding.rule)))).toBeLessThan(5);
    expect(found).toContain('lockfile-out-of-date');
  });

  it('takes doctor less than 2 s on thousands of dependency groups', { timeout: 120_000 }, () => {
    const groups = fill(`${PROJECT}\n[dependency-groups]\n`, (index) => `g${index} = ["a", "b"]\n`, MIB / 2);
    const root = repository({ 'pyproject.toml': groups, 'pdm.lock': '[metadata]\ncontent_hash = "sha256:00"\n' });
    expect(seconds(() => runDoctor(root))).toBeLessThan(2);
  });

  // config-drift compared every changed line with every other one (20 s for half a MiB before).
  it('takes doctor less than 5 s on thousands of uv packages and exclude-newer-package entries', { timeout: 120_000 }, () => {
    const config = fill(`${PROJECT}\n[tool.uv]\nexclude-newer = "P3D"\n\n[tool.uv.exclude-newer-package]\n`, (index) => `p${index} = "P1D"\n`, MIB / 2);
    const options = fill('version = 1\n\n[options]\nexclude-newer = "0001-01-01T00:00:00Z"\nexclude-newer-span = "P3D"\n\n[options.exclude-newer-package]\n', (index) => `p${index} = { timestamp = "0001-01-01T00:00:00Z", span = "P2D" }\n`, MIB / 2);
    const lock = fill(options, (index) => `\n[[package]]\nname = "p${index}"\nversion = "1.0.0"\n`, MIB);
    const root = repository({ 'pyproject.toml': config, 'uv.lock': lock });
    let found: string[] = [];
    expect(seconds(() => (found = runDoctor(root).findings.map((finding) => finding.rule)))).toBeLessThan(5);
    expect(found).toEqual(expect.arrayContaining(['lockfile-out-of-date', 'config-drift']));
  });
});

describe('the settings explain shows', () => {
  // Each one was compared with every one before it (explain on 1600 projects took 16.7 s, apply --dry-run 5.2 s).
  it('keeps 20000 settings written twice once each, in less than 1 s', () => {
    const root = repository({ 'package.json': '{}' });
    const policy = loadPolicyIfPresent(root);
    const npm = knowledgeBase.find((tool) => tool.id === 'npm');
    if (policy === undefined || npm === undefined) throw new Error('no policy or no npm');
    const context = createContext({ tool: npm, tools: knowledgeBase, targets: new Set(['npm']), policy, version: undefined, workspace: new Workspace(root), warnings: [], snippets: [], failures: [] });
    let written: ReturnType<typeof recordSettings>['written'] = [];
    const time = seconds(() => {
      written = recordSettings(() => {
        for (let round = 0; round < 2; round++) for (let index = 0; index < 20_000; index++) context.writes('installScripts', `setting-${index}`, '.npmrc');
      }).written;
    });
    expect(written).toHaveLength(20_000);
    expect(written[19_999]).toEqual({ tool: 'npm', part: 'installScripts', setting: 'setting-19999', file: '.npmrc' });
    expect(time).toBeLessThan(1);
  });
});
