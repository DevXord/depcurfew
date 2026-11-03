// apply and init on what a repository already sets (decision D-167): the files a pip requirements file includes,
// stricter settings and exceptions kept, delays depcurfew cannot read, quoted and spaced TOML table names, allow-lists of
// the wrong type, [Global] in pip.conf, enableScripts: 1 in Yarn, and the approvals of the package managers' own
// allow-lists in init. No network; every directory is removed afterwards.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProject } from '../src/apply/index.ts';
import { editIncluded, formatControlAfter, formatControlFacts } from '../src/apply/pip-includes.ts';
import { run } from '../src/cli/run.ts';
import { requirementsLongOptions } from '../src/doctor/python.ts';
import { requirementsFormatOf } from '../src/doctor/python-lockfiles.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';
import { validatePolicy } from '../src/policy/validate.ts';
import type { ResolvedPolicy } from '../src/policy/schema.ts';
import { planUserApply, writeUserChanges } from '../src/user/apply.ts';
import { runUserDoctor } from '../src/user/doctor.ts';
import type { UserEnvironment } from '../src/user/locate.ts';
import { userPolicyPath } from '../src/user/policy-path.ts';
import { platform, userFileOf } from './support/user.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d167-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function repository(files: Record<string, string>, policy?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d167-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  if (policy !== undefined) writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, ...policy }, null, 2));
  return root;
}

const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
type Warning = { code: string; location?: { file: string; line?: number }; message: string; fix?: string };
const warnings = (report: { warningDetails: Warning[] }, code: string) => report.warningDetails.filter((warning) => warning.code === code);
const codes = (report: { warningDetails: Warning[] }) => report.warningDetails.map((warning) => warning.code).filter((code) => code !== 'version-not-pinned');

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

async function initJson(root: string): Promise<{ notices: { code: string; message: string; fix: string; location: { file: string; line?: number } }[] }> {
  const result = await exec('init', '--json', root);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as { notices: { code: string; message: string; fix: string; location: { file: string; line?: number } }[] };
}

const policyOf = (root: string) => JSON.parse(read(root, 'depcurfew.json')) as { cooldown: { minimum: string; exclude: string[]; securityUpdates: string }; installScripts: { allow: string[] }; sources: Record<string, string> };

const SUPERSEDED = '# depcurfew: superseded by the managed block: ';
const PIP = { installScripts: { default: 'deny', allow: [] }, targets: ['pip'] };

describe('pip: the files a requirements file includes keep the block', () => {
  it('comments out --no-binary <name> of a file included with -r, and doctor reports it before apply', () => {
    const root = repository({ 'requirements.txt': 'requests==2.32.3\n-r base.txt\n', 'base.txt': '--no-binary psycopg2\npsycopg2==2.9.9\n' }, PIP);
    const drift = runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift');
    expect(drift.find((finding) => finding.location?.file === 'base.txt')).toMatchObject({
      level: 'error',
      location: { file: 'base.txt', line: 1 },
      message: 'base.txt does not match depcurfew.json: `--no-binary psycopg2` is set outside the block that depcurfew manages; depcurfew apply comments it out, and the block sets what depcurfew.json requires',
    });
    const report = applyProject(root);
    expect(read(root, 'requirements.txt')).toContain('--only-binary=:all:');
    expect(read(root, 'base.txt')).toBe(`${SUPERSEDED}--no-binary psycopg2\npsycopg2==2.9.9\n`);
    expect(warnings(report, 'build-switch-undone')).toEqual([]);
    expect(applyProject(root).changes).toEqual([]);
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });

  it.each([
    ['--no-binary=:all:', 'base.txt'],
    ['--only-binary=:none:', 'constraints.txt'],
    ['--only-binary :all:,:none:', 'base.txt'],
    ['--no-bin :all:', 'base.txt'],
    ['--no-binary=:none:,psycopg2', 'base.txt'],
  ])('comments out %s in an included file', (line, file) => {
    const include = file === 'constraints.txt' ? '-c constraints.txt' : '-r base.txt';
    const root = repository({ 'requirements.txt': `flask==3.1.0\n${include}\n`, [file]: `${line}\n` }, PIP);
    applyProject(root);
    expect(read(root, file)).toBe(`${SUPERSEDED}${line}\n`);
  });

  it('follows includes as pip does, relative to the file that includes them, and stops at a loop', () => {
    const root = repository(
      { 'requirements.txt': '-r requirements/base.txt\n', 'requirements/base.txt': '-r ../common.txt\n-r base.txt\n', 'common.txt': '--no-binary=:all:\n-r requirements.txt\n' },
      PIP,
    );
    applyProject(root);
    expect(read(root, 'common.txt')).toBe(`${SUPERSEDED}--no-binary=:all:\n-r requirements.txt\n`);
  });

  it('keeps the lines that do not undo the block', () => {
    const lines = '--no-binary=:none:\n--only-binary=psycopg2\n--only-binary=:none:,:all:\n--no-binary=Sharp_Py\n--prefer-binary\n--index-url https://pypi.org/simple\n';
    const root = repository({ 'requirements.txt': '-r base.txt\n', 'base.txt': lines }, { installScripts: { default: 'deny', allow: ['pypi:sharp-py'] }, targets: ['pip'] });
    applyProject(root);
    expect(read(root, 'base.txt')).toBe(lines);
  });

  it('brings the lines back once the policy no longer forbids building', () => {
    const root = repository({ 'requirements.txt': '-r base.txt\n', 'base.txt': '--no-binary psycopg2\n' }, PIP);
    applyProject(root);
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, installScripts: { default: 'allow' }, targets: ['pip'] }));
    applyProject(root);
    expect(read(root, 'base.txt')).toBe('--no-binary psycopg2\n');
    expect(read(root, 'requirements.txt')).toBe('-r base.txt\n');
  });

  it('warns with file and line where it cannot comment a line out, and doctor reports it after apply', () => {
    const root = repository(
      {
        'requirements.txt': 'requests==2.32.3\n-r base.txt\npsycopg2==2.9.9 --no-binary psycopg2\n',
        'base.txt': '--index-url https://pypi.org/simple --only-binary=:none:\n--no-binary \\\n  :all:\n',
      },
      PIP,
    );
    const report = applyProject(root);
    expect(warnings(report, 'build-switch-undone')).toEqual([
      {
        code: 'build-switch-undone',
        tool: 'pip',
        location: { file: 'requirements.txt', line: 3 },
        message:
          'pip: --no-binary psycopg2 in requirements.txt (line 3) makes pip build psycopg2 from source, after the --only-binary=:all: of the managed block in requirements.txt; pip applies the options after a requirement to the whole install, and depcurfew apply does not comment the line out, which would remove the requirement',
        fix: 'Remove --no-binary psycopg2 from requirements.txt, or add the packages that must be built from source to installScripts.allow in depcurfew.json as pypi:<name>, then run depcurfew apply again',
      },
      expect.objectContaining({
        location: { file: 'base.txt', line: 1 },
        message: expect.stringMatching(/^pip: --only-binary :none: in base\.txt \(line 1\) lets pip build any package from source again, .*; the line sets other options too, so depcurfew apply does not comment it out$/u),
      }),
      expect.objectContaining({
        location: { file: 'base.txt', line: 2 },
        message: expect.stringMatching(/^pip: --no-binary :all: in base\.txt \(line 2\) makes pip build every package from source, .*; the line continues on the next one, so depcurfew apply does not comment it out$/u),
      }),
    ]);
    expect(read(root, 'base.txt')).toBe('--index-url https://pypi.org/simple --only-binary=:none:\n--no-binary \\\n  :all:\n');
    // After apply the block stands above the requirement, which is on line 6 now.
    const drift = runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift');
    expect(drift.map((finding) => [finding.level, finding.location?.file, finding.location?.line]).sort()).toEqual([
      ['error', 'base.txt', 1],
      ['error', 'base.txt', 2],
      ['error', 'requirements.txt', 6],
    ]);
  });

  it('warns about an include it cannot check: a URL, a path outside the repository, a missing file', () => {
    const root = repository({ 'requirements.txt': 'requests==2.32.3\n-r https://example.com/base.txt\n-c ../constraints.txt\n-r missing.txt\n' }, PIP);
    const report = applyProject(root);
    expect(warnings(report, 'requirements-include-unread').map((warning) => [warning.location, warning.message, warning.fix])).toEqual([
      [
        { file: 'requirements.txt', line: 2 },
        'pip: requirements.txt includes https://example.com/base.txt (line 2), which pip downloads, so depcurfew apply cannot check that it has no --no-binary or --only-binary=:none: line, which would undo the --only-binary=:all: of the managed block in requirements.txt',
        'Keep the included file in the repository as a regular file and include it by a relative path, then run depcurfew apply again; until then check by hand that it has no --no-binary or --only-binary=:none: line',
      ],
      [
        { file: 'requirements.txt', line: 3 },
        'pip: requirements.txt includes ../constraints.txt (line 3), which is outside the repository, so depcurfew apply cannot check that it has no --no-binary or --only-binary=:none: line, which would undo the --only-binary=:all: of the managed block in requirements.txt',
        'Keep the included file in the repository as a regular file and include it by a relative path, then run depcurfew apply again; until then check by hand that it has no --no-binary or --only-binary=:none: line',
      ],
      [
        { file: 'requirements.txt', line: 4 },
        'pip: requirements.txt includes missing.txt (line 4), which does not exist, so depcurfew apply cannot check that it has no --no-binary or --only-binary=:none: line, which would undo the --only-binary=:all: of the managed block in requirements.txt',
        'Create missing.txt or remove the line that includes it (pip stops when it cannot open an included file), then run depcurfew apply again',
      ],
    ]);
    // doctor reports such includes as files it cannot read (decision D-066).
    expect(runDoctor(root).findings.some((finding) => finding.rule === 'unreadable-config')).toBe(true);
  });

  it('reads FormatControl in the order pip does: a later include undoes --only-binary=:all:, an earlier one does not', () => {
    const pip = knowledgeBase.find((tool) => tool.id === 'pip');
    const facts = pip === undefined ? undefined : formatControlFacts(pip);
    if (pip === undefined || facts === undefined) throw new Error('pip facts');
    const format = requirementsFormatOf(pip);
    const reading = { facts, format, longOptions: requirementsLongOptions(format) };
    const files: Record<string, string> = {
      'after.txt': '--only-binary=:all:\n-r weak.txt\n',
      'before.txt': '-r weak.txt\n--only-binary=:all:\n',
      'line.txt': '--only-binary=:all:\nflask==3.1.0 --only-binary=:none:\n',
      'weak.txt': '--no-binary=:all:\n',
    };
    const after = (root: string) => formatControlAfter((file) => files[file], root, reading);
    expect(after('after.txt')).toEqual({ onlyAll: false, from: undefined });
    expect(after('before.txt')).toEqual({ onlyAll: true, from: 'before.txt' });
    expect(after('line.txt')).toEqual({ onlyAll: false, from: undefined });
    // A line commented out with the marker counts as a comment.
    expect(editIncluded('--no-binary=:all:\n', reading, new Set()).text).toBe(`${SUPERSEDED}--no-binary=:all:\n`);
  });

  it('lockfile-install-scripts does not count on --only-binary=:all: that an included file undoes', () => {
    const block = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\n--only-binary=:all:\n# <<< depcurfew managed block\n';
    const message = (base: string) => {
      const root = repository({ 'requirements.txt': `${block}-r base.txt\nfoo @ git+https://github.com/acme/foo\n`, 'base.txt': base }, PIP);
      return runDoctor(root).findings.find((finding) => finding.rule === 'lockfile-install-scripts')?.message;
    };
    expect(message('flask==3.1.0\n')).toContain('--only-binary=:all: in requirements.txt forbids building only for packages from an index');
    expect(message('--only-binary=:none:\n')).toBe('foo is built from source when installed (it comes from a git repository), which runs its build code, but depcurfew.json does not allow it');
  });
});

describe('TOML tables and keys as TOML reads them', () => {
  it.each(['[tool."uv"]', "[tool.'uv']", '[tool . uv]', '[ tool.uv ]'])('%s is the table [tool.uv]', (header) => {
    const root = repository({ 'pyproject.toml': `[project]\nname = "x"\nversion = "1"\n${header}\n"exclude-newer" = "1 day"\n`, 'uv.lock': 'version = 1\n' }, { cooldown: { minimum: '3d' }, targets: ['uv'] });
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(read(root, 'pyproject.toml')).toBe(
      `[project]\nname = "x"\nversion = "1"\n${header}\n${SUPERSEDED}"exclude-newer" = "1 day"\n\n# >>> depcurfew managed block [tool.uv]: edit depcurfew.json and run depcurfew apply instead\nexclude-newer = "3 days"\n# <<< depcurfew managed block\n`,
    );
    expect(applyProject(root).changes).toEqual([]);
  });

  it('a dotted key tool."uv".exclude-newer at the top level is commented out too', () => {
    const root = repository({ 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n', 'uv.toml': 'tool."uv".x = 1\n' }, { cooldown: { minimum: '3d' }, targets: ['uv'] });
    expect(applyProject(root).errors).toEqual([]);
  });

  it('["install"] in bunfig.toml is the table [install], for apply and doctor', () => {
    const root = repository(
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "bun@1.3.5"\n}\n', 'bun.lock': '{}', 'bunfig.toml': '["install"]\nregistry = "https://registry.npmjs.org/"\n' },
      { cooldown: { minimum: '3d' }, targets: 'auto' },
    );
    const report = applyProject(root);
    expect(report.errors).toEqual([]);
    expect(read(root, 'bunfig.toml')).toContain('["install"]\nregistry = "https://registry.npmjs.org/"\n\n# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nminimumReleaseAge = 259200\n');
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift')).toEqual([]);
  });
});

describe('an allow-list of another type than the tool reads is left as it is', () => {
  const policy = { installScripts: { default: 'deny', allow: ['esbuild'] }, targets: 'auto' };
  it.each([
    [
      'npm allowScripts as a list',
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "npm@11.17.0",\n  "allowScripts": ["sharp"]\n}\n' },
      'allowScripts',
      ['sharp'],
      'npm: allowScripts in package.json (line 4) is a list, not an object, so depcurfew apply does not write esbuild into it',
      'Write allowScripts in package.json as an object such as {"esbuild": true}, keeping the packages it names, then run depcurfew apply again',
    ],
    [
      'Bun trustedDependencies as an object',
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "bun@1.3.5",\n  "trustedDependencies": {"sharp": true}\n}\n', 'bun.lock': '{}' },
      'trustedDependencies',
      { sharp: true },
      'Bun: trustedDependencies in package.json (line 4) is an object, not a list, so depcurfew apply does not write esbuild into it',
      'Write trustedDependencies in package.json as a list such as ["esbuild"], keeping the packages it names, then run depcurfew apply again',
    ],
    [
      'Yarn dependenciesMeta as a list',
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.12.0",\n  "dependenciesMeta": ["sharp"]\n}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'nodeLinker: node-modules\n' },
      'dependenciesMeta',
      ['sharp'],
      'Yarn (Berry): dependenciesMeta in package.json (line 4) is a list, not an object, so depcurfew apply does not write esbuild into it',
      'Write dependenciesMeta in package.json as an object such as {"esbuild": {"built": true}}, keeping the packages it names, then run depcurfew apply again',
    ],
  ])('%s', (_name, files, key, value, message, fix) => {
    const root = repository(files, policy);
    const report = applyProject(root);
    expect((JSON.parse(read(root, 'package.json')) as Record<string, unknown>)[key]).toEqual(value);
    expect(warnings(report, 'unexpected-value')).toEqual([{ code: 'unexpected-value', tool: expect.any(String), location: { file: 'package.json', line: 4 }, message, fix }]);
    expect(report.errors).toEqual([]);
  });

  it('pnpm allowBuilds as a list and a Yarn package entry that is not an object stay too', () => {
    const pnpm = repository(
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "pnpm@11.4.2"\n}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'allowBuilds:\n  - sharp\n' },
      policy,
    );
    expect(codes(applyProject(pnpm))).toContain('unexpected-value');
    expect(read(pnpm, 'pnpm-workspace.yaml')).toContain('allowBuilds:\n  - sharp\n');
    const yarn = repository(
      {
        'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.12.0",\n  "dependenciesMeta": {"esbuild": true}\n}\n',
        'yarn.lock': '__metadata:\n  version: 8\n',
        '.yarnrc.yml': 'nodeLinker: node-modules\n',
      },
      policy,
    );
    expect(warnings(applyProject(yarn), 'unexpected-value').map((warning) => warning.message)).toEqual([
      'Yarn (Berry): dependenciesMeta.esbuild in package.json (line 4) is true, not an object, so depcurfew apply does not write esbuild into it',
    ]);
  });
});

describe('Yarn reads enableScripts: 1 and "true" as true', () => {
  it.each(['1', '"true"', '"1"'])('enableScripts: %s is replaced with allow-all-replaced', (value) => {
    const root = repository(
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.12.0"\n}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': `enableScripts: ${value}\n` },
      { installScripts: { default: 'deny' }, targets: 'auto' },
    );
    const report = applyProject(root);
    expect(read(root, '.yarnrc.yml')).toContain('enableScripts: false');
    expect(warnings(report, 'allow-all-replaced')[0]?.message).toBe(
      `Yarn (Berry): enableScripts: ${JSON.stringify(value === '1' ? 1 : JSON.parse(value))} in .yarnrc.yml (line 1) allowed every install script (Yarn (Berry) reads every value but false, 0, "false" and "0" as true, or stops on it); set to false because the policy denies install scripts`,
    );
  });

  it('enableScripts: 0 and "false" are off already', () => {
    for (const value of ['0', '"false"']) {
      const root = repository(
        { 'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.12.0"\n}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': `enableScripts: ${value}\n` },
        { installScripts: { default: 'deny' }, targets: 'auto' },
      );
      expect(codes(applyProject(root))).not.toContain('allow-all-replaced');
    }
  });
});

describe('delays depcurfew could not read', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-03T12:00:00Z'), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fixed date of Deno, uv and PDM counts as the whole days since it: cooldown-shortened', () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ 'deno.json': '{\n  "minimumDependencyAge": "2024-01-01T00:00:00Z"\n}\n' }, 'deno.json', 'Deno: minimumDependencyAge: "2024-01-01T00:00:00Z" in deno.json (line 2), a fixed date 1038 days ago, holds back every version uploaded since'],
      [{ 'deno.json': '{\n  "minimumDependencyAge": { "age": "2024-01-01", "exclude": ["npm:foo"] }\n}\n' }, 'deno.json', 'Deno: minimumDependencyAge: "2024-01-01" in deno.json (line 2), a fixed date 1038 days ago'],
      [{ 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n[tool.uv]\nexclude-newer = "2024-01-01T00:00:00Z"\n', 'uv.lock': 'version = 1\n' }, 'pyproject.toml', 'uv: exclude-newer = "2024-01-01T00:00:00Z" in pyproject.toml (line 5), a fixed date 1038 days ago'],
      [{ 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n[tool.pdm]\ndistribution = false\n[tool.pdm.resolution]\nexclude-newer = "2024-01-01"\n' }, 'pyproject.toml', 'PDM: exclude-newer = "2024-01-01" in pyproject.toml (line 7), a fixed date 1038 days ago'],
    ];
    for (const [files, file, start] of cases) {
      const root = repository(files, { cooldown: { minimum: '3d' }, targets: 'auto' });
      const shortened = warnings(applyProject(root), 'cooldown-shortened');
      expect(shortened, file).toHaveLength(1);
      expect(shortened[0]?.message.startsWith(start), shortened[0]?.message).toBe(true);
      expect(shortened[0]?.fix).toBe(
        'To keep a delay at least that long, set cooldown.minimum to "1038d" in depcurfew.json and run depcurfew apply again; depcurfew.json sets a delay that moves with time, not a fixed date',
      );
    }
  });

  it('a date in the future holds nothing back, so replacing it shortens nothing', () => {
    const root = repository({ 'deno.json': '{\n  "minimumDependencyAge": "2099-01-01"\n}\n' }, { cooldown: { minimum: '3d' }, targets: 'auto' });
    const report = applyProject(root);
    expect(codes(report)).not.toContain('cooldown-shortened');
    expect(read(root, 'deno.json')).toBe('{\n  "minimumDependencyAge": 4320\n}\n');
  });

  it('a value it cannot read stays as it is, with cooldown-not-written', () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ 'composer.json': '{\n  "config": {"policy": {"cooldown": {"period": "1 month"}}}\n}\n' }, 'composer.json', 'Composer: cooldown not written: config.policy.cooldown.period in composer.json (line 2) is "1 month", which depcurfew cannot read ("1 month" is not a duration Composer understands), so depcurfew apply leaves it as it is instead of replacing a delay that may be longer than cooldown.minimum'],
      [{ 'composer.json': '{\n  "config": {"policy": {"cooldown": {"period": "P30D"}}}\n}\n' }, 'composer.json', 'Composer: cooldown not written: config.policy.cooldown.period in composer.json (line 2) is "P30D"'],
      [{ 'composer.json': '{\n  "config": {"policy": {"cooldown": {"period": "30d"}}}\n}\n' }, 'composer.json', 'Composer: cooldown not written: config.policy.cooldown.period in composer.json (line 2) is "30d"'],
      [{ 'deno.json': '{\n  "minimumDependencyAge": "3 days"\n}\n' }, 'deno.json', 'Deno: cooldown not written: minimumDependencyAge in deno.json (line 2) is "3 days"'],
      [{ 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n[tool.uv]\nexclude-newer = "2 weeks, 3 days"\n', 'uv.lock': 'version = 1\n' }, 'pyproject.toml', 'uv: cooldown not written: exclude-newer in pyproject.toml (line 5) is "2 weeks, 3 days"'],
    ];
    for (const [files, file, start] of cases) {
      const root = repository(files, { cooldown: { minimum: '3d' }, installScripts: { default: 'deny', allow: [] }, targets: 'auto' });
      const before = read(root, file);
      const report = applyProject(root);
      const notWritten = warnings(report, 'cooldown-not-written');
      expect(notWritten, file).toHaveLength(1);
      expect(notWritten[0]?.message.startsWith(start), notWritten[0]?.message).toBe(true);
      expect(notWritten[0]?.location?.line).toBe(file === 'pyproject.toml' ? 5 : 2);
      const after = report.changes.find((change) => change.file === file)?.after ?? before;
      expect(after).toContain(file === 'pyproject.toml' ? 'exclude-newer = "2 weeks, 3 days"\n' : before.includes('"1 month"') ? '"1 month"' : before.slice(before.indexOf('"', 10), before.indexOf('"', 10) + 6));
    }
  });

  it('init keeps a fixed date as the whole days since it', async () => {
    const root = repository({ 'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n[tool.uv]\nexclude-newer = "2024-01-01T00:00:00Z"\n', 'uv.lock': 'version = 1\n' });
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).cooldown.minimum).toBe('1038d');
    expect(notices.find((notice) => notice.code === 'cooldown-kept')?.message).toBe(
      'cooldown.minimum is 1038d instead of 3d, to keep the longest release-age delay already set: exclude-newer = "2024-01-01T00:00:00Z" in pyproject.toml (line 5), a fixed date 1038 days ago',
    );
    expect(codes(applyProject(root))).not.toContain('cooldown-shortened');
  });
});

describe('a repository stricter than the default policy', () => {
  const npm = { 'package.json': '{\n  "name": "app",\n  "private": true,\n  "packageManager": "npm@11.21.1"\n}\n', 'package-lock.json': '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "app"\n    }\n  }\n}\n' };

  it('init keeps allow-file=none in sources; apply warns when it turns none or root into all', async () => {
    const root = repository({ ...npm, '.npmrc': 'min-release-age=14\nallow-file=none\nallow-directory=root\n' });
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).sources).toEqual({ git: 'deny', remoteTarball: 'deny', file: 'deny', directory: 'allow' });
    expect(notices.find((notice) => notice.code === 'sources-kept')).toEqual({
      code: 'sources-kept',
      level: 'note',
      location: { file: '.npmrc', line: 2 },
      message: 'sources.file is "deny" instead of "allow", to keep what the repository already sets: allow-file=none in .npmrc (line 2); depcurfew apply then denies local tarball dependencies for every package manager it configures',
      fix: 'Leave sources.file as it is to keep them out, or set it to "allow" in depcurfew.json before you run depcurfew apply',
    });
    const report = applyProject(root);
    expect(read(root, '.npmrc')).toContain('allow-file=none\n');
    expect(warnings(report, 'source-loosened')).toEqual([
      {
        code: 'source-loosened',
        tool: 'npm',
        location: { file: '.npmrc', line: 3 },
        message: 'npm: allow-directory=root in .npmrc (line 3) allows local directory dependencies only where the root package.json names them; because sources.directory is "allow" in depcurfew.json, depcurfew apply comments it out and writes allow-directory=all, so npm installs them for every package',
        fix: 'depcurfew.json has no value for root: to keep such dependencies out, set sources.directory to "deny" (allow-directory=none) in depcurfew.json and run depcurfew apply again; keep "allow" if the project needs them',
      },
    ]);
    expect(warnings(applyProject(root), 'source-loosened')).toEqual([]);
  });

  it('apply warns when "allow" replaces allow-file=none it did not write', () => {
    const root = repository({ ...npm, '.npmrc': 'allow-file=none\n' }, { sources: { file: 'allow' }, targets: 'auto' });
    expect(warnings(applyProject(root), 'source-loosened').map((warning) => warning.message)).toEqual([
      'npm: allow-file=none in .npmrc (line 1) blocks local tarball dependencies; because sources.file is "allow" in depcurfew.json, depcurfew apply comments it out and writes allow-file=all, so npm installs them again',
    ]);
  });

  it('pnpm blockExoticSubdeps: true and a Yarn list without ** are loosened with a warning', () => {
    const pnpm = repository(
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "pnpm@11.4.2"\n}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'blockExoticSubdeps: true\n' },
      { sources: { git: 'allow', remoteTarball: 'allow' }, targets: 'auto' },
    );
    expect(warnings(applyProject(pnpm), 'source-loosened').map((warning) => warning.message)).toEqual([
      'pnpm: blockExoticSubdeps: true in pnpm-workspace.yaml (line 1) blocks git and tarball sources of indirect dependencies; because sources.git and sources.remoteTarball are "allow" in depcurfew.json, depcurfew apply sets it to false, so pnpm installs them again',
    ]);
    const yarn = repository(
      { 'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.18.1"\n}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'approvedGitRepositories:\n  - github.com/acme/*\n' },
      { sources: { git: 'allow' }, targets: 'auto' },
    );
    expect(warnings(applyProject(yarn), 'source-loosened').map((warning) => warning.message)).toEqual([
      'Yarn (Berry): approvedGitRepositories: ["github.com/acme/*"] in .yarnrc.yml (line 1) approves only the git repositories it lists; because sources.git is "allow" in depcurfew.json, depcurfew apply sets it to ["**"], so Yarn (Berry) installs from any git repository',
    ]);
  });

  it('init keeps a Renovate delay of security updates; apply with "bypass" warns that it removes it', async () => {
    const root = repository({ ...npm, 'renovate.json': '{\n  "minimumReleaseAge": "14 days",\n  "vulnerabilityAlerts": {\n    "minimumReleaseAge": "3 days"\n  }\n}\n' });
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).cooldown.securityUpdates).toBe('delay');
    expect(notices.find((notice) => notice.code === 'security-delay-kept')?.message).toBe(
      'cooldown.securityUpdates is "delay" instead of "bypass", to keep the delay of security updates already set: vulnerabilityAlerts.minimumReleaseAge "3 days" in renovate.json (line 4); depcurfew apply then gives security updates the delay of cooldown.minimum',
    );
    expect((JSON.parse(applyProject(root, { write: false }).changes.find((change) => change.file === 'renovate.json')?.after ?? '{}') as { vulnerabilityAlerts: { minimumReleaseAge: unknown } }).vulnerabilityAlerts.minimumReleaseAge).toBe('14 days');
    writeFileSync(join(root, 'depcurfew.json'), JSON.stringify({ version: 1, cooldown: { minimum: '14d', securityUpdates: 'bypass' }, targets: 'auto' }));
    expect(warnings(applyProject(root, { write: false }), 'security-delay-removed')).toEqual([
      {
        code: 'security-delay-removed',
        tool: 'renovate',
        location: { file: 'renovate.json', line: 4 },
        message: 'Renovate: vulnerabilityAlerts.minimumReleaseAge "3 days" in renovate.json (line 4) delays security updates by 3 days; because cooldown.securityUpdates is "bypass" in depcurfew.json, depcurfew apply sets it to null, so Renovate proposes security updates at once',
        fix: 'To keep a delay, set cooldown.securityUpdates to "delay" in depcurfew.json (security updates then wait as long as cooldown.minimum) and run depcurfew apply again; if an earlier depcurfew apply wrote this value and you changed cooldown.securityUpdates on purpose, nothing to do',
      },
    ]);
  });

  const exceptions = {
    'package.json': '{\n  "name": "x",\n  "packageManager": "pnpm@11.4.2"\n}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n  - foo\n  - "@acme/*"\n',
    'pyproject.toml': '[project]\nname = "x"\nversion = "1"\n[tool.uv]\nexclude-newer-package = { internal-tools = false, slow = "30 days" }\n',
    'uv.lock': 'version = 1\n',
    '.github/dependabot.yml': 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: daily\n    cooldown:\n      default-days: 3\n      exclude:\n        - foo\n',
  };

  it('init lists the exceptions the tools already have in cooldown.exclude, and apply keeps them', async () => {
    const root = repository(exceptions);
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).cooldown.exclude).toEqual(['@acme/*', 'foo', 'pypi:internal-tools']);
    expect(notices.find((notice) => notice.code === 'exclusions-kept')).toEqual({
      code: 'exclusions-kept',
      level: 'note',
      location: { file: 'pnpm-workspace.yaml', line: 2 },
      message:
        'cooldown.exclude lists the packages the repository already exempts from the release-age delay, so that depcurfew apply keeps them: foo and @acme/* (minimumReleaseAgeExclude in pnpm-workspace.yaml, line 2); pypi:internal-tools (exclude-newer-package in pyproject.toml, line 5); foo (cooldown.exclude in .github/dependabot.yml, line 9, npm updates)',
      fix: 'Review each one before you run depcurfew apply: cooldown.exclude exempts it in every tool depcurfew configures, so remove the ones that do not need the exception from depcurfew.json',
    });
    expect(codes(applyProject(root))).not.toContain('exclusion-dropped');
  });

  it('init does not spread an exception that matches every package', async () => {
    const root = repository({ ...exceptions, 'pnpm-workspace.yaml': 'minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n  - foo\n  - "@*/*"\n' });
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).cooldown.exclude).toEqual(['foo', 'pypi:internal-tools']);
    expect(notices.find((notice) => notice.code === 'exclusions-kept')?.message).toMatch(/; init leaves out @\*\/\*, which matches every package \(depcurfew doctor reports it as broad-exclusion\)$/u);
  });

  it('apply warns when it drops an exception it did not write, and keeps it as a comment in YAML', () => {
    const root = repository(exceptions, { cooldown: { minimum: '3d', exclude: [] }, targets: 'auto' });
    const report = applyProject(root);
    expect(warnings(report, 'exclusion-dropped').map((warning) => [warning.location, warning.message, warning.fix])).toEqual([
      [
        { file: 'pnpm-workspace.yaml', line: 2 },
        'pnpm: minimumReleaseAgeExclude in pnpm-workspace.yaml (line 2) exempts foo and @acme/* from the release-age delay, but cooldown.exclude in depcurfew.json does not; depcurfew apply comments them out, so pnpm delays them like every other package',
        'To keep the exceptions, add "foo" and "@acme/*" to cooldown.exclude in depcurfew.json and run depcurfew apply again',
      ],
      [
        { file: 'pyproject.toml', line: 5 },
        'uv: exclude-newer-package in pyproject.toml (line 5) exempts internal-tools from the release-age delay, but cooldown.exclude in depcurfew.json does not; depcurfew apply comments it out, so uv delays it like every other package',
        'To keep the exception, add "pypi:internal-tools" to cooldown.exclude in depcurfew.json and run depcurfew apply again',
      ],
      [
        { file: '.github/dependabot.yml', line: 9 },
        'Dependabot: cooldown.exclude in .github/dependabot.yml (line 9) for npm updates exempts foo from the release-age delay, but cooldown.exclude in depcurfew.json does not; depcurfew apply comments it out, so Dependabot delays it like every other package',
        'To keep the exception, add "foo" to cooldown.exclude in depcurfew.json and run depcurfew apply again',
      ],
    ]);
    expect(read(root, 'pnpm-workspace.yaml')).toBe(`minimumReleaseAge: 4320\n${SUPERSEDED}minimumReleaseAgeExclude: ["foo","@acme/*"]\n# managed by depcurfew\nminimumReleaseAgeExclude: []\n# managed by depcurfew\nminimumReleaseAgeStrict: true\n`);
    expect(read(root, '.github/dependabot.yml')).toContain(`      ${SUPERSEDED}exclude: ["foo"]\n      # managed by depcurfew\n      exclude: []\n`);
    const second = applyProject(root);
    expect(second.changes).toEqual([]);
    expect(codes(second)).not.toContain('exclusion-dropped');
  });
});

describe('init carries the approvals of the package managers own allow-lists into installScripts.allow', () => {
  it.each([
    ['pnpm allowBuilds', { 'package.json': '{\n  "name": "x",\n  "packageManager": "pnpm@11.4.2"\n}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'allowBuilds:\n  sharp: true\n  core-js: false\n' }, 'allowBuilds in pnpm-workspace.yaml, line 2'],
    ['Bun trustedDependencies', { 'package.json': '{\n  "name": "x",\n  "packageManager": "bun@1.4.4",\n  "trustedDependencies": ["sharp"]\n}\n', 'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": {},\n  "packages": {}\n}\n' }, 'trustedDependencies in package.json, line 4'],
    ['Yarn dependenciesMeta', { 'package.json': '{\n  "name": "x",\n  "packageManager": "yarn@4.18.1",\n  "dependenciesMeta": {"sharp": {"built": true}}\n}\n', 'yarn.lock': '__metadata:\n  version: 8\n', '.yarnrc.yml': 'nodeLinker: node-modules\n' }, 'dependenciesMeta in package.json, line 4'],
    ['npm allowScripts', { 'package.json': '{\n  "name": "x",\n  "packageManager": "npm@11.21.1",\n  "allowScripts": {"sharp": true}\n}\n', 'package-lock.json': '{\n  "name": "x",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "x"\n    }\n  }\n}\n' }, 'allowScripts in package.json, line 4'],
  ])('%s', async (_name, files, where) => {
    const root = repository(files);
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).installScripts.allow).toEqual(['sharp']);
    expect(notices.find((notice) => notice.code === 'install-scripts-kept')?.message).toBe(
      `installScripts.allow lists the packages that the package managers' own allow-lists already let run install scripts, so that depcurfew apply and depcurfew doctor keep them allowed: sharp (${where})`,
    );
    applyProject(root);
    const outside = runDoctor(root).findings.filter((finding) => /does not allow it|allow-list-entry-outside-policy/u.test(finding.message));
    expect(outside).toEqual([]);
  });

  it('a known package that a project list allows goes into installScripts.allow with a hint, not into installScripts.deny', async () => {
    const root = repository({ 'package.json': '{\n  "name": "x",\n  "packageManager": "pnpm@11.4.2"\n}\n', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' });
    const notices = (await initJson(root)).notices;
    expect(policyOf(root).installScripts).toEqual({ default: 'deny', allow: ['esbuild'], deny: [] });
    expect(notices.find((notice) => notice.code === 'install-scripts-kept')?.message).toContain(
      'esbuild (allowBuilds in pnpm-workspace.yaml, line 2; depcurfew knows it works without its install script, so installScripts.deny may suit it better)',
    );
  });

  it('a bun.lock that marks no package with install scripts gets install-scripts-not-recorded, as in doctor', async () => {
    const root = repository({
      'package.json': '{\n  "name": "x",\n  "packageManager": "bun@1.3.5",\n  "dependencies": {"left-pad": "1.3.0"}\n}\n',
      'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "x",\n      "dependencies": { "left-pad": "1.3.0" }\n    }\n  },\n  "packages": {\n    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-x"]\n  }\n}\n',
    });
    const notices = (await initJson(root)).notices;
    expect(notices.find((notice) => notice.code === 'install-scripts-not-recorded')?.message).toBe(
      'init cannot tell from bun.lock which packages have install scripts (it marks no package with install scripts, and Bun records them only since 1.4.4, so an older lockfile may hide some), so it names only the packages depcurfew knows, and installScripts.default "deny" blocks the scripts of the others',
    );
  });
});

describe('pip.conf: only [global] is the global section', () => {
  function policy(document: unknown): ResolvedPolicy {
    const result = validatePolicy(document);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.policy;
  }
  function machine(): UserEnvironment {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-d167-user-'));
    temporary.push(root);
    const home = join(root, 'home');
    const venv = join(root, 'venv');
    const info = join(venv, 'lib', 'python3.12', 'site-packages', 'pip-26.2.2.dist-info');
    mkdirSync(home, { recursive: true });
    mkdirSync(info, { recursive: true });
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(info, 'METADATA'), 'Metadata-Version: 2.4\nName: pip\nVersion: 26.2.2\n');
    writeFileSync(join(info, 'entry_points.txt'), '[console_scripts]\npip = pip._internal.cli.main:main\n');
    writeFileSync(join(venv, 'bin', 'pip'), '#!/usr/bin/python3\n');
    return { platform, home, env: { PATH: join(venv, 'bin') } };
  }
  const POLICY = policy({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: 'auto' });
  const BLOCK = '# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead\nuploaded-prior-to = P3D\nonly-binary = :all:\n# <<< depcurfew managed block\n';

  it.each(['[Global]', '[ global ]'])('%s is another section: the block goes into a real [global], and its keys stay', (header) => {
    const environment = machine();
    const file = userFileOf('pip', environment);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${header}\nno-binary = :all:\n`);
    const planned = planUserApply(POLICY, { environment });
    const after = planned.report.changes.find((change) => change.path === file)?.after;
    expect(after).toBe(`${header}\nno-binary = :all:\n\n[global]\n${BLOCK}`);
    writeUserChanges(planned);
    expect(planUserApply(POLICY, { environment }).report.changes).toEqual([]);
    // pip ignores the section, so doctor --user does not count its keys as global ones.
    const policyFile = userPolicyPath(environment);
    mkdirSync(dirname(policyFile), { recursive: true });
    writeFileSync(policyFile, JSON.stringify({ version: 1, cooldown: { minimum: '3d' }, installScripts: { default: 'deny' }, targets: 'auto' }));
    expect(runUserDoctor({ environment }).findings).toEqual([]);
  });
});
