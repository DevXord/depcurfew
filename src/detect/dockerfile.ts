// A small Dockerfile reader: parser directives (# escape=), comments, line continuations, here-documents and
// instructions in any case, in one linear pass without recursion. It reads what detection needs (ARG before the first
// FROM, FROM and RUN) and leaves the rest. Facts about the syntax come from the knowledge base (docker.syntax).
import type { DockerfileSyntaxKnowledge } from '../knowledge/types.ts';

export interface HereDocument {
  /** The body, lines joined with \n. */
  body: string;
  /** The line of the body's first line. */
  line: number;
  /**
   * The other words of the simple command the << marker is in (up to &&, ||, ;, | or &), other markers left out and
   * joined by spaces, for telling a script from data: RUN <<EOF and RUN <<EOF bash feed it to a shell, RUN <<EOF cat > f
   * does not. Absent when there are more than MAX_COMMAND_WORDS of them (then it is no script fed to a shell).
   */
  command?: string;
}

export interface Instruction {
  /** In upper case. */
  keyword: string;
  /** The arguments, with continuation lines joined as the builder joins them (escape and line break removed). */
  text: string;
  line: number;
  /** For each continuation line: the offset in text where it starts and its line number. */
  segments: readonly { offset: number; line: number }[];
  heredocs: HereDocument[];
}

const DIRECTIVE = /^#[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*=(.*)$/u;
const KNOWN_DIRECTIVES = new Set(['syntax', 'escape', 'check']);
/** A word that starts a here-document: an optional file descriptor, <<, an optional -, and the delimiter, quoted or not. */
const HEREDOC_WORD = /^\d*<<(-?)(["']?)([A-Za-z0-9_][A-Za-z0-9_.-]*)\2$/u;
/** Instructions whose here-documents belong to them. */
const HEREDOC_INSTRUCTIONS = new Set(['RUN', 'COPY', 'ADD']);
/** Words kept of the command a here-document marker is in; a shell with its options needs few. */
const MAX_COMMAND_WORDS = 16;
/** Words that end a simple command. */
const OPERATORS = new Set(['&&', '||', ';', '|', '&']);
/** Longer words are no marker, and only their start is kept. */
const MAX_WORD = 256;
/** Here-document bodies kept per instruction; later ones are still read past, so the instructions after them stay right. */
export const MAX_HEREDOCS = 256;

/** The escape character the parser directives at the top of the file set. */
function escapeOf(lines: readonly string[], syntax: DockerfileSyntaxKnowledge): { escape: string; start: number } {
  let escape = syntax.escapeCharacters[0] ?? '\\';
  const seen = new Set<string>();
  let index = 0;
  for (; index < lines.length; index++) {
    const match = DIRECTIVE.exec((lines[index] ?? '').trimStart());
    if (match === null) break;
    const key = (match[1] ?? '').toLowerCase();
    // An unknown or repeated directive is a comment, and no directive is read after a comment.
    if (!KNOWN_DIRECTIVES.has(key) || seen.has(key)) break;
    seen.add(key);
    const value = (match[2] ?? '').trim();
    if (key === syntax.escapeDirective && syntax.escapeCharacters.includes(value)) escape = value;
  }
  return { escape, start: index };
}

interface Marker {
  strip: boolean;
  delimiter: string;
  command?: string;
}

/**
 * The here-document markers of an instruction's text, in order, as BuildKit finds them (decision D-105): the text is
 * split into words with quotes kept, and only a whole word such as <<EOF, <<-"EOF" or 3<<EOF starts a here-document,
 * so `echo "a <<b"` starts none. One pass over the text.
 */
function heredocMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  // The simple command being read: its words other than markers, how many, and the markers in it so far.
  let words: string[] = [];
  let count = 0;
  let pending: Marker[] = [];
  let word = '';
  let inWord = false;
  const append = (part: string) => {
    if (word.length <= MAX_WORD) word += part.slice(0, MAX_WORD + 1 - word.length);
  };
  const endCommand = () => {
    for (const marker of pending) if (count <= MAX_COMMAND_WORDS) marker.command = words.join(' ');
    words = [];
    count = 0;
    pending = [];
  };
  const end = () => {
    if (!inWord) return;
    inWord = false;
    const match = word.length <= MAX_WORD ? HEREDOC_WORD.exec(word) : null;
    if (match !== null) {
      const marker: Marker = { strip: match[1] === '-', delimiter: match[3] ?? '' };
      markers.push(marker);
      pending.push(marker);
    } else if (OPERATORS.has(word)) {
      endCommand();
    } else {
      const last = word.endsWith(';') && !word.endsWith('\\;');
      count += 1;
      if (count <= MAX_COMMAND_WORDS) words.push(last ? word.slice(0, -1) : word);
      if (last) endCommand();
    }
    word = '';
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (char === ' ' || char === '\t') {
      end();
      continue;
    }
    inWord = true;
    if (char === '"' || char === "'") {
      // A quoted part stays in the word, quotes included; a backslash escapes the next character inside double quotes.
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char) cursor += char === '"' && text[cursor] === '\\' ? 2 : 1;
      const close = Math.min(cursor, text.length - 1);
      append(text.slice(index, Math.min(close + 1, index + MAX_WORD + 1)));
      index = close;
    } else if (char === '\\') {
      append(text.slice(index, index + 2));
      index += 1;
    } else {
      append(char);
    }
  }
  end();
  endCommand();
  return markers;
}

/** Reads the instructions of a Dockerfile. Every line is looked at once, so the time grows with the size of the file. */
export function readDockerfile(source: string, syntax: DockerfileSyntaxKnowledge): Instruction[] {
  const lines = source.split(/\r?\n/u);
  const { escape, start } = escapeOf(lines, syntax);
  const instructions: Instruction[] = [];
  let index = start;
  while (index < lines.length) {
    const first = (lines[index] ?? '').trimStart();
    if (first === '' || first.startsWith(syntax.comment)) {
      index += 1;
      continue;
    }
    const line = index + 1;
    const parts: string[] = [];
    const segments: { offset: number; line: number }[] = [];
    let length = 0;
    let current = first;
    let currentLine = line;
    // Continuation lines: comment lines and empty lines inside them are removed, as the builder does.
    for (;;) {
      const trimmed = current.trimEnd();
      const continues = trimmed.endsWith(escape);
      const content = continues ? trimmed.slice(0, -escape.length) : current;
      segments.push({ offset: length, line: currentLine });
      parts.push(content);
      length += content.length;
      index += 1;
      if (!continues) break;
      while (index < lines.length) {
        const next = (lines[index] ?? '').trimStart();
        if (next !== '' && !next.startsWith(syntax.comment)) break;
        index += 1;
      }
      if (index >= lines.length) break;
      current = lines[index] ?? '';
      currentLine = index + 1;
    }
    const whole = parts.join('');
    const keyword = /^\S+/u.exec(whole)?.[0] ?? '';
    const text = whole.slice(keyword.length).trimStart();
    const shift = whole.length - text.length;
    const instruction: Instruction = {
      keyword: keyword.toUpperCase(),
      text,
      line,
      segments: segments.map((segment) => ({ offset: Math.max(0, segment.offset - shift), line: segment.line })),
      heredocs: [],
    };
    if (HEREDOC_INSTRUCTIONS.has(instruction.keyword) && !text.startsWith('[') && text.includes('<<')) {
      for (const marker of heredocMarkers(text)) {
        const body: string[] = [];
        const bodyLine = index + 1;
        const keep = instruction.heredocs.length < MAX_HEREDOCS;
        while (index < lines.length) {
          const raw = lines[index] ?? '';
          index += 1;
          const candidate = marker.strip ? raw.replace(/^\t+/u, '') : raw;
          if (candidate === marker.delimiter) break;
          if (keep) body.push(candidate);
        }
        if (keep) instruction.heredocs.push({ body: body.join('\n'), line: bodyLine, ...(marker.command === undefined ? {} : { command: marker.command }) });
      }
    }
    instructions.push(instruction);
  }
  return instructions;
}

/** The line of an offset in an instruction's text: the last segment that starts at or before it, by binary search. */
export function lineAt(instruction: Instruction, offset: number): number {
  const { segments } = instruction;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.offset ?? 0) <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found < 0 ? instruction.line : (segments[found]?.line ?? instruction.line);
}

/** ARG NAME=value ARG2: the names with their defaults (undefined when there is none), quotes removed. */
export function argDeclarations(text: string): [string, string | undefined][] {
  const declarations: [string, string | undefined][] = [];
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:=("[^"]*"|'[^']*'|\S*))?/gu)) {
    const value = match[2];
    declarations.push([match[1] ?? '', value === undefined ? undefined : /^(["']).*\1$/su.test(value) ? value.slice(1, -1) : value]);
  }
  return declarations;
}

/** A value longer than this after substitution is not read: ARGs that repeat each other grow without bound. */
export const MAX_SUBSTITUTED_LENGTH = 4096;
/** At most this many variables are replaced in one value. */
export const MAX_SUBSTITUTIONS = 256;

/** Why a value cannot be told: a variable without a value, or one depcurfew does not read (`reason`). */
export type Substitution = { ok: true; value: string } | { ok: false; variable: string; reason?: string };

const TOO_LONG = `it is longer than ${MAX_SUBSTITUTED_LENGTH} characters after ARG substitution, which depcurfew does not read`;

/**
 * Replaces $VAR, ${VAR}, ${VAR:-word}, ${VAR-word}, ${VAR:+word} and ${VAR+word} with the ARGs declared before the
 * first FROM. A variable without a value (declared without a default, or not declared) can only come from
 * --build-arg, so the result is unknown, unless a modifier gives the value for an unset variable. A variable in
 * `unreadable` (an ARG whose own value depcurfew did not read) and a result past MAX_SUBSTITUTED_LENGTH characters or
 * MAX_SUBSTITUTIONS variables are unknown too, with the reason.
 */
export function substitute(text: string, args: ReadonlyMap<string, string | undefined>, escape: string, unreadable: ReadonlyMap<string, string> = new Map()): Substitution {
  let result = '';
  let substitutions = 0;
  if (text.length > MAX_SUBSTITUTED_LENGTH) return { ok: false, variable: '', reason: TOO_LONG };
  for (let index = 0; index < text.length; index++) {
    if (result.length > MAX_SUBSTITUTED_LENGTH) return { ok: false, variable: '', reason: TOO_LONG };
    const char = text[index] ?? '';
    if (char === escape && text[index + 1] === '$') {
      result += '$';
      index += 1;
      continue;
    }
    if (char !== '$') {
      result += char;
      continue;
    }
    let name: string;
    let modifier = '';
    let word = '';
    if (text[index + 1] === '{') {
      const end = text.indexOf('}', index + 2);
      if (end < 0) return { ok: false, variable: text.slice(index + 2) };
      const inner = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])(.*))?$/su.exec(text.slice(index + 2, end));
      if (inner === null) return { ok: false, variable: text.slice(index + 2, end) };
      name = inner[1] ?? '';
      modifier = inner[2] ?? '';
      word = inner[3] ?? '';
      index = end;
    } else {
      const plain = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(index + 1, index + 257))?.[0];
      if (plain === undefined) {
        result += char;
        continue;
      }
      name = plain;
      index += plain.length;
    }
    substitutions += 1;
    if (substitutions > MAX_SUBSTITUTIONS) return { ok: false, variable: name, reason: `it uses more than ${MAX_SUBSTITUTIONS} ARG substitutions, which depcurfew does not read` };
    const why = unreadable.get(name);
    if (why !== undefined) return { ok: false, variable: name, reason: why };
    const value = args.get(name);
    const set = value !== undefined;
    const empty = value === undefined || value === '';
    if (modifier === ':-' || modifier === '-') {
      if ((modifier === ':-' && empty) || (modifier === '-' && !set)) result += word;
      else result += value ?? '';
    } else if (modifier === ':+' || modifier === '+') {
      if ((modifier === ':+' && !empty) || (modifier === '+' && set)) result += word;
    } else if (set) {
      result += value;
    } else {
      return { ok: false, variable: name };
    }
  }
  return result.length > MAX_SUBSTITUTED_LENGTH ? { ok: false, variable: '', reason: TOO_LONG } : { ok: true, value: result };
}
