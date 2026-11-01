// What uv.lock and pdm.lock record of the settings they were locked with, compared with the settings the project has
// now (decision D-116). uv writes exclude-newer into [options] of uv.lock and compares it as uv itself does
// (extra.lockOptions, extra.lockComparison, extra.spanSyntax); PDM keeps a content hash of parts of pyproject.toml in
// pdm.lock (extra.lockHash), which is computed here as PDM computes it. Whatever depcurfew cannot tell the way the tool
// does (a date without a time, a number in the hashed tables, a workspace) gives no answer rather than a guess.
import { createHash } from 'node:crypto';
import { extraOf, isRecord } from '../apply/facts.ts';
import { TomlDateTime, tomlValueAt, type TomlDocument } from '../detect/toml.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { normalizePythonName } from '../policy/python-names.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

// ---------------------------------------------------------------------------------------------------------------
// uv: spans and timestamps

const SPAN_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds', 'microseconds', 'nanoseconds'] as const;
type SpanUnit = (typeof SPAN_UNITS)[number];

/** A jiff Span as uv compares it: each unit as written (fieldwise), with the sign. */
export interface Span {
  negative: boolean;
  units: Partial<Record<SpanUnit, bigint>>;
}

interface SpanSyntax {
  friendlyUnits: Record<SpanUnit, string[]>;
  rejectedUnits: SpanUnit[];
}

const isSpanSyntax = (value: unknown): value is SpanSyntax =>
  isRecord(value) && isRecord(value['friendlyUnits']) && SPAN_UNITS.every((unit) => isStrings((value['friendlyUnits'] as Record<string, unknown>)[unit])) && isStrings(value['rejectedUnits']);

/** ISO 8601 durations as jiff prints and reads them: P1Y2M3W4DT5H6M7S, whole numbers only. */
function isoSpan(text: string): Span | undefined {
  const match = /^([+-]?)P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/iu.exec(text);
  if (match === null || /^[+-]?P$/iu.test(text) || /T$/iu.test(text)) return undefined;
  const units: Span['units'] = {};
  const order: SpanUnit[] = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds'];
  order.forEach((unit, index) => {
    const value = match[index + 2];
    if (value !== undefined) units[unit] = BigInt(value);
  });
  return { negative: match[1] === '-', units };
}

/** jiff's friendly format with whole numbers ("3 days", "1w", "2 weeks, 3 days", "-1 day", "1 day ago"). */
function friendlySpan(text: string, syntax: SpanSyntax): Span | undefined {
  let rest = text.trim();
  let negative = false;
  if (/^[+-]/u.test(rest)) {
    negative = rest.startsWith('-');
    rest = rest.slice(1).trimStart();
  } else if (/\sago$/u.test(rest)) {
    negative = true;
    rest = rest.slice(0, -'ago'.length).trimEnd();
  }
  const units: Span['units'] = {};
  let last = -1;
  while (rest !== '') {
    const match = /^(\d+)[ \t\n\f\r]*([A-Za-z]+)[ \t\n\f\r]*(?:,[ \t\n\f\r]*)?/u.exec(rest);
    if (match === null) return undefined;
    const word = (match[2] ?? '').toLowerCase();
    const index = SPAN_UNITS.findIndex((unit) => syntax.friendlyUnits[unit].includes(word));
    // Each unit once, larger units first.
    if (index <= last) return undefined;
    last = index;
    units[SPAN_UNITS[index] as SpanUnit] = BigInt(match[1] ?? '0');
    rest = rest.slice(match[0].length);
  }
  return last === -1 ? undefined : { negative, units };
}

/** A span as uv reads it from a setting (friendly or ISO 8601), or undefined when depcurfew cannot read it as uv does. */
export function parseSpan(text: string, syntax: SpanSyntax): Span | undefined {
  const span = isoSpan(text.trim()) ?? friendlySpan(text, syntax);
  if (span === undefined || syntax.rejectedUnits.some((unit) => (span.units[unit] ?? 0n) !== 0n)) return undefined;
  return span;
}

/** Fieldwise equality, as ExcludeNewerSpan compares: the same number in every unit, and the same sign unless it is zero. */
export function sameSpan(a: Span, b: Span): boolean {
  const zero = (span: Span) => SPAN_UNITS.every((unit) => (span.units[unit] ?? 0n) === 0n);
  if (zero(a) || zero(b)) return zero(a) && zero(b);
  return a.negative === b.negative && SPAN_UNITS.every((unit) => (a.units[unit] ?? 0n) === (b.units[unit] ?? 0n));
}

/** "7 days" and "1 week" cover the same time but are different spans to uv. */
function sameLength(a: Span, b: Span): boolean {
  const nanos: Record<SpanUnit, bigint> = {
    years: -1n,
    months: -1n,
    weeks: 604_800_000_000_000n,
    days: 86_400_000_000_000n,
    hours: 3_600_000_000_000n,
    minutes: 60_000_000_000n,
    seconds: 1_000_000_000n,
    milliseconds: 1_000_000n,
    microseconds: 1_000n,
    nanoseconds: 1n,
  };
  const total = (span: Span) => SPAN_UNITS.reduce((sum, unit) => sum + (span.units[unit] ?? 0n) * nanos[unit], 0n) * (span.negative ? -1n : 1n);
  return total(a) === total(b);
}

/** An RFC 3339 timestamp in nanoseconds since 1970, or undefined for anything else (a date alone included). */
export function parseTimestamp(text: string): bigint | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/u.exec(text.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(milliseconds);
  if (Number.isNaN(milliseconds) || check.getUTCDate() !== day || check.getUTCMonth() !== month - 1 || hour > 23 || minute > 59 || second > 60) return undefined;
  const fraction = BigInt((match[7] ?? '').padEnd(9, '0') || '0');
  const offset = match[8] !== undefined ? 0 : (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11])) * 60;
  return (BigInt(milliseconds / 1000) - BigInt(offset)) * 1_000_000_000n + fraction;
}

// ---------------------------------------------------------------------------------------------------------------
// uv: the settings and uv.lock

/** One exclude-newer value: relative (a span) or absolute (a timestamp); unknown when depcurfew cannot tell which. */
type CutoffValue = { kind: 'span'; span: Span; text: string } | { kind: 'timestamp'; at: bigint; text: string } | { kind: 'unknown' };
type Override = { kind: 'enabled'; value: CutoffValue; text: string } | { kind: 'disabled' };

interface LockOptions {
  table: string;
  timestamp: string;
  span: string;
  packages: string;
  packageTimestamp: string;
  packageSpan: string;
  placeholder: string;
}

const isLockOptions = (value: unknown): value is LockOptions =>
  isRecord(value) && ['table', 'timestamp', 'span', 'packages', 'packageTimestamp', 'packageSpan', 'placeholder'].every((key) => typeof value[key] === 'string');

/** A value of exclude-newer as uv reads it from a setting: a timestamp, then a date (unknown here), then a span. */
function settingValue(value: unknown, syntax: SpanSyntax): CutoffValue | undefined {
  const text = value instanceof TomlDateTime ? value.text : value;
  if (typeof text !== 'string') return { kind: 'unknown' };
  const at = parseTimestamp(text);
  if (at !== undefined) return { kind: 'timestamp', at, text };
  // A date alone is the start of the next day in the time zone of the machine that locked (extra.lockComparison).
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text.trim())) return { kind: 'unknown' };
  const span = parseSpan(text, syntax);
  return span === undefined ? { kind: 'unknown' } : { kind: 'span', span, text };
}

/** A value uv.lock records: a span next to a placeholder timestamp, or a timestamp. */
function lockedValue(timestamp: unknown, span: unknown, options: LockOptions, syntax: SpanSyntax): CutoffValue | undefined {
  if (typeof span === 'string') {
    const parsed = parseSpan(span, syntax);
    return parsed === undefined ? { kind: 'unknown' } : { kind: 'span', span: parsed, text: span };
  }
  const text = timestamp instanceof TomlDateTime ? timestamp.text : timestamp;
  if (text === undefined) return undefined;
  if (typeof text !== 'string' || text === options.placeholder) return { kind: 'unknown' };
  const at = parseTimestamp(text);
  return at === undefined ? { kind: 'unknown' } : { kind: 'timestamp', at, text };
}

/** Whether uv locks again for this pair, as compare_exclude_newer_value decides: true, false, or undefined (cannot tell). */
function valueChanged(locked: CutoffValue, current: CutoffValue): boolean | undefined {
  if (locked.kind === 'unknown' || current.kind === 'unknown') return undefined;
  if (locked.kind !== current.kind) return true;
  if (locked.kind === 'span' && current.kind === 'span') return !sameSpan(locked.span, current.span);
  // Only an earlier cutoff than the locked one makes uv lock again.
  return locked.kind === 'timestamp' && current.kind === 'timestamp' ? current.at < locked.at : undefined;
}

/** What makes a uv.lock out of date, in words, with the line of uv.lock it concerns. */
export interface UvLockChange {
  /** The setting it concerns: exclude-newer or exclude-newer-package. */
  setting: string;
  /** What uv.lock records, e.g. `exclude-newer-span = "P3D"`, or undefined when it records nothing. */
  locked: string | undefined;
  /** What the configuration says now, e.g. `exclude-newer in pyproject.toml (line 9) is "1 week"`. */
  current: string;
  line: number | undefined;
  /** Why two spans of the same length differ, when they do. */
  note?: string;
}

/**
 * The first change of exclude-newer or exclude-newer-package between uv.lock and the settings, the way uv finds it
 * (extra.lockComparison); undefined when there is none, or when depcurfew cannot tell.
 */
export function uvLockChange(
  tool: ToolKnowledge,
  lock: TomlDocument,
  lockedPackages: readonly string[],
  configFile: string,
  setting: (key: string) => { file: string; line: number; value: unknown } | undefined,
): UvLockChange | undefined {
  if (tool.extra?.['lockOptions'] === undefined || tool.extra['spanSyntax'] === undefined) return undefined;
  const options = extraOf(tool, 'lockOptions', isLockOptions);
  const syntax = extraOf(tool, 'spanSyntax', isSpanSyntax);
  const table = tomlValueAt(lock, [options.table]);
  const recorded = isRecord(table) ? table : {};
  const lineOf = (...path: string[]) => lock.lineOf([options.table, ...path]);
  const where = (found: { file: string; line: number }) => `${found.file} (line ${found.line})`;

  // The global value: false turns off a value of a lower-priority file, so it counts as none.
  const global = setting(options.timestamp);
  const current = global === undefined || global.value === false ? undefined : settingValue(global.value, syntax);
  const locked = lockedValue(recorded[options.timestamp], recorded[options.span], options, syntax);
  const lockedText = typeof recorded[options.span] === 'string' ? `${options.span} = ${JSON.stringify(recorded[options.span])}` : `${options.timestamp} = ${JSON.stringify(locked?.kind === 'timestamp' ? locked.text : recorded[options.timestamp])}`;
  const lockedLine = typeof recorded[options.span] === 'string' ? lineOf(options.span) : lineOf(options.timestamp);
  if (locked === undefined && current !== undefined && global !== undefined) {
    return { setting: options.timestamp, locked: undefined, current: `${options.timestamp} in ${where(global)} is ${JSON.stringify(global.value instanceof TomlDateTime ? global.value.text : global.value)}`, line: undefined };
  }
  if (locked !== undefined && current === undefined) {
    const file = global?.file;
    return { setting: options.timestamp, locked: lockedText, current: file === undefined ? `${configFile} does not set ${options.timestamp}` : `${options.timestamp} is false in ${file}`, line: lockedLine };
  }
  if (locked !== undefined && current !== undefined && global !== undefined && valueChanged(locked, current) === true) {
    const note =
      locked.kind === 'span' && current.kind === 'span' && sameLength(locked.span, current.span)
        ? ` (uv compares the units as written, so ${spanWords(current.span)} is not ${spanWords(locked.span)})`
        : undefined;
    return { setting: options.timestamp, locked: lockedText, current: `${options.timestamp} in ${where(global)} is ${JSON.stringify(current.kind === 'unknown' ? '' : current.text)}`, line: lockedLine, ...(note === undefined ? {} : { note }) };
  }

  // Per package: only names of locked packages and names uv.lock records already count (filter_exclude_newer).
  const packagesSetting = setting(options.packages);
  const configured = new Map<string, Override>();
  if (packagesSetting !== undefined) {
    if (!isRecord(packagesSetting.value)) return undefined;
    for (const [name, value] of Object.entries(packagesSetting.value)) {
      configured.set(normalizePythonName(name), value === false ? { kind: 'disabled' } : { kind: 'enabled', value: settingValue(value, syntax) ?? { kind: 'unknown' }, text: JSON.stringify(value instanceof TomlDateTime ? value.text : value) });
    }
  }
  const lockedTable = recorded[options.packages];
  const lockedOverrides = new Map<string, { override: Override; key: string }>();
  if (lockedTable !== undefined) {
    if (!isRecord(lockedTable)) return undefined;
    for (const [key, value] of Object.entries(lockedTable)) {
      const override: Override =
        value === false
          ? { kind: 'disabled' }
          : isRecord(value)
            ? { kind: 'enabled', value: lockedValue(value[options.packageTimestamp], value[options.packageSpan], options, syntax) ?? { kind: 'unknown' }, text: tomlInline(value) }
            : { kind: 'enabled', value: lockedValue(value, undefined, options, syntax) ?? { kind: 'unknown' }, text: JSON.stringify(value instanceof TomlDateTime ? value.text : value) };
      lockedOverrides.set(normalizePythonName(key), { override, key });
    }
  }
  const counted = new Set([...lockedPackages.map(normalizePythonName), ...lockedOverrides.keys()]);
  const packageWhere = packagesSetting === undefined ? configFile : where(packagesSetting);
  const lockedPackageText = (_name: string, entry: { override: Override; key: string }) =>
    `${options.packages} ${entry.key} = ${entry.override.kind === 'disabled' ? 'false' : entry.override.text}`;
  for (const [name, entry] of lockedOverrides) {
    const now = configured.get(name);
    const line = lineOf(options.packages, entry.key);
    if (now === undefined) {
      return { setting: options.packages, locked: lockedPackageText(name, entry), current: `${packagesSetting?.file ?? configFile} does not set ${options.packages} for ${name}`, line };
    }
    if (entry.override.kind === 'disabled' && now.kind === 'enabled') {
      return { setting: options.packages, locked: lockedPackageText(name, entry), current: `${options.packages} for ${name} in ${packageWhere} is ${now.text}`, line };
    }
    if (entry.override.kind === 'enabled' && now.kind === 'enabled' && valueChanged(entry.override.value, now.value) === true) {
      return { setting: options.packages, locked: lockedPackageText(name, entry), current: `${options.packages} for ${name} in ${packageWhere} is ${now.text}`, line };
    }
  }
  for (const [name, now] of configured) {
    if (!counted.has(name) || lockedOverrides.has(name) || now.kind !== 'enabled') continue;
    return { setting: options.packages, locked: undefined, current: `${options.packages} for ${name} in ${packageWhere} is ${now.text}`, line: undefined };
  }
  return undefined;
}

function spanWords(span: Span): string {
  const parts = SPAN_UNITS.filter((unit) => (span.units[unit] ?? 0n) !== 0n).map((unit) => {
    const count = span.units[unit] ?? 0n;
    return `${count} ${count === 1n ? unit.slice(0, -1) : unit}`;
  });
  return `${span.negative ? '-' : ''}${parts.join(' ') || '0 days'}`;
}

function tomlInline(value: Record<string, unknown>): string {
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${key} = ${JSON.stringify(item instanceof TomlDateTime ? item.text : item)}`)
    .join(', ')} }`;
}

// ---------------------------------------------------------------------------------------------------------------
// PDM: the content hash of pdm.lock

interface LockHash {
  key: string[];
  separator: string;
  inputs: string[];
  inputsSetting: string[];
  workspace: string[];
  project: string[];
  fields: { name: string; path: string[]; missing: unknown }[];
  groups: { name: string; tables: string[][]; separators: string };
}

const isPath = (value: unknown): value is string[] => isStrings(value);
const isLockHash = (value: unknown): value is LockHash =>
  isRecord(value) &&
  isPath(value['key']) &&
  typeof value['separator'] === 'string' &&
  isPath(value['inputs']) &&
  isPath(value['inputsSetting']) &&
  isPath(value['workspace']) &&
  isPath(value['project']) &&
  Array.isArray(value['fields']) &&
  value['fields'].every((field) => isRecord(field) && typeof field['name'] === 'string' && isPath(field['path'])) &&
  isRecord(value['groups']) &&
  typeof value['groups']['name'] === 'string' &&
  Array.isArray(value['groups']['tables']) &&
  value['groups']['tables'].every(isPath) &&
  typeof value['groups']['separators'] === 'string';

/** A JSON string as Python's json.dumps writes it (ensure_ascii): every character outside space..~ as \uXXXX. */
function pythonString(text: string): string {
  const escapes: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let out = '"';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const code = text.charCodeAt(index);
    if (escapes[char] !== undefined) out += escapes[char];
    else if (code >= 0x20 && code <= 0x7e) out += char;
    // UTF-16 code units are what Python writes for a character beyond U+FFFF too: a surrogate pair.
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

/** Code-point order, as Python sorts str keys: the code points of each key are taken once, not at each comparison. */
function byCodePoint(keys: readonly string[]): string[] {
  const points = keys.map((key) => ({ key, points: [...key].map((char) => char.codePointAt(0) ?? 0) }));
  points.sort((a, b) => {
    const length = Math.min(a.points.length, b.points.length);
    for (let index = 0; index < length; index++) {
      const difference = (a.points[index] ?? 0) - (b.points[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return a.points.length - b.points.length;
  });
  return points.map((entry) => entry.key);
}

/**
 * json.dumps(value, sort_keys=True) as Python writes it; undefined for a value whose text depcurfew cannot be sure of:
 * numbers (the TOML reader does not keep 1.0 apart from 1, which Python writes differently), dates (which json.dumps
 * cannot write), and a string with a carriage return (a multi-line string, which TOML readers may write differently).
 */
export function pythonJson(value: unknown): string | undefined {
  if (typeof value === 'string') return value.includes('\r') ? undefined : pythonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const items = value.map(pythonJson);
    return items.some((item) => item === undefined) ? undefined : `[${items.join(', ')}]`;
  }
  if (isRecord(value) && !(value instanceof TomlDateTime)) {
    const keys = byCodePoint(Object.keys(value));
    const parts: string[] = [];
    for (const key of keys) {
      const item = pythonJson(value[key]);
      if (item === undefined) return undefined;
      parts.push(`${pythonString(key)}: ${item}`);
    }
    return `{${parts.join(', ')}}`;
  }
  return undefined;
}

/** What pdm.lock says about its freshness, and what PDM computes now. */
export type PdmHashResult = { matches: boolean; line: number | undefined } | undefined;

/**
 * Compares the content_hash of pdm.lock with the one PDM computes from pyproject.toml now (extra.lockHash); undefined
 * when PDM does not use it (canonical lock inputs), computes it differently (a workspace root, no [project] table), or
 * depcurfew cannot compute it the same way.
 */
export function pdmHash(tool: ToolKnowledge, lock: TomlDocument, pyproject: TomlDocument): PdmHashResult {
  if (tool.extra?.['lockHash'] === undefined) return undefined;
  const fact = extraOf(tool, 'lockHash', isLockHash);
  const recorded = tomlValueAt(lock, fact.key);
  if (typeof recorded !== 'string') return undefined;
  const at = recorded.indexOf(fact.separator);
  if (at <= 0) return undefined;
  const algorithm = recorded.slice(0, at);
  const expected = recorded.slice(at + fact.separator.length).toLowerCase();
  if (tomlValueAt(lock, fact.inputs) !== undefined || tomlValueAt(pyproject, fact.inputsSetting) === true) return undefined;
  const workspace = tomlValueAt(pyproject, fact.workspace);
  if (workspace !== undefined && !(isRecord(workspace) && Object.keys(workspace).length === 0)) return undefined;
  if (!isRecord(tomlValueAt(pyproject, fact.project))) return undefined;
  // A Map, not an object: a group named constructor is data, and each list is appended once (decision D-121).
  const groups = new Map<string, unknown[]>();
  const separators = new RegExp(fact.groups.separators, 'gu');
  for (const [index, path] of fact.groups.tables.entries()) {
    const table = tomlValueAt(pyproject, path);
    if (table === undefined) continue;
    if (!isRecord(table)) return undefined;
    for (const [name, list] of Object.entries(table)) {
      if (!Array.isArray(list)) return undefined;
      const group = name.replace(separators, '-').toLowerCase();
      const known = groups.get(group);
      // A name twice in [dependency-groups] is an error of PDM; the later tables add to a group.
      if (index === 0 && known !== undefined) return undefined;
      if (known === undefined) groups.set(group, [...(list as unknown[])]);
      else for (const item of list as unknown[]) known.push(item);
    }
  }
  // Object.fromEntries defines own properties, so no name (not even __proto__) changes the object's prototype.
  const dump: Record<string, unknown> = { [fact.groups.name]: Object.fromEntries(groups) };
  for (const field of fact.fields) dump[field.name] = tomlValueAt(pyproject, field.path) ?? field.missing;
  const text = pythonJson(dump);
  if (text === undefined) return undefined;
  let actual: string;
  try {
    actual = createHash(algorithm).update(text, 'utf8').digest('hex');
  } catch {
    return undefined;
  }
  return { matches: actual === expected, line: lock.lineOf(fact.key) };
}
