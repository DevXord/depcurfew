// Expands workspace patterns into package directories with a small, conservative glob matcher: `*` matches
// within one path segment, `**` matches any number of segments, and a leading `!` excludes matches.
import { isAbsoluteAnywhere } from '../paths.ts';
import { joinPath, type Repository } from './repository.ts';
import { wildcardMatch } from './wildcard.ts';

type Segment = { kind: 'any-depth' } | { kind: 'pattern'; pattern: string };

function segmentsOf(pattern: string): Segment[] {
  const segments: Segment[] = [];
  for (const segment of pattern.split('/')) {
    if (segment === '' || segment === '.') continue;
    // Consecutive ** match the same directories as one.
    if (segment === '**') {
      if (segments.at(-1)?.kind !== 'any-depth') segments.push({ kind: 'any-depth' });
    } else {
      segments.push({ kind: 'pattern', pattern: segment });
    }
  }
  return segments;
}

/**
 * Adds to `found` the directories under `directory` that match the segments from `index` on. Each pair of directory
 * and segment is visited once, so several ** in one pattern cannot multiply the walk.
 */
function matchDirectories(repository: Repository, segments: readonly Segment[], index: number, directory: string, found: Set<string>, visited: Set<string>): void {
  const key = `${index}\0${directory}`;
  if (visited.has(key)) return;
  visited.add(key);
  const segment = segments[index];
  if (segment === undefined) {
    found.add(directory);
    return;
  }
  if (segment.kind === 'any-depth') {
    matchDirectories(repository, segments, index + 1, directory, found, visited);
    for (const child of repository.listDirectories(directory)) {
      matchDirectories(repository, segments, index, joinPath(directory, child), found, visited);
    }
    return;
  }
  for (const child of repository.listDirectories(directory)) {
    if (wildcardMatch(child, segment.pattern)) matchDirectories(repository, segments, index + 1, joinPath(directory, child), found, visited);
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
    if (isAbsoluteAnywhere(pattern) || pattern.split('/').includes('..')) {
      repository.warn('workspace-outside-repository', `workspace pattern "${raw}" points outside the repository`, [declaredIn]);
      continue;
    }
    matchDirectories(repository, segmentsOf(pattern), 0, '.', negated ? excluded : included, new Set());
  }
  return [...included]
    .filter((directory) => directory !== '.' && !excluded.has(directory))
    .filter((directory) => manifests.some((manifest) => repository.isFile(joinPath(directory, manifest))))
    .sort();
}
