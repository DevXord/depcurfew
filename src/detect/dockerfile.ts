// A small Dockerfile reader: parser directives (# escape=), comments, line continuations, here-documents and
// instructions in any case, in one linear pass without recursion. It reads what detection needs (ARG before the first
// FROM, FROM and RUN) and leaves the rest. Facts about the syntax come from the knowledge base (docker.syntax).
import type { DockerfileSyntaxKnowledge } from '../knowledge/types.ts';

export interface HereDocument {
  /** The body, lines joined with \n. */
  body: string;
  /** The line of the body's first line. */
  line: number;
  /** The words before the << marker on the instruction line, for telling a script from data. */
  before: string;
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
const HEREDOC = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2/gu;
/** Instructions whose here-documents belong to them. */
const HEREDOC_INSTRUCTIONS = new Set(['RUN', 'COPY', 'ADD']);

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

/** The here-document markers of an instruction's text, in order. */
function heredocMarkers(text: string): { strip: boolean; delimiter: string; index: number }[] {
  const markers: { strip: boolean; delimiter: string; index: number }[] = [];
  for (const match of text.matchAll(HEREDOC)) markers.push({ strip: match[1] === '-', delimiter: match[3] ?? '', index: match.index });
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
    if (HEREDOC_INSTRUCTIONS.has(instruction.keyword) && !text.startsWith('[')) {
      for (const marker of heredocMarkers(text)) {
        const body: string[] = [];
        const bodyLine = index + 1;
        while (index < lines.length) {
          const raw = lines[index] ?? '';
          index += 1;
          const candidate = marker.strip ? raw.replace(/^\t+/u, '') : raw;
          if (candidate === marker.delimiter) break;
          body.push(candidate);
        }
        instruction.heredocs.push({ body: body.join('\n'), line: bodyLine, before: text.slice(0, marker.index).trim() });
      }
    }
    instructions.push(instruction);
  }
  return instructions;
}

/** The line of an offset in an instruction's text. */
export function lineAt(instruction: Instruction, offset: number): number {
  let line = instruction.line;
  for (const segment of instruction.segments) {
    if (segment.offset > offset) break;
    line = segment.line;
  }
  return line;
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

export type Substitution = { ok: true; value: string } | { ok: false; variable: string };

/**
 * Replaces $VAR, ${VAR}, ${VAR:-word}, ${VAR-word}, ${VAR:+word} and ${VAR+word} with the ARGs declared before the
 * first FROM. A variable without a value (declared without a default, or not declared) can only come from
 * --build-arg, so the result is unknown, unless a modifier gives the value for an unset variable.
 */
export function substitute(text: string, args: ReadonlyMap<string, string | undefined>, escape: string): Substitution {
  let result = '';
  for (let index = 0; index < text.length; index++) {
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
  return { ok: true, value: result };
}
