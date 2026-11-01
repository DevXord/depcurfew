// Inputs from an untrusted repository cannot make depcurfew run for minutes (decision P7 of the review before 1.0.0):
// wildcard patterns from depcurfew.json or workspace declarations, and many ** segments in a workspace pattern. Nor can
// a hook event of 1 MiB (the most the hook reads) with brackets, quotes or variables for the PowerShell and cmd readers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';
import { detectProject } from '../../src/detect/index.ts';
import { wildcardMatch } from '../../src/detect/wildcard.ts';
import { matchesPattern } from '../../src/doctor/allow-lists.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function elapsed(action: () => void): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

describe('wildcardMatch', () => {
  it.each([
    ['esbuild', 'esbuild', true],
    ['esbuild', 'esbuil', false],
    ['@types/node', '@types/*', true],
    ['@types/node', '*', false],
    ['@scope/a/b', '@scope/*', false],
    ['eslint-plugin-react', 'eslint-*-react', true],
    ['eslint-react', 'eslint-*-react', false],
    ['abc', '*', true],
    ['', '*', true],
    ['abc', 'a*b*c', true],
    ['aXbYc', 'a*b*c', true],
    ['acb', 'a*b*c', false],
    ['a.b', 'a?b', false],
    ['a+b', 'a+b', true],
  ])('%s against %s', (text, pattern, expected) => {
    expect(wildcardMatch(text, pattern)).toBe(expected);
  });
});

describe('patterns that make regular expressions backtrack', () => {
  it('matches a policy pattern with many stars quickly', () => {
    const pattern = `${'*a'.repeat(30)}*b`;
    const name = 'a'.repeat(200);
    expect(elapsed(() => expect(matchesPattern(name, pattern)).toBe(false))).toBeLessThan(500);
  });

  it('expands a workspace pattern with many stars quickly', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-dos-'));
    temporary.push(root);
    mkdirSync(join(root, 'a'.repeat(60)));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'npm@11.19.1', workspaces: [`${'*a'.repeat(30)}*b`] }));
    expect(elapsed(() => detectProject(root))).toBeLessThan(2000);
  });

  it('walks the tree once for a pattern with many ** segments', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcurfew-dos-'));
    temporary.push(root);
    mkdirSync(join(root, 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/pkg'), { recursive: true });
    writeFileSync(join(root, 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/pkg/package.json'), '{"name": "pkg"}');
    const pattern = `${Array(20).fill('**').join('/')}/pkg`;
    const patternWithGaps = `${Array(10).fill('**/*').join('/')}/pkg`;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'npm@11.19.1', workspaces: [pattern, patternWithGaps] }));
    let packages: string[] = [];
    expect(elapsed(() => (packages = detectProject(root).workspaces?.packages ?? []))).toBeLessThan(2000);
    expect(packages).toEqual(['d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/pkg']);
  });
});

describe('PowerShell and cmd command lines of a hook event', () => {
  it.each([
    ['deeply nested brackets', '('.repeat(300_000) + ')'.repeat(300_000), 'powershell'],
    ['many brackets', '(a) '.repeat(250_000), 'powershell'],
    ['many subexpressions next to npm', 'npm i $(a) '.repeat(90_000), 'powershell'],
    ['many variables in strings', '"x$y" '.repeat(160_000), 'powershell'],
    ['many open quotes', "'a\"b".repeat(250_000), 'powershell'],
    ['many statements', 'npm i x; '.repeat(110_000), 'powershell'],
    ['many splats', '@a '.repeat(330_000), 'powershell'],
    ['nested groups in cmd /c', `cmd /c "${'('.repeat(300_000)}npm i x${')'.repeat(300_000)}"`, 'posix'],
    ['many expansions in cmd /c', `cmd /c "npm i ${'%x% '.repeat(250_000)}"`, 'posix'],
  ] as const)('reads %s quickly', (_label, line, shell) => {
    expect(elapsed(() => scanCommandLine(line, { shell }))).toBeLessThan(5000);
  });
});

describe('the directories of a hook event (decision D-118)', () => {
  it.each([
    ['many loops that change directory', 'while x; do cd a && npm i y; '.repeat(30_000), 'posix'],
    ['many changes of directory', 'cd a && npm i y && pushd b && '.repeat(30_000), 'posix'],
    ['many open subshells', `${'( cd a && '.repeat(80_000)}npm i y`, 'posix'],
    ['many command substitutions with changes', 'echo $(cd a && npm i y) '.repeat(40_000), 'posix'],
    ['deeply nested branches', `${'if x; then cd a; '.repeat(60_000)}npm i y`, 'posix'],
    ['many changes of location in PowerShell', 'Set-Location a; npm i y; Push-Location b; '.repeat(30_000), 'powershell'],
  ] as const)('reads %s quickly', (_label, line, shell) => {
    expect(elapsed(() => scanCommandLine(line, { shell }))).toBeLessThan(5000);
  });
});
