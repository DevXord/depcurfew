// What depcurfew apply reports besides the changes: warnings (something of the policy is not applied, or applied
// with a side effect) and errors (nothing is written). Every one has a stable code for programs and AI agents
// (apply --json) and the README lists them; the message says what happened and `fix` what to do.
import type { ToolId } from '../knowledge/types.ts';

export const APPLY_WARNINGS = {
  'nothing-to-configure': 'depcurfew found no supported package manager or bot, so nothing is configured.',
  'depcurfew-outdated': 'The project installs a newer depcurfew than the one running, which may not know settings that version writes.',
  'file-unreadable': 'A file that shows which tools a project uses cannot be read or parsed (too large, a symlink out of the repository, no read permission, invalid), so depcurfew may configure fewer tools than the project uses.',
  'tool-not-supported': 'A detected tool is not supported (Yarn Classic), so nothing is written for it.',
  'tool-only-in-ci': 'A tool appears only in a CI setup step, with no manifest, lockfile or configuration in the repository, so targets "auto" does not configure it.',
  'version-not-pinned': 'No exact version of a package manager is pinned, so depcurfew configures for the latest version it knows.',
  'version-too-old': 'The pinned version of a tool lacks a setting the policy needs, so that setting is not written.',
  'cooldown-not-written': 'The release-age delay cannot be written for a tool.',
  'cooldown-shortened': 'A release-age delay set outside depcurfew\'s markers (in JSON files also one an earlier apply wrote) is longer than the policy, and apply replaces it with the shorter one.',
  'cooldown-environment-only': 'pip reads no project configuration, so the release-age delay has to be set in the environment where pip runs.',
  'exclude-pattern-unsupported': 'A cooldown exception uses a wildcard the tool does not support, so it is not written.',
  'exclude-unsupported': 'The tool has no setting for cooldown exceptions, so the release-age delay applies to every package.',
  'allow-pattern-unsupported': 'An installScripts.allow entry is a pattern, but the tool takes package names only, so it is not written.',
  'allow-all-unsupported': 'The tool has no setting that allows every install script, so installScripts "allow" is not written.',
  'allow-all-replaced': 'A setting that allowed every install script was replaced, because the policy denies install scripts.',
  'allow-list-entry-outside-policy': 'An install-script allow-list in the repository lets a package run scripts the policy does not allow; apply does not remove it.',
  'built-in-list-replaced': "Bun's built-in list of trusted packages is replaced by the policy's allow-list.",
  'scripts-not-enforceable': 'The pinned npm or pnpm runs every install script and has no allow-list, so "deny" cannot be enforced.',
  'before-overrides-cooldown': 'before= in .npmrc takes the place of the release-age delay apply writes, or makes npm stop with an error next to it.',
  'exact-version-gap': 'The pinned pnpm skips the release-age delay for packages requested by exact version.',
  'source-not-enforceable': 'The tool has no setting for a dependency source the policy denies; doctor checks the lockfile instead.',
  'source-switch-indirect-only': 'The pnpm setting for git and tarball sources stops them only for indirect dependencies.',
  'source-switch-combined': 'One pnpm setting covers git and tarball sources, so denying one denies both.',
  'forced-source-build': 'Python packages on the allow-list are always built from source, because no tool can only allow a build.',
  'build-switch-scope': "The tool's switch forbids building only packages from an index; git, local and archive dependencies are still built.",
  'build-switch-install-only': 'Poetry applies its build switch when installing; poetry lock may still build source distributions.',
  'build-switch-environment-only': 'The tool has no project setting that forbids building from source, so it has to be set in the environment where the tool runs.',
  'requirements-file-missing': 'There is no requirements file to write pip options into.',
  'manifest-missing': 'A setting belongs in a project manifest (package.json, deno.json, pyproject.toml, Pipfile) that does not exist, and apply does not create manifests.',
  'lockfile-out-of-date': 'The lockfile records, or is checked against, a setting apply changed, so it has to be locked again.',
  'file-ignored-by-git': 'A file apply writes matches a .gitignore rule, so the change may never reach the repository.',
  'bot-config-missing': 'A bot has no configuration file, and depcurfew does not create one.',
  'bot-config-not-edited': 'A bot configuration file is in a place or format depcurfew does not edit; a snippet shows what to add.',
  'bot-entries-missing': 'The Dependabot configuration has no entries for the package managers in use.',
  'security-delay-unsupported': 'Dependabot cannot delay security updates, so securityUpdates "delay" is not applied.',
} as const satisfies Record<string, string>;

export const APPLY_ERRORS = {
  'cannot-edit': 'A file cannot be read or edited safely (invalid syntax, a symlink, a style depcurfew does not edit), so nothing is written.',
  'cannot-write': 'A file cannot be written (no permission, a read-only file system, a full disk, a directory or symlink in its place); the files already written are put back, so nothing changes.',
  'policy-missing': 'The directory has no depcurfew.json.',
  'policy-invalid': 'depcurfew.json does not follow the schema; issues lists the problems.',
  'policy-unreadable': 'depcurfew.json cannot be read.',
  'policy-exists': 'depcurfew init found a depcurfew.json and writes it only with --force.',
  'directory-not-found': 'The directory given on the command line does not exist or cannot be opened.',
  'not-a-directory': 'The path given on the command line is a file, not a directory.',
} as const satisfies Record<string, string>;

export type ApplyWarningCode = keyof typeof APPLY_WARNINGS;
export type ApplyErrorCode = keyof typeof APPLY_ERRORS;

export interface ApplyWarning {
  code: ApplyWarningCode;
  /** The tool it concerns, when there is one. */
  tool?: ToolId;
  /** The file it concerns, when there is one, and the line when it is known. */
  location?: { file: string; line?: number };
  /** What happened, for people; it starts with the tool's name when it concerns one. */
  message: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

/** A warning as one line of text, as ApplyReport.warnings has it. */
export function warningText(warning: ApplyWarning): string {
  return warning.fix === undefined ? warning.message : `${warning.message}. ${warning.fix}`;
}
