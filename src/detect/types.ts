import type { ToolId } from '../knowledge/types.ts';

export type PackageManagerId = Extract<ToolId, 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'uv' | 'pip' | 'poetry' | 'pdm' | 'pipenv'>;
export type BotId = Extract<ToolId, 'renovate' | 'dependabot'>;

/** Why a package manager is considered in use. Ordered from the strongest signal. */
export type EvidenceKind = 'lockfile' | 'packageManager' | 'devEngines' | 'config' | 'ci' | 'default';

export interface Evidence {
  kind: EvidenceKind;
  /** Repository-relative path with `/` separators. */
  file: string;
}

/**
 * tool-config: a version the tool's own configuration requires, e.g. required-version in [tool.uv]. nvmrc and
 * node-version: the files .nvmrc and .node-version; engines: engines.node in package.json (a range of the Node.js
 * versions the package works on, advisory); dockerfile: a Dockerfile (FROM node:22, RUN npm install -g npm@11).
 */
export type VersionSource =
  | 'packageManager'
  | 'tool-config'
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
  /** dockerfile: the build stage, by its name or its number from 0. */
  stage?: string;
};

/**
 * A command in a CI run step or a Dockerfile RUN instruction. install: installs packages with the tool (npm ci,
 * npm install, pip install -r requirements.txt); upgrade: replaces the tool itself (npm install -g npm@11.17.0,
 * pip install --upgrade pip, corepack enable npm).
 */
export interface ToolCommand {
  kind: 'install' | 'upgrade';
  tool: 'npm' | 'pip';
  /** upgrade: the version asked for as written, latest when none is; absent when the command does not say (corepack enable npm). */
  version?: string;
  line: number;
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

export interface WorkspaceInfo {
  declarations: { file: string; patterns: string[] }[];
  /** Directories of workspace packages, without the root. */
  packages: string[];
}

export interface DetectionWarning {
  code: string;
  message: string;
  files: string[];
}

export interface Detection {
  packageManagers: PackageManagerInfo[];
  node: { versions: VersionDeclaration[] };
  bots: BotInfo[];
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
