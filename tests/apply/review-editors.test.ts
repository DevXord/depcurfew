// Editors after the review before 1.0.0 (decision P5 and the comment findings): apply never produces a file the tool
// can no longer read, and never drops a comment.
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { jsonArrayAppend, jsonArrayRemove, jsonSet } from '../../src/apply/json-edit.ts';
import { writeTomlBlock } from '../../src/apply/toml.ts';
import { yamlSet } from '../../src/apply/yaml-edit.ts';
import { parseJsonc } from '../../src/detect/jsonc.ts';

const START = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead';
const END = '# <<< depcurfew managed block';
const SUPERSEDED = '# depcurfew: superseded by the managed block: ';

describe('yamlSet and flow collections', () => {
  it('refuses to add a key to a flow map', () => {
    expect(() => yamlSet('allowBuilds: { esbuild: true }\n', ['allowBuilds', 'sharp'], true)).toThrow(
      'allowBuilds is written in flow style ({ ... } or [ ... ]), which depcurfew does not edit; rewrite it in block style, or set allowBuilds.sharp to true by hand',
    );
  });

  it('refuses to add a key to a flow map inside a sequence item', () => {
    const text = 'updates:\n  - { package-ecosystem: npm, directory: /, cooldown: { default-days: 1 } }\n';
    expect(() => yamlSet(text, ['updates', 0, 'cooldown', 'exclude'], ['react'])).toThrow('updates.0.cooldown is written in flow style');
  });

  it('refuses to add a key to a flow map that is the whole document', () => {
    expect(() => yamlSet('{ packages: [a] }\n', ['minimumReleaseAge'], 1440)).toThrow('the document is written in flow style');
  });

  it('replaces a scalar in a document that is one flow map', () => {
    const text = '{version: 2, updates: [{package-ecosystem: npm, cooldown: {default-days: 1}}]}\n';
    expect(yamlSet(text, ['updates', 0, 'cooldown', 'default-days'], 3)).toBe('{version: 2, updates: [{package-ecosystem: npm, cooldown: {default-days: 3}}]}\n');
  });

  it('still replaces a scalar inside a flow map in place', () => {
    const result = yamlSet('cooldown: { default-days: 1 }\n', ['cooldown', 'default-days'], 3);
    expect(result).toBe('cooldown: { default-days: 3 }\n');
    expect(parseYaml(result)).toEqual({ cooldown: { 'default-days': 3 } });
  });

  it('still replaces a flow list under a block map with a block list', () => {
    const result = yamlSet('minimumReleaseAgeExclude: [a]\n', ['minimumReleaseAgeExclude'], ['b']);
    expect(parseYaml(result)).toEqual({ minimumReleaseAgeExclude: ['b'] });
  });
});

describe('writeTomlBlock and values over several lines', () => {
  it('comments out every line of a superseded multi-line value', () => {
    const body = '[install]\nminimumReleaseAgeExcludes = [\n  "foo",\n  "bar",\n]\nregistry = "https://registry.npmjs.org/"\n';
    const result = writeTomlBlock(body, 'install', ['minimumReleaseAge = 259200'], ['minimumReleaseAge', 'minimumReleaseAgeExcludes']);
    expect(result).toBe(
      `[install]\n${SUPERSEDED}minimumReleaseAgeExcludes = [\n#   "foo",\n#   "bar",\n# ]\nregistry = "https://registry.npmjs.org/"\n\n${START}\nminimumReleaseAge = 259200\n${END}\n`,
    );
    expect(writeTomlBlock(result, 'install', ['minimumReleaseAge = 259200'], ['minimumReleaseAge', 'minimumReleaseAgeExcludes'])).toBe(result);
  });

  it('comments out a multi-line string and keeps brackets inside strings', () => {
    const body = '[install]\nminimumReleaseAgeExcludes = ["a]", "b"]\ncafile = """\n[not.a.table]\n"""\n';
    const result = writeTomlBlock(body, 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAgeExcludes', 'cafile']);
    expect(result).toBe(
      `[install]\n${SUPERSEDED}minimumReleaseAgeExcludes = ["a]", "b"]\n${SUPERSEDED}cafile = """\n# [not.a.table]\n# """\n\n${START}\nminimumReleaseAge = 1\n${END}\n`,
    );
  });

  it('does not take a nested array on its own line for a table header', () => {
    const body = '[run]\nmatrix = [\n  [1, 2]\n]\n[install]\nregistry = "x"\n';
    const result = writeTomlBlock(body, 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAge']);
    expect(result).toBe(`[run]\nmatrix = [\n  [1, 2]\n]\n[install]\nregistry = "x"\n\n${START}\nminimumReleaseAge = 1\n${END}\n`);
  });

  it('ends the table at an array-of-tables header', () => {
    const body = '[install]\nfoo = 1\n\n[[test.x]]\na = 1\n';
    expect(writeTomlBlock(body, 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAge'])).toBe(
      `[install]\nfoo = 1\n\n${START}\nminimumReleaseAge = 1\n${END}\n\n[[test.x]]\na = 1\n`,
    );
  });

  it('notes keys it comments out without writing a block accurately', () => {
    expect(writeTomlBlock('[install]\nminimumReleaseAge = 5\n', 'install', [], ['minimumReleaseAge'])).toBe(
      '[install]\n# depcurfew: turned off; depcurfew.json manages this setting: minimumReleaseAge = 5\n',
    );
  });

  it('refuses to add a table that dotted keys already define', () => {
    expect(() => writeTomlBlock('install.registry = "x"\n', 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAge'])).toThrow(
      'install is defined with dotted keys or an inline table, so a [install] table cannot be added; move its settings under a [install] header',
    );
    expect(() => writeTomlBlock('install = { registry = "x" }\n', 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAge'])).toThrow(
      'install is defined with dotted keys or an inline table',
    );
  });

  it('adds the table when the only dotted keys were managed ones it comments out', () => {
    expect(writeTomlBlock('install.minimumReleaseAge = 60\n', 'install', ['minimumReleaseAge = 1'], ['minimumReleaseAge'])).toBe(
      `${SUPERSEDED}install.minimumReleaseAge = 60\n\n[install]\n${START}\nminimumReleaseAge = 1\n${END}\n`,
    );
  });
});

describe('parseJsonc and trailing commas', () => {
  it('removes trailing commas but never changes strings', () => {
    expect(parseJsonc('{"prBodyNotes": ["a, ]"], "x": "b,  }",}')).toEqual({ prBodyNotes: ['a, ]'], x: 'b,  }' });
  });

  it('removes a trailing comma followed by a comment', () => {
    expect(parseJsonc('{"a": [1, 2, // last\n], /* end */ }')).toEqual({ a: [1, 2] });
  });
});

describe('JSON editing keeps comments', () => {
  it('keeps the comment of the next element when removing the first one', () => {
    const text = '{\n  "packageRules": [\n    { "description": "depcurfew" }, // Group eslint: keep this comment\n    { "groupName": "eslint" }\n  ]\n}\n';
    const result = jsonArrayRemove(text, ['packageRules'], 0);
    expect(result).toContain('// Group eslint: keep this comment');
    expect(parseJsonc(result)).toEqual({ packageRules: [{ groupName: 'eslint' }] });
  });

  it('keeps the trailing comment of the previous element when removing the last one', () => {
    const text = '{\n  "packageRules": [\n    { "groupName": "eslint" }, // keep\n    { "description": "depcurfew" }\n  ]\n}\n';
    const result = jsonArrayRemove(text, ['packageRules'], 1);
    expect(result).toBe('{\n  "packageRules": [\n    { "groupName": "eslint" } // keep\n  ]\n}\n');
  });

  it('removes a middle element with its line and keeps comments around it', () => {
    const text = '[\n  "a",\n  // about b\n  "b",\n  "c" // about c\n]\n';
    const result = jsonArrayRemove(`{"x": ${text}}`, ['x'], 1);
    expect(result).toBe('{"x": [\n  "a",\n  // about b\n  "c" // about c\n]\n}');
  });

  it('empties an array without comments as before', () => {
    expect(jsonArrayRemove('{"x": [1]}', ['x'], 0)).toBe('{"x": []}');
  });

  it('keeps single-line arrays tidy', () => {
    expect(jsonArrayRemove('{"x": ["a", "b", "c"]}', ['x'], 1)).toBe('{"x": ["a", "c"]}');
    expect(jsonArrayRemove('{"x": ["a", "b"]}', ['x'], 1)).toBe('{"x": ["a"]}');
    expect(jsonArrayRemove('{"x": ["a", "b"]}', ['x'], 0)).toBe('{"x": ["b"]}');
  });

  it('removes the last element of a multi-line array with its line', () => {
    expect(jsonArrayRemove('{"x": [\n  "a",\n  "b"\n]}', ['x'], 1)).toBe('{"x": [\n  "a"\n]}');
  });

  it('keeps a comment inside an empty array or object when adding to it', () => {
    const array = jsonArrayAppend('{\n  "allowScripts": [\n    // reviewed by security team\n  ]\n}\n', ['allowScripts'], 'npm:esbuild');
    expect(array).toBe('{\n  "allowScripts": [\n    // reviewed by security team\n    "npm:esbuild"\n  ]\n}\n');
    const object = jsonSet('{\n  "x": { /* nothing yet */ }\n}\n', ['x', 'a'], 1);
    expect(object).toContain('/* nothing yet */');
    expect(parseJsonc(object)).toEqual({ x: { a: 1 } });
  });
});

describe('writeIniBlock without a block', () => {
  it('notes keys it comments out accurately', async () => {
    const { writeIniBlock } = await import('../../src/apply/ini.ts');
    expect(writeIniBlock('dangerously-allow-all-scripts=true\n', [], ['dangerously-allow-all-scripts'])).toBe(
      '# depcurfew: turned off; depcurfew.json manages this setting: dangerously-allow-all-scripts=true\n',
    );
  });
});
