// Reading lockfiles for doctor: where each package comes from (registry, git, tarball URL, local tarball, local
// directory, workspace) and, where the format records it, whether it has install scripts. The spelling of every
// format comes from the knowledge base (extra.lockfileFormat).
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { isRecord, values } from '../apply/facts.ts';
import { parseJsonc } from '../detect/jsonc.ts';
import type { Repository } from '../detect/repository.ts';
import type { PackageManagerInfo } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';

/** Lockfiles are often larger than configuration files. */
export const MAX_LOCKFILE_SIZE = 64 * 1024 * 1024;

export type Source = 'registry' | 'git' | 'remoteTarball' | 'file' | 'directory' | 'workspace' | 'unknown';

export interface LockEntry {
  name: string;
  /** How the lockfile names the source, for messages. */
  spec: string;
  source: Source;
  /** undefined when the format does not record install scripts. */
  installScript: boolean | undefined;
  /** Text to look for when reporting the line. */
  anchor: string;
}

export interface Lockfile {
  file: string;
  entries: LockEntry[];
  /** Whether the format records install scripts at all. */
  recordsScripts: boolean;
  /** 1-based line of an entry's anchor (searched on demand, since lockfiles are large). */
  lineOf(entry: LockEntry): number | undefined;
}

type Format = Record<string, unknown>;

/**
 * Finds the 1-based line of each anchor. Rules ask in the order the entries were parsed, which is the order of the
 * file, so each search continues where the last one stopped and a large lockfile is not scanned once per entry.
 */
function lineFinder(text: string, start = 0): (anchor: string) => number | undefined {
  let newlines: number[] | undefined;
  let cursor = start;
  return (anchor) => {
    let offset = text.indexOf(anchor, cursor);
    if (offset === -1) offset = text.indexOf(anchor);
    if (offset === -1) return undefined;
    cursor = offset + anchor.length;
    if (newlines === undefined) {
      newlines = [];
      for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) newlines.push(index);
    }
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((newlines[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Splits name@spec, where the name may be scoped and the spec may contain @ (git@host). */
export function splitSpec(key: string): { name: string; spec: string } {
  const at = key.startsWith('@') ? key.indexOf('@', key.indexOf('/') + 1) : key.indexOf('@');
  return at <= 0 ? { name: key, spec: '' } : { name: key.slice(0, at), spec: key.slice(at + 1) };
}

const HTTP = /^https?:\/\//u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function npmEntries(text: string, format: Format, workspaces: readonly string[]): LockEntry[] {
  const document = JSON.parse(text) as unknown;
  if (!isRecord(document) || !isRecord(document['packages'])) throw new UnsupportedLockfile('it has no "packages" section (lockfileVersion 1 is not read)');
  const packages = document['packages'];
  const registry = new RegExp(String(format['registryTarball']), 'u');
  const scriptsKey = String(format['installScripts']);
  const entries: LockEntry[] = [];
  for (const [key, value] of Object.entries(packages)) {
    if (!key.includes('node_modules/') || !isRecord(value)) continue;
    const name = typeof value['name'] === 'string' ? value['name'] : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = typeof value['resolved'] === 'string' ? value['resolved'] : '';
    // Without resolved, npm installs name@version, so a version such as git+https://… is where the package comes from.
    const version = typeof value['version'] === 'string' ? value['version'] : '';
    const spec = resolved !== '' || format['specWithoutResolved'] !== 'version' ? resolved : version;
    let source: Source = 'unknown';
    if (value[String(format['linkFlag'])] === true) source = workspaces.includes(resolved) ? 'workspace' : 'directory';
    else if (strings(format['gitPrefixes']).some((prefix) => spec.startsWith(prefix))) source = 'git';
    else if (spec.startsWith(String(format['filePrefix']))) source = /\.(?:tgz|tar\.gz)$/u.test(spec) ? 'file' : 'directory';
    else if (HTTP.test(spec)) source = registry.test(spec) ? 'registry' : 'remoteTarball';
    else if (resolved === '' && (spec === '' || EXACT_VERSION.test(spec))) source = 'registry';
    entries.push({ name, spec, source, installScript: value[scriptsKey] === true, anchor: `${JSON.stringify(key)}: {` });
  }
  return entries;
}

/** The project lockfile of a pnpm-lock.yaml and where it starts: the last document when a boot document comes first. */
function pnpmGraph(text: string, documents: Format | undefined): { document: unknown; start: number } {
  const marker = documents?.['bootMarker'];
  if (typeof marker !== 'string' || documents?.['graph'] !== 'last' || text.split(/\r?\n/u, 1)[0] !== marker) return { document: parseYaml(text), start: 0 };
  const parsed = parseAllDocuments(text);
  const all = Array.isArray(parsed) ? parsed : [parsed];
  for (const document of all) if (document.errors.length > 0) throw document.errors[0] as Error;
  const last = all.at(-1);
  return { document: last?.toJS() as unknown, start: last?.range[0] ?? 0 };
}

function pnpmEntries(text: string, format: Format, documents: Format | undefined): { entries: LockEntry[]; start: number } {
  const { document, start } = pnpmGraph(text, documents);
  if (!isRecord(document)) return { entries: [], start };
  if (!String(document['lockfileVersion']).startsWith('9')) throw new UnsupportedLockfile(`its lockfileVersion ${String(document['lockfileVersion'])} is not read; depgate reads 9.0`);
  const hosts = strings(format['gitHostedTarballHosts']);
  const entries: LockEntry[] = [];
  const packages = isRecord(document['packages']) ? document['packages'] : {};
  for (const [key, value] of Object.entries(packages)) {
    const { name, spec } = splitSpec(key);
    const resolution = isRecord(value) && isRecord(value['resolution']) ? value['resolution'] : {};
    const tarball = typeof resolution['tarball'] === 'string' ? resolution['tarball'] : '';
    let host = '';
    try {
      host = HTTP.test(tarball) ? new URL(tarball).hostname : HTTP.test(spec) ? new URL(spec).hostname : '';
    } catch {
      host = '';
    }
    let source: Source = 'registry';
    if (spec.startsWith(String(format['gitKeyPrefix'])) || resolution['type'] === format['gitType']) source = 'git';
    else if (resolution[String(format['gitHostedFlag'])] === true || (host !== '' && hosts.includes(host))) source = 'git';
    else if (resolution['type'] === format['directoryType']) source = 'directory';
    else if (spec.startsWith('file:')) source = 'file';
    else if (HTTP.test(spec)) source = 'remoteTarball';
    entries.push({ name, spec, source, installScript: undefined, anchor: key });
  }
  // link: dependencies other than workspace: ones are local directories, listed only under importers.
  const importers = isRecord(document['importers']) ? document['importers'] : {};
  for (const importer of Object.values(importers)) {
    if (!isRecord(importer)) continue;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = isRecord(importer[group]) ? importer[group] : {};
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (!isRecord(dependency) || typeof dependency['version'] !== 'string') continue;
        const specifier = typeof dependency['specifier'] === 'string' ? dependency['specifier'] : '';
        if (dependency['version'].startsWith('link:') && !specifier.startsWith('workspace:')) {
          entries.push({ name, spec: specifier, source: 'directory', installScript: undefined, anchor: `specifier: ${specifier}` });
        }
      }
    }
  }
  return { entries, start };
}

function yarnSource(locator: string, format: Format): Source {
  if (locator.startsWith(String(format['workspace']))) return 'workspace';
  if (locator.startsWith(String(format['registry']))) return 'registry';
  if (locator.startsWith(String(format['patch']))) {
    const inner = decodeURIComponent(locator.slice(String(format['patch']).length).split('#')[0] ?? '');
    return yarnSource(splitSpec(inner).spec, format);
  }
  if (locator.startsWith(String(format['file']))) {
    const path = locator.slice(String(format['file']).length).split('#')[0]?.split('::')[0] ?? '';
    return new RegExp(String(format['tarball']), 'u').test(path) ? 'file' : 'directory';
  }
  if (strings(format['directory']).some((prefix) => locator.startsWith(prefix))) return 'directory';
  if (locator.includes(String(format['gitCommit'])) || /^(git\+|git:|ssh:|git@|github:)/u.test(locator)) return 'git';
  if (HTTP.test(locator)) return 'remoteTarball';
  return 'unknown';
}

function yarnEntries(text: string, format: Format): LockEntry[] {
  const document = parseYaml(text) as unknown;
  if (!isRecord(document)) return [];
  return Object.entries(document)
    .filter(([key, value]) => key !== '__metadata' && isRecord(value) && typeof value['resolution'] === 'string')
    .map(([, value]) => {
      const resolution = (value as Record<string, unknown>)['resolution'] as string;
      const { name, spec } = splitSpec(resolution);
      return { name, spec, source: yarnSource(spec, format), installScript: undefined, anchor: `resolution: "${resolution}"` };
    });
}

function bunEntries(text: string, format: Format): LockEntry[] {
  const document = parseJsonc(text);
  const packages = isRecord(document) && isRecord(document['packages']) ? document['packages'] : {};
  const tarball = new RegExp(String(format['tarball']), 'u');
  const scriptsKey = String(format['installScripts']);
  const entries: LockEntry[] = [];
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    const { name, spec } = splitSpec(value[0]);
    let source: Source = 'registry';
    if (strings(format['git']).some((prefix) => spec.startsWith(prefix))) source = 'git';
    else if (spec.startsWith(String(format['workspace']))) source = 'workspace';
    else if (strings(format['directory']).some((prefix) => spec.startsWith(prefix))) source = 'directory';
    else if (HTTP.test(spec)) source = 'remoteTarball';
    else if (/^(\.{1,2}\/|\/)/u.test(spec) && tarball.test(spec)) source = 'file';
    const info = (value as unknown[]).find((item) => isRecord(item));
    entries.push({ name, spec, source, installScript: isRecord(info) && info[scriptsKey] === true, anchor: `${JSON.stringify(key)}: [` });
  }
  return entries;
}

function denoEntries(text: string, format: Format): { entries: LockEntry[]; recordsScripts: boolean } {
  const document = JSON.parse(text) as unknown;
  if (!isRecord(document)) return { entries: [], recordsScripts: false };
  const recordsScripts = Number(document['version']) >= Number(format['installScriptsSinceLockfile']);
  const npm = isRecord(document['npm']) ? document['npm'] : {};
  const scriptsKey = String(format['installScripts']);
  const entries = Object.entries(npm).map(([key, value]): LockEntry => {
    const { name, spec } = splitSpec(key);
    return { name, spec, source: 'registry', installScript: recordsScripts ? isRecord(value) && value[scriptsKey] === true : undefined, anchor: `${JSON.stringify(key)}: {` };
  });
  return { entries, recordsScripts };
}

/** A lockfile in a version or shape depgate does not read; the message says why. */
class UnsupportedLockfile extends Error {}

/**
 * A lockfile that could not be checked. An unreadable one (missing, outside the repository, too large, invalid) is
 * also a repository warning, which unreadable-config reports as an error; an unsupported format version is not.
 */
export type LockfileResult = { ok: true; lockfile: Lockfile } | { ok: false; file: string; reason: string; unreadable: boolean };

function documentsOf(tool: ToolKnowledge): Format | undefined {
  const fact = tool.extra?.['lockfileDocuments'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return isRecord(value) ? value : undefined;
}

/** The lockfiles a package manager uses in the repository root, parsed. */
export function readLockfiles(repository: Repository, manager: PackageManagerInfo, tool: ToolKnowledge, workspaces: readonly string[]): LockfileResult[] {
  const fact = tool.extra?.['lockfileFormat'];
  const format = fact === undefined ? undefined : values(fact)[0];
  if (!isRecord(format)) return [];
  const files = [...new Set(manager.evidence.filter((item) => item.kind === 'lockfile').map((item) => item.file))];
  return files.map((file): LockfileResult => {
    if (file.endsWith('.lockb')) return { ok: false, file, reason: 'it is a binary file in an undocumented format', unreadable: false };
    const text = repository.readText(file, MAX_LOCKFILE_SIZE);
    if (text === undefined) {
      if (!repository.warnings.some((warning) => warning.files.includes(file))) repository.warn('invalid-file', `cannot read ${file}`, [file]);
      return { ok: false, file, reason: 'it cannot be read', unreadable: true };
    }
    try {
      let entries: LockEntry[];
      let recordsScripts = format['installScripts'] !== null;
      let start = 0;
      if (tool.id === 'npm') entries = npmEntries(text, format, workspaces);
      else if (tool.id === 'pnpm') ({ entries, start } = pnpmEntries(text, format, documentsOf(tool)));
      else if (tool.id === 'yarn') entries = yarnEntries(text, format);
      else if (tool.id === 'bun') entries = bunEntries(text, format);
      else ({ entries, recordsScripts } = denoEntries(text, format));
      const find = lineFinder(text, start);
      return { ok: true, lockfile: { file, entries, recordsScripts, lineOf: (entry) => find(entry.anchor) } };
    } catch (error) {
      if (error instanceof UnsupportedLockfile) return { ok: false, file, reason: error.message, unreadable: false };
      const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      repository.warn('invalid-file', `cannot parse ${file}: ${message}`, [file]);
      return { ok: false, file, reason: `it cannot be parsed (${message})`, unreadable: true };
    }
  });
}
