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

/**
 * The manifests, then the lockfiles, of every package manager depcurfew knows (package.json, pyproject.toml … uv.lock),
 * in the order of the knowledge base: a directory with package.json is told by the first lookup (decision D-157).
 */
function projectFiles(): string[] {
  const facts = detectionFacts(knowledgeBase, environment);
  return [...new Set([...facts.managers.flatMap((manager) => manager.manifests), ...facts.managers.flatMap((manager) => manager.lockfiles)])];
}

/** Whether the path is a regular file; a missing one costs no exception, which matters for thousands of directories (decision D-157). */
function isFile(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
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
 * repository of its own) is left out, with the reason, and so is one whose name differs only in case from another
 * that can be listed.
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
  const { listed, twins } = caseTwins(candidates, new Set(problems.map((problem) => problem.project)));
  return { projects: listed, leftOut: [...leftOut, ...twins].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0)) };
}

/**
 * Directories whose names differ only in case are one directory on Windows and macOS, and the policy refuses both
 * (decision D-158): of the sorted `candidates` init can list (those not `refused`, decision D-161), the first in sort
 * order of each name in any case is listed and the others are left out with the reason. A set and a map keep this
 * linear for tens of thousands of directories (decision D-163).
 */
export function caseTwins(candidates: readonly string[], refused: ReadonlySet<string>): { listed: string[]; twins: LeftOutProject[] } {
  const firsts = new Map<string, string>();
  const listed: string[] = [];
  const twins: LeftOutProject[] = [];
  for (const name of candidates) {
    if (refused.has(name)) continue;
    const key = name.toLowerCase();
    const first = firsts.get(key);
    if (first === undefined) {
      firsts.set(key, name);
      listed.push(name);
      continue;
    }
    twins.push({
      project: name,
      file: name,
      reason: `its name differs from "${first}" only in case, so both name the same directory on Windows and macOS, and projects in ${POLICY_FILE} cannot list both`,
      fix: `Rename one of the two directories so that their names differ in more than case, then run depcurfew init --force to list both`,
    });
  }
  return { listed, twins };
}
