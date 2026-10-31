// depcurfew-outdated: the project installs a newer depcurfew than the one running doctor.
import { isNewerThanRunning, projectCopy } from '../../self-version.ts';
import type { Rule } from '../types.ts';

export const depcurfewOutdated: Rule = {
  id: 'depcurfew-outdated',
  summary: 'The project installs a newer depcurfew than the one running.',
  description:
    'A global install or an old cached copy may not know settings, rules or tool versions that the version pinned in the project knows, so it can miss problems or report fixed ones. The project copy is read from node_modules or package-lock.json.',
  help: "Run the project's copy of depcurfew, or update the one you run.",
  level: 'warning',
  requiresPolicy: false,
  check(context) {
    const copy = projectCopy(context.repository);
    if (copy === undefined || !isNewerThanRunning(copy)) return;
    context.report({
      location: { file: copy.file, ...(copy.line === undefined ? {} : { line: copy.line }) },
      message: `depcurfew ${copy.version} is installed in the project (${copy.file}), but the depcurfew running this check is older, so it may not know settings that version writes or checks`,
      fix: `Run the project's copy (npx depcurfew doctor), or update the depcurfew you run to ${copy.version} or later`,
    });
  },
};
