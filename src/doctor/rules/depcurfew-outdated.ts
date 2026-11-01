// depcurfew-outdated: the project installs a newer depcurfew than the one running doctor.
import { isNewerThanRunning, outdatedText, projectCopy } from '../../self-version.ts';
import type { Rule } from '../types.ts';

export const depcurfewOutdated: Rule = {
  id: 'depcurfew-outdated',
  checks: 'The depcurfew running is not older than the one the project installs',
  summary: 'The project installs a newer depcurfew than the one running.',
  description:
    'A global install or an old cached copy may not know settings, rules or tool versions that the version pinned in the project knows, so it can miss problems or report fixed ones. The project copy is read from node_modules or package-lock.json.',
  help: "Run the project's copy of depcurfew (install the project's dependencies first when only package-lock.json pins it), or update the one you run.",
  level: 'warning',
  requiresPolicy: false,
  applies: (scope) => projectCopy(scope.repository) !== undefined,
  check(context) {
    const copy = projectCopy(context.repository);
    if (copy === undefined || !isNewerThanRunning(copy)) return;
    context.report({ location: { file: copy.file, ...(copy.line === undefined ? {} : { line: copy.line }) }, ...outdatedText(copy, 'doctor') });
  },
};
