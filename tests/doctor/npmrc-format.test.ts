// .npmrc as npm reads it with the ini package (extra.npmrcFormat): comments after a value, quotes, escapes, keys
// without a value and [section] headers, below which keys belong to the section and are not npm settings.
import { describe, expect, it } from 'vitest';
import { writeIniBlock } from '../../src/apply/ini.ts';
import { BLOCK_END, BLOCK_START } from '../../src/apply/block.ts';
import { iniEntries, iniLines } from '../../src/doctor/settings.ts';

const values = (text: string) => Object.fromEntries(iniEntries(text).map((entry) => [entry.key, entry.value]));

describe('iniEntries', () => {
  it('cuts a value at an unescaped # or ;, as npm does', () => {
    expect(values('ignore-scripts=true # keep scripts off\nregistry=https://example.test/ ; mirror\nb=x\\;y\\#z\n')).toEqual({
      'ignore-scripts': 'true',
      registry: 'https://example.test/',
      b: 'x;y#z',
    });
  });

  it('keeps # and ; inside quotes and removes the quotes', () => {
    expect(values('a="x # y"\nb=\'z ; w\'\nc = "quoted" \n')).toEqual({ a: 'x # y', b: 'z ; w', c: 'quoted' });
  });

  it('reads a key without = as true and skips comment lines, also indented ones', () => {
    expect(values('ignore-scripts\n  # comment\n\t; comment\n=no-key\n')).toEqual({ 'ignore-scripts': 'true' });
  });

  it('gives keys below a [section] header to the section, not to the top level', () => {
    const text = 'save-exact=true\n[custom]\nmin-release-age=0\n[other.part]\nfoo=bar\n';
    expect(iniEntries(text).map((entry) => entry.key)).toEqual(['save-exact']);
    expect(iniLines(text).map(({ key, section, line }) => ({ key, section, line }))).toEqual([
      { key: 'save-exact', section: undefined, line: 1 },
      { key: 'min-release-age', section: 'custom', line: 3 },
      { key: 'foo', section: 'other.part', line: 5 },
    ]);
  });

  it('reads a header only at the start of the line and with nothing after it but spaces', () => {
    // As in ini: "  [x]" and "[x] # note" are keys with the value true, so they do not start a section.
    expect(iniLines('[a]  \nk=1\n  [b]\nm=2\n').map(({ key, section }) => ({ key, section }))).toEqual([
      { key: 'k', section: 'a' },
      { key: '[b]', section: 'a' },
      { key: 'm', section: 'a' },
    ]);
  });

  it('numbers lines with CRLF line endings and marks the managed block', () => {
    const text = `a=1\r\n${BLOCK_START}\r\nmin-release-age=3\r\n${BLOCK_END}\r\nb=2\r\n`;
    expect(iniEntries(text).map(({ key, line, managed }) => ({ key, line, managed }))).toEqual([
      { key: 'a', line: 1, managed: false },
      { key: 'min-release-age', line: 3, managed: true },
      { key: 'b', line: 5, managed: false },
    ]);
  });
});

describe('writeIniBlock and [section] headers', () => {
  const block = (entries: string[]) => [BLOCK_START, ...entries, BLOCK_END];

  it('puts a new block above the first section, where npm reads it', () => {
    expect(writeIniBlock('save-exact=true\n\n[custom]\nfoo=bar\n', ['min-release-age=3'], ['min-release-age'])).toBe(
      ['save-exact=true', '', ...block(['min-release-age=3']), '[custom]', 'foo=bar', ''].join('\n'),
    );
    expect(writeIniBlock('[custom]\nfoo=bar\n', ['a=1'], ['a'])).toBe([...block(['a=1']), '[custom]', 'foo=bar', ''].join('\n'));
  });

  it('moves a block that an older apply appended inside a section', () => {
    const before = ['save-exact=true', '[custom]', 'foo=bar', '', ...block(['min-release-age=1']), ''].join('\n');
    const after = writeIniBlock(before, ['min-release-age=3'], ['min-release-age']);
    expect(after).toBe(['save-exact=true', '', ...block(['min-release-age=3']), '[custom]', 'foo=bar', ''].join('\n'));
    expect(writeIniBlock(after, ['min-release-age=3'], ['min-release-age'])).toBe(after);
  });

  it('leaves keys of a section alone: they are other settings', () => {
    const before = 'min-release-age=1\n[custom]\nmin-release-age=0\n';
    expect(writeIniBlock(before, ['min-release-age=3'], ['min-release-age'])).toBe(
      ['# depcurfew: superseded by the managed block: min-release-age=1', '', ...block(['min-release-age=3']), '[custom]', 'min-release-age=0', ''].join('\n'),
    );
  });
});

describe('writeIniBlock and the comments of a section', () => {
  it('puts a new block above the comment lines that introduce the first section, and keeps it there', () => {
    const before = 'save-exact=true\n\n# read by our scripts\n[custom]\nfoo=bar\n';
    const after = writeIniBlock(before, ['a=1'], ['a']);
    expect(after).toBe(`save-exact=true\n\n${BLOCK_START}\na=1\n${BLOCK_END}\n# read by our scripts\n[custom]\nfoo=bar\n`);
    expect(writeIniBlock(after, ['a=2'], ['a'])).toBe(after.replace('a=1', 'a=2'));
  });
});
