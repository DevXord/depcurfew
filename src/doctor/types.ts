import type { Repository } from '../detect/repository.ts';
import type { Detection } from '../detect/types.ts';
import type { PlanOptions } from '../apply/index.ts';
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
  /**
   * Set when the rules run on a directory listed in projects in depcurfew.json (decision D-100): its path relative to
   * the repository root. `root`, `repository` and `detection` are then the project's, and file names relative to it.
   */
  project?: string;
  /**
   * At the repository root: the directories listed in projects that could be read, for the rules that compare the
   * bots, which are configured from the root, with the package managers of every project.
   */
  projects?: readonly ProjectView[];
  /** How apply plans this directory, for the rules that compare with that plan (config-drift). */
  plan?: PlanOptions;
}

/** A directory listed in projects, as the rules at the repository root see it. */
export interface ProjectView {
  /** Relative to the repository root, as listed. */
  directory: string;
  /** The absolute path. */
  root: string;
  repository: Repository;
  detection: Detection;
}

/** What a rule may look at to decide whether it concerns the project: the context without the reporting functions. */
export type RuleScope = Omit<RuleContext, 'report' | 'notice'>;

export interface Rule {
  /** Stable kebab-case identifier, used in SARIF and in the documentation. */
  id: string;
  /** One sentence: what the rule finds. */
  summary: string;
  /** What the rule checks, said as what holds when it passes, for the list of what doctor checked. */
  checks?: string;
  /** Why it matters. */
  description: string;
  /** How to fix it in general. */
  help: string;
  /** Default level of its findings. */
  level: Level;
  /** Rules that compare the repository with depcurfew.json do not run without one. */
  requiresPolicy: boolean;
  /**
   * Whether the rule concerns the project at all, from detection: the Python rules without a Python tool, the bot rules
   * without a bot. false shows the rule as "not applicable" in the list of what doctor checked (decision D-098). It
   * never changes findings: check still runs, and a rule that reports one has problems. Absent: it always applies.
   */
  applies?(scope: RuleScope): boolean;
  check(context: RuleContext): void;
}

/** A package manager or bot doctor checked, with the version it checked against when one is known. */
export interface CheckedTool {
  id: string;
  name: string;
  /** The directory listed in projects the tool was found in; absent for the repository root. */
  project?: string;
  version?: string;
  /** Where the version comes from: a repository file, or PATH for doctor --user. */
  versionFrom?: string;
}

/** One check of the list of what doctor checked: a rule and what came of it. */
export interface RuleResult {
  rule: string;
  /** What the rule checks, in plain words (Rule.check). */
  check: string;
  /**
   * passed: it ran and found nothing; problems: it reported findings; skipped: it needs a policy that is missing or
   * invalid; not-applicable: it does not concern the project, e.g. a Python rule without a Python tool (decision D-098).
   */
  result: 'passed' | 'problems' | 'skipped' | 'not-applicable';
  errors: number;
  warnings: number;
  notes: number;
}

/** What doctor looked at, shown below the result, so that a clean report says what it covers. */
export interface Checked {
  tools: CheckedTool[];
  /** Files that were read, repository-relative (doctor) or as shown (~/.npmrc, doctor --user). */
  files: string[];
  /** Every rule, in the order it ran, with its result. */
  rules: RuleResult[];
  /** The policy that skipped rules need, as messages show it. */
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
