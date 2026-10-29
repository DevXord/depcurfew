// unreadable-config: doctor fails closed. A file it cannot read, parse or plan an edit for may still be read by a
// package manager or bot and weaken the policy there, so it is an error instead of a silent pass. The rule runs
// last, so it also sees what the other rules could not read.
import type { DetectionWarning } from '../../detect/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { plannedApply } from '../plan.ts';
import type { Rule } from '../types.ts';

/** Repository warnings that mean a file was not checked. */
export const UNREADABLE_WARNINGS: Readonly<Record<string, string>> = {
  'invalid-file': 'Fix the syntax error, so that depgate can check the file',
  'file-too-large': 'Make the file smaller than the limit, or check its settings by hand',
  'outside-repository': 'Replace the symlink with a regular file inside the repository',
  'workspace-outside-repository': 'Keep workspace packages inside the repository',
};

export const unreadableConfig: Rule = {
  id: 'unreadable-config',
  summary: 'A configuration file or lockfile cannot be read, parsed or edited, so depgate cannot check it.',
  description:
    'A package manager or bot may still read the file and its settings may weaken the policy; depgate fails closed and reports an error instead of passing silently.',
  help: 'Fix what the message describes: invalid syntax, a symlink, a file over the size limit or a style depgate apply cannot edit.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    // One error per file: a file that cannot be read cannot be edited either.
    const reported = new Set<string>();
    const warnings: DetectionWarning[] = [...context.detection.warnings, ...context.repository.warnings];
    for (const warning of warnings) {
      const fix = UNREADABLE_WARNINGS[warning.code];
      const file = warning.files[0] ?? POLICY_FILE;
      if (fix === undefined || reported.has(file)) continue;
      reported.add(file);
      context.report({ location: { file }, message: `${warning.message.replace(/:$/u, '')}; depgate cannot check it`, fix });
    }
    for (const failure of plannedApply(context)?.failures ?? []) {
      if (reported.has(failure.file)) continue;
      reported.add(failure.file);
      context.report({
        location: { file: failure.file },
        message: `depgate apply cannot edit ${failure.file} for ${context.tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool} (${failure.message}), so it cannot be checked against ${POLICY_FILE}`,
        fix: 'Fix what the message describes, then run depgate apply; or add the settings by hand',
      });
    }
  },
};
