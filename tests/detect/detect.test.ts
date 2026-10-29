import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject } from '../../src/detect/index.ts';

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
  it('does not follow a symlinked config file that points outside', () => {
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

  it('follows a symlink that stays inside the repository', () => {
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

  it('does not walk into node_modules, .git or symlinked directories when expanding **', () => {
    write('package.json', JSON.stringify({ workspaces: ['**'] }));
    write('package-lock.json', '{}');
    write('libs/deep/a/package.json', '{}');
    write('node_modules/dep/package.json', '{}');
    write('.git/x/package.json', '{}');
    mkdirSync(join(outside, 'linked'));
    writeFileSync(join(outside, 'linked', 'package.json'), '{}');
    symlinkSync(join(outside, 'linked'), join(root, 'linked'));
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
  it('records expressions and every setup step in every workflow', () => {
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
        '',
      ].join('\n'),
    );
    const result = detectProject(root);
    expect(result.node.versions).toEqual([
      { version: '${{ matrix.node }}', source: 'github-actions', file: '.github/workflows/test.yaml', line: 9 },
    ]);
    expect(result.packageManagers[0]?.versions).toEqual([
      { version: '11.6.0', source: 'github-actions', file: '.github/workflows/test.yaml', line: 12 },
    ]);
  });
});
