import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/apply/diff.ts';
import { writeIniBlock } from '../../src/apply/ini.ts';
import { jsonGet, jsonSet, jsonArrayAppend, jsonArrayRemove, jsonArrayReplace } from '../../src/apply/json-edit.ts';
import { detectStyle, restoreStyle, toLf } from '../../src/apply/text.ts';
import { writeTomlBlock } from '../../src/apply/toml.ts';
import { parseToml } from '../../src/detect/toml.ts';
import { yamlGet, yamlSet } from '../../src/apply/yaml-edit.ts';

const START = '# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead';
const END = '# <<< depcurfew managed block';

describe('text style', () => {
  it('detects and restores CRLF, a byte order mark and a missing final newline', () => {
    const text = '﻿a=1\r\nb=2';
    const style = detectStyle(text);
    expect(style).toEqual({ eol: '\r\n', bom: true, finalNewline: false });
    expect(toLf(text)).toBe('a=1\nb=2');
    expect(restoreStyle('a=1\nb=2\nc=3\n', style)).toBe('﻿a=1\r\nb=2\r\nc=3');
  });

  it('defaults to LF with a final newline for new files', () => {
    expect(detectStyle('')).toEqual({ eol: '\n', bom: false, finalNewline: true });
  });
});

describe('writeIniBlock (.npmrc)', () => {
  it('appends a managed block after a blank line', () => {
    expect(writeIniBlock('save-exact=true\n', ['min-release-age=3'], ['min-release-age'])).toBe(
      `save-exact=true\n\n${START}\nmin-release-age=3\n${END}\n`,
    );
  });

  it('creates the block in an empty file', () => {
    expect(writeIniBlock('', ['a=1'], ['a'])).toBe(`${START}\na=1\n${END}\n`);
  });

  it('replaces an existing block in place and keeps the rest', () => {
    const before = `# top\n${START}\nmin-release-age=1\n${END}\nregistry=https://example.test/\n`;
    expect(writeIniBlock(before, ['min-release-age=3'], ['min-release-age'])).toBe(
      `# top\n${START}\nmin-release-age=3\n${END}\nregistry=https://example.test/\n`,
    );
  });

  it('comments out managed keys set outside the block, including list keys', () => {
    const before = 'min-release-age = 1\nmin-release-age-exclude[]=old\nsave-exact=true\n';
    expect(writeIniBlock(before, ['min-release-age=3'], ['min-release-age', 'min-release-age-exclude'])).toBe(
      [
        '# depcurfew: superseded by the managed block: min-release-age = 1',
        '# depcurfew: superseded by the managed block: min-release-age-exclude[]=old',
        'save-exact=true',
        '',
        START,
        'min-release-age=3',
        END,
        '',
      ].join('\n'),
    );
  });

  it('removes its own block when nothing is managed any more', () => {
    expect(writeIniBlock(`a=1\n\n${START}\nb=2\n${END}\n`, [], ['b'])).toBe('a=1\n');
  });

  it('is idempotent', () => {
    const once = writeIniBlock('x=1\nmin-release-age=1\n', ['min-release-age=3'], ['min-release-age']);
    expect(writeIniBlock(once, ['min-release-age=3'], ['min-release-age'])).toBe(once);
  });
});

describe('writeTomlBlock (bunfig.toml)', () => {
  it('adds the block at the end of the existing table', () => {
    const before = '[install]\nexact = true\n\n[run]\nbun = true\n';
    expect(writeTomlBlock(before, 'install', ['minimumReleaseAge = 259200'], ['minimumReleaseAge'])).toBe(
      `[install]\nexact = true\n\n${START}\nminimumReleaseAge = 259200\n${END}\n\n[run]\nbun = true\n`,
    );
  });

  it('creates the table when it is missing', () => {
    expect(writeTomlBlock('telemetry = false\n', 'install', ['a = 1'], ['a'])).toBe(
      `telemetry = false\n\n[install]\n${START}\na = 1\n${END}\n`,
    );
    expect(writeTomlBlock('', 'install', ['a = 1'], ['a'])).toBe(`[install]\n${START}\na = 1\n${END}\n`);
  });

  it('comments out managed keys in the table and dotted keys elsewhere, but not in subtables', () => {
    const before = 'install.minimumReleaseAge = 1\n[install]\nminimumReleaseAge = 2\n[install.scopes]\nminimumReleaseAge = "kept"\n';
    expect(writeTomlBlock(before, 'install', ['minimumReleaseAge = 3'], ['minimumReleaseAge'])).toBe(
      [
        '# depcurfew: superseded by the managed block: install.minimumReleaseAge = 1',
        '[install]',
        '# depcurfew: superseded by the managed block: minimumReleaseAge = 2',
        '',
        START,
        'minimumReleaseAge = 3',
        END,
        '[install.scopes]',
        'minimumReleaseAge = "kept"',
        '',
      ].join('\n'),
    );
  });

  it('replaces its block and is idempotent', () => {
    const once = writeTomlBlock('[install]\nexact = true\n', 'install', ['a = 1'], ['a']);
    expect(writeTomlBlock(once, 'install', ['a = 1'], ['a'])).toBe(once);
    expect(writeTomlBlock(once, 'install', ['a = 2'], ['a'])).toBe(once.replace('a = 1', 'a = 2'));
  });
});

describe('writeTomlBlock (uv.toml, pyproject.toml, poetry.toml)', () => {
  it('writes top-level keys after the existing ones and before the first table', () => {
    const before = '# Shared settings.\nindex-strategy = "first-index"\nexclude-newer = "1 day"\n\n[[index]]\nname = "internal"\n';
    expect(writeTomlBlock(before, '', ['exclude-newer = "3 days"'], ['exclude-newer'])).toBe(
      [
        '# Shared settings.',
        'index-strategy = "first-index"',
        '# depcurfew: superseded by the managed block: exclude-newer = "1 day"',
        '',
        START,
        'exclude-newer = "3 days"',
        END,
        '',
        '[[index]]',
        'name = "internal"',
        '',
      ].join('\n'),
    );
    expect(writeTomlBlock('', '', ['no-build = true'], ['no-build'])).toBe(`${START}\nno-build = true\n${END}\n`);
  });

  it('keeps a top-level block in place and is idempotent', () => {
    const once = writeTomlBlock('[[index]]\nname = "internal"\n', '', ['exclude-newer = "3 days"'], ['exclude-newer']);
    expect(once).toBe(`${START}\nexclude-newer = "3 days"\n${END}\n\n[[index]]\nname = "internal"\n`);
    expect(writeTomlBlock(once, '', ['exclude-newer = "3 days"'], ['exclude-newer'])).toBe(once);
    expect(writeTomlBlock(once, '', [], ['exclude-newer'])).toBe('[[index]]\nname = "internal"\n');
  });

  it('writes into a dotted table such as [tool.uv] and leaves its subtables alone', () => {
    const before = '[project]\nname = "demo"\n\n[tool.uv]\nrequired-version = "==0.13.6"\n\n[tool.uv.sources]\nlib = { path = "lib" }\n';
    expect(writeTomlBlock(before, 'tool.uv', ['no-build = true'], ['no-build'])).toBe(
      `[project]\nname = "demo"\n\n[tool.uv]\nrequired-version = "==0.13.6"\n\n${START}\nno-build = true\n${END}\n\n[tool.uv.sources]\nlib = { path = "lib" }\n`,
    );
  });

  it('comments out a managed key written as a table of its own or with dotted keys', () => {
    const before = '[tool.uv]\nno-build = false\n\n[tool.uv.exclude-newer-package]\nfoo = false\n\n[tool.uv.sources]\nlib = { path = "lib" }\n';
    const after = writeTomlBlock(before, 'tool.uv', ['exclude-newer-package = { "idna" = false }'], ['exclude-newer-package']);
    expect(after).toContain('# depcurfew: superseded by the managed block: [tool.uv.exclude-newer-package]\n# depcurfew: superseded by the managed block: foo = false');
    expect(after).toContain('[tool.uv.sources]\nlib = { path = "lib" }');
    expect(() => parseToml(after)).not.toThrow();
    const top = writeTomlBlock('exclude-newer-package.foo = false\n', '', ['exclude-newer-package = { "a" = false }'], ['exclude-newer-package']);
    expect(top.startsWith('# depcurfew: superseded by the managed block: exclude-newer-package.foo = false')).toBe(true);
    expect(() => parseToml(top)).not.toThrow();
  });

  it('keeps one block per table when the blocks carry the table name', () => {
    const solver = (body: string, days: number) => writeTomlBlock(body, 'solver', [`min-release-age = ${days}`], ['min-release-age'], 'solver');
    const installer = (body: string) => writeTomlBlock(body, 'installer', ['only-binary = [":all:"]'], ['only-binary'], 'installer');
    const once = installer(solver('[virtualenvs]\nin-project = true\n', 3));
    const solverStart = START.replace(': ', ' [solver]: ');
    const installerStart = START.replace(': ', ' [installer]: ');
    expect(once).toBe(
      `[virtualenvs]\nin-project = true\n\n[solver]\n${solverStart}\nmin-release-age = 3\n${END}\n\n[installer]\n${installerStart}\nonly-binary = [":all:"]\n${END}\n`,
    );
    expect(installer(solver(once, 3))).toBe(once);
    expect(installer(solver(once, 5))).toBe(once.replace('min-release-age = 3', 'min-release-age = 5'));
  });
});

describe('yamlSet', () => {
  const pnpm = [
    '# pnpm settings',
    'packages:',
    "  - 'apps/*'   # apps",
    '',
    'minimumReleaseAge: 1440 # one day',
    'flow: {a: 1, b: [x, y]}',
    'allowBuilds:',
    '  sharp: true',
    '',
  ].join('\n');

  it('replaces a scalar in place, keeps its comment and marks the key', () => {
    expect(yamlSet(pnpm, ['minimumReleaseAge'], 4320)).toBe(
      pnpm.replace('minimumReleaseAge: 1440 # one day', '# managed by depcurfew\nminimumReleaseAge: 4320 # one day'),
    );
  });

  it('leaves the text untouched when the value is already right', () => {
    expect(yamlSet(pnpm, ['minimumReleaseAge'], 1440)).toBe(pnpm);
  });

  it('appends a new key with a marker, using the file’s sequence style', () => {
    expect(yamlSet(pnpm, ['minimumReleaseAgeExclude'], ['@acme/*'])).toBe(
      `${pnpm}# managed by depcurfew\nminimumReleaseAgeExclude:\n  - "@acme/*"\n`,
    );
    const flat = 'packages:\n- a\n';
    expect(yamlSet(flat, ['onlyBuiltDependencies'], ['esbuild'])).toBe(
      `${flat}# managed by depcurfew\nonlyBuiltDependencies:\n- esbuild\n`,
    );
  });

  it('adds an entry to a nested map without touching the other entries', () => {
    expect(yamlSet(pnpm, ['allowBuilds', 'esbuild'], true)).toBe(`${pnpm.replace('  sharp: true\n', '  sharp: true\n  # managed by depcurfew\n  esbuild: true\n')}`);
  });

  it('replaces a list with a new list', () => {
    const before = 'npmPreapprovedPackages: [old]\nother: 1\n';
    expect(yamlSet(before, ['npmPreapprovedPackages'], ['@acme/*', 'b'])).toBe(
      '# managed by depcurfew\nnpmPreapprovedPackages:\n  - "@acme/*"\n  - b\nother: 1\n',
    );
  });

  it('creates nested maps inside a sequence item', () => {
    const before = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: docker\n    directory: /\n';
    expect(yamlSet(before, ['updates', 0, 'cooldown'], { 'default-days': 3, exclude: ['@acme/*'] })).toBe(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: /',
        '    # managed by depcurfew',
        '    cooldown:',
        '      default-days: 3',
        '      exclude:',
        '        - "@acme/*"',
        '  - package-ecosystem: docker',
        '    directory: /',
        '',
      ].join('\n'),
    );
  });

  it('sets a key inside an existing nested map and keeps its siblings', () => {
    const before = 'updates:\n  - package-ecosystem: npm\n    cooldown:\n      semver-major-days: 7\n';
    expect(yamlSet(before, ['updates', 0, 'cooldown', 'default-days'], 3)).toBe(
      'updates:\n  - package-ecosystem: npm\n    cooldown:\n      semver-major-days: 7\n      # managed by depcurfew\n      default-days: 3\n',
    );
  });

  it('writes into an empty document and adds a final newline when missing', () => {
    expect(yamlSet('', ['minimumReleaseAge'], 4320)).toBe('# managed by depcurfew\nminimumReleaseAge: 4320\n');
    expect(yamlSet('a: 1', ['b'], 2)).toBe('a: 1\n# managed by depcurfew\nb: 2\n');
  });

  it('does not add a second marker', () => {
    const once = yamlSet('minimumReleaseAge: 1\n', ['minimumReleaseAge'], 2);
    expect(yamlSet(once, ['minimumReleaseAge'], 3)).toBe(once.replace(': 2', ': 3'));
  });

  it('reads values', () => {
    expect(yamlGet(pnpm, ['allowBuilds', 'sharp'])).toBe(true);
    expect(yamlGet(pnpm, ['missing', 'key'])).toBeUndefined();
  });

  it('refuses a document that is not a map', () => {
    expect(() => yamlSet('- a\n', ['b'], 1)).toThrow(/not a map/);
  });
});

describe('JSON and JSONC editing', () => {
  const pkg = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';

  it('adds a property at the end with the file’s indentation', () => {
    expect(jsonSet(pkg, ['allowScripts'], { esbuild: true })).toBe(
      '{\n  "name": "x",\n  "version": "1.0.0",\n  "allowScripts": {\n    "esbuild": true\n  }\n}\n',
    );
    const tabs = '{\n\t"name": "x"\n}';
    expect(jsonSet(tabs, ['trustedDependencies'], ['esbuild'])).toBe('{\n\t"name": "x",\n\t"trustedDependencies": [\n\t\t"esbuild"\n\t]\n}');
  });

  it('creates missing parents and adds to existing objects', () => {
    const once = jsonSet(pkg, ['allowScripts', 'esbuild'], true);
    expect(once).toBe('{\n  "name": "x",\n  "version": "1.0.0",\n  "allowScripts": {\n    "esbuild": true\n  }\n}\n');
    expect(jsonSet(once, ['allowScripts', 'sharp'], true)).toBe(
      '{\n  "name": "x",\n  "version": "1.0.0",\n  "allowScripts": {\n    "esbuild": true,\n    "sharp": true\n  }\n}\n',
    );
  });

  it('replaces a value in place', () => {
    expect(jsonSet(pkg, ['version'], '2.0.0')).toBe(pkg.replace('1.0.0', '2.0.0'));
    expect(jsonSet(pkg, ['version'], '1.0.0')).toBe(pkg);
  });

  it('keeps comments and trailing commas in JSONC', () => {
    const jsonc = '{\n  // comment\n  "imports": {}, // trailing\n}\n';
    expect(jsonSet(jsonc, ['minimumDependencyAge'], 4320)).toBe('{\n  // comment\n  "imports": {}, // trailing\n  "minimumDependencyAge": 4320,\n}\n');
    expect(jsonGet(jsonc, ['imports'])).toEqual({});
  });

  it('fills an empty object', () => {
    expect(jsonSet('{}\n', ['a'], 1)).toBe('{\n  "a": 1\n}\n');
    expect(jsonSet('{\n  "a": {}\n}\n', ['a', 'b'], [1])).toBe('{\n  "a": {\n    "b": [\n      1\n    ]\n  }\n}\n');
  });

  it('appends, replaces and removes array elements', () => {
    const rules = '{\n  "packageRules": [\n    { "matchPackageNames": ["a"] }\n  ]\n}\n';
    const appended = jsonArrayAppend(rules, ['packageRules'], { description: 'x' });
    expect(appended).toBe('{\n  "packageRules": [\n    { "matchPackageNames": ["a"] },\n    {\n      "description": "x"\n    }\n  ]\n}\n');
    expect(jsonArrayReplace(appended, ['packageRules'], 1, { description: 'y' })).toBe(appended.replace('"x"', '"y"'));
    expect(jsonArrayRemove(appended, ['packageRules'], 1)).toBe(rules);
    expect(jsonArrayAppend('{\n  "a": []\n}\n', ['a'], 1)).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });

  it('refuses a document that is not an object', () => {
    expect(() => jsonSet('[]', ['a'], 1)).toThrow(/not an object/);
  });
});

describe('unifiedDiff', () => {
  it('shows changed lines with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'].join('\n') + '\n';
    expect(unifiedDiff('x.txt', before, after)).toBe(
      ['--- a/x.txt', '+++ b/x.txt', '@@ -2,7 +2,8 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', '+i', ''].join('\n'),
    );
  });

  it('shows a new file', () => {
    expect(unifiedDiff('.npmrc', null, 'a=1\n')).toBe(['--- /dev/null', '+++ b/.npmrc', '@@ -0,0 +1 @@', '+a=1', ''].join('\n'));
  });

  it('is empty when nothing changed', () => {
    expect(unifiedDiff('x', 'a\n', 'a\n')).toBe('');
  });
});
