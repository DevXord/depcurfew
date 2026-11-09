// npx, npm exec and npm x without a package option run a program of the project when there is one, and download nothing
// then (decision D-185). As libnpmexec looks (extra.localBinaries of the npm knowledge): first for a bin of that name in
// the package.json of npm's local prefix and of the workspace the command runs in, which npx installs into its cache
// with that package's dependencies; then for a file of that name in node_modules/.bin of the workspace (or of the
// local prefix) and of every directory above it, which it runs as it is. Only a file found in the second way, with no
// such bin and nothing depcurfew could not read on the way, lets the hook leave the request out; anything else is
// checked as a package, as before.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { values } from '../apply/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { LocalBinariesKnowledge } from '../knowledge/types.ts';
import { readLimited } from '../read-limited.ts';
import { MAX_CONFIG_SIZE, npmLocalPrefix } from './registry-settings.ts';

/** How many directories up from the start the program is looked for; deeper trees are checked as a package. */
const MAX_LEVELS = 256;

function facts(): LocalBinariesKnowledge | undefined {
  const fact = knowledgeBase.find((tool) => tool.id === 'npm')?.extra?.['localBinaries'];
  return fact === undefined ? undefined : (values(fact)[0] as LocalBinariesKnowledge | undefined);
}

/** The bin names a package.json declares: the keys of bin, or the name without its scope for a bin path; undefined when it cannot be read. */
function declaredBins(directory: string): { names: ReadonlySet<string>; binDirectory: boolean } | undefined {
  const read = readLimited(join(directory, 'package.json'), MAX_CONFIG_SIZE);
  if (!read.ok) return read.problem === 'missing' ? { names: new Set(), binDirectory: false } : undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(read.bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return undefined;
  const { bin, name, directories } = manifest as Record<string, unknown>;
  const names = new Set<string>();
  if (typeof bin === 'string') {
    if (typeof name !== 'string') return undefined;
    names.add(name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name);
  } else if (typeof bin === 'object' && bin !== null) {
    for (const key of Object.keys(bin)) names.add(key);
  } else if (bin !== undefined) {
    return undefined;
  }
  // directories.bin makes every file of that directory a bin, which depcurfew does not list.
  const binDirectory = typeof directories === 'object' && directories !== null && Object.hasOwn(directories, 'bin');
  return { names, binDirectory };
}

/** Whether `path` is a regular file, following links; a link to nothing is not. */
function isProgram(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * Whether npx `name`, run in `start` (with npm --prefix: `start` is that prefix), runs a program of node_modules/.bin
 * without downloading anything.
 */
export function runsLocalBinary(start: string, name: string, options: { prefix?: boolean } = {}): boolean {
  const fact = facts();
  if (fact === undefined) return false;
  let from: string;
  let manifests: string[];
  if (options.prefix === true) {
    from = resolve(start);
    manifests = [from];
  } else {
    const local = npmLocalPrefix(start);
    // A root whose workspaces depcurfew could not match may make npm look elsewhere.
    if ((local.unsure?.length ?? 0) > 0 || (local.workspace !== undefined && local.exact !== true)) return false;
    from = local.workspace ?? local.prefix;
    manifests = [...new Set([from, local.prefix])];
  }
  for (const directory of manifests) {
    const declared = declaredBins(directory);
    if (declared === undefined || declared.binDirectory || declared.names.has(name)) return false;
  }
  let directory = from;
  for (let level = 0; level < MAX_LEVELS; level++) {
    if (isProgram(join(directory, ...fact.directory.split('/'), name))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return false;
}
