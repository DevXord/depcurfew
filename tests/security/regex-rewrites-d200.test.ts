// Decision D-200: the rewrites of regular expressions that read repository text give the same results as the patterns
// they replace. Each old pattern is kept here and compared with the new code on random inputs from a fixed seed, built
// from the characters each pattern cares about: its literals, separators, blanks (also U+00A0, U+3000 and U+FEFF) and
// the four line terminators (\n, \r, U+2028, U+2029), where . and ^ of the m flag differ from [^\n]. CI compares a few
// thousand inputs per rewrite; DEPCURFEW_DIFFERENTIAL_INPUTS=300000 compares as many as during development. Then each
// new function reads 1 MiB of its worst input in a fraction of a second.
import { describe, expect, it } from 'vitest';
import { colonPair } from '../../src/apply/diff.ts';
import { indentsSequences } from '../../src/apply/yaml-edit.ts';
import { gemVersion } from '../../src/detect/commands.ts';
import { directoryGlobMatch } from '../../src/detect/wildcard.ts';
import { wordsMinutes } from '../../src/doctor/durations.ts';
import { markdown } from '../../src/doctor/github.ts';
import { requirementBeforeOptions } from '../../src/doctor/python-lockfiles.ts';
import { MAX_WAYS, MAX_WAYS_UNBOUNDED, unreadableRegex } from '../../src/doctor/renovate-regex.ts';
import { presetName } from '../../src/doctor/renovate.ts';
import { namesDirectory } from '../../src/doctor/rules/bot-cooldown.ts';
import { withoutTomlComment } from '../../src/doctor/settings.ts';
import { printable } from '../../src/printable.ts';
import { trimTrailing } from '../../src/trim.ts';
import { cpuNow } from '../support/cpu-time.ts';

const COUNT = Number(process.env['DEPCURFEW_DIFFERENTIAL_INPUTS'] ?? '4000');
const SEED = 0x5eed_d200;

/** mulberry32: a small generator with a fixed seed, so a difference found in CI can be found again. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const BLANKS = [' ', '\t', '\u000b', '\f', '\u00a0', '\u3000', '\ufeff'];

/** `count` random texts of up to `parts` pieces of `alphabet`. */
function* texts(alphabet: readonly string[], parts: number, seed: number, count = COUNT): Generator<string> {
  const random = generator(seed);
  for (let index = 0; index < count; index++) {
    const length = Math.floor(random() * (parts + 1));
    let text = '';
    for (let part = 0; part < length; part++) text += alphabet[Math.floor(random() * alphabet.length)] ?? '';
    yield text;
  }
}

/** The inputs where `next` gives another result than `old`, at most five. */
function differences<T>(inputs: Iterable<T>, old: (input: T) => unknown, next: (input: T) => unknown): { input: T; old: unknown; next: unknown }[] {
  const found: { input: T; old: unknown; next: unknown }[] = [];
  for (const input of inputs) {
    const before = old(input);
    const after = next(input);
    if (!Object.is(before, after) && JSON.stringify(before) !== JSON.stringify(after)) found.push({ input, old: before, next: after });
    if (found.length === 5) break;
  }
  return found;
}

function cpuSeconds(action: () => unknown): number {
  const start = cpuNow();
  action();
  return (cpuNow() - start) / 1000;
}

// The code before decision D-200, as it was.
const MINUTES: Record<string, number> = { ms: 1 / 60000, s: 1 / 60, second: 1 / 60, m: 1, minute: 1, h: 60, hour: 60, d: 1440, day: 1440, w: 10080, week: 10080 };
function oldWords(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+)\s*([a-z]+)/giu)];
  if (parts.length === 0 || parts.map((part) => part[0]).join(' ').replaceAll(/\s+/gu, '') !== text.replaceAll(/\s+/gu, '')) return undefined;
  let total = 0;
  for (const part of parts) {
    const unit = MINUTES[(part[2] ?? '').toLowerCase().replace(/s$/u, '')];
    if (unit === undefined) return undefined;
    total += Number(part[1]) * unit;
  }
  return total;
}
const oldTomlComment = (raw: string) => raw.replace(/\s+#.*$/u, '');
const oldTrim = (text: string) => text.replace(/\/+$/u, '');
const oldRequirement = (requirement: string) => requirement.split(/\s+--?[a-z]/u, 1)[0];
function oldIndentsSequences(text: string): boolean {
  const match = /^([ \t]*)[^\s#-][^\n]*:[ \t]*(?:#[^\n]*)?\n([ \t]*)- /mu.exec(text);
  return match === null ? true : (match[2]?.length ?? 0) > (match[1]?.length ?? 0);
}
const oldPresetName = (preset: string) => preset.replace(/\(.*\)$/u, '');
const OLD_GEM_VERSION = /^\s*([0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?\s*$/u;
function oldMarkdown(text: string): string {
  const flat = printable(text.replaceAll(/\s*[\r\n]+\s*/gu, ' '));
  return flat
    .split(/(`[^`]*`)/u)
    .map((part, index) =>
      index % 2 === 1
        ? part.replaceAll('|', '\\|')
        : part
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll(/([\\`*_[\]|~#!])/gu, '\\$1')
            .replaceAll(/(https?|www)(?=[:.])/gu, '$1&#8203;'),
    )
    .join('');
}
const OLD_KEY = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_.\/@-]+(?::[A-Za-z0-9_.\/@-]+)*))`;
const OLD_COLON = new RegExp(String.raw`^\s*(?:-\s+)?${OLD_KEY}\s*:(?:\s+|$)(.*)$`, 'u');
function oldColonPair(line: string): { key: string; value: string } | undefined {
  const colon = OLD_COLON.exec(line);
  return colon === null ? undefined : { key: colon[1] ?? colon[2] ?? colon[3] ?? '', value: colon[4] ?? '' };
}
function oldNamesDirectory(entry: string, project: string, globs: boolean): boolean {
  const trimmed = entry.replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (!globs || !trimmed.includes('*')) return trimmed === project;
  const pattern = trimmed
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'u').test(project);
}

describe('rewrites give the results of the patterns they replace (decision D-200)', () => {
  it("durations in the 'words' syntax (Renovate, uv, Bun)", () => {
    const alphabet = ['1', '2', '0', '7', 'd', 'D', 'day', 'days', 'h', 'hours', 'm', 'min', 's', 'w', 'week', 'ms', 'x', 'S', '\u017f', '\u212a', 'K', '!', '-', '.', ...BLANKS, ...TERMINATORS];
    expect(differences(texts(alphabet, 12, SEED + 1), oldWords, wordsMinutes)).toEqual([]);
    for (const text of ['', ' ', '1d', ' 1 d ', '1d2', 'd1d', '1 day 12h', '3days', '1wee\u212a', '1day\u017f', '1\u2028d', `${'1'.repeat(20)}!`]) expect(wordsMinutes(text), text).toEqual(oldWords(text));
  });

  it('the comment at the end of a TOML value', () => {
    const alphabet = ['#', 'a', '"', '=', '[', ',', '\uD83D', '\uDE00', ...BLANKS, ...TERMINATORS];
    expect(differences(texts(alphabet, 14, SEED + 2), oldTomlComment, withoutTomlComment)).toEqual([]);
    for (const text of ['a#b', 'a #b', 'a # b\n', 'a\n#x', ' #', '#', 'a \n #x', 'a # b # c', 'a\t#\u2028x']) expect(withoutTomlComment(text), text).toBe(oldTomlComment(text));
  });

  it('trailing slashes', () => {
    const alphabet = ['/', 'a', '\\', '.', ' ', ...TERMINATORS];
    expect(differences(texts(alphabet, 12, SEED + 3), oldTrim, (text) => trimTrailing(text, '/'))).toEqual([]);
  });

  it('a requirement before its options', () => {
    const alphabet = ['requests', '==2.3', '-', '--', 'a', 'Z', 'x', ';', '@', ...BLANKS, ...TERMINATORS];
    expect(differences(texts(alphabet, 12, SEED + 4), oldRequirement, requirementBeforeOptions)).toEqual([]);
  });

  it('the list indentation of a YAML document', () => {
    const alphabet = ['key', 'a', ':', ': ', '#', '# c', '-', '- ', '  ', ' ', '\t', '\n', '\n', '\n  - ', '\n- ', '\r', '\u2028', '\u2029', '\u00a0', '\ufeff', 'x: y'];
    expect(differences(texts(alphabet, 16, SEED + 5), oldIndentsSequences, indentsSequences)).toEqual([]);
    for (const text of ['updates:\n  - a\n', 'updates:\n- a\n', 'a: # c\n    - x', '  a:\n - x', 'a:\r\n  - x', 'x\ra:\n  - b', 'a:b\n  - x', ':a:\n - x']) expect(indentsSequences(text), text).toBe(oldIndentsSequences(text));
  });

  it('a preset without its arguments', () => {
    const alphabet = ['(', ')', 'a', ':', 'config:recommended', '>', '\uD83D', ...TERMINATORS];
    expect(differences(texts(alphabet, 12, SEED + 6), oldPresetName, presetName)).toEqual([]);
    for (const text of ['a()', 'a(b)c)', '))\n(a(): )', '(a\n(b)', ')', '()', 'x(']) expect(presetName(text), text).toBe(oldPresetName(text));
  });

  it('a version of bundle _VERSION_', () => {
    const alphabet = ['1', '0', '12', '.', 'a', 'Z', 'pre', '-', '_', '!', ...BLANKS, ...TERMINATORS, '\u1680', '\u2000', '\u200a', '\u202f', '\u205f', '\u180e', '\u200b'];
    expect(differences(texts(alphabet, 10, SEED + 7), (text) => OLD_GEM_VERSION.test(text), gemVersion)).toEqual([]);
  });

  it('every character blank to /\\s/u is blank to trim, and the other way round', () => {
    // gemVersion trims where the pattern read \s*: both must know the same blanks.
    const different: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const character = String.fromCharCode(code);
      if (/^\s$/u.test(character) !== (character.trim() === '')) different.push(code);
    }
    expect(different).toEqual([]);
  });

  it('markdown of the job summary', () => {
    const alphabet = ['a', '`', '|', '<', '&', '*', 'http', 'www', '.', ':', '\u0007', '\u202e', ...BLANKS, ...TERMINATORS, '\r\n'];
    expect(differences(texts(alphabet, 14, SEED + 8), oldMarkdown, markdown)).toEqual([]);
    for (const text of [' \n \n\t', 'a \n b', 'a  b', '\r', 'a\u2028b']) expect(markdown(text), text).toBe(oldMarkdown(text));
  });

  it('a Dependabot directories glob against a project', () => {
    const globs = ['a', 'b', '*', '**', '/', '.', '(', ')', '\\', '$', '[', '{', '+', '?', '|', '^', '\uD83D', '\uDE00', '\uD83D\uDE00', ...TERMINATORS];
    const projects = ['a', 'b', '/', '.', '(', '$', '\\', '\uD83D', '\uDE00', '\uD83D\uDE00', ...TERMINATORS];
    const random = generator(SEED + 9);
    const pairs = [...texts(globs, 8, SEED + 10)].map((glob): [string, string] => [glob, [...texts(projects, 8, Math.floor(random() * 2 ** 31), 1)][0] ?? '']);
    expect(differences(pairs, ([glob, project]) => oldNamesDirectory(glob, project, true), ([glob, project]) => namesDirectory(glob, project, true))).toEqual([]);
    for (const [glob, project] of [
      ['/*', 'a'],
      ['/*', 'a/b'],
      ['/**', 'a/b'],
      ['/**/x', 'x'],
      ['/a**b', 'a/c/b'],
      ['/***', 'a/b'],
      ['/a*', 'a\u2028b'],
      ['/a**', 'a\u2028b'],
      ['/\uD83D*', '\uD83D\uDE00'],
    ] as const) {
      expect(namesDirectory(glob, project, true), `${glob} ${project}`).toBe(oldNamesDirectory(glob, project, true));
    }
  });

  it('a key and its value after a colon, in the diff of a secret', () => {
    const alphabet = ['a', 'T', 'key', ':', ': ', ' ', '\t', '-', '- ', '"', "'", '\\', '.', '/', '@', '#', '=', 'x', ...BLANKS, ...TERMINATORS];
    expect(differences(texts(alphabet, 10, SEED + 12), oldColonPair, colonPair)).toEqual([]);
    for (const line of ['npmAuthToken: x', '  - "a:b": c', "'k': ", 'a:b: c', 'a: \u2028b', 'a: b\u2028c', 'a:', 'a :  ', '- : x', '-: x', '\u2028a: b', 'a:b:c d']) {
      expect(colonPair(line), JSON.stringify(line)).toEqual(oldColonPair(line));
    }
  });
});

describe('the rewrites read 1 MiB of their worst input quickly (decision D-200)', () => {
  const mebibyte = 1024 * 1024;
  it.each([
    ['words', () => wordsMinutes(`${'1'.repeat(mebibyte)}!`)],
    ['TOML comment', () => withoutTomlComment(`3${' '.repeat(mebibyte)}days`)],
    ['TOML comment after blanks and a hash', () => withoutTomlComment(`${' #'.repeat(mebibyte / 2)}\r`)],
    ['trailing slashes', () => trimTrailing(`${'/'.repeat(mebibyte)}x`, '/')],
    ['requirement', () => requirementBeforeOptions(`requests==2.32.3${' '.repeat(mebibyte)}x`)],
    ['YAML indentation', () => indentsSequences(`x-note: "${':#'.repeat(mebibyte / 2)}"\nupdates:\n  - a\n`)],
    ['YAML indentation with carriage returns', () => indentsSequences(`${'a:\r'.repeat(mebibyte / 3)}\n`)],
    ['preset', () => presetName(`x${'('.repeat(mebibyte)})`)],
    ['bundle version', () => gemVersion(`${'\u00a0'.repeat(mebibyte)}x`)],
    ['markdown', () => markdown(`a${' '.repeat(mebibyte)}b`)],
    ['directories glob', () => directoryGlobMatch('a'.repeat(200), `${'*a'.repeat(2000)}*c`)],
    ['regex shape', () => unreadableRegex(`${'(?:a|b)'.repeat(mebibyte / 7)}`)],
    ['directories glob of stars', () => directoryGlobMatch('a'.repeat(200), `${'*'.repeat(mebibyte)}z`)],
    ['directories glob of stars and letters', () => directoryGlobMatch('a'.repeat(200), `${'**a'.repeat(mebibyte / 3)}z`)],
    ['one directories glob against 100 projects', () => Array.from({ length: 100 }, (_, index) => namesDirectory(`/${'*'.repeat(mebibyte)}z`, `p${index}${'a'.repeat(100)}`, true))],
    ['a colon and many blanks before a line separator', () => colonPair(`npmAuthToken: ${' '.repeat(mebibyte)}x\u2028y`)],
  ])('%s', (_label, action) => {
    expect(cpuSeconds(action)).toBeLessThan(1);
  });
});

describe('Renovate /regex/ patterns doctor runs (decision D-200)', () => {
  it.each([
    ['^\\.github\\/workflows\\/.*\\.ya?ml$', undefined],
    ['^(major|minor)$', undefined],
    ['^(npm|pnpm|yarn|bun|deno|pip|uv|poetry|pdm|pipenv|composer|bundler)$', undefined],
    ['^pep', undefined],
    ['x{3}\\d{2,4}', undefined],
    ['[(?=*]a+', undefined],
    ['\\(a\\)+', undefined],
    ['\\u{1F600}+', undefined],
    ['(a|aa)*z', 'a quantified group'],
    ['(?:ab)?', 'a quantified group'],
    ['(?<name>a){2}', 'a quantified group'],
    ['(a)\\1', 'a backreference'],
    ['(?<n>a)\\k<n>', 'a backreference'],
    ['(?=a)b', 'a lookaround'],
    ['(?!a)b', 'a lookaround'],
    ['(?<=a)b', 'a lookaround'],
    ['(?<!a)b', 'a lookaround'],
    ['a*a*b', 'more than one unbounded quantifier (*, + or {n,})'],
    ['a+|b+', 'more than one unbounded quantifier (*, + or {n,})'],
    ['\\p{L}+x{2,}', 'more than one unbounded quantifier (*, + or {n,})'],
    ['[ab]?'.repeat(8), undefined],
    ['[ab]?'.repeat(9), `more than ${MAX_WAYS} ways to match (each ?, {n,m} and | multiplies them)`],
    ['(?:a|a)'.repeat(9), `more than ${MAX_WAYS} ways to match (each ?, {n,m} and | multiplies them)`],
    ['a{0,300}', `more than ${MAX_WAYS} ways to match (each ?, {n,m} and | multiplies them)`],
    ['.*[ab]?[ab]?c', undefined],
    ['a+[ab]{0,15}', undefined],
    ['^(major|minor|patch|pin|digest)-.*$', undefined],
    ['a+[ab]{0,16}', `an unbounded quantifier (*, + or {n,}) and more than ${MAX_WAYS_UNBOUNDED} ways to match (each ?, {n,m} and | multiplies them)`],
    ['.*[ab]{0,255}c', `an unbounded quantifier (*, + or {n,}) and more than ${MAX_WAYS_UNBOUNDED} ways to match (each ?, {n,m} and | multiplies them)`],
    ['[ab]?[ab]?[ab]?[ab]?[ab]?.*', `an unbounded quantifier (*, + or {n,}) and more than ${MAX_WAYS_UNBOUNDED} ways to match (each ?, {n,m} and | multiplies them)`],
  ])('%s', (source, reason) => {
    expect(() => new RegExp(source, 'u')).not.toThrow();
    expect(unreadableRegex(source)).toBe(reason);
  });

  it('a pattern it runs takes little time on a long input, whatever its shape', () => {
    // Random patterns from pieces that backtrack when combined; whichever ones unreadableRegex lets through run on
    // 300 characters (more than a file name holds) quickly.
    const pieces = ['a', 'a?', 'a*', 'a+', '[ab]', '[ab]?', '(?:a|a)', '(?:a|b)', 'b', '.', '.*', '(a|aa)', '|', '\\d', 'x{2,5}'];
    let ran = 0;
    for (const source of texts(pieces, 12, SEED + 11, 2000)) {
      let compiled: RegExp;
      try {
        compiled = new RegExp(source, 'u');
      } catch {
        continue;
      }
      if (unreadableRegex(source) !== undefined) continue;
      ran += 1;
      expect(cpuSeconds(() => compiled.test(`${'a'.repeat(300)}!`)), source).toBeLessThan(0.2);
    }
    expect(ran).toBeGreaterThan(100);
  });
});
