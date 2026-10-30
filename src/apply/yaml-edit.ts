// Edits YAML text with minimal changes: the parser (yaml) locates nodes, and only the changed value or the new
// key is written, so comments, quoting and spacing elsewhere stay byte for byte. Keys depcurfew sets get a
// "# managed by depcurfew" comment on the line above. The result is parsed again and has to hold exactly the old
// data with the one value set; otherwise the edit is refused.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Node, type Pair } from 'yaml';
import { sameData, withValue } from './expected.ts';

type Path = readonly (string | number)[];

export const YAML_MARKER = '# managed by depcurfew';

function parse(text: string) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message.split('\n', 1)[0] ?? 'invalid YAML');
  return { document, lineCounter };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf('\n', position - 1) + 1;
}

/** The line break that ends the line of `position`, or the end of the text. */
function lineEnd(text: string, position: number): number {
  const newline = text.indexOf('\n', position);
  return newline === -1 ? text.length : newline;
}

/**
 * Where the content of a node ends: the end of its last scalar, alias or flow collection. The yaml library counts
 * the comments after a block collection, and the indentation of the next line, as part of it; an edit that ended
 * there would take that indentation away from the next line.
 */
function contentEnd(node: Node): number {
  if ((isMap(node) || isSeq(node)) && !isFlow(node)) {
    const last = node.items.at(-1) as Pair<Node, Node | null> | Node | undefined;
    const child = last === undefined ? undefined : isMap(node) ? ((last as Pair<Node, Node | null>).value ?? (last as Pair<Node, Node | null>).key) : (last as Node);
    if (child?.range !== undefined && child.range !== null) return contentEnd(child);
  }
  return (node.range as [number, number, number])[1];
}

/** The line break after the content of a node (after a comment on its last line), or the end of the text. */
function contentLineEnd(text: string, node: Node): number {
  const end = contentEnd(node);
  // A block scalar (| or >) ends with its own line break.
  return end > 0 && text[end - 1] === '\n' ? end - 1 : lineEnd(text, end);
}

/**
 * After the line break at `end`, the comment lines indented deeper than `indent` (and blank lines between them)
 * still belong to the last value, such as a commented-out list item; returns the line break after the last of them.
 */
function nestedCommentsEnd(text: string, end: number, indent: number): number {
  let result = end;
  let position = end;
  while (position < text.length) {
    const stop = lineEnd(text, position + 1);
    const line = text.slice(position + 1, stop);
    const trimmed = line.trimStart();
    if (trimmed !== '') {
      if (!trimmed.startsWith('#') || line.length - trimmed.length <= indent) break;
      result = stop;
    }
    position = stop;
  }
  return result;
}

/** Whether block sequences in the document are indented under their key (the yaml default) or not. */
function indentsSequences(text: string): boolean {
  const match = /^([ \t]*)[^\s#-][^\n]*:[ \t]*(?:#[^\n]*)?\n([ \t]*)- /mu.exec(text);
  return match === null ? true : (match[2]?.length ?? 0) > (match[1]?.length ?? 0);
}

function indentUnit(text: string): number {
  const sizes = [...text.matchAll(/\n( +)\S/gu)].map((match) => match[1]?.length ?? 0).filter((size) => size > 0);
  return sizes.length === 0 ? 2 : Math.min(...sizes);
}

function render(value: unknown, text: string): string {
  return stringify(value, { indent: indentUnit(text), indentSeq: indentsSequences(text), lineWidth: 0 });
}

function indentLines(block: string, indent: string): string {
  return block
    .split('\n')
    .map((line) => (line === '' ? line : `${indent}${line}`))
    .join('\n');
}

function nest(path: Path, value: unknown): unknown {
  return path.reduceRight<unknown>((inner, segment) => ({ [String(segment)]: inner }), value);
}

/** Whether the line above the key at `keyStart` is the marker. */
function marked(text: string, keyStart: number): boolean {
  const start = lineStart(text, keyStart);
  return start > 0 && text.slice(lineStart(text, start - 1), start - 1).trim() === YAML_MARKER;
}

/** Adds the marker line above the key at `keyStart`, unless it is already there or the key shares a line with "- ". */
function mark(text: string, keyStart: number): string {
  const start = lineStart(text, keyStart);
  const indent = text.slice(start, keyStart);
  if (!/^[ \t]*$/u.test(indent) || marked(text, keyStart)) return text;
  return `${text.slice(0, start)}${indent}${YAML_MARKER}\n${text.slice(start)}`;
}

/**
 * Replaces the value of the key at `keyRange` with a block value or an inline one ([], {} or a scalar). The old value
 * ends with its last line of content: comments after it and the next line stay as they are, and so do a comment on
 * the key's line and comments before the first item of a block collection.
 */
function replaceValue(text: string, keyRange: readonly number[], valueNode: Node | null, value: unknown, keyIndent: number): string {
  const colon = text.indexOf(':', keyRange[1]);
  const keyLineEnd = lineEnd(text, colon);
  const block = value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  const blockIndent = ' '.repeat(Array.isArray(value) && !indentsSequences(text) ? keyIndent : keyIndent + indentUnit(text));
  const rendered = block ? indentLines(render(value, text), blockIndent).replace(/\n$/u, '') : render(value, text).trimEnd();
  const valueStart = valueNode === null ? colon + 1 : (valueNode.range as [number, number, number])[0];
  if (valueNode === null || valueStart <= keyLineEnd) {
    // The old value starts on the key's line: a flow collection, a scalar or nothing.
    let end = valueNode === null ? colon + 1 : contentEnd(valueNode);
    if (end > 0 && text[end - 1] === '\n') end -= 1;
    const rest = text.slice(end);
    if (!block) {
      const space = /\s$/u.test(text.slice(0, valueStart)) ? '' : ' ';
      return `${text.slice(0, valueStart)}${space}${rendered}${rest.startsWith('#') ? ' ' : ''}${rest}`;
    }
    const restOfLine = text.slice(end, lineEnd(text, end));
    return `${text.slice(0, valueStart).trimEnd()}${restOfLine.startsWith('#') ? ' ' : ''}${restOfLine}\n${rendered}${text.slice(lineEnd(text, end))}`;
  }
  // A block collection on the lines below the key.
  const start = lineStart(text, valueStart) - 1;
  const end = contentLineEnd(text, valueNode);
  if (block) return `${text.slice(0, start)}\n${rendered}${text.slice(end)}`;
  return `${text.slice(0, colon + 1)} ${rendered}${text.slice(colon + 1, start)}${text.slice(end)}`;
}

export function yamlGet(text: string, path: Path): unknown {
  const value: unknown = parse(text).document.toJS();
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

function findPair(node: Node, key: string): Pair<Node, Node | null> | undefined {
  if (!isMap(node)) return undefined;
  return (node.items as Pair<Node, Node | null>[]).filter((pair) => isScalar(pair.key) && String(pair.key.value) === key).at(-1);
}

/** Whether a map or sequence is written in flow style ({ ... } or [ ... ]). */
function isFlow(node: Node): boolean {
  return (isMap(node) || isSeq(node)) && node.flow === true;
}

/**
 * New keys and block values cannot be written into a flow collection without rewriting it, which would not keep the
 * file as it is; the user rewrites it or sets the value by hand. Scalars inside it are still replaced in place.
 */
function refuseFlow(path: Path, index: number, value: unknown): never {
  const where = index === 0 ? 'the document' : path.slice(0, index).join('.');
  throw new Error(
    `${where} is written in flow style ({ ... } or [ ... ]), which depcurfew does not edit; rewrite it in block style, or set ${path.join('.')} to ${JSON.stringify(value)} by hand`,
  );
}

/** The 1-based line of the deepest key of `path` that exists in the document, if any. */
function pathLine(text: string, path: Path): number | undefined {
  const { document, lineCounter } = parse(text);
  let node = document.contents as Node | null;
  let line: number | undefined;
  for (const segment of path) {
    if (node === null) break;
    if (typeof segment === 'number') {
      node = isSeq(node) ? ((node.items[segment] as Node | undefined) ?? null) : null;
      continue;
    }
    const pair = findPair(node, segment);
    if (pair === undefined) break;
    if (pair.key.range !== null && pair.key.range !== undefined) line = lineCounter.linePos(pair.key.range[0]).line;
    node = pair.value;
  }
  return line;
}

/**
 * Sets the value at `path`, creating missing maps on the way, and marks the key that was written. The result must
 * parse and hold the same data as before apart from that value; otherwise nothing is changed and an error says so.
 */
export function yamlSet(text: string, path: Path, value: unknown): string {
  const before = parse(text).document.toJS() as unknown;
  const edited = setValue(text, path, value);
  if (edited === text) return text;
  const line = pathLine(text, path);
  const setting = `${path.join('.')}${line === undefined ? '' : ` (line ${line})`}`;
  const byHand = `set ${path.join('.')} to ${JSON.stringify(value)} by hand`;
  let after: unknown;
  try {
    after = parse(edited).document.toJS() as unknown;
  } catch (error) {
    throw new Error(`setting ${setting} would leave invalid YAML (${error instanceof Error ? error.message : String(error)}), so depcurfew did not edit it; ${byHand}`);
  }
  if (!sameData(after, withValue(before, path, value))) {
    throw new Error(`setting ${setting} would change other settings in the file, so depcurfew did not edit it; ${byHand}`);
  }
  return edited;
}

function setValue(text: string, path: Path, value: unknown): string {
  const { document, lineCounter } = parse(text);
  const column = (offset: number) => lineCounter.linePos(offset).col - 1;

  if (document.contents === null || (isScalar(document.contents) && document.contents.value === null)) {
    const prefix = text.trim() === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${YAML_MARKER}\n${render(nest(path, value), text)}`;
  }
  let node = document.contents as Node;
  if (!isMap(node)) throw new Error('the YAML document is not a map');

  // A key inside a map that already carries the marker is managed with it and gets no marker of its own.
  let insideMarked = false;
  for (const [index, segment] of path.entries()) {
    if (typeof segment === 'number') {
      if (!isSeq(node) || node.items[segment] === undefined) throw new Error(`no item ${segment} at ${path.slice(0, index).join('.')}`);
      node = node.items[segment] as Node;
      continue;
    }
    if (!isMap(node)) throw new Error(`${path.slice(0, index).join('.')} is not a map`);
    const pair = findPair(node, segment);
    if (pair === undefined) {
      if (isFlow(node)) refuseFlow(path, index, value);
      // Append a new key after the last line of this map, at the indentation of its first key. Comments after
      // that line stay where they are, except those indented under the last value, which belong to it.
      const first = node.items[0] as Pair<Node, Node | null> | undefined;
      const keyColumn = first === undefined || first.key.range === null || first.key.range === undefined ? 0 : column(first.key.range[0]);
      const at = nestedCommentsEnd(text, contentLineEnd(text, node), keyColumn);
      const addition = indentLines(`${insideMarked ? '' : `${YAML_MARKER}\n`}${render({ [segment]: nest(path.slice(index + 1), value) }, text)}`, ' '.repeat(keyColumn));
      return at >= text.length ? `${text}\n${addition}` : `${text.slice(0, at + 1)}${addition}${text.slice(at + 1)}`;
    }
    if (index === path.length - 1) {
      const current = pair.value === null ? null : (pair.value.toJSON() as unknown);
      if (equal(current, value)) return text;
      const keyRange = pair.key.range as [number, number, number];
      const valueNode = pair.value;
      let replaced: string;
      if (valueNode !== null && isScalar(valueNode) && (value === null || typeof value !== 'object')) {
        const [start, end] = valueNode.range as [number, number, number];
        // A key without a value has an empty node right after the colon or at its comment: keep them apart.
        const before = start > 0 && !/\s/u.test(text[start - 1] as string) ? ' ' : '';
        const after = text[end] === '#' ? ' ' : '';
        replaced = `${text.slice(0, start)}${before}${render(value, text).trimEnd()}${after}${text.slice(end)}`;
      } else {
        if (isFlow(node)) refuseFlow(path, index, value);
        replaced = replaceValue(text, keyRange, valueNode, value, column(keyRange[0]));
      }
      return insideMarked ? replaced : mark(replaced, keyRange[0]);
    }
    if (pair.value === null || !(isMap(pair.value) || isSeq(pair.value))) {
      if (isFlow(node)) refuseFlow(path, index, value);
      // A scalar stands where a map is needed: replace it with the nested map.
      return setValue(text, path.slice(0, index + 1), nest(path.slice(index + 1), value));
    }
    if (pair.key.range !== null && pair.key.range !== undefined && marked(text, pair.key.range[0])) insideMarked = true;
    node = pair.value;
  }
  return text;
}
