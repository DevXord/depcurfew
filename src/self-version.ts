// The depcurfew a project installs, so that an older copy running elsewhere (a global install, an old npx cache)
// can say so: it may not know settings the project's version writes or checks.
import { compareVersions, parseVersion } from './apply/version.ts';
import type { Repository } from './detect/repository.ts';
import { getVersion } from './version.ts';

const NAME = 'depcurfew';

export interface ProjectCopy {
  version: string;
  /** Where the version was read, relative to the project root. */
  file: string;
  line?: number;
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

/** The installed copy in node_modules, else the version package-lock.json records; undefined when neither has one. */
export function projectCopy(repository: Repository): ProjectCopy | undefined {
  const manifest = `node_modules/${NAME}/package.json`;
  const installedText = repository.isFile(manifest) ? repository.readText(manifest) : undefined;
  if (installedText !== undefined) {
    const version = versionIn(installedText, (document) => field(document, 'version'));
    if (version !== undefined) return { version, file: manifest, ...lineAt(installedText, '"version"') };
  }
  const lockfile = 'package-lock.json';
  const lockText = repository.isFile(lockfile) ? repository.readText(lockfile) : undefined;
  if (lockText !== undefined) {
    const key = `node_modules/${NAME}`;
    const version = versionIn(lockText, (document) => field(field(field(document, 'packages'), key), 'version'));
    if (version !== undefined) return { version, file: lockfile, ...lineAt(lockText, `"${key}"`) };
  }
  return undefined;
}

function lineAt(text: string, needle: string): { line?: number } {
  const line = lineOf(text, needle);
  return line === undefined ? {} : { line };
}

/** Whether the project's copy is newer than the depcurfew that runs. */
export function isNewerThanRunning(copy: ProjectCopy, running: string = getVersion()): boolean {
  const pinned = parseVersion(copy.version);
  const current = parseVersion(running);
  return pinned !== undefined && current !== undefined && compareVersions(pinned, current) > 0;
}
