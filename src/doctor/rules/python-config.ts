// python-config-ignored: Python settings written where the tool does not read them, or that another setting turns
// off, which look effective but are not: [tool.uv] next to a uv.toml, uv settings in workspace members, pip.conf in
// the project, options pip rejects in requirements files, an exclude-newer date that never moves (uv, PDM), PDM's uv
// mode, which installs without the build settings, and Pipenv's pure-python and uv resolver backends, which lock without
// cool-down-period (decision D-202).
// And a pip install in a Dockerfile stage of the python image or in a CI job without the release-age delay the policy
// asks for: pip takes it only from the environment or its command line there (decision D-115).
import { extraOf, isRecord, isSwitch, settingOf, sinceOf } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { joinPath } from '../../detect/repository.ts';
import type { DockerStage, ToolCommand } from '../../detect/types.ts';
import { jobLabel } from '../../detect/workflows.ts';
import { contextPath } from './bundled-versions.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { requirementsFormatOf } from '../python-lockfiles.ts';
import { readPythonSetting, requirementsLongOptions, requirementsOptions, tomlSettingAt } from '../python.ts';
import type { Rule, RuleContext } from '../types.ts';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The settings depcurfew manages for a Python tool, as keys of its configuration table. */
function managedKeys(tool: ToolKnowledge): string[] {
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  const required = tool.extra?.['requiredVersion'] === undefined ? undefined : extraOf(tool, 'requiredVersion', isRecord);
  return [settingOf(tool.cooldown.setting), settingOf(tool.cooldown.exclude.setting), build?.setting ?? null, settingOf(tool.installScripts.allowList.setting), typeof required?.['key'] === 'string' ? required['key'] : null].filter(
    (key): key is string => key !== null,
  );
}

/** The keys of a TOML table in a file that set one of `keys`, with their lines. */
function keysIn(context: RuleContext, file: string, table: readonly string[], keys: readonly string[]): { key: string; line: number }[] {
  return keys.flatMap((key) => {
    const found = tomlSettingAt(context.repository, file, [...table, key]);
    return found === undefined ? [] : [{ key, line: found.line }];
  });
}

function checkUv(context: RuleContext, tool: ToolKnowledge): void {
  const tables = extraOf(tool, 'configTables', isRecord);
  const order = extraOf(tool, 'configFileOrder', isStrings);
  const [winner, loser] = order;
  if (winner === undefined || loser === undefined) return;
  const keys = managedKeys(tool);
  const table = (file: string) => (String(tables[file] ?? '') === '' ? [] : String(tables[file]).split('.'));
  if (context.repository.isFile(winner)) {
    for (const { key, line } of keysIn(context, loser, table(loser), keys)) {
      context.report({
        location: { file: loser, line },
        message: `uv reads ${winner} and ignores [${String(tables[loser])}] in ${loser}, so ${key} here has no effect`,
        fix: `Move ${key} to ${winner}, or remove it from ${loser}`,
      });
    }
  }
  if (extraOf(tool, 'workspaceRootOnly', (value): value is boolean => typeof value === 'boolean')) {
    for (const member of context.detection.workspaces?.packages ?? []) {
      for (const file of order) {
        const path = joinPath(member, file);
        for (const { key, line } of keysIn(context, path, table(file), keys)) {
          context.report({
            location: { file: path, line },
            message: `uv reads settings only from the workspace root, so ${key} in ${path} has no effect`,
            fix: `Set ${key} in the root ${winner} or [${String(tables['pyproject.toml'])}] of the root pyproject.toml, and remove it from ${path}`,
          });
        }
      }
    }
  }
  fixedDate(context, tool);
}

/** An exclude-newer date, which never moves, where a duration was meant (uv, PDM). */
function fixedDate(context: RuleContext, tool: ToolKnowledge): void {
  const setting = settingOf(tool.cooldown.setting);
  const found = setting === null ? undefined : readPythonSetting(context.repository, tool, setting);
  if (found === undefined || !(typeof found.value === 'string' || typeof found.value === 'object') || !/^\d{4}-\d{2}-\d{2}/u.test(String(found.value))) return;
  const syntax = tool.extra?.['durationStrings'] === undefined ? undefined : extraOf(tool, 'durationStrings', isRecord)['syntax'];
  context.report({
    level: 'warning',
    location: { file: found.file, line: found.line },
    message: `${setting} is the fixed date ${String(found.value)}, so ${tool.name} never uses versions uploaded after it; that is a freeze, not a delay that moves with time`,
    fix: `Write a duration such as "${syntax === 'compact' ? '3d' : '3 days'}" (${tool.name} ${sinceOf(tool.cooldown.availableSince) ?? ''} or later), or let depcurfew apply write it from cooldown.minimum`,
  });
}

/** PDM in uv mode (use_uv in pdm.toml) installs with uv sync, without its build settings. */
function checkPdm(context: RuleContext, tool: ToolKnowledge): void {
  fixedDate(context, tool);
  const mode = tool.extra?.['uvMode'] === undefined ? undefined : extraOf(tool, 'uvMode', isRecord);
  if (typeof mode?.['file'] !== 'string' || typeof mode['key'] !== 'string') return;
  const found = tomlSettingAt(context.repository, mode['file'], [mode['key']]);
  if (found?.value !== true) return;
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  if (build === undefined || readPythonSetting(context.repository, tool, build.setting) === undefined) return;
  context.report({
    level: 'warning',
    location: { file: found.file, line: found.line },
    message: `${mode['key']} in ${found.file} makes ${tool.name} install with uv sync, which it runs without ${build.setting}, so packages may still be built from source when installing`,
    fix: `Remove ${mode['key']} from ${found.file}, or forbid building in uv too ([tool.uv] no-build = true in pyproject.toml)`,
  });
}

/** Whether Python takes a TOML value as true: Pipenv reads `settings.get("resolver_backend") or settings.get("resolver")`. */
function pythonTrue(value: unknown): boolean {
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value) !== 0;
  if (typeof value === 'boolean') return value;
  return !isRecord(value) || Object.keys(value).length > 0;
}

/**
 * Pipenv's resolver backends that lock without cool-down-period (extra.resolverBypass): resolver_backend, or the older
 * key resolver, set in [pipenv] to one of them, compared stripped as Pipenv reads it (decision D-202). The older key is
 * reported also next to resolver_backend, which Pipenv reads first: before olderKeyAlone.until some commands read
 * only the older key, and removing it is right in every version.
 */
function checkPipenv(context: RuleContext, tool: ToolKnowledge): void {
  const bypass = tool.extra?.['resolverBypass'] === undefined ? undefined : extraOf(tool, 'resolverBypass', isRecord);
  const setting = settingOf(tool.cooldown.setting);
  if (bypass === undefined || setting === null) return;
  const { table, keys, values, delayBackend, olderKeyAlone } = bypass;
  if (typeof table !== 'string' || !isStrings(keys) || !isStrings(values) || typeof delayBackend !== 'string') return;
  const delay = readPythonSetting(context.repository, tool, setting);
  if (delay === undefined) return;
  const [first] = keys;
  const older = isRecord(olderKeyAlone) && typeof olderKeyAlone['until'] === 'string' && isStrings(olderKeyAlone['commands']) ? { until: olderKeyAlone['until'], commands: olderKeyAlone['commands'] } : undefined;
  const found = keys.map((key) => ({ key, entry: tomlSettingAt(context.repository, delay.file, [table, key]) }));
  for (const [index, { key, entry }] of found.entries()) {
    if (entry === undefined || typeof entry.value !== 'string' || !values.includes(entry.value.trim())) continue;
    const written = `${key} = ${JSON.stringify(entry.value)}`;
    // A key after one that is set is read only where the older key alone counts.
    const shadowed = found.slice(0, index).some((earlier) => earlier.entry !== undefined && pythonTrue(earlier.entry.value));
    context.report({
      location: { file: entry.file, line: entry.line },
      message:
        shadowed && older !== undefined && first !== undefined
          ? `${written} is the older name of ${first}: ${tool.name} reads ${first} first, but ${listing(older.commands)} of ${tool.name} before ${older.until} read only ${key}, so there it still selects a resolver backend that locks without ${setting}`
          : `${written} makes ${tool.name} lock without ${setting}, so the release-age delay in ${delay.file} has no effect`,
      fix:
        index === 0
          ? `Remove ${key} from [${table}] in ${delay.file}, or write ${key} = "${delayBackend}", so that ${tool.name} locks with ${delayBackend} and applies ${setting}`
          : `Remove ${key} from [${table}] in ${delay.file}, and write ${first ?? key} = "${delayBackend}" if the backend must be named, so that ${tool.name} locks with ${delayBackend} and applies ${setting}`,
    });
  }
}

/** A COPY or ADD source of the build context that brings `file` into the image: the file, or a directory that holds it. */
function copiesFile(source: string, file: string): boolean {
  const path = contextPath(source);
  return path !== undefined && (path === '.' || path === file || file.startsWith(`${path}/`));
}

/**
 * Whether a CI job or a Dockerfile stage points PIP_CONFIG_FILE to `file` (decision D-173): a job with the path of the
 * file from the root of the workspace (pip.conf, ./pip.conf, ${{ github.workspace }}/pip.conf, $GITHUB_WORKSPACE/pip.conf),
 * a stage with a path whose name is the file's name, when it or a stage it starts from copies the file from the build
 * context. Then pip reads the file there.
 */
function pointedTo(context: RuleContext, file: string): boolean {
  const workspace = /^(?:\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?)\//u;
  const normalized = (value: string) => value.trim().replace(workspace, '').replace(/^(?:\.\/)+/u, '');
  if (context.detection.jobs.some((job) => (job.pipConfigFiles ?? []).some((value) => normalized(value) === file))) return true;
  const name = file.split('/').at(-1) ?? file;
  return context.detection.dockerfiles.some(({ stages }) =>
    stages.some((stage, index) => {
      if (!(stage.pipConfigFiles ?? []).some((value) => value.trim().split('/').at(-1) === name)) return false;
      // The stage and the stages it starts from, each once.
      for (let at: number | undefined = index, seen = 0; at !== undefined && seen <= index; seen++) {
        const current: DockerStage | undefined = stages[at];
        if (current === undefined) break;
        if ((current.copies ?? []).some((source) => copiesFile(source, file))) return true;
        at = current.from !== undefined && current.from < at ? current.from : undefined;
      }
      return false;
    }),
  );
}

function checkPip(context: RuleContext, tool: ToolKnowledge, configFiles: readonly string[]): void {
  const names = extraOf(tool, 'configFileNames', isStrings);
  const configVariable = extraOf(tool, 'configFileVariable', (value): value is string => typeof value === 'string');
  for (const directory of ['.', ...(context.detection.workspaces?.packages ?? [])]) {
    for (const name of names) {
      const file = joinPath(directory, name);
      if (!context.repository.isFile(file) || pointedTo(context, file)) continue;
      context.report({
        level: 'warning',
        location: { file },
        message: `pip reads no configuration from the project, so ${file} has no effect unless ${configVariable} points to it`,
        fix: `Set ${configVariable}=${file} where pip runs, or put the options in the requirements file pip installs from`,
      });
    }
  }
  const format = requirementsFormatOf(tool);
  // Options of the requirements parser are accepted; --hash and --config-settings on a line of their own are ignored.
  const allowed = new Set([...extraOf(tool, 'requirementsOptions', isStrings), ...requirementsLongOptions(format)]);
  const cooldownFlag = `--${settingOf(tool.cooldown.setting) ?? ''}`;
  const variable = extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string');
  for (const file of configFiles) {
    for (const { option, line } of requirementsOptions(context.repository, file, format)) {
      if (allowed.has(option)) continue;
      context.report({
        location: { file, line },
        message: `pip does not accept ${option} in requirements files, so installing from ${file} fails`,
        fix: option === cooldownFlag ? `Remove the line and set ${variable} where pip runs instead` : `Remove the line, and pass ${option} on the pip command line instead`,
      });
    }
  }
}

/** What the release-age delay of pip installs is checked against: the days of the policy and the names to give. */
interface PipDelay {
  days: number;
  minimum: string;
  variable: string;
  option: string;
  since: string | undefined;
}

function pipDelayOf(context: RuleContext, tool: ToolKnowledge): PipDelay | undefined {
  const policy = context.policy;
  if (policy?.cooldown === undefined) return undefined;
  const converted = convertCooldown(tool, policy.cooldown.minimum);
  if (!converted.ok || typeof converted.value !== 'number') return undefined;
  return {
    days: converted.value,
    minimum: policy.cooldown.minimum.text,
    variable: extraOf(tool, 'environmentVariable', (value): value is string => typeof value === 'string'),
    option: `--${settingOf(tool.cooldown.setting) ?? ''}`,
    since: sinceOf(tool.cooldown.availableSince),
  };
}

/**
 * The finding for the first pip install of a stage or a job whose release-age delay does not hold: none (error), fewer
 * days than the policy (error) or a fixed date (warning). `where` names the place, `add` how to set it there. true when
 * a finding was reported.
 */
function reportPipDelay(context: RuleContext, delay: PipDelay, command: ToolCommand, file: string, where: string, add: string, place: string): boolean {
  const plural = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;
  const location = { file, line: command.line };
  const instead = `Set ${delay.variable}=P${delay.days}D instead, ${place}, or as ${delay.option}=P${delay.days}D on that pip install`;
  if (command.delay === undefined) {
    context.report({
      location,
      message: `${where} without a release-age delay: pip reads no configuration from the project, and nothing sets ${delay.variable} or ${delay.option} there, so the ${delay.minimum} of ${POLICY_FILE} does not hold for it`,
      fix: `${add}, or pass ${delay.option}=P${delay.days}D to that pip install (pip ${delay.since ?? 'a recent version'} or later reads a number of days)`,
    });
    return true;
  }
  const written = /^P(\d+)D$/u.exec(command.delay)?.[1];
  if (written === undefined) {
    if (!/^\d{4}-\d{2}-\d{2}/u.test(command.delay)) return false;
    context.report({
      level: 'warning',
      location,
      message: `${where} with the release-age delay ${command.delay}, a fixed date: it holds back every later upload instead of delaying each new version by the ${delay.minimum} of ${POLICY_FILE}`,
      fix: instead,
    });
    return true;
  }
  if (Number(written) >= delay.days) return false;
  context.report({
    location,
    message: `${where} with the release-age delay ${command.delay} (${plural(Number(written))}), shorter than the ${delay.minimum} of ${POLICY_FILE} (${plural(delay.days)} for pip)`,
    fix: instead,
  });
  return true;
}

/** pip installs of a stage or job that depcurfew can judge: installs whose delay is not hidden in a configuration file. */
const judged = (command: ToolCommand) => command.tool === 'pip' && command.kind === 'install' && command.delayUnknown !== true;

/**
 * pip installs in Dockerfile stages of the official python image, which has no pip.conf: pip reads no configuration
 * from the project, so the release-age delay of the policy holds there only when the stage sets PIP_UPLOADED_PRIOR_TO
 * (ENV, also in a stage it starts from, or on the command) or passes --uploaded-prior-to, with at least as many days
 * (decision D-115). A stage (or one it starts from) that copies a pip.conf or pip.ini, writes pip's configuration
 * (pip config set) or names one with PIP_CONFIG_FILE is not checked.
 */
function checkPipDockerfiles(context: RuleContext, tool: ToolKnowledge): void {
  const policy = context.policy;
  const delay = pipDelayOf(context, tool);
  if (policy === undefined || delay === undefined || (policy.targets !== 'auto' && !policy.targets.includes('pip'))) return;
  const names = extraOf(tool, 'configFileNames', isStrings);
  for (const file of context.detection.dockerfiles) {
    const configured: boolean[] = [];
    for (const [index, stage] of file.stages.entries()) {
      const own = stage.pipConfig === true || (stage.copies ?? []).some((source) => names.includes(source.split('/').at(-1) ?? ''));
      configured.push(own || (stage.from !== undefined && stage.from < index && configured[stage.from] === true));
      if (stage.runtime?.tool !== 'python' || configured[index] === true) continue;
      const name = stage.name === undefined ? `the stage at line ${stage.line}` : `stage ${stage.name}`;
      for (const command of stage.commands.filter(judged)) {
        const where = `${name} in ${file.file} installs packages with pip on line ${command.line}`;
        const add = `Add ENV ${delay.variable}=P${delay.days}D to ${name} before line ${command.line}`;
        if (reportPipDelay(context, delay, command, file.file, where, add, `with ENV in ${name} before line ${command.line}`)) break;
      }
    }
  }
}

/** The directory listed in projects a command's working directory lies in; '' for the root. */
function projectOfCommand(command: ToolCommand, projects: readonly string[]): string {
  const directory = command.directory;
  if (directory === undefined) return '';
  return projects.find((project) => directory === project || directory.startsWith(`${project}/`)) ?? '';
}

/**
 * pip installs in CI jobs, as in Dockerfile stages (decision D-115): pip takes the release-age delay only from
 * PIP_UPLOADED_PRIOR_TO in the env of the workflow, the job or the step (or set on the command line, or exported before)
 * or from --uploaded-prior-to. An install in the directory of a project (working-directory, cd) counts when that
 * project uses pip, with the policy of the root it shares. A job that may change pip's configuration (pip config set,
 * a pip.conf it writes, PIP_CONFIG_FILE) is not checked.
 */
function checkPipJobs(context: RuleContext, tool: ToolKnowledge): void {
  const policy = context.policy;
  const delay = pipDelayOf(context, tool);
  if (policy === undefined || delay === undefined || (policy.targets !== 'auto' && !policy.targets.includes('pip'))) return;
  const views = context.projects ?? [];
  const projects = views.map((view) => view.directory);
  const pipIn = (detection: RuleContext['detection']) => detection.packageManagers.some((manager) => manager.id === 'pip' && manager.supported);
  const usesPip = new Map<string, boolean>([['', pipIn(context.detection)], ...views.map((view): [string, boolean] => [view.directory, pipIn(view.detection)])]);
  for (const job of context.detection.jobs) {
    if (job.pipConfig === true) continue;
    for (const command of [...job.commands].sort((a, b) => a.line - b.line).filter(judged)) {
      const project = projectOfCommand(command, projects);
      if (usesPip.get(project) !== true) continue;
      // The job named by its id only when GitHub accepts it as one (decision D-135).
      const named = jobLabel(job.id, job.line);
      const where = `${named} in ${job.file} installs packages with pip${project === '' ? '' : ` in ${project}`} on line ${command.line}`;
      const add = `Add ${delay.variable}: P${delay.days}D to the env of ${named} (or of that step)`;
      if (reportPipDelay(context, delay, command, job.file, where, add, `in the env of ${named} or of that step`)) break;
    }
  }
}

const PYTHON_TOOLS: ReadonlySet<string> = new Set(['uv', 'pip', 'pdm', 'pipenv']);

export const pythonConfigIgnored: Rule = {
  id: 'python-config-ignored',
  checks: 'Python tools read their settings where they are written',
  summary: 'A Python tool ignores a setting where it is written.',
  description:
    'uv reads uv.toml instead of [tool.uv] when both exist, and in a workspace only the root; pip reads no configuration from the project (a pip.conf counts only where PIP_CONFIG_FILE names it) and rejects options it does not know in requirements files, so a CI job or a Dockerfile stage of the python image installs without the release-age delay unless it sets PIP_UPLOADED_PRIOR_TO or passes --uploaded-prior-to; PDM in uv mode installs without only-binary; Pipenv with resolver_backend (or its older name resolver) set to "pure-python" or "uv" locks without cool-down-period. A setting in such a place looks effective but is not, and an exclude-newer date freezes dependencies instead of delaying new versions.',
  help: 'Move the setting to the file the tool reads.',
  level: 'error',
  requiresPolicy: false,
  // The tools check looks at, whether or not the knowledge base covers their version.
  applies: (scope) => scope.detection.packageManagers.some((manager) => PYTHON_TOOLS.has(manager.id)),
  check(context) {
    for (const manager of context.detection.packageManagers) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      if (tool.id === 'uv') checkUv(context, tool);
      if (tool.id === 'pip') {
        checkPip(context, tool, manager.configFiles);
        checkPipDockerfiles(context, tool);
      }
      if (tool.id === 'pdm') checkPdm(context, tool);
      if (tool.id === 'pipenv') checkPipenv(context, tool);
    }
    // CI jobs of the root also install in projects, which may use pip when the root does not.
    const pip = context.tools.find((entry) => entry.id === 'pip');
    if (pip !== undefined) checkPipJobs(context, pip);
  },
};
