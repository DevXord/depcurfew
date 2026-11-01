// The depcurfew a project installs, so that an older copy running elsewhere (a global install, an old npx cache)
// can say so: it may not know settings the project's version writes or checks.
import { compareVersions, parseVersion } from './apply/version.ts';
import type { Repository } from './detect/repository.ts';
import { getVersion } from './version.ts';

const NAME = 'depcurfew';

/**
 * The tools directory the README recommends for a repository without package.json in its root: depcurfew pinned in
 * its own package.json and package-lock.json there (decision D-116).
 */
export const TOOLS_DIRECTORY = '.claude/depcurfew';

/** The project's copy as the hook of the README runs it, relative to its directory. */
export const INSTALLED_CLI = `node_modules/${NAME}/dist/cli.js`;

export interface ProjectCopy {
  version: string;
  /** Where the version was read, relative to the project root. */
  file: string;
  line?: number;
  /** The directory it is installed or pinned in: the project itself (absent), or TOOLS_DIRECTORY. */
  directory?: string;
}

function lineOf(text: string, needle: string): number | undefined {
  const index = text.indexOf(needle);
  return index < 0 ? undefined : text.slice(0, index).split('\n').length;
}

function versionIn(text: string, read: (document: unknown) => unknown): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const version = read(document);
  return typeof version === 'string' && parseVersion(version) !== undefined ? version : undefined;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

/** The copy of one directory: installed in node_modules, else the version package-lock.json records. */
function copyIn(repository: Repository, directory: string | undefined): ProjectCopy | undefined {
  const prefix = directory === undefined ? '' : `${directory}/`;
  const at = directory === undefined ? {} : { directory };
  const manifest = `${prefix}node_modules/${NAME}/package.json`;
  const installedText = repository.isFile(manifest) ? repository.readText(manifest) : undefined;
  if (installedText !== undefined) {
    const version = versionIn(installedText, (document) => field(document, 'version'));
    if (version !== undefined) return { version, file: manifest, ...lineAt(installedText, '"version"'), ...at };
  }
  const lockfile = `${prefix}package-lock.json`;
  const lockText = repository.isFile(lockfile) ? repository.readText(lockfile) : undefined;
  if (lockText !== undefined) {
    const key = `node_modules/${NAME}`;
    const version = versionIn(lockText, (document) => field(field(field(document, 'packages'), key), 'version'));
    if (version !== undefined) return { version, file: lockfile, ...lineAt(lockText, `"${key}"`), ...at };
  }
  return undefined;
}

/**
 * The newest copy of depcurfew the repository installs or pins: in the project (node_modules, else package-lock.json)
 * or in the tools directory of the README (TOOLS_DIRECTORY, decision D-116); undefined when neither has one.
 */
export function projectCopy(repository: Repository): ProjectCopy | undefined {
  const copies = [copyIn(repository, undefined), copyIn(repository, TOOLS_DIRECTORY)].filter((copy): copy is ProjectCopy => copy !== undefined);
  return copies.reduce<ProjectCopy | undefined>((newest, copy) => (newest === undefined || isNewer(copy.version, newest.version) ? copy : newest), undefined);
}

function isNewer(version: string, than: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(than);
  return a !== undefined && b !== undefined && compareVersions(a, b) > 0;
}

function lineAt(text: string, needle: string): { line?: number } {
  const line = lineOf(text, needle);
  return line === undefined ? {} : { line };
}

/**
 * The warning about a newer project copy, the same in apply and doctor. A version read from package-lock.json is not
 * installed yet, and npx would fetch a registry or cached copy instead, so the fix installs it first. `line` puts the
 * line into the message, for apply's text output, which shows no location.
 */
export function outdatedText(copy: ProjectCopy, command: 'apply' | 'doctor', line = false): { message: string; fix: string } {
  const at = line && copy.line !== undefined ? `, line ${copy.line}` : '';
  const pinned = copy.file.endsWith('package-lock.json');
  const where = pinned
    ? `is pinned in ${copy.file}${line && copy.line !== undefined ? ` (line ${copy.line})` : ''}`
    : `is installed in ${copy.directory ?? 'the project'} (${copy.file}${at})`;
  const knows = command === 'apply' ? 'settings that version writes' : 'settings that version writes or checks';
  const runner = command === 'apply' ? 'apply' : 'this check';
  const update = `update the depcurfew you run to ${copy.version} or later`;
  // The tools directory has no npx of its own: its copy runs by path, as the hook of the README runs it.
  const tools = copy.directory === undefined ? undefined : `node ${copy.directory}/${INSTALLED_CLI} ${command}`;
  return {
    message: `depcurfew ${copy.version} ${where}, but the depcurfew running ${runner} is older, so it may not know ${knows}`,
    fix:
      tools !== undefined
        ? pinned
          ? `Install it in ${copy.directory} (cd ${copy.directory} && npm ci --ignore-scripts), then run that copy (${tools}), or ${update}`
          : `Run that copy (${tools}), or ${update}`
        : pinned
          ? `Install the project's dependencies (npm ci), then run its copy (npx depcurfew ${command}), or ${update}`
          : `Run the project's copy (npx depcurfew ${command}), or ${update}`,
  };
}

/** Whether the project's copy is newer than the depcurfew that runs. */
export function isNewerThanRunning(copy: ProjectCopy, running: string = getVersion()): boolean {
  const pinned = parseVersion(copy.version);
  const current = parseVersion(running);
  return pinned !== undefined && current !== undefined && compareVersions(pinned, current) > 0;
}
