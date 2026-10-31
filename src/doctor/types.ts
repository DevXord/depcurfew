import type { Repository } from '../detect/repository.ts';
import type { Detection } from '../detect/types.ts';
import type { ToolKnowledge } from '../knowledge/types.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';

/** The SARIF levels: an error fails `doctor`, warnings and notes do not. */
export type Level = 'error' | 'warning' | 'note';

export interface Location {
  /** Repository-relative path with `/` separators. */
  file: string;
  /** 1-based; absent when the finding concerns the whole file. */
  line?: number;
  /** doctor --user: the environment variable, as it is set, of a finding whose file is "environment". */
  variable?: string;
}

export interface Finding {
  rule: string;
  level: Level;
  message: string;
  location: Location;
  /** A fix for this finding; the rule's general help applies when absent. */
  fix?: string;
}

/** Something doctor could not check, such as an unreadable file. Not a problem in the repository itself. */
export interface Notice {
  message: string;
  file?: string;
}

export interface RuleContext {
  root: string;
  repository: Repository;
  detection: Detection;
  /** undefined when the repository has no depcurfew.json. */
  policy: ResolvedPolicy | undefined;
  tools: readonly ToolKnowledge[];
  report(finding: Omit<Finding, 'rule' | 'level'> & { level?: Level }): void;
  notice(message: string, file?: string): void;
}

export interface Rule {
  /** Stable kebab-case identifier, used in SARIF and in the documentation. */
  id: string;
  /** One sentence: what the rule finds. */
  summary: string;
  /** Why it matters. */
  description: string;
  /** How to fix it in general. */
  help: string;
  /** Default level of its findings. */
  level: Level;
  /** Rules that compare the repository with depcurfew.json do not run without one. */
  requiresPolicy: boolean;
  check(context: RuleContext): void;
}

/** A package manager or bot doctor checked, with the version it checked against when one is known. */
export interface CheckedTool {
  id: string;
  name: string;
  version?: string;
  /** Where the version comes from: a repository file, or PATH for doctor --user. */
  versionFrom?: string;
}

/** What doctor looked at, shown below the result, so that a clean report says what it covers. */
export interface Checked {
  tools: CheckedTool[];
  /** Files that were read, repository-relative (doctor) or as shown (~/.npmrc, doctor --user). */
  files: string[];
  /** Rules that ran. */
  rules: string[];
  /** Rules that did not run because they compare with a policy and there is none (or it is invalid). */
  skippedRules: string[];
  /** The policy those rules need, as messages show it. */
  policyFile: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  /** invalid: depcurfew.json does not follow the schema or cannot be read (only with invalidPolicy: 'report'). */
  policy: 'valid' | 'missing' | 'invalid';
  findings: Finding[];
  notices: Notice[];
  /** What was checked. */
  checked?: Checked;
}
