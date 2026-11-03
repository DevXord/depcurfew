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
 * The most directories one workspace declaration lists while its patterns are matched (decision D-161). `**` lists
 * every directory under it (the excluding patterns too), so a repository with more stops the walk there, with the
 * warning workspace-search-limit; the packages found until then are kept.
 */
export const MAX_WORKSPACE_DIRECTORIES = 20_000;

/** What the patterns of one declaration share: how many directories may still be listed, and whether that ran out. */
interface Budget {
  left: number;
  reached: boolean;
}

/** One pattern on its way through the repository. */
interface Walk {
  repository: Repository;
  segments: readonly Segment[];
  /** The directories matched, each with its real path. */
  found: Map<string, string>;
  /** The pairs of segment index and real path already visited. */
  visited: Set<string>;
  budget: Budget;
}

/**
 * Adds to `found` the directories under `directory` that match the segments from `index` on. Each pair of segment and
 * directory is visited once, keyed by the real path of the directory (decision D-161): several ** in one pattern cannot
 * multiply the walk, and neither can a symlink that leads back up (s0 -> .), which would otherwise make every path
 * through it a new directory. A directory whose real path is the root is not a workspace package of itself.
 */
function matchDirectories(walk: Walk, index: number, directory: string): void {
  if (walk.budget.reached) return;
  const real = walk.repository.realPath(directory);
  if (real === undefined) return;
  const key = `${index}\0${real}`;
  if (walk.visited.has(key)) return;
  walk.visited.add(key);
  const segment = walk.segments[index];
  if (segment === undefined) {
    if (real !== walk.repository.root) walk.found.set(directory, real);
    return;
  }
  if (walk.budget.left === 0) {
    walk.budget.reached = true;
    return;
  }
  walk.budget.left -= 1;
  if (segment.kind === 'any-depth') {
    matchDirectories(walk, index + 1, directory);
    for (const child of walk.repository.listDirectories(directory)) matchDirectories(walk, index, joinPath(directory, child));
    return;
  }
  for (const child of walk.repository.listDirectories(directory, (name) => wildcardMatch(name, segment.pattern))) {
    matchDirectories(walk, index + 1, joinPath(directory, child));
  }
}

/**
 * Package directories (without the root) matched by the patterns that contain one of the manifests, each real
 * directory once, under the first of its paths in sort order. Together the patterns list at most `limit` directories
 * (MAX_WORKSPACE_DIRECTORIES).
 */
export function expandWorkspaces(
  repository: Repository,
  patterns: readonly string[],
  manifests: readonly string[],
  declaredIn: string,
  limit = MAX_WORKSPACE_DIRECTORIES,
): string[] {
  const included = new Map<string, string>();
  const excluded = new Map<string, string>();
  const budget: Budget = { left: limit, reached: false };
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (isAbsoluteAnywhere(pattern) || pattern.split('/').includes('..')) {
      repository.warn('workspace-outside-repository', `workspace pattern "${raw}" points outside the repository`, [declaredIn]);
      continue;
    }
    matchDirectories({ repository, segments: segmentsOf(pattern), found: negated ? excluded : included, visited: new Set(), budget }, 0, '.');
  }
  if (budget.reached) {
    repository.warn(
      'workspace-search-limit',
      `the workspace patterns in ${declaredIn} match more than ${limit} directories; depcurfew looked for workspace packages in the first ${limit} and not in the others`,
      [declaredIn],
    );
  }
  // A directory reached through a symlink inside the repository is one package, not one per path (decision D-161).
  const packages = new Map<string, string>();
  for (const directory of [...included.keys()].filter((path) => !excluded.has(path)).sort()) {
    const real = included.get(directory) as string;
    if (!packages.has(real) && manifests.some((manifest) => repository.isFile(joinPath(directory, manifest)))) packages.set(real, directory);
  }
  return [...packages.values()];
}
