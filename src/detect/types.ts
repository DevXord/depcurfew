import type { BotOnlyEcosystemId, ToolId } from '../knowledge/types.ts';

export type { BotOnlyEcosystemId } from '../knowledge/types.ts';

export type PackageManagerId = Extract<ToolId, 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'uv' | 'pip' | 'poetry' | 'pdm' | 'pipenv' | 'composer' | 'bundler'>;
export type BotId = Extract<ToolId, 'renovate' | 'dependabot'>;

/** Why a package manager is considered in use. Ordered from the strongest signal. */
export type EvidenceKind = 'lockfile' | 'packageManager' | 'devEngines' | 'config' | 'ci' | 'default';

export interface Evidence {
  kind: EvidenceKind;
  /** Repository-relative path with `/` separators. */
  file: string;
}

/**
 * tool-config: a version the tool's own configuration requires, e.g. required-version in [tool.uv]. lockfile: the
 * version of the tool that wrote the lockfile, which the tool switches to (BUNDLED WITH in Gemfile.lock). nvmrc and
 * node-version: the files .nvmrc and .node-version; engines: engines.node in package.json (a range of the Node.js
 * versions the package works on, advisory); dockerfile: a Dockerfile (FROM node:22, RUN npm install -g npm@11).
 */
export type VersionSource =
  | 'packageManager'
  | 'tool-config'
  | 'lockfile'
  | 'devEngines'
  | 'volta'
  | 'tool-versions'
  | 'nvmrc'
  | 'node-version'
  | 'engines'
  | 'github-actions'
  | 'dockerfile';

/**
 * A version declared somewhere in the repository, as written (it may be a range or an expression). A CI step that
 * names a version file has `versionFile`, and also `version` when depcurfew could read the version from that file.
 */
export type VersionDeclaration = ({ version: string; versionFile?: string } | { versionFile: string }) & {
  source: VersionSource;
  file: string;
  line?: number;
  /** github-actions: the key of the job under jobs. */
  job?: string;
  /** github-actions: the line of the step that sets the version up; installs after it and before the next such step use it. */
  step?: number;
  /** github-actions: the version is one value of this matrix key, from ${{ matrix.<key> }}; the line is the value's. */
  matrix?: string;
  /** Why depcurfew does not read the version written (a matrix with too many values); the version is then as written. */
  unknown?: string;
  /** dockerfile: the build stage, by its name or its number from 0. */
  stage?: string;
  /**
   * github-actions: the image of jobs.<id>.container (node:20) the version comes from, read like a FROM of a Dockerfile
   * (decision D-115); the line is the image's, and it stands for the job's steps until a setup step.
   */
  container?: string;
};

/**
 * A command in a CI run step or a Dockerfile RUN instruction. install: installs packages with the tool (npm ci,
 * npm install, pip install -r requirements.txt, pnpm install, yarn, bun add); upgrade: replaces the tool itself
 * (npm install -g npm@11.17.0, pip install --upgrade pip, corepack enable npm). npm install -g with another package is
 * neither: npm does not read the project .npmrc in global mode.
 */
export interface ToolCommand {
  kind: 'install' | 'upgrade';
  /**
   * pnpm, Yarn and Bun only install (their versions come from packageManager and the setup actions); poetry only
   * upgrades: pipx install poetry==2.3.0 or pip install poetry==2.3.0 installs that Poetry (decision D-115). bundler:
   * bundle install, update, lock, add and cache resolve the Gemfile, and gem install bundler -v 4.0.23 upgrades (decision
   * D-152).
   */
  tool: 'npm' | 'pip' | 'pnpm' | 'yarn' | 'bun' | 'poetry' | 'bundler';
  /** upgrade: the version asked for as written, latest when none is; absent when the command does not say (corepack enable npm). */
  version?: string;
  /** npm ci and its aliases, which install exactly the versions of package-lock.json (decision D-115). */
  lockfile?: true;
  /** npm runs it with dependency install scripts off (--ignore-scripts, npm_config_ignore_scripts=true; decision D-115). */
  scriptsOff?: true;
  /**
   * npm install: its command line and variables leave out optional dependencies (--omit=optional, --no-optional,
   * npm_config_omit=optional) or keep them whatever .npmrc says (--include=optional); absent when they do not say
   * (decision D-127).
   */
  optionalDependencies?: 'omitted' | 'kept';
  /** pip install: the release-age delay it gets, as written (--uploaded-prior-to, PIP_UPLOADED_PRIOR_TO; decision D-115). */
  delay?: string;
  /** pip install: PIP_CONFIG_FILE names a file that may set the delay, or the value is a variable depcurfew does not read. */
  delayUnknown?: true;
  /** bundler: the delay comes from the command line (--cooldown), not from BUNDLE_COOLDOWN (decision D-152). */
  delayOption?: true;
  line: number;
  /**
   * A command that installs or runs Corepack comes before it in the same job (an earlier run step, or earlier in its
   * own) or Dockerfile stage (an earlier RUN, or earlier in its own), also on the same line (decision D-141).
   */
  afterCorepack?: true;
  /**
   * github-actions: the working directory of the run step as written (working-directory of the step, or
   * defaults.run.working-directory of the job or the workflow), without ./ and a trailing /, joined with the literal
   * cd before the command (cd frontend && npm ci); absent for the root. dockerfile: the directory of a literal cd before
   * the command, relative to the working directory of the instruction. A cd depcurfew does not follow ($DIR, an
   * absolute path) gives a directory that is no project (decision D-115).
   */
  directory?: string;
}

/** A GitHub Actions job, with what its run steps do with npm and pip. */
export interface WorkflowJob {
  file: string;
  /** The key of the job under jobs. */
  id: string;
  line: number;
  /** Installs and package manager changes, in order. */
  commands: ToolCommand[];
  /** A run step calls node, npm, npx, pnpm, yarn, bun or corepack, so the job uses the Node.js it sets up. */
  runsNode: boolean;
  /**
   * A run step may change pip's configuration (pip config set, a pip.conf it writes, PIP_CONFIG_FILE in env), so the
   * release-age delay of its pip installs cannot be told (decision D-115).
   */
  pipConfig?: true;
  /** The line of the first run step command that installs Corepack (npm install -g corepack) or runs it (decision D-128). */
  corepack?: number;
}

/** The official runtime image a build stage starts from. */
export interface StageRuntime {
  tool: 'node' | 'python';
  /** The tag as written after ARG substitution; absent when the image has none (latest, or a digest alone). */
  tag?: string;
  /** The version the tag names: 22, 22.11.0, lts, jod, latest (moving tags stay names); absent when it cannot be told. */
  version?: string;
  /** Why the version cannot be told. */
  unknown?: string;
}

export interface DockerStage {
  /** The line of its FROM instruction. */
  line: number;
  /** The name after AS, in lower case. */
  name?: string;
  /** The image after ARG substitution; absent when an ARG it uses has no value. */
  image?: string;
  /** The earlier stage this one starts from (FROM <name>), by its number from 0. */
  from?: number;
  /** The official node or python image of this stage or of the stage it starts from. */
  runtime?: StageRuntime;
  commands: ToolCommand[];
  /** A RUN may change pip's configuration (pip config set, a pip.conf it writes), as for jobs (decision D-115). */
  pipConfig?: true;
  /** The line of the first RUN command that installs Corepack (npm install -g corepack) or runs it (decision D-128). */
  corepack?: number;
  /**
   * The source paths of the stage's COPY and ADD instructions that copy from the build context (not --from), as
   * written; absent when there are none. A root Dockerfile whose stage copies only files of one directory listed in
   * projects builds that project (decision D-109). At most 256.
   */
  copies?: string[];
}

export interface DockerfileInfo {
  file: string;
  stages: DockerStage[];
}

export interface PackageManagerInfo {
  id: PackageManagerId;
  /** Yarn only: Berry (2+) or Classic (1.x). */
  variant?: 'berry' | 'classic';
  /** False for tools the knowledge base does not cover, such as Yarn Classic. */
  supported: boolean;
  evidence: Evidence[];
  versions: VersionDeclaration[];
  /** The tool's own configuration files, in the root and in workspace packages; `.npmrc` is listed separately. */
  configFiles: string[];
}

export interface BotInfo {
  id: BotId;
  configFiles: string[];
}

/**
 * An ecosystem whose new versions depcurfew delays only through the update bots (decision D-151): its package manager
 * has no release-age delay depcurfew configures.
 */
export interface BotEcosystemInfo {
  id: BotOnlyEcosystemId;
  /** The files that show it, from the root, the direct subdirectories, workspace packages and projects; sorted. */
  files: string[];
}

export interface WorkspaceInfo {
  declarations: { file: string; patterns: string[] }[];
  /** Directories of workspace packages, without the root. */
  packages: string[];
}

export interface DetectionWarning {
  code: string;
  message: string;
  files: string[];
  /** The line in the first file the warning is about, when it names one (decision D-124). */
  line?: number;
}

export interface Detection {
  packageManagers: PackageManagerInfo[];
  /**
   * Detected with the directories listed in projects (decision D-137): package managers only CI setup steps of the root
   * show, while the root holds no manifest of their registry, or every install with them in its workflows runs in a
   * listed directory and no Dockerfile of the root installs with them. The steps set them up for the projects, so they
   * are no package managers of the root; the versions the steps install are still checked. Absent when there are none.
   */
  ciForProjects?: PackageManagerInfo[];
  node: { versions: VersionDeclaration[] };
  bots: BotInfo[];
  /** Cargo, Go modules, Maven, Gradle and NuGet, whose new versions only the bots delay (decision D-151); absent when none. */
  botEcosystems?: BotEcosystemInfo[];
  workspaces: WorkspaceInfo | null;
  /** `.npmrc` files in the root and in workspace packages; several tools read them. */
  npmrcFiles: string[];
  /** GitHub Actions workflow files that were read. */
  workflows: string[];
  /** The jobs of those workflows. */
  jobs: WorkflowJob[];
  /** Dockerfiles and Containerfiles of the root, its direct subdirectories without a manifest, and workspace packages. */
  dockerfiles: DockerfileInfo[];
  warnings: DetectionWarning[];
}
