// Part of manager-version-too-old: the npm that comes with a declared Node.js, and the pip that comes with the python
// image, must know the settings in use wherever nothing replaces them. A CI job that installs with npm after setup-node,
// a Dockerfile stage that installs with npm or pip, and the version files developers use (.nvmrc, .node-version,
// Volta, .tool-versions, devEngines.runtime, engines.node of a private package) decide which Node.js runs. The same
// places tell `apply` which npm versions a repository without a pinned npm runs (npmInUse, decision D-105).
import { describeRequirements, type Requirement } from '../../apply/requirements.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import { values } from '../../apply/facts.ts';
import type { PlanOptions } from '../../apply/index.ts';
import { versionedValue } from '../effective.ts';
import type { Detection, DockerfileInfo, DockerStage, PackageManagerInfo, ToolCommand, VersionDeclaration, WorkflowJob } from '../../detect/types.ts';
import { environment } from '../../knowledge/environment.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { managerSources } from '../projects.ts';
import type { Level, RuleContext } from '../types.ts';
import { formatBound, lowestVersion } from '../version-range.ts';
import {
  firstReleasesWith,
  namingOf,
  newestLineOf,
  nodeBundledNpm,
  pythonBundledPip,
  releasesPhrase,
  runtimeFacts,
  supportedLtsLines,
  today,
  type Naming,
  type Resolution,
  type Resolved,
  type RuntimeFacts,
} from '../runtime-versions.ts';

/** A setting in use, and another way to have it from an earlier version (strict-allow-scripts=true in .npmrc). */
export type Needed = Requirement & { instead?: { setting: string; file: string; since: string } };

export interface BundledHelpers {
  /** The settings in use for a tool, read with the given context (the root's, or a project's). */
  features: (tool: ToolKnowledge, context: RuleContext) => readonly Needed[];
  missing: (features: readonly Needed[], below: (since: Version) => boolean) => Needed[];
  /** The earlier version that is enough with the other way of a missing setting (alternativeOf in manager-version.ts). */
  alternative: (missing: readonly Needed[], name: string, advice: StrictAdvice) => { version: Version; suffix: (change: 'repository' | 'machine') => string; set: string } | undefined;
  line: (declaration: VersionDeclaration) => number | undefined;
  label: (declaration: VersionDeclaration) => string;
}

/** What depcurfew apply does about strict-allow-scripts in a directory (strictAdvice). */
export interface StrictAdvice {
  /** It writes it for the repository as it is. */
  now: boolean;
  /** It configures npm there, so a change of the repository that brings an npm 11.16 to 11.x makes it write it. */
  targeted: boolean;
}

export const SOURCE_LABEL: Record<VersionDeclaration['source'], string> = {
  packageManager: 'packageManager',
  'tool-config': 'the required version',
  devEngines: 'devEngines',
  volta: 'Volta',
  'tool-versions': '.tool-versions',
  nvmrc: '.nvmrc',
  'node-version': '.node-version',
  engines: 'engines',
  'github-actions': 'GitHub Actions',
  dockerfile: 'Dockerfile',
};

const RULE = 'manager-version-too-old';
/** Where developers choose their Node.js; anyone can install another npm, so these give warnings. */
const DEVELOPER_SOURCES = new Set<VersionDeclaration['source']>(['nvmrc', 'node-version', 'volta', 'tool-versions', 'devEngines', 'engines']);

function newest(versions: readonly Version[]): Version {
  return versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

function bundledText(tool: string, bundled: readonly Version[]): string {
  const low = bundled[0] as Version;
  const high = bundled.at(-1) as Version;
  return compareVersions(low, high) === 0 ? `${tool} ${formatVersion(low)}` : `${tool} ${formatVersion(low)} to ${formatVersion(high)}`;
}

// Jobs of the workflows, indexed once per detection (decision D-105): a matrix of hundreds of values times many setup
// steps must not make every declaration look at every other one.

interface JobGroup {
  job: WorkflowJob;
  /** The Node.js declarations of the job's setup steps, in detection order. */
  declarations: VersionDeclaration[];
  /** The lines of the job's Node.js setup steps, sorted, each once. */
  steps: number[];
  /** The job's commands sorted by line, and their lines. */
  commands: ToolCommand[];
  lines: number[];
  /** The commands after a step line, by that line. */
  after: Map<number, readonly ToolCommand[]>;
}

export interface JobIndex {
  /** Every job of the detection, in order. */
  groups: readonly JobGroup[];
  /** The job a github-actions declaration belongs to. */
  of(declaration: VersionDeclaration): JobGroup | undefined;
}

const INDEXES = new WeakMap<Detection, JobIndex>();

function jobKey(file: string, id: string): string {
  return `${file}\u0000${id}`;
}

/** The first index whose value is greater than `value` (or `orEqual` and equal), in a sorted list. */
function firstAbove(sorted: readonly number[], value: number, orEqual = false): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const item = sorted[middle] ?? 0;
    if (item > value || (orEqual && item === value)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function jobIndex(detection: Detection): JobIndex {
  const known = INDEXES.get(detection);
  if (known !== undefined) return known;
  const byKey = new Map<string, JobGroup>();
  const groups: JobGroup[] = [];
  for (const job of detection.jobs) {
    const key = jobKey(job.file, job.id);
    if (byKey.has(key)) continue;
    const commands = [...job.commands].sort((a, b) => a.line - b.line);
    const group: JobGroup = { job, declarations: [], steps: [], commands, lines: commands.map((command) => command.line), after: new Map() };
    byKey.set(key, group);
    groups.push(group);
  }
  for (const declaration of detection.node.versions) {
    if (declaration.source !== 'github-actions' || declaration.job === undefined) continue;
    const group = byKey.get(jobKey(declaration.file, declaration.job));
    if (group === undefined) continue;
    group.declarations.push(declaration);
    if (declaration.step !== undefined) group.steps.push(declaration.step);
  }
  for (const group of groups) group.steps = [...new Set(group.steps)].sort((a, b) => a - b);
  const index: JobIndex = { groups, of: (declaration) => (declaration.job === undefined ? undefined : byKey.get(jobKey(declaration.file, declaration.job))) };
  INDEXES.set(detection, index);
  return index;
}

/**
 * The commands of a job that use the Node.js a setup step declares: after that step and before the next step that
 * sets up Node.js again (a job can build on one version and then test on another). Without a step line, all of them.
 * Binary searches over the sorted lines, and the result is kept per step.
 */
export function commandsAfterStep(group: JobGroup, declaration: VersionDeclaration): readonly ToolCommand[] {
  const step = declaration.step;
  if (step === undefined) return group.commands;
  const known = group.after.get(step);
  if (known !== undefined) return known;
  const next = group.steps[firstAbove(group.steps, step)];
  const { lines } = group;
  const start = firstAbove(lines, step);
  const end = next === undefined ? lines.length : firstAbove(lines, next - 1);
  const found = group.commands.slice(start, Math.max(start, end));
  group.after.set(step, found);
  return found;
}

/** The first install with the tool that nothing before it replaced; undefined when the tool is replaced first or not used. */
function firstPlainInstall(commands: readonly ToolCommand[], tool: 'npm' | 'pip', replaced: boolean): number | undefined {
  if (replaced) return undefined;
  for (const command of commands) {
    if (command.tool !== tool) continue;
    // After a replacement no later install uses the bundled tool.
    if (command.kind === 'upgrade') return undefined;
    return command.line;
  }
  return undefined;
}

/** The project (a directory listed in projects) a command's working directory lies in; '' for the root. */
function projectOf(command: ToolCommand, projects: readonly string[]): string {
  const directory = command.directory;
  if (directory === undefined) return '';
  return projects.find((project) => directory === project || directory.startsWith(`${project}/`)) ?? '';
}

/** Per project ('' for the root): the first npm install of the commands that nothing before it replaced. */
function firstInstallsByProject(commands: readonly ToolCommand[], projects: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const command of commands) {
    if (command.tool !== 'npm') continue;
    // npm install -g npm replaces npm for the whole job, whatever the directory.
    if (command.kind === 'upgrade') break;
    const project = projectOf(command, projects);
    if (!found.has(project)) found.set(project, command.line);
  }
  return found;
}

/**
 * The root jobs, with only the commands that install in `project` or replace npm or pip, for a project's plan and the
 * npm it runs: a CI job with working-directory: frontend uses frontend/.npmrc (decision D-105). Declarations stay those
 * of the root workflow files.
 */
export function jobsInProject(detection: Detection, project: string): { jobs: WorkflowJob[]; versions: VersionDeclaration[] } {
  const jobs = detection.jobs
    .map((job) => ({ ...job, commands: job.commands.filter((command) => command.kind === 'upgrade' || projectOf(command, [project]) === project) }))
    .filter((job) => job.commands.some((command) => command.kind === 'install'));
  const keys = new Set(jobs.map((job) => jobKey(job.file, job.id)));
  const versions = detection.node.versions.filter((declaration) => declaration.source === 'github-actions' && declaration.job !== undefined && keys.has(jobKey(declaration.file, declaration.job)));
  return { jobs: jobs.map((job) => ({ ...job, commands: job.commands.map(({ directory: _directory, ...command }) => command) })), versions };
}

/**
 * For every stage: the stage it starts from, up to the one with an image, and whether the tool was replaced on the
 * way. A stage only starts from an earlier one, so one pass in order is enough, also for a long chain of stages.
 */
function ancestries(file: DockerfileInfo, tool: 'npm' | 'pip'): { root: DockerStage; replaced: boolean }[] {
  const found: { root: DockerStage; replaced: boolean }[] = [];
  for (const [index, stage] of file.stages.entries()) {
    const from = stage.from;
    const parent = from === undefined || from >= index ? undefined : file.stages[from];
    const above = from === undefined ? undefined : found[from];
    if (parent === undefined || above === undefined) {
      found.push({ root: stage, replaced: false });
      continue;
    }
    found.push({ root: above.root, replaced: above.replaced || parent.commands.some((command) => command.tool === tool && command.kind === 'upgrade') });
  }
  return found;
}

/** "Node.js 22 (matrix.node) in GitHub Actions (.github/workflows/ci.yml, job test)", "Node.js 22 in .nvmrc". */
export function nodeSubject(declaration: VersionDeclaration & { version: string }, label: string): string {
  const matrix = declaration.matrix === undefined ? '' : ` (matrix.${declaration.matrix})`;
  const where = declaration.source === 'github-actions' && declaration.job !== undefined ? `${declaration.file}, job ${declaration.job}` : declaration.file;
  const from = declaration.versionFile === undefined ? '' : ` from ${declaration.versionFile}`;
  return `Node.js ${declaration.version}${matrix}${from} in ${label === where ? label : `${label} (${where})`}`;
}

/** nodeBundledNpm with the result kept per text, for a matrix that repeats one version in many steps. */
function resolver(facts: RuntimeFacts): (text: string, naming: Naming) => Resolved {
  const known = new Map<string, Resolved>();
  return (text, naming) => {
    const key = `${naming}\u0000${text}`;
    let found = known.get(key);
    if (found === undefined) {
      found = nodeBundledNpm(text, naming, facts);
      known.set(key, found);
    }
    return found;
  };
}

/** A CI job that installs with the npm of a declared Node.js. */
interface JobPlace {
  job: WorkflowJob;
  declaration: VersionDeclaration;
  /** '' for the root, or the project whose directory the install runs in. */
  project: string;
  install: number;
}

function jobPlaces(detection: Detection, projects: readonly string[]): JobPlace[] {
  const places: JobPlace[] = [];
  for (const group of jobIndex(detection).groups) {
    for (const declaration of group.declarations) {
      for (const [project, install] of firstInstallsByProject(commandsAfterStep(group, declaration), projects)) places.push({ job: group.job, declaration, project, install });
    }
  }
  return places;
}

/** A Dockerfile stage that installs with the tool of its official image. */
interface DockerPlace {
  file: DockerfileInfo;
  /** The number of the stage, from 0. */
  index: number;
  stage: DockerStage & { runtime: NonNullable<DockerStage['runtime']> };
  root: DockerStage;
  install: number;
}

/** The stages that install with the tool of their image; `keep` chooses the stages (a project's, or the root's). */
function dockerPlaces(dockerfiles: readonly DockerfileInfo[], tool: 'npm' | 'pip', keep: (file: DockerfileInfo, index: number) => boolean = () => true): DockerPlace[] {
  const runtimeTool = tool === 'npm' ? 'node' : 'python';
  const places: DockerPlace[] = [];
  for (const file of dockerfiles) {
    const reported = new Set<DockerStage>();
    const lineage = ancestries(file, tool);
    for (const [index, stage] of file.stages.entries()) {
      if (stage.runtime?.tool !== runtimeTool || !keep(file, index)) continue;
      const { root, replaced } = lineage[index] ?? { root: stage, replaced: false };
      const install = firstPlainInstall(stage.commands, tool, replaced);
      if (install === undefined || reported.has(root)) continue;
      reported.add(root);
      places.push({ file, index, stage: stage as DockerPlace['stage'], root, install });
    }
  }
  return places;
}

/** The developer files that choose the Node.js npm comes with; `fromRoot`: the project uses version files of the root. */
function developerPlaces(detection: Detection, manager: PackageManagerInfo | undefined, manifest: unknown, fromRoot = false): (VersionDeclaration & { version: string })[] {
  const declarations = detection.node.versions.filter((entry) => DEVELOPER_SOURCES.has(entry.source));
  // Volta installs its own npm when package.json pins one.
  const voltaNpm = manager?.versions.some((entry) => entry.source === 'volta') === true;
  // engines.node says which Node.js versions a package works on; it chooses the Node.js of a project only when the
  // project is not published (private) and nothing more specific names one.
  const isPrivate = typeof manifest === 'object' && manifest !== null && (manifest as Record<string, unknown>)['private'] === true;
  const others = fromRoot || declarations.some((entry) => entry.source !== 'engines');
  return declarations.filter((declaration): declaration is VersionDeclaration & { version: string } => {
    if (!('version' in declaration)) return false;
    if (declaration.source === 'volta' && voltaNpm) return false;
    return !(declaration.source === 'engines' && (!isPrivate || others));
  });
}

/** One npm version in use, or a range of them, and where it comes from, for apply's and doctor's messages. */
export interface NpmInUse {
  /** The npm versions, lowest first. */
  versions: Version[];
  /**
   * Where it comes from, for "npm 10.9.9 (with Node.js 22 in .nvmrc)": "with Node.js 22 in .nvmrc", "installed in
   * Dockerfile, line 3", "packageManager in package.json", "the lowest version devEngines in package.json allows".
   */
  where: string;
  /** The file and line that declare it; absent for what the repository root declares for a project (its file is not the project's). */
  location?: { file: string; line?: number };
  /** The exact version the repository pins for everyone (repositoryPin). */
  pin?: true;
}

/** What a directory listed in projects takes from the repository root besides its CI installs (decision D-109). */
export interface RootPlaces {
  /** The root's Node.js version files (.nvmrc, .node-version, .tool-versions), when the project has none of its own. */
  versions: readonly VersionDeclaration[];
  /** Root Dockerfiles with the stages that build the project (they copy only its files). */
  dockerfiles: readonly { file: DockerfileInfo; stages: readonly number[] }[];
}

/** What makes a project choose its Node.js itself: a version file or a key of its package.json that names one. */
const OWN_SOURCES = new Set<VersionDeclaration['source']>(['nvmrc', 'node-version', 'tool-versions', 'volta', 'devEngines']);

/** The sources of the version files that version managers also use in subdirectories (environment.node.inheritedVersionFiles). */
function inheritedSources(): Set<VersionDeclaration['source']> {
  const files: readonly string[] = values(environment.node.inheritedVersionFiles)[0] ?? [];
  const sources: Record<string, VersionDeclaration['source']> = { '.nvmrc': 'nvmrc', '.node-version': 'node-version', '.tool-versions': 'tool-versions' };
  return new Set(files.flatMap((file) => (sources[file] === undefined ? [] : [sources[file]])));
}

/** "frontend/x" and "./frontend" lie in frontend; "." and "../frontend" do not. */
function copiedProject(source: string, projects: readonly string[]): string | undefined {
  let path = source;
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/^\/+/u, '').replace(/\/+\.?$/u, '');
  return projects.find((project) => path === project || path.startsWith(`${project}/`));
}

/**
 * For every stage of a root Dockerfile: the project it builds, when it and the stages it starts from copy files from
 * the build context and every such file lies in that one project (COPY frontend/package.json ./). COPY . . or files of
 * several directories are not clearly a build of one project, so such a stage stays the root's (decision D-109).
 */
export function stageProjects(file: DockerfileInfo, projects: readonly string[]): (string | undefined)[] {
  const found: { project: string | undefined; any: boolean; mixed: boolean }[] = [];
  for (const [index, stage] of file.stages.entries()) {
    const above = stage.from !== undefined && stage.from < index ? found[stage.from] : undefined;
    let project = above?.project;
    let any = above?.any ?? false;
    let mixed = above?.mixed ?? false;
    for (const source of stage.copies ?? []) {
      const own = copiedProject(source, projects);
      if (own === undefined || (any && own !== project)) mixed = true;
      project ??= own;
      any = true;
    }
    found.push({ project, any, mixed });
  }
  return found.map((entry) => (entry.any && !entry.mixed ? entry.project : undefined));
}

/**
 * What a project takes from the root (decision D-109): the root's .nvmrc, .node-version and .tool-versions, which nvm,
 * nodenv and asdf also use in its directory, when the project chooses no Node.js of its own (Volta, devEngines and
 * engines of the root package.json do not reach a project with a package.json of its own); and the stages of root
 * Dockerfiles that build it.
 */
export function rootPlaces(rootDetection: Detection, project: string, projectDetection: Detection | undefined): RootPlaces {
  const own = projectDetection?.node.versions.some((declaration) => OWN_SOURCES.has(declaration.source)) ?? false;
  const inherited = inheritedSources();
  const versions = own ? [] : rootDetection.node.versions.filter((declaration) => inherited.has(declaration.source));
  const dockerfiles = rootDetection.dockerfiles
    .map((file) => ({ file, stages: stageProjects(file, [project]).flatMap((built, index) => (built === project ? [index] : [])) }))
    .filter((entry) => entry.stages.length > 0);
  return { versions, dockerfiles };
}

/** Whether a stage of a root Dockerfile builds one of the projects, so that it is not the root's. */
export function builtByProject(projects: readonly string[]): (file: DockerfileInfo, index: number) => string | undefined {
  const known = new Map<DockerfileInfo, (string | undefined)[]>();
  return (file, index) => {
    if (projects.length === 0) return undefined;
    let built = known.get(file);
    if (built === undefined) {
      built = stageProjects(file, projects);
      known.set(file, built);
    }
    return built[index];
  };
}

const AT_ROOT = ' at the repository root';

/**
 * The npm versions a directory runs (decisions D-105 and D-109): the versions declared for npm itself (the pin for the
 * repository, other declarations, the lowest version of a range, npm install -g npm@<version> in CI jobs and
 * Dockerfiles), and the npm that comes with the Node.js of every place manager-version-too-old checks (CI jobs and
 * Dockerfile stages that install with it, developer version files). Versions that cannot be read are left out.
 * `projects` leaves out root CI installs in those directories and root Dockerfile stages that build them; `extra` adds
 * root jobs that install in this project (jobsInProject), `root` the root's version files and Dockerfile stages
 * (rootPlaces). apply writes strict-allow-scripts from this list, and doctor promises it from the same list.
 */
export function npmInUse(
  detection: Detection,
  manifest: unknown,
  label: (declaration: VersionDeclaration) => string,
  options: { projects?: readonly string[]; extra?: { jobs: readonly WorkflowJob[]; versions: readonly VersionDeclaration[] }; root?: RootPlaces } = {},
): NpmInUse[] {
  const facts = runtimeFacts(environment);
  const resolve = resolver(facts);
  const found: NpmInUse[] = [];
  const keys = new Set<string>();
  const push = (entry: NpmInUse) => {
    const key = `${entry.where}\u0000${entry.versions.map(formatVersion).join(' ')}`;
    if (keys.has(key)) return;
    keys.add(key);
    found.push(entry);
  };
  const add = (resolution: Resolved, where: string, location: NpmInUse['location']) => {
    if (resolution.kind !== 'unknown') push({ versions: [...resolution.bundled], where: `with ${where}`, ...(location === undefined ? {} : { location }) });
  };
  const at = (file: string, line: number | undefined) => ({ file, ...(line === undefined ? {} : { line }) });
  const projects = options.projects ?? [];
  const built = builtByProject(projects);
  const manager = detection.packageManagers.find((entry) => entry.id === 'npm');
  // npm itself; the pin is the first exact version of packageManager, devEngines, Volta or .tool-versions.
  const pin = manager === undefined ? undefined : repositoryPin(manager);
  let pinned = false;
  for (const declaration of manager?.versions ?? []) {
    if (!('version' in declaration)) continue;
    const exact = parseVersion(declaration.version);
    if (declaration.source === 'github-actions' || declaration.source === 'dockerfile') {
      if (exact === undefined) continue;
      if (declaration.source === 'dockerfile') {
        const file = detection.dockerfiles.find((entry) => entry.file === declaration.file);
        const index = file === undefined ? -1 : file.stages.findIndex((stage, position) => (stage.name ?? String(position)) === declaration.stage);
        if (file !== undefined && index >= 0 && built(file, index) !== undefined) continue;
      }
      const job = declaration.job === undefined ? '' : ` job ${declaration.job} of`;
      push({ versions: [exact], where: `installed in${job} ${declaration.file}${declaration.line === undefined ? '' : `, line ${declaration.line}`}`, location: at(declaration.file, declaration.line) });
      continue;
    }
    if (exact !== undefined) {
      const isPin: boolean = !pinned && pin !== undefined && compareVersions(exact, pin) === 0;
      pinned ||= isPin;
      push({ versions: [exact], where: `${label(declaration)} in ${declaration.file}`, location: at(declaration.file, declaration.line), ...(isPin ? { pin: true as const } : {}) });
      continue;
    }
    const lowest = lowestVersion(declaration.version);
    const version = lowest.kind === 'unknown' ? undefined : parseVersion(formatBound(lowest));
    if (version !== undefined) push({ versions: [version], where: `the lowest version ${label(declaration)} in ${declaration.file} allows`, location: at(declaration.file, declaration.line) });
  }
  const views: Detection[] = [detection];
  if (options.extra !== undefined && options.extra.jobs.length > 0) {
    views.push({ ...detection, jobs: [...options.extra.jobs], node: { versions: [...options.extra.versions] }, dockerfiles: [] });
  }
  for (const [index, view] of views.entries()) {
    for (const place of jobPlaces(view, index === 0 ? projects : [])) {
      const declaration = place.declaration;
      if (place.project !== '' || !('version' in declaration) || declaration.unknown !== undefined) continue;
      const matrix = declaration.matrix === undefined ? '' : ` (matrix.${declaration.matrix})`;
      const from = declaration.versionFile === undefined ? '' : ` from ${declaration.versionFile}`;
      const where = `Node.js ${declaration.version}${matrix}${from} in job ${place.job.id} of ${declaration.file}${index === 0 ? '' : AT_ROOT}`;
      add(resolve(declaration.version, 'setup-node'), where, index === 0 ? at(declaration.file, declaration.line) : undefined);
    }
  }
  const subject = (place: DockerPlace) => `Node.js ${place.stage.runtime.version ?? ''} of ${place.root.image ?? 'node'} in ${place.file.file}`;
  for (const place of dockerPlaces(detection.dockerfiles, 'npm', (file, index) => built(file, index) === undefined)) {
    const version = place.stage.runtime.version;
    if (version !== undefined) add(resolve(version, 'docker'), subject(place), at(place.file.file, place.root.line));
  }
  for (const declaration of developerPlaces(detection, manager, manifest, (options.root?.versions.length ?? 0) > 0)) {
    const where = declaration.file === label(declaration) ? declaration.file : `${label(declaration)} in ${declaration.file}`;
    add(resolve(declaration.version, namingOf(declaration.source)), `Node.js ${declaration.version} in ${where}`, at(declaration.file, declaration.line));
  }
  // The root's version files and the stages of root Dockerfiles that build this project.
  for (const declaration of options.root?.versions ?? []) {
    if ('version' in declaration) add(resolve(declaration.version, namingOf(declaration.source)), `Node.js ${declaration.version} in ${declaration.file}${AT_ROOT}`, undefined);
  }
  for (const { file, stages } of options.root?.dockerfiles ?? []) {
    const keep = new Set(stages);
    for (const place of dockerPlaces([file], 'npm', (_file, index) => keep.has(index))) {
      if (place.stage.runtime.version !== undefined) add(resolve(place.stage.runtime.version, 'docker'), `${subject(place)}${AT_ROOT}`, undefined);
    }
    for (const index of stages) {
      for (const command of file.stages[index]?.commands ?? []) {
        const version = command.tool === 'npm' && command.kind === 'upgrade' && command.version !== undefined ? parseVersion(command.version) : undefined;
        if (version !== undefined) push({ versions: [version], where: `installed in ${file.file}${AT_ROOT}, line ${command.line}` });
      }
    }
  }
  // The root jobs counted for a project replace npm with npm install -g npm@<version> in their own commands.
  for (const job of options.extra?.jobs ?? []) {
    for (const command of job.commands) {
      const version = command.tool === 'npm' && command.kind === 'upgrade' && command.version !== undefined ? parseVersion(command.version) : undefined;
      if (version !== undefined) push({ versions: [version], where: `installed in job ${job.id} of ${job.file}${AT_ROOT}, line ${command.line}` });
    }
  }
  return found;
}

/** "npm 11.16.0 (with Node.js 24.18.0 in .nvmrc)", "npm 11.3.0 to 11.19.1 (…)": the versions of an entry, or some of them. */
export function npmInUseText(entry: NpmInUse, versions: readonly Version[] = entry.versions): string {
  const sorted = [...versions].sort(compareVersions);
  const low = formatVersion(sorted[0] as Version);
  const high = formatVersion(sorted.at(-1) as Version);
  return `npm ${low === high ? low : `${low} to ${high}`} (${entry.where})`;
}

interface Place {
  /** "Node.js 22 in GitHub Actions (.github/workflows/ci.yml, job test)". */
  subject: string;
  file: string;
  line?: number;
  /** CI and Dockerfiles: no one replaces the bundled tool there. */
  enforced: boolean;
  /** Added after the message: which install uses it. */
  installs?: string;
  /** How to install the tool before the installs, and how to choose a newer runtime, in this place. */
  install: (version: string) => string;
  /**
   * Whether that install is a change of the repository that depcurfew apply sees (a RUN or a CI step), or one on a
   * developer's machine, which it cannot see (decision D-109).
   */
  installSeen: boolean;
  /** "24.14.1 or a later 24.x; 26.0.0 or later", the first of those releases, and the version they bring at least. */
  runtime: (releases: string, first: string, bundled: string) => string;
}

interface Check {
  tool: ToolKnowledge;
  features: readonly Needed[];
  /** The version the repository pins for the tool, offered in the fix when it is new enough. */
  pinned: Version | undefined;
  /** npm: the release since which an unknown .npmrc key gives a warning. */
  warnsSince?: Version;
  /** What depcurfew apply does about strict-allow-scripts in this directory, for the fixes that offer it. */
  advice: StrictAdvice;
}

function report(context: RuleContext, helpers: BundledHelpers, check: Check, place: Place, resolution: Resolution, facts: RuntimeFacts): void {
  const name = check.tool.name;
  const low = resolution.bundled[0] as Version;
  const high = newest(resolution.bundled);
  const missing = helpers.missing(check.features, (since) => compareVersions(low, since) < 0);
  if (missing.length === 0) return;
  const none = missing.filter((item) => compareVersions(high, parseVersion(item.since) as Version) < 0);
  const some = missing.filter((item) => !none.includes(item));
  const single = compareVersions(low, high) === 0;
  // The note on disputed versions goes to the end of the message, once.
  const describe = (items: readonly Requirement[]) => describeRequirements(items.map(({ setting, since }) => ({ setting, since })));
  const clauses = single
    ? [`which does not support ${describe(missing)}`]
    : [...(none.length > 0 ? [`none of which supports ${describe(none)}`] : []), ...(some.length > 0 ? [`not all of which support ${describe(some)}`] : [])];
  const disputed = missing.some((item) => item.disputed === true) ? '; where official sources disagree on the version, depcurfew assumes the later one' : '';
  const silent = check.warnsSince !== undefined && compareVersions(low, check.warnsSince) < 0 ? `; ${name} before ${formatVersion(check.warnsSince)} ignores settings it does not know without a warning` : '';
  const verb = resolution.kind === 'exact' || single ? 'comes with' : 'can come with';
  const message = `${place.subject} ${verb} ${bundledText(name, resolution.bundled)}, ${clauses.join(', and ')}${place.installs === undefined ? '' : `, and ${place.installs}`}${silent}${disputed}`;
  const needed = newest(missing.map((item) => parseVersion(item.since) as Version));
  const target = check.pinned !== undefined && compareVersions(check.pinned, needed) >= 0 ? check.pinned : needed;
  const segments = check.tool.id === 'npm' ? facts.node : facts.python;
  const lines = check.tool.id === 'npm' ? supportedLtsLines(facts, today()).map((line) => String(line.line)) : undefined;
  const better = firstReleasesWith(needed, segments, lines);
  const newestLine = lines === undefined ? newestLineOf(segments) : (lines.at(-1) ?? '');
  const runtimeFor = (version: Version) => {
    const releases = firstReleasesWith(version, segments, lines);
    return releases.length === 0 ? undefined : place.runtime(releasesPhrase(releases, newestLine), formatVersion(releases[0]?.release as Version), formatVersion(version));
  };
  const runtime = better.length === 0 ? undefined : runtimeFor(needed);
  // npm 12 blocks dependency scripts by default; npm 11.16 and later do it with strict-allow-scripts (decision D-105),
  // which the fix promises from depcurfew apply only where apply writes it (decision D-109).
  const other = helpers.alternative(missing, name, check.advice);
  // Every version it brings is new enough for the other way: only the setting is missing.
  const enough = other !== undefined && compareVersions(low, other.version) >= 0;
  const otherRuntime = other === undefined || enough ? undefined : runtimeFor(other.version);
  const noRelease = better.length === 0 && check.tool.id === 'npm' ? `; no supported Node.js release comes with ${name} ${formatVersion(needed)} yet` : '';
  const alternatives = [
    ...(enough ? [other.set] : []),
    place.install(formatVersion(target)),
    ...(runtime === undefined ? [] : [runtime]),
    ...(other === undefined || enough
      ? []
      : [`${place.install(formatVersion(other.version))} ${other.suffix(place.installSeen ? 'repository' : 'machine')}`, ...(otherRuntime === undefined ? [] : [`${otherRuntime} ${other.suffix('repository')}`])]),
  ];
  const fix = alternatives.join(', or ');
  const level: Level = place.enforced && none.length > 0 ? 'error' : 'warning';
  context.report({
    level,
    location: place.line === undefined ? { file: place.file } : { file: place.file, line: place.line },
    message,
    fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}${noRelease}`,
  });
}

function unknown(context: RuleContext, subject: string, reason: string, file: string): void {
  context.notice(`${RULE} cannot tell which npm or pip comes with ${subject}: ${reason}`, file);
}

/**
 * CI jobs that install with the npm of a declared Node.js. An install in the directory of a project (working-directory:
 * frontend) uses that project's npm configuration, so it is checked against the project's settings (decision D-105).
 */
function checkJobs(context: RuleContext, helpers: BundledHelpers, checkFor: (project: string) => Check | undefined, facts: RuntimeFacts): void {
  const projects = (context.projects ?? []).map((view) => view.directory);
  const resolve = resolver(facts);
  for (const { job, declaration, project, install } of jobPlaces(context.detection, projects)) {
    const check = checkFor(project);
    if (check === undefined) continue;
    if (!('version' in declaration)) {
      unknown(context, `the Node.js of ${declaration.versionFile} in ${declaration.file}`, 'depcurfew cannot read the version from that file', declaration.file);
      continue;
    }
    const subject = nodeSubject(declaration, helpers.label(declaration));
    if (declaration.unknown !== undefined) {
      unknown(context, subject, declaration.unknown, declaration.file);
      continue;
    }
    const resolution = resolve(declaration.version, 'setup-node');
    if (resolution.kind === 'unknown') {
      unknown(context, subject, resolution.reason, declaration.file);
      continue;
    }
    const where = project === '' ? '' : ` in ${project}`;
    report(context, helpers, check, {
      subject,
      file: declaration.file,
      ...(declaration.line === undefined ? {} : { line: declaration.line }),
      enforced: true,
      installs: `job ${job.id} installs packages with it${where} on line ${install}`,
      install: (version) => `run npm install -g npm@${version} in job ${job.id} before it installs packages`,
      installSeen: true,
      runtime: (releases, _first, bundled) => `set up a Node.js release that comes with npm ${bundled} or later (${releases})`,
    }, resolution, facts);
  }
}

/** Dockerfile stages that install with the tool of their image; a root stage that builds a project is checked for it. */
function checkDockerfiles(context: RuleContext, helpers: BundledHelpers, checkFor: (project: string) => Check | undefined, tool: 'npm' | 'pip', facts: RuntimeFacts): void {
  const runtimeTool = tool === 'npm' ? 'node' : 'python';
  const built = tool === 'npm' ? builtByProject((context.projects ?? []).map((view) => view.directory)) : () => undefined;
  for (const { file, index, stage, root, install } of dockerPlaces(context.detection.dockerfiles, tool)) {
    const project = built(file, index) ?? '';
    const check = checkFor(project);
    if (check === undefined) continue;
    const image = root.image ?? (runtimeTool === 'node' ? 'node' : 'python');
    const name = stage.name === undefined ? `the stage at line ${stage.line}` : `stage ${stage.name}`;
    const runtimeName = runtimeTool === 'node' ? 'Node.js' : 'Python';
    const version = stage.runtime.version;
    const subject = `${runtimeName}${version === undefined ? '' : ` ${version}`} (${image}) in ${file.file}`;
    if (version === undefined) {
      unknown(context, subject, stage.runtime.unknown ?? 'the tag names no version', file.file);
      continue;
    }
    const resolution = runtimeTool === 'node' ? nodeBundledNpm(version, 'docker', facts) : pythonBundledPip(version, facts);
    if (resolution.kind === 'unknown') {
      unknown(context, subject, resolution.reason, file.file);
      continue;
    }
    const upgrade = tool === 'npm' ? (target: string) => `npm install -g npm@${target}` : (target: string) => `pip install pip==${target}`;
    report(context, helpers, check, {
      subject,
      file: file.file,
      line: root.line,
      enforced: true,
      installs: `${name} installs packages with it${project === '' ? '' : ` for ${project}`} on line ${install}`,
      install: (target) => `add RUN ${upgrade(target)} to ${name} before it installs packages`,
      installSeen: true,
      runtime: (releases, first, bundled) => `start from a ${runtimeTool} image whose ${runtimeName} release comes with ${tool} ${bundled} or later (${releases}), such as ${runtimeTool}:${first}`,
    }, resolution, facts);
  }
}

/**
 * The version files developers use. `project`: the root's files, checked for a project that has none of its own and
 * uses them (decision D-109).
 */
function checkDeveloperFiles(
  context: RuleContext,
  helpers: BundledHelpers,
  check: Check,
  declarations: readonly (VersionDeclaration & { version: string })[],
  facts: RuntimeFacts,
  project?: string,
): void {
  for (const declaration of declarations) {
    const subject = nodeSubject(declaration, helpers.label(declaration));
    const resolution = nodeBundledNpm(declaration.version, namingOf(declaration.source), facts);
    if (resolution.kind === 'unknown') {
      unknown(context, subject, resolution.reason, declaration.file);
      continue;
    }
    const line = helpers.line(declaration);
    report(context, helpers, check, {
      subject,
      file: declaration.file,
      ...(line === undefined ? {} : { line }),
      enforced: false,
      ...(project === undefined ? {} : { installs: `${project} has no Node.js version file of its own, so it uses this one` }),
      install: (version) => `install npm ${version} where this Node.js is used (npm install -g npm@${version})`,
      installSeen: false,
      runtime: (releases, _first, bundled) => `require a Node.js release that comes with npm ${bundled} or later in ${helpers.label(declaration)} (${releases})`,
    }, resolution, facts);
  }
}

/** The exact version the repository pins for everyone (packageManager, devEngines, Volta, .tool-versions, the tool's own configuration). */
export function repositoryPin(manager: PackageManagerInfo): Version | undefined {
  return pinnedVersion({ ...manager, versions: manager.versions.filter((entry) => entry.source !== 'github-actions' && entry.source !== 'dockerfile') });
}

/** The options of npmInUse for a directory: the root (whose projects are left out) or a project (with what the root gives it). */
export function npmInUseOptions(context: Pick<RuleContext, 'projects' | 'plan'>): Parameters<typeof npmInUse>[3] {
  const ci = context.plan?.ci;
  const root = context.plan?.root;
  return { projects: (context.projects ?? []).map((view) => view.directory), ...(ci === undefined ? {} : { extra: ci }), ...(root === undefined ? {} : { root }) };
}

/** The npm versions a directory runs, as apply sees them (npmInUse). */
export function npmPlaces(context: Pick<RuleContext, 'detection' | 'repository' | 'projects' | 'plan'>): NpmInUse[] {
  const manifest = context.repository.parseOnce('package.json', (text) => JSON.parse(text) as unknown);
  return npmInUse(context.detection, manifest, (declaration) => SOURCE_LABEL[declaration.source], npmInUseOptions(context));
}

/**
 * What depcurfew apply does about strict-allow-scripts for npm in a directory (decision D-109): `now`, it writes it for
 * the repository as it is, because some npm in use runs scripts allowScripts does not cover with a notice; `targeted`,
 * it configures npm there at all, so a change of the repository that brings such an npm makes it write it.
 */
export function strictAdvice(context: Pick<RuleContext, 'detection' | 'repository' | 'projects' | 'plan' | 'policy'>, tool: ToolKnowledge): StrictAdvice {
  const policy = context.policy;
  const targeted = policy !== undefined && (policy.targets === 'auto' || policy.targets.includes(tool.id));
  if (!targeted || tool.extra?.['strictAllowScripts'] === undefined) return { now: false, targeted };
  const defaults = values(tool.installScripts.defaultPolicy)[0] ?? [];
  const now = npmPlaces(context).some((entry) => entry.versions.some((version) => versionedValue(defaults, version) === 'run-with-warning'));
  return { now, targeted };
}

/** The check of npm in one directory (the root or a project): its settings, its pin and when unknown keys warn. */
function npmCheck(context: RuleContext, helpers: BundledHelpers, managers: readonly PackageManagerInfo[], project?: string): Check | undefined {
  const manager = managers.find((entry) => entry.id === 'npm' && entry.supported);
  const npm = context.tools.find((entry) => entry.id === 'npm');
  if (manager === undefined || npm === undefined) return undefined;
  // A check for a project made at the root names the project's .npmrc from the root.
  const features = helpers
    .features(npm, context)
    .map((item) => (project === undefined || item.instead === undefined ? item : { ...item, instead: { ...item.instead, file: `${project}/${item.instead.file}` } }));
  if (features.length === 0) return undefined;
  const unknownKeys = npm.extra?.['unknownConfigKeys'] === undefined ? undefined : values(npm.extra['unknownConfigKeys'])[0];
  const warning = Array.isArray(unknownKeys) ? (unknownKeys as { since: string; value: string }[]).find((entry) => entry.value === 'warning')?.since : undefined;
  const warnsSince = warning === undefined ? undefined : parseVersion(warning);
  return { tool: npm, features, pinned: repositoryPin(manager), ...(warnsSince === undefined ? {} : { warnsSince }), advice: strictAdvice(context, npm) };
}

/** The npm and pip that come with the declared runtimes, checked against the settings the repository relies on. */
export function checkBundledVersions(context: RuleContext, helpers: BundledHelpers): void {
  const facts = runtimeFacts(environment);
  const managed = (id: string) => context.detection.packageManagers.find((entry) => entry.id === id && entry.supported);
  const npmManager = managed('npm');
  const rootCheck = npmCheck(context, helpers, context.detection.packageManagers);
  // A project's npm reads the project's .npmrc; its settings are read with the project's context, and what apply
  // does there with the plan options of the project (its CI installs and what it takes from the root).
  const views = context.projects ?? [];
  const sources = views.length === 0 ? [] : managerSources(context).filter((source) => source.project !== undefined);
  const checks = new Map<string, Check | undefined>();
  const planOf = (project: string): PlanOptions => {
    const ci = jobsInProject(context.detection, project);
    return { project, ...(ci.jobs.length === 0 ? {} : { ci }), root: rootPlaces(context.detection, project, views.find((view) => view.directory === project)?.detection) };
  };
  const checkFor = (project: string): Check | undefined => {
    if (project === '') return rootCheck;
    if (!checks.has(project)) {
      const source = sources.find((entry) => entry.project === project);
      const plan = planOf(project);
      checks.set(project, source === undefined ? undefined : npmCheck({ ...source.context, plan }, helpers, source.managers, project));
    }
    return checks.get(project);
  };
  checkJobs(context, helpers, checkFor, facts);
  checkDockerfiles(context, helpers, checkFor, 'npm', facts);
  if (npmManager !== undefined && rootCheck !== undefined) {
    const manifest = context.repository.parseOnce('package.json', (text) => JSON.parse(text) as unknown);
    checkDeveloperFiles(context, helpers, rootCheck, developerPlaces(context.detection, npmManager, manifest), facts);
  }
  // The root's version files, for each project that has none of its own.
  for (const view of views) {
    const inherited = planOf(view.directory).root?.versions ?? [];
    const check = inherited.length === 0 ? undefined : checkFor(view.directory);
    if (check === undefined) continue;
    checkDeveloperFiles(context, helpers, check, inherited.filter((declaration): declaration is VersionDeclaration & { version: string } => 'version' in declaration), facts, view.directory);
  }
  const pipManager = managed('pip');
  const pip = context.tools.find((entry) => entry.id === 'pip');
  if (pipManager !== undefined && pip !== undefined) {
    const features = helpers.features(pip, context);
    const check: Check = { tool: pip, features, pinned: repositoryPin(pipManager), advice: { now: false, targeted: false } };
    if (features.length > 0) checkDockerfiles(context, helpers, (project) => (project === '' ? check : undefined), 'pip', facts);
  }
}
