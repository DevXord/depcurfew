// `projects` in depcurfew.json (decision D-100): independent projects in one repository, each in its own directory
// with its own manifest and lockfile. apply, doctor and explain treat each listed directory as a project of its own
// with the policy of the root, and the root as before; Renovate and Dependabot are configured once, from the root.
// What is planned or found in a project names its files relative to that project; the helpers here name them
// relative to the repository root again, in paths and in the text of messages.
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection, VersionDeclaration } from '../detect/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { readPolicyFile } from '../policy/file.ts';
import { lineOf } from '../doctor/settings.ts';
import { jsonElementOffsets, jsonGet } from './json-edit.ts';
import { isInside } from '../paths.ts';
import type { ApplyErrorCode } from './warnings.ts';

/** The detection of a project with every file named relative to the repository root, for explain. */
export function relocateDetection(project: string, detection: Detection): Detection {
  const files = new Set<string>([...detection.npmrcFiles, ...detection.workflows, ...detection.warnings.flatMap((warning) => warning.files)]);
  const at = (file: string) => {
    files.add(file);
    return inProject(project, file);
  };
  const version = (declaration: VersionDeclaration): VersionDeclaration => ({
    ...declaration,
    file: at(declaration.file),
    ...('versionFile' in declaration ? { versionFile: at(declaration.versionFile) } : {}),
  });
  const relocated: Detection = {
    packageManagers: detection.packageManagers.map((manager) => ({
      ...manager,
      evidence: manager.evidence.map((item) => ({ ...item, file: at(item.file) })),
      versions: manager.versions.map(version),
      configFiles: manager.configFiles.map(at),
    })),
    node: { versions: detection.node.versions.map(version) },
    bots: detection.bots.map((bot) => ({ ...bot, configFiles: bot.configFiles.map(at) })),
    workspaces:
      detection.workspaces === null
        ? null
        : {
            declarations: detection.workspaces.declarations.map((declaration) => ({ ...declaration, file: at(declaration.file) })),
            packages: detection.workspaces.packages.map(at),
          },
    npmrcFiles: detection.npmrcFiles.map(at),
    workflows: detection.workflows.map(at),
    jobs: detection.jobs.map((job) => ({ ...job, file: at(job.file) })),
    dockerfiles: detection.dockerfiles.map((dockerfile) => ({ ...dockerfile, file: at(dockerfile.file) })),
    warnings: [],
  };
  relocated.warnings = detection.warnings.map((warning) => ({
    ...warning,
    message: relocateText(warning.message, project, files),
    files: warning.files.map((file) => inProject(project, file)),
  }));
  return relocated;
}

/** A path of a project file as seen from the repository root. */
export function inProject(project: string, file: string): string {
  return file === '' || file === '.' ? project : `${project}/${file}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The text of a message about a project with the names of the project's files (relative to the project) made
 * relative to the repository root: ".npmrc" becomes "frontend/.npmrc". Only whole paths are replaced, never the end
 * of a longer path, and depcurfew.json stays as it is, because the policy is the root's.
 */
export function relocateText(text: string, project: string, files: Iterable<string>): string {
  const names = [...new Set(files)].filter((file) => file !== '' && file !== POLICY_FILE).sort((a, b) => b.length - a.length);
  if (names.length === 0 || text === '') return text;
  const pattern = new RegExp(`(?<![\\w./\\\\-])(?:${names.map(escapeRegExp).join('|')})(?![\\w/\\\\-]|\\.\\w)`, 'gu');
  return text.replace(pattern, (file) => inProject(project, file));
}

/** Why a directory listed in projects cannot be used; nothing is written and doctor reports it (invalid-project). */
export interface ProjectProblem {
  code: Extract<ApplyErrorCode, `project-${string}`>;
  /** The entry of projects it concerns. */
  project: string;
  location: { file: string; line?: number };
  message: string;
  fix: string;
}

/**
 * The line of each entry of projects in the text of depcurfew.json, from the positions of the elements of that array
 * (the same name may also stand elsewhere, e.g. in cooldown.exclude); the first occurrence of the quoted name when
 * the text cannot be parsed.
 */
function projectLines(text: string): (project: string) => number | undefined {
  let listed: unknown;
  let offsets: number[] | undefined;
  try {
    listed = jsonGet(text, ['projects']);
    offsets = jsonElementOffsets(text, ['projects']);
  } catch {
    listed = undefined;
  }
  return (project) => {
    const index = Array.isArray(listed) ? listed.indexOf(project) : -1;
    const offset = index === -1 ? undefined : offsets?.[index];
    return offset === undefined ? lineOf(text, JSON.stringify(project)) : text.slice(0, offset).split('\n').length;
  };
}

/** Whether two directories of the repository are the same or one lies inside the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The problems of the directories listed in projects: one that does not exist, is not a directory, is reached through
 * a symlink (which may lead out of the repository, and would put the files apply writes in another place), has a
 * depcurfew.json of its own (two policies for the same files), or overlaps a workspace package of the root (whose
 * configuration the root already writes). `rootDetection` is the detection of the root, for its workspaces.
 */
export function projectProblems(root: string, projects: readonly string[], rootDetection: Detection | undefined): ProjectProblem[] {
  if (projects.length === 0) return [];
  const policy = readPolicyFile(root);
  const text = policy.status === 'ok' ? policy.text : '';
  const real = realpathSync(root);
  const problems: ProjectProblem[] = [];
  const entryLine = projectLines(text);
  for (const project of projects) {
    const line = entryLine(project);
    const location = { file: POLICY_FILE, ...(line === undefined ? {} : { line }) };
    const remove = `remove "${project}" from projects in ${POLICY_FILE}`;
    const problem = (code: ProjectProblem['code'], message: string, fix: string, at = location) => problems.push({ code, project, location: at, message, fix });

    // Each part of the path on its own, so that a symlink anywhere on the way is seen, not only at the end.
    let missing: string | undefined;
    let link: string | undefined;
    let file: string | undefined;
    const parts = project.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const part = parts.slice(0, count).join('/');
      let stats;
      try {
        stats = lstatSync(join(root, part), { throwIfNoEntry: false });
      } catch {
        stats = undefined;
      }
      if (stats === undefined) {
        missing = part;
        break;
      }
      if (stats.isSymbolicLink()) {
        link = part;
        break;
      }
      if (!stats.isDirectory()) {
        file = part;
        break;
      }
    }
    if (missing !== undefined) {
      problem('project-not-found', `the project directory ${project} listed in projects does not exist`, `Create ${project}, or correct or ${remove}`);
      continue;
    }
    if (link !== undefined) {
      let target: string | undefined;
      try {
        target = realpathSync(join(root, link));
      } catch {
        target = undefined;
      }
      const outside = target === undefined || !isInside(real, target);
      problem(
        'project-symlink',
        `the project directory ${project} listed in projects ${link === project ? 'is' : `lies under ${link}, which is`} a symlink${outside ? ' that leads outside the repository' : ''}; depcurfew does not follow symlinks to projects, so the files it writes stay in the repository`,
        outside ? `Move the project into the repository, or ${remove}` : `List the directory the symlink points to instead, or ${remove}`,
      );
      continue;
    }
    if (file !== undefined) {
      problem('project-not-a-directory', `${file} is a file, so the project directory ${project} listed in projects is not a directory`, `List the directory of the project, not a file in it, or ${remove}`);
      continue;
    }
    if (readPolicyFile(join(root, project)).status !== 'missing') {
      problem(
        'project-has-policy',
        `${inProject(project, POLICY_FILE)} is a second policy for ${project}, which projects in the ${POLICY_FILE} of the repository root already covers`,
        `Remove ${inProject(project, POLICY_FILE)} (move what it sets into the ${POLICY_FILE} of the root), or ${remove} and run depcurfew in ${project} on its own`,
        { file: inProject(project, POLICY_FILE) },
      );
      continue;
    }
    const member = rootDetection?.workspaces?.packages.find((directory) => overlaps(directory, project));
    if (member !== undefined) {
      const declared = rootDetection?.workspaces?.declarations.map((declaration) => declaration.file).join(', ') ?? '';
      const relation = member === project ? 'is a workspace package' : member.startsWith(`${project}/`) ? `holds the workspace package ${member}` : `lies in the workspace package ${member}`;
      problem(
        'project-in-workspace',
        `the project directory ${project} listed in projects ${relation} of the repository root (declared in ${declared}), which the configuration of the root already covers`,
        `${remove.charAt(0).toUpperCase()}${remove.slice(1)}; depcurfew configures workspace packages with the root`,
      );
    }
  }
  return problems;
}
