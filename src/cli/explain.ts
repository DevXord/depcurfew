import { detectProject } from '../detect/index.ts';
import type { Detection, DetectionWarning, DockerStage, ToolCommand, VersionDeclaration } from '../detect/types.ts';
import { WARNING_FIXES } from '../doctor/unreadable-warnings.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ToolId } from '../knowledge/types.ts';
import { convertCooldown } from '../policy/convert.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { makeNotice } from '../doctor/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { loadPolicyIfPresent, PolicyError } from '../apply/index.ts';
import { join } from 'node:path';
import { projectProblems, relocateDetection } from '../apply/projects.ts';
import { autoTargets, directoryTargets } from '../apply/targets.ts';
import { listing } from '../apply/requirements.ts';
import { rootPlaces } from '../doctor/rules/bundled-versions.ts';
import { policyEffects, type PolicyEffects, type ToolEffect } from '../apply/effects.ts';
import type { PolicyPart } from '../apply/warnings.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import { managerName, toolName } from './describe.ts';
import { paint, PLAIN, type Paint } from '../color.ts';
import { printable } from '../printable.ts';
import { safeJson } from '../json-safe.ts';
import { inputErrorLines, policyInputError, projectDirectory, reportInputError, type InputError } from './directory.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from './io.ts';

type CooldownEntry =
  | { tool: ToolId; ok: true; unit: string; value: number | string; exact: boolean }
  | { tool: ToolId; ok: false; reason: string };

type Access = 'allow' | 'deny';
type SourceKind = (typeof SOURCE_KINDS)[number];

/** What apply does with a part of the policy for each tool (decision D-117): the settings it writes, its warnings. */
export interface PartReport {
  tools: ToolEffect[];
}

/** installScripts as the policy gives it, and what apply does with it for each tool. */
export type InstallScriptsReport = { default: Access; allow: string[]; deny: string[] } & PartReport;

/** The dependency sources the policy manages, and what apply does with them for each tool. */
export type SourcesReport = Partial<Record<SourceKind, Access>> & PartReport;

export type PolicyReport =
  | {
      file: string;
      valid: true;
      targets: { mode: 'auto' | 'listed'; tools: ToolId[] };
      cooldown: { minimum: string; tools: CooldownEntry[] } | null;
      installScripts: InstallScriptsReport | null;
      sources: SourcesReport | null;
    }
  | { file: string; valid: false; issues: string[] };

/**
 * A warning of detection as explain reports it: with a level, the file it concerns and what to do, like the warnings of
 * the other commands (decision D-107; new fields, the code, message and files stay).
 */
export interface ExplainWarning extends DetectionWarning {
  level: 'warning';
  /** With the line of the first file when the warning names one (script-not-followed, decision D-124). */
  location?: { file: string; line?: number };
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
  | {
      directory: string;
      project: ExplainDetection;
      fromRoot: FromRoot;
      targets: { mode: 'auto' | 'listed'; tools: ToolId[] };
      /** What apply does with installScripts and sources there (decision D-117); null when the policy has no such part. */
      installScripts: PartReport | null;
      sources: PartReport | null;
    }
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

function explainedWarning(warning: DetectionWarning): ExplainWarning {
  const file = warning.files[0];
  return {
    code: warning.code,
    level: 'warning',
    ...(file === undefined ? {} : { location: { file, ...(warning.line === undefined ? {} : { line: warning.line }) } }),
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
  // One plan of the whole repository, as apply makes it, only when the policy has a part it shows (decision D-117).
  const effects = policy.installScripts === undefined && policy.sources === undefined ? undefined : policyEffects(directory, policy, detection);
  const part = (name: PolicyPart, project: string | undefined, ids: readonly ToolId[]) => partReport(effects, policy, name, project, ids);
  const problems = projectProblems(directory, policy.projects, detection);
  const projects = policy.projects.map((entry): ProjectReport => {
    const problem = problems.find((item) => item.project === entry);
    if (problem !== undefined) return { directory: entry, project: null, error: { code: problem.code, level: 'error', location: problem.location, message: problem.message, fix: problem.fix } };
    const root = join(directory, entry);
    const found = detectProject(root);
    const { targets } = directoryTargets(root, policy, found, knowledgeBase, { project: entry, withProjects });
    const places = rootPlaces(detection, entry, found);
    const fromRoot: FromRoot = { versions: [...places.versions], dockerfiles: places.dockerfiles.map((item) => ({ file: item.file.file, stages: [...item.stages] })) };
    return {
      directory: entry,
      project: explained(relocateDetection(entry, found)),
      fromRoot,
      targets: { mode, tools: [...targets] },
      installScripts: part('installScripts', entry, [...targets]),
      sources: part('sources', entry, [...targets]),
    };
  });
  const tools = withProjects ? [...directoryTargets(directory, policy, detection, knowledgeBase, { withProjects }).targets] : policy.targets === 'auto' ? autoTargets(directory, detection).targets : [...policy.targets];
  const every = [...new Set([...tools, ...projects.flatMap((entry) => ('targets' in entry ? entry.targets.tools : []))])];
  const ordered = knowledgeBase.map((tool) => tool.id).filter((id) => every.includes(id));
  // A directory that cannot be used is an error, as in apply, with the line of its entry in depcurfew.json.
  const errors = problems.map((problem): InputError => ({ code: problem.code, level: 'error', location: problem.location, message: problem.message, fix: problem.fix }));
  const scripts = policy.installScripts;
  const installScripts = scripts === undefined ? null : { default: scripts.default, allow: [...scripts.allow], deny: [...scripts.deny], tools: part('installScripts', undefined, tools)?.tools ?? [] };
  const sources = policy.sources === undefined ? null : { ...sourceAccess(policy.sources), tools: part('sources', undefined, tools)?.tools ?? [] };
  return {
    policy: { file: POLICY_FILE, valid: true, targets: { mode, tools }, cooldown: cooldownReport(policy, withProjects ? ordered : tools), installScripts, sources },
    projects,
    errors,
    withProjects,
  };
}

/** The sources the policy manages, in the order of the policy schema. */
function sourceAccess(sources: NonNullable<ResolvedPolicy['sources']>): Partial<Record<SourceKind, Access>> {
  return Object.fromEntries(SOURCE_KINDS.flatMap((kind) => (sources[kind] === undefined ? [] : [[kind, sources[kind]]])));
}

/** What apply does with a part of the policy for the tools of one directory; null when the policy lacks the part. */
function partReport(effects: PolicyEffects | undefined, policy: ResolvedPolicy, name: PolicyPart, project: string | undefined, tools: readonly ToolId[]): PartReport | null {
  if (effects === undefined || policy[name] === undefined) return null;
  return { tools: tools.map((tool) => effects(project, name, tool)) };
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
  if (policy.cooldown === null) lines.push('  cooldown: not managed');
  else {
    lines.push(`  cooldown ${policy.cooldown.minimum}:`);
    for (const entry of policy.cooldown.tools) {
      const name = toolName(entry.tool);
      lines.push(
        entry.ok
          ? `    ${name}: ${amount(entry.value, entry.unit)}${entry.exact ? '' : ' (rounded up)'}`
          : `    ${name}: cannot apply: ${entry.reason}`,
      );
    }
  }
  const scripts = policy.installScripts;
  const lists = scripts === null ? [] : [...(scripts.allow.length === 0 ? [] : [`allow ${listing(scripts.allow)}`]), ...(scripts.deny.length === 0 ? [] : [`deny ${listing(scripts.deny)}`])];
  lines.push(...partLines(scripts === null ? 'installScripts' : `installScripts ${[scripts.default, ...lists].join(', ')}`, scripts));
  const sources = policy.sources;
  const access = sources === null ? [] : SOURCE_KINDS.flatMap((kind) => (sources[kind] === undefined ? [] : [`${kind} ${sources[kind]}`]));
  lines.push(...partLines(access.length === 0 ? 'sources' : `sources ${access.join(', ')}`, sources));
  return lines;
}

/**
 * What apply does with a part of the policy (decision D-117), one line per tool: the settings it writes with their
 * files, then apply's warnings with their codes and what to do; "nothing to write" when it writes nothing and has
 * nothing to say. The JSON document holds the same settings and warnings.
 */
function partLines(heading: string, part: PartReport | null): string[] {
  if (part === null) return [`  ${heading}: not managed`];
  if (part.tools.length === 0) return [`  ${heading}: no tools to configure`];
  return [`  ${heading}:`, ...part.tools.map((entry) => `    ${toolName(entry.tool)}: ${effectText(entry)}`)];
}

function effectText(entry: ToolEffect): string {
  // Settings grouped by file (and TOML table), in the order the generator writes them.
  const places: { place: string; settings: string[] }[] = [];
  for (const { setting, file, table } of entry.settings) {
    const place = table === undefined ? file : `[${table}] of ${file}`;
    const group = places.find((item) => item.place === place);
    if (group === undefined) places.push({ place, settings: [setting] });
    else group.settings.push(setting);
  }
  // Warnings with the same code and fix in a row share the code and the fix (the two sources a tool cannot hold).
  const warnings: { code: string; fix: string | undefined; messages: string[] }[] = [];
  for (const warning of entry.warnings) {
    const last = warnings.at(-1);
    if (last !== undefined && last.code === warning.code && last.fix === warning.fix) last.messages.push(warning.message);
    else warnings.push({ code: warning.code, fix: warning.fix, messages: [warning.message] });
  }
  const said = warnings.map((item) => `warning: ${item.messages.join('; ')} (${item.code})${item.fix === undefined ? '' : `; fix: ${item.fix}`}`);
  if (places.length === 0 && said.length === 0) return 'nothing to write';
  return [places.length === 0 ? 'nothing written' : places.map((item) => `${listing(item.settings)} in ${item.place}`).join(', '), ...said].join('; ');
}

/** Section headings (unindented lines up to their first colon) in bold, "cannot apply", "invalid" and apply's "warning" in yellow. */
function paintReport(lines: readonly string[], colors: Paint): string[] {
  return lines.map((line) => {
    const marked = line
      .replace(/: (cannot apply|cannot be used|invalid)(?=:|$)/u, (_match, word: string) => `: ${colors.yellow(word)}`)
      .replace(/(?<=^ {4}[^:]+: (?:.*; )?)warning(?=: )/gu, (word) => colors.yellow(word));
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
    // The policy's values are in the policy section; a part the policy lacks is "not managed" there.
    ...(entry.installScripts === null ? [] : partLines('installScripts', entry.installScripts)),
    ...(entry.sources === null ? [] : partLines('sources', entry.sources)),
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
  // The same notice doctor gives when the directory is a project of a parent policy (decision D-115).
  const notices = target.notice === undefined ? [] : [makeNotice('policy-from-parent', target.notice, POLICY_FILE)];
  if (json) {
    const { errors, ...rest } = report;
    io.stdout(`${safeJson({ ...rest, notices, errors }, 2)}\n`);
  } else {
    for (const notice of notices) io.stderr(`note: ${notice.message} (${notice.code})\n`);
    io.stdout(renderReport(report, paint(io.colors?.stdout)));
  }
  return report.errors.length > 0 ? EXIT_FAILURE : EXIT_OK;
}
