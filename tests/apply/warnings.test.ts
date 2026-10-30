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

  it('joins message and fix into one line for ApplyReport.warnings', () => {
    expect(warningText({ code: 'nothing-to-configure', message: 'a' })).toBe('a');
    expect(warningText({ code: 'nothing-to-configure', message: 'a', fix: 'Do b' })).toBe('a. Do b');
  });
});
