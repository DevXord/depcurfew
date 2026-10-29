// Edits JSON and JSONC text in place: values are replaced or inserted, and everything else (indentation, comments,
// trailing commas, key order) stays as it is. New values are written with the file's indentation.
import { nextSignificant, parseJsonc } from '../detect/jsonc.ts';

type Path = readonly (string | number)[];

type JsonNode =
  | { kind: 'object'; start: number; end: number; members: Member[] }
  | { kind: 'array'; start: number; end: number; elements: JsonNode[] }
  | { kind: 'value'; start: number; end: number };

interface Member {
  key: string;
  keyStart: number;
  value: JsonNode;
}

class Parser {
  index = 0;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  skip(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') this.index += 1;
      else if (char === '/' && this.text[this.index + 1] === '/') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1;
      } else if (char === '/' && this.text[this.index + 1] === '*') {
        const end = this.text.indexOf('*/', this.index + 2);
        this.index = end === -1 ? this.text.length : end + 2;
      } else return;
    }
  }

  string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length && this.text[this.index] !== '"') this.index += this.text[this.index] === '\\' ? 2 : 1;
    this.index += 1;
    return JSON.parse(this.text.slice(start, this.index)) as string;
  }

  value(): JsonNode {
    this.skip();
    const start = this.index;
    const char = this.text[this.index];
    if (char === '{') {
      this.index += 1;
      const members: Member[] = [];
      for (;;) {
        this.skip();
        if (this.text[this.index] === '}') break;
        if (this.text[this.index] === ',') {
          this.index += 1;
          continue;
        }
        if (this.text[this.index] !== '"') throw new SyntaxError(`unexpected character at ${this.index}`);
        const keyStart = this.index;
        const key = this.string();
        this.skip();
        if (this.text[this.index] !== ':') throw new SyntaxError(`expected ':' at ${this.index}`);
        this.index += 1;
        members.push({ key, keyStart, value: this.value() });
      }
      this.index += 1;
      return { kind: 'object', start, end: this.index, members };
    }
    if (char === '[') {
      this.index += 1;
      const elements: JsonNode[] = [];
      for (;;) {
        this.skip();
        if (this.text[this.index] === ']') break;
        if (this.text[this.index] === ',') {
          this.index += 1;
          continue;
        }
        elements.push(this.value());
      }
      this.index += 1;
      return { kind: 'array', start, end: this.index, elements };
    }
    if (char === '"') {
      this.string();
      return { kind: 'value', start, end: this.index };
    }
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(this.text.slice(this.index));
    if (match === null) throw new SyntaxError(`unexpected character at ${this.index}`);
    this.index += match[0].length;
    return { kind: 'value', start, end: this.index };
  }
}

function parse(text: string): JsonNode {
  return new Parser(text).value();
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The indentation unit of the file: a tab, or the smallest indentation in spaces; two spaces by default. */
function indentUnit(text: string): string {
  const indents = [...text.matchAll(/\n([ \t]+)\S/gu)].map((match) => match[1] ?? '');
  if (indents.some((indent) => indent.startsWith('\t'))) return '\t';
  const sizes = indents.map((indent) => indent.length).filter((size) => size > 0);
  return ' '.repeat(sizes.length === 0 ? 2 : Math.min(...sizes));
}

function serialize(value: unknown, unit: string, indent: string): string {
  return JSON.stringify(value, null, unit).replaceAll('\n', `\n${indent}`);
}

function isSameLine(text: string, from: number, to: number): boolean {
  return !text.slice(from, to).includes('\n');
}

/** Position after `from` skipping spaces and a comment on the same line; stops at the line break. */
function endOfLine(text: string, from: number): number {
  let index = from;
  for (;;) {
    while (text[index] === ' ' || text[index] === '\t') index += 1;
    if (text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
      return index;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1 || text.slice(index, end).includes('\n')) return index;
      index = end + 2;
      continue;
    }
    return index;
  }
}

function nest(path: Path, value: unknown): unknown {
  return path.reduceRight<unknown>((inner, segment) => ({ [String(segment)]: inner }), value);
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Inserts `entry` (already serialized) after the last of `items` in a container that spans start..end. */
function insertItem(text: string, container: { start: number; end: number }, lastEnd: number | undefined, firstStart: number | undefined, entry: (indent: string) => string): string {
  const unit = indentUnit(text);
  const containerIndent = lineIndent(text, container.start);
  if (lastEnd === undefined || firstStart === undefined) {
    const indent = containerIndent + unit;
    let at = container.start + 1;
    if (text.slice(container.start + 1, container.end - 1).trim() !== '') {
      // Comments in the empty container stay; the entry goes after them.
      at = container.end - 1;
      while (at > container.start + 1 && /\s/u.test(text[at - 1] as string)) at -= 1;
    }
    return `${text.slice(0, at)}\n${indent}${entry(indent)}\n${containerIndent}${text.slice(container.end - 1)}`;
  }
  if (isSameLine(text, container.start, firstStart)) {
    // An inline container such as { "a": 1 }: keep it on one line.
    return `${text.slice(0, lastEnd)}, ${entry('').replaceAll(/\n\s*/gu, ' ')}${text.slice(lastEnd)}`;
  }
  const indent = lineIndent(text, firstStart);
  let after = lastEnd;
  while (text[after] === ' ' || text[after] === '\t') after += 1;
  if (text[after] === ',') {
    const lineEnd = endOfLine(text, after + 1);
    return `${text.slice(0, lineEnd)}\n${indent}${entry(indent)},${text.slice(lineEnd)}`;
  }
  const lineEnd = endOfLine(text, lastEnd);
  const closingOnSameLine = text[lineEnd] === '}' || text[lineEnd] === ']';
  const tail = closingOnSameLine ? `\n${containerIndent}` : '';
  return `${text.slice(0, lastEnd)},${text.slice(lastEnd, lineEnd)}\n${indent}${entry(indent)}${tail}${text.slice(lineEnd)}`;
}

function rootObject(text: string): JsonNode & { kind: 'object' } {
  const root = parse(text);
  if (root.kind !== 'object') throw new Error('the JSON document is not an object');
  return root;
}

function find(text: string, path: Path): JsonNode | undefined {
  let node: JsonNode | undefined = rootObject(text);
  for (const segment of path) {
    if (node?.kind === 'object') node = node.members.filter((member) => member.key === segment).at(-1)?.value;
    else if (node?.kind === 'array' && typeof segment === 'number') node = node.elements[segment];
    else return undefined;
  }
  return node;
}

/** The offset where the value at `path` starts, or undefined; for reporting line numbers. */
export function jsonOffset(text: string, path: Path): number | undefined {
  try {
    return find(text, path)?.start;
  } catch {
    return undefined;
  }
}

export function jsonGet(text: string, path: Path): unknown {
  let value: unknown = parseJsonc(text);
  for (const segment of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[String(segment)];
  }
  return value;
}

/** Sets the value at `path`, creating missing objects on the way. */
export function jsonSet(text: string, path: Path, value: unknown): string {
  const unit = indentUnit(text);
  let node: JsonNode = rootObject(text);
  for (const [index, segment] of path.entries()) {
    if (node.kind === 'object') {
      const member = node.members.filter((item) => item.key === segment).at(-1);
      if (member === undefined) {
        const rest = path.slice(index + 1);
        const last = node.members.at(-1);
        return insertItem(text, node, last?.value.end, node.members[0]?.keyStart, (indent) => `${JSON.stringify(String(segment))}: ${serialize(nest(rest, value), unit, indent)}`);
      }
      node = member.value;
    } else if (node.kind === 'array' && typeof segment === 'number' && node.elements[segment] !== undefined) {
      node = node.elements[segment];
    } else {
      // A value stands where an object is needed: replace it with the nested object.
      const replacement = serialize(nest(path.slice(index), value), unit, lineIndent(text, node.start));
      return `${text.slice(0, node.start)}${replacement}${text.slice(node.end)}`;
    }
  }
  if (equal(jsonGet(text, path), value)) return text;
  return `${text.slice(0, node.start)}${serialize(value, unit, lineIndent(text, node.start))}${text.slice(node.end)}`;
}

function arrayAt(text: string, path: Path): JsonNode & { kind: 'array' } {
  const node = find(text, path);
  if (node?.kind !== 'array') throw new Error(`no array at ${path.join('.')}`);
  return node;
}

export function jsonArrayAppend(text: string, path: Path, value: unknown): string {
  const unit = indentUnit(text);
  const array = arrayAt(text, path);
  return insertItem(text, array, array.elements.at(-1)?.end, array.elements[0]?.start, (indent) => serialize(value, unit, indent));
}

export function jsonArrayReplace(text: string, path: Path, index: number, value: unknown): string {
  const element = arrayAt(text, path).elements[index];
  if (element === undefined) throw new Error(`no element ${index} at ${path.join('.')}`);
  return `${text.slice(0, element.start)}${serialize(value, indentUnit(text), lineIndent(text, element.start))}${text.slice(element.end)}`;
}

/** Removes the line around `at` when only whitespace is left on it. */
function dropBlankLine(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  const lineEnd = newline === -1 ? text.length : newline;
  return lineStart > 0 && text.slice(lineStart, lineEnd).trim() === '' ? `${text.slice(0, lineStart - 1)}${text.slice(lineEnd)}` : text;
}

/**
 * Removes the element and the comma that separates it (the one after it, or before it for the last element), and its
 * line when nothing else is left on it. Comments stay, also those next to the element.
 */
export function jsonArrayRemove(text: string, path: Path, index: number): string {
  const { elements, start, end } = arrayAt(text, path);
  const element = elements[index];
  if (element === undefined) throw new Error(`no element ${index} at ${path.join('.')}`);
  const blank = (from: number, to: number) => text.slice(from, to).trim() === '';
  if (elements.length === 1 && `${text.slice(start + 1, element.start)}${text.slice(element.end, end - 1)}`.replaceAll(',', '').trim() === '') {
    return `${text.slice(0, start + 1)}${text.slice(end - 1)}`;
  }
  const after = nextSignificant(text, element.end);
  if (text[after] === ',') {
    if (!blank(element.end, after)) return dropBlankLine(`${text.slice(0, element.start)}${text.slice(element.end, after)}${text.slice(after + 1)}`, element.start);
    // The element, its comma and the spaces after the comma on the same line.
    let stop = after + 1;
    while (text[stop] === ' ' || text[stop] === '\t') stop += 1;
    return dropBlankLine(`${text.slice(0, element.start)}${text.slice(stop)}`, element.start);
  }
  const previous = elements[index - 1];
  const comma = previous === undefined ? undefined : nextSignificant(text, previous.end);
  if (previous === undefined || comma === undefined || text[comma] !== ',') return dropBlankLine(`${text.slice(0, element.start)}${text.slice(element.end)}`, element.start);
  if (blank(previous.end, comma) && blank(comma + 1, element.start)) {
    // The last element, with the comma before it and everything between them.
    return `${text.slice(0, comma)}${text.slice(element.end)}`;
  }
  // A comment between them stays: remove the comma and the element on their own.
  const removed = `${text.slice(0, comma)}${text.slice(comma + 1, element.start)}${text.slice(element.end)}`;
  return dropBlankLine(removed, element.start - 1);
}
