// Edits YAML text with minimal changes: the parser (yaml) locates nodes, and only the changed value or the new
// key is written, so comments, quoting and spacing elsewhere stay byte for byte. Keys depgate sets get a
// "# managed by depgate" comment on the line above.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Node, type Pair } from 'yaml';

type Path = readonly (string | number)[];

export const YAML_MARKER = '# managed by depgate';

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

/** Adds the marker line above the key at `keyStart`, unless it is already there or the key shares a line with "- ". */
function mark(text: string, keyStart: number): string {
  const start = lineStart(text, keyStart);
  const indent = text.slice(start, keyStart);
  if (!/^[ \t]*$/u.test(indent)) return text;
  const previousStart = lineStart(text, start - 1);
  if (start > 0 && text.slice(previousStart, start - 1).trim() === YAML_MARKER) return text;
  return `${text.slice(0, start)}${indent}${YAML_MARKER}\n${text.slice(start)}`;
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
    `${where} is written in flow style ({ ... } or [ ... ]), which depgate does not edit; rewrite it in block style, or set ${path.join('.')} to ${JSON.stringify(value)} by hand`,
  );
}

/** Sets the value at `path`, creating missing maps on the way, and marks the key that was written. */
export function yamlSet(text: string, path: Path, value: unknown): string {
  const { document, lineCounter } = parse(text);
  const column = (offset: number) => lineCounter.linePos(offset).col - 1;

  if (document.contents === null || (isScalar(document.contents) && document.contents.value === null)) {
    const prefix = text.trim() === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${YAML_MARKER}\n${render(nest(path, value), text)}`;
  }
  let node = document.contents as Node;
  if (!isMap(node)) throw new Error('the YAML document is not a map');

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
      // Append a new key at the end of this map, at the indentation of its first key.
      const first = node.items[0] as Pair<Node, Node | null> | undefined;
      const indent = first === undefined || first.key.range === null || first.key.range === undefined ? '' : ' '.repeat(column(first.key.range[0]));
      const range = node.range ?? [text.length, text.length, text.length];
      let insertAt = range[2];
      const prefix = insertAt > 0 && text[insertAt - 1] !== '\n' ? '\n' : '';
      const addition = indentLines(`${YAML_MARKER}\n${render({ [segment]: nest(path.slice(index + 1), value) }, text)}`, indent);
      return `${text.slice(0, insertAt)}${prefix}${addition}${text.slice(insertAt)}`;
    }
    if (index === path.length - 1) {
      const current = pair.value === null ? null : (pair.value.toJSON() as unknown);
      if (equal(current, value)) return text;
      const keyRange = pair.key.range as [number, number, number];
      const valueNode = pair.value;
      let replaced: string;
      if (valueNode !== null && isScalar(valueNode) && (value === null || typeof value !== 'object')) {
        const [start, end] = valueNode.range as [number, number, number];
        replaced = `${text.slice(0, start)}${render(value, text).trimEnd()}${text.slice(end)}`;
      } else {
        if (isFlow(node)) refuseFlow(path, index, value);
        const colon = text.indexOf(':', keyRange[1]);
        const end = valueNode === null ? text.indexOf('\n', colon) : (valueNode.range as [number, number, number])[2];
        const stop = end === -1 ? text.length : end;
        const keyIndent = column(keyRange[0]);
        const seq = Array.isArray(value);
        const blockIndent = ' '.repeat(seq && !indentsSequences(text) ? keyIndent : keyIndent + indentUnit(text));
        const body =
          value !== null && typeof value === 'object' && Object.keys(value).length > 0
            ? `\n${indentLines(render(value, text), blockIndent)}`
            : ` ${render(value, text).trimEnd()}\n`;
        const tail = text.slice(stop);
        replaced = `${text.slice(0, colon + 1)}${body}${tail.startsWith('\n') && body.endsWith('\n') ? tail.slice(1) : tail}`;
      }
      return mark(replaced, keyRange[0]);
    }
    if (pair.value === null || !(isMap(pair.value) || isSeq(pair.value))) {
      if (isFlow(node)) refuseFlow(path, index, value);
      // A scalar stands where a map is needed: replace it with the nested map.
      return yamlSet(text, path.slice(0, index + 1), nest(path.slice(index + 1), value));
    }
    node = pair.value;
  }
  return text;
}
