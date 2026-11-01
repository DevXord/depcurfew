// unreadable-config: doctor fails closed. A file it cannot read, parse or plan an edit for may still be read by a
// package manager or bot and weaken the policy there, so it is an error instead of a silent pass. The rule runs
// last, so it also sees what the other rules could not read.
import { yamlOptionsFor } from '../../apply/facts.ts';
import { parseJsonc } from '../../detect/jsonc.ts';
import type { Repository } from '../../detect/repository.ts';
import type { Detection, DetectionWarning } from '../../detect/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { parseYaml } from '../../yaml-parse.ts';
import { parseToml } from '../../detect/toml.ts';
import { UNREADABLE_WARNINGS } from '../unreadable-warnings.ts';
import { plannedApply } from '../plan.ts';
import { positionInMessage } from '../positions.ts';
import type { Rule } from '../types.ts';

export { UNREADABLE_WARNINGS } from '../unreadable-warnings.ts';

/**
 * YAML as detection and apply read it (parseYaml: the document shared with the rules, then its values), with or without
 * merge keys; throws its first error. Building the values applies the limit of the yaml package on aliases (100 per
 * anchor), so a file whose aliases expand without end is an error here as it is in apply, also without a policy
 * (decision D-124).
 */
const yamlParsers = [false, true].map((merge) => (text: string) => {
  parseYaml(text, { merge });
  return true;
});

/** The parser detection and apply read a configuration file with, by its name; undefined for other files (.npmrc, JSON5). */
function configParser(file: string): ((text: string) => unknown) | undefined {
  const name = file.split('/').at(-1) ?? file;
  if (/\.toml$/u.test(name) || name === 'Pipfile') return parseToml;
  if (/\.ya?ml$/u.test(name)) return yamlParsers[yamlOptionsFor(file).merge === true ? 1 : 0];
  if (/\.jsonc?$/u.test(name) || name === '.renovaterc') return parseJsonc;
  return undefined;
}

/**
 * Reads a configuration file of a tool found the way detection and apply read it, so that a syntax error is a warning
 * of the repository: TOML (also Pipfile), YAML, and JSON with comments (also .renovaterc). Other files (.npmrc, JSON5)
 * are not parsed here.
 */
function parseConfig(repository: Repository, file: string): void {
  const parser = configParser(file);
  if (parser !== undefined) repository.parseOnce(file, parser);
}

/**
 * Whether the text of a configuration file parses as detection and apply read it, without a warning of the repository:
 * a rule that cannot use a file that does not parse says so (decision D-124), while unreadable-config reports the file
 * with the message of apply's plan, when there is one.
 */
export function configParses(file: string, text: string): boolean {
  const parser = configParser(file);
  if (parser === undefined) return true;
  try {
    parser(text);
    return true;
  } catch {
    return false;
  }
}

/** The configuration files of the package managers and bots detection found. */
function configFilesOf(detection: Detection): string[] {
  return [...new Set([...detection.packageManagers.flatMap((manager) => manager.configFiles), ...detection.bots.flatMap((bot) => bot.configFiles)])];
}

/** The fix for YAML whose aliases expand more than depcurfew reads (the yaml library's maxAliasCount). */
const ALIAS_LIMIT_FIX = 'Write the repeated values out instead of using so many YAML aliases (*name), so that depcurfew can check the file';

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
      // YAML that parses but whose aliases expand past the limit (a billion laughs) is no syntax error to fix.
      const fix = warning.code === 'invalid-file' && /excessive alias count/iu.test(warning.message) ? ALIAS_LIMIT_FIX : UNREADABLE_WARNINGS[warning.code];
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
