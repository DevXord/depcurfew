// Whether git ignores a file apply writes: then the protection stays on this machine, and a fresh clone (CI) lacks it.
// A small matcher for the usual .gitignore syntax (environment.git.ignore in the knowledge base): .gitignore files in
// the repository root and the directories down to the file, after .git/info/exclude. Patterns it does not understand
// (character classes) are skipped; when a skipped pattern re-includes files (!), the answer is "unknown", so there is
// never a warning that might be wrong. Tracked files are not ignored, so the index is read to leave them out.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repository } from '../detect/repository.ts';
import { environment } from '../knowledge/environment.ts';
import { values } from './facts.ts';

export interface IgnoreRule {
  /** The pattern as written in the file. */
  pattern: string;
  file: string;
  line: number;
}

/** One path segment of a pattern: literal characters, ? (one character) and * (any run of characters). */
type Token = { kind: 'char'; char: string } | { kind: 'one' } | { kind: 'any' };
/** A pattern as segments between slashes; ** as a whole segment stands for any number of directories. */
type Glob = (Token[] | '**')[];

interface Rule extends IgnoreRule {
  /** The directory of the .gitignore, '' for the root. */
  base: string;
  negate: boolean;
  directoryOnly: boolean;
  /** With a slash at the start or in the middle, the pattern matches paths relative to `base`, otherwise names. */
  anchored: boolean;
  /** undefined: a pattern this matcher does not understand. */
  glob: Glob | undefined;
}

export type IgnoreResult = { ignored: true; rule: IgnoreRule } | { ignored: false } | { ignored: 'unknown' };

/**
 * A pattern of a .gitignore as segments; undefined for character classes, which are not supported, and for a
 * trailing backslash, which never matches. No regular expressions: the patterns come from the repository, and a
 * regular expression built from *a*a*a… backtracks exponentially.
 */
function compileGlob(pattern: string): Glob | undefined {
  const segments: Glob = [];
  for (const segment of pattern.split('/')) {
    if (segment === '**') {
      segments.push('**');
      continue;
    }
    const tokens: Token[] = [];
    for (let index = 0; index < segment.length; index++) {
      const char = segment[index] ?? '';
      if (char === '\\') {
        const next = segment[index + 1];
        if (next === undefined) return undefined;
        tokens.push({ kind: 'char', char: next });
        index += 1;
      } else if (char === '[') {
        return undefined;
      } else if (char === '*') {
        // Other runs of asterisks are ordinary asterisks.
        if (tokens.at(-1)?.kind !== 'any') tokens.push({ kind: 'any' });
      } else if (char === '?') {
        tokens.push({ kind: 'one' });
      } else {
        tokens.push({ kind: 'char', char });
      }
    }
    segments.push(tokens);
  }
  return segments;
}

/** One segment against a name: greedy with one backtracking point, at most length(name) × length(tokens) steps. */
function matchSegment(name: string, tokens: readonly Token[]): boolean {
  let at = 0;
  let index = 0;
  let star = -1;
  let resume = 0;
  while (at < name.length) {
    const token = tokens[index];
    if (token?.kind === 'any') {
      star = index;
      index += 1;
      resume = at;
    } else if (token !== undefined && (token.kind === 'one' || token.char === name[at])) {
      index += 1;
      at += 1;
    } else if (star !== -1) {
      index = star + 1;
      resume += 1;
      at = resume;
    } else {
      return false;
    }
  }
  while (tokens[index]?.kind === 'any') index += 1;
  return index === tokens.length;
}

/** Path segments against pattern segments: ** at the start or in the middle matches zero or more, at the end one or more. */
function matchGlob(parts: readonly string[], glob: Glob): boolean {
  const memo = new Map<number, boolean>();
  const match = (pattern: number, part: number): boolean => {
    const key = pattern * (parts.length + 1) + part;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    const segment = glob[pattern];
    if (segment === undefined) result = part === parts.length;
    else if (segment === '**') {
      if (pattern === glob.length - 1) result = part < parts.length;
      else {
        result = false;
        for (let next = part; next <= parts.length && !result; next++) result = match(pattern + 1, next);
      }
    } else result = part < parts.length && matchSegment(parts[part] ?? '', segment) && match(pattern + 1, part + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** The rules of one pattern file; `base` is its directory ('' for the root and for .git/info/exclude). */
export function parseIgnoreFile(text: string, file: string, base: string): Rule[] {
  const rules: Rule[] = [];
  text.split('\n').forEach((raw, index) => {
    let line = raw.replace(/\r$/u, '');
    if (line === '' || line.startsWith('#')) return;
    // Trailing spaces are dropped unless escaped with a backslash.
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);
    if (line === '') return;
    const pattern = line;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    const directoryOnly = line.endsWith('/') && !line.endsWith('\\/');
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (line === '') return;
    rules.push({ pattern, file, line: index + 1, base, negate, directoryOnly, anchored, glob: compileGlob(line) });
  });
  return rules;
}

function matches(rule: Rule, path: string, directory: boolean): boolean | undefined {
  if (rule.base !== '' && !path.startsWith(`${rule.base}/`)) return false;
  if (rule.directoryOnly && !directory) return false;
  if (rule.glob === undefined) return undefined;
  const relative = rule.base === '' ? path : path.slice(rule.base.length + 1);
  return matchGlob(rule.anchored ? relative.split('/') : [relative.split('/').at(-1) ?? relative], rule.glob);
}

/** The last rule that decides about `path`; 'unknown' when a rule it cannot read might re-include it. */
function decide(rules: readonly Rule[], path: string, directory: boolean): Rule | undefined | 'unknown' {
  let decided: Rule | undefined;
  for (const rule of rules) {
    const result = matches(rule, path, directory);
    if (result === undefined) {
      // A positive pattern that is skipped can only hide an ignored file; a negation might un-ignore it.
      if (rule.negate) return 'unknown';
      continue;
    }
    if (result) decided = rule;
  }
  return decided;
}

function ignoreFacts(): { file: string; excludeFile: string; indexFile: string } {
  const [fact] = values(environment.git.ignore);
  return fact ?? { file: '.gitignore', excludeFile: '.git/info/exclude', indexFile: '.git/index' };
}

/** Pattern files in the order git reads them for `path`: info/exclude, then .gitignore from the root down. */
function rulesFor(repository: Repository, path: string, cache: Map<string, Rule[]>): Rule[] {
  const facts = ignoreFacts();
  const directories = path.split('/').slice(0, -1);
  const files: [string, string][] = [[facts.excludeFile, '']];
  for (let depth = 0; depth <= directories.length; depth++) {
    const base = directories.slice(0, depth).join('/');
    files.push([base === '' ? facts.file : `${base}/${facts.file}`, base]);
  }
  return files.flatMap(([file, base]) => {
    let rules = cache.get(file);
    if (rules === undefined) {
      const text = repository.isFile(file) ? repository.readText(file) : undefined;
      rules = text === undefined ? [] : parseIgnoreFile(text, file, base);
      cache.set(file, rules);
    }
    return rules;
  });
}

/** Whether git ignores the file at `path` (relative to the root, with `/`) when it is not tracked. */
export function ignoredByGit(repository: Repository, path: string, cache = new Map<string, Rule[]>()): IgnoreResult {
  const rules = rulesFor(repository, path, cache);
  const parts = path.split('/');
  // A file below an ignored directory cannot be re-included; git does not even look inside.
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join('/');
    const decided = decide(rules, directory, true);
    if (decided === 'unknown') return { ignored: 'unknown' };
    if (decided !== undefined && !decided.negate) return { ignored: true, rule: { pattern: decided.pattern, file: decided.file, line: decided.line } };
  }
  const decided = decide(rules, path, false);
  if (decided === 'unknown') return { ignored: 'unknown' };
  return decided !== undefined && !decided.negate ? { ignored: true, rule: { pattern: decided.pattern, file: decided.file, line: decided.line } } : { ignored: false };
}

const MAX_INDEX_SIZE = 64 * 1024 * 1024;

/** A number in the variable-width encoding of index version 4 (as OFS_DELTA offsets in pack files). */
function readOffset(buffer: Buffer, start: number): { value: number; next: number } | undefined {
  let index = start;
  let byte = buffer[index];
  if (byte === undefined) return undefined;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    index += 1;
    byte = buffer[index];
    if (byte === undefined) return undefined;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: index + 1 };
}

/** The paths in an index file (versions 2 to 4), or undefined when it does not read as one with that hash size. */
function indexPaths(buffer: Buffer, hashSize: number): Set<string> | undefined {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'DIRC') return undefined;
  const version = buffer.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const count = buffer.readUInt32BE(8);
  const paths = new Set<string>();
  let offset = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    const flagsAt = start + 40 + hashSize;
    if (flagsAt + 2 > buffer.length) return undefined;
    const flags = buffer.readUInt16BE(flagsAt);
    let nameAt = flagsAt + 2;
    if ((flags & 0x4000) !== 0) {
      if (version < 3) return undefined;
      nameAt += 2;
    }
    let name: Buffer;
    if (version === 4) {
      const strip = readOffset(buffer, nameAt);
      if (strip === undefined || strip.value > previous.length) return undefined;
      const end = buffer.indexOf(0, strip.next);
      if (end === -1) return undefined;
      name = Buffer.concat([previous.subarray(0, previous.length - strip.value), buffer.subarray(strip.next, end)]);
      offset = end + 1;
    } else {
      const end = buffer.indexOf(0, nameAt);
      if (end === -1) return undefined;
      name = buffer.subarray(nameAt, end);
      // Entries are padded with 1 to 8 NUL bytes to a multiple of eight bytes.
      offset = start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    const length = flags & 0x0fff;
    if (length !== 0x0fff && length !== name.length) return undefined;
    previous = name;
    paths.add(name.toString('utf8'));
  }
  // In split-index mode (the link extension) most entries live in a shared index, which is not read.
  for (let at = offset; at + 8 <= buffer.length - hashSize; ) {
    if (buffer.toString('latin1', at, at + 4) === 'link') return undefined;
    at += 8 + buffer.readUInt32BE(at + 4);
  }
  return offset <= buffer.length ? paths : undefined;
}

/**
 * The tracked files, from the index in the root's .git directory; undefined when there is none (a linked worktree, a
 * subdirectory of a repository) or it cannot be read. SHA-1 and SHA-256 repositories differ in the hash size.
 */
export function trackedFiles(repository: Repository): Set<string> | undefined {
  const file = ignoreFacts().indexFile;
  if (!repository.isFile(file)) return undefined;
  const path = join(repository.root, file);
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_INDEX_SIZE) return undefined;
    const buffer = readFileSync(path);
    return indexPaths(buffer, 20) ?? indexPaths(buffer, 32);
  } catch {
    return undefined;
  }
}
