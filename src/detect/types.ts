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

/** tool-config: a version the tool's own configuration requires, e.g. required-version in [tool.uv]. */
export type VersionSource = 'packageManager' | 'tool-config' | 'devEngines' | 'volta' | 'tool-versions' | 'github-actions';

/** A version declared somewhere in the repository, as written (it may be a range or an expression). */
export type VersionDeclaration = ({ version: string } | { versionFile: string }) & {
  source: VersionSource;
  file: string;
  line?: number;
};

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
  warnings: DetectionWarning[];
}
