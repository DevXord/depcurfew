import { describe, expect, it } from 'vitest';
import { parseToml, TomlDateTime } from '../../src/detect/toml.ts';

const root = (text: string) => parseToml(text).root;

describe('parseToml', () => {
  it('reads key/value pairs, tables and comments', () => {
    const text = [
      '# a comment',
      'title = "depcurfew" # after a value',
      '',
      '[tool.uv]',
      'exclude-newer = "2026-10-01T00:00:00Z"',
      '"quoted key" = true',
      "'literal key' = false",
      '',
      '[tool.poetry]',
      'name = "demo"',
    ].join('\n');
    expect(root(text)).toEqual({
      title: 'depcurfew',
      tool: { uv: { 'exclude-newer': '2026-10-01T00:00:00Z', 'quoted key': true, 'literal key': false }, poetry: { name: 'demo' } },
    });
  });

  it('reads dotted keys into nested tables', () => {
    expect(root('a.b.c = 1\na.b.d = 2\n"x.y".z = 3\n')).toEqual({ a: { b: { c: 1, d: 2 } }, 'x.y': { z: 3 } });
    expect(root('[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true\n')).toEqual({
      fruit: { apple: { color: 'red', taste: { sweet: true }, texture: { smooth: true } } },
    });
  });

  it('reads basic strings with escapes and literal strings without them', () => {
    expect(root('a = "tab\\there \\"q\\" \\\\ \\u00e9 \\U0001F600"\nb = \'C:\\path\\n\'\n')).toEqual({ a: 'tab\there "q" \\ é 😀', b: 'C:\\path\\n' });
  });

  it('reads multi-line strings', () => {
    const text = ['a = """', 'one', 'two"""', 'b = """\\', '   folded \\', '   line"""', "c = '''", 'raw \\n', "'''", 'd = """quote at end"""""'].join('\n');
    expect(root(text)).toEqual({ a: 'one\ntwo', b: 'folded line', c: 'raw \\n\n', d: 'quote at end""' });
  });

  it('reads numbers and booleans', () => {
    expect(
      root('a = 1_000\nb = -17\nc = 0xff\nd = 0o17\ne = 0b101\nf = 3.14\ng = -1e3\nh = 6.626e-34\ni = inf\nj = -inf\nk = true\nl = +5\n'),
    ).toEqual({ a: 1000, b: -17, c: 255, d: 15, e: 5, f: 3.14, g: -1000, h: 6.626e-34, i: Infinity, j: -Infinity, k: true, l: 5 });
    expect(Number.isNaN(root('n = nan\n').n)).toBe(true);
    expect(root('big = 9007199254740993\n').big).toBe(9007199254740993n);
  });

  it('keeps date-times as written, with their kind', () => {
    const value = root('a = 1979-05-27T07:32:00Z\nb = 1979-05-27 07:32:00.999\nc = 1979-05-27\nd = 07:32:00\ne = 1979-05-27T00:32:00-07:00\n');
    expect(value.a).toEqual(new TomlDateTime('1979-05-27T07:32:00Z', 'offset-date-time'));
    expect(value.b).toEqual(new TomlDateTime('1979-05-27 07:32:00.999', 'local-date-time'));
    expect(value.c).toEqual(new TomlDateTime('1979-05-27', 'local-date'));
    expect(value.d).toEqual(new TomlDateTime('07:32:00', 'local-time'));
    expect(String(value.e)).toBe('1979-05-27T00:32:00-07:00');
  });

  it('reads arrays across lines, with comments and a trailing comma', () => {
    const text = ['a = [', '  "x", # first', '  "y",', ']', 'b = [[1, 2], ["m"]]', 'c = []'].join('\n');
    expect(root(text)).toEqual({ a: ['x', 'y'], b: [[1, 2], ['m']], c: [] });
  });

  it('reads inline tables, also across lines and with a trailing comma', () => {
    const text = ['a = { x = 1, y.z = "two" }', 'wheels = [', '  { url = "https://example.test/a.whl", size = 3 },', ']', 'b = {', '  k = 1,', '}'].join('\n');
    expect(root(text)).toEqual({ a: { x: 1, y: { z: 'two' } }, wheels: [{ url: 'https://example.test/a.whl', size: 3 }], b: { k: 1 } });
  });

  it('reads arrays of tables and their sub-tables', () => {
    const text = [
      '[[package]]',
      'name = "a"',
      '[package.source]',
      'type = "git"',
      '[[package.files]]',
      'file = "a.tar.gz"',
      '',
      '[[package]]',
      'name = "b"',
      '[[package.files]]',
      'file = "b.whl"',
      '[[package.files]]',
      'file = "b.tar.gz"',
    ].join('\n');
    expect(root(text)).toEqual({
      package: [
        { name: 'a', source: { type: 'git' }, files: [{ file: 'a.tar.gz' }] },
        { name: 'b', files: [{ file: 'b.whl' }, { file: 'b.tar.gz' }] },
      ],
    });
  });

  it('accepts CRLF line endings and a byte order mark', () => {
    expect(root('\uFEFFa = 1\r\n[t]\r\nb = "x"\r\n')).toEqual({ a: 1, t: { b: 'x' } });
  });

  it('records the line of every key, table and array element', () => {
    const document = parseToml(['top = 1', '', '[tool.uv]', 'no-build = true', '', '[[package]]', 'name = "a"', '[[package]]', 'name = "b"', 'source = { git = "https://example.test/b" }'].join('\n'));
    expect(document.lineOf(['top'])).toBe(1);
    expect(document.lineOf(['tool', 'uv'])).toBe(3);
    expect(document.lineOf(['tool', 'uv', 'no-build'])).toBe(4);
    expect(document.lineOf(['package', 0])).toBe(6);
    expect(document.lineOf(['package', 1])).toBe(8);
    expect(document.lineOf(['package', 1, 'source', 'git'])).toBe(10);
    expect(document.lineOf(['missing'])).toBeUndefined();
  });

  it.each([
    ['a = 1\na = 2\n', 'line 2: a is defined twice'],
    ['[t]\n[t]\n', 'line 2: table t is defined twice'],
    ['a = 1\n[a]\n', 'line 2: a is already a value, not a table'],
    ['a = { b = 1 }\n[a.c]\n', 'line 2: a is an inline table, which cannot be extended'],
    ['a = { b = 1 }\na.c = 2\n', 'line 2: a is an inline table, which cannot be extended'],
    ['[a]\nb = 1\n[[a]]\n', 'line 3: a is not an array of tables'],
    ['a = "unterminated\n', 'line 1: unterminated string'],
    ['a = """never closed\n', 'line 1: unterminated string'],
    ['a = 1 b = 2\n', 'line 1: expected a new line after the value'],
    ['a\n', 'line 1: expected = after the key'],
    ['a = \n', 'line 1: expected a value'],
    ['a = [1, 2\n', 'line 2: expected , or ] in the array'],
    ['a = "\\q"\n', 'line 1: invalid escape \\q'],
    ['= 1\n', 'line 1: expected a key'],
  ])('rejects %j', (text, message) => {
    expect(() => parseToml(text)).toThrow(message);
  });
});
