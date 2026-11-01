// depcurfew init in a repository of independent projects (decision D-100): when the root has no manifest or lockfile
// of any tool but direct subdirectories do, init lists them under projects. The file names come from the knowledge
// base through the facts detection uses.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectionFacts } from '../detect/knowledge.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { validateProjectDirectory } from '../policy/project-directory.ts';

/** Directories init does not look into: installed packages and git's own. Dot-directories are skipped too. */
const SKIPPED = new Set(['node_modules']);

/** The manifests and lockfiles of every package manager depcurfew knows (package.json, pyproject.toml, uv.lock …). */
function projectFiles(): string[] {
  const facts = detectionFacts(knowledgeBase, environment);
  return [...new Set(facts.managers.flatMap((manager) => [...manager.manifests, ...manager.lockfiles]))].sort();
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the directory holds a manifest or lockfile of any package manager. */
function hasProject(directory: string, files: readonly string[]): boolean {
  return files.some((file) => isFile(join(directory, file)));
}

/**
 * The direct subdirectories of `root` that hold a manifest or lockfile, sorted, when the root itself holds none; an
 * empty list otherwise. Symlinks are not followed: apply refuses a project reached through one.
 */
export function proposedProjects(root: string): string[] {
  const files = projectFiles();
  if (hasProject(root, files)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    // A name the policy cannot hold (one with a colon or a *) is left out rather than written into an invalid policy.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name) && validateProjectDirectory(entry.name) === undefined)
    .map((entry) => entry.name)
    .filter((name) => hasProject(join(root, name), files))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
