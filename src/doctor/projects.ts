// The package managers the bots of the repository root serve: the root's own and those of every directory listed in
// projects in depcurfew.json (decision D-100). Renovate and Dependabot read their configuration from the root, so
// the rules that compare a bot with the package managers look at all of them.
import { projectFiles } from '../apply/index.ts';
import { inProject, relocateText } from '../apply/projects.ts';
import type { PackageManagerInfo } from '../detect/types.ts';
import type { RuleContext } from './types.ts';

export interface ManagerSource {
  /** The directory listed in projects; undefined for the root. */
  project?: string;
  /** The context to read the managers' files with: the project's repository and detection. */
  context: RuleContext;
  /** The supported package managers found there. */
  managers: PackageManagerInfo[];
  /** Names the project's files in a text relative to the repository root, as the findings of the root need. */
  relocate(text: string): string;
}

export function managerSources(context: RuleContext): ManagerSource[] {
  const root: ManagerSource = { context, managers: context.detection.packageManagers.filter((entry) => entry.supported), relocate: (text) => text };
  return [
    root,
    ...(context.projects ?? []).map((view): ManagerSource => {
      const files = projectFiles(view.detection);
      const relocate = (text: string) => relocateText(text, view.directory, [...files, ...view.repository.read]);
      const { projects: _projects, ...rest } = context;
      return {
        project: view.directory,
        context: {
          ...rest,
          root: view.root,
          repository: view.repository,
          detection: view.detection,
          project: view.directory,
          // What a project's file says that doctor cannot read is a notice of the root run, so the file is named from the root.
          notice: (message, file, fix) => context.notice(relocate(message), file === undefined ? undefined : inProject(view.directory, file), fix === undefined ? undefined : relocate(fix)),
        },
        managers: view.detection.packageManagers.filter((entry) => entry.supported),
        relocate,
      };
    }),
  ];
}
