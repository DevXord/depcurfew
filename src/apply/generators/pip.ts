// pip: no project configuration. The build options go into requirements.txt in a managed block; the release-age
// delay cannot be set in the project, so apply says how to set it where pip runs.
import { requirementsLongOptions } from '../../doctor/python.ts';
import { includedFile, requirementsFormatOf, requirementsIncludes } from '../../doctor/python-lockfiles.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { hasManagedLines } from '../block.ts';
import { lines, myers } from '../diff.ts';
import { extraOf, firstFile, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { editIncluded, formatControlFacts, keptLines, optionsText, weakeningEffect, type KeptLine } from '../pip-includes.ts';
import { formatVersion } from '../version.ts';
import { eachSource } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { buildAllowList, buildSwitchScopeWarning, forcedBuildWarning } from './python.ts';

/** The line of `before` that a line of `after` (1-based) was, for a line the edit kept. */
function lineInOriginal(before: string, after: string): (line: number) => number {
  const map = new Map<number, number>();
  let old = 0;
  let now = 0;
  for (const operation of myers(lines(before), lines(after))) {
    if (operation.kind !== 'insert') old += 1;
    if (operation.kind !== 'delete') now += 1;
    if (operation.kind === 'same') map.set(now, old);
  }
  return (line) => map.get(line) ?? line;
}

const WHY: Readonly<Record<KeptLine['reason'], string>> = {
  requirement: 'pip applies the options after a requirement to the whole install, and depcurfew apply does not comment the line out, which would remove the requirement',
  options: 'the line sets other options too, so depcurfew apply does not comment it out',
  continued: 'the line continues on the next one, so depcurfew apply does not comment it out',
};

/**
 * The files `root` includes (-r, -c), in the order pip reads them, as far as they are in the directory configured:
 * option lines that undo the block (`block` and the normalized names of its --no-binary entries, when it is written)
 * are commented out, lines commented out so come back once nothing is blocked, and what apply cannot comment out or
 * read is a warning (decision D-167).
 */
function checkIncludes(context: Context, root: string, block: { text: string; allowed: ReadonlySet<string> } | undefined, original: string): void {
  const facts = formatControlFacts(context.tool);
  if (facts === undefined) return;
  const format = requirementsFormatOf(context.tool);
  const reading = { facts, format, longOptions: requirementsLongOptions(format) };
  const { workspace } = context;
  const where = context.project ?? 'the repository';
  const undoing = `${facts.noBinary} or ${facts.onlyBinary}=${facts.none}`;
  const visited = new Set([root]);
  const queue = [root];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const includer = file;
    const text = workspace.read(includer);
    // Lines of requirements.txt as the file has them now, before the block this run writes (included files only get
    // lines commented out, which moves no line).
    const lineOf = includer === root ? lineInOriginal(original, text) : (line: number) => line;
    for (const kept of block === undefined ? [] : keptLines(text, reading, block.allowed)) {
      const options = optionsText(kept.options);
      const line = lineOf(kept.line);
      context.warn({
        code: 'build-switch-undone',
        location: { file: includer, line },
        message: `${context.name}: ${options} in ${includer} (line ${line}) ${weakeningEffect(kept.options, facts)}, after the ${block?.text ?? ''} of the managed block in ${root}; ${WHY[kept.reason]}`,
        fix: `Remove ${options} from ${includer}, or add the packages that must be built from source to installScripts.allow in ${POLICY_FILE} as pypi:<name>, then run depcurfew apply again`,
      });
    }
    for (const include of requirementsIncludes(text, format)) {
      const { path } = include;
      const line = lineOf(include.line);
      const included = includedFile(includer, path);
      const unread = (reason: string, fix: string) => {
        if (block === undefined) return;
        context.warn({
          code: 'requirements-include-unread',
          location: { file: includer, line },
          message: `${context.name}: ${includer} includes ${path} (line ${line}), ${reason}, so depcurfew apply cannot check that it has no ${undoing} line, which would undo the ${block.text} of the managed block in ${root}`,
          fix,
        });
      };
      const keep = `Keep the included file in ${where} as a regular file and include it by a relative path, then run depcurfew apply again; until then check by hand that it has no ${undoing} line`;
      if (included.url) unread('which pip downloads', keep);
      else if (included.outside) unread(`which is outside ${where}`, keep);
      else if (!visited.has(included.target)) {
        visited.add(included.target);
        if (!workspace.isFile(included.target)) {
          unread('which does not exist', `Create ${included.target} or remove the line that includes it (pip stops when it cannot open an included file), then run depcurfew apply again`);
          continue;
        }
        try {
          workspace.edit(included.target, (body) => editIncluded(body, reading, block?.allowed).text);
        } catch (error) {
          unread(`which depcurfew cannot read (${error instanceof Error ? error.message : String(error)})`, keep);
          continue;
        }
        queue.push(included.target);
      }
    }
  }
}

export const pip: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = (tool.project === undefined ? undefined : firstFile(tool.project.manifests)) ?? 'requirements.txt';

  if (policy.cooldown !== undefined) {
    const flag = settingOf(tool.cooldown.setting) ?? 'uploaded-prior-to';
    const variable = extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string');
    const since = sinceOf(tool.cooldown.availableSince);
    const result = convertCooldown(tool, policy.cooldown.minimum);
    const value = result.ok ? `P${String(result.value)}D` : undefined;
    const version = context.version === undefined || context.atLeast(since) ? '' : ` (pip ${formatVersion(context.version)} is too old for it)`;
    context.warn({
      code: 'cooldown-environment-only',
      message: `${context.name}: cooldown not written: pip reads no configuration from the project and rejects --${flag} in requirements files${version}`,
      fix: `Set ${variable}${value === undefined ? '' : `=${value}`} where pip installs packages (CI, Dockerfile), with pip ${since ?? 'a recent version'} or later`,
    });
  }

  const entries: string[] = [];
  const managed: string[] = [];
  const settings: string[] = [];
  let block: { text: string; allowed: ReadonlySet<string> } | undefined;
  if (policy.installScripts?.default === 'deny') {
    const build = extraOf(tool, 'buildSwitch', isSwitch);
    const setting = settingOf(tool.installScripts.allowList.setting);
    if (context.supports(build.since, build.setting)) {
      entries.push(`${build.setting}=${String(build.value)}`);
      managed.push(build.setting);
      settings.push(build.setting);
      buildSwitchScopeWarning(context, build.setting, build.covers);
      if (setting !== null) {
        managed.push(setting);
        const names = policy.installScripts.allow.length > 0 ? buildAllowList(context, setting) : [];
        for (const name of names) entries.push(`${setting}=${name}`);
        if (names.length > 0) settings.push(setting);
        forcedBuildWarning(context, setting, names);
        block = { text: `${build.setting}=${String(build.value)}`, allowed: new Set(names) };
      } else {
        block = { text: `${build.setting}=${String(build.value)}`, allowed: new Set() };
      }
    }
  }

  eachSource(context, () => undefined);

  if (!context.exists(file)) {
    if (entries.length > 0) {
      context.warn({
        code: 'requirements-file-missing',
        message: `${context.name}: no ${file}, so ${entries.join(' and ')} not written`,
        fix: `Add ${entries.length === 1 ? 'it' : 'them'} to the pip command or the requirements file pip installs from`,
      });
    }
    return undefined;
  }
  // Only into a requirements file that exists; without one, requirements-file-missing says what to do instead.
  for (const setting of settings) context.writes('installScripts', setting, file);
  const original = context.read(file);
  if (entries.length > 0 || hasManagedLines(original)) context.requirements(file, entries, managed);
  // Also without a block, so that lines of included files commented out by an earlier run come back.
  checkIncludes(context, file, block, original);
  return undefined;
};
