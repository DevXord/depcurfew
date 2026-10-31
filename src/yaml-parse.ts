// YAML parsing for the files depcurfew reads from a repository. The yaml package checks duplicate keys by comparing
// each key with every earlier key of its map, which is quadratic: a 0.5 MiB map takes half a minute, a 3 MB
// pnpm-lock.yaml 19 s and a 14 MB one six minutes. Files are parsed without that check, and the same check runs here
// with a Set, so a duplicate key is still an error of the document, with the line and column of the second key.
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments, parseDocument, YAMLParseError, type Document } from 'yaml';

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

/** One YAML document, as parseDocument gives it; a duplicate key is in `errors`. */
export function parseYamlDocument(text: string, lineCounter = new LineCounter()): Document.Parsed {
  return checked(parseDocument(text, { uniqueKeys: false, lineCounter }), lineCounter);
}

/** Every document of a YAML stream, as parseAllDocuments gives them; a duplicate key is in `errors`. */
export function parseYamlDocuments(text: string, lineCounter = new LineCounter()): Document.Parsed[] {
  const parsed = parseAllDocuments(text, { uniqueKeys: false, lineCounter });
  return (Array.isArray(parsed) ? parsed : []).map((document) => checked(document, lineCounter));
}

/** One YAML document as plain values; throws its first error, like parse from the yaml package. */
export function parseYaml(text: string): unknown {
  const document = parseYamlDocument(text);
  if (document.errors.length > 0) throw document.errors[0] as Error;
  return document.toJS() as unknown;
}
