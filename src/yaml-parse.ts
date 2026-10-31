// YAML parsing for the files depcurfew reads from a repository. The yaml package checks duplicate keys by comparing
// each key with every earlier key of its map, which is quadratic: a 0.5 MiB map takes half a minute, a 3 MB
// pnpm-lock.yaml 19 s and a 14 MB one six minutes. Files are parsed without that check, and the same check runs here
// with a Set, so a duplicate key is still an error of the document, with the line and column of the second key.
import { isMap, isScalar, isSeq, Lexer, LineCounter, parseAllDocuments, parseDocument, YAMLParseError, type Document } from 'yaml';

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

function checked(document: Document.Parsed, lineCounter: LineCounter): Document.Parsed {
  if (document.errors.length === 0) {
    const duplicate = duplicateKey(document, lineCounter);
    if (duplicate !== undefined) document.errors.push(duplicate);
  }
  return document;
}

/** One YAML document, as parseDocument gives it; a duplicate key or nesting deeper than MAX_YAML_DEPTH is in `errors`. */
export function parseYamlDocument(text: string, lineCounter = new LineCounter()): Document.Parsed {
  const deep = tooDeep(text);
  if (deep !== undefined) return tooDeepDocument(text, deep);
  return checked(parseDocument(text, { uniqueKeys: false, lineCounter }), lineCounter);
}

/** Every document of a YAML stream, as parseAllDocuments gives them; errors as in parseYamlDocument. */
export function parseYamlDocuments(text: string, lineCounter = new LineCounter()): Document.Parsed[] {
  const deep = tooDeep(text);
  if (deep !== undefined) return [tooDeepDocument(text, deep)];
  const parsed = parseAllDocuments(text, { uniqueKeys: false, lineCounter });
  return (Array.isArray(parsed) ? parsed : []).map((document) => checked(document, lineCounter));
}

/** One YAML document as plain values; throws its first error, like parse from the yaml package. */
export function parseYaml(text: string): unknown {
  const document = parseYamlDocument(text);
  if (document.errors.length > 0) throw document.errors[0] as Error;
  return document.toJS() as unknown;
}
