// Every fact about a package manager or bot carries the official URL it was verified against
// and the date of verification. Disputed facts keep every variant with its own source.

export type ToolId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'uv' | 'pip' | 'poetry' | 'pdm' | 'pipenv' | 'renovate' | 'dependabot';
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

/** A platform family for user-level paths. */
export type UserPlatform = 'linux' | 'darwin' | 'win32';

/** A base directory for a user-level file. */
export interface UserDirectory {
  /**
   * Where it starts: an environment variable (used only when it is set and not empty, and with `absolute` only when
   * it is an absolute path), or the home directory (HOME on Linux and macOS, USERPROFILE on Windows).
   */
  from: { env: string; absolute?: boolean } | 'home';
  /** Path below it, with / separators; empty for the directory itself. */
  path: string;
  /** Use this directory only when it already exists (pip on macOS). */
  ifExists?: boolean;
  /** Skip this directory while this environment variable is set and not empty (pip 26.2+ on macOS and XDG_DATA_HOME). */
  unlessEnv?: string;
}

/** Where the user file is on some platforms: the first directory that applies is used. */
export interface UserLocation {
  platforms: readonly UserPlatform[];
  directories: readonly UserDirectory[];
  file: string;
}

/** The user-level configuration file of a range of versions. */
export interface UserFile {
  format: 'ini' | 'yaml' | 'toml';
  locations: readonly UserLocation[];
  /** INI only: the [sections] whose keys the tool reads, '' for the keys above the first header; absent: every key. */
  sections?: readonly string[];
  /** Other user-level files this version reads the same settings from, whose keys win over this file's. */
  overriddenBy?: readonly UserFile[];
  /** INI only: the tool reads a key with underscores as the same key with dashes (pip: only_binary is only-binary). */
  underscoresAsDashes?: boolean;
  /** YAML only: the tool's loader applies merge keys (<<: *defaults), so merged keys count as keys of the map. */
  mergeKeys?: boolean;
}

/** What depcurfew writes with a user-level setting. */
export type UserSettingPurpose =
  | 'cooldown'
  | 'cooldownExclude'
  | 'cooldownStrict'
  | 'scriptsAllow'
  | 'scriptsStrict'
  | 'buildsDeny'
  | 'buildsAllow'
  | 'sourceGit'
  | 'sourceRemote'
  | 'sourceFile'
  | 'sourceDirectory'
  | 'sourcesExotic';

/** A setting the tool reads from its user file: the key there and the versions that read it from that file. */
export interface UserSetting {
  purpose: UserSettingPurpose;
  key: string;
  since: string;
  /** First version that no longer reads it from the user file. */
  until?: string;
}

/**
 * The values of a switch that turns a protection off, given by the values the tool reads as off: every other value
 * turns it on (fail closed), so a string "false" or "yes" that the tool takes for true is not missed. In INI files and
 * environment variables values are compared as text after trimming, elsewhere with their type (false, 0, null, "").
 */
export interface UnlessOff<T> {
  except: readonly T[];
}

/** A value in the user file that weakens every project that does not set the key itself (doctor --user). */
export interface UserWeakening {
  key: string;
  /** 'any' for every value, the values that weaken, or every value except those the tool reads as off. */
  values: 'any' | readonly (string | number | boolean)[] | UnlessOff<string | number | boolean | null>;
  /** What it does, for the message. */
  effect: string;
}

/** An environment variable that bypasses or overrides the user file or the policy (doctor --user). */
export interface UserVariable {
  /** The variable name; matched without regard to case when `anyCase`. */
  name: string;
  anyCase?: boolean;
  /** 'any' when every value matters, the values that weaken, or every value except those the tool reads as off. */
  values: 'any' | readonly string[] | UnlessOff<string>;
  effect: string;
  /** First version that reads the variable; every version when absent. */
  since?: string;
  /** First version that no longer reads it. */
  until?: string;
  /** The file the tool reads when the variable is unset, from the home directory (~/.npmrc): naming it changes nothing. */
  defaultPath?: string;
}

/** The tool's user-level configuration, for `depcurfew apply --user` and `doctor --user`. */
export interface UserConfigKnowledge {
  /** The user file per version, oldest first; null for versions without a user file. */
  files: Fact<Versioned<UserFile | null>>;
  /** Settings depcurfew can write there. */
  settings: Fact<readonly UserSetting[]>;
  /** What a version does with a key it does not know in the user file: ignore it, warn, or fail. */
  unknownKeys: Fact<'ignore' | 'warn' | 'fail'>;
  /** Whether a value the installed version cannot parse makes every command fail; depcurfew then needs the exact version. */
  invalidValueFails: Fact<boolean>;
  /** Values in the user file that weaken projects. */
  weakening: Fact<readonly UserWeakening[]>;
  /** Environment variables that move or skip the user file or override settings. */
  variables: Fact<readonly UserVariable[]>;
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
  /** Package managers only: the user-level configuration (`--user`). */
  user?: UserConfigKnowledge;
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
  /** Options whose value names the package to download in place of the first argument. */
  packageOptions: readonly string[];
  /** Options whose value names a package to download besides the one the first argument names. */
  extraPackageOptions?: readonly string[];
  /** Options whose value is a shell command line that runs with the downloaded packages. */
  lineOptions?: readonly string[];
  /** Flags that make the first argument a shell command line instead of a package. */
  shellOptions?: readonly string[];
  /** false when the first argument is the command to run, not a package (uv run): only package options name packages. */
  packageArgument?: boolean;
  /** A first argument with one of these endings is a script: a local one names no package; a URL is downloaded. */
  scriptSuffixes?: readonly string[];
  /** A first argument that is an http or https URL is a script to download and run. */
  scriptUrls?: boolean;
  /** The package may be followed by /<binary>, which picks one of its executables and is not part of its name (deno x npm:typescript/tsc). */
  binaryPath?: boolean;
}

/** How a tool reads its options. A fact of its own (`parsing`) next to the command-line fact adds to these. */
export interface CommandLineParsing {
  /**
   * A long option may be shortened to any prefix that names one option (optparse, argparse, nopt). The scanner
   * resolves a prefix to any option only when the tool lists all of its flags (`flagOptions`); otherwise only to an
   * option that changes the registry or the configuration file.
   */
  abbreviations?: boolean;
  /** Short options may be grouped (-Uq) and the last may carry its value in the same word (-ivalue). */
  groupedShortOptions?: boolean;
  /** Any number of leading dashes names the same option: -registry, --registry and ---registry (nopt). */
  anyDashes?: boolean;
  /** An option starting with this prefix is a negated flag and never takes a value (nopt: --no-save). */
  negation?: string;
  /**
   * Words that stand for other options, without their dashes (nopt shorthands): reg is --registry. A word made only
   * of one-letter shorthands (-gD) stands for each of them, and an unambiguous prefix of a shorthand for the shorthand.
   */
  shorthands?: Readonly<Record<string, readonly string[]>>;
  /** An option starting with this prefix sets the setting named after it, as the option of that name does (pnpm: --config.registry=…). */
  settingPrefix?: string;
}

/**
 * Options and environment variables that turn a per-package choice on or off. Variables come first, then the
 * options in the order written; a later one wins, and a package named on its own wins over :all:.
 */
export interface SelectionSwitches {
  /** Flags that turn it on, or off, for every package. */
  onFlags?: readonly string[];
  offFlags?: readonly string[];
  /** Options whose value is a comma-separated list of packages to turn it on, or off, for; :all: is every package and :none: empties the list. */
  onLists?: readonly string[];
  offLists?: readonly string[];
  /** In lists, true stands for :all: and false for :none: (Poetry). */
  listBooleans?: boolean;
  /** Options whose value names packages to turn it on for. */
  onPackages?: readonly string[];
  /** Options whose value is a mode: one of onModes turns it on for every package, one of offModes off, any other mode leaves the default. */
  modeOptions?: readonly string[];
  /** Options whose value is PACKAGE=MODE, with the modes of modeOptions. */
  packageModeOptions?: readonly string[];
  onModes?: readonly string[];
  offModes?: readonly string[];
  /** Variables: a boolean that turns it on for every package, lists as onLists and offLists, packages separated by spaces, or a mode. */
  flagVariables?: readonly string[];
  onListVariables?: readonly string[];
  offListVariables?: readonly string[];
  onPackageVariables?: readonly string[];
  modeVariables?: readonly string[];
}

/** How a Python tool's command line chooses pre-releases and building from source, which change what is installed. */
export interface PythonSelectionKnowledge {
  /** On: pre-releases may be picked; off: never. Left at the default, PEP 440 applies (only when asked for or nothing else fits). */
  prereleases: SelectionSwitches;
  /** On: the package is built from source even when it has wheels, which runs its build code; off: wheels only. */
  buildFromSource: SelectionSwitches;
  /** Commands that read these options differently; their switches replace the ones above. */
  commands?: readonly { command: readonly string[]; prereleases?: SelectionSwitches; buildFromSource?: SelectionSwitches }[];
}

/** How npm picks the version of a package named without one, or with a range. */
export interface NpmVersionSelectionKnowledge {
  /** The option, variable (without regard to case) and .npmrc key of the dist-tag npm prefers. */
  tagOption: string;
  tagVariable: string;
  tagKey: string;
  /** The range a name without a version stands for. */
  bareRange: string;
}

/** Options that only some commands of a tool have, or that mean something else in its other commands. */
export interface CommandOptions {
  command: readonly string[];
  /** Options of this command followed by a separate value. */
  valueOptions: readonly string[];
  /** Options of this command whose value is a local path or VCS URL installed in editable mode. */
  editableOptions?: readonly string[];
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
  createNames?: 'prefix' | 'prefix-unless-prefixed';
  /** Commands that run another command of the same tool in a workspace, after the given number of operands. */
  workspaceCommands?: readonly { command: readonly string[]; operands: number }[];
  /** Options of the add commands after which the arguments are local files, so no package is named. */
  fileOptions?: readonly string[];
  /**
   * Options of the add commands (or of every command) followed by a separate value; other options are flags. Empty
   * when listed in a fact of its own. Package options of run and create commands are listed with those commands only.
   */
  valueOptions: readonly string[];
  /** Options that stand alone, for tools that accept abbreviated long options: an exact name is never a prefix. */
  flagOptions?: readonly string[];
  /** How options are read; left out, only whole option names with = or a separate value are read. */
  parsing?: CommandLineParsing;
  /** Options of the add commands whose value names a package to install as well. */
  addPackageOptions?: readonly string[];
  /** Options whose value is a local path or VCS URL installed in editable mode. */
  editableOptions?: readonly string[];
  /** Package options whose value is a list of requirements separated by commas. */
  commaSeparatedOptions?: readonly string[];
  /** Run commands take a first argument with one of these names (and a version) for an interpreter, not a package. */
  interpreterNames?: readonly string[];
  /** Options that differ between the commands of the tool. */
  commandOptions?: readonly CommandOptions[];
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

/** How the Python interpreter runs a module (python -m pip) or a command string. */
export interface PythonInterpreterKnowledge {
  /** Executable names; versioned names such as python3.12 are the same. */
  executables: readonly string[];
  /** Runs the named module as a script; the options end there. */
  moduleOption: string;
  /** Runs a command string; the options end there. */
  commandOption: string;
  /** Other options followed by a separate value. */
  valueOptions: readonly string[];
  /**
   * One-letter options may be grouped after one dash (-Im pip): flags, then perhaps an option with a value, which is
   * the rest of the word or the next word.
   */
  groupedShortOptions: boolean;
}

/** How poetry add reads name@constraint (and uv tool commands name@version). */
export interface PoetryConstraintsKnowledge {
  /** Between the name (with extras) and the constraint. */
  separator: string;
  /** In place of a constraint: the newest release. */
  latest: string;
  /** Prefix of a constraint that keeps the left-most non-zero part of major.minor.patch. */
  caret: string;
  /** Prefix of a constraint that allows patch changes, or minor changes when only a major version is given. */
  tilde: string;
  /** Any version alone, or after a version prefix (1.*). */
  any: string;
}

/** The JSON form of the simple repository API of a Python package index (PEP 691, PEP 700, PEP 792). */
export interface PypiIndexKnowledge {
  /** Base URL; a project's page is the normalized name followed by a slash. */
  url: string;
  /** Accept header that asks for the JSON form. */
  accept: string;
  /** Status of a project the index does not know. */
  notFoundStatus: number;
  /** Key of the list of distribution files, and the keys of a file. */
  filesField: string;
  filenameField: string;
  /** ISO 8601 upload time in UTC; optional, since API version 1.1. */
  uploadTimeField: string;
  /** true or a reason string when the file is yanked. */
  yankedField: string;
  /** Key of the list of all versions of the project, since API version 1.1. */
  versionsField: string;
  /** Key of the project status object, its status and its reason, since API version 1.4. */
  statusField: string;
  statusValueField: string;
  statusReasonField: string;
}

/** Project status markers (PEP 792): which mean that no file may be downloaded, and which installers may warn about. */
export interface ProjectStatusKnowledge {
  /** The index offers no file of the project. */
  blocked: readonly string[];
  /** Installers may warn about the project. */
  warned: readonly string[];
}

/** Claude Code hooks that run before a tool call and can block it (used by depcurfew check --hook claude-code). */
export interface ClaudeCodeHooksKnowledge {
  /** Project settings file that can be committed. */
  settingsFile: string;
  event: string;
  /** Separates the tool names of a matcher that lists several, each matched exactly. */
  matcherSeparator: string;
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

/** A Claude Code tool that runs shell commands, by the name a matcher and the event use, and the shell it runs them in. */
export interface ClaudeCodeShellTool {
  tool: string;
  shell: 'bash' | 'powershell';
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

export interface GitIgnoreKnowledge {
  /** The per-directory pattern file, e.g. .gitignore. */
  file: string;
  /** The repository's own pattern file, relative to the working tree. */
  excludeFile: string;
  /** The index, whose entries are the tracked files. */
  indexFile: string;
  /** Whether a pattern also hides a file git already tracks (it does not). */
  trackedFilesIgnored: boolean;
}

/** npm's shims for the programs of packages on Windows. */
export interface CommandShimsKnowledge {
  /** The files written next to each program (besides a sh script). */
  extensions: readonly string[];
  /** The shim cmd.exe runs, which passes its arguments on with `argumentsVariable`, so they are read once more. */
  batchExtension: string;
  argumentsVariable: string;
}

/** The git setting that makes .gitignore patterns and index lookups ignore case. */
export interface GitIgnoreCaseKnowledge {
  /** The repository's configuration file, relative to the working tree. */
  configFile: string;
  section: string;
  key: string;
  /** Values read as true (case-insensitive); a key without a value is true too. */
  trueValues: readonly string[];
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
  pypiIndex: {
    api: Fact<PypiIndexKnowledge>;
    projectStatus: Fact<ProjectStatusKnowledge>;
  };
  claudeCode: {
    hooks: Fact<ClaudeCodeHooksKnowledge>;
    /** The tools whose PreToolUse events carry a shell command in the hooks fact's input.command. */
    shellTools: Fact<readonly ClaudeCodeShellTool[]>;
  };
  git: {
    /** Where git reads the patterns of files it does not pick up, and the index that lists the tracked files. */
    ignore: Fact<GitIgnoreKnowledge>;
    ignoreCase: Fact<GitIgnoreCaseKnowledge>;
  };
  windows: {
    commandShims: Fact<CommandShimsKnowledge>;
    /** Files whose arguments PowerShell hands to cmd.exe as a raw command line. */
    batchArguments: Fact<{ extensions: readonly string[] }>;
  };
  python: {
    /** How Python package names are compared: lowercased, with every run of these characters replaced by `replacement`. */
    nameNormalization: Fact<{ separators: string; replacement: string }>;
    /** Python package names: ASCII letters and digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
    namePattern: Fact<string>;
    /** The project file of a Python project, whose [tool.<name>] tables hold tool settings. */
    projectFile: Fact<string>;
    /** The file extension of a wheel, a built distribution that installs without running package code. */
    wheelExtension: Fact<string>;
    /** File extensions of source distributions on an index, which are built when installed. */
    sourceDistributionExtensions: Fact<readonly string[]>;
    interpreter: Fact<PythonInterpreterKnowledge>;
    /** Hatch, which has no supply-chain settings of its own: how a project shows it uses Hatch. */
    hatch: Fact<{ pyprojectTable: string; configFile: string }>;
  };
}
