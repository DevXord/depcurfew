// Python lockfiles for doctor: uv.lock, poetry.lock, pylock.toml and pip requirements files. Each package gets its
// source (registry, git, URL, local archive or directory, workspace) and whether installing it builds it from
// source, which runs its build code (decision D-065: the Python counterpart of install scripts). Key names come from
// the knowledge base (extra.lockfileFormat, extra.requirementsFormat).
import { isRecord } from '../apply/facts.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { environment } from '../knowledge/environment.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { parseToml } from '../detect/toml.ts';
import type { LockEntry, Source } from './lockfiles.ts';

type Format = Record<string, unknown>;

const WHEEL = evidenceOf(environment.python.wheelExtension)[0]?.value ?? '.whl';

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string');
}

function isWheel(location: string): boolean {
  return (location.split(/[?#]/u, 1)[0] ?? '').toLowerCase().endsWith(WHEEL);
}

function entry(name: string, spec: string, source: Source, builds: boolean | undefined, line: number | undefined): LockEntry {
  return { name: normalizePythonName(name), spec, source, installScript: builds, anchor: name, ...(line === undefined ? {} : { line }) };
}

/** uv.lock: [[package]] with source = { registry | git | url | path | directory | editable | virtual = ... }. */
export function uvEntries(input: string, format: Format, workspaces: readonly string[]): LockEntry[] {
  const document = parseToml(input);
  const keys = isRecord(format['sources']) ? format['sources'] : {};
  const kind = (source: Record<string, unknown>): [string, string] | undefined =>
    Object.entries(keys).flatMap(([name, key]) => (typeof key === 'string' && typeof source[key] === 'string' ? [[name, source[key] as string] as [string, string]] : []))[0];
  const members = new Set(['.', ...workspaces]);
  return list(document.root[String(format['packages'])]).flatMap((item, index): LockEntry[] => {
    if (!isRecord(item) || typeof item['name'] !== 'string') return [];
    const line = document.lineOf([String(format['packages']), index]);
    const found = isRecord(item['source']) ? kind(item['source']) : undefined;
    if (found === undefined) return [entry(item['name'], 'no source given', 'unknown', undefined, line)];
    const [name, location] = found;
    const wheels = list(item[String(format['wheels'])]);
    switch (name) {
      case 'registry':
        return [entry(item['name'], location, 'registry', item[String(format['sdist'])] !== undefined && wheels.length === 0, line)];
      case 'git':
        return [entry(item['name'], location, 'git', true, line)];
      case 'remoteTarball':
        return [entry(item['name'], location, 'remoteTarball', !isWheel(location), line)];
      case 'file':
        return [entry(item['name'], location, 'file', !isWheel(location), line)];
      case 'directory':
      case 'editable':
        return members.has(location) ? [entry(item['name'], location, 'workspace', false, line)] : [entry(item['name'], location, 'directory', true, line)];
      case 'virtual':
        return [entry(item['name'], location, 'workspace', false, line)];
      default:
        return [entry(item['name'], location, 'unknown', undefined, line)];
    }
  });
}

/** poetry.lock: [[package]] without [package.source] comes from PyPI; files list every distribution. */
export function poetryEntries(input: string, format: Format): LockEntry[] {
  const document = parseToml(input);
  const types = isRecord(format['sources']) ? format['sources'] : {};
  const kindOf = (type: string): string | undefined => Object.entries(types).find(([, value]) => value === type)?.[0];
  return list(document.root[String(format['packages'])]).flatMap((item, index): LockEntry[] => {
    if (!isRecord(item) || typeof item['name'] !== 'string') return [];
    const line = document.lineOf([String(format['packages']), index]);
    const files = list(item[String(format['files'])]).map((file) => (isRecord(file) ? text(file['file']) : undefined)).filter((file): file is string => file !== undefined);
    const source = item[String(format['source'])];
    if (!isRecord(source)) return [entry(item['name'], 'PyPI', 'registry', files.length > 0 && !files.some(isWheel), line)];
    const url = text(source['url']) ?? '';
    const kind = kindOf(text(source['type']) ?? '');
    switch (kind) {
      case 'registry':
        return [entry(item['name'], text(source['reference']) ?? url, 'registry', files.length > 0 && !files.some(isWheel), line)];
      case 'git':
        return [entry(item['name'], url, 'git', true, line)];
      case 'remoteTarball':
      case 'file':
        return [entry(item['name'], url, kind, !isWheel(url), line)];
      case 'directory':
        return [entry(item['name'], url, 'directory', true, line)];
      default:
        return [entry(item['name'], `${text(source['type']) ?? 'unknown'} ${url}`.trim(), 'unknown', undefined, line)];
    }
  });
}

/** pylock.toml (PEP 751): each [[packages]] has one of vcs, directory, archive, or sdist and wheels from an index. */
export function pylockEntries(input: string, format: Format): LockEntry[] {
  const document = parseToml(input);
  const key = (name: string) => String(format[name]);
  return list(document.root[key('packages')]).flatMap((item, index): LockEntry[] => {
    if (!isRecord(item) || typeof item['name'] !== 'string') return [];
    const line = document.lineOf([key('packages'), index]);
    const location = (value: unknown) => (isRecord(value) ? (text(value['url']) ?? text(value['path']) ?? '') : '');
    const vcs = item[key('vcs')];
    if (isRecord(vcs)) return [entry(item['name'], location(vcs), text(vcs['type']) === 'git' ? 'git' : 'unknown', true, line)];
    const directory = item[key('directory')];
    if (isRecord(directory)) return [entry(item['name'], location(directory), 'directory', true, line)];
    const archive = item[key('archive')];
    if (isRecord(archive)) {
      const where = location(archive);
      return [entry(item['name'], where, text(archive['url']) !== undefined ? 'remoteTarball' : 'file', !isWheel(where), line)];
    }
    const wheels = list(item[key('wheels')]);
    const sdist = item[key('sdist')];
    if (wheels.length === 0 && !isRecord(sdist)) return [entry(item['name'], 'no source given', 'unknown', undefined, line)];
    return [entry(item['name'], text(item[key('index')]) ?? 'an index', 'registry', isRecord(sdist) && wheels.length === 0, line)];
  });
}

/** The logical lines of a requirements file: continuations joined, comments removed, with the line each starts on. */
export function requirementsLines(input: string, format: Format): { text: string; line: number }[] {
  const comment = String(format['comment']);
  const continuation = String(format['continuation']);
  // A comment starts at # preceded by whitespace (or at the start of the line).
  const commentPattern = new RegExp(`(^|\\s)${comment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}.*$`, 'u');
  const lines = input.split(/\r?\n/u);
  const result: { text: string; line: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    let line = (lines[index] ?? '').replace(commentPattern, '');
    while (line.trimEnd().endsWith(continuation) && index + 1 < lines.length) {
      index += 1;
      line = `${line.trimEnd().slice(0, -continuation.length)} ${(lines[index] ?? '').replace(commentPattern, '')}`;
    }
    const text = line.trim();
    if (text !== '') result.push({ text, line: start + 1 });
  }
  return result;
}

const PYTHON_NAME = new RegExp(evidenceOf(environment.python.namePattern)[0]?.value ?? '^[A-Za-z0-9][A-Za-z0-9._-]*$', 'iu');

/** A pip requirements file: VCS and URL requirements, local paths and registry requirements (which may or may not have wheels). */
export function requirementsEntries(input: string, format: Format): LockEntry[] {
  const vcs = isRecord(format['vcs']) ? format['vcs'] : {};
  const gitPrefixes = strings(vcs['git']);
  const otherPrefixes = strings(vcs['other']);
  const direct = String(format['direct']);
  const editable = strings(format['editable']);
  const entries: LockEntry[] = [];
  for (const { text: body, line: lineNumber } of requirementsLines(input, format)) {
    let requirement = body;
    const flag = editable.find((option) => requirement.startsWith(`${option} `) || requirement.startsWith(`${option}=`));
    if (flag !== undefined) requirement = requirement.slice(flag.length + 1).trim();
    else if (requirement.startsWith('-')) continue;
    requirement = (requirement.split(/\s+--?[a-z]/u, 1)[0] ?? requirement).split(';', 1)[0]?.trim() ?? requirement;
    // name @ URL (PEP 508); the name has no : or +, so a URL with user@host is not taken for one.
    const reference = new RegExp(`^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\[[^\\]]*\\])?\\s*${direct.trim()}\\s*(.+)$`, 'u').exec(requirement);
    const target = reference?.[2] ?? requirement;
    // The name comes from "name @" or #egg=; a guess from a file or directory name could match the allow-list for
    // the wrong code, so a requirement without either stays unnamed and is shown by its location.
    const add = (location: string, source: Source, builds: boolean | undefined) => {
      const name = reference?.[1] ?? /#egg=([^&\s]+)/u.exec(target)?.[1];
      entries.push(name !== undefined && PYTHON_NAME.test(name) ? entry(name, target, source, builds, lineNumber) : { ...entry('', target, source, builds, lineNumber), name: location, unnamed: true });
    };
    if (gitPrefixes.some((prefix) => target.startsWith(prefix))) add(target, 'git', true);
    else if (otherPrefixes.some((prefix) => target.startsWith(prefix))) add(target, 'unknown', true);
    else if (/^https?:\/\//u.test(target)) add(target, 'remoteTarball', !isWheel(target));
    else if (/^(\.{1,2}(\/|$)|\/|file:)/u.test(target) || flag !== undefined) {
      const path = target.replace(/^file:(\/\/)?/u, '');
      // The project itself (-e . or .) is built as part of the work on it, not as a dependency.
      if (/^\.\/?$/u.test(path)) {
        entries.push({ ...entry('', target, 'workspace', false, lineNumber), name: '.' });
        continue;
      }
      const archive = /\.(?:whl|zip|tar\.gz|tgz|tar\.bz2|tar)$/iu.test(path);
      add(path, archive ? 'file' : 'directory', archive ? !isWheel(path) : true);
    } else {
      const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(requirement)?.[0];
      if (name !== undefined) entries.push(entry(name, requirement, 'registry', undefined, lineNumber));
    }
  }
  return entries;
}

