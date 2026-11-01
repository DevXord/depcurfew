# depcurfew

One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate and Dependabot, and a doctor that finds configuration that silently does nothing.

## Why

Package managers and update bots now each protect you against freshly published malicious versions: a release-age delay, an allow-list for install scripts, limits on git and tarball dependencies. Each tool names these settings differently, counts time in its own unit, reads them from its own files and supports them only from some version on. A setting can also look right and do nothing, for example because CI pins an older version of the package manager, or because a bot proposes versions the package manager would refuse.

depcurfew keeps one policy file, `depcurfew.json`, writes it into the configuration of every tool in the repository, and checks that the result really works.

## Five-minute start

1. `npx depcurfew init` writes `depcurfew.json` with the default policy below and lists the tools it detected. When the repository already sets a longer release-age delay for one of them, `cooldown.minimum` keeps the longest one, and `init` says where it found it.
2. `npx depcurfew explain` shows what it detected and what the policy means for each tool.
3. `npx depcurfew apply --dry-run` prints the changes as a diff, without writing anything.
4. `npx depcurfew apply` writes them. Run it again whenever `depcurfew.json` changes; a second run with the same policy changes nothing.
5. `npx depcurfew doctor` reports configuration that silently does not work and drift from the policy, and exits with 1 when it finds an error or, with the `"doctor": { "failOn": "warning" }` that `init` writes, a warning.
6. Add the [GitHub Action](#github-action) so that doctor runs on every push and reports to code scanning.

The default policy:

<!-- BEGIN GENERATED: default-policy -->
```json
{
  "$schema": "https://unpkg.com/depcurfew/schema.json",
  "version": 1,
  "cooldown": {
    "minimum": "3d",
    "exclude": [],
    "securityUpdates": "bypass"
  },
  "installScripts": {
    "default": "deny",
    "allow": [],
    "deny": []
  },
  "sources": {
    "git": "deny",
    "remoteTarball": "deny",
    "file": "allow",
    "directory": "allow"
  },
  "targets": "auto",
  "doctor": {
    "failOn": "warning"
  }
}
```
<!-- END GENERATED: default-policy -->

## Installation

depcurfew runs on Node.js 18.3.0 or later, so it also works where a project or a coding agent still has an older Node.js (CI runs every command on the oldest version it supports), and has a single runtime dependency, [`yaml`](https://github.com/eemeli/yaml). Node.js 18 and 20 no longer get security fixes from the Node.js project; prefer a supported line where you can. Working on depcurfew itself needs Node.js 22.18 or later.

Add it to the project as a development dependency, so the team, CI and coding agents all run the version pinned in the lockfile. Once `apply` has written the project's release-age delay, later updates of depcurfew go through that delay as well:

```bash
npm install --save-dev --save-exact depcurfew
npx dcf doctor
```

Pin the exact version (`--save-exact`, or `save-exact=true` in `.npmrc`) and update it on purpose: depcurfew is a young project with frequent releases, and a range would let a new release in without review.

Who needs it installed:

- **Developers working on the project:** nothing to do. The protection does not depend on depcurfew being installed: it lives in the package manager configuration that `apply` writes into the repository (`.npmrc`, `package.json`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml`, `deno.json`, `pyproject.toml` or `uv.toml`, `poetry.toml`, `Pipfile`, `requirements.txt` and the bot configuration), and the package managers read it on their own. pip's release-age delay is the exception: pip reads it only from the environment where it runs, and `apply` says what to set there. The project install brings depcurfew along as a development dependency anyway.
- **Whoever changes `depcurfew.json`:** runs `npx dcf apply` and commits the result.
- **CI:** runs `doctor`, with the GitHub Action below or with the project's own copy on other CI systems.

A global install (`npm install -g depcurfew`) works, but teams should not rely on it: each machine may run a different version, the lockfile does not pin it, and npm does not read the project's `.npmrc` in global mode, so the project's release-age delay does not cover the install.

To work on depcurfew itself, run it from a clone of this repository:

```bash
git clone https://github.com/DevXord/depcurfew.git
cd depcurfew
npm ci
npm run build
node dist/cli.js doctor /path/to/your/repository
```

## The policy file

Every section is optional: a section that is absent means depcurfew does not manage that area. Durations are converted to each tool's own unit and always rounded up, so a tool never waits less than the policy says. Where a tool cannot express part of the policy, depcurfew says so instead of skipping it silently.

<!-- BEGIN GENERATED: policy-fields -->
| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `version` |  |  | Version of the policy format. |
| `cooldown` |  |  | Release-age delay (cooldown): freshly published versions wait before they are used. |
| `cooldown.minimum` |  |  | Minimum age of a release before it is installed or proposed: a whole number followed by m (minutes), h (hours), d (days) or w (weeks). Converted to each tool's unit, always rounding up. |
| `cooldown.exclude` |  | `[]` | Packages that skip the release-age delay, e.g. your own scope. |
| `cooldown.securityUpdates` | `"bypass"`, `"delay"` | `"bypass"` | Whether security updates skip the delay ("bypass") or wait like other updates ("delay"), where the tool can tell them apart. |
| `installScripts` |  |  | Code that dependencies run when they are installed: lifecycle scripts in npm, building from source in Python. |
| `installScripts.default` | `"allow"`, `"deny"` |  | Whether dependency lifecycle scripts (preinstall, install, postinstall) run by default; for Python, whether packages may be built from source. |
| `installScripts.allow` |  | `[]` | Packages whose lifecycle scripts may run when the default is "deny"; Python packages listed here are always built from source. |
| `installScripts.deny` |  | `[]` | Packages you reviewed that work without their lifecycle scripts, so the scripts stay blocked on purpose and doctor does not report them, for example "fsevents", which ships a prebuilt binary. A package cannot be in both lists, also not through two patterns that match the same name. Python packages listed here must not be built from source: doctor reports a tool that would still build one. |
| `sources` |  |  | Where dependencies may come from besides the registry. An absent field is not managed. |
| `sources.git` | `"allow"`, `"deny"` |  | Dependencies installed from git repositories. |
| `sources.remoteTarball` | `"allow"`, `"deny"` |  | Dependencies installed from tarball URLs outside the registry. |
| `sources.file` | `"allow"`, `"deny"` |  | Dependencies installed from local tarball files. |
| `sources.directory` | `"allow"`, `"deny"` |  | Dependencies installed from local directories. |
| `targets` |  | `"auto"` | Tools to configure: "auto" detects them in the repository, or list them explicitly. |
| `projects` |  | `[]` | Directories of independent projects in this repository, each with its own manifest and lockfile (e.g. frontend and backend). depcurfew configures each one with this policy as a project of its own, and configures Renovate and Dependabot once, from the repository root, for all of them. The repository root is always configured as well. A project must not be inside another one, must not be a workspace package of the root and must not have a depcurfew.json of its own. |
| `doctor` |  |  | How depcurfew doctor and the GitHub Action treat findings. Without this section only errors fail, as before; depcurfew init writes "failOn": "warning". |
| `doctor.failOn` | `"error"`, `"warning"` | `"error"` | Which findings make depcurfew doctor exit with 1 and fail the GitHub Action: "error" (only errors) or "warning" (warnings too). Notes never fail. doctor --fail-on and the input fail-on of the Action override it. |
<!-- END GENERATED: policy-fields -->

`doctor.failOn` decides which findings make `depcurfew doctor` exit with 1 and fail the GitHub Action: `"error"` only errors, `"warning"` warnings too; notes, which say what doctor could not check, never fail. `depcurfew init` writes `"warning"`, so a new repository stays free of warnings. A policy without the `doctor` section fails on errors only, as before, so an existing `depcurfew.json` keeps its exit codes. `doctor --fail-on error` or `--fail-on warning` and the input `fail-on` of the Action override it for one run; an invalid `depcurfew.json` counts as `"error"` (it fails doctor anyway, as `invalid-policy`). The user policy takes the same section for `doctor --user`.

### Several projects in one repository

A repository can hold independent projects side by side, each in its own directory with its own manifest and lockfile, often with nothing in the root but the bot configuration:

```text
.github/dependabot.yml   updates entries for /frontend and /backend
depcurfew.json           "projects": ["frontend", "backend"]
frontend/                package.json, package-lock.json
backend/                 pyproject.toml, uv.lock
```

List those directories under `projects`, relative to the repository root with `/` between directories (no patterns, no `..`, no `/` at either end). `apply`, `doctor` and `explain` then treat each listed directory as a project of its own with the policy of the root: its own `.npmrc`, lockfiles and workspaces, as if the command ran there. The root is configured as before. Renovate and Dependabot are configured once, from the repository root, where they read their configuration, and wait at least as long as the package manager of any project (in the example, npm rounds `36h` up to 2 days, so every Dependabot entry gets `default-days: 2`). Every path in the output is relative to the root (`frontend/.npmrc`), and all files of all projects are written or none. A `renovate.json` or `.github/dependabot.yml` inside a project is never read by the bot, so `doctor` gives a note at it instead of comparing its delay (and says so when the root has no configuration of that bot at all), and "What was checked" marks it as not read; a project that the Dependabot configuration of the root leaves out while it updates other projects gets a warning.

What the root gives a project, for the npm it runs: the CI jobs of the root that install in its directory (`working-directory: frontend`); the `.nvmrc`, `.node-version` and `.tool-versions` of the root (nvm, nodenv and asdf use those files in subdirectories too), each unless the project has a file of the same kind, because each tool reads only its own file: with `frontend/.nvmrc`, asdf still uses the root `.tool-versions` in `frontend`; and the stages of a root Dockerfile that copy files only from that project (`COPY frontend/package.json frontend/package-lock.json ./`). Copy sources are read as Docker reads them, from the root of the build context with `.` and `..` resolved (`COPY frontend/../ .` copies the whole context, `/frontend/x` is `frontend/x`). A stage that copies `.` or files of several directories is the root's, because it is not clearly a build of one project. Volta, `devEngines` and `engines` in the root `package.json` do not count for a project, which has a `package.json` of its own. `explain` lists, for each project, the root version files and root Dockerfile stages it uses (`fromRoot` in `--json`).

An npm depcurfew cannot tell (a Node.js version newer than the releases it knows, an image pinned only by digest, a version it cannot read) counts as one that runs every dependency install script: `apply` warns with `scripts-not-enforceable` and `doctor` reports packages with install scripts as errors, so an unknown npm never passes for one that blocks them. The npm of every Node.js release down to 0.6.3 is known from `nodejs.org/dist/index.json`; every release before 18.0.0 comes with npm 8 or older.

`depcurfew init` in a root without a manifest or lockfile lists the direct subdirectories that have one, except one with a `depcurfew.json` of its own, which it names and leaves out. A listed directory that does not exist, is a file, is reached through a symlink, has a `depcurfew.json` of its own or overlaps a workspace package of the root is an error (`project-not-found`, `project-not-a-directory`, `project-symlink`, `project-has-policy`, `project-in-workspace`) at the line of its entry in `depcurfew.json`: `apply` writes nothing, `explain` shows it and exits with 1, and `doctor` reports it as `invalid-project`. With a list of `targets`, each listed package manager is configured only in the directories that use it. `check` and the Claude Code hook find the `depcurfew.json` of the root from a project directory, as from any subdirectory of the repository.

## Commands

The package installs two names for the same command: `depcurfew` and the short `dcf`, so `dcf doctor` works like `depcurfew doctor`.

| Command | What it does |
| --- | --- |
| `depcurfew init [directory] [--force]` | Writes `depcurfew.json` with the default policy (keeping a longer release-age delay the repository already sets); `--force` overwrites an existing one. |
| `depcurfew explain [directory] [--json]` | Describes the detected package managers, versions, bots and workspaces, and what the policy means for each tool: the release-age delay, and the settings `apply` writes for `installScripts` and `sources`, or why a tool cannot enforce them. |
| `depcurfew apply [directory] [--dry-run] [--json]` | Writes the policy into the configuration of every target tool; `--dry-run` prints a unified diff instead, `--json` the result as JSON. |
| `depcurfew doctor [directory] [--json \| --sarif] [--fail-on error\|warning]` | Finds configuration that silently does not work and drift from the policy; `--sarif` prints SARIF 2.1.0 for code scanning, and `--fail-on` overrides `doctor.failOn` of the policy (`--strict` is `--fail-on warning`). |
| `depcurfew check <package...> [--json] [--dir <directory>] [--registry <url>] [--index <url>]` | Checks packages against the policy before you install them: see [Guarding installs](#guarding-installs). |
| `depcurfew check --hook claude-code` | The same check as a Claude Code hook that blocks install commands breaking the policy. |
| `depcurfew mcp [--dir <directory>] [--registry <url>] [--index <url>]` | The same check as tools of a Model Context Protocol server, for AI agents in Claude Desktop, VS Code and other clients: see [MCP server](#mcp-server). |
| `depcurfew init --user [--force]` | Writes the user policy, which `--user` uses: see [Protecting the whole machine](#protecting-the-whole-machine). |
| `depcurfew apply --user [--dry-run] [--json] [--for <tool@version>]` | Writes the user policy into the user-level configuration of the installed package managers. |
| `depcurfew doctor --user [--json \| --sarif] [--fail-on error\|warning] [--for <tool@version>]` | Checks that configuration against the user policy, and the environment variables that override it. |

Without a directory, `explain`, `apply` and `doctor` work on the nearest directory with `depcurfew.json`, from the current directory up to the root of the repository (the directory with `.git`), and say so when that is a parent directory (outside a git repository only the current directory counts, and on Linux and macOS a parent directory counts only when it belongs to you and others cannot write to it, because a shared parent such as `/tmp` may hold someone else's `depcurfew.json`; directories inside `node_modules` are skipped), so `doctor` run in a subdirectory does not pass for a project without a policy. A directory given on the command line is used as it is. `check` looks for `depcurfew.json` the same way, starting in `--dir`.

Exit codes: `0` success (warnings included, except for `doctor` when warnings fail it), `1` an error (an invalid or unreadable policy, a directory in `projects` that cannot be used, a file that cannot be edited or written, a doctor finding with level error, or also one with level warning when `doctor.failOn` in `depcurfew.json` (with `--user` the user policy) or `--fail-on` is `warning`, which `--strict` means too; notes never fail), `2` a usage error (such as an unknown option or a directory that does not exist). `depcurfew <command> --help` describes a command with examples and its exit codes.

Every finding and warning says what to do about it. When a command cannot start, it says why with a code (`directory-not-found`, `not-a-directory`, `policy-missing`, `policy-invalid`, `policy-unreadable`, and for `init` also `policy-exists` and `cannot-write`) and what to do; with `--json` that is a document with `errors` on stdout, and `doctor --sarif` prints a run marked as not successful. Text for people is colored on a terminal; `NO_COLOR=1` turns colors off and `FORCE_COLOR=1` turns them on, for example in a CI log that shows them. Control characters in names and values from the repository or a registry are shown as text (ESC as `\x1b`, or as `\u001b` inside a quoted value such as a package name in the problems of `depcurfew.json`), so a crafted package or file name cannot change the terminal. `--json`, `--sarif` and a diff written to a file stay plain, for programs and AI agents.

The `--json` documents of all commands share these fields: `schemaVersion` (1), `policy` (its status in `apply` and `doctor`, the path of the `depcurfew.json` used in `check`, its values in `explain`), `notices` (such as the parent directory whose `depcurfew.json` was used) and `errors`, the reasons a command could not start, each with `code`, `level`, `location.file`, `message` and `fix`, and `issues` for `policy-invalid`. A usage error with `--json` (an unknown option, `check` without a package, `--json` with `--sarif`) prints a document with only `schemaVersion` and `errors`, with the code `usage` and no location, and exits with 2. The warnings of `explain` have `code`, `level`, `location` (when they concern one file), `message`, `files` and `fix`. Paths are relative to the directory the command works on (a directory that does not exist is named as given). A `depcurfew.json` that cannot be used is an error with the same code, message and fix in `apply`, `check` and `explain`, which also keeps it in `policy`; `doctor` reports it as the finding `invalid-policy`, so that it reaches code scanning too, and counts it in `summary.error`. Within a `schemaVersion` fields and values are only added; a field is removed or changes its meaning only with a new `schemaVersion`.

`explain` shows, for each tool in the policy section (and for each directory listed in `projects`), what `installScripts` and `sources` mean there, from the same plan `apply` makes: the settings `apply` writes with their files, or the warning `apply` gives when the tool cannot enforce a part, with its code and what to do. The text has one line per tool and part, `nothing to write` when `apply` writes nothing there and has nothing to say, and `not managed` when the policy has no such section:

```text
  installScripts deny, allow esbuild:
    <tool>: <setting> and <setting> in <file>, <setting> in <file>; warning: <message> (<code>); fix: <what to do>
  sources git deny:
    <tool>: nothing written; warning: <tool> has no setting for git dependencies, so "deny" cannot be enforced (source-not-enforceable); fix: <what to do>
```

In `explain --json`, `policy.installScripts` holds `default`, `allow`, `deny` and `tools`, `policy.sources` the sources the policy sets and `tools`, and each entry of `projects` has `installScripts` and `sources` with `tools` (each `null` when the policy has no such section). Each entry of `tools` has `tool`, `settings` (`setting`, `file`, and `table` for a TOML table) and `warnings`, the warnings of `apply --json` about that part for the tool. A setting that `apply` writes only to correct a value (`allow-all-replaced`) is listed only while the file still needs that correction.

How `apply` edits files:

- It keeps comments, formatting, line endings and key order. In line-based files (INI, TOML) it writes a block between `# >>> depcurfew managed block` and `# <<< depcurfew managed block` markers and comments out older copies of the settings it manages (they come back when the policy stops managing them); in YAML it marks the keys it writes with `# managed by depcurfew`; JSON files keep their comments and indentation.
- It reads files the way the tool does. In YAML files of a tool whose loader applies merge keys (`<<: *defaults` in `pnpm-workspace.yaml` and pnpm's `config.yaml`), a setting a merge key brings in counts, and `apply` writes its value into the map itself, which wins over merged keys; `.yarnrc.yml` and `dependabot.yml` are read without merging. A switch that allows every install script counts as on for every value the tool does not read as off: pnpm runs every build script for `dangerouslyAllowAllBuilds: "false"` (a string) or `yes`, and npm and pnpm 10 for `=1` or `=yes` in `.npmrc`.
- It never removes settings it does not manage. Allow-lists are only added to; exception lists follow the policy, except the entries Renovate adds to pnpm's exception list for security updates, which stay with their comment. An entry in a tool's own install-script list that contradicts `installScripts` (it lets a package of `installScripts.deny` run its scripts, or blocks one of `installScripts.allow`) stays as it is, with the warning `deny-conflicts-with-file`, and `apply` records no denial for that package.
- When it replaces a longer release-age delay someone set by hand with the policy's shorter one, it warns (`cooldown-shortened`) and names the `cooldown.minimum` that keeps it.
- If any file cannot be edited, nothing is written. If a file cannot be written, the files already written are put back.
- It does not create bot configuration files or project manifests (`package.json`, `deno.json`, `pyproject.toml`, `Pipfile`, `requirements.txt`); it creates a package manager's configuration file when it is missing. A package manager seen only in a CI setup step, with nothing of it in the repository, is not configured under `targets: "auto"`.
- It warns when a file it writes is ignored by git (`.gitignore` or `.git/info/exclude`), because the change would then stay on one machine.

### apply warnings and errors

Each warning and error of `apply` has a code. The text output shows it in parentheses after the message, with what to do on the next line, like a doctor finding. `depcurfew apply --json` (also with `--dry-run`) prints one JSON document and nothing on stderr: `changes` (each file with its action and unified diff), `warnings` and `errors` (each with `code`, `level`, `message` and `fix`; `tool` when it concerns one tool; `location` when it concerns one file, with `file` and, when known, `line`; for an invalid policy also `issues`), `snippets` to add by hand, `notices` (such as the parent directory whose `depcurfew.json` was used) and `written`. A run that writes nothing because of an error lists no changes and exits with 1. Diffs, on the terminal, in a pipe and in `changes`, show the values of secrets as `<redacted>` (`_authToken`, `_auth` and `_password` in `.npmrc`, keys ending in `token` or `password`, the user and password of a URL), so that a diff can be shared or logged; the files keep them. The text diff also shows control and bidirectional characters from the files as text (`\x1b`, `‮`), so that a value cannot drive the terminal or a CI log; `changes` keeps them, escaped by JSON.

<!-- BEGIN GENERATED: apply-codes -->
Warnings:

- `nothing-to-configure`: depcurfew found no supported package manager or bot, so nothing is configured.
- `environment-overrides`: apply --user: an environment variable makes a tool read another user file or none, or overrides a value apply writes there.
- `depcurfew-outdated`: The project installs a newer depcurfew than the one running, which may not know settings that version writes.
- `file-unreadable`: A file that shows which tools a project uses cannot be read or parsed (too large, a symlink out of the repository, no read permission, invalid), so depcurfew may configure fewer tools than the project uses.
- `tool-not-supported`: A detected or installed tool is not supported (Yarn Classic), so nothing is written for it.
- `target-not-found`: With projects, a package manager listed under targets is configured in each directory (the root or a project) that uses it, and none uses it, so nothing is written for it.
- `tool-only-in-ci`: A tool appears only in a CI setup step, with no manifest, lockfile or configuration in the repository, so targets "auto" does not configure it.
- `version-not-pinned`: No exact version of a package manager is pinned, so depcurfew configures for the latest version it knows.
- `version-too-old`: The pinned version of a tool (with apply --user, the installed one) lacks a setting the policy needs, so that setting is not written.
- `version-unknown`: apply --user: the installed version of a tool cannot be read from its files, and a value it does not understand would stop every command, so nothing is written for it.
- `no-user-config`: apply --user: the tool has no user-level configuration file, so nothing is written for it.
- `user-setting-project-only`: apply --user: the tool reads a part of the policy only from project files, so it is not written into the user file.
- `user-directory-relative`: apply --user: the environment variable that names the directory of the user file (XDG_CONFIG_HOME, APPDATA) is a relative path, so the tool looks in another place from each directory, or where it looks then is not known; nothing is written for it.
- `user-file-uncertain`: apply --user: a library the tool calls decides where its user file is (platformdirs for Poetry and PDM on macOS), and its version cannot be read from files, so apply --user writes where the tool's docs say and names the other files the tool may read.
- `user-setting-overridden`: apply --user: a file the tool reads ahead of its user file (~/.npmrc for pnpm 10) sets a key apply writes there to another value, so the value written has no effect.
- `version-not-used`: apply --user: --for gives the version of a tool that apply --user does not configure (not in PATH with targets "auto", or not listed under targets).
- `cooldown-not-written`: The release-age delay cannot be written for a tool.
- `cooldown-shortened`: A release-age delay set outside depcurfew's markers (in JSON files also one an earlier apply wrote) is longer than the policy, and apply replaces it with the shorter one.
- `cooldown-environment-only`: pip reads no project configuration, so the release-age delay has to be set in the environment where pip runs.
- `exclude-pattern-unsupported`: A cooldown exception uses a wildcard the tool does not support, so it is not written.
- `exclude-unsupported`: The tool has no setting for cooldown exceptions, so the release-age delay applies to every package.
- `allow-pattern-unsupported`: An installScripts.allow entry is a pattern, but the tool takes package names only, so it is not written.
- `deny-pattern-unsupported`: An installScripts.deny entry is a pattern, but the tool records denials by package name only, so it is not written.
- `allow-all-unsupported`: The tool has no setting that allows every install script, so installScripts "allow" is not written.
- `allow-all-replaced`: A setting that allowed every install script (with any value the tool reads as true, also one that a YAML merge key brings in, or pnpm 10's dangerously-allow-all-builds in .npmrc) was set to false, because the policy denies install scripts.
- `allow-list-entry-outside-policy`: An install-script allow-list in the repository (with apply --user, in a user file) lets a package run scripts the policy does not allow; apply does not remove it.
- `deny-conflicts-with-file`: An entry in a tool's own list lets a package of installScripts.deny run its install scripts, or blocks a package of installScripts.allow; apply does not change entries it did not write.
- `unexpected-value`: A setting apply adds to has a value of a type the tool does not accept there, so apply leaves it as it is and writes nothing into it.
- `built-in-list-replaced`: Bun's built-in list of trusted packages is replaced by the policy's allow-list.
- `scripts-not-enforceable`: The pinned (with apply --user, the installed) npm or pnpm, or another npm the repository runs (one a declared Node.js comes with, or a CI job or Dockerfile installs), runs every install script and has no allow-list, so "deny" cannot be enforced; also given for an npm the repository runs whose version depcurfew cannot tell, which counts as one that runs them.
- `strict-allow-scripts-for-npm-in-use`: An npm the repository runs (the pinned one, one a CI job or Dockerfile installs, or one a declared Node.js comes with, for a project also through the root version files and root Dockerfiles that build it) is 11.16 to 11.x and runs install scripts the allow-list does not cover unless strict-allow-scripts is set, so apply writes strict-allow-scripts=true, which makes npm 12 stop the install at such a script; not given when that npm is the pinned one and no place runs npm 12.
- `before-overrides-cooldown`: before= in .npmrc takes the place of the release-age delay apply writes, or makes npm stop with an error next to it (apply --user then does not write the delay).
- `exact-version-gap`: The pinned (with apply --user, the installed) pnpm skips the release-age delay for packages requested by exact version.
- `source-not-enforceable`: The tool has no setting for a dependency source the policy denies; doctor checks the lockfile instead.
- `source-switch-indirect-only`: The pnpm setting for git and tarball sources stops them only for indirect dependencies.
- `source-switch-combined`: One pnpm setting covers git and tarball sources, so denying one denies both.
- `forced-source-build`: Python packages on the allow-list are always built from source, because no tool can only allow a build.
- `build-switch-scope`: The tool's switch forbids building only packages from an index; git, local and archive dependencies are still built.
- `build-switch-install-only`: Poetry applies its build switch when installing; poetry lock may still build source distributions.
- `build-switch-environment-only`: The tool has no project setting that forbids building from source, so it has to be set in the environment where the tool runs.
- `requirements-file-missing`: There is no requirements file to write pip options into.
- `manifest-missing`: A setting belongs in a project manifest (package.json, deno.json, pyproject.toml, Pipfile) that does not exist, and apply does not create manifests.
- `lockfile-out-of-date`: The lockfile records, or is checked against, a setting apply changed, so it has to be locked again.
- `file-ignored-by-git`: A file apply writes matches a .gitignore rule, so the change may never reach the repository.
- `bot-config-missing`: A bot has no configuration file, and depcurfew does not create one.
- `bot-config-not-edited`: A bot configuration file is in a place or format depcurfew does not edit; a snippet shows what to add.
- `bot-entries-missing`: The Dependabot configuration has no entries for the package managers in use.
- `security-delay-unsupported`: Dependabot cannot delay security updates, so securityUpdates "delay" is not applied.

Errors (nothing is written):

- `cannot-edit`: A file cannot be read or edited safely (invalid syntax, a symlink, a style depcurfew does not edit), so nothing is written.
- `cannot-write`: A file cannot be written (no permission, a read-only file system, a full disk, a directory or symlink in its place); the files already written are put back, so nothing changes.
- `policy-missing`: The directory has no depcurfew.json.
- `policy-invalid`: depcurfew.json does not follow the schema; issues lists the problems.
- `policy-unreadable`: depcurfew.json cannot be read.
- `policy-exists`: depcurfew init found a depcurfew.json and writes it only with --force.
- `directory-not-found`: The directory given on the command line does not exist or cannot be opened.
- `not-a-directory`: The path given on the command line is a file, not a directory.
- `usage`: The command line is not valid: an unknown command or option, a missing or extra argument, or options that cannot go together (exit code 2); with --json the document holds only schemaVersion and this error.
- `project-not-found`: A directory listed in projects in depcurfew.json does not exist, so nothing is written.
- `project-not-a-directory`: A path listed in projects in depcurfew.json is a file, not a directory, so nothing is written.
- `project-symlink`: A directory listed in projects in depcurfew.json is a symlink or lies under one, which may lead out of the repository, so nothing is written.
- `project-has-policy`: A directory listed in projects has a depcurfew.json of its own, a second policy for the same files, so nothing is written.
- `project-in-workspace`: A directory listed in projects is, holds or lies in a workspace package of the repository root, which the root configuration already covers, so nothing is written.
- `home-missing`: apply --user and init --user: the home directory (HOME, USERPROFILE on Windows) does not exist or is not an absolute path, so nothing is written.
<!-- END GENERATED: apply-codes -->

## Protecting the whole machine

`depcurfew apply` protects one project. The user-level configuration of each package manager protects every project on the machine that does not set the same settings itself, and also what runs outside a project: `npx`, `uvx`, global installs, and a new project before anyone ran `apply` in it.

```bash
depcurfew init --user
depcurfew apply --user --dry-run
depcurfew apply --user
depcurfew doctor --user
```

- The user policy is `~/.config/depcurfew/depcurfew.json` (in `$XDG_CONFIG_HOME/depcurfew/` when that variable is set to an absolute path, in `%APPDATA%\depcurfew\` on Windows). It has the same format as a project policy; under `targets: "auto"` it configures the package managers found in `PATH`.
- depcurfew does not run other programs to learn their versions. It reads the version from the files next to the executable in `PATH`: the `package.json` of a tool installed from npm (also Yarn installed as `@yarnpkg/cli-dist`), the `.dist-info` folder of one installed from PyPI. A Yarn or pnpm shim of Corepack runs, outside a project, the version Corepack's `lastKnownGood.json` names (in `$COREPACK_HOME`, else `$XDG_CACHE_HOME/node/corepack`, else `~/.cache/node/corepack`; `%LOCALAPPDATA%\node\corepack` on Windows), and a `yarnPath` in `~/.yarnrc.yml` that points to a release named `yarn-<version>.cjs`, as `yarn set version` names it, gives Yarn's version; `doctor --user` says where each version came from. When it cannot, it configures for the latest version it knows and says so, except for tools that stop every command on a value their version does not understand (the last column below): for those it writes nothing until you pass the version, for example `--for uv@0.13.6`. Bun from its official installer (`~/.bun/bin/bun`, which writes no version file) or from Homebrew has no version depcurfew can read, so it needs `--for bun@<version>`.
- `init --user` keeps a longer release-age delay that the user files of the installed tools already set, as `init` does in a project: a delay of 7 days in `~/.npmrc` makes `cooldown.minimum` `7d`, and `init --user` says which setting, value, file and line it took. Deno reads the delay in `~/.npmrc` in whole days and ignores any other value, so `apply --user` writes it for Deno in days, rounded up.
- Poetry and PDM ask the library platformdirs where their user directory is, and on macOS the answer depends on the platformdirs version in the tool's environment (the rows below). depcurfew reads that version from the `platformdirs-<version>.dist-info` folder next to the tool's own; when it cannot and `XDG_CONFIG_HOME` or `XDG_DATA_HOME` would move the file, `apply --user` writes where the docs say (`~/Library/Application Support/...`) and warns with the other file (`user-file-uncertain`), and `doctor --user` checks both.
- `apply --user` writes the files of all tools or none, as `apply` does in a project: a user file it cannot read or edit (not UTF-8, a symlink, larger than 1 MiB, a file where its directory belongs) is an error that names it, such as `~/.config/pip/pip.conf`, with a fix for that problem, and a file that cannot be written puts back the ones already replaced. `init --user` and `apply --user` do not create a missing home directory, and when `XDG_CONFIG_HOME` or `%APPDATA%` is a relative path, `apply --user` writes nothing for the tools that may use it, with a warning (pip then reads `pip.conf` relative to the directory each command runs in). Run as root (`sudo` with `HOME` kept), they leave each file they replace to its owner, and give what they create in the home directory to the owner of the home directory.
- A key `apply --user` writes into a user file can be overridden by a file the tool reads ahead of it: pnpm 10 reads `~/.npmrc` before its `rc` file. `apply --user` warns about a different value there (`user-setting-overridden`) with the line, and `doctor --user` reports it.
- A tool's own project settings win over its user file for the same key. Parts of the policy that a tool reads only from project files, such as per-package allow-lists, are not written into the user file; `apply --user` names them, and `depcurfew apply` in the project writes them.
- A user file is edited as `apply` edits a project file: a setting the policy manages that is set by hand elsewhere in the file is commented out and comes back when the policy stops managing it (YAML files get the policy's value instead). That includes an exception list the policy leaves empty, the command sections of `pip.conf` such as `[install]`, and the `[pip]` table of `uv.toml`. Install-script allow-list entries that the policy does not allow are kept and reported; a longer delay that the policy shortens is reported.
- `doctor --user` reports a user file that does not match the user policy, values in user files that weaken every project, and environment variables that make a tool read another file, no file or other values, such as a relative `XDG_CONFIG_HOME`. It reads values as each tool does: a switch that allows every install script is on for every value the tool does not read as off (`dangerously-allow-all-builds=1` in `~/.npmrc` for pnpm 10), and a merge key (`<<: *defaults`) counts in pnpm's `config.yaml`. A missing home directory, or a user file it cannot read, is an error rather than a clean report, and an installed tool too old for settings the user policy needs (npm 10 has no release-age delay and no install-script allow-list) is a warning that says what stays unprotected and which version to update to.
- Tools that record the release-age delay in their lockfile may lock differently on a machine whose user file sets one than on a machine without it; set the same delay in the project with `depcurfew apply` so that every machine and CI agree.

<!-- BEGIN GENERATED: user-config -->
| Tool | User file | Settings `apply --user` writes (versions that read them there) | Needs the exact version |
| --- | --- | --- | --- |
| npm | Linux, macOS: `~/.npmrc`<br>Windows: `%HOME%\.npmrc` (when it is an absolute path), else `~\.npmrc` | `min-release-age` (11.10.0+), `min-release-age-exclude` (11.17.0+), `strict-allow-scripts` (11.16.0+), `allow-scripts` (11.16.0+), `allow-git` (11.10.0+), `allow-remote` (11.15.0+), `allow-file` (11.15.0+), `allow-directory` (11.15.0+) | no |
| pnpm | Linux: `$XDG_CONFIG_HOME/pnpm/rc`, else `~/.config/pnpm/rc`<br>macOS: `$XDG_CONFIG_HOME/pnpm/rc`, else `~/Library/Preferences/pnpm/rc`<br>Windows: `%XDG_CONFIG_HOME%\pnpm\rc`, else `%LOCALAPPDATA%\pnpm\config\rc`, else `~\.config\pnpm\rc`<br>11.0.0+: Linux: `$XDG_CONFIG_HOME/pnpm/config.yaml`, else `~/.config/pnpm/config.yaml`<br>macOS: `$XDG_CONFIG_HOME/pnpm/config.yaml`, else `~/Library/Preferences/pnpm/config.yaml`<br>Windows: `%XDG_CONFIG_HOME%\pnpm\config.yaml`, else `%LOCALAPPDATA%\pnpm\config\config.yaml`, else `~\.config\pnpm\config.yaml` | `minimum-release-age` (10.16.0–11.0.0), `minimum-release-age-exclude` (10.16.0–11.0.0), `only-built-dependencies` (10.0.0–11.0.0), `strict-dep-builds` (10.3.0–11.0.0), `block-exotic-subdeps` (10.26.0–11.0.0), `minimumReleaseAge` (11.0.0+), `minimumReleaseAgeExclude` (11.0.0+), `minimumReleaseAgeStrict` (11.0.0+), `strictDepBuilds` (11.0.7+), `blockExoticSubdeps` (11.0.0–12.0.0) | yes |
| Yarn (Berry) | Linux, macOS, Windows: `~/.yarnrc.yml` | `npmMinimalAgeGate` (4.10.2+), `npmPreapprovedPackages` (4.10.0+), `enableScripts` (4.0.0+), `approvedGitRepositories` (4.14.0+) | yes |
| Bun | Linux, macOS, Windows: `$XDG_CONFIG_HOME/.bunfig.toml` (when it is an absolute path), else `~/.bunfig.toml` | `install.minimumReleaseAge` (1.3.0+), `install.minimumReleaseAgeExcludes` (1.3.0+) | yes |
| Deno | 1.45.0+: Linux, macOS, Windows: `~/.npmrc` | `min-release-age` (2.8.0+) | no |
| uv | Linux, macOS: `$XDG_CONFIG_HOME/uv/uv.toml` (when it is an absolute path), else `~/.config/uv/uv.toml`<br>Windows: `%APPDATA%\uv\uv.toml`, else `~\AppData\Roaming\uv\uv.toml` | `exclude-newer` (0.9.17+), `exclude-newer-package` (0.9.25+), `no-build` (0.2.12+), `no-build-package` (0.2.12+), `no-binary-package` (0.2.12+) | yes |
| pip | Linux: `$XDG_CONFIG_HOME/pip/pip.conf`, else `~/.config/pip/pip.conf`<br>macOS: `~/Library/Application Support/pip/pip.conf` (when the folder exists), else `~/.config/pip/pip.conf`<br>Windows: `%APPDATA%\pip\pip.ini`, else `~\AppData\Roaming\pip\pip.ini`<br>26.2.0+: Linux: `$XDG_CONFIG_HOME/pip/pip.conf`, else `~/.config/pip/pip.conf`<br>macOS: `$XDG_DATA_HOME/pip/pip.conf` (when the folder exists), else `~/Library/Application Support/pip/pip.conf` (when the folder exists and $XDG_DATA_HOME is not set), else `~/.config/pip/pip.conf`<br>Windows: `%APPDATA%\pip\pip.ini`, else `~\AppData\Roaming\pip\pip.ini` | `uploaded-prior-to` (26.1.0+), `only-binary` (7.1.0+), `no-binary` (7.1.0+) | yes |
| Poetry | 2.0.0+: Linux: `$XDG_CONFIG_HOME/pypoetry/config.toml`, else `~/.config/pypoetry/config.toml`<br>macOS: `~/Library/Application Support/pypoetry/config.toml`<br>Windows: `%APPDATA%\pypoetry\config.toml`, else `~\AppData\Roaming\pypoetry\config.toml`<br>macOS with platformdirs before 4.6.0: `~/Library/Application Support/pypoetry/config.toml`<br>macOS with platformdirs 4.6.0–4.9.6: `$XDG_CONFIG_HOME/pypoetry/config.toml`, else `$XDG_DATA_HOME/pypoetry/config.toml`, else `~/Library/Application Support/pypoetry/config.toml`<br>macOS with platformdirs 4.9.6–4.11.8: `$XDG_CONFIG_HOME/pypoetry/config.toml`, else `~/Library/Application Support/pypoetry/config.toml`<br>macOS with platformdirs 4.11.8+: `$XDG_CONFIG_HOME/pypoetry/config.toml` (when it is an absolute path), else `~/Library/Application Support/pypoetry/config.toml` | `solver.min-release-age` (2.4.0+), `solver.min-release-age-exclude` (2.4.0+), `installer.only-binary` (2.0.0+), `installer.no-binary` (1.2.0+) | no |
| PDM | Linux: `$XDG_CONFIG_HOME/pdm/config.toml`, else `~/.config/pdm/config.toml`<br>macOS: `~/Library/Application Support/pdm/config.toml`<br>Windows: `~\AppData\Local\pdm\pdm\config.toml`<br>macOS with platformdirs before 4.6.0: `~/Library/Application Support/pdm/config.toml`<br>macOS with platformdirs 4.6.0–4.9.6: `$XDG_CONFIG_HOME/pdm/config.toml`, else `$XDG_DATA_HOME/pdm/config.toml`, else `~/Library/Application Support/pdm/config.toml`<br>macOS with platformdirs 4.9.6–4.11.8: `$XDG_CONFIG_HOME/pdm/config.toml`, else `~/Library/Application Support/pdm/config.toml`<br>macOS with platformdirs 4.11.8+: `$XDG_CONFIG_HOME/pdm/config.toml` (when it is an absolute path), else `~/Library/Application Support/pdm/config.toml` | `strategy.exclude-newer` (2.27.0+) | yes |
| Pipenv | none | none | no |
<!-- END GENERATED: user-config -->

### doctor --user rules

<!-- BEGIN GENERATED: user-rules -->
### `user-policy-invalid`

**error** · The user policy does not follow the schema or cannot be read.

Without a valid user policy (~/.config/depcurfew/depcurfew.json), doctor --user cannot compare the user-level configuration with it, so only the checks that need no user policy run, as when there is none.

Fix: Fix what the message lists, or write a new user policy with depcurfew init --user --force.

### `user-config-unreadable`

**error** · A user-level configuration file cannot be read, parsed or edited, or the home directory does not exist, so depcurfew cannot check it.

The package manager may still read the file (or stop on it), and its settings may weaken every project on the machine; doctor --user fails closed and reports an error instead of passing silently. Without a home directory the user files of most tools cannot be found at all.

Fix: Do what the fix of the finding says: fix invalid syntax, give read permission, replace a symlink apply --user does not write through, make a file smaller than 1 MiB, or set HOME to an existing directory.

### `user-config-drift`

**warning** · needs depcurfew.json · A user-level configuration file does not match the user policy.

depcurfew apply --user writes the user policy (~/.config/depcurfew/depcurfew.json) into the user-level configuration of each installed tool, which protects every project on the machine that does not set the same settings itself, and npx, uvx and global installs. A file that no longer matches leaves that protection weaker than the policy.

Fix: Run depcurfew apply --user.

### `user-config-weakens`

**warning** · A user-level configuration file has a value that weakens every project that does not set it itself.

Settings in the user-level configuration apply to every project that does not set the same key, and some apply even then (lists that tools merge across files). A value that turns the release-age delay off, exempts packages or allows install scripts or git dependencies there weakens all of them at once, and so does a file the tool reads ahead of the user file.

Fix: Remove the value from the file, or set it in the policy and run depcurfew apply --user.

### `user-environment-overrides`

**warning** · An environment variable moves, skips or overrides the user-level configuration or the policy.

Package managers read settings from environment variables before their configuration files, and some variables make them read another file or none. A variable set in a shell profile or a CI runner can switch the protection off without any file showing it.

Fix: Unset the variable, or set it to a value the policy allows.
<!-- END GENERATED: user-rules -->

## Supported tools

What depcurfew configures and checks for each tool, from its [knowledge base](https://github.com/DevXord/depcurfew/blob/main/docs/knowledge.md), where every value links to the official documentation or changelog it was verified against.

<!-- BEGIN GENERATED: tools -->
| Tool | Release-age delay | Exceptions | Install-script allow-list (Python: packages built from source) | Dependency sources | Verified |
| --- | --- | --- | --- | --- | --- |
| npm | `min-release-age` in `.npmrc` (days), since 11.10.0 | `min-release-age-exclude`, since 11.17.0 | `allowScripts` in `package.json` | git: `allow-git`<br>remote tarball: `allow-remote`<br>local tarball: `allow-file`<br>local directory: `allow-directory` | 2026-10-28 – 2026-11-01 |
| pnpm | `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes), since 10.16.0 | `minimumReleaseAgeExclude`, since 10.16.0 | `allowBuilds` in `pnpm-workspace.yaml` | git: `blockExoticSubdeps`<br>remote tarball: `blockExoticSubdeps` | 2026-10-28 – 2026-11-01 |
| Yarn (Berry) | `npmMinimalAgeGate` in `.yarnrc.yml` (minutes), since 4.10.2 | `npmPreapprovedPackages`, since 4.10.0 | `dependenciesMeta.<package>.built` in `package.json` | git: `approvedGitRepositories` | 2026-10-28 – 2026-11-01 |
| Bun | `install.minimumReleaseAge` in `bunfig.toml` (seconds), since 1.3.0 | `install.minimumReleaseAgeExcludes`, since 1.3.0 | `trustedDependencies` in `package.json` | none | 2026-10-28 – 2026-11-01 |
| Deno | `minimumDependencyAge` in `deno.json`, `.npmrc` (minutes), since 2.5.5 / 2.6.0 ⚠️ | `minimumDependencyAge.exclude`, since 2.5.5 | `allowScripts` in `deno.json` | none | 2026-10-28 – 2026-11-01 |
| uv | `exclude-newer` in `uv.toml`, `pyproject.toml` (duration string), since 0.9.17 | `exclude-newer-package`, since 0.9.25 | `no-binary-package` in `pyproject.toml` | none | 2026-10-30 – 2026-10-31 |
| pip | `uploaded-prior-to` on the command line or in the environment (no project file) (days), since 26.1.0 | none | `--no-binary` in `requirements.txt` | none | 2026-10-30 – 2026-10-31 |
| Poetry | `solver.min-release-age` in `poetry.toml` (days), since 2.4.0 | `solver.min-release-age-exclude`, since 2.4.0 | `installer.no-binary` in `poetry.toml` | none | 2026-10-30 – 2026-11-01 |
| PDM | `exclude-newer` in `pyproject.toml` (duration string), since 2.26.9 | `exclude-newer-override`, since 2.29.1 | `no-binary` in `pyproject.toml` | none | 2026-10-30 – 2026-11-01 |
| Pipenv | `cool-down-period` in `Pipfile` (duration string), since 2026.6.2 | none | none | none | 2026-10-30 – 2026-10-31 |
| Renovate | `minimumReleaseAge` in `renovate.json`, `renovate.jsonc` … (duration string), since 35.46.0 | `packageRules: matchPackageNames + minimumReleaseAge: null`, since 35.46.0 ❓ | none | n/a | 2026-10-28 – 2026-11-01 |
| Dependabot | `cooldown` in `.github/dependabot.yml`, `.github/dependabot.yaml` (days), since 2025 07 01 | `cooldown.exclude`, since 2025 07 01 ❓ | none | n/a | 2026-10-28 – 2026-11-01 |

⚠️ official sources disagree (depcurfew takes the safer reading) · ❓ official sources are incomplete. Every value with its source: [docs/knowledge.md](https://github.com/DevXord/depcurfew/blob/main/docs/knowledge.md).
<!-- END GENERATED: tools -->

Yarn Classic (1.x) is detected but not supported.

**Where Node.js and Python come from.** `doctor` also reads the files that choose the runtime: `.nvmrc`, `.node-version`, `engines.node`, Volta, `.tool-versions`, `devEngines.runtime`, `actions/setup-node` in workflows (with `node-version-file` and matrix values), and Dockerfiles (`Dockerfile`, `*.Dockerfile`, `Dockerfile.<name>` and `Containerfile` in the root, in direct subdirectories without a manifest of their own and in workspace packages, with `FROM node:<tag>` or `FROM python:<tag>`). An unpinned npm is the one that comes with that Node.js: Node.js 22 comes with npm 10, which ignores the release-age setting without a warning. With `installScripts.default: "deny"`, `apply` writes `strict-allow-scripts=true` when any of these places runs npm 11.16 to 11.x (the pinned npm, an npm a CI job or Dockerfile installs, or the npm of a declared Node.js), also when another place runs npm 12, and says what that means for npm 12; `doctor` offers the setting with "which depcurfew apply writes" only where `apply` does. `manager-version-too-old` reports such a runtime where its npm (or the pip of the official `python` image) lacks a setting in use, unless the CI job or the build stage installs another one first (`npm install -g npm@<version>`, `pip install pip==<version>`), and `runtime-end-of-life` reports Node.js lines past their end of life. `depcurfew explain` lists what it found.

### Python projects

depcurfew configures uv, Poetry, PDM, Pipenv and pip from the same `depcurfew.json`, and the bots for Python packages: Dependabot `pip` and `uv` entries and Renovate.

- **Detection.** A Python tool counts as used when its lockfile is there, when `pyproject.toml` has its table, or when its own configuration file or a CI setup step shows it; `requirements.txt` means pip. `depcurfew explain` lists what it found.
- **Package names.** Python packages on the policy's package lists (the cooldown exceptions, `installScripts.allow` and `installScripts.deny`) take the prefix `pypi:`, for example `"pypi:docopt"`. Names without a prefix stay npm names, so an exception for an npm package never applies to a Python package of the same name.
- **Install scripts are builds.** A wheel installs without running package code; a source distribution, a git repository or a local directory is built, which runs its build code. `installScripts.default: "deny"` forbids building, and the packages in `installScripts.allow` are the exceptions. None of the three tools can only allow a build, so these packages are always built from source, even where a wheel exists; `apply` says so, and `doctor` lists the packages in the lockfile that would be built. Packages in `installScripts.deny` must not be built: `doctor` reports one that a tool would still build (Poetry, PDM, pip and Pipenv build git, local and URL dependencies whatever their settings say), and one without wheels that cannot be installed while building is blocked.
- **pip reads no project configuration.** `apply` writes the build options into `requirements.txt`. The release-age delay cannot live in the project, so `apply` prints the environment variable to set where pip runs. `doctor` also checks the files a requirements file includes with `-r` and `-c`, and reports an include it cannot read.
- **Lock again after `apply`.** `uv.lock` records the release-age delay, and PDM checks `pdm.lock` against all of its resolution settings, the delay and the build ban included. After `apply` changes them, `uv sync --locked` and `uv lock --check` fail until you run `uv lock`, and `pdm lock --check` and `pdm install --check` until you run `pdm lock`; `apply` says so (`lockfile-out-of-date`). `poetry.lock` and `Pipfile.lock` do not depend on the settings `apply` writes.
- **PDM and Pipenv cannot pin their own version.** `apply` configures for the latest version depcurfew knows and names that version (`version-not-pinned`). Pipenv takes the delay in whole days only (rounded up), has no exceptions and no project setting that forbids building; `apply` says what to set where Pipenv runs instead. `doctor` reads `pdm.lock` and `Pipfile.lock`, and reports settings that turn the delay or the build ban off without a word: Pipenv's pure-Python resolver and PDM's uv mode.
- **Hatch has no settings of its own.** Its environments install with uv or pip, so a Hatch project is covered by the uv configuration (add `"uv"` to `targets` when its environments use the uv installer) or by the environment variables of pip.
- **Running depcurfew.** depcurfew is a Node.js program. In a project without `package.json`, run a pinned version with `npx --yes depcurfew@<version>`; in CI the [GitHub Action](#github-action) needs nothing else.

## doctor rules

Findings have a level: an **error** makes `depcurfew doctor` exit with 1, a **warning** does too when `doctor.failOn` in `depcurfew.json` or `--fail-on` is `warning` (the policy of `depcurfew init` sets it; without it a warning does not), and a **note** never does. When warnings make doctor fail, the line under the counts says where that was set, with how to fail on errors only, and `--json` has `failOn` (`error` or `warning`), `failOnFrom` (`option`, `policy` or `default`) and `strict` (`true` when warnings fail). Things doctor could not check (a binary lockfile, a lockfile format without install-script data, a missing policy) are listed as notes after the findings, not as findings. Below them, doctor says what it checked: the package managers and bots it found with the version it checked against, the files it read and every check with what it checks and its result, `passed`, the problems it found, `skipped` when it needs a policy, or `not applicable` when it does not concern the project, such as the Python checks without a Python tool or the bot checks without an update bot (`checked` in `--json`, where the result is `passed`, `problems`, `skipped` or `not-applicable`).

<!-- BEGIN GENERATED: rules -->
### `invalid-policy`

**error** · depcurfew.json does not follow the schema or cannot be read.

Without a valid policy, the rules that compare the repository with depcurfew.json cannot run, so doctor runs only the rules that need no policy, as when there is no policy file.

Fix: Fix what the message lists; an editor that reads the $schema of depcurfew.json shows the problems as you type.

### `invalid-project`

**error** · needs depcurfew.json · A directory listed in projects in depcurfew.json does not exist, is not a directory, is a symlink, has a depcurfew.json of its own or overlaps a workspace package of the root.

depcurfew checks and configures each listed directory as a project of its own. A directory that is missing or misspelled is never checked, so its package managers keep whatever configuration they have; one with a depcurfew.json of its own would follow two policies, and a workspace package of the root is configured with the root already. depcurfew apply writes nothing while one of them is listed.

Fix: Correct or remove the entry in projects, or remove the depcurfew.json of the project.

### `depcurfew-outdated`

**warning** · The project installs a newer depcurfew than the one running.

A global install or an old cached copy may not know settings, rules or tool versions that the version pinned in the project knows, so it can miss problems or report fixed ones. The project copy is read from node_modules or package-lock.json.

Fix: Run the project's copy of depcurfew (install the project's dependencies first when only package-lock.json pins it), or update the one you run.

### `manager-version-too-old`

**error** · A declared package manager version, or the npm or pip that comes with a declared Node.js or Python version, is older than a setting the repository relies on.

Package managers ignore settings they do not know yet; npm 10 does not even warn. When packageManager, devEngines, Volta, .tool-versions, a CI step or a Dockerfile pins an older version, the setting is silently not applied there. The same holds for the npm that comes with the Node.js a CI job, a Dockerfile stage or a version file (.nvmrc, .node-version) chooses, and for the pip of a python image: Node.js 22 comes with npm 10, which has no min-release-age.

Fix: Raise the declared version to at least the version that introduced the setting, everywhere it is declared, or install a newer npm or pip before installing packages.

### `runtime-end-of-life`

**warning** · A declared Node.js version is past its end of life.

After its end of life a Node.js release line gets no more releases, security fixes included. A version file, CI step or Dockerfile that only allows such lines keeps running an unpatched Node.js, and an older npm with it.

Fix: Move to a Node.js line that is still supported, in every place that declares the version.

### `setting-ignored-by-version`

**error** · A setting or file is ignored by the package manager version in use.

Package managers drop old settings and files in new major versions and only accept new forms from some version on. The configuration stays in the repository and looks effective while the version in use ignores it.

Fix: Move the setting to the place and form this version reads.

### `npmrc-overrides-policy`

**error** · An .npmrc file changes a security setting in a way the policy does not see, or is ignored.

Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages and the keys below a [section] header, and a before date in .npmrc takes the place of min-release-age; pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy, and dangerously-allow-all-builds there runs every build script while pnpm-workspace.yaml has no build settings of its own.

Fix: Keep security settings out of .npmrc files that are ignored or that override the policy; set them through depcurfew.json and depcurfew apply.

### `pnpm-shared-workspace-lockfile`

**warning** · pnpm 10 without a shared lockfile lets a package .npmrc change the release-age delay.

With sharedWorkspaceLockfile: false, pnpm 10 installs every workspace project separately with that project's own .npmrc layered over the workspace settings (read from the pnpm 10 source code), so a setting such as minimum-release-age=0 in a package .npmrc applies to that package.

Fix: Remove security settings from package .npmrc files, or keep the default shared lockfile.

### `python-config-ignored`

**error** · A Python tool ignores a setting where it is written.

uv reads uv.toml instead of [tool.uv] when both exist, and in a workspace only the root; pip reads no configuration from the project and rejects options it does not know in requirements files; PDM in uv mode installs without only-binary; Pipenv with resolver_backend = "pure-python" locks without cool-down-period. A setting in such a place looks effective but is not, and an exclude-newer date freezes dependencies instead of delaying new versions.

Fix: Move the setting to the file the tool reads.

### `config-drift`

**error** · needs depcurfew.json · A configuration file does not match what depcurfew apply writes for depcurfew.json.

A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy. Entries in a tool's own install-script lists that apply does not change are reported as well: one that lets a package of installScripts.deny run its scripts is an error, like the differences depcurfew apply fixes, and one that lets a package the policy does not name run them, or that blocks a package the policy allows, is a warning.

Fix: Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.

### `bot-cooldown-mismatch`

**error** · An update bot waits less than the package manager before proposing a new version.

The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile. A Dependabot cooldown with an include list delays only the dependencies it names, and a Renovate packageRules entry can shorten the delay for a whole registry or update type. With projects in depcurfew.json, a bot configuration file inside a project gets a note, because the bot reads its configuration only from the repository root, and a project that the Dependabot configuration of the root leaves out while it updates other projects gets a warning.

Fix: Give the bot a delay at least as long as the package manager's (depcurfew apply does this).

### `broad-exclusion`

**error** · An exception list matches every package, or a per-scope setting shortens the delay, which turns the protection off.

A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies. The same goes for a Renovate packageRules entry that turns minimumReleaseAge off for a whole datasource, for major, minor or patch updates of every package, or with only negative patterns, which match every package they do not name. In Yarn 4.17 and later, npmScopes.<scope>.npmMinimalAgeGate replaces the delay for one scope, so a shorter value there exempts that scope.

Fix: Replace the pattern with the packages or scopes that really need the exception.

### `lockfile-forbidden-source`

**error** · needs depcurfew.json · The lockfile installs a package from a source depcurfew.json denies.

A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.

Fix: Replace the dependency with a registry version, or allow that source in depcurfew.json.

### `lockfile-install-scripts`

**error** · needs depcurfew.json · The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.

Install scripts run arbitrary code during installation, and so does building a Python package from source (a source distribution, a git repository or a local directory). Where the package manager runs them by default, or an entry in its own allow-list lets them run, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. A package in installScripts.deny was reviewed and works without its scripts, so it is reported only while the package manager still runs them (or builds it from source), or when it cannot be installed without a build. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile; uv.lock, poetry.lock, pdm.lock and pylock.toml show which Python packages have no wheel. pip requirements files and Pipfile.lock list hashes only, so the check does not apply to their packages from an index (depcurfew check pypi:<name> shows whether one has wheels), only to requirements from a repository, a URL or a local path.

Fix: Remove or replace the package, or review it and add it to installScripts.allow in depcurfew.json, or to installScripts.deny when it works without its scripts (Python packages with the prefix pypi:). For a package in installScripts.deny, make the package manager block its scripts (depcurfew apply records the denial where the tool can).

### `unreadable-config`

**error** · A configuration file or lockfile cannot be read, parsed or edited, so depcurfew cannot check it.

A package manager or bot may still read the file and its settings may weaken the policy; depcurfew fails closed and reports an error instead of passing silently.

Fix: Fix what the message describes: invalid syntax, missing read permission, a symlink, a file over the size limit or a style depcurfew apply cannot edit.
<!-- END GENERATED: rules -->

## GitHub Action

The action runs `depcurfew doctor`, prints the report to the job log, shows each finding as an annotation on its file and in a table in the job summary, each with how to fix it, uploads the SARIF report to code scanning and fails the job when doctor finds an error, or also a warning when `doctor.failOn` in `depcurfew.json` is `warning` (the input `fail-on` is empty by default and follows it) or the input `fail-on` is `warning` (as `depcurfew doctor --fail-on warning`); `fail-on: error` fails on errors only, whatever the policy says, and the depcurfew doctor check fails or passes the same way. The log and the job summary also say what was checked: the tools found, the files read and every check with its result (passed, the problems it found, skipped because it needs `depcurfew.json`, or not applicable to the project). A clean run adds a notice with the same list ("No problems found in 7 files for npm 11.21.1 (package.json). 14 checks: 9 passed, 5 not applicable."), so it is not mistaken for one that did nothing. Code scanning lists only alerts, so its entry stays empty when there is nothing to report; next to it, in the Checks tab of a pull request, the action adds the check "depcurfew doctor" with the result, the table of checks and the findings as annotations on their lines (at most 100, errors first; a finding about a whole file is shown on its first line). It needs `checks: write`, which the example below grants; without it the step only says so in the log. A workflow that runs on both `push` and `pull_request` checks the same commit twice: the second run updates the entry of the first one instead of adding another, unless both run at the same moment, since GitHub has no way to look for an entry and add one in a single step. Annotations cannot be removed from an entry, so when the first entry has annotations other than the second run's findings, the second run adds a new entry and marks the first one as replaced (neutral, with a title that says so), rather than leave findings that no longer hold under the new result. It runs from its own checkout, with nothing to install, and sets up Node.js 22 only when the runner has an older version.

Pin it to a full commit SHA, like every action in your workflows; the example pins the commit of the latest release, and the comment names its tag. If the repository cannot use code scanning, set `upload-sarif: false`; the findings stay in the job log.

<!-- BEGIN GENERATED: action-workflow -->
```yaml
name: depcurfew

on:
  push:
  pull_request:

jobs:
  doctor:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      security-events: write
      # The depcurfew doctor check with the result in the Checks tab:
      checks: write
      # Only needed in private repositories:
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: DevXord/depcurfew@25fb6165f2d19767eb4d35c92606500e104b09f9 # v1.2.0
```
<!-- END GENERATED: action-workflow -->

<!-- BEGIN GENERATED: action-reference -->
| Input | Default | Description |
| --- | --- | --- |
| `directory` | `.` | Directory to check, relative to the workspace. |
| `sarif-file` | `depcurfew.sarif` | Where to write the SARIF report, relative to the workspace; a path outside it works too. |
| `upload-sarif` | `true` | Upload the SARIF report to GitHub code scanning. The job needs the security-events write permission. |
| `category` | `depcurfew` | Code scanning category of the upload, to tell several depcurfew runs in one workflow apart. |
| `fail-on` | empty | Which findings fail the step and the depcurfew doctor check. Empty (the default) follows doctor.failOn in depcurfew.json, which depcurfew init sets to warning, and fails on errors only without it; error or warning overrides the policy, and warning makes warnings fail them too, as depcurfew doctor --fail-on warning does. Notes never do. Any other value fails the step. |
| `fail-on-error` | `true` | Deprecated, use fail-on. false keeps the step from failing on findings at all, whatever fail-on says, and makes the depcurfew doctor check neutral instead of failed. |
| `annotations` | `true` | Show the findings as annotations on the files, each with how to fix it, or one notice when there are none, which lists every check and its result. GitHub shows a limited number per step; the log lists every finding. Turn off when code scanning already shows them. |
| `job-summary` | `true` | Add a table of the findings, each with how to fix it, and what was checked (tools, files read, every check with its result) to the job summary. |
| `check-run` | `true` | Add a check named "depcurfew doctor" to the commit, with the result, every check and the findings as annotations on the files (at most 100, errors first), shown next to the code scanning entry in the Checks tab of a pull request. A later run on the same commit, such as push and pull_request of one commit, updates it instead of adding a second one. The job needs the checks write permission; without it the step only says so in the log. |
| `github-token` | `${{ github.token }}` | Token for the depcurfew doctor check; the workflow token by default. |

| Output | Description |
| --- | --- |
| `errors` | Number of findings with level error. |
| `warnings` | Number of findings with level warning. |
| `notes` | Number of findings with level note. |
| `sarif-file` | Path of the SARIF report, relative to the workspace when it is inside it, otherwise absolute; empty when doctor could not run or the report could not be written. |
<!-- END GENERATED: action-reference -->

### Other CI systems

The action works only on GitHub. On GitLab CI or any other CI, install the project's dependencies without running their install scripts, so nothing from the lockfile runs before doctor has checked it, then run the depcurfew version the lockfile pins; the job fails when doctor finds an error, or a warning when `doctor.failOn` is `warning` (exit code 1):

```yaml
depcurfew:
  image: node:22
  script:
    - npm ci --ignore-scripts
    - npx --no depcurfew doctor
```

`--no` makes npx fail instead of downloading the latest depcurfew when the project does not have it; in CI npx otherwise downloads without asking. With pnpm, Yarn or Bun, use their frozen-lockfile install with install scripts turned off instead of `npm ci --ignore-scripts`.

`depcurfew doctor --json` and `--sarif` write the findings for other tools; set `FORCE_COLOR=1` if the CI log shows colors.

## What depcurfew does not do

depcurfew makes the package managers' own protections work and checks a package's age, name, install scripts and source before it is installed. It does not know which packages are malicious: it has no malware database and does not scan package contents, so a malicious version older than the cooldown passes. Use it together with a tool that blocks known malware at install time, and keep `npm audit` or an equivalent for known vulnerabilities. It also does not run or sandbox anything: the protection comes from the configuration the package managers read.

## Guarding installs

The configuration `apply` writes is what really protects a project: the package managers themselves wait out the release-age delay and refuse install scripts and sources the policy denies. `depcurfew check` adds a check before something is installed, which matters most for AI coding agents that add packages on their own:

```bash
npx depcurfew check zod@4 left-pad
npx depcurfew check pypi:requests "pypi:django>=5.2,<6"
```

For each package it looks up the npm registry (the one `--registry` or `registry=` in `.npmrc` names, else the public one; any other is named in a note), or PyPI for names with the `pypi:` prefix, and reports:

- a name the registry does not know, which is how made-up package names show up;
- a version younger than the cooldown in `depcurfew.json`, with the newest version that is old enough;
- install scripts the policy does not allow; for a Python package, a version without wheels, which is built from source and so runs its build code. A package in `installScripts.deny` is not reported, because its scripts are meant to stay blocked (`doctor` checks that the package manager blocks them), except a Python package without wheels, which gets a warning: it cannot be installed where building is blocked;
- a name that differs by a letter or two, or only in separators, from a popular package of its registry: 5,000 npm packages with the most weekly downloads among the results of several hundred registry searches (the npm registry has no download ranking, so a popular package can be missing), and the 5,000 most downloaded PyPI projects of a recent month;
- a deprecated version (a warning);
- a registry or index reached over plain HTTP (a warning), unless it is on this computer (`localhost`, `127.0.0.0/8` or `::1`), such as a local registry for testing.

A registry that redirects to another origin (another host, port or scheme, so also from `http://` to `https://` on the same host), and one at a link-local address, where cloud metadata services answer, is not followed or asked: the package counts as not checked. For a name without a version or with a range, npm prefers the dist-tag `tag=` in `.npmrc` names, and so does `check`.

Python packages are written as pip takes them after the prefix (`pypi:name`, `pypi:name==1.2`, `pypi:name[extra]>=1.2,<2`), or as `pypi:name@1.2`, `pypi:name@^1.2` and `pypi:name@latest`, as `uvx` and `poetry add` take them. The version is picked as pip picks it: the newest match, pre-releases only when asked for or when nothing else matches, and yanked versions only when pinned with `==` (a warning). A version is as old as its newest file, because files can be added to a release later. A project PyPI quarantines (as malware, for example) is an error; an archived or deprecated one, a warning. `--index` looks Python packages up in another index that serves the JSON form of the simple repository API.

Git repositories, tarball URLs and local paths are checked against the `sources` section only. Without a `depcurfew.json` in the directory or one of its parents up to the root of the repository, the default policy applies. When the registry cannot be reached, the package counts as failed: `check` exits with 1 whenever a package breaks the policy or cannot be checked. With `--json` it prints one document and nothing on stderr: `packages` with their findings (each with `code`, `level`, `message` and `fix`), `notices`, and `errors` for a `depcurfew.json` that cannot be used, in which case no package is checked.

### Claude Code

`depcurfew check --hook claude-code` runs as a Claude Code hook before every command of the tools that run shell commands: Bash, PowerShell and Monitor. It finds the packages the command would install or download to run, checks them and answers:

- **deny** when a package breaks the policy (Claude sees the reason and can pick another package or version);
- **ask** when depcurfew cannot vouch for the command: a look-alike name, a registry it cannot reach, an error of its own, or a command it cannot read, such as one with `$(...)` or variables in its arguments, or a shell that runs commands from a pipe (`curl … | sh`);
- nothing when everything checks out, so the command goes through Claude Code's usual permission prompts.

Warnings, such as a deprecated version or a git source depcurfew does not look up, never decide: the command goes through the usual permission prompts, and the warnings reach Claude as context next to the result of the command, with the deprecation message in quotes as the publisher's text, which is data, not instructions.

It follows the command lines inside a command: `$(...)` and backticks, `sh -c`, PowerShell's `-Command`, `cmd /c`, `eval`, `npx -c`, `yarn workspace <name>`, `python -m pip`, the command `uv run` runs, a package manager run by `npx`, `uvx` or `pipx run`, and wrappers such as `sudo`, `su -c`, `env`, `timeout`, `flock` and `xargs`. It reads options the way each tool does, including npm's and pnpm's shorthands and abbreviations (`--reg` and `--regis` for `--registry`), abbreviated long options of pip and pipx (`--extra` for `--extra-index-url`) and short options with their value in the same word (`-ihttps://…`), so an option, or a variable such as `PIP_INDEX_URL` or `UV_INDEX`, that points the tool at another index makes it ask. It checks the version the command would install: the dist-tag `--tag` or `npm_config_tag` makes npm prefer, pre-releases that `--pre`, `--prerelease allow` and the like allow, and builds from source that the command's options or variables force (wheels refused), which count as install scripts. A script piped into an interpreter (`curl … | python3`, `irm … | iex`) or read from `<(curl …)` makes it ask, and so does a command with more than 50 packages, of which the first 50 are checked. `deno x` and `dx` are read like `npx`. Packages from requirements files (`pip install -r`) and the project's own files (`uv sync`, `poetry install`) are not checked, as with `npm install` without names; `depcurfew doctor` checks the lockfiles. When it cannot read the hook event at all, it exits with code 2, which blocks the command in every Claude Code version, and says on stderr what it got and how Claude Code runs the hook.

The hook takes its policy from the project Claude Code works on (`CLAUDE_PROJECT_DIR`), wherever Claude's working directory is inside it: a different `depcurfew.json` nearer the working directory (in a nested repository, a vendored one or a package folder) is applied too, and the stricter answer counts, so it can tighten the check but never relax it; a decision says so. Paths are compared by where they really lead, through symlinks. When the project directory is not in a git repository (a folder that holds several repositories), the nearest `depcurfew.json` of the working directory applies, as `check` finds it.

It reads commands the way Windows runs them too: executables in any case and with `.exe`, `.cmd`, `.bat` or `.ps1` (`NPM.CMD i lodash`), paths with backslashes, and `cmd /c` or `cmd /k` (also `//c` from Git Bash), where `%VAR%` and `!VAR!` count as expansions. PowerShell commands (the PowerShell tool, `powershell -c`, `pwsh -c` and `iex`) are read like any other when they are plain commands: quotes, `;`, `|`, `&&`, the call operator `&`, redirections and `$env:NAME = "value"` before a command. PowerShell syntax it does not read, such as variables, `(...)`, `$(...)`, `{...}`, `@(...)`, backticks, commas, `Start-Process` or `Set-Alias`, makes it ask when the same statement names a package manager; a statement without one, such as `Get-ChildItem | Where-Object { $_.Length -gt 1kb }`, goes through. It also asks about an argument with `&`, `|`, `<`, `>` or `"` for a package manager run from PowerShell, because the `.cmd` shim of a package manager hands its arguments to cmd.exe again.

Install depcurfew as a development dependency of the project, then add the hook:

<!-- BEGIN GENERATED: claude-code-hook -->
In `.claude/settings.json` of the project:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Monitor",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/node_modules/depcurfew/dist/cli.js",
              "check",
              "--hook",
              "claude-code"
            ],
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The matcher `Bash|PowerShell|Monitor` covers every tool that runs shell commands. On Windows, PowerShell is the main shell wherever the PowerShell tool is on, and without Git Bash there is no Bash tool, so a hook on `Bash` alone never runs there; Monitor runs a command in the background. `command` is `node` itself, which also starts on Windows, where Claude Code runs it without a shell.

`onFailure: "block"` needs Claude Code 2.1.295 or later; without it, a hook that fails to start, crashes or times out lets the command through.

**Before depcurfew is installed.** The hook runs the copy in `node_modules`. When that file is missing (a fresh clone before `npm ci`, a repository without `package.json` in its root, a new cloud session), node still starts, cannot load it and exits with code 1 and a stack trace, and with `onFailure: "block"` that failure blocks every command of these tools, including the `npm ci` that would install depcurfew; without it, every command runs unchecked. The blocked call shows the hook command, `failed; blocking because onFailure is "block"` and node's `Error: Cannot find module '…/node_modules/depcurfew/dist/cli.js'`: run the install (`npm ci --ignore-scripts` in the project, or in `.claude/depcurfew` for the tools directory below) from a terminal, then try again. So install depcurfew before the hook is needed:

- **On your machine:** run `npm ci` once after cloning, in a terminal, before you start Claude Code.
- **In every session:** a `SessionStart` hook installs the locked copy when it is missing (with pnpm, Yarn or Bun, use their install from the lockfile instead of `npm ci`). It runs when a session starts or resumes, and Claude's first response waits for it, so the guard is in place before the first command. `--ignore-scripts` keeps the install from running dependency scripts before the guard is there. Add it next to `PreToolUse` in the same `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && { test -f node_modules/depcurfew/dist/cli.js || npm ci --ignore-scripts; }"
          }
        ]
      }
    ]
  }
}
```

- **A repository without `package.json` in its root** (several projects side by side): keep depcurfew in a small tools directory, for example `.claude/depcurfew/package.json` with depcurfew pinned exactly and its `package-lock.json` committed, install it there (`cd .claude/depcurfew && npm ci --ignore-scripts`, also in the `SessionStart` hook), and point the hook at `${CLAUDE_PROJECT_DIR}/.claude/depcurfew/node_modules/depcurfew/dist/cli.js`.
- **Cloud sessions (Claude Code on the web):** the repository's `.claude/settings.json` hooks run there, user-level ones do not. The environment's setup script runs before Claude Code starts, so it can install depcurfew too; the `SessionStart` hook above covers a cached environment as well.
- **Locked out already:** install depcurfew from a terminal outside Claude Code, or remove the hook from `.claude/settings.json` there; Claude cannot do it for you while the hook blocks its commands, which is the point of `block`.

Commands the guard reads (an add subcommand of any npm package manager, such as `install` or `i`, is checked for all of them; Python commands are matched word for word, and `python -m pip` counts as `pip`):

| Package manager | Add packages | Download and run | Starter kits |
| --- | --- | --- | --- |
| npm | `npm install`, `npm add`, `npm i`, `npm in`, `npm ins`, `npm inst`, `npm insta`, `npm instal`, `npm isnt`, `npm isnta`, `npm isntal`, `npm isntall`, `npm install-test`, `npm it` | `npx`, `npm exec`, `npm x` | `npm init`, `npm create`, `npm innit` |
| pnpm | `pnpm add` | `pnx`, `pnpx`, `pnpm dlx` | `pnpm create` |
| Yarn (Berry) | `yarn add` | `yarn dlx` | `yarn create` |
| Bun | `bun add` | `bunx`, `bun x` | `bun create` |
| Deno | `deno add`, `deno install` | `deno x`, `dx`, `denox`, `dnx` | none |
| uv | `uv add`, `uv pip install`, `uv tool install` | `uvx`, `uv tool run`, `uv run` | none |
| pip | `pip install`, `pip3 install` | none | none |
| pipx | `pipx install` | `pipx run` | none |
| Poetry | `poetry add` | none | none |
| PDM | `pdm add` | none | none |
| Pipenv | `pipenv install` | none | none |
<!-- END GENERATED: claude-code-hook -->

The hook reads commands the way a shell splits them, but it is a safety net, not a sandbox: a command can install packages in ways it does not recognize (a script, another tool). Keep the package manager configuration from `depcurfew apply` in place; it is what enforces the policy for every install.

### MCP server

`depcurfew mcp` runs the same check as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so that an AI agent in Claude Desktop, VS Code or any other client that starts a local stdio server can ask before it installs a package. It offers two read-only tools:

- `check_packages` takes `packages`, a list of 1 to 50 specs as `depcurfew check` takes them (`zod@4`, `pypi:requests`), and an optional `directory`. It returns the document of `check --json` (`schemaVersion`, `policy`, `packages` with their findings, `notices`, `errors`) as structured content and as JSON text. A package that breaks the policy is a successful check with error findings; the call itself is an error (`isError`) only when nothing could be checked, such as a `depcurfew.json` that cannot be used, a directory that does not exist or a wrong argument, with a message that says what to do.
- `explain_policy` takes an optional `directory` and returns which `depcurfew.json` applies (`null` and the default policy of `depcurfew init` when there is none), the release-age delay and its exceptions, the install-script lists, the allowed sources, and the registry and index `check_packages` asks, with the scopes `.npmrc` assigns to other registries as a list of `scope` and `registry`. It reads local files only.

The policy and the registries are always those of the project directory: its `depcurfew.json` or the nearest one above it up to the root of the repository, and the `.npmrc` next to it, shown relative to the project directory. A `directory` must exist inside the project directory, but it does not change them: a directory inside the project can carry a `depcurfew.json` that the user did not write, such as a package in `.venv/…/site-packages`, a vendored clone with a `.git` of its own, or a file an agent wrote. When the directory has a `depcurfew.json` of its own, the result has a notice that it is not used; to check a project with a policy of its own, start a server for it with `--dir`.

What the agent gets is the same as in the hook: install scripts are named without their content, text from a registry or the repository (keys too) is shown as visible text and cut to 400 characters, with control characters, bidirectional controls and invisible characters (zero-width characters, Unicode tag characters, variation selectors) written as escapes, and the publisher's text, such as a deprecation message, in quotes; the tool descriptions say that it is data, not instructions. A fix that would change `depcurfew.json` says to ask the user instead, because only the user changes the policy, and a fix about the registry or index (one that cannot be reached, plain HTTP) says to tell the user, because the agent cannot choose another one; without a `depcurfew.json`, a notice says that the default policy applies and to tell the user if the project should have its own. The registry and the index are options of the server (`--registry`, `--index`, and `.npmrc` as for `check`), never arguments of a call, so an agent cannot point the check at a registry that vouches for anything. The project directory is `--dir`, else `CLAUDE_PROJECT_DIR`, else the directory the client starts the server in. The server ends when the client closes its stdin or sends SIGINT or SIGTERM, and writes nothing but protocol messages to stdout.

Install depcurfew as a development dependency of the project, then add the server. Each configuration starts `node` itself with the path of the installed script, which works without a shell on Windows too:

<!-- BEGIN GENERATED: mcp-clients -->
The server speaks the `initialize` handshake of the protocol revisions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and the stateless revision 2026-07-28, without the handshake, for clients that use it.

**Claude Code.** Add the server to `.mcp.json` of the project, which everyone working on it shares (Claude Code asks before it starts a server from that file):

```bash
claude mcp add --scope project --transport stdio depcurfew -- node '${CLAUDE_PROJECT_DIR:-.}/node_modules/depcurfew/dist/cli.js' mcp
```

or write `.mcp.json` yourself:

```json
{
  "mcpServers": {
    "depcurfew": {
      "command": "node",
      "args": [
        "${CLAUDE_PROJECT_DIR:-.}/node_modules/depcurfew/dist/cli.js",
        "mcp"
      ]
    }
  }
}
```

Claude Code sets `CLAUDE_PROJECT_DIR` to the project root for the server, and `depcurfew mcp` takes it as the project directory. Claude Code itself does not have the variable, so in `args` it needs the default `${CLAUDE_PROJECT_DIR:-.}` (in cmd.exe, leave out the single quotes).

**Claude Desktop.** In `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`, Linux: `~/.config/Claude/claude_desktop_config.json`), with absolute paths and `--dir`, because Claude Desktop starts servers in no particular directory:

```json
{
  "mcpServers": {
    "depcurfew": {
      "command": "node",
      "args": [
        "/path/to/project/node_modules/depcurfew/dist/cli.js",
        "mcp",
        "--dir",
        "/path/to/project"
      ]
    }
  }
}
```

**VS Code.** In `.vscode/mcp.json` of the workspace:

```json
{
  "servers": {
    "depcurfew": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/node_modules/depcurfew/dist/cli.js",
        "mcp"
      ],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

`code --add-mcp '{"name":"depcurfew","type":"stdio","command":"node","args":["/path/to/project/node_modules/depcurfew/dist/cli.js","mcp","--dir","/path/to/project"]}'` adds the server for one project to your user profile instead.
<!-- END GENERATED: mcp-clients -->

Other clients that start a stdio server take the same command and arguments; give them absolute paths and `--dir` when they do not start the server in the project directory.

The server is advice to an agent that asks, not a guard: an agent can install packages without calling it. The package manager configuration from `depcurfew apply` is what enforces the policy; in Claude Code the hook above also checks every install command.

## Network and privacy

Only `check`, the Claude Code hook and the `check_packages` tool of `depcurfew mcp` use the network. For each package they request one URL with the package name in it: from the public npm registry (`registry.npmjs.org`) or PyPI (`pypi.org`), or from the registry that the project's or your `.npmrc` sets, `--registry` or `--index`. They send no credentials (tokens in `.npmrc` are not read, and a user name and password written into a registry URL are removed before the request and in every message) and nothing else about the project, and depcurfew has no telemetry. A private package whose scope has no registry in `.npmrc` is looked up in the public registry, so its name reaches that registry; set `@scope:registry` in `.npmrc` or pass `--registry` first. `init`, `explain`, `apply` and `doctor` work without network access. The GitHub Action checks the repository without it too; afterwards it sends the result (the counts, the table of checks and findings, the files read) to the GitHub API of the run (`GITHUB_API_URL`) with the workflow token to create the depcurfew doctor check (input `check-run`), and the SARIF upload to code scanning is a separate step that runs GitHub's own action. An editor that reads the `$schema` of `depcurfew.json` may download the schema from unpkg.com.

## Library

The same functions are available from the package: `detectProject`, `planApply` and `applyProject`, `runDoctor` with `toSarif`, `checkSpecs` with `scanCommandLine`, and the policy parser and converters. Their types ship in `dist/index.d.ts`, and [`src/index.ts`](https://github.com/DevXord/depcurfew/blob/main/src/index.ts) lists every export. The package is an ES module only: use `import`; `require('depcurfew')` works on Node.js 22.12 and later, which load ES modules with `require()`.

## Contributing

Facts about package managers live only in [`src/knowledge/`](https://github.com/DevXord/depcurfew/tree/main/src/knowledge), each with the official URL it was verified against and the date. A correction is welcome with a link to the official documentation or changelog. `npm test` builds the project and runs every test without network access.

## License

[MIT](https://github.com/DevXord/depcurfew/blob/main/LICENSE)

## Trademarks

npm is a registered trademark of npm, Inc. "Python" and "PyPI" are trademarks of the Python Software Foundation. pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate, Dependabot, GitHub, Claude Code and the other names in this document belong to their owners. depcurfew is an independent project and is not affiliated with or endorsed by any of them.
