// BUNDLE_COOLDOWN read as Bundler reads it (decision D-159): .bundle/config with Bundler's own line reader
// (Gem::YAMLSerializer, not YAML), and every value with String#to_i, also in the env of a CI workflow.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleConfigValue, rubyToI } from '../src/doctor/bundle-config.ts';
import { runDoctor } from '../src/doctor/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-bundle-config-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const POLICY = JSON.stringify({ version: 1, cooldown: { minimum: '7d' } });
const LOCK = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.2.3)\n\nBUNDLED WITH\n   4.0.23\n';
const GEMFILE = 'source "https://rubygems.org", cooldown: 7\n';
const weakens = (root: string) => runDoctor(root).findings.filter((finding) => finding.rule === 'bundler-config-weakens');

describe('String#to_i', () => {
  it.each([
    ['7', 7],
    ['  7 days', 7],
    ['\t\n+14', 14],
    ['-3', -3],
    ['0d14', 14],
    ['0D14', 14],
    ['1_4', 14],
    ['1__4', 1],
    ['14_', 14],
    ['_14', 0],
    ['0x10', 0],
    ['0o14', 0],
    ['1e3', 1],
    ['1e400', 1],
    ['"14"', 0],
    ['[0]', 0],
    ['~', 0],
    ['true', 0],
    ['', 0],
    ['0d', 0],
    ['- 7', 0],
  ])('%j is %d', (text, value) => {
    expect(rubyToI(text)).toBe(value);
  });
});

describe('.bundle/config as Bundler reads it', () => {
  it.each([
    ['BUNDLE_COOLDOWN: "14"', '14'],
    ["BUNDLE_COOLDOWN: '14'", '14'],
    ['BUNDLE_COOLDOWN: 14', '14'],
    ['BUNDLE_COOLDOWN:  "14"', ' "14"'],
    ['BUNDLE_COOLDOWN: "14" # two weeks', '"14"'],
    ['BUNDLE_COOLDOWN: 14 # two weeks', '14'],
    ['BUNDLE_COOLDOWN: # nothing', '# nothing'],
    ['BUNDLE_COOLDOWN: "14', '"14'],
    ['BUNDLE_COOLDOWN: ~', '~'],
    ['BUNDLE_COOLDOWN: [0]', '[0]'],
    ['BUNDLE_COOLDOWN: a: 1', undefined],
    [' BUNDLE_COOLDOWN: 3', '3'],
  ])('%j is %j', (line, value) => {
    const found = bundleConfigValue(`---\n${line}\n`, 'BUNDLE_COOLDOWN');
    expect(found === undefined || found === 'error' || found.kind !== 'text' ? undefined : found.value).toBe(value);
  });

  it('takes the last line of a key, keys spelled exactly, at the top level only', () => {
    expect(bundleConfigValue('---\nBUNDLE_COOLDOWN: "0"\nBUNDLE_COOLDOWN: "14"\n', 'BUNDLE_COOLDOWN')).toEqual({ kind: 'text', value: '14', line: 3, written: 'BUNDLE_COOLDOWN: "14"' });
    expect(bundleConfigValue('---\n"BUNDLE_COOLDOWN": "0"\n{BUNDLE_COOLDOWN: "0"}\nBUNDLE_COOLDOWN : 0\nbundle_cooldown: 0\n', 'BUNDLE_COOLDOWN')).toBeUndefined();
    expect(bundleConfigValue('---\nBUNDLE_MIRROR:\n  BUNDLE_COOLDOWN: "0"\n', 'BUNDLE_COOLDOWN')).toBeUndefined();
  });

  it('gives a map or a list, which stop Bundler, as other, and a file Bundler cannot read as an error', () => {
    expect(bundleConfigValue('---\nBUNDLE_COOLDOWN:\n', 'BUNDLE_COOLDOWN')).toMatchObject({ kind: 'other', line: 2 });
    expect(bundleConfigValue('---\nBUNDLE_COOLDOWN: []\n', 'BUNDLE_COOLDOWN')).toMatchObject({ kind: 'other', line: 2 });
    expect(bundleConfigValue('---\nBUNDLE_COOLDOWN:\n- 0\n', 'BUNDLE_COOLDOWN')).toMatchObject({ kind: 'other', line: 2 });
    expect(bundleConfigValue('---\n    BUNDLE_COOLDOWN: "0"\n', 'BUNDLE_COOLDOWN')).toBe('error');
    expect(bundleConfigValue('---\n- 0\n', 'BUNDLE_COOLDOWN')).toBe('error');
  });
});

describe('bundler-config-weakens reads BUNDLE_COOLDOWN as Bundler does', () => {
  it.each([
    ['BUNDLE_COOLDOWN: ~\n'],
    ['BUNDLE_COOLDOWN: null\n'],
    ['BUNDLE_COOLDOWN: true\n'],
    ['BUNDLE_COOLDOWN: 0x10\n'],
    ['BUNDLE_COOLDOWN: 0o14\n'],
    ['BUNDLE_COOLDOWN: [0]\n'],
    ['BUNDLE_COOLDOWN: 1e3\n'],
    ['BUNDLE_COOLDOWN: "14" # two weeks\n'],
    ['BUNDLE_COOLDOWN: "14"\nBUNDLE_COOLDOWN: "0"\n'],
  ])('%j turns the cooldown off or shortens it and is reported', (config) => {
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.bundle/config': `---\n${config}`, 'depcurfew.json': POLICY });
    expect(weakens(root)).toHaveLength(1);
  });

  it.each([
    ['"BUNDLE_COOLDOWN": "0"\n'],
    ['{BUNDLE_COOLDOWN: "0"}\n'],
    ['BUNDLE_COOLDOWN : 0\n'],
    ['BUNDLE_COOLDOWN: "0"\nBUNDLE_COOLDOWN: "14"\n'],
    ['BUNDLE_COOLDOWN: 0d14\n'],
    ['BUNDLE_COOLDOWN: "false"\n'],
    ['BUNDLE_COOLDOWN:\n'],
  ])('%j is not what Bundler reads as a shorter cooldown and is not reported', (config) => {
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.bundle/config': `---\n${config}`, 'depcurfew.json': POLICY });
    expect(weakens(root)).toEqual([]);
  });

  it('says what Bundler reads when the line is not what it looks like', () => {
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.bundle/config': '---\nBUNDLE_COOLDOWN: "14" # two weeks\n', 'depcurfew.json': POLICY });
    expect(weakens(root)).toEqual([
      {
        rule: 'bundler-config-weakens',
        level: 'error',
        location: { file: '.bundle/config', line: 2 },
        message:
          '`BUNDLE_COOLDOWN: "14" # two weeks` in .bundle/config sets BUNDLE_COOLDOWN to the text "\\"14\\"" (Bundler reads the file line by line, not as YAML), which to_i reads as 0, so it turns off the cooldown of Bundler for every source, in place of the cooldown: of the Gemfile; Bundler reads .bundle/config before the environment',
        fix: 'Remove BUNDLE_COOLDOWN from .bundle/config (bundle config unset --local cooldown), so that the cooldown: of the Gemfile applies, or set it to at least 7 (bundle config set --local cooldown 7)',
      },
    ]);
  });

  it('names how to_i reads a plain value', () => {
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.bundle/config': '---\nBUNDLE_COOLDOWN: 1e3\n', 'depcurfew.json': POLICY });
    expect(weakens(root).map((finding) => finding.message)).toEqual([
      'BUNDLE_COOLDOWN: "1e3" in .bundle/config, which Bundler reads with to_i as 1, sets the cooldown of Bundler to 1 day for every source in place of the cooldown: of the Gemfile, shorter than the 7d of depcurfew.json; Bundler reads .bundle/config before the environment',
    ]);
  });

  it('reads a number in the env of a workflow as written: 1e400 is 1 day, not Infinity', () => {
    const workflow = 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      BUNDLE_COOLDOWN: 1e400\n    steps:\n      - run: bundle install\n';
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.github/workflows/ci.yml': workflow, 'depcurfew.json': POLICY });
    expect(weakens(root).map((finding) => [finding.location, finding.message])).toEqual([
      [
        { file: '.github/workflows/ci.yml', line: 6 },
        'BUNDLE_COOLDOWN=1e400 in the env of job a in .github/workflows/ci.yml reaches every Bundler command there, which Bundler reads with to_i as 1, and sets the cooldown of Bundler to 1 day for every source in place of the cooldown: of the Gemfile, shorter than the 7d of depcurfew.json',
      ],
    ]);
  });

  it.each([['0x10'], ['~'], ['true'], ['"0d3"']])('BUNDLE_COOLDOWN: %s in the env of a workflow is reported', (value) => {
    const workflow = `on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      BUNDLE_COOLDOWN: ${value}\n    steps:\n      - run: bundle install\n`;
    const root = repository({ Gemfile: GEMFILE, 'Gemfile.lock': LOCK, '.github/workflows/ci.yml': workflow, 'depcurfew.json': POLICY });
    expect(weakens(root)).toHaveLength(1);
  });
});
