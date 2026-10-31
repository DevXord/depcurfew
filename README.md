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
5. `npx depcurfew doctor` reports configuration that silently does not work and drift from the policy, and exits with 1 when it finds an error.
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
    "allow": []
  },
  "sources": {
    "git": "deny",
    "remoteTarball": "deny",
    "file": "allow",
    "directory": "allow"
  },
  "targets": "auto"
}
```
<!-- END GENERATED: default-policy -->

## Installation

depcurfew needs Node.js 22 or later and has a single runtime dependency, [`yaml`](https://github.com/eemeli/yaml).

Add it to the project as a development dependency, so the team, CI and coding agents all run the version pinned in the lockfile. Once `apply` has written the project's release-age delay, later updates of depcurfew go through that delay as well:

```bash
npm install --save-dev depcurfew
npx dcf doctor
```

Who needs it installed:

- **Developers working on the project:** nothing to do. The protection does not depend on depcurfew being installed: it lives in the package manager configuration that `apply` writes into the repository (`.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml`, `deno.json` and the bot configuration), and the package managers read it on their own. The project install brings depcurfew along as a development dependency anyway.
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
| `sources` |  |  | Where dependencies may come from besides the registry. An absent field is not managed. |
| `sources.git` | `"allow"`, `"deny"` |  | Dependencies installed from git repositories. |
| `sources.remoteTarball` | `"allow"`, `"deny"` |  | Dependencies installed from tarball URLs outside the registry. |
| `sources.file` | `"allow"`, `"deny"` |  | Dependencies installed from local tarball files. |
| `sources.directory` | `"allow"`, `"deny"` |  | Dependencies installed from local directories. |
| `targets` |  | `"auto"` | Tools to configure: "auto" detects them in the repository, or list them explicitly. |
<!-- END GENERATED: policy-fields -->

## Commands

The package installs two names for the same command: `depcurfew` and the short `dcf`, so `dcf doctor` works like `depcurfew doctor`.

| Command | What it does |
| --- | --- |
| `depcurfew init [directory] [--force]` | Writes `depcurfew.json` with the default policy (keeping a longer release-age delay the repository already sets); `--force` overwrites an existing one. |
| `depcurfew explain [directory] [--json]` | Describes the detected package managers, versions, bots and workspaces, and the policy values for each tool. |
| `depcurfew apply [directory] [--dry-run] [--json]` | Writes the policy into the configuration of every target tool; `--dry-run` prints a unified diff instead, `--json` the result as JSON. |
| `depcurfew doctor [directory] [--json \| --sarif]` | Finds configuration that silently does not work and drift from the policy; `--sarif` prints SARIF 2.1.0 for code scanning. |
| `depcurfew check <package...> [--json] [--dir <directory>] [--registry <url>] [--index <url>]` | Checks packages against the policy before you install them: see [Guarding installs](#guarding-installs). |
| `depcurfew check --hook claude-code` | The same check as a Claude Code hook that blocks install commands breaking the policy. |

Without a directory, `explain`, `apply` and `doctor` work on the nearest directory with `depcurfew.json`, from the current directory up to the root of the repository (the directory with `.git`), and say so when that is a parent directory (outside a git repository only the current directory counts, because a shared parent such as `/tmp` may hold someone else's `depcurfew.json`), so `doctor` run in a subdirectory does not pass for a project without a policy. A directory given on the command line is used as it is. `check` looks for `depcurfew.json` the same way, starting in `--dir`.

Exit codes: `0` success (warnings included), `1` an error (an invalid or unreadable policy, a file that cannot be edited, a doctor finding with level error), `2` a usage error (such as an unknown option or a directory that does not exist). `depcurfew <command> --help` describes a command with examples and its exit codes.

Every finding and warning says what to do about it. When a command cannot start, it says why with a code (`directory-not-found`, `not-a-directory`, `policy-missing`, `policy-invalid`, `policy-unreadable`) and what to do; with `--json` that is a document with `errors` on stdout, and `doctor --sarif` prints a run marked as not successful. Text for people is colored on a terminal; `NO_COLOR=1` turns colors off and `FORCE_COLOR=1` turns them on, for example in a CI log that shows them. Control characters in names and values from the repository or a registry are shown as text (ESC as `\x1b`), so a crafted package or file name cannot change the terminal. `--json`, `--sarif` and a diff written to a file stay plain, for programs and AI agents.

How `apply` edits files:

- It keeps comments, formatting, line endings and key order. In line-based files (INI, TOML) it writes a block between `# >>> depcurfew managed block` and `# <<< depcurfew managed block` markers and comments out older copies of the settings it manages (they come back when the policy stops managing them); in YAML it marks the keys it writes with `# managed by depcurfew`; JSON files keep their comments and indentation.
- It never removes settings it does not manage. Allow-lists are only added to; exception lists follow the policy, except the entries Renovate adds to pnpm's exception list for security updates, which stay with their comment.
- When it replaces a longer release-age delay someone set by hand with the policy's shorter one, it warns (`cooldown-shortened`) and names the `cooldown.minimum` that keeps it.
- If any file cannot be edited, nothing is written. If a file cannot be written, the files already written are put back.
- It does not create bot configuration files or project manifests (`package.json`, `deno.json`, `pyproject.toml`, `Pipfile`, `requirements.txt`); it creates a package manager's configuration file when it is missing. A package manager seen only in a CI setup step, with nothing of it in the repository, is not configured under `targets: "auto"`.
- It warns when a file it writes is ignored by git (`.gitignore` or `.git/info/exclude`), because the change would then stay on one machine.

### apply warnings and errors

Each warning and error of `apply` has a code. The text output shows it in parentheses after the message, with what to do on the next line, like a doctor finding. `depcurfew apply --json` (also with `--dry-run`) prints one JSON document and nothing on stderr: `changes` (each file with its action and unified diff), `warnings` and `errors` (each with `code`, `level`, the tool, the file when there is one, `message` and `fix`), `snippets` to add by hand, `notices` (such as the parent directory whose `depcurfew.json` was used) and `written`. A run that writes nothing because of an error lists no changes and exits with 1.

<!-- BEGIN GENERATED: apply-codes -->
Warnings:

- `nothing-to-configure`: depcurfew found no supported package manager or bot, so nothing is configured.
- `file-unreadable`: A file that shows which tools a project uses cannot be parsed, so depcurfew may configure fewer tools than the project uses.
- `tool-not-supported`: A detected tool is not supported (Yarn Classic), so nothing is written for it.
- `tool-only-in-ci`: A tool appears only in a CI setup step, with no manifest, lockfile or configuration in the repository, so targets "auto" does not configure it.
- `version-not-pinned`: No exact version of a package manager is pinned, so depcurfew configures for the latest version it knows.
- `version-too-old`: The pinned version of a tool lacks a setting the policy needs, so that setting is not written.
- `cooldown-not-written`: The release-age delay cannot be written for a tool.
- `cooldown-shortened`: A release-age delay set outside depcurfew's markers (in JSON files also one an earlier apply wrote) is longer than the policy, and apply replaces it with the shorter one.
- `cooldown-environment-only`: pip reads no project configuration, so the release-age delay has to be set in the environment where pip runs.
- `exclude-pattern-unsupported`: A cooldown exception uses a wildcard the tool does not support, so it is not written.
- `exclude-unsupported`: The tool has no setting for cooldown exceptions, so the release-age delay applies to every package.
- `allow-pattern-unsupported`: An installScripts.allow entry is a pattern, but the tool takes package names only, so it is not written.
- `allow-all-unsupported`: The tool has no setting that allows every install script, so installScripts "allow" is not written.
- `allow-all-replaced`: A setting that allowed every install script was replaced, because the policy denies install scripts.
- `allow-list-entry-outside-policy`: An install-script allow-list in the repository lets a package run scripts the policy does not allow; apply does not remove it.
- `built-in-list-replaced`: Bun's built-in list of trusted packages is replaced by the policy's allow-list.
- `scripts-not-enforceable`: The pinned npm or pnpm runs every install script and has no allow-list, so "deny" cannot be enforced.
- `before-overrides-cooldown`: before= in .npmrc takes the place of the release-age delay apply writes, or makes npm stop with an error next to it.
- `exact-version-gap`: The pinned pnpm skips the release-age delay for packages requested by exact version.
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
- `cannot-write`: A file cannot be written (no permission, a read-only file system, a full disk); the files already written are put back, so nothing changes.
- `policy-missing`: The directory has no depcurfew.json.
- `policy-invalid`: depcurfew.json does not follow the schema; issues lists the problems.
- `policy-unreadable`: depcurfew.json cannot be read.
- `directory-not-found`: The directory given on the command line does not exist or cannot be opened.
- `not-a-directory`: The path given on the command line is a file, not a directory.
<!-- END GENERATED: apply-codes -->

## Supported tools

What depcurfew configures and checks for each tool, from its [knowledge base](docs/knowledge.md), where every value links to the official documentation or changelog it was verified against.

<!-- BEGIN GENERATED: tools -->
| Tool | Release-age delay | Exceptions | Install-script allow-list (Python: packages built from source) | Dependency sources | Verified |
| --- | --- | --- | --- | --- | --- |
| npm | `min-release-age` in `.npmrc` (days), since 11.10.0 | `min-release-age-exclude`, since 11.17.0 | `allowScripts` in `package.json` | git: `allow-git`<br>remote tarball: `allow-remote`<br>local tarball: `allow-file`<br>local directory: `allow-directory` | 2026-10-28 – 2026-10-30 |
| pnpm | `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes), since 10.16.0 | `minimumReleaseAgeExclude`, since 10.16.0 | `allowBuilds` in `pnpm-workspace.yaml` | git: `blockExoticSubdeps`<br>remote tarball: `blockExoticSubdeps` | 2026-10-28 – 2026-10-31 |
| Yarn (Berry) | `npmMinimalAgeGate` in `.yarnrc.yml` (minutes), since 4.10.2 | `npmPreapprovedPackages`, since 4.10.0 | `dependenciesMeta.<package>.built` in `package.json` | git: `approvedGitRepositories` | 2026-10-28 – 2026-10-29 |
| Bun | `install.minimumReleaseAge` in `bunfig.toml` (seconds), since 1.3.0 | `install.minimumReleaseAgeExcludes`, since 1.3.0 | `trustedDependencies` in `package.json` | none | 2026-10-28 – 2026-10-29 |
| Deno | `minimumDependencyAge` in `deno.json`, `.npmrc` (minutes), since 2.5.5 / 2.6.0 ⚠️ | `minimumDependencyAge.exclude`, since 2.5.5 | `allowScripts` in `deno.json` | none | 2026-10-28 – 2026-10-30 |
| uv | `exclude-newer` in `uv.toml`, `pyproject.toml` (duration string), since 0.9.17 | `exclude-newer-package`, since 0.9.25 | `no-binary-package` in `pyproject.toml` | none | 2026-10-30 |
| pip | `uploaded-prior-to` on the command line or in the environment (no project file) (days), since 26.1.0 | none | `--no-binary` in `requirements.txt` | none | 2026-10-30 |
| Poetry | `solver.min-release-age` in `poetry.toml` (days), since 2.4.0 | `solver.min-release-age-exclude`, since 2.4.0 | `installer.no-binary` in `poetry.toml` | none | 2026-10-30 |
| PDM | `exclude-newer` in `pyproject.toml` (duration string), since 2.26.9 | `exclude-newer-override`, since 2.29.1 | `no-binary` in `pyproject.toml` | none | 2026-10-30 – 2026-10-31 |
| Pipenv | `cool-down-period` in `Pipfile` (duration string), since 2026.6.2 | none | none | none | 2026-10-30 |
| Renovate | `minimumReleaseAge` in `renovate.json`, `renovate.jsonc` … (duration string), since 35.46.0 | `packageRules: matchPackageNames + minimumReleaseAge: null`, since 35.46.0 ❓ | none | n/a | 2026-10-28 – 2026-10-30 |
| Dependabot | `cooldown` in `.github/dependabot.yml`, `.github/dependabot.yaml` (days), since 2025 07 01 | `cooldown.exclude`, since 2025 07 01 ❓ | none | n/a | 2026-10-28 – 2026-10-30 |

⚠️ official sources disagree (depcurfew takes the safer reading) · ❓ official sources are incomplete. Every value with its source: [docs/knowledge.md](docs/knowledge.md).
<!-- END GENERATED: tools -->

Yarn Classic (1.x) is detected but not supported.

### Python projects

depcurfew configures uv, Poetry, PDM, Pipenv and pip from the same `depcurfew.json`, and the bots for Python packages: Dependabot `pip` and `uv` entries and Renovate.

- **Detection.** A Python tool counts as used when its lockfile is there, when `pyproject.toml` has its table, or when its own configuration file or a CI setup step shows it; `requirements.txt` means pip. `depcurfew explain` lists what it found.
- **Package names.** Python packages on the policy's package lists (the cooldown exceptions and `installScripts.allow`) take the prefix `pypi:`, for example `"pypi:docopt"`. Names without a prefix stay npm names, so an exception for an npm package never applies to a Python package of the same name.
- **Install scripts are builds.** A wheel installs without running package code; a source distribution, a git repository or a local directory is built, which runs its build code. `installScripts.default: "deny"` forbids building, and the packages in `installScripts.allow` are the exceptions. None of the three tools can only allow a build, so these packages are always built from source, even where a wheel exists; `apply` says so, and `doctor` lists the packages in the lockfile that would be built.
- **pip reads no project configuration.** `apply` writes the build options into `requirements.txt`. The release-age delay cannot live in the project, so `apply` prints the environment variable to set where pip runs. `doctor` also checks the files a requirements file includes with `-r` and `-c`, and reports an include it cannot read.
- **Lock again after `apply`.** `uv.lock` records the release-age delay, and PDM checks `pdm.lock` against all of its resolution settings, the delay and the build ban included. After `apply` changes them, `uv sync --locked` and `uv lock --check` fail until you run `uv lock`, and `pdm lock --check` and `pdm install --check` until you run `pdm lock`; `apply` says so (`lockfile-out-of-date`). `poetry.lock` and `Pipfile.lock` do not depend on the settings `apply` writes.
- **PDM and Pipenv cannot pin their own version.** `apply` configures for the latest version depcurfew knows and says which version the settings need. Pipenv takes the delay in whole days only (rounded up), has no exceptions and no project setting that forbids building; `apply` says what to set where Pipenv runs instead. `doctor` reads `pdm.lock` and `Pipfile.lock`, and reports settings that turn the delay or the build ban off without a word: Pipenv's pure-Python resolver and PDM's uv mode.
- **Hatch has no settings of its own.** Its environments install with uv or pip, so a Hatch project is covered by the uv configuration (add `"uv"` to `targets` when its environments use the uv installer) or by the environment variables of pip.
- **Running depcurfew.** depcurfew is a Node.js program. In a project without `package.json`, run a pinned version with `npx --yes depcurfew@<version>`; in CI the [GitHub Action](#github-action) needs nothing else.

## doctor rules

Findings have a level: an **error** makes `depcurfew doctor` exit with 1, a **warning** or a **note** does not. Things doctor could not check (a binary lockfile, a lockfile format without install-script data, a missing policy) are listed as notes after the findings, not as findings.

<!-- BEGIN GENERATED: rules -->
### `invalid-policy`

**error** · depcurfew.json does not follow the schema or cannot be read.

Without a valid policy, the rules that compare the repository with depcurfew.json cannot run, so doctor runs only the rules that need no policy, as when there is no policy file.

Fix: Fix what the message lists; an editor that reads the $schema of depcurfew.json shows the problems as you type.

### `manager-version-too-old`

**error** · A declared package manager version is older than a setting the repository relies on.

Package managers ignore settings they do not know yet. When packageManager, devEngines, Volta, .tool-versions or a CI step pins an older version, the setting is silently not applied there.

Fix: Raise the declared version to at least the version that introduced the setting, everywhere it is declared.

### `setting-ignored-by-version`

**error** · A setting or file is ignored by the package manager version in use.

Package managers drop old settings and files in new major versions and only accept new forms from some version on. The configuration stays in the repository and looks effective while the version in use ignores it.

Fix: Move the setting to the place and form this version reads.

### `npmrc-overrides-policy`

**error** · An .npmrc file changes a security setting in a way the policy does not see, or is ignored.

Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages and the keys below a [section] header, and a before date in .npmrc takes the place of min-release-age; pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy.

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

A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy.

Fix: Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.

### `bot-cooldown-mismatch`

**error** · An update bot waits less than the package manager before proposing a new version.

The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile. A Dependabot cooldown with an include list delays only the dependencies it names, and a Renovate packageRules entry can shorten the delay for a whole registry or update type.

Fix: Give the bot a delay at least as long as the package manager's (depcurfew apply does this).

### `broad-exclusion`

**error** · An exception list matches every package, which turns the protection off.

A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies. The same goes for a Renovate packageRules entry that turns minimumReleaseAge off for a whole datasource, for major, minor or patch updates of every package, or with only negative patterns, which match every package they do not name.

Fix: Replace the pattern with the packages or scopes that really need the exception.

### `lockfile-forbidden-source`

**error** · needs depcurfew.json · The lockfile installs a package from a source depcurfew.json denies.

A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.

Fix: Replace the dependency with a registry version, or allow that source in depcurfew.json.

### `lockfile-install-scripts`

**error** · needs depcurfew.json · The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.

Install scripts run arbitrary code during installation, and so does building a Python package from source (a source distribution, a git repository or a local directory). Where the package manager runs them by default, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile; uv.lock, poetry.lock and pylock.toml show which Python packages have no wheel.

Fix: Remove or replace the package, or add it to installScripts.allow in depcurfew.json after reviewing it (Python packages with the prefix pypi:).

### `unreadable-config`

**error** · A configuration file or lockfile cannot be read, parsed or edited, so depcurfew cannot check it.

A package manager or bot may still read the file and its settings may weaken the policy; depcurfew fails closed and reports an error instead of passing silently.

Fix: Fix what the message describes: invalid syntax, missing read permission, a symlink, a file over the size limit or a style depcurfew apply cannot edit.
<!-- END GENERATED: rules -->

## GitHub Action

The action runs `depcurfew doctor`, prints the report to the job log, shows each finding as an annotation on its file and in a table in the job summary, each with how to fix it, uploads the SARIF report to code scanning and fails the job when doctor finds an error. It runs from its own checkout, with nothing to install, and sets up Node.js 22 only when the runner has an older version.

Pin it to a full commit SHA, like every action in your workflows. If the repository cannot use code scanning, set `upload-sarif: false`; the findings stay in the job log.

<!-- BEGIN GENERATED: action-workflow -->
```yaml
name: depcurfew

on:
  push:
  pull_request:

jobs:
  doctor:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      # Only needed in private repositories:
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: DevXord/depcurfew@<full-commit-sha> # pin a commit, not a tag
```
<!-- END GENERATED: action-workflow -->

<!-- BEGIN GENERATED: action-reference -->
| Input | Default | Description |
| --- | --- | --- |
| `directory` | `.` | Directory to check, relative to the workspace. |
| `sarif-file` | `depcurfew.sarif` | Where to write the SARIF report, relative to the workspace. |
| `upload-sarif` | `true` | Upload the SARIF report to GitHub code scanning. The job needs the security-events write permission. |
| `category` | `depcurfew` | Code scanning category of the upload, to tell several depcurfew runs in one workflow apart. |
| `fail-on-error` | `true` | Fail the step when doctor reports an error. |
| `annotations` | `true` | Show the findings as annotations on the files, each with how to fix it. GitHub shows a limited number per step; the log lists every finding. Turn off when code scanning already shows them. |
| `job-summary` | `true` | Add a table of the findings, each with how to fix it, to the job summary. |

| Output | Description |
| --- | --- |
| `errors` | Number of findings with level error. |
| `warnings` | Number of findings with level warning. |
| `notes` | Number of findings with level note. |
| `sarif-file` | Path of the SARIF report, relative to the workspace; empty when doctor could not run. |
<!-- END GENERATED: action-reference -->

### Other CI systems

The action works only on GitHub. On GitLab CI or any other CI, install the project's dependencies without running their install scripts, so nothing from the lockfile runs before doctor has checked it, then run the depcurfew version the lockfile pins; the job fails when doctor finds an error (exit code 1):

```yaml
depcurfew:
  image: node:22
  script:
    - npm ci --ignore-scripts
    - npx --no depcurfew doctor
```

`--no` makes npx fail instead of downloading the latest depcurfew when the project does not have it; in CI npx otherwise downloads without asking. With pnpm, Yarn or Bun, use their frozen-lockfile install with install scripts turned off instead of `npm ci --ignore-scripts`.

`depcurfew doctor --json` and `--sarif` write the findings for other tools; set `FORCE_COLOR=1` if the CI log shows colors.

## Guarding installs

The configuration `apply` writes is what really protects a project: the package managers themselves wait out the release-age delay and refuse install scripts and sources the policy denies. `depcurfew check` adds a check before something is installed, which matters most for AI coding agents that add packages on their own:

```bash
npx depcurfew check zod@4 left-pad
npx depcurfew check pypi:requests "pypi:django>=5.2,<6"
```

For each package it looks up the npm registry (the one `--registry` or `registry=` in `.npmrc` names, else the public one; any other is named in a note), or PyPI for names with the `pypi:` prefix, and reports:

- a name the registry does not know, which is how made-up package names show up;
- a version younger than the cooldown in `depcurfew.json`, with the newest version that is old enough;
- install scripts the policy does not allow; for a Python package, a version without wheels, which is built from source and so runs its build code;
- a name that differs by a letter or two, or only in separators, from a popular package of its registry: 5,000 npm packages with the most weekly downloads among the results of several hundred registry searches (the npm registry has no download ranking, so a popular package can be missing), and the 5,000 most downloaded PyPI projects of a recent month;
- a deprecated version (a warning);
- a registry or index reached over plain HTTP (a warning).

A registry that redirects to another host, and one at a link-local address, where cloud metadata services answer, is not followed or asked: the package counts as not checked. For a name without a version or with a range, npm prefers the dist-tag `tag=` in `.npmrc` names, and so does `check`.

Python packages are written as pip takes them after the prefix (`pypi:name`, `pypi:name==1.2`, `pypi:name[extra]>=1.2,<2`), or as `pypi:name@1.2`, `pypi:name@^1.2` and `pypi:name@latest`, as `uvx` and `poetry add` take them. The version is picked as pip picks it: the newest match, pre-releases only when asked for or when nothing else matches, and yanked versions only when pinned with `==` (a warning). A version is as old as its newest file, because files can be added to a release later. A project PyPI quarantines (as malware, for example) is an error; an archived or deprecated one, a warning. `--index` looks Python packages up in another index that serves the JSON form of the simple repository API.

Git repositories, tarball URLs and local paths are checked against the `sources` section only. Without a `depcurfew.json` in the directory or one of its parents up to the root of the repository, the default policy applies. When the registry cannot be reached, the package counts as failed: `check` exits with 1 whenever a package breaks the policy or cannot be checked. With `--json` it prints one document and nothing on stderr: `packages` with their findings (each with `code`, `level`, `message` and `fix`), `notices`, and `errors` for a `depcurfew.json` that cannot be used, in which case no package is checked.

### Claude Code

`depcurfew check --hook claude-code` runs as a Claude Code hook before every shell command. It finds the packages the command would install or download to run, checks them and answers:

- **deny** when a package breaks the policy (Claude sees the reason and can pick another package or version);
- **ask** when depcurfew cannot vouch for the command: a look-alike name, a registry it cannot reach, an error of its own, or a command it cannot read, such as one with `$(...)` or variables in its arguments, or a shell that runs commands from a pipe (`curl … | sh`);
- nothing when everything checks out, so the command goes through Claude Code's usual permission prompts.

It follows the command lines inside a command: `$(...)` and backticks, `sh -c`, PowerShell's `-Command`, `eval`, `npx -c`, `yarn workspace <name>`, `python -m pip`, the command `uv run` runs, a package manager run by `npx`, `uvx` or `pipx run`, and wrappers such as `sudo`, `su -c`, `env`, `timeout`, `flock` and `xargs`. It reads options the way each tool does, including npm's and pnpm's shorthands and abbreviations (`--reg` and `--regis` for `--registry`), abbreviated long options of pip and pipx (`--extra` for `--extra-index-url`) and short options with their value in the same word (`-ihttps://…`), so an option, or a variable such as `PIP_INDEX_URL` or `UV_INDEX`, that points the tool at another index makes it ask. It checks the version the command would install: the dist-tag `--tag` or `npm_config_tag` makes npm prefer, pre-releases that `--pre`, `--prerelease allow` and the like allow, and builds from source that the command's options or variables force (wheels refused), which count as install scripts. A script piped into an interpreter (`curl … | python3`, `irm … | iex`) or read from `<(curl …)` makes it ask, and so does a command with more than 50 packages, of which the first 50 are checked. `deno x` and `dx` are read like `npx`. Packages from requirements files (`pip install -r`) and the project's own files (`uv sync`, `poetry install`) are not checked, as with `npm install` without names; `depcurfew doctor` checks the lockfiles. When it cannot read the hook event at all, it exits with code 2, which blocks the command in every Claude Code version.

Install depcurfew as a development dependency of the project, then add the hook:

<!-- BEGIN GENERATED: claude-code-hook -->
In `.claude/settings.json` of the project:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
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

`onFailure: "block"` needs Claude Code 2.1.295 or later; without it, a hook that fails to start, crashes or times out lets the command through.

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

## Network and privacy

Only `check` and the Claude Code hook use the network. For each package they request one URL with the package name in it: from the public npm registry (`registry.npmjs.org`) or PyPI (`pypi.org`), or from the registry that the project's or your `.npmrc` sets, `--registry` or `--index`. They send no credentials (tokens in `.npmrc` are not read) and nothing else about the project, and depcurfew has no telemetry. A private package whose scope has no registry in `.npmrc` is looked up in the public registry, so its name reaches that registry; set `@scope:registry` in `.npmrc` or pass `--registry` first. `init`, `explain`, `apply` and `doctor` work without network access, and so does the doctor step of the GitHub Action (the SARIF upload to code scanning is a separate step that runs GitHub's own action). An editor that reads the `$schema` of `depcurfew.json` may download the schema from unpkg.com.

## Library

The same functions are available from the package: `detectProject`, `planApply` and `applyProject`, `runDoctor` with `toSarif`, `checkSpecs` with `scanCommandLine`, and the policy parser and converters. See `src/index.ts`.

## Contributing

Facts about package managers live only in `src/knowledge/`, each with the official URL it was verified against and the date. A correction is welcome with a link to the official documentation or changelog. `npm test` builds the project and runs every test without network access.

## License

[MIT](LICENSE)

## Trademarks

npm is a registered trademark of npm, Inc. "Python" and "PyPI" are trademarks of the Python Software Foundation. pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate, Dependabot, GitHub, Claude Code and the other names in this document belong to their owners. depcurfew is an independent project and is not affiliated with or endorsed by any of them.
