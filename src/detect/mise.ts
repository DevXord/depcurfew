// mise (decision D-173): the versions [tools] of mise.toml and the files beside it request, as mise reads them: the
// file of a directory that wins first, a string, the first entry of a list or the version of a table.
import type { MiseConfigKnowledge, RuntimeOrTool } from '../knowledge/types.ts';
import { joinPath } from './repository.ts';
import { TomlDateTime, type TomlDocument, type TomlValue } from './toml.ts';

function isTable(value: TomlValue | undefined): value is Record<string, TomlValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof TomlDateTime);
}

/**
 * The request of a tool's entry: "24", ["24", "22"] (the first provides the command) or { version = "24" }; undefined
 * for anything else (a table without a version, such as { path = ... }). `lists`: whether a list gives its first entry.
 */
export function miseRequest(value: TomlValue | undefined, versionKey: string, lists = true): { request: string; path: (string | number)[] } | undefined {
  if (typeof value === 'string') return { request: value, path: [] };
  if (lists && Array.isArray(value)) {
    const found = miseRequest(value[0], versionKey, false);
    return found === undefined ? undefined : { request: found.request, path: [0, ...found.path] };
  }
  if (isTable(value) && typeof value[versionKey] === 'string') return { request: value[versionKey], path: [versionKey] };
  return undefined;
}

/** A tool's request in one parsed mise file, with the line of the request. */
export function requestIn(document: TomlDocument, facts: MiseConfigKnowledge, name: string): { request: string; line?: number } | undefined {
  const table = document.root[facts.table];
  if (!isTable(table) || !Object.hasOwn(table, name)) return undefined;
  const found = miseRequest(table[name], facts.versionKey);
  if (found === undefined) return undefined;
  const line = document.lineOf([facts.table, name, ...found.path]) ?? document.lineOf([facts.table, name]);
  return { request: found.request.trim(), ...(line === undefined ? {} : { line }) };
}

/**
 * The request of each tool mise reads in `directory` (relative to the root, '' or '.' for it), from the nearest
 * directory up to the root and in each from the file that wins first; a file that cannot be parsed is skipped.
 */
export function miseTools(read: (file: string) => TomlDocument | undefined, facts: MiseConfigKnowledge, directory = ''): Map<RuntimeOrTool, { request: string; file: string; line?: number }> {
  const found = new Map<RuntimeOrTool, { request: string; file: string; line?: number }>();
  const parts = directory === '' || directory === '.' ? [] : directory.split('/').filter((part) => part !== '' && part !== '.');
  for (let depth = parts.length; depth >= 0; depth--) {
    const base = depth === 0 ? '.' : parts.slice(0, depth).join('/');
    for (const name of facts.files) {
      const file = joinPath(base, name);
      const document = read(file);
      if (document === undefined) continue;
      for (const [key, tool] of Object.entries(facts.tools)) {
        if (found.has(tool)) continue;
        const request = requestIn(document, facts, key);
        if (request !== undefined) found.set(tool, { ...request, file });
      }
    }
  }
  return found;
}
