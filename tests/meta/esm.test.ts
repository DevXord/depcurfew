import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findEsmViolations } from './esm-scanner.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

function typeScriptFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith('.ts')).map((entry) => join(root, directory, entry));
}

describe('ESM scanner', () => {
  it.each([
    ['top-level await', 'const x = await load();', 'top-level-await'],
    ['top-level for await', 'for await (const x of xs) {}', 'top-level-await'],
    ['require call', "const fs = require('node:fs');", 'commonjs'],
    ['module.exports', 'module.exports = {};', 'commonjs'],
    ['exports.name', 'exports.answer = 42;', 'commonjs'],
    ['import = require', "import fs = require('node:fs');", 'commonjs'],
    ['export =', 'export = {};', 'commonjs'],
  ])('flags %s', (_name, source, rule) => {
    expect(findEsmViolations('sample.ts', source).map((violation) => violation.rule)).toEqual([rule]);
  });

  it.each([
    ['await inside an async function', 'async function f() { await g(); }'],
    ['await inside an arrow function', 'const f = async () => { await g(); };'],
    ['await inside a class method', 'class A { async m() { await g(); } }'],
    ['promise chain at top level', 'main().then((code) => { process.exitCode = code; });'],
    ['static ESM import', "import { readFileSync } from 'node:fs';"],
  ])('accepts %s', (_name, source) => {
    expect(findEsmViolations('sample.ts', source)).toEqual([]);
  });
});

describe('repository sources', () => {
  const files = [...typeScriptFiles('src'), ...typeScriptFiles('scripts')];

  it('contain TypeScript files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('are ESM-only and free of top-level await', () => {
    const violations = files.flatMap((file) =>
      findEsmViolations(file, readFileSync(file, 'utf8')).map(
        (violation) => `${relative(root, file)}:${violation.line} [${violation.rule}] ${violation.text}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
