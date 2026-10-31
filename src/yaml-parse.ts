// YAML parsing for the files depcurfew reads from a repository. The yaml package checks duplicate keys by comparing
// each key with every earlier key of its map, which is quadratic: a 0.5 MiB map takes half a minute, a 3 MB
// pnpm-lock.yaml 19 s and a 14 MB one six minutes. Files are parsed without that check, and the same check runs here
// with a Set, so a duplicate key is still an error of the document, with the line and column of the second key.
// YAML merge keys (<<) are read only for files of tools whose loader applies them (extra.yamlMergeKeys).
import { isAlias, isMap, isScalar, isSeq, Lexer, LineCounter, parseAllDocuments, parseDocument, YAMLParseError, type Document, type Node, type Pair } from 'yaml';

export interface YamlOptions {
  /**
   * Apply merge keys (<<: *defaults) as YAML 1.1 does: the keys of the merged maps join the map unless it has them
   * itself, and earlier maps win over later ones. Without it, << is an ordinary key, as for Yarn.
   */
  merge?: boolean;
}

/** Whether a pair is a merge key (<<) of a document parsed with `merge`: the yaml package gives it a symbol. */
export function isMergePair(pair: Pair): boolean {
  return isScalar(pair.key) && typeof pair.key.value === 'symbol' && pair.key.value.description === '<<';
}

/** The maps a merge key brings in, in the order they count (an alias resolved to its node); undefined when one is not a map. */
export function mergeSources(document: Document.Parsed, pair: Pair): Node[] | undefined {
  const resolve = (node: unknown): unknown => (isAlias(node) ? node.resolve(document) : node);
  const value = resolve(pair.value);
  const items = isSeq(value) ? value.items.map(resolve) : [value];
  return items.every((item) => isMap(item)) ? (items as Node[]) : undefined;
}

/** The pair of a map with this key written in the map itself (the last one), not through a merge key. */
export function ownPair(node: Node, key: string): Pair<Node, Node | null> | undefined {
  if (!isMap(node)) return undefined;
  return (node.items as Pair<Node, Node | null>[]).filter((pair) => isScalar(pair.key) && !isMergePair(pair) && String(pair.key.value) === key).at(-1);
}

/**
 * The pair a merge key (<<) of the map brings in for `key` when the map does not have it itself, and that merge key:
 * from the first map that has it, earlier maps first, also through the merge keys of those maps. Only documents
 * parsed with `merge` have merge keys.
 */
export function mergedPair(document: Document.Parsed, node: Node, key: string, seen = new Set<Node>()): { pair: Pair<Node, Node | null>; merge: Pair } | undefined {
  if (!isMap(node) || seen.has(node)) return undefined;
  seen.add(node);
  for (const merge of node.items.filter((item) => isMergePair(item))) {
    for (const source of mergeSources(document, merge) ?? []) {
      const pair = ownPair(source, key) ?? mergedPair(document, source, key, seen)?.pair;
      if (pair !== undefined) return { pair, merge };
    }
  }
  return undefined;
}

/**
 * The yaml package builds nested collections by recursion, so a file nested a few hundred levels deep exhausts the
 * stack (about 800 levels in a plain Node.js process, fewer inside doctor), and at 100 000 levels Node.js can end the
 * process with a fatal error instead of an exception. Configuration and lockfiles are nested a dozen levels at most.
 */
export const MAX_YAML_DEPTH = 256;

/** Tokens the lexer adds that are not in the text: document start, scalar start and flow end. */
const CONTROL = new Set(['\u0002', '\u001f', '\u0018']);

/**
 * The position where collections are nested deeper than MAX_YAML_DEPTH, found with the lexer of the yaml package
 * (which reads quotes, comments and block scalars as the parser does, without recursion): flow collections, block
 * collections by their indentation, and compact items such as "- - -" on one line. undefined when the text is fine.
 */
function tooDeep(text: string): number | undefined {
  let offset = 0;
  let flow = 0;
  let compact = 0;
  let lineStart = true;
  let indent = 0;
  let indents: number[] = [];
  for (const token of new Lexer().lex(text)) {
    const start = offset;
    if (CONTROL.has(token)) continue;
    offset += token.length;
    if (/^(?:\r?\n)+$/u.test(token)) {
      lineStart = true;
      indent = 0;
      compact = 0;
      continue;
    }
    if (lineStart && /^[ \t]+$/u.test(token)) {
      indent = token.length;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      if (token === '---' || token === '...') {
        indents = [];
        flow = 0;
      } else if (flow === 0 && !token.startsWith('#')) {
        while (indents.length > 0 && (indents.at(-1) ?? 0) >= indent) indents.pop();
        indents.push(indent);
      }
    }
    if (token === '[' || token === '{') flow += 1;
    else if (token === ']' || token === '}') flow = Math.max(0, flow - 1);
    else if ((token === '-' || token === '?') && flow === 0) compact += 1;
    if (flow + indents.length + compact > MAX_YAML_DEPTH) return start;
  }
  return undefined;
}

/** A document that was not parsed because it is nested too deep, with the error that says so. */
function tooDeepDocument(text: string, offset: number): Document.Parsed {
  const document = parseDocument('', { lineCounter: new LineCounter() });
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1;
    lineStart = index + 1;
  }
  const col = offset - lineStart + 1;
  const error = new YAMLParseError([offset, offset + 1], 'BAD_INDENT', `collections are nested more than ${MAX_YAML_DEPTH} levels deep at line ${line}, column ${col}, deeper than depcurfew parses`);
  error.linePos = [{ line, col }];
  document.errors.push(error);
  return document;
}

/** The second occurrence of a key in a map (keys compared as the yaml package does: scalar values with ===). */
function duplicateKey(document: Document.Parsed, lineCounter: LineCounter): YAMLParseError | undefined {
  const stack: unknown[] = [document.contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      const keys = new Set<unknown>();
      for (const pair of node.items) {
        if (isScalar(pair.key)) {
          if (keys.has(pair.key.value)) {
            const [start = 0, end = start] = pair.key.range ?? [];
            const { line, col } = lineCounter.linePos(start);
            const error = new YAMLParseError([start, end], 'DUPLICATE_KEY', `Map keys must be unique at line ${line}, column ${col}`);
            error.linePos = [{ line, col }];
            return error;
          }
          keys.add(pair.key.value);
        }
        stack.push(pair.key, pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
  return undefined;
}

/** An error at the key of a pair. */
function pairError(pair: Pair, lineCounter: LineCounter, code: 'BAD_ALIAS', message: (line: number, col: number) => string): YAMLParseError {
  const [start = 0, end = start] = (isScalar(pair.key) ? pair.key.range : undefined) ?? [];
  const { line, col } = lineCounter.linePos(start);
  const error = new YAMLParseError([start, end], code, message(line, col));
  error.linePos = [{ line, col }];
  return error;
}

/**
 * With merge keys: a merge key whose value is not a map, an alias of one or a list of them, which the tools' loaders
 * reject (js-yaml: "cannot merge mappings"), or a document that cannot be converted at all (an alias without its
 * anchor, aliases that expand without end), as an error of the document instead of an exception later.
 */
function mergeProblem(document: Document.Parsed, lineCounter: LineCounter): YAMLParseError | undefined {
  const stack: unknown[] = [document.contents];
  let first: Pair | undefined;
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isMergePair(pair)) {
          first ??= pair;
          if (mergeSources(document, pair) === undefined) {
            return pairError(pair, lineCounter, 'BAD_ALIAS', (line, col) => `the merge key << at line ${line}, column ${col} must refer to a map or a list of maps`);
          }
        }
        stack.push(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
  if (first === undefined) return undefined;
  try {
    document.toJS({ maxAliasCount: 100 });
  } catch (thrown) {
    const reason = (thrown instanceof Error ? thrown.message : String(thrown)).split('\n', 1)[0] ?? '';
    return pairError(first, lineCounter, 'BAD_ALIAS', (line) => `${reason} (the file uses the merge key << at line ${line})`);
  }
  return undefined;
}

function checked(document: Document.Parsed, lineCounter: LineCounter, merge: boolean): Document.Parsed {
  if (document.errors.length === 0) {
    const problem = duplicateKey(document, lineCounter) ?? (merge ? mergeProblem(document, lineCounter) : undefined);
    if (problem !== undefined) document.errors.push(problem);
  }
  return document;
}

/**
 * One YAML document, as parseDocument gives it; a duplicate key or nesting deeper than MAX_YAML_DEPTH is in `errors`,
 * and with `merge` also a merge key that does not refer to maps.
 */
export function parseYamlDocument(text: string, lineCounter = new LineCounter(), options: YamlOptions = {}): Document.Parsed {
  const deep = tooDeep(text);
  if (deep !== undefined) return tooDeepDocument(text, deep);
  const merge = options.merge === true;
  return checked(parseDocument(text, { uniqueKeys: false, lineCounter, merge }), lineCounter, merge);
}

/** Every document of a YAML stream, as parseAllDocuments gives them; errors as in parseYamlDocument. */
export function parseYamlDocuments(text: string, lineCounter = new LineCounter()): Document.Parsed[] {
  const deep = tooDeep(text);
  if (deep !== undefined) return [tooDeepDocument(text, deep)];
  const parsed = parseAllDocuments(text, { uniqueKeys: false, lineCounter });
  return (Array.isArray(parsed) ? parsed : []).map((document) => checked(document, lineCounter, false));
}

/** One YAML document as plain values; throws its first error, like parse from the yaml package. */
export function parseYaml(text: string, options: YamlOptions = {}): unknown {
  const document = parseYamlDocument(text, new LineCounter(), options);
  if (document.errors.length > 0) throw document.errors[0] as Error;
  return document.toJS() as unknown;
}
