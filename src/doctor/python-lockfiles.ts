// Python lockfiles for doctor: uv.lock, poetry.lock, pdm.lock, Pipfile.lock, pylock.toml and pip requirements files.
// Each package gets its source (registry, git, URL, local archive or directory, workspace) and whether installing it
// builds it from source, which runs its build code (decision D-065: the Python counterpart of install scripts). Key
// names come from the knowledge base (extra.lockfileFormat, extra.requirementsFormat).
import { isRecord, values } from '../apply/facts.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { environment } from '../knowledge/environment.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { parseToml } from '../detect/toml.ts';
import type { LockEntry, Source } from './lockfiles.ts';

type Format = Record<string, unknown>;

const WHEEL = evidenceOf(environment.python.wheelExtension)[0]?.value ?? '.whl';
const SDISTS = evidenceOf(environment.python.sourceDistributionExtensions)[0]?.value ?? [];

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

/** pdm.lock: [[package]] with files from an index, or a VCS repository (git = …), a url or a local path instead. */
export function pdmEntries(input: string, format: Format): LockEntry[] {
  const document = parseToml(input);
  const key = (name: string) => String(format[name]);
  const vcs = strings(format['vcs']);
  return list(document.root[key('packages')]).flatMap((item, index): LockEntry[] => {
    if (!isRecord(item) || typeof item['name'] !== 'string') return [];
    const line = document.lineOf([key('packages'), index]);
    const repository = vcs.find((name) => typeof item[name] === 'string');
    if (repository !== undefined) return [entry(item['name'], String(item[repository]), repository === 'git' ? 'git' : 'unknown', true, line)];
    const url = text(item[key('url')]);
    if (url !== undefined) return [entry(item['name'], url, 'remoteTarball', !isWheel(url), line)];
    const path = text(item[key('path')]);
    if (path !== undefined) {
      const archive = [WHEEL, ...SDISTS].some((extension) => path.toLowerCase().endsWith(extension));
      return [entry(item['name'], path, archive ? 'file' : 'directory', archive ? !isWheel(path) : true, line)];
    }
    const files = list(item[key('files')]).map((file) => (isRecord(file) ? text(file[key('file')]) : undefined)).filter((file): file is string => file !== undefined);
    return [entry(item['name'], 'an index', 'registry', files.length > 0 && !files.some(isWheel), line)];
  });
}

/**
 * Pipfile.lock: every key but _meta is a category of packages. Git, remote file and local path entries are built;
 * for index packages the hashes do not tell wheels from source distributions, so whether they are built is unknown.
 */
export function pipfileLockEntries(input: string, format: Format): LockEntry[] {
  const document = JSON.parse(input) as unknown;
  if (!isRecord(document)) throw new Error('Pipfile.lock is not a JSON object');
  const key = (name: string) => String(format[name]);
  const entries: LockEntry[] = [];
  for (const [category, packages] of Object.entries(document)) {
    if (category === key('meta') || !isRecord(packages)) continue;
    for (const [name, item] of Object.entries(packages)) {
      if (!isRecord(item)) continue;
      const git = text(item[key('git')]);
      const file = text(item[key('file')]);
      const path = text(item[key('path')]);
      // The line is looked up by the quoted name, the way it is written in the lockfile.
      const anchored = (found: LockEntry): LockEntry => ({ ...found, anchor: JSON.stringify(name) });
      if (git !== undefined) entries.push(anchored(entry(name, git, 'git', true, undefined)));
      else if (file !== undefined) entries.push(anchored(entry(name, file, 'remoteTarball', !isWheel(file), undefined)));
      // The project itself (pipenv install -e . writes path "."), as -e . in a requirements file.
      else if (path !== undefined && isProject(path)) entries.push(anchored(entry(name, path, 'workspace', false, undefined)));
      else if (path !== undefined) entries.push(anchored(entry(name, path, 'directory', true, undefined)));
      else entries.push(anchored(entry(name, 'an index', 'registry', undefined, undefined)));
    }
  }
  return entries;
}

/** "." or "./": the project itself, relative to the lockfile at its root. */
function isProject(path: string): boolean {
  return /^\.\/?$/u.test(path);
}

/**
 * pylock.toml (PEP 751): each [[packages]] has one of vcs, directory, archive, or sdist and wheels from an index. A
 * directory path is relative to the lock file, so "." is the project itself, which, like a workspace member, is part
 * of the work on the project rather than a dependency built from source.
 */
export function pylockEntries(input: string, format: Format, workspaces: readonly string[] = []): LockEntry[] {
  const document = parseToml(input);
  const key = (name: string) => String(format[name]);
  return list(document.root[key('packages')]).flatMap((item, index): LockEntry[] => {
    if (!isRecord(item) || typeof item['name'] !== 'string') return [];
    const line = document.lineOf([key('packages'), index]);
    const location = (value: unknown) => (isRecord(value) ? (text(value['url']) ?? text(value['path']) ?? '') : '');
    const vcs = item[key('vcs')];
    if (isRecord(vcs)) return [entry(item['name'], location(vcs), text(vcs['type']) === 'git' ? 'git' : 'unknown', true, line)];
    const directory = item[key('directory')];
    if (isRecord(directory)) {
      const path = location(directory);
      const relative = path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
      const member = isProject(path) || relative === '' || workspaces.includes(relative);
      return [entry(item['name'], path, member ? 'workspace' : 'directory', !member, line)];
    }
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
    // The logical line in parts, joined once at the end: joining a growing text for every continuation line takes
    // minutes on a file of many short continued lines. Trailing whitespace is trimmed as it is checked, since the
    // logical line is trimmed in the end anyway.
    const parts = [(lines[index] ?? '').replace(commentPattern, '')];
    const trimEnd = () => {
      while (parts.length > 0) {
        const last = (parts.at(-1) ?? '').trimEnd();
        if (last !== '') {
          parts[parts.length - 1] = last;
          return;
        }
        parts.pop();
      }
    };
    trimEnd();
    while ((parts.at(-1) ?? '').endsWith(continuation) && index + 1 < lines.length) {
      index += 1;
      parts[parts.length - 1] = (parts.at(-1) ?? '').slice(0, -continuation.length);
      parts.push(' ', (lines[index] ?? '').replace(commentPattern, ''));
      trimEnd();
    }
    const text = parts.join('').trim();
    if (text !== '') result.push({ text, line: start + 1 });
  }
  return result;
}

const PYTHON_NAME = new RegExp(evidenceOf(environment.python.namePattern)[0]?.value ?? '^[A-Za-z0-9][A-Za-z0-9._-]*$', 'iu');

/** The facts about pip requirements files in one record: syntax, includes (-r, -c) and how pip tells paths and URLs. */
export function requirementsFormatOf(tool: ToolKnowledge): Format {
  const record = (key: string): Format => {
    const fact = tool.extra?.[key];
    const value = fact === undefined ? undefined : values(fact)[0];
    return isRecord(value) ? value : {};
  };
  return { ...record('requirementsFormat'), includes: record('requirementsIncludes'), paths: record('requirementsPaths') };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The requirements and constraints files a requirements file includes (-r, -c), as written, with their lines. */
export function requirementsIncludes(input: string, format: Format): { path: string; line: number }[] {
  const includes = isRecord(format['includes']) ? format['includes'] : {};
  const options = [...strings(includes['requirements']), ...strings(includes['constraints'])];
  // -r file, -rfile, --requirement file and --requirement=file, as optparse reads them.
  const short = options.filter((option) => !option.startsWith('--')).map(escapeRegExp);
  const long = options.filter((option) => option.startsWith('--')).map(escapeRegExp);
  const pattern = new RegExp(`^(?:(?:${short.join('|') || '(?!)'})\\s*|(?:${long.join('|') || '(?!)'})(?:\\s+|=))(\\S+)`, 'u');
  return requirementsLines(input, format).flatMap(({ text: body, line }) => {
    const path = pattern.exec(body)?.[1];
    return path === undefined ? [] : [{ path, line }];
  });
}

/** Where one requirement comes from, as pip reads it. */
export interface RequirementSource {
  source: Source;
  /** The URL or path, or the whole requirement for a registry package. */
  target: string;
  /** From "name @", #egg= or, for a registry package, the requirement itself; undefined when the requirement has no name. */
  name?: string;
  /** Whether installing it builds it from source; undefined when the index decides (a registry package). */
  builds: boolean | undefined;
}

/**
 * Classifies one requirement (without options or environment markers): a VCS URL, a URL, a local archive or
 * directory, the project itself, or a registry package. `editable` is set for the value of -e, which is always a path
 * or a VCS URL.
 */
export function requirementSource(requirement: string, format: Format, editable: boolean): RequirementSource {
  const vcs = isRecord(format['vcs']) ? format['vcs'] : {};
  const gitPrefixes = strings(vcs['git']);
  const otherPrefixes = strings(vcs['other']);
  const egg = new RegExp(`${escapeRegExp(String(format['egg']))}([^&\\s]+)`, 'u');
  const paths = isRecord(format['paths']) ? format['paths'] : {};
  const separators = strings(paths['separators']);
  const currentDirectory = String(paths['currentDirectory']);
  const archives = strings(paths['archiveExtensions']);
  const urlSchemes = new RegExp(`^(?:${strings(paths['urlSchemes']).map(escapeRegExp).join('|') || '(?!)'})://`, 'iu');
  const fileScheme = new RegExp(`^${escapeRegExp(String(paths['fileScheme']))}(//)?`, 'iu');
  // name @ URL (PEP 508); the name has no : or +, so a URL with user@host is not taken for one.
  const reference = new RegExp(`^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\[[^\\]]*\\])?\\s*${escapeRegExp(String(format['direct']).trim())}\\s*(.+)$`, 'u');
  // pip takes anything with a path separator, or starting with ., for a path, and an archive name for a file.
  const looksLikePath = (text: string) => separators.some((separator) => text.includes(separator)) || text.startsWith(currentDirectory);
  const isArchive = (text: string) => archives.some((extension) => text.toLowerCase().endsWith(extension));
  const named = reference.exec(requirement);
  const target = named?.[2] ?? requirement;
  // The name comes from "name @" or #egg=; a guess from a file or directory name could match the allow-list for
  // the wrong code, so a requirement without either stays unnamed.
  const name = named?.[1] ?? egg.exec(target)?.[1];
  const located = (source: Source, location: string, builds: boolean): RequirementSource => ({
    source,
    target: location,
    ...(name !== undefined && PYTHON_NAME.test(name) ? { name } : {}),
    builds,
  });
  if (gitPrefixes.some((prefix) => target.startsWith(prefix))) return located('git', target, true);
  if (otherPrefixes.some((prefix) => target.startsWith(prefix))) return located('unknown', target, true);
  if (urlSchemes.test(target)) return located('remoteTarball', target, !isWheel(target));
  if (fileScheme.test(target) || looksLikePath(target) || isArchive(target) || editable) {
    const path = target.replace(fileScheme, '');
    // The project itself (-e . or .) is built as part of the work on it, not as a dependency.
    if (/^\.\/?$/u.test(path)) return { source: 'workspace', target, name: '.', builds: false };
    const archive = isArchive(path);
    return located(archive ? 'file' : 'directory', path, archive ? !isWheel(path) : true);
  }
  const registryName = /^[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(requirement)?.[0];
  return { source: 'registry', target: requirement, ...(registryName === undefined ? {} : { name: registryName }), builds: undefined };
}

/** A pip requirements file: VCS and URL requirements, local paths and registry requirements (which may or may not have wheels). */
export function requirementsEntries(input: string, format: Format): LockEntry[] {
  const editable = strings(format['editable']);
  const entries: LockEntry[] = [];
  for (const { text: body, line: lineNumber } of requirementsLines(input, format)) {
    let requirement = body;
    const flag = editable.find((option) => requirement.startsWith(`${option} `) || requirement.startsWith(`${option}=`));
    if (flag !== undefined) requirement = requirement.slice(flag.length + 1).trim();
    else if (requirement.startsWith('-')) continue;
    requirement = (requirement.split(/\s+--?[a-z]/u, 1)[0] ?? requirement).split(';', 1)[0]?.trim() ?? requirement;
    const found = requirementSource(requirement, format, flag !== undefined);
    if (found.source === 'workspace') {
      entries.push({ ...entry('', found.target, 'workspace', false, lineNumber), name: '.' });
    } else if (found.source === 'registry') {
      if (found.name !== undefined) entries.push(entry(found.name, requirement, 'registry', undefined, lineNumber));
    } else if (found.name !== undefined) {
      entries.push(entry(found.name, found.target, found.source, found.builds, lineNumber));
    } else {
      entries.push({ ...entry('', found.target, found.source, found.builds, lineNumber), name: found.target, unnamed: true });
    }
  }
  return entries;
}
