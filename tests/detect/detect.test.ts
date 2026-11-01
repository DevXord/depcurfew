import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';
import { canSymlink } from '../support/platform.ts';

let root: string;
let outside: string;

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'depcurfew-detect-'));
  outside = mkdtempSync(join(tmpdir(), 'depcurfew-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('detectProject on broken input', () => {
  it('reports an unparseable package.json and keeps going', () => {
    write('package.json', '{ "name": ');
    write('package-lock.json', '{}');
    const result = detectProject(root);
    expect(result.packageManagers.map((manager) => manager.id)).toEqual(['npm']);
    expect(result.warnings).toEqual([
      { code: 'invalid-file', message: expect.stringMatching(/^cannot parse package\.json: /), files: ['package.json'] },
    ]);
  });

  it('reports an unparseable workflow and keeps going', () => {
    write('package.json', '{}');
    write('package-lock.json', '{}');
    write('.github/workflows/broken.yml', 'jobs:\n  test: [\n');
    const result = detectProject(root);
    expect(result.workflows).toEqual(['.github/workflows/broken.yml']);
    expect(result.warnings).toEqual([
      {
        code: 'invalid-file',
        message: expect.stringMatching(/^cannot parse \.github\/workflows\/broken\.yml: /),
        files: ['.github/workflows/broken.yml'],
      },
    ]);
  });

  it.each([
    ['pnpm', 'packageManager "pnpm" is not in the form name@version'],
    ['pnpm@', 'packageManager "pnpm@" is not in the form name@version'],
    ['cnpm@9.0.0', 'packageManager names cnpm, which depcurfew does not know'],
  ])('reports packageManager %j', (value, message) => {
    write('package.json', JSON.stringify({ packageManager: value }));
    write('package-lock.json', '{}');
    expect(detectProject(root).warnings).toEqual([{ code: 'invalid-package-manager', message, files: ['package.json'] }]);
  });

  it('skips files larger than the size limit', () => {
    write('package.json', JSON.stringify({ name: 'x', padding: 'x'.repeat(1024 * 1024) }));
    write('package-lock.json', '{}');
    expect(detectProject(root).warnings).toEqual([
      { code: 'file-too-large', message: 'package.json is larger than 1 MiB and was not read', files: ['package.json'] },
    ]);
  });
});

describe('detectProject stays inside the repository', () => {
  it.skipIf(!canSymlink())('does not follow a symlinked config file that points outside', () => {
    writeFileSync(join(outside, '.npmrc'), 'min-release-age=0\n');
    write('package.json', '{}');
    write('package-lock.json', '{}');
    symlinkSync(join(outside, '.npmrc'), join(root, '.npmrc'));
    const result = detectProject(root);
    expect(result.npmrcFiles).toEqual([]);
    expect(result.warnings).toEqual([
      { code: 'outside-repository', message: '.npmrc points outside the repository and was not read', files: ['.npmrc'] },
    ]);
  });

  it.skipIf(!canSymlink())('follows a symlink that stays inside the repository', () => {
    write('package.json', '{}');
    write('package-lock.json', '{}');
    write('config/npmrc', 'save-exact=true\n');
    symlinkSync(join(root, 'config/npmrc'), join(root, '.npmrc'));
    expect(detectProject(root).npmrcFiles).toEqual(['.npmrc']);
  });

  it('ignores workspace patterns that leave the repository', () => {
    mkdirSync(join(outside, 'pkg'));
    writeFileSync(join(outside, 'pkg', 'package.json'), '{}');
    write('package.json', JSON.stringify({ workspaces: ['../*', 'packages/*'] }));
    write('package-lock.json', '{}');
    write('packages/a/package.json', '{}');
    const result = detectProject(root);
    expect(result.workspaces).toEqual({ declarations: [{ file: 'package.json', patterns: ['../*', 'packages/*'] }], packages: ['packages/a'] });
    expect(result.warnings).toEqual([
      { code: 'workspace-outside-repository', message: 'workspace pattern "../*" points outside the repository', files: ['package.json'] },
    ]);
  });

  it('ignores workspace patterns with a Windows drive or share', () => {
    write('package.json', JSON.stringify({ workspaces: ['C:/elsewhere/*', '\\\\nas\\share\\*', 'packages/*'] }));
    write('package-lock.json', '{}');
    write('packages/a/package.json', '{}');
    const result = detectProject(root);
    expect(result.workspaces?.packages).toEqual(['packages/a']);
    expect(result.warnings).toEqual([
      { code: 'workspace-outside-repository', message: 'workspace pattern "C:/elsewhere/*" points outside the repository', files: ['package.json'] },
      { code: 'workspace-outside-repository', message: 'workspace pattern "\\\\nas\\share\\*" points outside the repository', files: ['package.json'] },
    ]);
  });

  it('does not walk into node_modules, .git or symlinked directories when expanding **', () => {
    write('package.json', JSON.stringify({ workspaces: ['**'] }));
    write('package-lock.json', '{}');
    write('libs/deep/a/package.json', '{}');
    write('node_modules/dep/package.json', '{}');
    write('.git/x/package.json', '{}');
    mkdirSync(join(outside, 'linked'));
    writeFileSync(join(outside, 'linked', 'package.json'), '{}');
    symlinkSync(join(outside, 'linked'), join(root, 'linked'), 'junction');
    expect(detectProject(root).workspaces?.packages).toEqual(['libs/deep/a']);
  });

  it('accepts the object form of workspaces with a packages list', () => {
    write('package.json', JSON.stringify({ workspaces: { packages: ['apps/*'] } }));
    write('bun.lock', '{}');
    write('apps/one/package.json', '{}');
    expect(detectProject(root).workspaces).toEqual({ declarations: [{ file: 'package.json', patterns: ['apps/*'] }], packages: ['apps/one'] });
  });
});

describe('detectProject on GitHub Actions', () => {
  it('records expressions, the values of a matrix key and every setup step in every workflow', () => {
    write('package.json', '{}');
    write('package-lock.json', '{}');
    write(
      '.github/workflows/test.yaml',
      [
        'jobs:',
        '  test:',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22]',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: ${{ matrix.node }}',
        '      - run: |',
        '          corepack enable',
        '          npm i -g npm@11.6.0',
        '  other:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: ${{ inputs.node }}',
        '',
      ].join('\n'),
    );
    const result = detectProject(root);
    const file = '.github/workflows/test.yaml';
    expect(result.node.versions).toEqual([
      { version: '20', source: 'github-actions', file, line: 5, job: 'test', step: 7, matrix: 'node' },
      { version: '22', source: 'github-actions', file, line: 5, job: 'test', step: 7, matrix: 'node' },
      { version: '${{ inputs.node }}', source: 'github-actions', file, line: 17, job: 'other', step: 15 },
    ]);
    expect(result.packageManagers[0]?.versions).toEqual([{ version: '11.6.0', source: 'github-actions', file, line: 12, job: 'test' }]);
    expect(result.jobs).toEqual([
      { file, id: 'test', line: 2, commands: [{ kind: 'upgrade', tool: 'npm', version: '11.6.0', line: 12 }], runsNode: true },
      { file, id: 'other', line: 13, commands: [], runsNode: false },
    ]);
  });

  it('reads the Node.js version setup-node takes from node-version-file', () => {
    write('package.json', JSON.stringify({ private: true, devEngines: { runtime: [{ name: 'node', version: '24.14.1' }] }, engines: { node: '>=22' } }));
    write('package-lock.json', '{}');
    write('.nvmrc', '# the LTS line\nlts/jod # comment\n');
    write('.tool-versions', 'python 3.13.14\nnodejs 24.19.0\n');
    const steps = ['package.json', '.nvmrc', './.tool-versions', 'missing.txt', 'mise.toml'].flatMap((name) => [
      '      - uses: actions/setup-node@v7',
      '        with:',
      `          node-version-file: ${name}`,
    ]);
    write('.github/workflows/ci.yml', ['jobs:', '  test:', '    steps:', ...steps, ''].join('\n'));
    // setup-node takes the first line that is only a version, or else the whole text (src/util.ts), comments included.
    const versions = detectProject(root).node.versions.filter((entry) => entry.source === 'github-actions');
    expect(versions.map((entry) => ('version' in entry ? entry.version : undefined))).toEqual(['24.14.1', '# the LTS line\nlts/jod # comment', '24.19.0', undefined, undefined]);
    // .nvmrc itself is read as nvm reads it, without the comment.
    expect(detectProject(root).node.versions.find((entry) => entry.source === 'nvmrc')).toEqual({ version: 'lts/jod', source: 'nvmrc', file: '.nvmrc', line: 2 });
    expect(detectProject(root).node.versions.find((entry) => entry.source === 'engines')).toEqual({ version: '>=22', source: 'engines', file: 'package.json' });
  });
});

describe('detectProject on workspaces of several registries', () => {
  it('counts a package.json member of a Deno workspace, but not a Python project under a JavaScript workspace pattern', () => {
    write('deno.json', '{ "workspace": ["./web", "./api"] }\n');
    write('web/package.json', '{ "name": "web" }\n');
    write('api/deno.json', '{ "name": "@app/api" }\n');
    write('package.json', '{ "name": "root", "workspaces": ["tools/*"] }\n');
    write('package-lock.json', '{ "lockfileVersion": 3, "packages": {} }\n');
    write('tools/js/package.json', '{ "name": "js" }\n');
    write('tools/py/pyproject.toml', '[project]\nname = "py"\nversion = "0.1.0"\n');
    expect(detectProject(root).workspaces?.packages).toEqual(['api', 'tools/js', 'web']);
  });

  it('falls back to the next declaration file when one cannot be parsed', () => {
    write('deno.json', '{ "workspace": ["./pkg", }\n');
    write('deno.jsonc', '{ "workspace": ["./pkg"] }\n');
    write('pkg/deno.json', '{ "name": "@app/pkg" }\n');
    const result = detectProject(root);
    expect(result.workspaces?.packages).toEqual(['pkg']);
    expect(result.warnings.map((warning) => warning.code)).toContain('invalid-file');
  });
});

describe('detectProject on Python projects', () => {
  it('takes required-version only from the file uv reads: uv.toml hides [tool.uv] in pyproject.toml', () => {
    write('pyproject.toml', '[project]\nname = "app"\nversion = "0.1.0"\n\n[tool.uv]\nrequired-version = "==0.9.16"\n');
    write('uv.toml', 'no-build = true\n');
    write('uv.lock', 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n');
    expect(detectProject(root).packageManagers.find((manager) => manager.id === 'uv')?.versions).toEqual([]);
    write('uv.toml', 'required-version = "==0.13.6"\n');
    expect(detectProject(root).packageManagers.find((manager) => manager.id === 'uv')?.versions).toEqual([
      { version: '0.13.6', source: 'tool-config', file: 'uv.toml', line: 1 },
    ]);
  });

  it('finds named pylock files, as the specification allows', () => {
    write('pylock.dev.toml', 'lock-version = "1.0"\ncreated-by = "pip"\n');
    write('pylock.a.b.toml', 'lock-version = "1.0"\n');
    const pip = detectProject(root).packageManagers.find((manager) => manager.id === 'pip');
    expect(pip?.evidence).toEqual([{ kind: 'lockfile', file: 'pylock.dev.toml' }]);
  });
});
