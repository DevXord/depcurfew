// JSON and JSONC files are parsed strictly before and after every edit (D-074). The editor's own parser skips
// commas, so a deno.json with a missing comma used to be edited and written with exit code 0.
import { describe, expect, it } from 'vitest';
import { jsonArrayAppend, jsonArrayRemove, jsonArrayReplace, jsonSet } from '../../src/apply/json-edit.ts';

const MISSING_COMMA = '{\n  "tasks": { "dev": "deno run main.ts" }\n  "imports": { "chalk": "npm:chalk@5" }\n}\n';

describe('JSON edits refuse a file that does not parse', () => {
  it('names the line and column of a missing comma', () => {
    expect(() => jsonSet(MISSING_COMMA, ['minimumDependencyAge'], 4320)).toThrow(
      "invalid JSON at line 3, column 3: Expected ',' or '}' after property value",
    );
  });

  it('checks every kind of edit', () => {
    const broken = '{\n  "allowScripts": ["npm:a"]\n  "x": 1\n}\n';
    expect(() => jsonArrayAppend(broken, ['allowScripts'], 'npm:b')).toThrow('invalid JSON at line 3, column 3');
    expect(() => jsonArrayReplace(broken, ['allowScripts'], 0, 'npm:b')).toThrow('invalid JSON at line 3, column 3');
    expect(() => jsonArrayRemove(broken, ['allowScripts'], 0)).toThrow('invalid JSON at line 3, column 3');
  });

  it('refuses other syntax errors the editor would skip', () => {
    expect(() => jsonSet('{\n  "a": 1,,\n  "b": 2\n}\n', ['c'], 3)).toThrow('invalid JSON at line 2');
    expect(() => jsonSet('{\n  "a": [1 2]\n}\n', ['c'], 3)).toThrow('invalid JSON at line 2');
    expect(() => jsonSet('{\n  "a": 1\n}\n}\n', ['c'], 3)).toThrow('invalid JSON at line 4');
    expect(() => jsonSet('{\n  "a": 1\n', ['c'], 3)).toThrow('invalid JSON');
  });

  it('still edits JSONC with comments and trailing commas', () => {
    const text = '{\n  // tasks\n  "tasks": {},\n  /* imports */ "imports": {},\n}\n';
    expect(jsonSet(text, ['minimumDependencyAge'], 4320)).toBe('{\n  // tasks\n  "tasks": {},\n  /* imports */ "imports": {},\n  "minimumDependencyAge": 4320,\n}\n');
  });

  it('keeps a key named __proto__ as data when it checks the result', () => {
    const text = '{\n  "__proto__": { "a": 1 },\n  "b": 2\n}\n';
    expect(jsonSet(text, ['c'], 3)).toBe('{\n  "__proto__": { "a": 1 },\n  "b": 2,\n  "c": 3\n}\n');
  });
});
