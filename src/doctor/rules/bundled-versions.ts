// Part of manager-version-too-old: the npm that comes with a declared Node.js, and the pip that comes with the python
// image, must know the settings in use wherever nothing replaces them. A CI job that installs with npm after setup-node,
// a Dockerfile stage that installs with npm or pip, and the version files developers use (.nvmrc, .node-version,
// Volta, .tool-versions, devEngines.runtime, engines.node of a private package) decide which Node.js runs.
import { describeRequirements, type Requirement } from '../../apply/requirements.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import { values } from '../../apply/facts.ts';
import type { DockerfileInfo, DockerStage, PackageManagerInfo, VersionDeclaration, WorkflowJob } from '../../detect/types.ts';
import { environment } from '../../knowledge/environment.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import type { Level, RuleContext } from '../types.ts';
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
  type Resolution,
  type RuntimeFacts,
} from '../runtime-versions.ts';

export interface BundledHelpers {
  features: (tool: ToolKnowledge) => readonly Requirement[];
  missing: (features: readonly Requirement[], below: (since: Version) => boolean) => Requirement[];
  line: (declaration: VersionDeclaration) => number | undefined;
  label: (declaration: VersionDeclaration) => string;
}

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
  /** "24.14.1 or a later 24.x; 26.0.0 or later", the first of those releases, and the version they bring at least. */
  runtime: (releases: string, first: string, bundled: string) => string;
}

interface Check {
  tool: ToolKnowledge;
  features: readonly Requirement[];
  /** The version the repository pins for the tool, offered in the fix when it is new enough. */
  pinned: Version | undefined;
  /** npm: the release since which an unknown .npmrc key gives a warning. */
  warnsSince?: Version;
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
  const alternatives = [
    place.install(formatVersion(target)),
    ...(better.length === 0 ? [] : [place.runtime(releasesPhrase(better, newestLine), formatVersion(better[0]?.release as Version), formatVersion(needed))]),
  ];
  const fix = alternatives.join(', or ');
  const level: Level = place.enforced && none.length > 0 ? 'error' : 'warning';
  context.report({
    level,
    location: place.line === undefined ? { file: place.file } : { file: place.file, line: place.line },
    message,
    fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}${better.length === 0 && check.tool.id === 'npm' ? ` (no supported Node.js release comes with ${name} ${formatVersion(needed)} yet)` : ''}`,
  });
}

function unknown(context: RuleContext, subject: string, reason: string, file: string): void {
  context.notice(`${RULE} cannot tell which npm or pip comes with ${subject}: ${reason}`, file);
}

/** The first install with the tool in a job that nothing before it replaced; undefined when the tool is replaced first or not used. */
function firstPlainInstall(commands: readonly WorkflowJob['commands'][number][], tool: 'npm' | 'pip', replaced: boolean): number | undefined {
  let changed = replaced;
  for (const command of commands) {
    if (command.tool !== tool) continue;
    if (command.kind === 'upgrade') changed = true;
    else if (!changed) return command.line;
  }
  return undefined;
}

/** "Node.js 22 (matrix.node) in GitHub Actions (.github/workflows/ci.yml, job test)", "Node.js 22 in .nvmrc". */
export function nodeSubject(declaration: VersionDeclaration & { version: string }, label: string): string {
  const matrix = declaration.matrix === undefined ? '' : ` (matrix.${declaration.matrix})`;
  const where = declaration.source === 'github-actions' && declaration.job !== undefined ? `${declaration.file}, job ${declaration.job}` : declaration.file;
  const from = declaration.versionFile === undefined ? '' : ` from ${declaration.versionFile}`;
  return `Node.js ${declaration.version}${matrix}${from} in ${label === where ? label : `${label} (${where})`}`;
}

/**
 * The commands of a job that use the Node.js a setup step declares: after that step and before the next step that
 * sets up Node.js again (a job can build on one version and then test on another). Without a step line, all of them.
 */
export function commandsAfterStep(job: WorkflowJob, declaration: VersionDeclaration, all: readonly VersionDeclaration[]): WorkflowJob['commands'] {
  const step = declaration.step;
  if (step === undefined) return job.commands;
  const next = all.map((entry) => entry.step).filter((line): line is number => line !== undefined && line > step);
  const end = next.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...next);
  return job.commands.filter((command) => command.line > step && command.line < end);
}

function checkJobs(context: RuleContext, helpers: BundledHelpers, check: Check, facts: RuntimeFacts): void {
  for (const job of context.detection.jobs) {
    const declarations = context.detection.node.versions.filter((entry) => entry.source === 'github-actions' && entry.file === job.file && entry.job === job.id);
    for (const declaration of declarations) {
      const install = firstPlainInstall(commandsAfterStep(job, declaration, declarations), 'npm', false);
      if (install === undefined) continue;
      if (!('version' in declaration)) {
        unknown(context, `the Node.js of ${declaration.versionFile} in ${declaration.file}`, 'depcurfew cannot read the version from that file', declaration.file);
        continue;
      }
      const subject = nodeSubject(declaration, helpers.label(declaration));
      const resolution = nodeBundledNpm(declaration.version, 'setup-node', facts);
      if (resolution.kind === 'unknown') {
        unknown(context, subject, resolution.reason, declaration.file);
        continue;
      }
      report(context, helpers, check, {
        subject,
        file: declaration.file,
        ...(declaration.line === undefined ? {} : { line: declaration.line }),
        enforced: true,
        installs: `job ${job.id} installs packages with it on line ${install}`,
        install: (version) => `run npm install -g npm@${version} in job ${job.id} before it installs packages`,
        runtime: (releases, _first, bundled) => `set up a Node.js release that comes with npm ${bundled} or later (${releases})`,
      }, resolution, facts);
    }
  }
}

/** The stage a stage starts from, up to the one with an image, and whether the tool was replaced on the way. */
function ancestry(file: DockerfileInfo, stage: DockerStage, tool: 'npm' | 'pip'): { root: DockerStage; replaced: boolean } {
  let root = stage;
  let replaced = false;
  const seen = new Set<DockerStage>();
  while (root.from !== undefined && !seen.has(root)) {
    seen.add(root);
    const parent = file.stages[root.from];
    if (parent === undefined) break;
    if (parent.commands.some((command) => command.tool === tool && command.kind === 'upgrade')) replaced = true;
    root = parent;
  }
  return { root, replaced };
}

function checkDockerfiles(context: RuleContext, helpers: BundledHelpers, check: Check, facts: RuntimeFacts): void {
  const tool = check.tool.id === 'npm' ? 'npm' : 'pip';
  const runtimeTool = tool === 'npm' ? 'node' : 'python';
  for (const file of context.detection.dockerfiles) {
    const reported = new Set<DockerStage>();
    for (const stage of file.stages) {
      if (stage.runtime?.tool !== runtimeTool) continue;
      const { root, replaced } = ancestry(file, stage, tool);
      const install = firstPlainInstall(stage.commands, tool, replaced);
      if (install === undefined || reported.has(root)) continue;
      reported.add(root);
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
        installs: `${name} installs packages with it on line ${install}`,
        install: (target) => `add RUN ${upgrade(target)} to ${name} before it installs packages`,
        runtime: (releases, first, bundled) => `start from a ${runtimeTool} image whose ${runtimeName} release comes with ${tool} ${bundled} or later (${releases}), such as ${runtimeTool}:${first}`,
      }, resolution, facts);
    }
  }
}

function checkDeveloperFiles(context: RuleContext, helpers: BundledHelpers, check: Check, manager: PackageManagerInfo, facts: RuntimeFacts): void {
  const declarations = context.detection.node.versions.filter((entry) => DEVELOPER_SOURCES.has(entry.source));
  // Volta installs its own npm when package.json pins one.
  const voltaNpm = manager.versions.some((entry) => entry.source === 'volta');
  // engines.node says which Node.js versions a package works on; it chooses the Node.js of a project only when the
  // project is not published (private) and nothing more specific names one.
  const manifest = context.repository.parseOnce('package.json', (text) => JSON.parse(text) as unknown);
  const isPrivate = typeof manifest === 'object' && manifest !== null && (manifest as Record<string, unknown>)['private'] === true;
  const others = declarations.some((entry) => entry.source !== 'engines');
  for (const declaration of declarations) {
    if (!('version' in declaration)) continue;
    if (declaration.source === 'volta' && voltaNpm) continue;
    if (declaration.source === 'engines' && (!isPrivate || others)) continue;
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
      install: (version) => `install npm ${version} where this Node.js is used (npm install -g npm@${version})`,
      runtime: (releases, _first, bundled) => `require a Node.js release that comes with npm ${bundled} or later in ${helpers.label(declaration)} (${releases})`,
    }, resolution, facts);
  }
}

/** The exact version the repository pins for everyone (packageManager, devEngines, Volta, .tool-versions, the tool's own configuration). */
function repositoryPin(manager: PackageManagerInfo): Version | undefined {
  return pinnedVersion({ ...manager, versions: manager.versions.filter((entry) => entry.source !== 'github-actions' && entry.source !== 'dockerfile') });
}

/** The npm and pip that come with the declared runtimes, checked against the settings the repository relies on. */
export function checkBundledVersions(context: RuleContext, helpers: BundledHelpers): void {
  const facts = runtimeFacts(environment);
  const managed = (id: string) => context.detection.packageManagers.find((entry) => entry.id === id && entry.supported);
  const npmManager = managed('npm');
  const npm = context.tools.find((entry) => entry.id === 'npm');
  if (npmManager !== undefined && npm !== undefined) {
    const features = helpers.features(npm);
    if (features.length > 0) {
      const unknownKeys = npm.extra?.['unknownConfigKeys'] === undefined ? undefined : values(npm.extra['unknownConfigKeys'])[0];
      const warning = Array.isArray(unknownKeys) ? (unknownKeys as { since: string; value: string }[]).find((entry) => entry.value === 'warning')?.since : undefined;
      const warnsSince = warning === undefined ? undefined : parseVersion(warning);
      const check: Check = { tool: npm, features, pinned: repositoryPin(npmManager), ...(warnsSince === undefined ? {} : { warnsSince }) };
      checkJobs(context, helpers, check, facts);
      checkDockerfiles(context, helpers, check, facts);
      checkDeveloperFiles(context, helpers, check, npmManager, facts);
    }
  }
  const pipManager = managed('pip');
  const pip = context.tools.find((entry) => entry.id === 'pip');
  if (pipManager !== undefined && pip !== undefined) {
    const features = helpers.features(pip);
    if (features.length > 0) checkDockerfiles(context, helpers, { tool: pip, features, pinned: repositoryPin(pipManager) }, facts);
  }
}
