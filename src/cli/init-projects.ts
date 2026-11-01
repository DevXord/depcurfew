// depcurfew init in a repository of independent projects (decision D-100): when the root has no manifest or lockfile
// of any tool but direct subdirectories do, init lists them under projects. The file names come from the knowledge
// base through the facts detection uses.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectionFacts } from '../detect/knowledge.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { inProject, projectProblems } from '../apply/projects.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
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

/** A subdirectory init leaves out of projects, because apply would refuse it: why and what to do, for the output of init. */
export interface LeftOutProject {
  project: string;
  /** The file that makes apply refuse it (its own depcurfew.json), else the directory. */
  file: string;
  reason: string;
  fix: string;
}

/**
 * The direct subdirectories of `root` that hold a manifest or lockfile, sorted, when the root itself holds none; an
 * empty list otherwise. Symlinks are not followed: apply refuses a project reached through one. A directory that apply
 * would refuse as a project (projectProblems: one with a depcurfew.json of its own, or a git submodule or other
 * repository of its own) is left out, with the reason.
 */
export function proposedProjects(root: string): { projects: string[]; leftOut: LeftOutProject[] } {
  const files = projectFiles();
  if (hasProject(root, files)) return { projects: [], leftOut: [] };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { projects: [], leftOut: [] };
  }
  const candidates = entries
    // A name the policy cannot hold (one with a colon or a *) is left out rather than written into an invalid policy.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name) && validateProjectDirectory(entry.name) === undefined)
    .map((entry) => entry.name)
    .filter((name) => hasProject(join(root, name), files))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The root has no manifest, so no workspaces either; what is left is a policy of its own, or a directory that changed.
  const problems = projectProblems(root, candidates, undefined);
  const leftOut = problems.map((problem): LeftOutProject => {
    const { project } = problem;
    const own = inProject(project, POLICY_FILE);
    if (problem.code === 'project-has-policy') {
      return {
        project,
        file: own,
        reason: `${own} is a policy of its own, and two policies for the same files are refused`,
        fix: `Run depcurfew in ${project} on its own, or move what ${own} sets into ${POLICY_FILE}, remove it and add "${project}" to projects`,
      };
    }
    if (problem.code === 'project-is-repository') {
      return {
        project,
        file: project,
        reason: 'it is a separate git repository (it has a .git of its own, as a git submodule does), whose files belong to that repository',
        fix: `Run depcurfew init in ${project} for it`,
      };
    }
    // The fix of apply speaks of an entry of projects, which init did not write: what to do here instead.
    return { project, file: project, reason: `${problem.message}; depcurfew apply would refuse it`, fix: `Fix what the message describes, then run depcurfew init --force to list ${project}` };
  });
  return { projects: candidates.filter((name) => !problems.some((problem) => problem.project === name)), leftOut };
}
