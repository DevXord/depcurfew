// Inputs from an untrusted repository cannot make depcurfew run for minutes (decision P7 of the review before 1.0.0):
// wildcard patterns from depcurfew.json or workspace declarations, and many ** segments in a workspace pattern. Nor can
// a hook event of 1 MiB (the most the hook reads) with brackets, quotes or variables for the PowerShell and cmd readers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanCommandLine } from '../../src/check/command.ts';
import { requestedSpecs } from '../../src/check/hook.ts';
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

describe('the stack of pushd, traps, env -S and names the shell builds (decision D-123)', () => {
  const MiB = 1024 * 1024;
  /** `part` repeated up to 1 MiB, the most the hook reads, with `tail` at the end. */
  const filled = (part: string, tail = '') => part.repeat(Math.floor((MiB - tail.length) / part.length)) + tail;
  it.each([
    // The verifier's inputs: every ( ) subshell used to copy the stack of pushd (36.7 s and 27.7 s).
    ['many pushd, then many subshells', `${'pushd a;'.repeat(62_000)}${'(:);'.repeat(120_000)}npm i fresh-pkg@1.1.0`],
    ['pushd and a subshell, many times', 'pushd a; (:); '.repeat(70_000)],
    ['pushd of an absolute path and a subshell', filled('pushd /a; (:); ', 'npm i x')],
    ['cd and cd -, many times', filled('cd a; cd -; ', 'npm i x')],
    ['cd to absolute paths between installs', filled('cd /a; npm i x; cd /b; npm i y; ')],
    ['installs after long paths', `${`cd ${'a'.repeat(1000)}; `.repeat(64)}${'npm i x;'.repeat(120_000)}`],
    ['pushd and pushd +1', filled('pushd a; pushd +1; ', 'npm i x')],
    ['pushd, popd and an install', filled('pushd a; popd; npm i x; ')],
    ['dirs -c between pushd and popd', filled('pushd a; dirs -c; popd; ', 'npm i x')],
    ['pushd -n', filled('pushd -n a; ', 'popd; npm i x')],
    ['nested env -S', filled("env -S'-S\"-i\"' ", 'npm i x')],
    ['many -S strings', `env ${'-S -i '.repeat(150_000)}npm i x`],
    ['an alias that ends in a blank, many times', `alias n='n '; ${'n '.repeat(400_000)}`],
    ['a long alias that ends in a blank', `alias n='${'x'.repeat(1000)} '; ${'n '.repeat(400_000)}`],
    ['traps that change directory', filled("trap 'cd a' DEBUG; npm i x; ")],
    ['files run with .', filled('. ./x.sh; npm i x; ')],
    ['activation scripts of virtual environments', filled('source .venv/bin/activate; pip install x; . v/bin/activate; ')],
    ['declare with a name the shell builds', filled('declare "$X=1"; cd -; npm i x; ')],
    ['arithmetic and subscripts', filled('(( $X )); echo ${a[$i]}; ')],
    ['functions that change directory', filled('f() { cd a; }; npm i x; ')],
    ['many commands that do nothing', filled(':;')],
  ])('reads %s in under 2 seconds', (_label, line) => {
    expect(elapsed(() => scanCommandLine(line))).toBeLessThan(2000);
  });

  it('removes repeated installs in a directory with long paths quickly in the hook (it took 18 s)', () => {
    const line = `${`cd ${'a'.repeat(1000)}; `.repeat(64)}${'npm i x;'.repeat(120_000)}`;
    expect(elapsed(() => expect(requestedSpecs(line).specs).toHaveLength(1))).toBeLessThan(2000);
  });
});

describe('aliases that expand themselves (decision D-119)', () => {
  it.each([
    ['an alias of 30 copies of itself', `alias a='${'a;'.repeat(30)}'; a`],
    ['an alias of 40 copies of itself', `alias a='${'a;'.repeat(40)}'; a`],
    ['an alias that installs and expands itself', `alias a='npm i x; ${'a; '.repeat(40)}'; a; a; a`],
    ['two aliases that expand each other', `alias a='${'b;'.repeat(40)}' b='${'a;'.repeat(40)}'; a; b`],
    ['a chain of aliases', `alias d='${'true;'.repeat(40)}'; alias c='${'d;'.repeat(40)}'; alias b='${'c;'.repeat(40)}'; alias a='${'b;'.repeat(40)}'; a; a`],
    ['an alias through eval', `alias a='eval "${'a;'.repeat(40)}"'; a`],
    ['many uses of a long alias', `alias a='${'true; '.repeat(20_000)}'; ${'a;'.repeat(20_000)}`],
  ])('reads %s in under a second', (_label, line) => {
    expect(elapsed(() => scanCommandLine(line))).toBeLessThan(1000);
  });
});
