// Every fact about a package manager or bot carries the official URL it was verified against
// and the date of verification. Disputed facts keep every variant with its own source.

export type ToolId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'uv' | 'pip' | 'poetry' | 'renovate' | 'dependabot';
export type ToolKind = 'package-manager' | 'update-bot';
/** The registry a package manager installs from; package names in the policy are compared per ecosystem. */
export type Ecosystem = 'npm' | 'pypi';

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
  /** Key of a list of patterns that exclude packages, next to the package list; such patterns win. */
  excludeKey?: string;
}

/** Facts for recognising a package manager in a repository. */
export interface ProjectKnowledge {
  /** Lockfile names in the project root. */
  lockfiles: Fact<Versioned<readonly string[]>>;
  /** Files that make a directory a project or a workspace package for this tool. */
  manifests: Fact<readonly string[]>;
  /** `null` when the tool has no workspaces. In TOML files the key is a dotted path to a table. */
  workspaces: Fact<WorkspaceDeclaration | null>;
  /** Key of the package list when the workspace declaration is an object instead of a list; `null` if only lists are accepted. */
  workspacesObjectKey: Fact<string | null>;
}

export interface ToolKnowledge {
  id: ToolId;
  name: string;
  kind: ToolKind;
  /** Package managers only; `npm` when absent. */
  ecosystem?: Ecosystem;
  cooldown: CooldownKnowledge;
  installScripts: InstallScriptsKnowledge;
  /** Package managers only: bots do not resolve dependency sources themselves. */
  sources?: SourcesKnowledge;
  /** Package managers only: how to recognize the tool in a repository. */
  project?: ProjectKnowledge;
  /** Further sourced facts that matter for generators and `doctor`, keyed by a short name. */
  extra?: Readonly<Record<string, Fact<unknown>>>;
}

/**
 * How a package manager's command line adds packages or downloads and runs them, for the install guard
 * (`depcurfew check --hook`). Commands are the executable followed by the subcommand, e.g. ["npm", "install"].
 */
/** A command that downloads packages, with the options that name packages and the options whose value is a command line. */
export interface DownloadCommand {
  command: readonly string[];
  /** Options whose value names a package to download as well. */
  packageOptions: readonly string[];
  /** Options whose value is a shell command line that runs with the downloaded packages. */
  lineOptions?: readonly string[];
  /** Flags that make the first argument a shell command line instead of a package. */
  shellOptions?: readonly string[];
}

export interface CommandLineKnowledge {
  /** Commands that add the packages given as arguments, aliases included. */
  add: readonly (readonly string[])[];
  /** Commands that download a package and run it; without a package option the first argument names the package. */
  run: readonly DownloadCommand[];
  /** Commands that download and run a starter package named after their first argument. */
  create: readonly DownloadCommand[];
  /**
   * How create commands name the package: `prefix` maps foo to create-foo, @s to @s/create and @s/foo to
   * @s/create-foo; `prefix-unless-prefixed` does the same but keeps a name (or the part after the scope) that already
   * starts with create-.
   */
  createNames: 'prefix' | 'prefix-unless-prefixed';
  /** Commands that run another command of the same tool in a workspace, after the given number of operands. */
  workspaceCommands?: readonly { command: readonly string[]; operands: number }[];
  /** Options of the add commands after which the arguments are local files, so no package is named. */
  fileOptions?: readonly string[];
  /**
   * Options of the add commands (or of every command) followed by a separate value; other options are flags. Empty
   * when listed in a fact of its own. Package options of run and create commands are listed with those commands only.
   */
  valueOptions: readonly string[];
}

/** Forms of a package spec on the command line that do not name a registry package, by prefix. */
export interface PackageSpecKnowledge {
  /** Prefixes of specs that install a git repository. */
  git: readonly string[];
  /** Prefixes of specs that install a local directory, or a local tarball when the path has a tarball extension. */
  local: readonly string[];
  /** Prefixes of specs that name a package of the workspace. */
  workspace: readonly string[];
  /** Prefix of a spec that installs another registry package under the given name (name@npm:other@1). */
  alias?: string;
  /** Prefixes of specs that download a tarball URL. */
  remoteTarball?: readonly string[];
  /** Extensions that make a path a tarball rather than a directory. */
  tarballExtensions?: readonly string[];
  /** The git prefix a bare user/repo spec stands for. */
  shorthand?: string;
  /** user@host:path (the scp-like form of an ssh URL) is a git repository. */
  scp?: boolean;
}

/**
 * Command-line options and environment variables that change where a package manager fetches packages from. In
 * option names, <scope> stands for any scope; variable names are compared without regard to case.
 */
export interface RegistryOverridesKnowledge {
  /** Their value is the URL of a registry. */
  registryOptions: readonly string[];
  registryVariables: readonly string[];
  /** Their value is another configuration file, which may set any registry. */
  configOptions: readonly string[];
  configVariables: readonly string[];
}

/** Where a project sets the registry packages come from, for all packages or for a scope. */
export interface RegistryConfigKnowledge {
  /** The project's configuration file. */
  file: string;
  /** The user's configuration file, which the project's file overrides. */
  userFile: string;
  /** The key with the base URL of the registry. */
  key: string;
  /** A scope followed by this suffix is the key of that scope's registry, e.g. @myco:registry. */
  scopeKeySuffix: string;
}

// Facts about the environment around the package managers: version pinning (Corepack, Volta, asdf) and CI.

/** A tool that environment facts refer to: Node.js, Python or a package manager. */
export type RuntimeOrTool = 'node' | 'python' | ToolId;

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

/** Uploading SARIF to GitHub code scanning from a workflow. */
export interface CodeScanningUploadKnowledge {
  action: string;
  inputs: { sarifFile: string; category: string };
  /** Workflow permissions needed in every repository, and in addition in private ones. */
  permissions: { always: Readonly<Record<string, string>>; privateRepositories: Readonly<Record<string, string>> };
}

/** Turning off the processing of workflow commands in a step's log; {token} stands for a unique random token. */
export interface StopCommandsKnowledge {
  stop: string;
  resume: string;
}

/** The public npm registry, as depcurfew check reads it. */
export interface NpmRegistryKnowledge {
  url: string;
  /** Path of a package document; scoped names have their slash escaped as %2f. */
  packagePath: string;
  /** Field of the full document that maps versions to publish times; the abbreviated install document lacks it. */
  timeField: string;
  /** Field of the document that maps tags (latest, next) to versions. */
  distTagsField: string;
  /** The tag every package has, which a spec without a version installs. */
  defaultTag: string;
  /** Field of the document that maps versions to their version objects. */
  versionsField: string;
  /** Field of a version object with the lifecycle scripts of its package.json. */
  scriptsField: string;
  /** Field of a version object that holds the deprecation message. */
  deprecatedField: string;
  /** Lifecycle scripts a package runs when it is installed as a dependency. */
  installScripts: readonly string[];
}

/** Claude Code hooks that run before a tool call and can block it (used by depcurfew check --hook claude-code). */
export interface ClaudeCodeHooksKnowledge {
  /** Project settings file that can be committed. */
  settingsFile: string;
  event: string;
  /** The tool name of shell commands, matched by the matcher. */
  shellTool: string;
  /** Fields of the JSON a command hook reads on stdin. */
  input: { event: string; tool: string; command: string; cwd: string };
  /** Fields of the JSON object a hook prints to decide. */
  output: { container: string; event: string; decision: string; reason: string };
  decisions: { deny: string; ask: string };
  /** A command hook that exits with this code blocks the call; stderr is the reason. */
  blockingExitCode: number;
  /** The handler field that blocks the call when the hook fails or times out, and the version that has it. */
  onFailure: { field: string; value: string; since: string };
  /** Placeholder for the project root in a hook command. */
  projectDir: string;
  /** Keys of a settings file: the hooks map, a matcher group and a command handler run without a shell. */
  settings: { hooks: string; matcher: string; handlers: string; type: string; commandType: string; command: string; args: string };
}

/**
 * Annotation workflow commands: `::{command} {property}={value},…::{message}` on a line of its own. Values are
 * escaped by replacing each character listed in `escape` (in order), properties also with `escapeProperty`.
 */
export interface AnnotationsKnowledge {
  commands: { error: string; warning: string; note: string };
  properties: { file: string; line: string; title: string };
  escape: readonly (readonly [string, string])[];
  escapeProperty: readonly (readonly [string, string])[];
}

/** How many annotations GitHub shows: per level in one step, and in all steps of a job together. */
export interface AnnotationLimitsKnowledge {
  perLevelPerStep: number;
  perJob: number;
}

/** The Markdown job summary of a step: the environment variable naming its file and its size limit. */
export interface StepSummaryKnowledge {
  variable: string;
  maxBytes: number;
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
    setupPython: Fact<SetupActionKnowledge>;
    setupUv: Fact<SetupActionKnowledge>;
    /** Third-party actions that install Poetry; Poetry has no official action. */
    installPoetry: Fact<SetupActionKnowledge>;
    actionsPoetry: Fact<SetupActionKnowledge>;
    codeScanningUpload: Fact<CodeScanningUploadKnowledge>;
    stopCommands: Fact<StopCommandsKnowledge>;
    annotations: Fact<AnnotationsKnowledge>;
    annotationLimits: Fact<AnnotationLimitsKnowledge>;
    stepSummary: Fact<StepSummaryKnowledge>;
  };
  npmRegistry: {
    api: Fact<NpmRegistryKnowledge>;
    notFoundStatus: Fact<number>;
    /** Search endpoint, its result limit and the field with weekly downloads. */
    search: Fact<{ path: string; maxSize: number; weeklyDownloadsField: string }>;
  };
  claudeCode: {
    hooks: Fact<ClaudeCodeHooksKnowledge>;
  };
  python: {
    /** How Python package names are compared: lowercased, with every run of these characters replaced by `replacement`. */
    nameNormalization: Fact<{ separators: string; replacement: string }>;
    /** Python package names: ASCII letters and digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
    namePattern: Fact<string>;
  };
}
