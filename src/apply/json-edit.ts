// Edits JSON and JSONC text in place: values are replaced or inserted, and everything else (indentation, comments,
// trailing commas, key order) stays as it is. New values are written with the file's indentation.
import { parseJsonc } from '../detect/jsonc.ts';

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
    return `${text.slice(0, container.start + 1)}\n${indent}${entry(indent)}\n${containerIndent}${text.slice(container.end - 1)}`;
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

export function jsonArrayRemove(text: string, path: Path, index: number): string {
  const { elements, start, end } = arrayAt(text, path);
  const element = elements[index];
  if (element === undefined) throw new Error(`no element ${index} at ${path.join('.')}`);
  const previous = elements[index - 1];
  const next = elements[index + 1];
  if (previous !== undefined) return `${text.slice(0, previous.end)}${text.slice(element.end)}`;
  if (next !== undefined) return `${text.slice(0, element.start)}${text.slice(next.start)}`;
  return `${text.slice(0, start + 1)}${text.slice(end - 1)}`;
}
