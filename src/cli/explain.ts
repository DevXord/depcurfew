import { detectProject } from '../detect/index.ts';
import type { Detection, DetectionWarning, DockerStage, ToolCommand, VersionDeclaration } from '../detect/types.ts';
import { UNREADABLE_WARNINGS } from '../doctor/unreadable-warnings.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId } from '../knowledge/types.ts';
import { convertCooldown } from '../policy/convert.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { join } from 'node:path';
import { projectProblems, relocateDetection } from '../apply/projects.ts';
import { autoTargets, directoryTargets } from '../apply/targets.ts';
import { listing } from '../apply/requirements.ts';
import { rootPlaces } from '../doctor/rules/bundled-versions.ts';
import { managerName, toolName } from './describe.ts';
import { paint, PLAIN, type Paint } from '../color.ts';
import { printable } from '../printable.ts';
import { safeJson } from '../json-safe.ts';
import { inputErrorLines, policyInputError, projectDirectory, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

type CooldownEntry =
  | { tool: ToolId; ok: true; unit: string; value: number | string; exact: boolean }
  | { tool: ToolId; ok: false; reason: string };

export type PolicyReport =
  | {
      file: string;
      valid: true;
      targets: { mode: 'auto' | 'listed'; tools: ToolId[] };
      cooldown: { minimum: string; tools: CooldownEntry[] } | null;
    }
  | { file: string; valid: false; issues: string[] };

/**
 * A warning of detection as explain reports it: with a level, the file it concerns and what to do, like the warnings of
 * the other commands (decision D-107; new fields, the code, message and files stay).
 */
export interface ExplainWarning extends DetectionWarning {
  level: 'warning';
  location?: { file: string };
  fix: string;
}

/** What detection found, with the warnings as explain reports them. */
export type ExplainDetection = Omit<Detection, 'warnings'> & { warnings: ExplainWarning[] };

/**
 * What a project takes from the repository root (decisions D-109 and D-111): the root's Node.js version files of the
 * kinds it has none of, and the stages of root Dockerfiles that build it (numbers from 0, as `from` counts them). Files
 * are named relative to the root.
 */
export interface FromRoot {
  versions: VersionDeclaration[];
  dockerfiles: { file: string; stages: number[] }[];
}

/** A directory listed in projects in depcurfew.json (decision D-100), with its files named relative to the root. */
export type ProjectReport =
  | { directory: string; project: ExplainDetection; fromRoot: FromRoot; targets: { mode: 'auto' | 'listed'; tools: ToolId[] } }
  | { directory: string; project: null; error: { code: string; level: 'error'; location: { file: string; line?: number }; message: string; fix: string } };

export interface ExplainReport {
  schemaVersion: 1;
  project: ExplainDetection;
  policy: PolicyReport | null;
  /** The directories listed in projects; empty without them or without a usable policy. */
  projects: ProjectReport[];
  /** A depcurfew.json that cannot be used, in the shape of the errors of apply --json and check --json. */
  errors: InputError[];
}

/** What to do about each warning of detection; the fixes of unreadable-config for files that could not be read. */
const WARNING_FIXES: Readonly<Record<string, string>> = {
  ...UNREADABLE_WARNINGS,
  'nothing-detected': `Run depcurfew explain in the directory of the project, or list the directories of the projects under projects in ${POLICY_FILE}`,
  'invalid-package-manager': 'Write packageManager in package.json as name@version, with a package manager depcurfew knows',
  'package-manager-assumed': 'Commit the lockfile, or name the package manager and its version in packageManager in package.json',
  'yarn-classic-unsupported': 'Move to Yarn 2 or later, or to another package manager depcurfew configures',
  'renovate-config-in-package-json': 'Move the renovate key of package.json to renovate.json',
  'multiple-lockfiles': 'Remove the lockfiles of the package managers the project does not use',
  'package-manager-mismatch': 'Commit the lockfile of the package manager that packageManager in package.json names, or correct packageManager',
  'python-tool-unknown': `Commit the lockfile of the tool that installs the project, or name the tool in targets in ${POLICY_FILE}`,
};

function explainedWarning(warning: DetectionWarning): ExplainWarning {
  const file = warning.files[0];
  return {
    code: warning.code,
    level: 'warning',
    ...(file === undefined ? {} : { location: { file } }),
    message: warning.message,
    files: warning.files,
    fix: WARNING_FIXES[warning.code] ?? 'Run depcurfew doctor, which says what to do about it',
  };
}

/**
 * The detection with its warnings as explain reports them. A root that holds nothing but the directories listed in
 * projects has no nothing-detected warning: the projects are what it holds.
 */
function explained(detection: Detection, withProjects = false): ExplainDetection {
  const warnings = detection.warnings.filter((warning) => !(withProjects && warning.code === 'nothing-detected'));
  return { ...detection, warnings: warnings.map(explainedWarning) };
}

function cooldownReport(policy: ResolvedPolicy, tools: readonly ToolId[]): { minimum: string; tools: CooldownEntry[] } | null {
  if (policy.cooldown === undefined) return null;
  const minimum = policy.cooldown.minimum;
  const entries = tools.flatMap((id): CooldownEntry[] => {
    const tool = knowledgeBase.find((entry) => entry.id === id);
    if (tool === undefined) return [];
    const result = convertCooldown(tool, minimum);
    return [
      result.ok
        ? { tool: id, ok: true, unit: result.unit, value: result.value, exact: result.exact }
        : { tool: id, ok: false, reason: result.reason },
    ];
  });
  return { minimum: minimum.text, tools: entries };
}

/**
 * The policy section and the projects; a depcurfew.json that cannot be used is read as apply reads it, with the same
 * error. With projects, the targets are the ones apply configures in each directory, and the cooldown is converted for
 * every tool of the root and of the projects.
 */
function policyReport(directory: string, detection: Detection): { policy: PolicyReport | null; projects: ProjectReport[]; errors: InputError[]; withProjects: boolean } {
  let policy: ResolvedPolicy | undefined;
  try {
    policy = loadPolicyIfPresent(directory);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    const issues = error.issues.length > 0 ? error.issues : [error.message];
    return { policy: { file: POLICY_FILE, valid: false, issues }, projects: [], errors: [policyInputError(error, POLICY_FILE)], withProjects: false };
  }
  if (policy === undefined) return { policy: null, projects: [], errors: [], withProjects: false };
  const mode = policy.targets === 'auto' ? ('auto' as const) : ('listed' as const);
  const withProjects = policy.projects.length > 0;
  const problems = projectProblems(directory, policy.projects, detection);
  const projects = policy.projects.map((entry): ProjectReport => {
    const problem = problems.find((item) => item.project === entry);
    if (problem !== undefined) return { directory: entry, project: null, error: { code: problem.code, level: 'error', location: problem.location, message: problem.message, fix: problem.fix } };
    const root = join(directory, entry);
    const found = detectProject(root);
    const { targets } = directoryTargets(root, policy, found, knowledgeBase, { project: entry, withProjects });
    const places = rootPlaces(detection, entry, found);
    const fromRoot: FromRoot = { versions: [...places.versions], dockerfiles: places.dockerfiles.map((item) => ({ file: item.file.file, stages: [...item.stages] })) };
    return { directory: entry, project: explained(relocateDetection(entry, found)), fromRoot, targets: { mode, tools: [...targets] } };
  });
  const tools = withProjects ? [...directoryTargets(directory, policy, detection, knowledgeBase, { withProjects }).targets] : policy.targets === 'auto' ? autoTargets(directory, detection).targets : [...policy.targets];
  const every = [...new Set([...tools, ...projects.flatMap((entry) => ('targets' in entry ? entry.targets.tools : []))])];
  const ordered = knowledgeBase.map((tool) => tool.id).filter((id) => every.includes(id));
  // A directory that cannot be used is an error, as in apply, with the line of its entry in depcurfew.json.
  const errors = problems.map((problem): InputError => ({ code: problem.code, level: 'error', location: problem.location, message: problem.message, fix: problem.fix }));
  return { policy: { file: POLICY_FILE, valid: true, targets: { mode, tools }, cooldown: cooldownReport(policy, withProjects ? ordered : tools) }, projects, errors, withProjects };
}

export function buildReport(directory: string): ExplainReport {
  const detection = detectProject(directory);
  const { withProjects, ...rest } = policyReport(directory, detection);
  return { schemaVersion: 1, project: explained(detection, withProjects), ...rest };
}

// Readable output

function where(declaration: VersionDeclaration): string {
  const location = declaration.line === undefined ? declaration.file : `${declaration.file}:${declaration.line}`;
  const value =
    'version' in declaration
      ? declaration.versionFile === undefined
        ? declaration.version
        : `${declaration.version} from ${declaration.versionFile}`
      : `from ${declaration.versionFile}`;
  const scope = [
    ...(declaration.job === undefined ? [] : [`job ${declaration.job}`]),
    ...(declaration.matrix === undefined ? [] : [`matrix.${declaration.matrix}`]),
    ...(declaration.stage === undefined ? [] : [`stage ${declaration.stage}`]),
  ];
  return `${value} (${[location, declaration.source, ...scope].join(', ')})`;
}

function commandText(command: ToolCommand): string {
  const what = command.kind === 'install' ? `${command.tool} installs` : `${command.tool} replaced${command.version === undefined ? '' : ` by ${command.version}`}`;
  return `${what} on line ${command.line}`;
}

/** "deps: node:22-alpine (Node.js 22), copies package.json and package-lock.json, npm installs on line 6". */
function stageText(stage: DockerStage, index: number, stages: readonly DockerStage[]): string {
  const name = stage.name ?? `#${index}`;
  const base = stage.from === undefined ? (stage.image ?? 'an image from an ARG without a value') : `stage ${stages[stage.from]?.name ?? `#${stage.from}`}`;
  const runtime = stage.runtime === undefined ? '' : stage.runtime.version === undefined ? ` (${stage.runtime.tool}, version unknown)` : ` (${stage.runtime.tool === 'node' ? 'Node.js' : 'Python'} ${stage.runtime.version})`;
  const copies = stage.copies === undefined || stage.copies.length === 0 ? [] : [`copies ${listing(stage.copies)}`];
  return [`${name}: ${base}${runtime}`, ...copies, ...stage.commands.map(commandText)].join(', ');
}

function amount(value: number | string, unit: string): string {
  if (typeof value === 'string') return value;
  return `${value} ${value === 1 ? unit.replace(/s$/u, '') : unit}`;
}

const AT_ROOT = 'at the repository root';

function projectLines(project: ExplainDetection, fromRoot?: { directory: string; places: FromRoot; detection: Pick<Detection, 'dockerfiles'> }): string[] {
  const lines = [project.packageManagers.length === 0 ? 'Package managers: none' : 'Package managers:'];
  for (const manager of project.packageManagers) {
    lines.push(`  ${managerName(manager)}`);
    if (manager.versions.length > 0) lines.push(`    versions: ${manager.versions.map(where).join(', ')}`);
    lines.push(`    evidence: ${manager.evidence.map((item) => `${item.file} (${item.kind})`).join(', ')}`);
    if (manager.configFiles.length > 0) lines.push(`    config files: ${manager.configFiles.join(', ')}`);
  }
  // A project also uses the root's version files of the kinds it has none of (decision D-111).
  const versions = [...project.node.versions.map((version) => `  ${where(version)}`), ...(fromRoot?.places.versions ?? []).map((version) => `  ${where(version).replace(/\)$/u, `, ${AT_ROOT})`)}`)];
  if (versions.length === 0) lines.push('Node.js versions: none declared');
  else lines.push('Node.js versions:', ...versions);
  if (project.bots.length === 0) lines.push('Bots: none');
  else lines.push('Bots:', ...project.bots.map((bot) => `  ${toolName(bot.id)}: ${bot.configFiles.join(', ')}`));
  if (project.workspaces === null) {
    lines.push('Workspaces: none');
  } else {
    const packages = project.workspaces.packages.length === 0 ? 'no packages' : project.workspaces.packages.join(', ');
    lines.push(`Workspaces: ${packages} (declared in ${project.workspaces.declarations.map((item) => item.file).join(', ')})`);
  }
  // An .npmrc that exists but is not a regular file is not one depcurfew read, but it is not missing either.
  const special = project.warnings.filter((warning) => warning.code === 'not-a-regular-file').flatMap((warning) => warning.files);
  const npmrc = [...project.npmrcFiles, ...special.map((file) => `${file} (not a regular file, not read)`)];
  lines.push(`.npmrc files: ${npmrc.length === 0 ? 'none' : npmrc.join(', ')}`);
  lines.push(`GitHub Actions workflows: ${project.workflows.length === 0 ? 'none' : project.workflows.join(', ')}`);
  // The stages of root Dockerfiles that build the project (they copy only its files).
  const rootStages = (fromRoot?.places.dockerfiles ?? []).flatMap((entry) => {
    const file = fromRoot?.detection.dockerfiles.find((item) => item.file === entry.file);
    if (file === undefined) return [];
    const stages = entry.stages.length === 1 ? 'the stage below builds' : 'the stages below build';
    return [`  ${entry.file} (${AT_ROOT}; ${stages} ${fromRoot?.directory ?? ''})`, ...entry.stages.map((index) => `    ${stageText(file.stages[index] as DockerStage, index, file.stages)}`)];
  });
  const dockerfiles = [...project.dockerfiles.flatMap((file) => [`  ${file.file}`, ...file.stages.map((stage, index) => `    ${stageText(stage, index, file.stages)}`)]), ...rootStages];
  if (dockerfiles.length === 0) lines.push('Dockerfiles: none');
  else lines.push('Dockerfiles:', ...dockerfiles);
  if (project.warnings.length === 0) lines.push('Warnings: none');
  else lines.push('Warnings:', ...project.warnings.flatMap((warning) => [`  ${warning.code}: ${warning.message}`, `    fix: ${warning.fix}`]));
  return lines;
}

function policyLines(policy: PolicyReport | null, errors: readonly InputError[]): string[] {
  if (policy === null) return [`Policy: no ${POLICY_FILE}`];
  // As apply says it: the level, the message with its code, the issues and what to do (decision D-111).
  if (!policy.valid) {
    const error = errors.find((item) => item.location.file === policy.file && item.code.startsWith('policy-')) ?? errors[0];
    const details = error === undefined ? policy.issues.map((issue) => `  ${issue}`) : inputErrorLines(error).map((line) => `  ${line}`);
    return [`Policy (${policy.file}): invalid`, ...details];
  }
  const names = policy.targets.tools.map(toolName);
  const lines = [
    `Policy (${policy.file}):`,
    `  targets: ${names.length === 0 ? 'none' : names.join(', ')} (${policy.targets.mode === 'auto' ? 'detected' : 'listed'})`,
  ];
  if (policy.cooldown === null) return [...lines, '  cooldown: not managed'];
  lines.push(`  cooldown ${policy.cooldown.minimum}:`);
  for (const entry of policy.cooldown.tools) {
    const name = toolName(entry.tool);
    lines.push(
      entry.ok
        ? `    ${name}: ${amount(entry.value, entry.unit)}${entry.exact ? '' : ' (rounded up)'}`
        : `    ${name}: cannot apply: ${entry.reason}`,
    );
  }
  return lines;
}

/** Section headings (unindented lines up to their first colon) in bold, "cannot apply" and "invalid" in yellow. */
function paintReport(lines: readonly string[], colors: Paint): string[] {
  return lines.map((line) => {
    const marked = line.replace(/: (cannot apply|cannot be used|invalid)(?=:|$)/u, (_match, word: string) => `: ${colors.yellow(word)}`);
    return /^\S/u.test(marked) ? marked.replace(/^[^:]+:/u, (heading) => colors.bold(heading)) : marked;
  });
}

/** A directory listed in projects: what was found there and what apply configures, or why it cannot be used. */
function listedProjectLines(entry: ProjectReport, rootDetection: Pick<Detection, 'dockerfiles'>): string[] {
  if (entry.project === null) {
    // As apply says it: the level, then the entry of depcurfew.json, unless the message names the file itself.
    const { file, line } = entry.error.location;
    const where = entry.error.message.includes(file) ? '' : `${file}${line === undefined ? '' : ` (line ${line})`}: `;
    return [`Project ${entry.directory}: cannot be used`, `  error: ${where}${entry.error.message} (${entry.error.code})`, `  fix: ${entry.error.fix}`];
  }
  const names = entry.targets.tools.map(toolName);
  return [
    `Project ${entry.directory}:`,
    ...projectLines(entry.project, { directory: entry.directory, places: entry.fromRoot, detection: rootDetection }).map((line) => `  ${line}`),
    `  targets: ${names.length === 0 ? 'none' : names.join(', ')} (${entry.targets.mode === 'auto' ? 'detected' : 'listed'})`,
  ];
}

export function renderReport(report: ExplainReport, colors: Paint = PLAIN): string {
  // Every line holds names and values from the repository: control characters in them are shown as text.
  const projects = report.projects.flatMap((entry) => ['', ...listedProjectLines(entry, report.project)]);
  const lines = [...projectLines(report.project), '', ...policyLines(report.policy, report.errors), ...projects].map((line) => printable(line));
  return `${paintReport(lines, colors).join('\n')}\n`;
}

export function explain(directory: string | undefined, json: boolean, io: CliIo): number {
  const target = projectDirectory(directory, 'explain');
  if (!target.ok) {
    if (json) io.stdout(`${safeJson({ schemaVersion: 1, project: null, policy: null, projects: [], notices: [], errors: [target.error] }, 2)}\n`);
    else reportInputError(target.error, io);
    return EXIT_USAGE;
  }
  const report = buildReport(target.directory);
  const notices = target.notice === undefined ? [] : [{ message: target.notice }];
  if (json) {
    const { errors, ...rest } = report;
    io.stdout(`${safeJson({ ...rest, notices, errors }, 2)}\n`);
  } else {
    for (const notice of notices) io.stderr(`note: ${notice.message}\n`);
    io.stdout(renderReport(report, paint(io.colors?.stdout)));
  }
  return report.errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
}
