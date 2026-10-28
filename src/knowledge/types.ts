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

export interface ToolKnowledge {
  id: ToolId;
  name: string;
  kind: ToolKind;
  cooldown: CooldownKnowledge;
  installScripts: InstallScriptsKnowledge;
  /** Package managers only: bots do not resolve dependency sources themselves. */
  sources?: SourcesKnowledge;
  /** Further sourced facts that matter for generators and `doctor`, keyed by a short name. */
  extra?: Readonly<Record<string, Fact<unknown>>>;
}
