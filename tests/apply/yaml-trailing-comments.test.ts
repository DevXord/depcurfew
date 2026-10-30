// YAML edits next to comments that end a map or a list (D-074). The yaml library counts such comments, and the
// indentation of the next line, as part of the node before them, so an edit that ended at the node's end used to
// eat that indentation: the next entry of dependabot.yml landed in column 0 and the file broke. An edit now ends
// with the last line of content, and the result is parsed again: an edit that would break the file or change a
// setting depcurfew does not manage is refused.
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { yamlSet } from '../../src/apply/yaml-edit.ts';

const MARKER = '# managed by depcurfew';

/** Every comment line of `before` is still a line of `after`. */
function expectCommentsKept(before: string, after: string): void {
  const lines = after.split('\n');
  for (const line of before.split('\n').filter((entry) => entry.trim().startsWith('#'))) expect(lines, line).toContain(line);
}

describe('yamlSet: a comment at the end of a dependabot.yml entry', () => {
  const before = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: npm',
    '    directory: "/"',
    '    schedule:',
    '      interval: weekly',
    '    # open-pull-requests-limit: 5',
    '  - package-ecosystem: github-actions',
    '    directory: "/"',
    '',
  ].join('\n');

  it('adds the key before the comment and keeps the next entry where it was', () => {
    const after = yamlSet(before, ['updates', 0, 'cooldown'], { 'default-days': 3 });
    expect(after).toBe(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: "/"',
        '    schedule:',
        '      interval: weekly',
        `    ${MARKER}`,
        '    cooldown:',
        '      default-days: 3',
        '    # open-pull-requests-limit: 5',
        '  - package-ecosystem: github-actions',
        '    directory: "/"',
        '',
      ].join('\n'),
    );
    expect(parseYaml(after)).toEqual({
      version: 2,
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', schedule: { interval: 'weekly' }, cooldown: { 'default-days': 3 } },
        { 'package-ecosystem': 'github-actions', directory: '/' },
      ],
    });
    expect(yamlSet(after, ['updates', 0, 'cooldown'], { 'default-days': 3 })).toBe(after);
  });

  it('adds a key to the last entry of a file without a final newline', () => {
    const text = 'updates:\n  - package-ecosystem: npm\n    directory: "/"\n    # comment';
    expect(yamlSet(text, ['updates', 0, 'cooldown'], { 'default-days': 3 })).toBe(
      `updates:\n  - package-ecosystem: npm\n    directory: "/"\n    ${MARKER}\n    cooldown:\n      default-days: 3\n    # comment`,
    );
  });
});

describe('yamlSet: a commented-out list item at the end of an entry', () => {
  const before = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: npm',
    '    directory: "/"',
    '    ignore:',
    '      - dependency-name: "react"',
    '      # - dependency-name: "eslint"',
    '  - package-ecosystem: github-actions',
    '    directory: "/"',
    '',
  ].join('\n');

  it('keeps the commented item with its list and adds the key after it', () => {
    const after = yamlSet(before, ['updates', 0, 'cooldown'], { 'default-days': 3 });
    expect(after).toBe(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: "/"',
        '    ignore:',
        '      - dependency-name: "react"',
        '      # - dependency-name: "eslint"',
        `    ${MARKER}`,
        '    cooldown:',
        '      default-days: 3',
        '  - package-ecosystem: github-actions',
        '    directory: "/"',
        '',
      ].join('\n'),
    );
    expect((parseYaml(after) as { updates: unknown[] }).updates).toHaveLength(2);
  });

  it('keeps blank lines between the list and the comments that follow it', () => {
    const text = 'packages:\n  - "packages/*"\n\n  # - "apps/*"\n';
    expect(yamlSet(text, ['minimumReleaseAge'], 4320)).toBe(`packages:\n  - "packages/*"\n\n  # - "apps/*"\n${MARKER}\nminimumReleaseAge: 4320\n`);
  });
});

describe('yamlSet: replacing a list that ends with a comment', () => {
  const before = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: npm',
    '    directory: "/"',
    '    cooldown:',
    '      default-days: 1',
    '      exclude:',
    '        - "react"',
    '        # - "vue"',
    '  - package-ecosystem: github-actions',
    '    directory: "/"',
    '',
  ].join('\n');

  it('replaces only the items and keeps the comment and the next entry', () => {
    const after = yamlSet(before, ['updates', 0, 'cooldown', 'exclude'], ['@acme/*', 'left-pad']);
    expect(after).toBe(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: "/"',
        '    cooldown:',
        '      default-days: 1',
        `      ${MARKER}`,
        '      exclude:',
        '        - "@acme/*"',
        '        - left-pad',
        '        # - "vue"',
        '  - package-ecosystem: github-actions',
        '    directory: "/"',
        '',
      ].join('\n'),
    );
    expectCommentsKept(before, after);
  });

  it('makes a second edit in the same file on the result of the first', () => {
    const first = yamlSet(before, ['updates', 0, 'cooldown', 'default-days'], 3);
    const second = yamlSet(first, ['updates', 0, 'cooldown', 'exclude'], ['left-pad']);
    expect(parseYaml(second)).toEqual({
      version: 2,
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', cooldown: { 'default-days': 3, exclude: ['left-pad'] } },
        { 'package-ecosystem': 'github-actions', directory: '/' },
      ],
    });
    expectCommentsKept(before, second);
    expect(yamlSet(yamlSet(second, ['updates', 0, 'cooldown', 'default-days'], 3), ['updates', 0, 'cooldown', 'exclude'], ['left-pad'])).toBe(second);
  });

  it('keeps a comment on the line of the key and the comments before the first item', () => {
    const text = 'minimumReleaseAgeExclude: # trusted\n  # our own packages\n  - "@acme/*"\n  # - "react"\nother: 1\n';
    expect(yamlSet(text, ['minimumReleaseAgeExclude'], ['left-pad'])).toBe(
      `${MARKER}\nminimumReleaseAgeExclude: # trusted\n  # our own packages\n  - left-pad\n  # - "react"\nother: 1\n`,
    );
  });

  it('keeps the comment after a flow list it replaces with a block list', () => {
    expect(yamlSet('minimumReleaseAgeExclude: [a]  # trusted\nother: 1\n', ['minimumReleaseAgeExclude'], ['b'])).toBe(
      `${MARKER}\nminimumReleaseAgeExclude:  # trusted\n  - b\nother: 1\n`,
    );
  });

  it('writes an empty list in place of a block list before the comment of the key line', () => {
    expect(yamlSet('exclude: # none yet\n  - a\nother: 1\n', ['exclude'], [])).toBe(`${MARKER}\nexclude: [] # none yet\nother: 1\n`);
  });

  it('writes a value after a key that has none, keeping its comment', () => {
    expect(yamlSet('cooldown:\n  default-days: # set by depcurfew\n', ['cooldown', 'default-days'], 3)).toBe(
      `cooldown:\n  ${MARKER}\n  default-days: 3 # set by depcurfew\n`,
    );
    expect(yamlSet('minimumReleaseAge:\nother: 1\n', ['minimumReleaseAge'], 4320)).toBe(`${MARKER}\nminimumReleaseAge: 4320\nother: 1\n`);
  });
});

describe('yamlSet: comments at the end of top-level maps and lists', () => {
  it('pnpm-workspace.yaml: a commented package at the end of packages', () => {
    const before = 'packages:\n  - "packages/*"\n  # - "apps/*"\n';
    const after = yamlSet(before, ['minimumReleaseAge'], 4320);
    expect(after).toBe(`packages:\n  - "packages/*"\n  # - "apps/*"\n${MARKER}\nminimumReleaseAge: 4320\n`);
    expect(yamlSet(after, ['minimumReleaseAge'], 4320)).toBe(after);
  });

  it('pnpm-workspace.yaml: a key added to a map that ends with a comment, before another key', () => {
    const before = 'allowBuilds:\n  esbuild: true\n  # sharp: true\npackages:\n  - "packages/*"\n';
    const after = yamlSet(before, ['allowBuilds', 'core-js'], true);
    expect(after).toBe(`allowBuilds:\n  esbuild: true\n  # managed by depcurfew\n  core-js: true\n  # sharp: true\npackages:\n  - "packages/*"\n`);
    expect(parseYaml(after)).toEqual({ allowBuilds: { esbuild: true, 'core-js': true }, packages: ['packages/*'] });
  });

  it('.yarnrc.yml: a list that ends with a comment before the next key', () => {
    const before = 'npmPreapprovedPackages:\n  - "react"\n  # - "vue"\nnodeLinker: node-modules\n';
    const after = yamlSet(before, ['npmPreapprovedPackages'], ['@acme/*']);
    expect(after).toBe(`${MARKER}\nnpmPreapprovedPackages:\n  - "@acme/*"\n  # - "vue"\nnodeLinker: node-modules\n`);
    expect(parseYaml(after)).toEqual({ npmPreapprovedPackages: ['@acme/*'], nodeLinker: 'node-modules' });
  });

  it('.yarnrc.yml: a list not indented under its key', () => {
    const before = 'npmPreapprovedPackages:\n- "react"\n# - "vue"\nnodeLinker: node-modules\n';
    const after = yamlSet(before, ['npmPreapprovedPackages'], ['@acme/*']);
    expect(after).toBe(`${MARKER}\nnpmPreapprovedPackages:\n- "@acme/*"\n# - "vue"\nnodeLinker: node-modules\n`);
    expect(yamlSet(after, ['enableScripts'], false)).toBe(`${after}${MARKER}\nenableScripts: false\n`);
  });

  it('.yarnrc.yml: a map that ends with a comment, at the end of the file', () => {
    const before = 'packageExtensions:\n  "debug@*":\n    peerDependencies:\n      supports-color: "*"\n    # dependencies: {}\n';
    const after = yamlSet(before, ['npmMinimalAgeGate'], '3d');
    expect(after).toBe(`${before}${MARKER}\nnpmMinimalAgeGate: 3d\n`);
  });
});

describe('yamlSet checks its result', () => {
  it('refuses an edit that would change a setting it does not manage', () => {
    // The list is shared through an anchor, so replacing it would change the alias too.
    const text = 'minimumReleaseAgeExclude: &trusted\n  - a\nother: *trusted\n';
    expect(() => yamlSet(text, ['minimumReleaseAgeExclude'], ['b'])).toThrow(
      'setting minimumReleaseAgeExclude (line 1) would change other settings in the file, so depcurfew did not edit it; set minimumReleaseAgeExclude to ["b"] by hand',
    );
  });
});
