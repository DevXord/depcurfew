// Every fact about a package manager or bot carries the official URL it was verified against
// and the date of verification. Disputed facts keep every variant with its own source.

export type ToolId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'renovate' | 'dependabot';
export type ToolKind = 'package-manager' | 'update-bot';

export interface Evidence<T> {
  value: T;
  /** URL of official documentation or changelog. */
  source: string;
  /** YYYY-MM-DD */
  verifiedAt: string;
  note?: string;
}

export interface VerifiedFact<T> extends Evidence<T> {
  status: 'verified';
}

/**
 * Supported by an official source, but not conclusively: inferred from code paths or issue comments,
 * or concluded from the absence of an option in a settings list.
 */
export interface UncertainFact<T> extends Evidence<T> {
  status: 'uncertain';
  note: string;
}

/** Official sources disagree; every variant is kept. */
export interface DisputedFact<T> {
  status: 'disputed';
  note: string;
  variants: readonly [Evidence<T>, Evidence<T>, ...Evidence<T>[]];
}

export type Fact<T> = VerifiedFact<T> | UncertainFact<T> | DisputedFact<T>;
export type FactStatus = Fact<unknown>['status'];

/** A value that changed between versions, oldest first. */
export interface Since<T> {
  /** First version with this value; `0.0.0` when the first version is not tracked. */
  since: string;
  value: T;
}
export type Versioned<T> = readonly Since<T>[];

export type DelayUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'duration-string';

/** How a release-age delay treats security updates. */
export type SecurityUpdateBehavior =
  | 'bypass' // security updates skip the delay
  | 'applies' // the delay also holds back security updates
  | 'configurable'; // a separate setting controls the delay for security updates

/** Whether dependency lifecycle scripts (preinstall/install/postinstall) run. */
export type ScriptPolicy =
  | 'run'
  | 'run-with-warning'
  | 'deny'
  | 'deny-except-allowlist'
  | 'not-applicable';

export interface CooldownKnowledge {
  setting: Fact<string | null>;
  configFiles: Fact<readonly string[]>;
  cliFlag: Fact<string | null>;
  unit: Fact<DelayUnit | null>;
  availableSince: Fact<string | null>;
  /** `null` means the delay is off. */
  default: Fact<Versioned<number | string | null>>;
  // Details of a setting are optional only when the setting is known not to exist (value `null`);
  // the validator enforces this.
  exclude: {
    setting: Fact<string | null>;
    availableSince?: Fact<string | null>;
    patternSyntax?: Fact<string | null>;
  };
  securityUpdates: Fact<SecurityUpdateBehavior | null>;
}

export interface InstallScriptsKnowledge {
  defaultPolicy: Fact<Versioned<ScriptPolicy>>;
  allowList: {
    setting: Fact<string | null>;
    file?: Fact<string | null>;
    availableSince?: Fact<string | null>;
    format?: Fact<string | null>;
  };
  /** Setting or flag that turns off all dependency scripts. */
  disableAll: Fact<string | null>;
}

/** Control over one kind of dependency source (git, remote tarball, local file, local directory). */
export interface SourceKnowledge {
  setting: Fact<string | null>;
  values?: Fact<readonly string[] | null>;
  availableSince?: Fact<string | null>;
  default?: Fact<Versioned<string> | null>;
}

export interface SourcesKnowledge {
  git: SourceKnowledge;
  remoteTarball: SourceKnowledge;
  file: SourceKnowledge;
  directory: SourceKnowledge;
}

/** Where a tool declares workspace packages: a key in the first of these files that exists. */
export interface WorkspaceDeclaration {
  files: readonly string[];
  key: string;
}

/** Facts for recognising a package manager in a repository. */
export interface ProjectKnowledge {
  /** Lockfile names in the project root. */
  lockfiles: Fact<Versioned<readonly string[]>>;
  /** Files that make a directory a project or a workspace package for this tool. */
  manifests: Fact<readonly string[]>;
  workspaces: Fact<WorkspaceDeclaration>;
  /** Key of the package list when the workspace declaration is an object instead of a list; `null` if only lists are accepted. */
  workspacesObjectKey: Fact<string | null>;
}

export interface ToolKnowledge {
  id: ToolId;
  name: string;
  kind: ToolKind;
  cooldown: CooldownKnowledge;
  installScripts: InstallScriptsKnowledge;
  /** Package managers only: bots do not resolve dependency sources themselves. */
  sources?: SourcesKnowledge;
  /** Package managers only: how to recognise the tool in a repository. */
  project?: ProjectKnowledge;
  /** Further sourced facts that matter for generators and `doctor`, keyed by a short name. */
  extra?: Readonly<Record<string, Fact<unknown>>>;
}

// Facts about the environment around the package managers: version pinning (Corepack, Volta, asdf) and CI.

/** A tool that environment facts refer to: Node.js or a package manager. */
export type RuntimeOrTool = 'node' | ToolId;

export interface PackageManagerFieldKnowledge {
  /** Key in package.json, e.g. `packageManager`. */
  key: string;
  /** Package managers Corepack accepts in that key. */
  managers: readonly ToolId[];
}

export interface DevEnginesKnowledge {
  key: string;
  packageManagerKey: string;
  runtimeKey: string;
}

export interface VoltaKnowledge {
  /** Key in package.json. */
  key: string;
  /** Tools whose versions Volta pins in that key. */
  tools: readonly RuntimeOrTool[];
}

export interface WorkflowsKnowledge {
  directory: string;
  extensions: readonly string[];
}

export interface SetupActionInput {
  name: string;
  /** `runtime` values have the form `<name>@<version>`, e.g. `node@22`. */
  kind: 'version' | 'version-file' | 'runtime';
  /** The tool a `version` or `version-file` input refers to. */
  tool?: RuntimeOrTool;
}

export interface SetupActionKnowledge {
  /** `owner/name`, compared without case. */
  action: string;
  /** Tools whose use the step itself shows. */
  installs: readonly RuntimeOrTool[];
  inputs: readonly SetupActionInput[];
}

export interface EnvironmentKnowledge {
  corepack: {
    packageManagerField: Fact<PackageManagerFieldKnowledge>;
    devEnginesSince: Fact<string>;
    envFileSince: Fact<string>;
    bundledWithNode: Fact<Versioned<boolean>>;
  };
  devEngines: Fact<DevEnginesKnowledge>;
  devEnginesSince: Fact<string>;
  volta: {
    manifest: Fact<VoltaKnowledge>;
    maintained: Fact<boolean>;
  };
  asdf: {
    /** Name of the file that pins tool versions. */
    toolVersionsFile: Fact<string>;
    /** Plugin names mapped to the tools they install. */
    plugins: Fact<Readonly<Record<string, RuntimeOrTool>>>;
  };
  githubActions: {
    workflows: Fact<WorkflowsKnowledge>;
    setupNode: Fact<SetupActionKnowledge>;
    pnpmActionSetup: Fact<SetupActionKnowledge>;
    pnpmSetup: Fact<SetupActionKnowledge>;
    setupBun: Fact<SetupActionKnowledge>;
    setupDeno: Fact<SetupActionKnowledge>;
  };
}
