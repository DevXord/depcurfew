// unreadable-config: doctor fails closed. A file it cannot read, parse or plan an edit for may still be read by a
// package manager or bot and weaken the policy there, so it is an error instead of a silent pass. The rule runs
// last, so it also sees what the other rules could not read.
import { yamlOptionsFor } from '../../apply/facts.ts';
import { parseJsonc } from '../../detect/jsonc.ts';
import type { Repository } from '../../detect/repository.ts';
import type { Detection, DetectionWarning } from '../../detect/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { readYamlDocument } from '../../yaml-parse.ts';
import { readTomlDocument } from '../python.ts';
import { UNREADABLE_WARNINGS } from '../unreadable-warnings.ts';
import { plannedApply } from '../plan.ts';
import { positionInMessage } from '../positions.ts';
import type { Rule } from '../types.ts';

export { UNREADABLE_WARNINGS } from '../unreadable-warnings.ts';

/** YAML as the rules read it (readYamlDocument, shared with them), with or without merge keys; throws its first error. */
const yamlParsers = [false, true].map((merge) => (text: string) => {
  const { document } = readYamlDocument(text, { merge });
  if (document.errors.length > 0) throw document.errors[0] as Error;
  return true;
});

/**
 * Reads a configuration file of a tool found the way the rules read it, so that a syntax error is a warning of the
 * repository: TOML (also Pipfile), YAML, and JSON with comments (also .renovaterc). Other files (.npmrc, JSON5) are not
 * parsed here.
 */
function parseConfig(repository: Repository, file: string): void {
  const name = file.split('/').at(-1) ?? file;
  if (/\.toml$/u.test(name) || name === 'Pipfile') readTomlDocument(repository, file);
  else if (/\.ya?ml$/u.test(name)) repository.parseOnce(file, yamlParsers[yamlOptionsFor(file).merge === true ? 1 : 0] as (text: string) => boolean);
  else if (/\.jsonc?$/u.test(name) || name === '.renovaterc') repository.parseOnce(file, parseJsonc);
}

/** The configuration files of the package managers and bots detection found. */
function configFilesOf(detection: Detection): string[] {
  return [...new Set([...detection.packageManagers.flatMap((manager) => manager.configFiles), ...detection.bots.flatMap((bot) => bot.configFiles)])];
}

export const unreadableConfig: Rule = {
  id: 'unreadable-config',
  checks: 'Every configuration file and lockfile can be read and parsed',
  summary: 'A configuration file or lockfile cannot be read, parsed or edited, so depcurfew cannot check it.',
  description:
    'A package manager or bot may still read the file and its settings may weaken the policy; depcurfew fails closed and reports an error instead of passing silently.',
  help: 'Fix what the message describes: invalid syntax, missing read permission, a symlink, a file over the size limit or a style depcurfew apply cannot edit.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    // One error per file: a file that cannot be read cannot be edited either.
    const reported = new Set<string>();
    const reportWarning = (warning: DetectionWarning) => {
      const fix = UNREADABLE_WARNINGS[warning.code];
      const file = warning.files[0] ?? POLICY_FILE;
      if (fix === undefined || reported.has(file)) return;
      reported.add(file);
      context.report({ location: { file, ...(warning.code === 'invalid-file' ? positionInMessage(warning.message) : undefined) }, message: `${warning.message.replace(/:$/u, '')}; depcurfew cannot check it`, fix });
    };
    for (const warning of [...context.detection.warnings, ...context.repository.warnings]) reportWarning(warning);
    for (const failure of plannedApply(context)?.failures ?? []) {
      if (reported.has(failure.file)) continue;
      reported.add(failure.file);
      context.report({
        location: { file: failure.file, ...positionInMessage(failure.message) },
        message: `depcurfew apply cannot edit ${failure.file} for ${context.tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool} (${failure.message}), so it cannot be checked against ${POLICY_FILE}`,
        fix: 'Fix what the message describes, then run depcurfew apply; or add the settings by hand',
      });
    }
    // The configuration files of the tools found, read here too: without a valid policy there is no plan of apply to
    // read them, and the rules that read a file apply does not edit skip it when it does not parse (decision D-121).
    for (const file of configFilesOf(context.detection)) {
      if (reported.has(file)) continue;
      const known = context.repository.warnings.length;
      parseConfig(context.repository, file);
      for (const warning of context.repository.warnings.slice(known)) reportWarning(warning);
    }
  },
};
