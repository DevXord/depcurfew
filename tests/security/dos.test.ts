// Inputs from an untrusted repository cannot make depcurfew run for minutes (decision P7 of the review before 1.0.0):
// wildcard patterns from depcurfew.json or workspace declarations, and many ** segments in a workspace pattern.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
