// Expands workspace patterns into package directories with a small, conservative glob matcher: `*` matches
// within one path segment, `**` matches any number of segments, and a leading `!` excludes matches.
import { joinPath, type Repository } from './repository.ts';

type Segment = { kind: 'any-depth' } | { kind: 'pattern'; regex: RegExp };

function segmentsOf(pattern: string): Segment[] {
  return pattern
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => {
      if (segment === '**') return { kind: 'any-depth' };
      const source = segment.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*');
      return { kind: 'pattern', regex: new RegExp(`^${source}$`, 'u') };
    });
}

function matchDirectories(repository: Repository, segments: readonly Segment[], directory: string, found: Set<string>): void {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    found.add(directory);
    return;
  }
  if (segment.kind === 'any-depth') {
    matchDirectories(repository, rest, directory, found);
    for (const child of repository.listDirectories(directory)) {
      matchDirectories(repository, segments, joinPath(directory, child), found);
    }
    return;
  }
  for (const child of repository.listDirectories(directory)) {
    if (segment.regex.test(child)) matchDirectories(repository, rest, joinPath(directory, child), found);
  }
}

/** Package directories (without the root) matched by the patterns that contain one of the manifests. */
export function expandWorkspaces(
  repository: Repository,
  patterns: readonly string[],
  manifests: readonly string[],
  declaredIn: string,
): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
      repository.warn('workspace-outside-repository', `workspace pattern "${raw}" points outside the repository`, [declaredIn]);
      continue;
    }
    matchDirectories(repository, segmentsOf(pattern), '.', negated ? excluded : included);
  }
  return [...included]
    .filter((directory) => directory !== '.' && !excluded.has(directory))
    .filter((directory) => manifests.some((manifest) => repository.isFile(joinPath(directory, manifest))))
    .sort();
}
