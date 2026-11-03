// The Gemfile as both parsers of Ruby read it, only top-level source calls as plain, repeated keys, CR LF line endings
// read the same way by apply and doctor, and hidden Bundler commands (decision D-163).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readGemfile, setSourceCooldown } from '../src/apply/gemfile.ts';
import { applyProject } from '../src/apply/index.ts';
import { run } from '../src/cli/run.ts';
import { findToolCommands } from '../src/detect/commands.ts';
import { detectionFacts } from '../src/detect/knowledge.ts';
import { Repository } from '../src/detect/repository.ts';
import { runDoctor } from '../src/doctor/index.ts';
import { readSetting } from '../src/doctor/settings.ts';
import { environment } from '../src/knowledge/environment.ts';
import { knowledgeBase } from '../src/knowledge/index.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'depcurfew-d163-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'depcurfew-d163-'));
  temporary.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** doctor --json as the CLI runs it, with a scratch home. */
async function doctor(root: string): Promise<{ code: number; findings: { rule: string; level: string; location?: { file: string; line?: number }; message: string; fix?: string }[] }> {
  let stdout = '';
  const code = await run(['doctor', '--json', root], { stdout: (text) => (stdout += text), stderr: () => {} }, {
    fetch: async () => new Response('{}', { status: 404 }),
    now: () => new Date('2026-11-03T12:00:00Z'),
    stdin: async () => '',
    home: () => HOME,
  });
  return { code, findings: (JSON.parse(stdout) as { findings: { rule: string; level: string; location?: { file: string; line?: number }; message: string; fix?: string }[] }).findings };
}

const POLICY = (minimum = '7d') => JSON.stringify({ version: 1, cooldown: { minimum } });
const LOCK = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.2.3)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n\nBUNDLED WITH\n   4.0.23\n';
const RUBYGEMS = 'source "https://rubygems.org"';
const notWritten = (root: string) =>
  applyProject(root, { write: false })
    .warningDetails.filter((warning) => warning.code === 'cooldown-not-written')
    .map((warning) => ({ line: warning.location?.line, message: warning.message, fix: warning.fix }));
const drift = (root: string) =>
  runDoctor(root)
    .findings.filter((finding) => finding.rule === 'config-drift')
    .map((finding) => [finding.level, finding.location?.line]);

describe('where Prism and parse.y read a Gemfile differently, depcurfew stops', () => {
  // Prism, the default parser since Ruby 3.4, reads ?€ as a character literal, so `or %;` starts a %-literal that ends
  // on line 3, and Ruby 3.4 runs only line 4, without a cooldown; parse.y reads ?€or as a ternary (extra.rubyParsers).
  const PRISM = ['x = ?€or%;', `${RUBYGEMS}, cooldown: 7`, 'y = ";', "source 'https://rubygems.org' # \"", 'gem "rack", "~> 3.2"', ''].join('\n');

  it('stops at ? before a character beyond ASCII', () => {
    const reading = readGemfile(PRISM);
    expect(reading.sources).toEqual([]);
    expect(reading.unknown).toEqual({
      line: 1,
      reason: 'Ruby 3.4 and newer (Prism) and Ruby 3.3 and older (parse.y) read ? before a character beyond ASCII differently, as a character literal or as the ? of a ternary',
      fix: 'write the character as a string ("€" in place of ?€), or put a space after the ? of a ternary',
    });
  });

  it('apply edits nothing and doctor reports an error, so it does not pass', async () => {
    const root = repository({ Gemfile: PRISM, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes).toEqual([]);
    expect(notWritten(root).map((warning) => warning.line)).toEqual([1]);
    const result = await doctor(root);
    expect(result.code).toBe(1);
    expect(result.findings.filter((finding) => finding.rule === 'config-drift').map((finding) => [finding.level, finding.location])).toEqual([['error', { file: 'Gemfile', line: 1 }]]);
  });

  it.each([
    ['? before a letter beyond ASCII', 'X = ?é\n'],
    ['? before a symbol beyond ASCII and a bracket', 'X = [?€]\n'],
    ['? before an emoji', 'X = ?😀\n'],
  ])('also stops at %s', (_, code) => {
    expect(readGemfile(`${RUBYGEMS}\n${code}`).unknown?.line).toBe(2);
  });

  it('reads ? before an ASCII character, an escape or a space as before', () => {
    for (const code of ['X = ?a', 'X = ?\\u{20AC}', 'X = ?\\u20AC', 'X = ENV["A"] ? "€" : 1', 'X = 1 ? :€ : 2']) {
      const reading = readGemfile(`${code}\n${RUBYGEMS}\n`);
      expect(reading.unknown, code).toBeUndefined();
      expect(reading.sources.map((source) => source.plain), code).toEqual([true]);
    }
  });

  it('stops at =begin followed by ^D or ^Z, which only parse.y reads as a comment', () => {
    for (const control of ['\u0004', '\u001a']) {
      const reading = readGemfile(`${RUBYGEMS}\n=begin${control}\n${RUBYGEMS}\n=end\n`);
      expect(reading.unknown?.line).toBe(2);
      expect(reading.unknown?.reason).toContain('Prism');
    }
    // Both read =begin before a NUL as the start of a comment.
    const nul = readGemfile(`${RUBYGEMS}\n=begin\u0000\n${RUBYGEMS}\n=end\n`);
    expect(nul.unknown).toBeUndefined();
    expect(nul.sources.map((source) => source.line)).toEqual([1]);
  });

  it('stops at $0 followed by a name, which Prism rejects and parse.y reads as one global', () => {
    expect(readGemfile(`${RUBYGEMS}\nX = $0abc\n`).unknown?.line).toBe(2);
    expect(readGemfile(`${RUBYGEMS}\nX = "#$0abc"\n`).unknown?.line).toBe(2);
    expect(readGemfile(`X = $0\n${RUBYGEMS}\n`).unknown).toBeUndefined();
  });
});

describe('a source call is plain only at the top level of the Gemfile', () => {
  // The block never runs, so Ruby runs only the ENV source, which has no cooldown; a plain call elsewhere does not
  // excuse a source whose URL is not a literal.
  it('reports the ENV source and the call in a block, also next to a plain call', async () => {
    const gemfile = `[].each do\n  ${RUBYGEMS}, cooldown: 7\nend\nsource ENV.fetch("GEM_SOURCE", "https://rubygems.org")\n`;
    const reading = readGemfile(gemfile);
    expect(reading.unknown).toBeUndefined();
    expect(reading.sources).toEqual([
      { line: 2, url: 'https://rubygems.org', cooldown: 7, plain: false, nested: true, block: false },
      { line: 4, plain: false, block: false },
    ]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes).toEqual([]);
    expect(notWritten(root)).toEqual([
      {
        line: 2,
        message:
          'Bundler: cooldown not written: the source "https://rubygems.org" call on line 2 of Gemfile is not edited, because it is not at the top level of Gemfile (it is inside a block, a method, a class, a condition, a loop, begin or brackets), so Ruby runs it only when that code runs; depcurfew apply edits only a plain source "https://rubygems.org" call on a line of its own',
        fix: 'No change is needed as long as Ruby runs that call: its cooldown: 7 is not shorter than the 7 days of depcurfew.json. To let depcurfew check it, move it to the top level of Gemfile as a plain call on a line of its own and set cooldown.minimum in depcurfew.json to "7d", so that depcurfew apply keeps 7',
      },
      {
        line: 4,
        message: 'Bundler: cooldown not written: the URL of the source call on line 4 of Gemfile is not a literal string, so depcurfew cannot tell whether it is "https://rubygems.org"',
        fix: 'If it names rubygems.org, write it as source "https://rubygems.org" on a line of its own and run depcurfew apply again, or add cooldown: 7 to that call by hand',
      },
    ]);
    const result = await doctor(root);
    expect(result.code).toBe(1);
    expect(result.findings.filter((finding) => finding.rule === 'config-drift').map((finding) => [finding.level, finding.location?.line])).toEqual([
      ['warning', 2],
      ['error', 4],
    ]);
    // With a plain call before it, the ENV source is still reported and the plain call is still edited.
    writeFileSync(join(root, 'Gemfile'), `${RUBYGEMS}\nsource ENV.fetch("GEM_SOURCE", "https://rubygems.org")\n`);
    expect(applyProject(root, { write: false }).changes.map((change) => change.after)).toEqual([`${RUBYGEMS}, cooldown: 7\nsource ENV.fetch("GEM_SOURCE", "https://rubygems.org")\n`]);
    expect(notWritten(root).map((warning) => warning.line)).toEqual([2]);
  });

  it.each([
    ['a do block', 'group :test do', 'end'],
    ['a do block with parameters', '[].each do |g|', 'end'],
    ['a block in braces', '[].each {', '}'],
    ['a method', 'def setup', 'end'],
    ['a method with parameters', 'def setup(a, b = {})', 'end'],
    ['a class', 'class Setup', 'end'],
    ['a singleton class', 'class << self', 'end'],
    ['a module', 'module Setup', 'end'],
    ['if', 'if ENV["CI"]', 'end'],
    ['the else of if', 'if ENV["CI"]\nelse', 'end'],
    ['unless', 'unless ENV["CI"]', 'end'],
    ['case', 'case ENV["X"]\nwhen "a"', 'end'],
    ['while', 'while false', 'end'],
    ['while with do', 'while false do', 'end'],
    ['until', 'until true', 'end'],
    ['for', 'for g in []', 'end'],
    ['for with do', 'for g in [] do', 'end'],
    ['begin', 'begin', 'end'],
    ['the rescue of begin', 'begin\nrescue', 'end'],
    ['a lambda in braces', 'SETUP = -> {', '}'],
    ['a lambda with do', 'SETUP = ->(x) do', 'end'],
    ['lambda do', 'SETUP = lambda do', 'end'],
    ['an install_if block', 'install_if -> { RUBY_PLATFORM =~ /darwin/ } do', 'end'],
    ['parentheses', 'X = (', ')'],
    ['a block after a number', '[1].each_slice 1do', 'end'],
    ['if inside a block', '[].each do\n  if true', '  end\nend'],
  ])('a source call inside %s is reported, and the one after it is edited', (_, open, close) => {
    const gemfile = `${open}\n  ${RUBYGEMS}\n${close}\n${RUBYGEMS}\n`;
    const inside = open.split('\n').length + 1;
    const after = inside + close.split('\n').length + 1;
    const reading = readGemfile(gemfile);
    expect(reading.unknown).toBeUndefined();
    expect(reading.sources.map((source) => [source.line, source.plain])).toEqual([
      [inside, false],
      [after, true],
    ]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    const report = applyProject(root, { write: false });
    expect(report.changes.map((change) => change.after)).toEqual([`${open}\n  ${RUBYGEMS}\n${close}\n${RUBYGEMS}, cooldown: 7\n`]);
    expect(notWritten(root).map((warning) => warning.line)).toEqual([inside]);
    expect(notWritten(root)[0]?.message).toContain('is not at the top level of Gemfile');
  });

  it.each([
    ['a modifier if', 'gem "rack" if ENV["CI"]'],
    ['a modifier unless', 'gem "rack" unless ENV["CI"]'],
    ['while as a modifier after end', 'begin\nend while false'],
    ['a rescue modifier', 'X = Integer("x") rescue 0'],
    ['an endless method', 'def setup = 1'],
    ['an endless method with parameters', 'def setup(a) = a'],
    ['an endless method of self', 'def self.setup() = 1'],
    ['next if in a block', '[].each do |g|\n  next if g\nend'],
    ['return unless in a method', 'def check\n  return unless true\nend'],
    ['an if expression on one line', 'X = if true then 1 else 2 end'],
    ['a number right before end', 'X = if true then 1end'],
    ['a while loop with do on one line', 'while false do end'],
    ['a hash over lines', 'X = {\n  a: 1,\n}'],
    ['keywords as labels, symbols, methods and words', 'X = { if: 1, end: 2, do: :end }\nY = X.class\nZ = %w[do end]'],
    ['a lambda in braces', 'L = -> { 1 }'],
    ['a block of the source call itself', 'source "https://gems.example.com" do\n  gem "internal"\nend'],
  ])('%s keeps the next line at the top level', (_, code) => {
    const gemfile = `${code}\n${RUBYGEMS}\n`;
    const reading = readGemfile(gemfile);
    expect(reading.unknown).toBeUndefined();
    expect(reading.sources.filter((source) => source.url === 'https://rubygems.org').map((source) => source.plain)).toEqual([true]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes.map((change) => change.after)).toEqual([`${code}\n${RUBYGEMS}, cooldown: 7\n`]);
  });

  it.each([
    ['an end without anything to close', `end\n${RUBYGEMS}\n`, 1, 'an end without'],
    ['a do without its end', `[].each do\n${RUBYGEMS}\n`, 1, 'the do that starts there has no end'],
    ['an if without its end', `${RUBYGEMS}\nif true\n`, 2, 'the if that starts there has no end'],
    ['a ( without its )', `${RUBYGEMS}\nX = (1\n`, 2, 'the ( that starts there has no )'],
    ['a ) where end is expected', `${RUBYGEMS}\nif (true\nend)\n`, 3, 'syntax error'],
    ['__END__ inside an if', `if true\n  ${RUBYGEMS}\n__END__\nend\n`, 3, 'the script ends before the end of the if that starts on line 1'],
    ['a number followed by a name', `${RUBYGEMS}, cooldown: 7days\n`, 1, 'the number 7 followed by the name days'],
  ])('stops at %s', (_, gemfile, line, reason) => {
    const reading = readGemfile(gemfile);
    expect(reading.unknown?.line).toBe(line);
    expect(reading.unknown?.reason).toContain(reason);
  });
});

describe('a next line that continues the call in Ruby 4.0', () => {
  // Ruby 4.0 joins a line that starts with &&, ||, and or or to the statement before it, past comment lines, as it
  // joins .method (extra.lineContinuation): cooldown: 7 followed by && 0 gives Bundler cooldown: 0.
  it.each([['&& 0'], ['|| 0'], ['and 0'], ['or 0'], ['# a comment\n  && 0']])('a plain-looking call followed by %s is reported', async (next) => {
    const gemfile = `${RUBYGEMS}, cooldown: 7\n  ${next}\ngem "rack"\n`;
    expect(readGemfile(gemfile).sources.map((source) => source.plain)).toEqual([false]);
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: false }).changes).toEqual([]);
    expect(notWritten(root).map((warning) => warning.line)).toEqual([1]);
    expect((await doctor(root)).code).not.toBe(0);
  });

  it.each([
    ['cooldown: 7 - 7', 'other'],
    ['cooldown: 7 \\\n  - 7', 'other'],
    ['cooldown: 7\n  && 0', 'other'],
    ['cooldown: 7 ? 0 : 1', 'other'],
    ['cooldown: 14 unless ENV["FAST"]', 14],
    ['cooldown: 14, type: :x', 14],
    ['cooldown: 14 if true # two weeks', 14],
  ])('the cooldown of a call that is not plain, %j, is a number only where its expression ends', (rest, cooldown) => {
    expect(readGemfile(`${RUBYGEMS}, ${rest}\n`).sources[0]).toMatchObject({ plain: false, cooldown });
  });

  it.each([['android_gem = 1'], ['order = 1'], ['..2'], [''], ['gem "and"']])('a next line %j does not continue it', (next) => {
    const gemfile = `${RUBYGEMS}, cooldown: 7\n${next}\n`;
    expect(readGemfile(gemfile).sources.map((source) => source.plain)).toEqual([true]);
  });
});

describe('a key given more than once', () => {
  // Ruby keeps the last of two equal keys (with a warning), and Bundler's normalize_hash lets a symbol key win over a
  // string key, so depcurfew does not tell which value Bundler takes.
  it.each([['cooldown: 7, cooldown: 0'], ['cooldown: 7, :cooldown => 0'], ['"cooldown": 7, cooldown: 0'], ['cooldown: 0, "cooldown" => 7'], ['cooldown: 14, cooldown: 7']])(
    'source "https://rubygems.org", %s is not plain, and doctor reports an error',
    async (keys) => {
      const gemfile = `${RUBYGEMS}, ${keys}\ngem "rack", "~> 3.2"\n`;
      expect(readGemfile(gemfile).sources).toEqual([{ line: 1, url: 'https://rubygems.org', cooldown: 'other', repeated: true, plain: false, block: false }]);
      const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
      expect(applyProject(root, { write: false }).changes).toEqual([]);
      expect(notWritten(root)).toEqual([
        {
          line: 1,
          message:
            'Bundler: cooldown not written: the source "https://rubygems.org" call on line 1 of Gemfile is not edited, because it gives cooldown: more than once, and which value Bundler takes depends on how Ruby merges the keys; depcurfew apply edits only a plain source "https://rubygems.org" call on a line of its own',
          fix: 'Keep a single cooldown: 7 in that call by hand in place of its cooldown: keys, or write it as a plain call on a line of its own and run depcurfew apply again',
        },
      ]);
      const result = await doctor(root);
      expect(result.code).toBe(1);
      const findings = result.findings.filter((finding) => finding.rule === 'config-drift');
      expect(findings.map((finding) => [finding.level, finding.location?.line])).toEqual([['error', 1]]);
      expect(findings[0]?.fix).not.toContain('No change is needed');
    },
  );

  it('reads :"cooldown" => and :\'cooldown\' => as the cooldown: key', () => {
    for (const key of [':"cooldown" =>', ":'cooldown' =>"]) {
      const gemfile = `${RUBYGEMS}, ${key} 3\n`;
      expect(readGemfile(gemfile).sources).toEqual([{ line: 1, url: 'https://rubygems.org', cooldown: 3, plain: true, block: false }]);
      expect(setSourceCooldown(gemfile, [1], 7)).toBe(`${RUBYGEMS}, ${key} 7\n`);
      expect(readGemfile(`${RUBYGEMS}, cooldown: 7, ${key} 0\n`).sources[0]).toMatchObject({ cooldown: 'other', repeated: true, plain: false });
    }
  });
});

describe('CR LF line endings are read the same way by apply and doctor', () => {
  // parse.y (nextc, parser_cr) and Prism read CR LF as one newline, also inside a literal delimited by CR, which ends
  // only at a CR alone (extra.rubySyntax).
  it('does not end a literal delimited by CR at the CR of CR LF', () => {
    const text = `NOTES = %\rabc\r\n${RUBYGEMS}, cooldown: 7\r\ny = "\r \nsource 'https://rubygems.org' # "\n`;
    const reading = readGemfile(text);
    expect(reading.unknown).toBeUndefined();
    expect(reading.sources).toEqual([{ line: 4, url: 'https://rubygems.org', plain: true, block: false }]);
  });

  it('keeps the error where apply cannot write the cooldown, also with CR LF line endings', async () => {
    const gemfile = `NOTES = %\rabc\r\n${RUBYGEMS}, cooldown: 7\r\n\r\r\ngem %w[rack].first\r\n${RUBYGEMS}\r\n`;
    const root = repository({ Gemfile: gemfile, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(notWritten(root).map((warning) => warning.line)).toEqual([4]);
    expect(drift(root)).toEqual([['error', 4]]);
    expect((await doctor(root)).code).toBe(1);
  });

  it.each([
    ['a plain call', `${RUBYGEMS}, cooldown: 7\ngem "rack"\n`],
    ['a heredoc', `NOTE = <<~TEXT\n  ${RUBYGEMS}\nTEXT\n${RUBYGEMS}, cooldown: 7\n`],
    ['__END__', `${RUBYGEMS}, cooldown: 7\n__END__\n${RUBYGEMS}\n`],
    ['a %-literal delimited by newlines', `X = %\nabc\n${RUBYGEMS}, cooldown: 7\n`],
    ['a backslash at the end of a line', `${RUBYGEMS}, \\\n  cooldown: 7\n${RUBYGEMS}, cooldown: 7\n`],
    ['a block', `[].each do\n  ${RUBYGEMS}, cooldown: 7\nend\n`],
  ])('%s: the same sources, the same setting for doctor, and an edit that keeps CR LF', (_, lf) => {
    const crlf = lf.replaceAll('\n', '\r\n');
    expect(readGemfile(crlf)).toEqual(readGemfile(lf));
    const lfRoot = repository({ Gemfile: lf, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY('8d') });
    const crlfRoot = repository({ Gemfile: crlf, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY('8d') });
    expect(readSetting(new Repository(crlfRoot), 'Gemfile', 'cooldown')).toEqual(readSetting(new Repository(lfRoot), 'Gemfile', 'cooldown'));
    expect(drift(crlfRoot)).toEqual(drift(lfRoot));
    expect(notWritten(crlfRoot)).toEqual(notWritten(lfRoot));
    const edited = applyProject(lfRoot, { write: false }).changes.map((change) => change.after);
    expect(applyProject(crlfRoot, { write: false }).changes.map((change) => change.after)).toEqual(edited.map((text) => text.replaceAll('\n', '\r\n')));
    const lines = readGemfile(lf).sources.map((source) => source.line);
    expect(setSourceCooldown(crlf, lines, 8)).toBe(setSourceCooldown(lf, lines, 8).replaceAll('\n', '\r\n'));
  });

  it('applies to a CR LF Gemfile once, and a second apply changes nothing', () => {
    const root = repository({ Gemfile: `${RUBYGEMS}\r\ngem "rack"\r\n`, 'Gemfile.lock': LOCK, 'depcurfew.json': POLICY() });
    expect(applyProject(root, { write: true }).changes.map((change) => change.after)).toEqual([`${RUBYGEMS}, cooldown: 7\r\ngem "rack"\r\n`]);
    expect(applyProject(root, { write: true }).changes).toEqual([]);
    expect(runDoctor(root).findings).toEqual([]);
  });
});

describe('hidden Bundler commands, read as Thor runs them', () => {
  const facts = detectionFacts(knowledgeBase, environment).commands;
  const read = (script: string) => findToolCommands(script, facts, 0, new Map()).commands.map(({ offset: _offset, ...command }) => command);

  // Thor finds a hidden command only by its exact name, after it reads - as _ (normalize_command_name), never by a
  // prefix (find_command_possibilities); install_or_cli_help runs install.
  it.each([['BUNDLE_COOLDOWN=0 bundle install_or_cli_help'], ['BUNDLE_COOLDOWN=0 bundle install-or-cli-help'], ['BUNDLE_COOLDOWN=0 bundle _4.0.23_ install_or_cli_help']])('%s installs', (script) => {
    expect(read(script)).toEqual([{ kind: 'install', tool: 'bundler', delay: '0', ...(script.includes('_4.0.23_') ? { version: '4.0.23' } : {}) }]);
  });

  it.each([['bundle install_or --cooldown 0'], ['bundle install_or_cli --cooldown 0'], ['bundle cli_help'], ['bundle cli-help'], ['bundle viz'], ['bundle inject rack 1']])('%s does not install', (script) => {
    expect(read(script).filter((command) => command.kind === 'install')).toEqual([]);
  });

  it('doctor reports BUNDLE_COOLDOWN=0 bundle install_or_cli_help in a CI job', () => {
    const workflow = 'on: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: BUNDLE_COOLDOWN=0 bundle install_or_cli_help\n';
    const root = repository({ Gemfile: `${RUBYGEMS}, cooldown: 7\n`, 'Gemfile.lock': LOCK, '.github/workflows/ci.yml': workflow, 'depcurfew.json': POLICY() });
    expect(runDoctor(root).findings.map((finding) => finding.rule)).toEqual(['bundler-config-weakens']);
  });
});
