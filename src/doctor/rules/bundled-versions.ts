// Part of manager-version-too-old: the npm that comes with a declared Node.js, and the pip that comes with the python
// image, must know the settings in use wherever nothing replaces them. A CI job that installs with npm after setup-node,
// a Dockerfile stage that installs with npm or pip, and the version files developers use (.nvmrc, .node-version,
// Volta, .tool-versions, devEngines.runtime, engines.node of a private package) decide which Node.js runs. The same
// places tell `apply` which npm versions a repository without a pinned npm runs (npmInUse, decision D-105).
import { describeRequirements, type Requirement } from '../../apply/requirements.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import { sinceOf, values } from '../../apply/facts.ts';
import { satisfies } from '../../check/semver.ts';
import { npm as npmFacts } from '../../knowledge/npm.ts';
import type { PlanOptions } from '../../apply/index.ts';
import { versionedValue } from '../effective.ts';
import type { Detection, DockerfileInfo, DockerStage, PackageManagerInfo, ToolCommand, VersionDeclaration, WorkflowJob } from '../../detect/types.ts';
import { environment } from '../../knowledge/environment.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { managerSources } from '../projects.ts';
import type { Level, RuleContext } from '../types.ts';
import { belowVersion, formatBound, lowestVersion } from '../version-range.ts';
import {
  firstReleasesWith,
  namingOf,
  newestLineOf,
  namingFor,
  nodeBundledNpm,
  nodeReleasesIn,
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

/**
 * A setting in use, and another way to have it from an earlier version (strict-allow-scripts=true in .npmrc); `kind`
 * says whether it is part of the release-age delay or of blocking install scripts (decision D-115).
 */
export type Needed = Requirement & { instead?: { setting: string; file: string; since: string }; kind?: 'cooldown' | 'scripts' };

export interface BundledHelpers {
  /** The settings in use for a tool, read with the given context (the root's, or a project's). */
  features: (tool: ToolKnowledge, context: RuleContext) => readonly Needed[];
  missing: (features: readonly Needed[], below: (since: Version) => boolean) => Needed[];
  /** The earlier version that is enough with the other way of a missing setting (alternativeOf in manager-version.ts). */
  alternative: (missing: readonly Needed[], name: string, advice: StrictAdvice) => { version: Version; suffix: (change: 'repository' | 'machine') => string; set: string; text: string } | undefined;
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

/** The project (a directory listed in projects) a command's working directory lies in; '' for the root. */
function projectOf(command: ToolCommand, projects: readonly string[]): string {
  const directory = command.directory;
  if (directory === undefined) return '';
  return projects.find((project) => directory === project || directory.startsWith(`${project}/`)) ?? '';
}

/**
 * What the installs of a place do (decision D-115): the line of the first, whether every one is npm ci (or an alias),
 * which installs the versions package-lock.json records, so that no release-age delay changes what it installs, and
 * whether every one runs with dependency install scripts off.
 */
export interface Installs {
  first: number;
  lockfile: boolean;
  scriptsOff: boolean;
}

function addInstall(found: Installs | undefined, command: ToolCommand): Installs {
  if (found === undefined) return { first: command.line, lockfile: command.lockfile === true, scriptsOff: command.scriptsOff === true };
  return { first: Math.min(found.first, command.line), lockfile: found.lockfile && command.lockfile === true, scriptsOff: found.scriptsOff && command.scriptsOff === true };
}

/**
 * Per project ('' for the root) and per npm (`source`: the bundled one, or the npm install -g npm@X before them): the
 * installs of a run of commands. An upgrade replaces npm for every later command of the run, whatever the directory.
 */
function installsBySource(
  commands: readonly ToolCommand[],
  tool: 'npm' | 'pip',
  projectFor: (command: ToolCommand) => string,
  start: ToolCommand | undefined,
  found: Map<ToolCommand | undefined, Map<string, Installs>>,
): ToolCommand | undefined {
  let source = start;
  for (const command of commands) {
    if (command.tool !== tool) continue;
    if (command.kind === 'upgrade') {
      source = command;
      continue;
    }
    const project = projectFor(command);
    const byProject = found.get(source) ?? new Map<string, Installs>();
    found.set(source, byProject);
    byProject.set(project, addInstall(byProject.get(project), command));
  }
  return source;
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

/** "Node.js 22 (matrix.node) in GitHub Actions (.github/workflows/ci.yml, job test)", "Node.js 22 in .nvmrc". */
export function nodeSubject(declaration: VersionDeclaration & { version: string }, label: string): string {
  const matrix = declaration.matrix === undefined ? '' : ` (matrix.${declaration.matrix})`;
  const container = declaration.container === undefined ? '' : ` of the job container ${declaration.container}`;
  const where = declaration.source === 'github-actions' && declaration.job !== undefined ? `${declaration.file}, job ${declaration.job}` : declaration.file;
  const from = declaration.versionFile === undefined ? '' : ` from ${declaration.versionFile}`;
  return `Node.js ${declaration.version}${matrix}${container}${from} in ${label === where ? label : `${label} (${where})`}`;
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

/**
 * A CI job that installs with npm: with the npm of the Node.js a setup step or the job container declares
 * (`declaration`), or with the one npm install -g npm@X put in its place (`upgrade`, with the Node.js declarations it
 * runs on, `nodes`).
 */
interface JobPlace {
  job: WorkflowJob;
  declaration?: VersionDeclaration;
  upgrade?: ToolCommand;
  nodes: readonly VersionDeclaration[];
  /** '' for the root, or the project whose directory the installs run in. */
  project: string;
  installs: Installs;
}

/**
 * The places of every job (decision D-115): the commands after a setup step (or the job container) and before the
 * next one use its Node.js; npm install -g npm@X replaces npm for the later commands of that part of the job.
 */
function jobPlaces(detection: Detection, projects: readonly string[]): JobPlace[] {
  const places: JobPlace[] = [];
  for (const group of jobIndex(detection).groups) {
    const byStep = new Map<number | undefined, VersionDeclaration[]>();
    for (const declaration of group.declarations) {
      const list = byStep.get(declaration.step) ?? [];
      list.push(declaration);
      byStep.set(declaration.step, list);
    }
    // The commands of each part of the job, from one setup step to the next; the part before the first has none.
    const parts = new Map<number | undefined, ToolCommand[]>();
    for (const command of group.commands) {
      const index = firstAbove(group.steps, command.line - 1);
      const step = index === 0 ? undefined : group.steps[index - 1];
      const list = parts.get(step) ?? [];
      list.push(command);
      parts.set(step, list);
    }
    const project = (command: ToolCommand) => projectOf(command, projects);
    for (const [step, commands] of parts) {
      const found = new Map<ToolCommand | undefined, Map<string, Installs>>();
      installsBySource(commands, 'npm', project, undefined, found);
      const nodes = byStep.get(step) ?? [];
      for (const [source, byProject] of found) {
        for (const [directory, installs] of byProject) {
          if (source !== undefined) places.push({ job: group.job, upgrade: source, nodes, project: directory, installs });
          else for (const declaration of nodes) places.push({ job: group.job, declaration, nodes: [declaration], project: directory, installs });
        }
      }
    }
  }
  return places;
}

/**
 * A Dockerfile stage that installs with npm or pip: with the tool of its official image, or with the one an
 * npm install -g npm@X or pip install pip==X put in its place (in it or in a stage it starts from, `upgrade`).
 */
interface DockerPlace {
  file: DockerfileInfo;
  /** The number of the first stage of these installs, from 0. */
  index: number;
  stage: DockerStage;
  /** The stage whose image the installs start from. */
  root: DockerStage;
  upgrade?: ToolCommand;
  project: string;
  installs: Installs;
}

/**
 * The places of every stage (decision D-115). A stage starts with the tool of the stage it starts from, or of its image;
 * its installs belong to the project its COPY sources name (stageProjects), or, in a stage that copies the whole build
 * context, to the project of the directory a literal cd leads to (cd frontend && npm ci); otherwise to the root. The
 * installs with the same tool and of the same project are one place, at the first stage that has them. One pass in
 * order: a stage only starts from an earlier one.
 */
function dockerPlaces(dockerfiles: readonly DockerfileInfo[], tool: 'npm' | 'pip', projects: readonly string[] = []): DockerPlace[] {
  const runtimeTool = tool === 'npm' ? 'node' : 'python';
  const places: DockerPlace[] = [];
  const built = builtByProject(projects);
  for (const file of dockerfiles) {
    const lineage: { root: DockerStage; upgrade: ToolCommand | undefined; whole: boolean }[] = [];
    // The places by their npm (the upgrade command, or the stage of the image) and project.
    const known = new Map<object, Map<string, DockerPlace>>();
    for (const [index, stage] of file.stages.entries()) {
      const from = stage.from;
      const above = from === undefined || from >= index ? undefined : lineage[from];
      const whole = (above?.whole ?? false) || (stage.copies ?? []).some((source) => contextPath(source) === '.');
      const assigned = built(file, index);
      const projectFor = (command: ToolCommand) => assigned ?? (whole ? projectOf(command, projects) : '');
      const found = new Map<ToolCommand | undefined, Map<string, Installs>>();
      const last = installsBySource(stage.commands, tool, projectFor, above?.upgrade, found);
      const root = above?.root ?? stage;
      lineage.push({ root, upgrade: last, whole });
      for (const [source, byProject] of found) {
        if (source === undefined && stage.runtime?.tool !== runtimeTool) continue;
        const ofSource = known.get(source ?? root) ?? new Map<string, DockerPlace>();
        known.set(source ?? root, ofSource);
        for (const [project, installs] of byProject) {
          const place = ofSource.get(project);
          if (place !== undefined) {
            place.installs = { first: place.installs.first, lockfile: place.installs.lockfile && installs.lockfile, scriptsOff: place.installs.scriptsOff && installs.scriptsOff };
            continue;
          }
          const created: DockerPlace = { file, index, stage, root, ...(source === undefined ? {} : { upgrade: source }), project, installs };
          ofSource.set(project, created);
          places.push(created);
        }
      }
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
  /** The npm versions, lowest first; empty when depcurfew cannot tell which npm it is (`unknown`). */
  versions: Version[];
  /**
   * Why depcurfew cannot tell which npm this place runs ("it is newer than the releases depcurfew knows (24 up to
   * 24.22.2)"). Such an npm counts as one that runs every dependency install script (decision D-111).
   */
  unknown?: string;
  /**
   * Where it comes from, for "npm 10.9.9 (with Node.js 22 in .nvmrc)": "with Node.js 22 in .nvmrc", "installed in
   * Dockerfile, line 3", "packageManager in package.json", "the lowest version devEngines in package.json allows".
   */
  where: string;
  /** The file and line that declare it; absent for what the repository root declares for a project (its file is not the project's). */
  location?: { file: string; line?: number };
  /** The exact version the repository pins for everyone (repositoryPin). */
  pin?: true;
  /**
   * npm install -g npm@<range>: the range as written; `versions` are its lowest version and the versions it allows from
   * which npm treats dependency scripts otherwise (11.16.0, 12.0.0), so that apply and doctor see each kind it may
   * install (decision D-115).
   */
  range?: string;
  /** npm install -g npm@<spec> with a spec depcurfew cannot read (a tag, a variable); `unknown` says so. */
  spec?: string;
  /**
   * The Node.js the place runs (its declaration, or the one of the job or stage that installs npm@X), for whether an npm
   * a fix offers runs there (decision D-121); absent for a pin and other declarations of npm itself.
   */
  nodes?: readonly NodeOf[];
}

/** What a directory listed in projects takes from the repository root besides its CI installs (decision D-109). */
export interface RootPlaces {
  /** The project; the stages of root Dockerfiles are then read for it (decision D-115). */
  project?: string;
  /** The root's Node.js version files (.nvmrc, .node-version, .tool-versions) of the kinds the project has none of. */
  versions: readonly VersionDeclaration[];
  /**
   * Root Dockerfiles with the stages that build the project (they copy only its files, decision D-109) or install in its
   * directory after copying the whole build context (cd frontend && npm ci, decision D-115).
   */
  dockerfiles: readonly { file: DockerfileInfo; stages: readonly number[] }[];
}

/** The sources of the version files that version managers also use in subdirectories (environment.node.inheritedVersionFiles). */
function inheritedSources(): Set<VersionDeclaration['source']> {
  const files: readonly string[] = values(environment.node.inheritedVersionFiles)[0] ?? [];
  const sources: Record<string, VersionDeclaration['source']> = { '.nvmrc': 'nvmrc', '.node-version': 'node-version', '.tool-versions': 'tool-versions' };
  return new Set(files.flatMap((file) => (sources[file] === undefined ? [] : [sources[file]])));
}

/**
 * A COPY or ADD source as Docker reads it in the build context (environment.docker.copySources): from the root of the
 * context, with . and .. resolved, ../ that would leave the context and trailing slashes removed. "frontend/../" is
 * the root ("."), "./frontend/./x" and "/frontend/x" are "frontend/x". Undefined when Docker would read it otherwise
 * than depcurfew assumes (the fact changed).
 */
export function contextPath(source: string): string | undefined {
  const facts = values(environment.docker.copySources)[0];
  if (facts === undefined || facts.relativeTo !== 'context' || facts.parentNavigation !== 'removed') return undefined;
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * The project a COPY or ADD source lies in: "frontend/x", "./frontend/./x" and "frontend/" lie in frontend; ".",
 * "frontend/../", "frontend-old/" and a source the project name only starts (frontend*) do not (decision D-111).
 */
function copiedProject(source: string, projects: readonly string[]): string | undefined {
  const path = contextPath(source);
  if (path === undefined || path.split('/').includes('..')) return undefined;
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
 * What a project takes from the root (decisions D-109 and D-111): the root's .nvmrc, .node-version and .tool-versions,
 * which nvm, nodenv and asdf also use in its directory. Each tool reads only its own file, so a project's own file
 * hides only the root file of the same kind: with frontend/.nvmrc, asdf still finds the root .tool-versions there.
 * Volta, devEngines and engines of the root package.json do not reach a project with a package.json of its own. And
 * the stages of root Dockerfiles that build it.
 */
export function rootPlaces(rootDetection: Detection, project: string, projectDetection: Detection | undefined): RootPlaces {
  const own = new Set(projectDetection?.node.versions.map((declaration) => declaration.source) ?? []);
  const inherited = inheritedSources();
  const versions = rootDetection.node.versions.filter((declaration) => inherited.has(declaration.source) && !own.has(declaration.source));
  const installing = new Map<DockerfileInfo, number[]>();
  for (const place of dockerPlaces(rootDetection.dockerfiles, 'npm', [project])) {
    if (place.project === project) installing.set(place.file, [...(installing.get(place.file) ?? []), place.index]);
  }
  const dockerfiles = rootDetection.dockerfiles
    .map((file) => {
      const stages = new Set([...stageProjects(file, [project]).flatMap((built, index) => (built === project ? [index] : [])), ...(installing.get(file) ?? [])]);
      return { file, stages: [...stages].sort((a, b) => a - b) };
    })
    .filter((entry) => entry.stages.length > 0);
  return { project, versions, dockerfiles };
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

/** The versions from which npm treats dependency scripts and the settings of the policy otherwise. */
function npmMarks(): Version[] {
  const since = [
    ...(values(npmFacts.installScripts.defaultPolicy)[0] ?? []).map((entry) => entry.since),
    sinceOf(npmFacts.installScripts.allowList.availableSince),
    sinceOf(npmFacts.cooldown.availableSince),
  ];
  return since.flatMap((text) => {
    const version = text === undefined ? undefined : parseVersion(text);
    return version === undefined ? [] : [version];
  });
}

/**
 * The npm of npm install -g npm@<spec> (decision D-115): an exact version; for a range (npm@11, npm@^11.10.0) its lowest
 * version and the versions it allows from which npm treats dependency scripts otherwise, as for a range in
 * packageManager; for a spec depcurfew cannot read (npm@latest, npm@${NPM_VERSION}) an npm it cannot tell, which
 * counts as one that runs every dependency install script (decision D-111).
 */
function upgradeEntry(spec: string, where: string, location: NpmInUse['location'], nodes: readonly NodeOf[] = []): NpmInUse {
  const fields = { where, ...(location === undefined ? {} : { location }), ...(nodes.length === 0 ? {} : { nodes }) };
  const exact = parseVersion(spec);
  if (exact !== undefined) return { versions: [exact], ...fields };
  const lowest = lowestVersion(spec);
  if (lowest.kind === 'unknown') return { versions: [], unknown: `npm@${spec} names no version depcurfew can read`, spec, ...fields };
  const candidates = [lowest.version, ...npmMarks()].filter((version) => satisfies(formatVersion(version), spec)).sort(compareVersions);
  const versions = candidates.filter((version, index) => index === 0 || compareVersions(version, candidates[index - 1] as Version) !== 0);
  return { versions: versions.length === 0 ? [lowest.version] : versions, range: spec, ...fields };
}

/**
 * The npm versions a directory runs (decisions D-105, D-109 and D-115): the versions declared for npm itself (the pin
 * for the repository, other declarations, the lowest version of a range), npm install -g npm@<version> in CI jobs and
 * Dockerfile stages that install packages with it, and the npm that comes with the Node.js of every place
 * manager-version-too-old checks (CI jobs and Dockerfile stages that install with it, developer version files). A
 * version that cannot be read stays in the list as unknown. A place whose installs all run with scripts off
 * (--ignore-scripts) is left out: it runs no dependency script. `projects` leaves out root CI installs in those
 * directories and root Dockerfile stages that build them; `extra` adds root jobs that install in this project
 * (jobsInProject), `root` the root's version files and Dockerfile stages (rootPlaces). apply writes
 * strict-allow-scripts from this list, and doctor promises it from the same list.
 */
export function npmInUse(
  detection: Detection,
  manifest: unknown,
  label: (declaration: VersionDeclaration) => string,
  options: { projects?: readonly string[]; extra?: { jobs: readonly WorkflowJob[]; versions: readonly VersionDeclaration[] }; root?: RootPlaces } = {},
): NpmInUse[] {
  const facts = sharedFacts();
  const resolve = resolver(facts);
  const found: NpmInUse[] = [];
  const keys = new Set<string>();
  const push = (entry: NpmInUse) => {
    const key = `${entry.where}\u0000${entry.versions.map(formatVersion).join(' ')}\u0000${entry.unknown ?? ''}`;
    if (keys.has(key)) return;
    keys.add(key);
    found.push(entry);
  };
  // A version depcurfew cannot map to an npm stays in the list as unknown: it must not pass for one that blocks scripts.
  const add = (resolution: Resolved, where: string, location: NpmInUse['location'], node?: NodeOf) => {
    const fields = { where: `with ${where}`, ...(location === undefined ? {} : { location }), ...(node === undefined ? {} : { nodes: [node] }) };
    push(resolution.kind === 'unknown' ? { versions: [], unknown: resolution.reason, ...fields } : { versions: [...resolution.bundled], ...fields });
  };
  const unknownNode = (reason: string, where: string, location: NpmInUse['location']) => add({ kind: 'unknown', reason }, where, location);
  const at = (file: string, line: number | undefined) => ({ file, ...(line === undefined ? {} : { line }) });
  const upgrade = (command: ToolCommand, where: string, location: NpmInUse['location'], nodes: readonly NodeOf[] = []) => {
    if (command.version !== undefined) push(upgradeEntry(command.version, where, location, nodes));
  };
  const stageNodes = (place: DockerPlace): NodeOf[] => {
    const version = place.stage.runtime?.tool === 'node' ? place.stage.runtime.version : undefined;
    return version === undefined ? [] : [{ version, naming: 'docker' }];
  };
  const projects = options.projects ?? [];
  const manager = detection.packageManagers.find((entry) => entry.id === 'npm');
  // npm itself; the pin is the first exact version of packageManager, devEngines, Volta or .tool-versions.
  const pin = manager === undefined ? undefined : repositoryPin(manager);
  let pinned = false;
  for (const declaration of manager?.versions ?? []) {
    if (!('version' in declaration)) continue;
    // npm install -g npm@X counts where it installs packages: from the places below (decision D-115).
    if (declaration.source === 'github-actions' || declaration.source === 'dockerfile') continue;
    const exact = parseVersion(declaration.version);
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
  const jobs = views.flatMap((view, index) => jobPlaces(view, index === 0 ? projects : []).map((place) => ({ place, ownFile: index === 0 })));
  const own = dockerPlaces(detection.dockerfiles, 'npm', projects).filter((place) => place.project === '');
  const rootProject = options.root?.project;
  const fromRoot = (options.root?.dockerfiles ?? []).flatMap(({ file, stages }) => {
    const keep = new Set(stages);
    return dockerPlaces([file], 'npm', rootProject === undefined ? [] : [rootProject]).filter((place) => (rootProject === undefined ? keep.has(place.index) : place.project === rootProject));
  });
  // The npm CI jobs and Dockerfile stages install for this directory, then the npm of the Node.js they set up.
  for (const { place, ownFile } of jobs) {
    if (place.upgrade === undefined || place.project !== '' || place.installs.scriptsOff) continue;
    upgrade(place.upgrade, `installed in job ${place.job.id} of ${place.job.file}${ownFile ? '' : AT_ROOT}, line ${place.upgrade.line}`, ownFile ? at(place.job.file, place.upgrade.line) : undefined, place.nodes.flatMap(nodeOf));
  }
  for (const place of own) {
    if (place.upgrade !== undefined && !place.installs.scriptsOff) upgrade(place.upgrade, `installed in ${place.file.file}, line ${place.upgrade.line}`, at(place.file.file, place.upgrade.line), stageNodes(place));
  }
  for (const place of fromRoot) {
    if (place.upgrade !== undefined && !place.installs.scriptsOff) upgrade(place.upgrade, `installed in ${place.file.file}${AT_ROOT}, line ${place.upgrade.line}`, undefined, stageNodes(place));
  }
  for (const { place, ownFile } of jobs) {
    const declaration = place.declaration;
    if (declaration === undefined || place.project !== '' || place.installs.scriptsOff) continue;
    const location = ownFile ? at(declaration.file, declaration.line) : undefined;
    const job = `job ${place.job.id} of ${declaration.file}${ownFile ? '' : AT_ROOT}`;
    if (!('version' in declaration)) {
      unknownNode('depcurfew cannot read the version from that file', `Node.js from ${declaration.versionFile} in ${job}`, location);
      continue;
    }
    const matrix = declaration.matrix === undefined ? '' : ` (matrix.${declaration.matrix})`;
    const container = declaration.container === undefined ? '' : ` of the job container ${declaration.container}`;
    const from = declaration.versionFile === undefined ? '' : ` from ${declaration.versionFile}`;
    const where = `Node.js ${declaration.version}${matrix}${container}${from} in ${job}`;
    if (declaration.unknown !== undefined) unknownNode(declaration.unknown, where, location);
    else add(resolve(declaration.version, namingFor(declaration)), where, location, { version: declaration.version, naming: namingFor(declaration) });
  }
  const subject = (place: DockerPlace) => `Node.js ${place.stage.runtime?.version === undefined ? '' : `${place.stage.runtime.version} `}of ${place.root.image ?? 'node'} in ${place.file.file}`;
  const stage = (place: DockerPlace, suffix: string, location: NpmInUse['location']) => {
    if (place.upgrade !== undefined || place.installs.scriptsOff) return;
    const version = place.stage.runtime?.version;
    if (version === undefined) unknownNode(place.stage.runtime?.unknown ?? 'the tag names no version', `${subject(place)}${suffix}`, location);
    else add(resolve(version, 'docker'), `${subject(place)}${suffix}`, location, { version, naming: 'docker' });
  };
  for (const place of own) stage(place, '', at(place.file.file, place.root.line));
  for (const declaration of developerPlaces(detection, manager, manifest, (options.root?.versions.length ?? 0) > 0)) {
    const where = declaration.file === label(declaration) ? declaration.file : `${label(declaration)} in ${declaration.file}`;
    add(resolve(declaration.version, namingOf(declaration.source)), `Node.js ${declaration.version} in ${where}`, at(declaration.file, declaration.line), { version: declaration.version, naming: namingOf(declaration.source) });
  }
  // The root's version files and the stages of root Dockerfiles that build this project.
  for (const declaration of options.root?.versions ?? []) {
    if ('version' in declaration) {
      add(resolve(declaration.version, namingOf(declaration.source)), `Node.js ${declaration.version} in ${declaration.file}${AT_ROOT}`, undefined, { version: declaration.version, naming: namingOf(declaration.source) });
    }
  }
  for (const place of fromRoot) stage(place, AT_ROOT, undefined);
  return found;
}

/** "npm 11.16.0 (with Node.js 24.18.0 in .nvmrc)", "npm 11.3.0 to 11.19.1 (…)": the versions of an entry, or some of them. */
export function npmInUseText(entry: NpmInUse, versions: readonly Version[] = entry.versions): string {
  // "npm@latest (installed in job test of .github/workflows/ci.yml, line 9; depcurfew cannot tell which version that is)".
  if (entry.spec !== undefined) return `npm@${entry.spec} (${entry.where}; depcurfew cannot tell which version that is)`;
  // "the npm that comes with Node.js 24.99.0 in .nvmrc (depcurfew cannot tell which one: it is newer than …)".
  if (entry.unknown !== undefined || versions.length === 0) return `the npm that comes ${entry.where} (depcurfew cannot tell which one: ${entry.unknown ?? 'no version is known'})`;
  if (entry.range !== undefined) return `npm@${entry.range} (${entry.where})`;
  const sorted = [...versions].sort(compareVersions);
  const low = formatVersion(sorted[0] as Version);
  const high = formatVersion(sorted.at(-1) as Version);
  return `npm ${low === high ? low : `${low} to ${high}`} (${entry.where})`;
}

/**
 * Whether the text of an entry (npmInUseText) names several versions, "npm 8.6.0 to 10.8.2 (…)", so that the verb after
 * it is plural: "npm@11 (…)", "npm 10.9.0 (…)" and an npm depcurfew cannot tell are one (decision D-121).
 */
export function npmInUseSeveral(entry: NpmInUse, versions: readonly Version[] = entry.versions): boolean {
  if (entry.spec !== undefined || entry.range !== undefined || entry.unknown !== undefined || versions.length < 2) return false;
  const sorted = [...versions].sort(compareVersions);
  return compareVersions(sorted[0] as Version, sorted.at(-1) as Version) !== 0;
}

/** A Node.js declaration of a place, for whether an npm can run on it (npm extra.nodeEngines). */
export interface NodeOf {
  version: string;
  naming: Naming;
}

function nodeOf(declaration: VersionDeclaration): NodeOf[] {
  return 'version' in declaration && declaration.unknown === undefined ? [{ version: declaration.version, naming: namingFor(declaration) }] : [];
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
  /** What those installs do: npm ci only needs no release-age delay, installs with scripts off no script blocking. */
  of?: Installs;
  /** The Node.js the place runs, for whether the npm a fix names runs on it. */
  nodes?: readonly NodeOf[];
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

/** Whether npm ci installs exactly the versions of package-lock.json, so that a release-age delay changes nothing there. */
function lockedVersionsInstalled(): boolean {
  const fact = npmFacts.extra?.['cleanInstall'];
  const value = fact === undefined ? undefined : values(fact)[0];
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['installsLockedVersions'] === true;
}

/**
 * The settings the installs of a place rely on (decision D-115): npm ci installs the versions package-lock.json records,
 * so the release-age delay changes nothing there; installs with dependency scripts off need no script blocking.
 */
export function placeFeatures<T extends { kind?: 'cooldown' | 'scripts' }>(features: readonly T[], installs: Installs | undefined): T[] {
  if (installs === undefined) return [...features];
  const locked = installs.lockfile && lockedVersionsInstalled();
  return features.filter((item) => !(locked && item.kind === 'cooldown') && !(installs.scriptsOff && item.kind === 'scripts'));
}

/** The range of Node.js versions an npm version is meant to run on (engines.node of npm/cli at its release). */
function npmEngines(version: Version): string | undefined {
  const fact = npmFacts.extra?.['nodeEngines'];
  const list = fact === undefined ? undefined : values(fact)[0];
  if (!Array.isArray(list)) return undefined;
  let found: string | undefined;
  for (const entry of list as { since: string; node: string }[]) {
    const since = parseVersion(entry.since);
    if (since !== undefined && compareVersions(version, since) >= 0) found = entry.node;
  }
  return found;
}

/**
 * Whether the npm a fix names runs on the Node.js of the place (decision D-115): `none` when no release the place allows
 * is in the engines range of that npm (npm 11 on Node.js 18), `some` when only some are (npm 11 on Node.js 20 runs from
 * 20.17.0), undefined when every one is or it cannot be told.
 */
function enginesVerdict(version: Version, nodes: readonly NodeOf[] | undefined, facts: RuntimeFacts): { verdict: 'none' | 'some'; range: string } | undefined {
  const range = npmEngines(version);
  if (range === undefined || nodes === undefined || nodes.length === 0) return undefined;
  // Kept per run (per facts) and text: thousands of places name the same few versions.
  const known = VERDICTS.get(facts) ?? new Map<string, ReturnType<typeof nodeReleasesIn>>();
  VERDICTS.set(facts, known);
  const verdicts = nodes.map((node) => {
    const key = `${node.version}\u0000${node.naming}\u0000${range}`;
    if (!known.has(key)) known.set(key, nodeReleasesIn(node.version, node.naming, range, facts));
    return known.get(key);
  });
  if (verdicts.every((verdict) => verdict === 'none')) return { verdict: 'none', range };
  if (verdicts.some((verdict) => verdict === 'none' || verdict === 'some')) return { verdict: 'some', range };
  return undefined;
}

const VERDICTS = new WeakMap<RuntimeFacts, Map<string, ReturnType<typeof nodeReleasesIn>>>();

/** The facts of the knowledge base about Node.js releases, made once: npmInUse runs for every directory of a plan. */
let shared: RuntimeFacts | undefined;
function sharedFacts(): RuntimeFacts {
  shared ??= runtimeFacts(environment);
  return shared;
}

/**
 * Whether npm `version` runs on the Node.js of the places (decision D-115): `none` when no release they allow is in its
 * engines range (npm 11 on Node.js 18), `some` when only some are, undefined when every one is or it cannot be told.
 * The same check for the fixes of doctor and of depcurfew apply (decision D-121).
 */
export function npmEnginesOn(version: Version, nodes: readonly NodeOf[]): { verdict: 'none' | 'some'; range: string } | undefined {
  return enginesVerdict(version, nodes, sharedFacts());
}

/** An install of npm `version` in a place, with what the Node.js there needs for it. */
function installOn(place: Place, version: Version, facts: RuntimeFacts): string {
  const text = formatVersion(version);
  const engines = enginesVerdict(version, place.nodes, facts);
  if (engines === undefined) return place.install(text);
  if (engines.verdict === 'none') return `move to a Node.js release that npm ${text} runs on (${engines.range}), then ${place.install(text)}`;
  // An install that ends with the command in parentheses takes the note inside them (a developer's version file).
  const install = place.install(text);
  const note = `npm ${text} runs on Node.js ${engines.range} only`;
  return install.endsWith(')') ? `${install.slice(0, -1)}; ${note})` : `${install} (${note})`;
}

function report(context: RuleContext, helpers: BundledHelpers, check: Check, place: Place, resolution: Resolution, facts: RuntimeFacts): void {
  const name = check.tool.name;
  const low = resolution.bundled[0] as Version;
  const high = newest(resolution.bundled);
  const missing = helpers.missing(placeFeatures(check.features, place.of), (since) => compareVersions(low, since) < 0);
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
  // npm 11 does not run on Node.js 18 (engines): the fix then says to move to a Node.js it runs on (decision D-115).
  const install = (version: Version) => (check.tool.id === 'npm' ? installOn(place, version, facts) : place.install(formatVersion(version)));
  const alternatives = [
    ...(enough ? [other.set] : []),
    install(target),
    ...(runtime === undefined ? [] : [runtime]),
    ...(other === undefined || enough
      ? []
      : [`${install(other.version)} ${other.suffix(place.installSeen ? 'repository' : 'machine')}`, ...(otherRuntime === undefined ? [] : [`${otherRuntime} ${other.suffix('repository')}`])]),
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

/** npm install -g npm@X in a CI job or a Dockerfile stage that then installs packages with it (decision D-115). */
interface UpgradePlace {
  command: ToolCommand;
  file: string;
  /** "GitHub Actions" or "Dockerfile". */
  label: string;
  /** For a project: which installs use it ("job build installs packages with it in frontend on line 13"). */
  installs?: string;
  of: Installs;
  nodes: readonly NodeOf[];
}

/**
 * The npm an npm install -g npm@X puts in place, checked against the settings of the directory its installs run in, as
 * for packageManager: an exact version that lacks one is an error, a range whose lowest version does a warning, and a
 * version depcurfew cannot read a notice (apply counts it as an npm that runs every dependency install script).
 */
function checkUpgrade(context: RuleContext, helpers: BundledHelpers, check: Check, place: UpgradePlace, facts: RuntimeFacts): void {
  const spec = place.command.version;
  if (spec === undefined) return;
  const name = check.tool.name;
  const where = place.label === place.file ? place.label : `${place.label} (${place.file})`;
  const lowest = lowestVersion(spec);
  if (lowest.kind === 'unknown') {
    context.notice(`${RULE} cannot evaluate ${name} version "${spec}" in ${place.file}`, place.file);
    return;
  }
  const missing = helpers.missing(placeFeatures(check.features, place.of), (since) => belowVersion(lowest, since));
  if (missing.length === 0) return;
  const needed = newest(missing.map((item) => parseVersion(item.since) as Version));
  const list = describeRequirements(missing);
  const subject =
    lowest.kind === 'exact'
      ? `${name} ${formatBound(lowest)} in ${where} does not support ${list}`
      : `${where} allows ${name} ${formatBound(lowest)} ("${spec}"), which does not support ${list}`;
  const alternative = helpers.alternative(missing, name, check.advice);
  // npm 11 does not run on Node.js 18: then the Node.js has to change first (decision D-115).
  const engines = (version: Version) => {
    const found = enginesVerdict(version, place.nodes, facts);
    if (found === undefined) return '';
    return found.verdict === 'none'
      ? ` (npm ${formatVersion(version)} runs on Node.js ${found.range}, so move to such a Node.js release first)`
      : ` (npm ${formatVersion(version)} runs on Node.js ${found.range} only)`;
  };
  const fix =
    alternative !== undefined && lowest.kind === 'exact' && compareVersions(lowest.version, alternative.version) >= 0
      ? `${alternative.set.charAt(0).toUpperCase()}${alternative.set.slice(1)}, or require ${name} ${formatVersion(needed)} or later in ${place.label}${engines(needed)}`
      : `Require ${name} ${formatVersion(needed)} or later in ${place.label}${engines(needed)}${alternative === undefined ? '' : `, or ${alternative.text}`}`;
  context.report({
    level: lowest.kind === 'exact' ? 'error' : 'warning',
    location: { file: place.file, line: place.command.line },
    message: `${subject}${place.installs === undefined ? '' : `, and ${place.installs}`}`,
    fix,
  });
}

/**
 * CI jobs that install with npm: with the npm of a declared Node.js, or with the npm npm install -g npm@X puts in its
 * place. An install in the directory of a project (working-directory: frontend, cd frontend) uses that project's npm
 * configuration, so it is checked against the project's settings (decisions D-105 and D-115).
 */
function checkJobs(context: RuleContext, helpers: BundledHelpers, checkFor: (project: string) => Check | undefined, facts: RuntimeFacts): void {
  const projects = (context.projects ?? []).map((view) => view.directory);
  const resolve = resolver(facts);
  for (const place of jobPlaces(context.detection, projects)) {
    const { job, project, installs } = place;
    const check = checkFor(project);
    if (check === undefined) continue;
    const where = project === '' ? '' : ` in ${project}`;
    const uses = `job ${job.id} installs packages with it${where} on line ${installs.first}`;
    if (place.upgrade !== undefined) {
      checkUpgrade(context, helpers, check, { command: place.upgrade, file: job.file, label: SOURCE_LABEL['github-actions'], ...(project === '' ? {} : { installs: uses }), of: installs, nodes: place.nodes.flatMap(nodeOf) }, facts);
      continue;
    }
    const declaration = place.declaration;
    if (declaration === undefined) continue;
    if (!('version' in declaration)) {
      unknown(context, `the Node.js of ${declaration.versionFile} in ${declaration.file}`, 'depcurfew cannot read the version from that file', declaration.file);
      continue;
    }
    const subject = nodeSubject(declaration, helpers.label(declaration));
    if (declaration.unknown !== undefined) {
      unknown(context, subject, declaration.unknown, declaration.file);
      continue;
    }
    const resolution = resolve(declaration.version, namingFor(declaration));
    if (resolution.kind === 'unknown') {
      unknown(context, subject, resolution.reason, declaration.file);
      continue;
    }
    report(context, helpers, check, {
      subject,
      file: declaration.file,
      ...(declaration.line === undefined ? {} : { line: declaration.line }),
      enforced: true,
      installs: uses,
      of: installs,
      nodes: nodeOf(declaration),
      install: (version) => `run npm install -g npm@${version} in job ${job.id} before it installs packages`,
      installSeen: true,
      runtime: (releases, _first, bundled) =>
        declaration.container === undefined
          ? `set up a Node.js release that comes with npm ${bundled} or later (${releases})`
          : `run the job in a node image whose Node.js release comes with npm ${bundled} or later (${releases})`,
    }, resolution, facts);
  }
}

/**
 * Dockerfile stages that install with the tool of their image, or with the npm an npm install -g npm@X puts in its
 * place; a root stage that builds a project, or installs in its directory, is checked for it.
 */
function checkDockerfiles(context: RuleContext, helpers: BundledHelpers, checkFor: (project: string) => Check | undefined, tool: 'npm' | 'pip', facts: RuntimeFacts): void {
  const runtimeTool = tool === 'npm' ? 'node' : 'python';
  const projects = tool === 'npm' ? (context.projects ?? []).map((view) => view.directory) : [];
  for (const { file, stage, root, upgrade, project, installs } of dockerPlaces(context.detection.dockerfiles, tool, projects)) {
    const check = checkFor(project);
    if (check === undefined) continue;
    const name = stage.name === undefined ? `the stage at line ${stage.line}` : `stage ${stage.name}`;
    const uses = `${name} installs packages with it${project === '' ? '' : ` for ${project}`} on line ${installs.first}`;
    const runtime = stage.runtime;
    if (upgrade !== undefined) {
      // pip install pip==X is a declaration of pip, which the declared versions of pip cover.
      if (tool !== 'npm') continue;
      const nodes = runtime?.tool === 'node' && runtime.version !== undefined ? [{ version: runtime.version, naming: 'docker' as const }] : [];
      checkUpgrade(context, helpers, check, { command: upgrade, file: file.file, label: SOURCE_LABEL.dockerfile, ...(project === '' ? {} : { installs: uses }), of: installs, nodes }, facts);
      continue;
    }
    if (runtime === undefined) continue;
    const image = root.image ?? (runtimeTool === 'node' ? 'node' : 'python');
    const runtimeName = runtimeTool === 'node' ? 'Node.js' : 'Python';
    const version = runtime.version;
    const subject = `${runtimeName}${version === undefined ? '' : ` ${version}`} (${image}) in ${file.file}`;
    if (version === undefined) {
      // A note with the place and a fix, as runtime-end-of-life gives for the same stage (decision D-115): a digest
      // alone, a tag depcurfew does not know or an ARG without a value hides which npm or pip the image has.
      const settings = placeFeatures(check.features, installs);
      if (settings.length === 0) continue;
      const list = describeRequirements(settings.map(({ setting, since }) => ({ setting, since })));
      context.report({
        level: 'note',
        location: { file: file.file, line: root.line },
        message: `${RULE} cannot tell which ${tool} comes with ${subject}: ${runtime.unknown ?? 'the tag names no version'}`,
        fix: `Use a ${runtimeTool} image tag that names the ${runtimeName} version (such as ${runtimeTool}:${runtimeTool === 'node' ? '24-alpine' : '3.13-slim'}, with the digest after it: ${runtimeTool}:<tag>@sha256:…), or check by hand that the ${tool} of that image supports ${list}`,
      });
      continue;
    }
    const resolution = runtimeTool === 'node' ? nodeBundledNpm(version, 'docker', facts) : pythonBundledPip(version, facts);
    if (resolution.kind === 'unknown') {
      unknown(context, subject, resolution.reason, file.file);
      continue;
    }
    const replace = tool === 'npm' ? (target: string) => `npm install -g npm@${target}` : (target: string) => `pip install pip==${target}`;
    report(context, helpers, check, {
      subject,
      file: file.file,
      line: root.line,
      enforced: true,
      installs: uses,
      of: installs,
      ...(tool === 'npm' ? { nodes: [{ version, naming: 'docker' as const }] } : {}),
      install: (target) => `add RUN ${replace(target)} to ${name} before it installs packages`,
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
      ...(project === undefined ? {} : { installs: `${project} has no ${declaration.file.split('/').at(-1) ?? declaration.file} of its own, so it uses this one` }),
      // npm 11 and 12 do not run on every Node.js this file allows (decision D-121), as in CI and Dockerfiles.
      nodes: [{ version: declaration.version, naming: namingOf(declaration.source) }],
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
