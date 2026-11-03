// The yarn.lock of Yarn Classic (lockfile v1) for known-malicious (decision D-165), read as the parser of Yarn 1.22.22
// reads it (yarn extra.classicLockfile, src/lockfile/parse.js): its tokens, two spaces per level, several keys for one
// value, later keys winning, and the two sides of a git conflict, the second winning. What Yarn Classic fetches for an
// entry is the URL of resolved without the part after #, so a registry tarball URL gives the package and the version
// looked up, read as for package-lock.json. Yarn Classic stays unsupported for settings; only the lookups read this.
import type { LockEntry, Source } from './lockfiles.ts';

type Format = Record<string, unknown>;

/** A lockfile of a later format version, which Yarn Classic refuses: not checked, with the reason. */
export class UnsupportedClassicLockfile extends Error {}

type Token =
  | { type: 'string'; value: string; line: number }
  | { type: 'number'; value: number; line: number }
  | { type: 'boolean'; value: boolean; line: number }
  | { type: 'indent'; value: number; line: number }
  | { type: 'colon' | 'comma' | 'newline' | 'eof' | 'invalid'; line: number };

/** Levels deeper than any yarn.lock has (an entry and its dependencies are two): deeper input is not read. */
const MAX_DEPTH = 64;

/** The first character of a word (an unquoted string) in parse.js, and the rest of a word, digits and spaces. */
const WORD_START = /[a-zA-Z/.-]/u;
const WORD = /[^:\n\r ,]*/uy;
const DIGITS = /[0-9]+/uy;
const SPACES = / +/uy;
/** What makes JSON.parse look at a quoted string more closely than taking its characters: an escape or a control character. */
const NOT_PLAIN = /[\\\u0000-\u001f]/u;

/**
 * The tokens of tokenise in src/lockfile/parse.js, one per call, in linear time. A newline is \n or \r and, as in Yarn,
 * the \n after it (so \n\n is one newline there, and the blank line does not end an entry); `line` counts the lines of
 * the file. A comment runs from # to the next \n and is checked for the format version; the spaces at the start of a
 * line are an indent of half their count (an odd count throws); a string in double quotes is JSON, and a quote after a
 * backslash that does not follow another backslash does not end it; then digits, true and false, colon and comma, and
 * a word from a letter, /, . or - to the next colon, space, line end or comma. Anything else is invalid, and nothing
 * follows it.
 */
function classicTokens(text: string, versionComment: RegExp, lockfileVersion: number, lineOf: (line: number) => number): () => Token {
  let line = 1;
  let at = 0;
  let afterNewline = false;
  let ended = false;
  const length = text.length;
  const sticky = (pattern: RegExp): number => {
    pattern.lastIndex = at;
    return pattern.exec(text) === null ? at : pattern.lastIndex;
  };
  return (): Token => {
    for (;;) {
      if (ended) throw new Error('it ends in the middle of an entry');
      if (at >= length) {
        ended = true;
        return { type: 'eof', line: lineOf(line) };
      }
      const char = text[at] as string;
      const start = at;
      // A line starts after \n or \r\n, not after a lone \r (lastNewline in parse.js).
      const lineStart = afterNewline;
      afterNewline = false;
      if (char === '\n' || char === '\r') {
        at += text[at + 1] === '\n' ? 2 : 1;
        afterNewline = char === '\n' || text[start + 1] === '\n';
        // \r\n is one line of the file, \n\n two.
        line += char === '\n' && text[start + 1] === '\n' ? 2 : 1;
        return { type: 'newline', line: lineOf(line) };
      }
      if (char === '#') {
        const end = text.indexOf('\n', at + 1);
        const comment = text.slice(at + 1, end === -1 ? length : end).trim();
        const version = versionComment.exec(comment)?.[1];
        if (version !== undefined && Number(version) > lockfileVersion) {
          throw new UnsupportedClassicLockfile(`it is a yarn lockfile v${version}, and Yarn Classic reads only version ${lockfileVersion}`);
        }
        at = end === -1 ? length : end;
        continue;
      }
      if (char === ' ') {
        if (!lineStart) {
          at += 1;
          continue;
        }
        const end = sticky(SPACES);
        const size = end - at;
        if (size % 2 !== 0) throw new Error(`line ${lineOf(line)} is indented by an odd number of spaces`);
        at = end;
        return { type: 'indent', value: size / 2, line: lineOf(line) };
      }
      if (char === '"') {
        let end = text.indexOf('"', at + 1);
        while (end !== -1 && text[end - 1] === '\\' && (end - 2 <= at || text[end - 2] !== '\\')) end = text.indexOf('"', end + 1);
        end = end === -1 ? length : end + 1;
        const quoted = text.slice(at, end);
        at = end;
        let value: unknown;
        if (quoted.length >= 2 && quoted.endsWith('"') && !NOT_PLAIN.test(quoted)) value = quoted.slice(1, -1);
        else {
          try {
            value = JSON.parse(quoted) as unknown;
          } catch {
            value = undefined;
          }
        }
        if (typeof value === 'string') return { type: 'string', value, line: lineOf(line) };
        return { type: 'invalid', line: lineOf(line) };
      }
      if (char >= '0' && char <= '9') {
        const end = sticky(DIGITS);
        const digits = text.slice(at, end);
        at = end;
        return { type: 'number', value: Number(digits), line: lineOf(line) };
      }
      if (text.startsWith('true', at)) {
        at += 4;
        return { type: 'boolean', value: true, line: lineOf(line) };
      }
      if (text.startsWith('false', at)) {
        at += 5;
        return { type: 'boolean', value: false, line: lineOf(line) };
      }
      if (char === ':' || char === ',') {
        at += 1;
        return { type: char === ':' ? 'colon' : 'comma', line: lineOf(line) };
      }
      if (WORD_START.test(char)) {
        const end = sticky(WORD);
        const word = text.slice(at, end);
        at = end;
        return { type: 'string', value: word, line: lineOf(line) };
      }
      ended = true;
      return { type: 'invalid', line: lineOf(line) };
    }
  };
}

/** A parsed value: an object of the lockfile (without a prototype) or a scalar. */
type Value = string | number | boolean | Entries;
interface Entries {
  [key: string]: Value;
}

interface Parsed {
  object: Entries;
  /** The line of the key line of each object. */
  lines: Map<Entries, number>;
}

/**
 * The Parser of src/lockfile/parse.js: the same loop, levels and errors, with a limit on nesting. Where Yarn's parser
 * stops before the end of the file (an indented line outside an entry), Yarn reads no more of it and resolves what
 * follows again, so that is an error here too: depcurfew would not see what Yarn installs. `lineOf` maps the lines of
 * one side of a conflict to the lines of the file.
 */
function parseClassic(text: string, format: Format, lineOf: (line: number) => number = (line) => line): Parsed {
  const versionComment = new RegExp(String(format['versionComment']), 'u');
  const read = classicTokens(text, versionComment, Number(format['lockfileVersion']), lineOf);
  const lines = new Map<Entries, number>();
  let token: Token = { type: 'eof', line: 1 };
  const next = (): Token => {
    token = read();
    return token;
  };
  const unexpected = (): never => {
    throw new Error(`Yarn Classic cannot read line ${token.line}`);
  };
  const key = (): string => {
    if (token.type !== 'string' || token.value === '') return unexpected();
    return token.value;
  };
  const level = (indent: number): Entries => {
    if (indent > MAX_DEPTH) throw new Error(`it nests more than ${MAX_DEPTH} levels deep at line ${token.line}`);
    const object = Object.create(null) as Entries;
    for (;;) {
      const current = token;
      if (current.type === 'newline') {
        const following = next();
        if (indent === 0) continue;
        if (following.type !== 'indent' || following.value !== indent) break;
        next();
      } else if (current.type === 'indent') {
        if (current.value !== indent) break;
        next();
      } else if (current.type === 'eof') {
        break;
      } else if (current.type === 'string') {
        const keys = [key()];
        next();
        while (token.type === 'comma') {
          next();
          keys.push(key());
          next();
        }
        const colon = token.type === 'colon';
        if (colon) next();
        if (token.type === 'string' || token.type === 'number' || token.type === 'boolean') {
          for (const name of keys) object[name] = token.value;
          next();
        } else if (colon) {
          const value = level(indent + 1);
          lines.set(value, current.line);
          for (const name of keys) object[name] = value;
          if (indent !== 0 && token.type !== 'indent') break;
        } else {
          unexpected();
        }
      } else {
        unexpected();
      }
    }
    return object;
  };
  next();
  const object = level(0);
  // What Yarn's parser leaves unread: blank and indented lines only, or the start of what Yarn does not lock.
  for (let rest: Token = token; rest.type !== 'eof'; rest = next()) {
    if (rest.type !== 'newline' && rest.type !== 'indent') throw new Error(`Yarn Classic stops reading it before line ${rest.line} and resolves the packages after that again`);
  }
  return { object, lines };
}

const CONFLICT = { start: '<<<<<<<', separator: '=======', ancestor: '|||||||', end: '>>>>>>>' };

interface Side {
  text: string;
  /** The line of the file of each line of the side, from 1. */
  lines: number[];
}

/** The two sides of a git conflict, as extractConflictVariants reads them; undefined without conflict markers. */
function conflictSides(text: string): [Side, Side] | undefined {
  if (!text.includes(CONFLICT.start) || !text.includes(CONFLICT.separator) || !text.includes(CONFLICT.end)) return undefined;
  const sides: [{ text: string[]; lines: number[] }, { text: string[]; lines: number[] }] = [
    { text: [], lines: [] },
    { text: [], lines: [] },
  ];
  const push = (side: 0 | 1, line: string, number: number) => {
    sides[side].text.push(line);
    sides[side].lines.push(number);
  };
  const lines = text.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++] as string;
    if (!line.startsWith(CONFLICT.start)) {
      push(0, line, index);
      push(1, line, index);
      continue;
    }
    let skip = false;
    while (index < lines.length) {
      const inner = lines[index++] as string;
      if (inner === CONFLICT.separator) break;
      if (skip || inner.startsWith(CONFLICT.ancestor)) skip = true;
      else push(0, inner, index);
    }
    while (index < lines.length) {
      const inner = lines[index++] as string;
      if (inner.startsWith(CONFLICT.end)) break;
      push(1, inner, index);
    }
  }
  return [
    { text: sides[0].text.join('\n'), lines: sides[0].lines },
    { text: sides[1].text.join('\n'), lines: sides[1].lines },
  ];
}

/** The parsed lockfile; of a conflicted one both sides, the second winning per key (parseWithConflict). */
function readClassic(text: string, format: Format): Parsed {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const sides = conflictSides(body);
  if (sides === undefined) return parseClassic(body, format);
  const [ours, theirs] = sides.map((side) => parseClassic(side.text, format, (line) => side.lines[line - 1] ?? line)) as [Parsed, Parsed];
  return { object: Object.assign(Object.create(null) as Entries, ours.object, theirs.object), lines: new Map([...ours.lines, ...theirs.lines]) };
}

function isEntries(value: Value | undefined): value is Entries {
  return typeof value === 'object' && value !== null;
}

/** Splits name@range as normalizePattern does: the scope's @ is not the separator. */
function patternParts(pattern: string): { name: string; range: string } {
  const scoped = pattern.startsWith('@');
  const parts = (scoped ? pattern.slice(1) : pattern).split('@');
  return { name: `${scoped ? '@' : ''}${parts[0] ?? ''}`, range: parts.slice(1).join('@') };
}

/** How a tarball URL is read for its registry package: npm's facts (tarballIdentity, lockfileFormat.registryTarball). */
export interface ClassicTarballs {
  registry: RegExp;
  identity: (url: string) => { name: string; version: string } | undefined;
}

/**
 * The entries of a yarn.lock of Yarn Classic. An entry with resolved comes from that URL: a registry tarball URL gives
 * the package and version looked up (a mislabel when the name its pattern declares, after an npm: alias, or its version
 * field differ), a git URL is git, file: and relative paths a local tarball, any other URL a tarball URL. An entry
 * without resolved is local when its pattern is (file:, link:, ./, ../, /); otherwise Yarn resolves its range again, so
 * it is a registry package without an exact version. Throws UnsupportedClassicLockfile for a later format version, and
 * an Error where Yarn's parser fails or stops early.
 */
export function classicYarnEntries(text: string, format: Format, tarballs: ClassicTarballs | undefined): LockEntry[] {
  const { object, lines } = readClassic(text, format);
  const versionKey = String(format['version']);
  const resolvedKey = String(format['resolved']);
  const hash = String(format['hash']);
  const alias = String(format['alias']);
  const git = new RegExp(String(format['gitResolved']), 'u');
  const local = Array.isArray(format['local']) ? format['local'].filter((item): item is string => typeof item === 'string') : [];
  // One entry per object: a key line with several patterns, or the same pattern repeated, share it. A key whose value
  // is a string names another pattern, which Yarn follows and which is an entry of its own.
  const patterns = new Map<Entries, string[]>();
  for (const [key, value] of Object.entries(object)) {
    if (isEntries(value)) patterns.set(value, [...(patterns.get(value) ?? []), key]);
  }
  const entries: LockEntry[] = [];
  for (const [value, keys] of patterns) {
    const key = keys[0] as string;
    const pattern = patternParts(key);
    // npm:<name>@<range> installs another package (registry-resolver.js).
    const target = pattern.range.startsWith(alias) ? patternParts(pattern.range.slice(alias.length)) : pattern;
    const name = target.name;
    const resolved = typeof value[resolvedKey] === 'string' ? value[resolvedKey] : undefined;
    const field = value[versionKey];
    const version = typeof field === 'string' ? field : typeof field === 'number' ? String(field) : undefined;
    const line = lines.get(value);
    const base = { name, spec: resolved ?? pattern.range, installScript: undefined, anchor: key, ...(line === undefined ? {} : { line }) };
    if (resolved === undefined) {
      const source: Source = local.some((prefix) => target.range.startsWith(prefix)) ? 'directory' : /[:/]/u.test(target.range) ? 'unknown' : 'registry';
      entries.push({ ...base, source });
      continue;
    }
    const url = resolved.split(hash)[0] ?? '';
    if (git.test(url)) {
      entries.push({ ...base, source: 'git' });
    } else if (!/^https?:\/\//u.test(url)) {
      entries.push({ ...base, source: local.some((prefix) => url.startsWith(prefix)) ? 'file' : 'unknown' });
    } else if (tarballs === undefined || !tarballs.registry.test(url)) {
      entries.push({ ...base, source: 'remoteTarball' });
    } else {
      // Yarn Classic fetches the tarball of resolved, whatever the version field says; a registry tarball URL from which
      // depcurfew reads no name and version is an entry without an exact version, never the version field (D-136).
      const identity = tarballs.identity(url);
      if (identity === undefined) {
        entries.push({ ...base, source: 'registry' });
        continue;
      }
      const same = identity.name === name && version === identity.version;
      entries.push({
        ...base,
        source: 'registry',
        version: identity.version,
        ...(identity.name === name ? {} : { registryName: identity.name }),
        ...(same ? {} : { mislabel: { tool: 'yarn-classic' as const, key, label: version === undefined ? name : `${name}@${version}` } }),
      });
    }
  }
  return entries;
}
