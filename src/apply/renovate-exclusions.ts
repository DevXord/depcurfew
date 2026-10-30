// Entries Renovate adds to pnpm's minimumReleaseAgeExclude for security updates (extra.pnpmSecurityExclusions of
// Renovate): "<name>@<version>" with the comment "# Renovate security update: <name>@<version>" on the line above,
// later versions joined with " || ". apply keeps them, comment included, and changes only the policy's entries, so
// the next Renovate security pull request does not fail config-drift (decision D-075). Only that format counts.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair } from 'yaml';
import { isRecord } from './facts.ts';

export interface SecurityExclusionFormat {
  managers: string[];
  file: string;
  setting: string;
  /** The comment above an entry, up to the package, e.g. "# Renovate security update: ". */
  comment: string;
  versionSeparator: string;
}

export const isSecurityExclusionFormat = (value: unknown): value is SecurityExclusionFormat =>
  isRecord(value) &&
  Array.isArray(value['managers']) &&
  typeof value['file'] === 'string' &&
  typeof value['setting'] === 'string' &&
  typeof value['comment'] === 'string' &&
  typeof value['versionSeparator'] === 'string';

export interface KeptEntry {
  value: string;
  /** The comment line and the entry line, as written. */
  lines: [string, string];
}

/** name@versions, with a scoped name (@scope/name@1.2.3) split at the second @. */
function split(spec: string, separator: string): { name: string; versions: string[] } | undefined {
  const at = spec.indexOf('@', 1);
  if (at <= 0) return undefined;
  const versions = spec.slice(at + 1).split(separator);
  // Exact versions only: no spaces, no range operators, no second @.
  if (!versions.every((version) => /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(version))) return undefined;
  return { name: spec.slice(0, at), versions };
}

function sequenceAt(text: string, key: string): { items: Node[]; lineCounter: LineCounter } | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined;
  const pair = (document.contents.items as Pair<Node, Node | null>[]).filter((item) => isScalar(item.key) && String(item.key.value) === key).at(-1);
  if (pair === undefined || pair.value === null || !isSeq(pair.value) || pair.value.flow === true) return undefined;
  return { items: pair.value.items as Node[], lineCounter };
}

/** The single-line string items of the sequence, with their 1-based line. */
function scalarItems(text: string, key: string): { value: string; line: number }[] {
  const sequence = sequenceAt(text, key);
  if (sequence === undefined) return [];
  return sequence.items.flatMap((item) => {
    if (!isScalar(item) || typeof item.value !== 'string' || item.range === null || item.range === undefined) return [];
    const line = sequence.lineCounter.linePos(item.range[0]).line;
    return sequence.lineCounter.linePos(item.range[1]).line === line ? [{ value: item.value, line }] : [];
  });
}

/** The entries of the block sequence at the top-level `key` that Renovate added for security updates. */
export function securityEntries(text: string, key: string, format: SecurityExclusionFormat): KeptEntry[] {
  const lines = text.split('\n');
  return scalarItems(text, key).flatMap(({ value, line }): KeptEntry[] => {
    const comment = lines[line - 2] ?? '';
    const trimmed = comment.trim();
    if (!trimmed.startsWith(format.comment)) return [];
    const named = split(trimmed.slice(format.comment.length).trim(), format.versionSeparator);
    const entry = split(value, format.versionSeparator);
    if (named === undefined || entry === undefined || named.name !== entry.name) return [];
    return [{ value, lines: [comment, lines[line - 1] ?? ''] }];
  });
}

/** Puts the kept entries back as they were written, in place of the same values rendered without their comment. */
export function restoreEntries(text: string, key: string, entries: readonly KeptEntry[]): string {
  const lines = text.split('\n');
  const used = new Set<number>();
  const replacements: { line: number; with: string[] }[] = [];
  const items = scalarItems(text, key);
  for (const entry of entries) {
    const item = items.find((candidate) => candidate.value === entry.value && !used.has(candidate.line));
    if (item === undefined) continue;
    used.add(item.line);
    const indent = /^\s*/u.exec(lines[item.line - 1] ?? '')?.[0] ?? '';
    replacements.push({ line: item.line, with: entry.lines.map((line) => `${indent}${line.trimStart()}`) });
  }
  for (const replacement of replacements.sort((a, b) => b.line - a.line)) lines.splice(replacement.line - 1, 1, ...replacement.with);
  return lines.join('\n');
}
