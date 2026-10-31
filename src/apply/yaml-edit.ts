// Edits YAML text with minimal changes: the parser (yaml) locates nodes, and only the changed value or the new
// key is written, so comments, quoting and spacing elsewhere stay byte for byte. Keys depcurfew sets get a
// "# managed by depcurfew" comment on the line above. The result is parsed again and has to hold exactly the old
// data with the one value set; otherwise the edit is refused. For tools whose loader applies YAML merge keys (<<),
// the data includes merged keys, and a key set where a merged one stands is written into the map itself, which wins.
import { isMap, isScalar, isSeq, LineCounter, stringify, type Node, type Pair } from 'yaml';
import { mergedPair, ownPair, parseYamlDocument, type YamlOptions } from '../yaml-parse.ts';
import { sameData, withValue, withValues } from './expected.ts';

type Path = readonly (string | number)[];

export const YAML_MARKER = '# managed by depcurfew';

interface Parsed {
  text: string;
  merge: boolean;
  document: ReturnType<typeof parseYamlDocument>;
  lineCounter: LineCounter;
  /** The plain data, computed once; only compared and copied, never handed out or changed. */
  data?: unknown;
}

/**
 * The last texts parsed. Every edit parses the text before it (to find the node and to compare the data) and the
 * text after it (to check the result), and the text after one edit is the text before the next: each is parsed once,
 * so a file with hundreds of edits (a dependabot.yml with an entry per directory) is not parsed four times per edit.
 * Documents are only read, never changed.
 */
const recent: Parsed[] = [];

function parse(text: string, merge = false): Parsed {
  let parsed = recent.find((entry) => entry.text === text && entry.merge === merge);
  if (parsed === undefined) {
    const lineCounter = new LineCounter();
    parsed = { text, merge, document: parseYamlDocument(text, lineCounter, { merge }), lineCounter };
    recent.unshift(parsed);
    recent.length = Math.min(recent.length, 2);
  }
  if (parsed.document.errors.length > 0) throw new Error(parsed.document.errors[0]?.message.split('\n', 1)[0] ?? 'invalid YAML');
  return parsed;
}

/** The data of a text, for comparing before and after an edit. */
function dataOf(text: string, merge = false): unknown {
  const parsed = parse(text, merge);
  if (!('data' in parsed)) parsed.data = parsed.document.toJS() as unknown;
  return parsed.data;
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
  let unit = 0;
  for (const match of text.matchAll(/\n( +)\S/gu)) {
    const size = match[1]?.length ?? 0;
    if (size > 0 && (unit === 0 || size < unit)) unit = size;
  }
  return unit === 0 ? 2 : unit;
}

/** The style of the last text rendered for: edits of one file in a batch all render for the same text. */
let lastStyle: { text: string; indent: number; indentSeq: boolean } | undefined;

function render(value: unknown, text: string): string {
  if (lastStyle?.text !== text) lastStyle = { text, indent: indentUnit(text), indentSeq: indentsSequences(text) };
  return stringify(value, { indent: lastStyle.indent, indentSeq: lastStyle.indentSeq, lineWidth: 0 });
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

/**
 * Adds the marker line above the key at `keyStart`, unless it is already there or the key shares a line with "- ".
 * `original` is the same text up to the key (before the value after it changed); positions are looked up there, so
 * that the edited text is not copied once more for each edit.
 */
function mark(text: string, keyStart: number, original = text): string {
  const start = lineStart(original, keyStart);
  const indent = original.slice(start, keyStart);
  if (!/^[ \t]*$/u.test(indent) || marked(original, keyStart)) return text;
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

export function yamlGet(text: string, path: Path, options: YamlOptions = {}): unknown {
  const value: unknown = dataOf(text, options.merge === true);
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
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
function pathLine(text: string, path: Path, merge: boolean): number | undefined {
  const { document, lineCounter } = parse(text, merge);
  let node = document.contents as Node | null;
  let line: number | undefined;
  for (const segment of path) {
    if (node === null) break;
    if (typeof segment === 'number') {
      node = isSeq(node) ? ((node.items[segment] as Node | undefined) ?? null) : null;
      continue;
    }
    const pair = ownPair(node, segment) ?? (merge ? mergedPair(document, node, segment)?.pair : undefined);
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
export function yamlSet(text: string, path: Path, value: unknown, options: YamlOptions = {}): string {
  const merge = options.merge === true;
  const before = dataOf(text, merge);
  const edited = setValue(text, path, value, merge);
  if (edited === text) return text;
  const setting = () => {
    const line = pathLine(text, path, merge);
    return `${path.join('.')}${line === undefined ? '' : ` (line ${line})`}`;
  };
  const byHand = `set ${path.join('.')} to ${JSON.stringify(value)} by hand`;
  let after: unknown;
  try {
    after = dataOf(edited, merge);
  } catch (error) {
    throw new Error(`setting ${setting()} would leave invalid YAML (${error instanceof Error ? error.message : String(error)}), so depcurfew did not edit it; ${byHand}`);
  }
  if (!sameData(after, withValue(before, path, value))) {
    throw new Error(`setting ${setting()} would change other settings in the file, so depcurfew did not edit it; ${byHand}`);
  }
  return edited;
}

/** The keys of a path and of every path above it, from the shortest: one key per level. */
function pathKeys(path: Path): string[] {
  return path.map((_, index) => JSON.stringify(path.slice(0, index + 1).map(String)));
}

/** Where `edited` differs from `text`: one stretch [start, end) of `text`, replaced by `replacement`. */
function changedStretch(text: string, edited: string): { start: number; end: number; replacement: string } {
  const CHUNK = 4096;
  const limit = Math.min(text.length, edited.length);
  let start = 0;
  while (start + CHUNK <= limit && text.slice(start, start + CHUNK) === edited.slice(start, start + CHUNK)) start += CHUNK;
  while (start < limit && text.charCodeAt(start) === edited.charCodeAt(start)) start += 1;
  let suffix = 0;
  const room = limit - start;
  while (suffix + CHUNK <= room && text.slice(text.length - suffix - CHUNK, text.length - suffix) === edited.slice(edited.length - suffix - CHUNK, edited.length - suffix)) suffix += CHUNK;
  while (suffix < room && text.charCodeAt(text.length - suffix - 1) === edited.charCodeAt(edited.length - suffix - 1)) suffix += 1;
  // A copy, not a slice: a slice keeps the whole edited text in memory as long as the replacement is kept.
  return { start, end: text.length - suffix, replacement: Buffer.from(edited.slice(start, edited.length - suffix), 'utf8').toString('utf8') };
}

interface Pending {
  path: Path;
  value: unknown;
  start: number;
  end: number;
  replacement: string;
}

/**
 * Sets several values, with the same result and the same checks as yamlSet one after another, in time that grows with
 * the size of the file rather than with the size times the number of edits. Edits of separate parts of the file (the
 * cooldown of each dependabot.yml entry) are all made on the text as it was, and their result is parsed and checked
 * once: it must hold the old data with exactly these values set. An edit that touches the stretch of another, or a
 * path inside another, first applies the edits before it. When the check fails, the edits are made one by one with
 * yamlSet, which gives the same result or the same error as without batching.
 */
export function yamlSetMany(text: string, edits: readonly (readonly [Path, unknown])[], options: YamlOptions = {}): string {
  const merge = options.merge === true;
  let base = text;
  // In the order of the edits, and by position (for the overlap check); the paths of the edits and of their parents.
  let pending: Pending[] = [];
  let byStart: Pending[] = [];
  let paths = new Set<string>();
  let parents = new Set<string>();
  const related = (path: Path): boolean => {
    const keys = pathKeys(path);
    return keys.some((key) => paths.has(key)) || parents.has(keys.at(-1) ?? '');
  };
  // The first pending edit that starts after `position`.
  const after = (position: number): number => {
    let low = 0;
    let high = byStart.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((byStart[middle]?.start ?? 0) <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const overlaps = (start: number, end: number): boolean => {
    const next = after(end);
    // Stretches do not overlap one another, so only the last one starting at or before `end` can reach `start`.
    const previous = byStart[next - 1];
    return previous !== undefined && previous.end >= start;
  };
  const add = (edit: Pending) => {
    pending.push(edit);
    byStart.splice(after(edit.start), 0, edit);
    const keys = pathKeys(edit.path);
    paths.add(keys.at(-1) ?? '');
    for (const key of keys.slice(0, -1)) parents.add(key);
  };
  const flush = () => {
    if (pending.length === 0) return;
    const parts: string[] = [];
    let at = 0;
    for (const edit of byStart) {
      parts.push(base.slice(at, edit.start), edit.replacement);
      at = edit.end;
    }
    parts.push(base.slice(at));
    const edited = parts.join('');
    const expected = withValues(dataOf(base, merge), pending);
    let same = false;
    try {
      same = sameData(dataOf(edited, merge), expected);
    } catch {
      same = false;
    }
    if (same) {
      base = edited;
    } else {
      for (const edit of pending) base = yamlSet(base, edit.path, edit.value, options);
    }
    pending = [];
    byStart = [];
    paths = new Set();
    parents = new Set();
  };
  for (const [path, value] of edits) {
    if (related(path)) flush();
    let edited: string;
    try {
      edited = setValue(base, path, value, merge);
    } catch {
      // Raise the error as yamlSet raises it, on the text with the edits before this one.
      flush();
      base = yamlSet(base, path, value, options);
      continue;
    }
    if (edited === base) continue;
    let stretch = changedStretch(base, edited);
    if (overlaps(stretch.start, stretch.end)) {
      flush();
      edited = setValue(base, path, value, merge);
      if (edited === base) continue;
      stretch = changedStretch(base, edited);
    }
    add({ path, value, ...stretch });
  }
  flush();
  return base;
}

function setValue(text: string, path: Path, value: unknown, merge = false): string {
  const { document, lineCounter } = parse(text, merge);
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
    const pair = ownPair(node, segment);
    const merged = pair === undefined && merge ? mergedPair(document, node, segment) : undefined;
    if (merged !== undefined) {
      // A key the map gets through a merge key: a value written into the map itself wins over it. Below such a key the
      // map comes from elsewhere, and writing one key into the map here would drop the other merged keys.
      if (index === path.length - 1) {
        const current = merged.pair.value === null ? null : (merged.pair.value.toJS(document) as unknown);
        if (equal(current, value)) return text;
      } else {
        const mergeLine = lineCounter.linePos((merged.merge.key as Node).range?.[0] ?? 0).line;
        throw new Error(
          `${path.slice(0, index + 1).join('.')} comes from the YAML merge key << (line ${mergeLine}), and depcurfew does not write into a merged map; write ${segment} into this map itself, or set ${path.join('.')} to ${JSON.stringify(value)} by hand`,
        );
      }
    }
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
      const current = pair.value === null ? null : ((merge ? pair.value.toJS(document) : pair.value.toJSON()) as unknown);
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
      return insideMarked ? replaced : mark(replaced, keyRange[0], text);
    }
    if (pair.value === null || !(isMap(pair.value) || isSeq(pair.value))) {
      if (isFlow(node)) refuseFlow(path, index, value);
      // A scalar stands where a map is needed: replace it with the nested map.
      return setValue(text, path.slice(0, index + 1), nest(path.slice(index + 1), value), merge);
    }
    if (pair.key.range !== null && pair.key.range !== undefined && marked(text, pair.key.range[0])) insideMarked = true;
    node = pair.value;
  }
  return text;
}
