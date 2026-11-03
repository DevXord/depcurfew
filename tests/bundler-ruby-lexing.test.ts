// The Gemfile read as Ruby's lexer reads it (decision D-159): lines Ruby never runs are no source calls, a file the
// scanner does not read with certainty is not edited and its cooldown does not count, integer literals as Ruby reads
// them, and the plain calls apply edits.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGemfile, rubyInteger, setSourceCooldown } from '../src/apply/gemfile.ts';
import { applyProject } from '../src/apply/index.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { readSetting } from '../src/doctor/settings.ts';
import { Repository } from '../src/detect/repository.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-ruby-lexing-'));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const POLICY = (minimum = '7d') => JSON.stringify({ version: 1, cooldown: { minimum } });
const LOCK = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.2.3)\n\nBUNDLED WITH\n   4.0.23\n';
const RUBYGEMS = 'source "https://rubygems.org"';
const lines = (text: string) => readGemfile(text).sources.map((source) => source.line);

describe('lines Ruby never runs are no source calls', () => {
  // Each Gemfile has its real source on line 1, from ENV, and a copy of source "https://rubygems.org" Ruby does not run.
  const REAL = 'source ENV.fetch("GEM_SOURCE", "https://rubygems.org")\n';
  it.each([
    ['__END__', `${REAL}gem "rack"\n__END__\n${RUBYGEMS}\n`],
    ['__END__ with CRLF', `${REAL}__END__\r\n${RUBYGEMS}\r\n`],
    ['^Z on a line', `${REAL}\u001a\n${RUBYGEMS}\n`],
    ['^D after spaces', `${REAL}   \u0004\n${RUBYGEMS}\n`],
    ['NUL after a call', `${REAL}gem "rack" \u0000 ignored\n${RUBYGEMS}\n`],
    ['a multi-line single-quoted string', `${REAL}NOTE = '\n${RUBYGEMS}\n'\n`],
    ['a multi-line double-quoted string', `${REAL}NOTE = "first\n${RUBYGEMS}\n"\n`],
    ['a multi-line backtick string', `${REAL}OUT = \`echo\n${RUBYGEMS}\n\`\n`],
    ['%q with , as the delimiter', `${REAL}DOC = %q,\n${RUBYGEMS}\n,\n`],
    ['%( with nested parentheses', `${REAL}DOC = %(a (b\n${RUBYGEMS}\n) c\n)\n`],
    ['%Q{ with nested braces', `${REAL}DOC = %Q{a {b}\n${RUBYGEMS}\n}\n`],
    ['%w[ over lines', `${REAL}LIST = %w[a\n${RUBYGEMS}\n]\n`],
    ['%| with | as the delimiter', `${REAL}DOC = %|\n${RUBYGEMS}\n|\n`],
    ['a %r regexp over lines', `${REAL}PATTERN = %r{a\n${RUBYGEMS}\n}x\n`],
    ['a / regexp over lines', `${REAL}PATTERN = /a\n${RUBYGEMS.replaceAll('/', '\\/')}\n/x\n`],
    ['a symbol in double quotes over lines', `${REAL}KEY = :"a\n${RUBYGEMS}\n"\n`],
    ['a heredoc with a quoted identifier', `${REAL}NOTE = <<~"END-OF-NOTE"\n${RUBYGEMS}\nEND-OF-NOTE\n`],
    ['a heredoc in single quotes with a space', `${REAL}NOTE = <<-'A B'\n${RUBYGEMS}\n  A B\n`],
    ['a backtick heredoc', `${REAL}OUT = <<\`CMD\`\n${RUBYGEMS}\nCMD\n`],
    ['a heredoc with a numeric identifier', `${REAL}NOTE = <<1\n${RUBYGEMS}\n1\n`],
    ['a heredoc ended by an empty line', `${REAL}NOTE = <<""\n${RUBYGEMS}\n\ngem "rack"\n`],
    ['the second heredoc of a line', `${REAL}pair(<<A, <<B)\na\nA\n${RUBYGEMS}\nB\n`],
    ['a terminator with trailing spaces', `${REAL}NOTE = <<~TEXT\n  TEXT  \n  ${RUBYGEMS}\nTEXT\n`],
    ['an indented terminator of a heredoc without - or ~', `${REAL}NOTE = <<TEXT\n  TEXT\n${RUBYGEMS}\nTEXT\n`],
    ['a line after a backslash in a heredoc', `${REAL}NOTE = <<A\nfirst \\\nA\n${RUBYGEMS}\nA\n`],
    ['a string that continues after the heredoc body', `${REAL}NOTE = <<A + "\nbody\nA\n${RUBYGEMS}\n"\n`],
    ['a heredoc started in the interpolation of another', `${REAL}NOTE = <<A\n#{<<B}\n${RUBYGEMS}\nB\nA\n`],
    ['=begin and =end', `${REAL}=begin\n${RUBYGEMS}\n=end of the comment\n`],
    ['=begin followed by a tab', `${REAL}=begin\tnote\n${RUBYGEMS}\n=end\n`],
    ['a comment', `${REAL}# ${RUBYGEMS}\n`],
  ])('%s', (_, gemfile) => {
    expect(lines(gemfile)).toEqual([1]);
    expect(readGemfile(gemfile).unknown).toBeUndefined();
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.filter((warning) => warning.code === 'cooldown-not-written').map((warning) => warning.location)).toEqual([{ file: 'Gemfile', line: 1 }]);
  });
});

describe('lines Ruby runs after literals that look like more', () => {
  it.each([
    ['a character literal ?"', `NOTE = ?"\n${RUBYGEMS}\n`],
    ['a character literal ?\'', `NOTE = ?'\n${RUBYGEMS}\n`],
    ['the global $"', `LOADED = $"\n${RUBYGEMS}\n`],
    ['#$" in a string', `NOTE = "#$""\n${RUBYGEMS}\n`],
    ['% after a value', `X = 10 %3\n${RUBYGEMS}\n`],
    ['/ after a value', `X = 10 /2\n${RUBYGEMS}\n`],
    ['<< after a value', `X = [1] <<2\n${RUBYGEMS}\n`],
    ['class << self', `class << self\nend\n${RUBYGEMS}\n`],
    ['a ternary', `X = ENV["A"] ? "b" : 'c'\n${RUBYGEMS}\n`],
    ['a closed heredoc', `NOTE = <<~TEXT\n  text\n  TEXT\n${RUBYGEMS}\n`],
    // A source call inside the block is not at the top level (decision D-163): the one after the block is plain.
    ['a block after do with parameters', `group :test do |g|\n  gem "rspec", "~> 3.13"\nend\n${RUBYGEMS}\n`],
    ['a regexp after =~', `install_if -> { RUBY_PLATFORM =~ /darwin/ } do\n  gem "x", "/"\nend\n${RUBYGEMS}\n`],
    ['%i after a label', `gem "tzinfo-data", platforms: %i[ windows jruby ]\n${RUBYGEMS}\n`],
  ])('%s', (_, gemfile) => {
    const reading = readGemfile(gemfile);
    expect(reading.unknown).toBeUndefined();
    expect(reading.sources.map((source) => source.plain)).toEqual([true]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes.map((change) => change.after)).toEqual([gemfile.replace(RUBYGEMS, `${RUBYGEMS}, cooldown: 7`)]);
  });
});

describe('a Gemfile depcurfew cannot read as Ruby does is not edited', () => {
  it.each([
    ['% after a name that may be a local variable', `${RUBYGEMS}\nplatforms %w[ruby]\n`, 2, 'after the name platforms and a space'],
    ['/ after such a name', `${RUBYGEMS}\nmatch /x/\n`, 2, 'after the name match and a space'],
    ['<< after such a name', `${RUBYGEMS}\nnote <<A\ntext\nA\n`, 2, 'after the name note and a space'],
    ['? after such a name', `${RUBYGEMS}\nx ?y\n`, 2, 'after the name x and a space'],
    ['alias', `${RUBYGEMS}\nalias other gem\n`, 2, 'it uses alias'],
    ['a control escape', `${RUBYGEMS}\nX = "\\C-a"\n`, 2, 'control or meta escape'],
    ['a string that does not end', `${RUBYGEMS}\nX = "open\n`, 2, 'does not end'],
    ['a heredoc without its terminator', `${RUBYGEMS}\nX = <<A\ntext\n`, 2, 'no line A that ends it'],
    ['=begin without =end', `${RUBYGEMS}\n=begin\ntext\n`, 2, 'has no =end'],
    ['a } without {', `${RUBYGEMS}\n}\n`, 2, 'syntax error'],
  ])('%s', (_, gemfile, line, reason) => {
    const reading = readGemfile(gemfile);
    expect(reading.unknown?.line).toBe(line);
    expect(reading.unknown?.reason).toContain(reason);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    const warning = report.warningDetails.find((entry) => entry.code === 'cooldown-not-written');
    expect(warning?.location).toEqual({ file: 'Gemfile', line });
    expect(warning?.message).toContain(`depcurfew cannot read Gemfile as Ruby does from line ${line} on, because `);
    expect(warning?.fix).toMatch(new RegExp(`^On line ${line} of Gemfile, .+, then run depcurfew apply again; or add cooldown: 7 to the source "https://rubygems.org" call by hand`, 'u'));
    // doctor does not count a cooldown it cannot be sure Ruby runs.
    writeFileSync(join(root, 'Gemfile'), gemfile.replace(RUBYGEMS, `${RUBYGEMS}, cooldown: 7`));
    expect(readSetting(new Repository(root), 'Gemfile', 'cooldown')).toBeUndefined();
  });

  it('says what it could not read and that the cooldown before it is enough, without advising a shorter one', () => {
    const gemfile = `${RUBYGEMS}, cooldown: 14\nplatforms %w[ruby]\n`;
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const warning = applyProject(root, { write: false }).warningDetails.find((entry) => entry.code === 'cooldown-not-written');
    expect(warning).toEqual({
      code: 'cooldown-not-written',
      tool: 'bundler',
      location: { file: 'Gemfile', line: 2 },
      message:
        'Bundler: cooldown not written: depcurfew cannot read Gemfile as Ruby does from line 2 on, because after the name platforms and a space, Ruby reads % one way when platforms is a local variable and another way when it is a method, which depcurfew does not tell; it does not edit a Gemfile it cannot read with certainty',
      fix: 'No change is needed if Ruby reads Gemfile as written: the source "https://rubygems.org" call on line 1 has cooldown: 14, not shorter than the 7 days of depcurfew.json. To let depcurfew check it, on line 2 of Gemfile, write the arguments of platforms in parentheses (platforms(...)), or put a space after the operator, then run depcurfew apply again',
    });
    expect(runDoctor(root).findings.filter((finding) => finding.rule === 'config-drift').map((finding) => [finding.level, finding.location])).toEqual([['warning', { file: 'Gemfile', line: 2 }]]);
  });

  it('edits a %q,...,-literal Gemfile only on the call Ruby runs, so the literal keeps its end', () => {
    const gemfile = `${RUBYGEMS}\nDOC = %q,\n${RUBYGEMS}\n,\n`;
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes.map((change) => change.after)).toEqual([`${RUBYGEMS}, cooldown: 7\nDOC = %q,\n${RUBYGEMS}\n,\n`]);
  });

  it('never edits a text it does not read with certainty, also when asked to', () => {
    const gemfile = `${RUBYGEMS}\nplatforms %w[ruby]\n`;
    expect(setSourceCooldown(gemfile, [1], 7)).toBe(gemfile);
  });
});

describe('which lines start a statement', () => {
  it.each([
    ['after a comma', `gem "x",\n${RUBYGEMS}\n`],
    ['after a backslash', `gem \\\n${RUBYGEMS}\n`],
    ['followed by .method', `${RUBYGEMS}\n  .tap { }\n`],
    ['followed by a comment and &.method', `${RUBYGEMS}\n# note\n  &.tap { }\n`],
    ['after a label', `gem "x", require:\n${RUBYGEMS}\n`],
    ['ending with a backslash', `${RUBYGEMS} \\\n  + "/"\n`],
  ])('a source call %s is not plain and is reported', (_, gemfile) => {
    const sources = readGemfile(gemfile).sources;
    expect(sources.map((source) => source.plain)).toEqual([false]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.some((warning) => warning.code === 'cooldown-not-written' && warning.location?.line === sources[0]?.line)).toBe(true);
  });

  it('reads the URL only of a literal Ruby does not change', () => {
    expect(readGemfile('source "https://#@host"\nsource "https://rubygems.org/#{x}"\nsource \'https://rubygems\\.org\'\n').sources).toEqual([
      { line: 1, plain: false, block: false },
      { line: 2, plain: false, block: false },
      { line: 3, url: 'https://rubygems\\.org', plain: true, block: false },
    ]);
  });
});

describe('cooldown: as Ruby reads an integer literal', () => {
  it.each([
    ['7', 7],
    ['010', 8],
    ['0o10', 8],
    ['0O17', 15],
    ['0x10', 16],
    ['0b101', 5],
    ['0d10', 10],
    ['1_000', 1000],
    ['0_7', 7],
    ['00', 0],
    ['0', 0],
  ])('%s is %d', (text, days) => {
    expect(rubyInteger(text)).toBe(days);
  });

  it.each([['08'], ['1__0'], ['1_'], ['_7'], ['7.5'], ['7r'], ['0x'], ['0o_1'], ['0__7'], ['1e3']])('%s is no Integer', (text) => {
    expect(rubyInteger(text)).toBeUndefined();
  });

  it('cooldown: 010 is 8 days, so a policy of 10 days changes it, and a second apply changes nothing', () => {
    const root = repository({ Gemfile: `${RUBYGEMS}, cooldown: 010\n`, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY('10d') });
    expect(applyProject(root, { write: true }).changes.map((change) => change.after)).toEqual([`${RUBYGEMS}, cooldown: 10\n`]);
    expect(applyProject(root, { write: true }).changes).toEqual([]);
  });

  it('cooldown: 0x10 is the 16 days of a policy of 16 days, so nothing changes', () => {
    const root = repository({ Gemfile: `${RUBYGEMS}, cooldown: 0x10\n`, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY('16d') });
    expect(applyProject(root, { write: false }).changes).toEqual([]);
    expect(runDoctor(root).findings).toEqual([]);
  });

  it('a value that is no Integer is reported, not edited', () => {
    const root = repository({ Gemfile: `${RUBYGEMS}, cooldown: 7.5\n`, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const report = applyProject(root, { write: false });
    expect(report.changes).toEqual([]);
    expect(report.warningDetails.find((warning) => warning.code === 'cooldown-not-written')).toMatchObject({
      message: expect.stringContaining('because its cooldown: is not a whole number written as a Ruby integer'),
      fix: 'Write cooldown: 7 in that call by hand in place of its value, or write it as a plain call on a line of its own and run depcurfew apply again',
    });
  });
});
