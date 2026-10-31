// The codes of apply's warnings and errors are an interface for programs: each is documented and each is in use.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APPLY_ERRORS, APPLY_WARNINGS, warningText } from '../../src/apply/warnings.ts';

const SOURCE = fileURLToPath(new URL('../../src/', import.meta.url));
const source = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('warnings.ts'))
  .map((file) => readFileSync(join(SOURCE, file), 'utf8'))
  .join('\n');

describe('apply warning and error codes', () => {
  it.each(Object.entries({ ...APPLY_WARNINGS, ...APPLY_ERRORS }))('%s is kebab-case, explained in one sentence and used', (code, summary) => {
    expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/u);
    expect(summary).toMatch(/^\S.*\.$/u);
    expect(source).toContain(`'${code}'`);
  });

  it('says what to do in every warning apply writes', () => {
    // Each object literal with a warning code, as written in the source: it has a fix, and not only sometimes.
    const literals: string[] = [];
    for (const match of source.matchAll(/code: '([a-z-]+)'/gu)) {
      if (!((match[1] ?? '') in APPLY_WARNINGS)) continue;
      const start = source.lastIndexOf('{', match.index);
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}' && --depth === 0) break;
      }
      literals.push(source.slice(start, end + 1));
    }
    expect(literals.length).toBeGreaterThan(30);
    for (const literal of literals) {
      expect(literal, literal).toMatch(/\bfix\b/u);
      expect(literal, literal).not.toMatch(/fix === undefined/u);
    }
  });

  it('says what to do in every warning of the fixture repositories', () => {
    const expected = fileURLToPath(new URL('../fixtures/expected/', import.meta.url));
    for (const name of readdirSync(expected)) {
      const report = JSON.parse(readFileSync(join(expected, name, 'apply.json'), 'utf8')) as { warnings: { code: string; fix?: string }[] };
      for (const warning of report.warnings) expect(warning.fix, `${name}: ${warning.code}`).toMatch(/^[A-Z]/u);
    }
  });

  it('joins message and fix into one line for ApplyReport.warnings', () => {
    expect(warningText({ code: 'nothing-to-configure', message: 'a' })).toBe('a');
    expect(warningText({ code: 'nothing-to-configure', message: 'a', fix: 'Do b' })).toBe('a. Do b');
  });
});
