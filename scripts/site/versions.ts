// The documentation of earlier releases (decision D-139). With `npm run site -- --versions` the site reads the
// release tags of the git repository (git tag --list 'v*') and gives each release from 1.1.0 on that is older than
// the version being built a directory /<version>/ with the README.md, docs/knowledge.md, CHANGELOG.md section and
// schema.json of its tag, read with git cat-file. Without the option, or without tags, only the current version is
// built. A tag that is not archived is named on stderr with the reason.
import { execFileSync } from 'node:child_process';

/** The oldest version whose documentation the site keeps. */
export const FIRST_ARCHIVED_VERSION = '1.1.0';

export interface ArchivedVersion {
  /** The version without the `v`, also the name of its directory. */
  version: string;
  tag: string;
  readme: string;
  knowledge?: string;
  /** The whole CHANGELOG.md of the tag; the site shows the section of the version. */
  changelog?: string;
  schema?: Buffer;
  /** From package.json of the tag. */
  description?: string;
  license?: string;
  /** The https address of the repository in package.json of the tag, whose file links are rewritten too. */
  repository?: string;
}

export interface SiteArguments {
  versions: boolean;
}

/** The arguments of npm run site: only --versions. */
export function siteArguments(args: readonly string[]): SiteArguments {
  const unknown = args.find((arg) => arg !== '--versions');
  if (unknown !== undefined) throw new Error(`site: unknown argument ${unknown}; npm run site takes only --versions (npm run site -- --versions)`);
  return { versions: args.includes('--versions') };
}

// A release tag: v<major>.<minor>.<patch>, with a pre-release part only for pre-releases. The version is a safe
// directory name: digits and dots.
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u;

function parts(version: string): number[] {
  return version.split('.').map(Number);
}

/** Compares two versions major.minor.patch. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The https address of the repository from the `repository` field of package.json, or undefined. */
export function repositoryUrl(repository: unknown): string | undefined {
  const url = typeof repository === 'string' ? repository : typeof repository === 'object' && repository !== null ? (repository as { url?: unknown }).url : undefined;
  if (typeof url !== 'string') return undefined;
  const plain = url.replace(/^git\+/u, '').replace(/\.git$/u, '');
  return /^https:\/\/[^\s/]+\/[^\s]+$/u.test(plain) ? plain : undefined;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function git(directory: string, args: readonly string[]): Buffer {
  return execFileSync('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
}

/** A file at a tag, as it is stored, or undefined when the tag has none. */
function show(directory: string, tag: string, path: string): Buffer | undefined {
  try {
    return git(directory, ['cat-file', 'blob', `${tag}:${path}`]);
  } catch {
    return undefined;
  }
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = Buffer.isBuffer(stderr) && stderr.length > 0 ? stderr.toString('utf8') : error instanceof Error ? error.message : String(error);
  return text.trim().split('\n')[0] ?? '';
}

/**
 * The earlier versions to archive from the release tags of the git repository in `directory`, newest first. `current`
 * is the version being built, whose documentation is the root of the site; every tag that is left out is named in a
 * line passed to `report`.
 */
export function readVersions(directory: string, current: string, report: (line: string) => void): ArchivedVersion[] {
  let tags: string[];
  try {
    tags = git(directory, ['tag', '--list', 'v*'])
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch (error) {
    report(`site: cannot read the git tags in ${directory} (${firstLine(error)}), so only the current version is built`);
    return [];
  }
  if (tags.length === 0) {
    report(`site: no tags v* in ${directory}, so only the current version is built`);
    return [];
  }
  const versions: ArchivedVersion[] = [];
  for (const tag of tags) {
    const match = TAG.exec(tag);
    if (match === null) {
      report(`site: skipped tag ${tag}: it is not a release tag v<major>.<minor>.<patch>`);
      continue;
    }
    if (match[4] !== undefined) {
      report(`site: skipped tag ${tag}: it is a pre-release`);
      continue;
    }
    const version = tag.slice(1);
    if (compareVersions(version, FIRST_ARCHIVED_VERSION) < 0) {
      report(`site: skipped tag ${tag}: the site keeps the documentation of ${FIRST_ARCHIVED_VERSION} and later only`);
      continue;
    }
    // The tag of the version being built is the root of the site.
    if (compareVersions(version, current) === 0) continue;
    if (compareVersions(version, current) > 0) {
      report(`site: skipped tag ${tag}: it is newer than the version being built, ${current}`);
      continue;
    }
    const readme = show(directory, tag, 'README.md');
    if (readme === undefined) {
      report(`site: skipped tag ${tag}: it has no README.md`);
      continue;
    }
    const knowledge = show(directory, tag, 'docs/knowledge.md');
    if (knowledge === undefined) report(`site: tag ${tag} has no docs/knowledge.md, so ${version}/ has no knowledge base page`);
    const changelog = show(directory, tag, 'CHANGELOG.md');
    if (changelog === undefined) report(`site: tag ${tag} has no CHANGELOG.md, so ${version}/ has no changes page`);
    const schema = show(directory, tag, 'schema.json');
    if (schema === undefined) report(`site: tag ${tag} has no schema.json, so ${version}/ has no schema`);
    let manifest: { description?: unknown; license?: unknown; repository?: unknown } = {};
    try {
      manifest = JSON.parse(show(directory, tag, 'package.json')?.toString('utf8') ?? '{}') as typeof manifest;
    } catch {
      // A package.json that is not JSON gives no description, license or repository.
    }
    versions.push({
      version,
      tag,
      readme: readme.toString('utf8'),
      ...(knowledge === undefined ? {} : { knowledge: knowledge.toString('utf8') }),
      ...(changelog === undefined ? {} : { changelog: changelog.toString('utf8') }),
      ...(schema === undefined ? {} : { schema }),
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
      ...(repositoryUrl(manifest.repository) === undefined ? {} : { repository: repositoryUrl(manifest.repository) as string }),
    });
  }
  return versions.sort((a, b) => compareVersions(b.version, a.version));
}
