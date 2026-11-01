// What depcurfew apply reports besides the changes: warnings (something of the policy is not applied, or applied
// with a side effect) and errors (nothing is written). Every one has a stable code for programs and AI agents
// (apply --json) and the README lists them; the message says what happened and `fix` what to do.
import type { ToolId } from '../knowledge/types.ts';

export const APPLY_WARNINGS = {
  'nothing-to-configure': 'depcurfew found no supported package manager or bot, so nothing is configured.',
  'environment-overrides': 'apply --user: an environment variable makes a tool read another user file or none, or overrides a value apply writes there.',
  'depcurfew-outdated': 'The project installs a newer depcurfew than the one running, which may not know settings that version writes.',
  'file-unreadable': 'A file that shows which tools a project uses cannot be read or parsed (too large, a symlink out of the repository, no read permission, invalid), so depcurfew may configure fewer tools than the project uses.',
  'tool-not-supported': 'A detected or installed tool is not supported (Yarn Classic), so nothing is written for it.',
  'target-not-found': 'With projects, a package manager listed under targets is configured in each directory (the root or a project) that uses it, and none uses it, so nothing is written for it.',
  'tool-only-in-ci': 'A tool appears only in a CI setup step, with no manifest, lockfile or configuration in the repository, so targets "auto" does not configure it.',
  'version-not-pinned': 'No exact version of a package manager is pinned, so depcurfew configures for the latest version it knows.',
  'version-too-old': 'The pinned version of a tool (with apply --user, the installed one) lacks a setting the policy needs, so that setting is not written.',
  'version-unknown': 'apply --user: the installed version of a tool cannot be read from its files, and a value it does not understand would stop every command, so nothing is written for it.',
  'no-user-config': 'apply --user: the tool has no user-level configuration file, so nothing is written for it.',
  'user-setting-project-only': 'apply --user: the tool reads a part of the policy only from project files, so it is not written into the user file.',
  'user-directory-relative': 'apply --user: the environment variable that names the directory of the user file (XDG_CONFIG_HOME, APPDATA) is a relative path, so the tool looks in another place from each directory, or where it looks then is not known; nothing is written for it.',
  'user-file-uncertain': 'apply --user: a library the tool calls decides where its user file is (platformdirs for Poetry and PDM on macOS), and its version cannot be read from files, so apply --user writes where the tool\'s docs say and names the other files the tool may read.',
  'user-setting-overridden': 'apply --user: a file the tool reads ahead of its user file (~/.npmrc for pnpm 10) sets a key apply writes there to another value, so the value written has no effect.',
  'version-not-used': 'apply --user: --for gives the version of a tool that apply --user does not configure (not in PATH with targets "auto", or not listed under targets).',
  'cooldown-not-written': 'The release-age delay cannot be written for a tool.',
  'cooldown-shortened': 'A release-age delay set outside depcurfew\'s markers (in JSON files also one an earlier apply wrote) is longer than the policy, and apply replaces it with the shorter one.',
  'cooldown-environment-only': 'pip reads no project configuration, so the release-age delay has to be set in the environment where pip runs.',
  'exclude-pattern-unsupported': 'A cooldown exception uses a wildcard the tool does not support, so it is not written.',
  'exclude-unsupported': 'The tool has no setting for cooldown exceptions, so the release-age delay applies to every package.',
  'allow-pattern-unsupported': 'An installScripts.allow entry is a pattern, but the tool takes package names only, so it is not written.',
  'deny-pattern-unsupported': 'An installScripts.deny entry is a pattern, but the tool records denials by package name only, so it is not written.',
  'allow-all-unsupported': 'The tool has no setting that allows every install script, so installScripts "allow" is not written.',
  'allow-all-replaced': 'A setting that allowed every install script (with any value the tool reads as true, also one that a YAML merge key brings in, or pnpm 10\'s dangerously-allow-all-builds in .npmrc) was set to false, because the policy denies install scripts.',
  'allow-list-entry-outside-policy': 'An install-script allow-list in the repository (with apply --user, in a user file) lets a package run scripts the policy does not allow; apply does not remove it.',
  'deny-conflicts-with-file': "An entry in a tool's own list lets a package of installScripts.deny run its install scripts, or blocks a package of installScripts.allow; apply does not change entries it did not write.",
  'unexpected-value': 'A setting apply adds to has a value of a type the tool does not accept there, so apply leaves it as it is and writes nothing into it.',
  'built-in-list-replaced': "Bun's built-in list of trusted packages is replaced by the policy's allow-list.",
  'scripts-not-enforceable': 'The pinned (with apply --user, the installed) npm or pnpm, or another npm the repository runs (one a declared Node.js comes with, or a CI job or Dockerfile installs), runs every install script and has no allow-list, so "deny" cannot be enforced.',
  'strict-allow-scripts-for-npm-in-use': 'An npm the repository runs (the pinned one, one a CI job or Dockerfile installs, or one a declared Node.js comes with, for a project also through the root version files and root Dockerfiles that build it) is 11.16 to 11.x and runs install scripts the allow-list does not cover unless strict-allow-scripts is set, so apply writes strict-allow-scripts=true, which makes npm 12 stop the install at such a script; not given when that npm is the pinned one and no place runs npm 12.',
  'before-overrides-cooldown': 'before= in .npmrc takes the place of the release-age delay apply writes, or makes npm stop with an error next to it (apply --user then does not write the delay).',
  'exact-version-gap': 'The pinned (with apply --user, the installed) pnpm skips the release-age delay for packages requested by exact version.',
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
  usage: 'The command line is not valid: an unknown command or option, a missing or extra argument, or options that cannot go together (exit code 2); with --json the document holds only schemaVersion and this error.',
  'project-not-found': 'A directory listed in projects in depcurfew.json does not exist, so nothing is written.',
  'project-not-a-directory': 'A path listed in projects in depcurfew.json is a file, not a directory, so nothing is written.',
  'project-symlink': 'A directory listed in projects in depcurfew.json is a symlink or lies under one, which may lead out of the repository, so nothing is written.',
  'project-has-policy': 'A directory listed in projects has a depcurfew.json of its own, a second policy for the same files, so nothing is written.',
  'project-in-workspace': 'A directory listed in projects is, holds or lies in a workspace package of the repository root, which the root configuration already covers, so nothing is written.',
  'home-missing': 'apply --user and init --user: the home directory (HOME, USERPROFILE on Windows) does not exist or is not an absolute path, so nothing is written.',
} as const satisfies Record<string, string>;

export type ApplyWarningCode = keyof typeof APPLY_WARNINGS;
export type ApplyErrorCode = keyof typeof APPLY_ERRORS;

export interface ApplyWarning {
  code: ApplyWarningCode;
  /** The directory listed in projects that the warning concerns; absent for the repository root. */
  project?: string;
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
