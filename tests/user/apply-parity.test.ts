// apply --user does for a key in a user file what apply does for the same key in a project file: it supersedes
// hand-written exclusions and build allow-lists, warns about allow-list entries it does not remove, about a delay it
// shortens, about before= next to min-release-age and about parts of the policy the user file cannot hold. The home
// directory and PATH are temporary directories.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Version } from '../../src/apply/version.ts';
import { knowledgeBase } from '../../src/knowledge/index.ts';
import type { ToolId } from '../../src/knowledge/types.ts';
import type { ResolvedPolicy } from '../../src/policy/schema.ts';
import { validatePolicy } from '../../src/policy/validate.ts';
import { planUserApply, writeUserChanges } from '../../src/user/apply.ts';
import { userFileFor, userFilePath, type UserEnvironment } from '../../src/user/locate.ts';
import { platform, shownPolicy, shownUserFile } from '../support/user.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function policy(document: Record<string, unknown>): ResolvedPolicy {
  const result = validatePolicy({ version: 1, ...document });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

/** The default policy of init --user, for the given tools. */
const DEFAULT = {
  cooldown: { minimum: '3d', exclude: [] },
  installScripts: { default: 'deny', allow: [], deny: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
};

const USER_MARKER = '# >>> depcurfew managed block: edit the user depcurfew.json and run depcurfew apply --user instead';
const SUPERSEDED = '# depcurfew: superseded by the managed block: ';

function machine(): UserEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-parity-'));
  temporary.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  return { platform, home, env: { PATH: join(root, 'bin') } };
}

function userPath(id: ToolId, environment: UserEnvironment, version?: Version): string {
  const tool = knowledgeBase.find((candidate) => candidate.id === id);
  const file = tool === undefined ? null : userFileFor(tool, version);
  const path = file === null ? undefined : userFilePath(file, environment);
  if (path === undefined) throw new Error(`no user file for ${id}`);
  return path;
}

function write(id: ToolId, environment: UserEnvironment, text: string, version?: Version): void {
  const path = userPath(id, environment, version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Planned = ReturnType<typeof planUserApply>;
const plan = (document: Record<string, unknown>, environment: UserEnvironment, versions: Partial<Record<ToolId, Version>>) =>
  planUserApply(policy(document), { environment, versions });
const after = (planned: Planned, id: ToolId, environment: UserEnvironment, version?: Version) =>
  planned.report.changes.find((change) => change.file === shownUserFile(id, environment, version))?.after;
const warningsOf = (planned: Planned, code: string) => planned.report.warningDetails.filter((warning) => warning.code === code);
const codes = (planned: Planned) => planned.report.warningDetails.map((warning) => `${warning.tool ?? ''}:${warning.code}`);

/** Plans, writes and plans again: the second plan has to change nothing. */
function applyTwice(document: Record<string, unknown>, environment: UserEnvironment, versions: Partial<Record<ToolId, Version>>): Planned {
  const first = plan(document, environment, versions);
  expect(first.report.errors).toEqual([]);
  writeUserChanges(first);
  expect(plan(document, environment, versions).report.changes).toEqual([]);
  return first;
}

describe('hand-written weakening values in user files with an empty policy list', () => {
  it('warns about allow-scripts entries in ~/.npmrc the policy does not allow, and keeps them (npm 11 and 12)', () => {
    for (const version of [
      [11, 21, 1],
      [12, 2, 1],
    ] as Version[]) {
      const environment = machine();
      write('npm', environment, 'save-exact=true\nallow-scripts=sharp,esbuild\n');
      const planned = plan({ ...DEFAULT, targets: ['npm'] }, environment, { npm: version });
      expect(after(planned, 'npm', environment)).toContain('allow-scripts=sharp,esbuild\n');
      expect(warningsOf(planned, 'allow-list-entry-outside-policy')).toEqual([
        {
          code: 'allow-list-entry-outside-policy',
          tool: 'npm',
          location: { file: '~/.npmrc', line: 2 },
          message: `allow-scripts in ~/.npmrc lets sharp run install scripts, but ${shownPolicy(environment)} does not allow it; depcurfew apply --user does not remove entries it did not write`,
          fix: `Remove sharp from allow-scripts in ~/.npmrc by hand, or add sharp to installScripts.allow in ${shownPolicy(environment)}`,
        },
        expect.objectContaining({ code: 'allow-list-entry-outside-policy', message: expect.stringContaining('lets esbuild run install scripts') }),
      ]);
    }
  });

  it('does not warn about allow-scripts entries the policy allows, nor about a key the npm version does not read', () => {
    const environment = machine();
    write('npm', environment, 'allow-scripts=sharp\n');
    const allowed = plan({ ...DEFAULT, installScripts: { default: 'deny', allow: ['sharp'] }, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(warningsOf(allowed, 'allow-list-entry-outside-policy')).toEqual([]);
    // The policy's own list supersedes the hand-written line.
    expect(after(allowed, 'npm', environment)).toContain(`${SUPERSEDED}allow-scripts=sharp`);
    const old = plan({ ...DEFAULT, targets: ['npm'] }, environment, { npm: [11, 12, 0] });
    expect(warningsOf(old, 'allow-list-entry-outside-policy')).toEqual([]);
  });

  it('warns about only-built-dependencies entries in the pnpm 10 rc', () => {
    const environment = machine();
    write('pnpm', environment, 'only-built-dependencies[]=sharp\n', [10, 34, 9]);
    const planned = plan({ ...DEFAULT, targets: ['pnpm'] }, environment, { pnpm: [10, 34, 9] });
    expect(warningsOf(planned, 'allow-list-entry-outside-policy').map((warning) => warning.message)).toEqual([
      `only-built-dependencies in ${shownUserFile('pnpm', environment, [10, 34, 9])} lets sharp run install scripts, but ${shownPolicy(environment)} does not allow it; depcurfew apply --user does not remove entries it did not write`,
    ]);
  });

  it('supersedes minimum-release-age-exclude in the pnpm 10 rc, restorably', () => {
    const environment = machine();
    write('pnpm', environment, 'minimum-release-age-exclude[]=*\n', [10, 34, 9]);
    applyTwice({ ...DEFAULT, targets: ['pnpm'] }, environment, { pnpm: [10, 34, 9] });
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['pnpm'] }, environment, { pnpm: [10, 34, 9] });
    expect(after(planned, 'pnpm', environment, [10, 34, 9])).toContain(`${SUPERSEDED}minimum-release-age-exclude[]=*`);
    // Without cooldown in the policy, the line comes back.
    const without = plan({ installScripts: { default: 'deny' }, targets: ['pnpm'] }, environment, { pnpm: [10, 34, 9] });
    expect(after(without, 'pnpm', environment, [10, 34, 9])).toMatch(/^minimum-release-age-exclude\[\]=\*$/mu);
  });

  it('empties minimumReleaseAgeExclude in the pnpm 11 config.yaml and npmPreapprovedPackages in ~/.yarnrc.yml', () => {
    const environment = machine();
    write('pnpm', environment, 'minimumReleaseAgeExclude: ["*"]\n', [11, 28, 10]);
    write('yarn', environment, 'npmPreapprovedPackages: ["*"]\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['pnpm', 'yarn'] }, environment, { pnpm: [11, 28, 10], yarn: [4, 18, 1] });
    expect(after(planned, 'pnpm', environment, [11, 28, 10])).toContain('minimumReleaseAgeExclude: []');
    expect(after(planned, 'yarn', environment)).toContain('npmPreapprovedPackages: []');
  });

  it('supersedes Poetry solver.min-release-age-exclude and installer.no-binary', () => {
    const environment = machine();
    write('poetry', environment, '[solver]\nmin-release-age-exclude = ["*"]\n\n[installer]\nno-binary = ["numpy"]\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['poetry'] }, environment, { poetry: [2, 5, 1] });
    const text = after(planned, 'poetry', environment) ?? '';
    expect(text).toContain(`${SUPERSEDED}min-release-age-exclude = ["*"]`);
    expect(text).toContain(`${SUPERSEDED}no-binary = ["numpy"]`);
  });
});

describe('pip.conf sections and the uv [pip] table', () => {
  it('supersedes the managed keys in [install], which beats [global] for pip install', () => {
    const environment = machine();
    write('pip', environment, '[global]\nindex-url = https://pypi.org/simple\n\n[install]\nuploaded-prior-to = P0D\nno-binary = :all:\nuser = true\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['pip'] }, environment, { pip: [26, 2, 2] });
    expect(after(planned, 'pip', environment)).toBe(
      [
        '[global]',
        USER_MARKER,
        'uploaded-prior-to = P3D',
        'only-binary = :all:',
        '# <<< depcurfew managed block',
        'index-url = https://pypi.org/simple',
        '',
        '[install]',
        `${SUPERSEDED}uploaded-prior-to = P0D`,
        `${SUPERSEDED}no-binary = :all:`,
        'user = true',
        '',
      ].join('\n'),
    );
  });

  it('supersedes a spelling with underscores too, which pip reads as the same key', () => {
    const environment = machine();
    write('pip', environment, '[global]\nonly_binary = :none:\n\n[install]\nUploaded_Prior_To = P0D\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['pip'] }, environment, { pip: [26, 2, 2] });
    const text = after(planned, 'pip', environment);
    expect(text).toContain(`${SUPERSEDED}only_binary = :none:`);
    expect(text).toContain(`${SUPERSEDED}Uploaded_Prior_To = P0D`);
  });

  it('restores a line it commented out once the policy no longer manages its key', () => {
    const environment = machine();
    write('pip', environment, '[global]\nonly-binary = numpy\n');
    const first = applyTwice({ ...DEFAULT, targets: ['pip'] }, environment, { pip: [26, 2, 2] });
    expect(after(first, 'pip', environment)).toContain(`${SUPERSEDED}only-binary = numpy`);
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['pip'] }, environment, { pip: [26, 2, 2] });
    expect(after(planned, 'pip', environment)).toBe(['[global]', USER_MARKER, 'uploaded-prior-to = P3D', '# <<< depcurfew managed block', 'only-binary = numpy', ''].join('\n'));
  });

  it('leaves the block where it is when other lines of [global] come before it', () => {
    const environment = machine();
    const block = [USER_MARKER, 'uploaded-prior-to = P3D', 'only-binary = :all:', '# <<< depcurfew managed block'];
    write('pip', environment, ['[global]', 'timeout = 30', ...block, ''].join('\n'));
    expect(plan({ ...DEFAULT, targets: ['pip'] }, environment, { pip: [26, 2, 2] }).report.changes).toEqual([]);
    // pip 26.0 gets no uploaded-prior-to: a hand-written one before the block stays where it is.
    const old = machine();
    write('pip', old, ['[global]', 'uploaded-prior-to = 2025-01-01', USER_MARKER, 'only-binary = :all:', '# <<< depcurfew managed block', ''].join('\n'));
    expect(plan({ ...DEFAULT, targets: ['pip'] }, old, { pip: [26, 0, 1] }).report.changes).toEqual([]);
  });

  it('supersedes exclude-newer in the [pip] table of uv.toml, which uv pip prefers to the top-level key', () => {
    const environment = machine();
    write('uv', environment, '[pip]\nexclude-newer = false\nexclude-newer-package = { requests = false }\nno-binary = [":all:"]\nindex-url = "https://pypi.org/simple"\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['uv'] }, environment, { uv: [0, 13, 6] });
    const text = after(planned, 'uv', environment) ?? '';
    expect(text).toContain('exclude-newer = "3 days"\n');
    expect(text).toMatch(/# depcurfew: [^\n]*exclude-newer = false\n/u);
    expect(text).toMatch(/# depcurfew: [^\n]*exclude-newer-package = \{ requests = false \}\n/u);
    expect(text).toMatch(/# depcurfew: [^\n]*no-binary = \[":all:"\]\n/u);
    expect(text).toContain('\nindex-url = "https://pypi.org/simple"\n');
    // Without cooldown in the policy, the [pip] delay comes back.
    const without = plan({ installScripts: { default: 'deny' }, targets: ['uv'] }, environment, { uv: [0, 13, 6] });
    expect(after(without, 'uv', environment)).toContain('[pip]\nexclude-newer = false\nexclude-newer-package = { requests = false }\n');
  });

  it('does not move or separate a uv.toml key written right after the block', () => {
    const environment = machine();
    const text = [USER_MARKER, 'exclude-newer = "3 days"', 'no-build = true', '# <<< depcurfew managed block', 'index-url = "https://pypi.org/simple"', ''].join('\n');
    write('uv', environment, text);
    expect(plan({ ...DEFAULT, targets: ['uv'] }, environment, { uv: [0, 13, 6] }).report.changes).toEqual([]);
  });
});

describe('a longer delay in a user file', () => {
  // The setting as its file writes it (decision D-111): key=value in INI files, key = value in TOML, key: value in YAML.
  const cases: { id: ToolId; version: Version; text: string; key: string; shown: string }[] = [
    { id: 'pnpm', version: [11, 28, 10], text: 'minimumReleaseAge: 10080\n', key: 'minimumReleaseAge', shown: 'minimumReleaseAge: 10080' },
    { id: 'npm', version: [11, 21, 1], text: 'min-release-age=7\n', key: 'min-release-age', shown: 'min-release-age=7' },
    { id: 'bun', version: [1, 4, 4], text: '[install]\nminimumReleaseAge = 604800\n', key: 'minimumReleaseAge', shown: 'minimumReleaseAge = 604800' },
    { id: 'uv', version: [0, 13, 6], text: 'exclude-newer = "7 days"\n', key: 'exclude-newer', shown: 'exclude-newer = "7 days"' },
    { id: 'pip', version: [26, 2, 2], text: '[global]\nuploaded-prior-to = P7D\n', key: 'uploaded-prior-to', shown: 'uploaded-prior-to=P7D' },
  ];
  for (const { id, version, text, key, shown } of cases) {
    it(`warns when the policy shortens ${key} for ${id}, and says how to keep it`, () => {
      const environment = machine();
      write(id, environment, text, version);
      const planned = plan({ cooldown: { minimum: '3d' }, targets: [id] }, environment, { [id]: version });
      const warnings = warningsOf(planned, 'cooldown-shortened');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ tool: id, location: { file: shownUserFile(id, environment, version) } });
      expect(warnings[0]?.message).toContain(`: ${shown} in `);
      expect(warnings[0]?.message).toContain(`waits 1 week, longer than cooldown.minimum "3d" in ${shownPolicy(environment)}; depcurfew apply --user`);
      expect(warnings[0]?.fix).toBe(`To keep the longer delay, set cooldown.minimum to "7d" in ${shownPolicy(environment)} and run depcurfew apply --user again`);
    });
  }

  it('says exactly what it does with the npm value', () => {
    const environment = machine();
    write('npm', environment, 'min-release-age=7\n');
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(warningsOf(planned, 'cooldown-shortened').map((warning) => warning.message)).toEqual([
      `npm: min-release-age=7 in ~/.npmrc (line 1) waits 1 week, longer than cooldown.minimum "3d" in ${shownPolicy(environment)}; depcurfew apply --user comments it out and writes min-release-age=3 in its managed block, so npm waits only 3 days`,
    ]);
  });

  it('does not warn about a shorter delay or about one it wrote itself', () => {
    const environment = machine();
    write('npm', environment, 'min-release-age=1\n');
    expect(warningsOf(applyTwice({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 21, 1] }), 'cooldown-shortened')).toEqual([]);
    expect(warningsOf(plan({ cooldown: { minimum: '2d' }, targets: ['npm'] }, environment, { npm: [11, 21, 1] }), 'cooldown-shortened')).toEqual([]);
  });
});

describe('before= in ~/.npmrc', () => {
  it('does not write min-release-age next to before= for npm 11.10 to 11.14, which then fails every command', () => {
    const environment = machine();
    write('npm', environment, 'before=2025-01-01\n');
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 12, 0] });
    expect(planned.report.changes).toEqual([]);
    expect(warningsOf(planned, 'before-overrides-cooldown')).toEqual([
      {
        code: 'before-overrides-cooldown',
        tool: 'npm',
        location: { file: '~/.npmrc', line: 1 },
        message:
          'npm 11.12.0 stops with an error when before and min-release-age are both set, and ~/.npmrc sets before=2025-01-01 (line 1), so depcurfew apply --user does not write min-release-age, which would make every npm command fail',
        fix: 'Remove the before line from ~/.npmrc, then run depcurfew apply --user again',
      },
    ]);
  });

  it('writes min-release-age for npm 11.15 and later and warns that before= takes its place', () => {
    const environment = machine();
    write('npm', environment, 'before=2025-01-01\n');
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(after(planned, 'npm', environment)).toContain('min-release-age=3\n');
    expect(warningsOf(planned, 'before-overrides-cooldown').map((warning) => warning.fix)).toEqual(['Remove the before line from ~/.npmrc, so that min-release-age applies']);
  });
});

describe('warnings project mode gives', () => {
  it('says that npm before 11.16 cannot enforce "deny", and how to fix it on this machine', () => {
    for (const version of [
      [10, 9, 2],
      [11, 12, 0],
    ] as Version[]) {
      const environment = machine();
      const planned = plan({ installScripts: { default: 'deny' }, targets: ['npm'] }, environment, { npm: version });
      expect(warningsOf(planned, 'scripts-not-enforceable')).toEqual([
        expect.objectContaining({ fix: 'Update npm to 11.16.0 or later (npm 12 blocks dependency scripts by default), then run depcurfew apply --user again' }),
      ]);
    }
  });

  it('says that pnpm before 10 cannot enforce "deny" from its user file', () => {
    const environment = machine();
    const planned = plan({ installScripts: { default: 'deny' }, targets: ['pnpm'] }, environment, { pnpm: [9, 15, 9] });
    expect(warningsOf(planned, 'scripts-not-enforceable').map((warning) => warning.fix)).toEqual([
      'Update pnpm to 10.0.0 or later, which blocks dependency install scripts by default, then run depcurfew apply --user again; until then, run depcurfew apply in each project',
    ]);
    expect(codes(plan({ installScripts: { default: 'deny' }, targets: ['pnpm'] }, environment, { pnpm: [10, 34, 9] }))).not.toContain('pnpm:scripts-not-enforceable');
  });

  it('reports forced source builds of the uv, pip and Poetry build allow-lists, naming the user policy', () => {
    const environment = machine();
    const planned = plan({ installScripts: { default: 'deny', allow: ['pypi:psycopg2'] }, targets: ['uv', 'pip', 'poetry'] }, environment, {
      uv: [0, 13, 6],
      pip: [26, 2, 2],
      poetry: [2, 5, 1],
    });
    const forced = warningsOf(planned, 'forced-source-build');
    expect(forced.map((warning) => warning.tool).sort()).toEqual(['pip', 'poetry', 'uv']);
    for (const warning of forced) expect(warning.fix).toBe(`If pypi:psycopg2 has a wheel and needs no build, remove it from installScripts.allow in ${shownPolicy(environment)}`);
  });

  it('gives the pnpm and Bun warnings of project mode', () => {
    const environment = machine();
    const planned = plan({ ...DEFAULT, sources: { git: 'deny', remoteTarball: 'allow' }, targets: ['pnpm'] }, environment, { pnpm: [10, 16, 1] });
    expect(warningsOf(planned, 'exact-version-gap').map((warning) => warning.fix)).toEqual(['Update pnpm to 10.17.0 or later, then run depcurfew apply --user again']);
    // pnpm 10.16 has no block-exotic-subdeps yet.
    expect(codes(planned)).toContain('pnpm:version-too-old');
    const exotic = plan({ ...DEFAULT, sources: { git: 'deny', remoteTarball: 'allow' }, targets: ['pnpm'] }, environment, { pnpm: [11, 28, 10] });
    expect(codes(exotic)).toEqual(expect.arrayContaining(['pnpm:source-switch-indirect-only', 'pnpm:source-switch-combined']));
    expect(warningsOf(exotic, 'source-switch-combined')[0]?.fix).toContain(`in ${shownPolicy(environment)}`);
    const bun = plan({ installScripts: { default: 'allow' }, targets: ['bun'] }, environment, { bun: [1, 4, 4] });
    expect(codes(bun)).toEqual(['bun:allow-all-unsupported']);
  });

  it('reports a shortened delay for Deno in whole days, and does not write min-release-age for Deno next to before= that breaks npm', () => {
    const environment = machine();
    write('npm', environment, 'min-release-age=7\n');
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['deno'] }, environment, { deno: [2, 9, 8] });
    expect(warningsOf(planned, 'cooldown-shortened').map((warning) => warning.message)).toEqual([
      `Deno: min-release-age=7 in ~/.npmrc (line 1) waits 1 week, longer than cooldown.minimum "3d" in ${shownPolicy(environment)}; depcurfew apply --user comments it out and writes min-release-age=3 in its managed block, so Deno waits only 3 days`,
    ]);
    const broken = machine();
    write('npm', broken, 'before=2025-01-01\n');
    const both = plan({ cooldown: { minimum: '3d' }, targets: ['deno', 'npm'] }, broken, { deno: [2, 9, 8], npm: [11, 12, 0] });
    expect(both.report.changes).toEqual([]);
    expect(codes(both)).toContain('npm:before-overrides-cooldown');
  });

  it('reports dependency sources a user file cannot hold', () => {
    const environment = machine();
    const planned = plan({ ...DEFAULT, targets: ['uv', 'pip', 'poetry', 'pdm', 'bun', 'yarn', 'pnpm'] }, environment, {
      uv: [0, 13, 6],
      pip: [26, 2, 2],
      poetry: [2, 5, 1],
      pdm: [2, 29, 5],
      bun: [1, 4, 4],
      yarn: [4, 18, 1],
      pnpm: [12, 17, 0],
    });
    expect(codes(planned)).toEqual(
      expect.arrayContaining(['uv:source-not-enforceable', 'pip:source-not-enforceable', 'poetry:source-not-enforceable', 'pdm:source-not-enforceable', 'bun:source-not-enforceable', 'yarn:source-not-enforceable']),
    );
    // Yarn's git setting is written; it has none for remote tarballs.
    expect(warningsOf(planned, 'source-not-enforceable').filter((warning) => warning.tool === 'yarn').map((warning) => warning.message)).toEqual([
      'Yarn (Berry) has no setting for remote tarball dependencies, so "deny" cannot be enforced',
    ]);
    // pnpm 12 reads blockExoticSubdeps only from pnpm-workspace.yaml.
    expect(warningsOf(planned, 'user-setting-project-only').filter((warning) => warning.tool === 'pnpm').map((warning) => warning.message)).toContain(
      `pnpm reads blockExoticSubdeps only from pnpm-workspace.yaml, not from ${shownUserFile('pnpm', environment, [12, 17, 0])}, so depcurfew apply --user does not write it`,
    );
  });

  it('drops allow-scripts patterns, which npm does not read', () => {
    const environment = machine();
    const planned = plan({ installScripts: { default: 'deny', allow: ['@acme/*', 'esbuild'] }, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(after(planned, 'npm', environment)).toContain('\nallow-scripts=esbuild\n');
    expect(warningsOf(planned, 'allow-pattern-unsupported').map((warning) => warning.message)).toEqual(['npm: allow-scripts takes package names only; "@acme/*" not written']);
  });

  it('says that explicit denials live only in project files, also with an empty allow-list', () => {
    const environment = machine();
    const planned = plan({ installScripts: { default: 'deny', allow: [], deny: ['core-js'] }, targets: ['npm', 'pnpm', 'yarn'] }, environment, {
      npm: [11, 21, 1],
      pnpm: [11, 28, 10],
      yarn: [4, 18, 1],
    });
    const messages = warningsOf(planned, 'user-setting-project-only').map((warning) => warning.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'npm reads the denials of installScripts.deny (allowScripts entries set to false) only from the root package.json of each project, not from ~/.npmrc, so depcurfew apply --user does not write them',
        `pnpm reads allowBuilds only from pnpm-workspace.yaml, not from ${shownUserFile('pnpm', environment, [11, 28, 10])}, so depcurfew apply --user does not write it`,
        'Yarn (Berry) reads dependenciesMeta only from the root package.json of each project, not from ~/.yarnrc.yml, so depcurfew apply --user does not write it',
      ]),
    );
  });
});

describe('version-too-old only for what the policy needs', () => {
  it('does not ask pnpm 10 for minimumReleaseAgeStrict, nor npm 11.12 for min-release-age-exclude with no exceptions', () => {
    const environment = machine();
    const planned = plan({ ...DEFAULT, targets: ['pnpm', 'npm'] }, environment, { pnpm: [10, 34, 9], npm: [11, 16, 0] });
    expect(codes(planned)).not.toContain('pnpm:version-too-old');
    expect(codes(planned)).not.toContain('npm:version-too-old');
    const old = plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 12, 0] });
    expect(codes(old)).not.toContain('npm:version-too-old');
  });

  it('asks to update the installed tool, and shows the version as the tool prints it', () => {
    const environment = machine();
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 6, 0] });
    expect(warningsOf(planned, 'version-too-old')).toEqual([
      expect.objectContaining({ message: 'npm 11.6.0 does not support min-release-age (added in 11.10.0); not written', fix: 'Update npm to 11.10.0 or later, then run depcurfew apply --user again' }),
    ]);
  });
});

describe('wording', () => {
  it('writes a marker that points to the user policy and apply --user', () => {
    const environment = machine();
    const planned = plan({ cooldown: { minimum: '3d' }, targets: ['npm', 'poetry'] }, environment, { npm: [11, 21, 1], poetry: [2, 5, 1] });
    expect(after(planned, 'npm', environment)).toBe(`${USER_MARKER}\nmin-release-age=3\n# <<< depcurfew managed block\n`);
    expect(after(planned, 'poetry', environment)).toContain(
      '[solver]\n# >>> depcurfew managed block [solver]: edit the user depcurfew.json and run depcurfew apply --user instead\nmin-release-age = 3\n',
    );
  });

  it('replaces a block an earlier apply --user wrote with the project marker', () => {
    const environment = machine();
    write('npm', environment, '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead\nmin-release-age=3\n# <<< depcurfew managed block\n');
    expect(after(plan({ cooldown: { minimum: '3d' }, targets: ['npm'] }, environment, { npm: [11, 21, 1] }), 'npm', environment)).toBe(
      `${USER_MARKER}\nmin-release-age=3\n# <<< depcurfew managed block\n`,
    );
  });

  it('says that Yarn 1 does not read ~/.yarnrc.yml', () => {
    const environment = machine();
    const planned = plan({ ...DEFAULT, targets: ['yarn'] }, environment, { yarn: [1, 22, 22] });
    expect(planned.report.changes).toEqual([]);
    expect(codes(planned)).toEqual(['yarn:tool-not-supported']);
    expect(planned.report.warningDetails[0]?.message).toBe('Yarn Classic 1.22.22 reads .yarnrc, not ~/.yarnrc.yml, and is not supported; nothing written for it');
  });

  it('uses the plural for parts that are plural', () => {
    const environment = machine();
    const planned = plan({ installScripts: { default: 'deny' }, targets: ['pdm'] }, environment, { pdm: [2, 29, 5] });
    expect(warningsOf(planned, 'user-setting-project-only').map((warning) => warning.message)).toEqual([
      `PDM reads only-binary and no-binary only from pyproject.toml, not from ${shownUserFile('pdm', environment)}, so depcurfew apply --user does not write them`,
    ]);
  });

  it('shows the version as the tool prints it (pip 24.0)', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-user-parity-'));
    temporary.push(root);
    const home = join(root, 'home');
    const venv = join(root, 'venv');
    const info = join(venv, 'lib', 'python3.12', 'site-packages', 'pip-24.0.dist-info');
    mkdirSync(home, { recursive: true });
    mkdirSync(info, { recursive: true });
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: pip\nVersion: 24.0\n');
    writeFileSync(join(info, 'entry_points.txt'), '[console_scripts]\npip = pip._internal.cli.main:main\n');
    writeFileSync(join(venv, 'bin', 'pip'), '#!/usr/bin/python3\n');
    const planned = planUserApply(policy({ cooldown: { minimum: '3d' }, targets: ['pip'] }), { environment: { platform, home, env: { PATH: join(venv, 'bin') } } });
    expect(warningsOf(planned, 'version-too-old').map((warning) => warning.message)).toEqual(['pip 24.0 does not support uploaded-prior-to (added in 26.1.0); not written']);
  });
});

describe('a switch in a user file that allows every install script', () => {
  it('is superseded in ~/.npmrc for any value npm reads as on, as in a project .npmrc', () => {
    const environment = machine();
    write('npm', environment, 'dangerously-allow-all-scripts=1\n');
    const planned = applyTwice({ ...DEFAULT, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(after(planned, 'npm', environment)).toContain(`${SUPERSEDED}dangerously-allow-all-scripts=1`);
  });

  it('is superseded in the pnpm 10 rc', () => {
    const environment = machine();
    write('pnpm', environment, 'dangerously-allow-all-builds=yes\n', [10, 28, 0]);
    const planned = applyTwice({ ...DEFAULT, targets: ['pnpm'] }, environment, { pnpm: [10, 28, 0] });
    expect(after(planned, 'pnpm', environment, [10, 28, 0])).toContain(`${SUPERSEDED}dangerously-allow-all-builds=yes`);
  });

  it('is replaced with false in the pnpm 11 config.yaml, with allow-all-replaced', () => {
    const environment = machine();
    write('pnpm', environment, 'dangerouslyAllowAllBuilds: "false"\n', [11, 28, 10]);
    const planned = applyTwice({ ...DEFAULT, targets: ['pnpm'] }, environment, { pnpm: [11, 28, 10] });
    expect(after(planned, 'pnpm', environment, [11, 28, 10])).toMatch(/^dangerouslyAllowAllBuilds: false$/mu);
    expect(warningsOf(planned, 'allow-all-replaced')).toHaveLength(1);
  });

  it('stays when the policy allows every install script', () => {
    const environment = machine();
    write('npm', environment, 'dangerously-allow-all-scripts=true\n');
    const planned = plan({ ...DEFAULT, installScripts: { default: 'allow', allow: [], deny: [] }, targets: ['npm'] }, environment, { npm: [11, 21, 1] });
    expect(after(planned, 'npm', environment) ?? 'dangerously-allow-all-scripts=true\n').not.toContain(SUPERSEDED + 'dangerously');
  });
});
