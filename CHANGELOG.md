# Changelog

All notable changes for users of depcurfew. The project follows [semantic versioning](https://semver.org/): the policy file (`version: 1`), the command-line options, the exit codes and the JSON and SARIF output (`schemaVersion: 1`) only change in a backward-incompatible way in a new major version.

## 1.2.0

### Protecting the whole machine

- `depcurfew init --user` writes a user policy (`~/.config/depcurfew/depcurfew.json`, `%APPDATA%\depcurfew\depcurfew.json` on Windows).
- `depcurfew apply --user` writes it into the user-level configuration of the installed package managers (npm, pnpm, Yarn, Bun, Deno, uv, pip, Poetry and PDM), which protects every project that does not set those settings itself, and `npx`, `uvx` and global installs. Versions are read from the files next to each executable, never by running it; `--for tool@version` gives a version by hand, and a tool that stops every command on a value its version does not understand gets nothing until its version is known. pip gets its release-age delay this way, which a project cannot set.
- `depcurfew doctor --user` reports user files that do not match the user policy, values in them that weaken every project, and environment variables that move, skip or override them.
  - It also checks the places that beat the user file: command sections such as `[install]` in `pip.conf`, the `[pip]` table of `uv.toml`, and the `~/.npmrc` that pnpm 10 reads ahead of its `rc` file. A value counts as depcurfew's only when it is exactly what `apply --user` writes into its block.
  - It fails closed: an invalid user policy (`user-policy-invalid`) and a user file it cannot read, parse or edit (`user-config-unreadable`) are errors with exit code 1.
  - Environment variables are checked in every spelling and named as they are set. The default `~/.npmrc` that npm passes to `npx` and `npm run` is not reported, and values that may hold credentials are never printed. `--sarif` locates user files relative to `HOME` without revealing the home path.
- `apply --user` treats a key in a user file as `apply` treats the same key in a project file: hand-written exception lists and Python build lists are commented out even when the policy lists none, longer delays it shortens are reported (`cooldown-shortened`), and the warnings of project mode appear here too (scripts that cannot be blocked, forced source builds, sources a user file cannot hold, allow-list patterns, denials that live only in project files, Yarn 1).
  - With npm 11.10–11.14 it does not write `min-release-age` next to `before=` in `~/.npmrc`, where every npm command would fail; it warns instead.
  - It writes the files of all tools or none, refuses a missing home directory (`home-missing`), skips a tool that would read a relative `XDG_CONFIG_HOME` or `%APPDATA%` (`user-directory-relative`), names every file by its `~/` path, and warns about environment variables that would leave what it writes without effect (`environment-overrides`).
  - `--for` accepts versions as tools print them (`pip@26.1`) and warns when it names a tool that is not configured (`version-not-used`).
  - After `corepack enable`, pnpm and Yarn shims are no longer read as version 0.34.0; their version is unknown until `--for` gives it.
  - It turns off a switch in a user file that runs every install script (`dangerously-allow-all-scripts` in `~/.npmrc`, pnpm's `dangerously-allow-all-builds` in `rc` and `dangerouslyAllowAllBuilds` in `config.yaml`) when the user policy denies install scripts, as `apply` does in a project.
  - It warns (`user-setting-overridden`) when `~/.npmrc` overrides a setting it writes to pnpm 10's `rc`, and `doctor --user` reports that even before the first apply.
  - `init --user` refuses a missing home directory as `apply --user` does, and a file in the way of `~/.config/depcurfew` is an error with a fix instead of a crash. Run as root with `HOME` kept, `init` and `apply --user` give new files in the home directory to its owner.

### Policy

- `installScripts.deny` lists packages you reviewed that work without their install scripts, such as `fsevents`, which ships a prebuilt binary. `doctor` no longer reports them while the tool does not run their scripts, and `apply` records the denial where the tool has one (npm 11.16+, pnpm 10.1+ as `ignoredBuiltDependencies` and from 10.26 in `allowBuilds`, Yarn, Deno 2.6+), so the tool stops warning about them on every install. For Python packages `doctor` reports a tool that would still build one from source. Policies without it stay valid.
  - `apply` never changes an allow-list entry you wrote for a denied package, or a tool's own denial of an allowed one; it warns with `deny-conflicts-with-file`, and `doctor` reports the same entries.
  - `depcurfew check` and the Claude Code hook do not block denied packages; a denied Python package without wheels gets a warning that it cannot be installed while building is blocked.
  - An npm pattern in `allow` and a `pypi:` name in `deny` no longer clash; two patterns that can match the same name are rejected, with an example name.

### Messages

- `doctor` rule and `apply` warning `depcurfew-outdated`: the project installs a newer depcurfew than the one running (a global install or an old npx cache), which may not know what the project's version writes or checks. When the version is only pinned in `package-lock.json`, it says to run `npm ci` first.

### Settings that switch protection off

- `apply` and `doctor` treat a switch that allows every install script as on for every value the tool does not read as off: pnpm's `dangerouslyAllowAllBuilds: "false"` (a string), `yes` or `"true"`, `dangerously-allow-all-builds=1` in `.npmrc` (also in the project `.npmrc` with pnpm 10, which `doctor` now checks), npm's `dangerously-allow-all-scripts=1`, the same in `npm_config_*` variables, and Yarn's `enableScripts: 1`.
- YAML merge keys (`<<: *defaults`) in `pnpm-workspace.yaml` and pnpm's `config.yaml` are read as pnpm reads them, so a setting that arrives through one is no longer hidden; `apply` writes its value into the map itself, which wins over merged keys. `.yarnrc.yml` and `dependabot.yml` are read without merging, as those tools do.
- `doctor` reports an allow-list entry that lets a package of `installScripts.deny` run its scripts as an error, names a missing JSON setting by its path, lists every `.npmrc` line outside the block, and reports an `.npmrc` that is not a regular file instead of showing it as missing.

### What doctor checked

- `doctor` and `doctor --user` say below the result what they checked: the package managers and bots found, with the version they checked against, the files read and how many rules ran (and which need a policy that is missing). `--json` has the same in the new `checked` field.
- The GitHub Action prints the same in the log, adds a "What was checked" section to the job summary and, when there is nothing to report, a notice ("No problems found: … rules checked … files"), so a clean run no longer looks like one that did nothing.

### Safety of output and files

- Diffs from `apply --dry-run` and `apply --json` show tokens and passwords (`_authToken`, `_auth`, `_password`, `user:password@` in URLs) as `<redacted>`; the files on disk are untouched.
- JSON and SARIF output escape C1 control and bidirectional characters, and the text diff of `apply --dry-run` shows control characters from files as text, also when piped.
- Files are read only when they are regular files and never past 1 MiB, whatever size the file system reports, so a FIFO or a file under `/proc` in place of a configuration file no longer makes depcurfew hang or run out of memory.
- Run as root (`sudo` with `HOME` kept), `apply` keeps the owner of each file it replaces.
- `depcurfew … | head` no longer ends with an EPIPE stack trace.

## 1.1.0

Everything below is new since 1.0.0. Upgrading needs no change to `depcurfew.json`.

### Guarding installs

- `depcurfew check <package...>` looks packages up in the npm registry or PyPI before you install them: names that do not exist or look like a popular package, versions younger than the delay, install scripts or builds from source the policy does not allow, yanked, deprecated or quarantined versions, and sources the policy denies. `--json`, `--dir`, `--registry` and `--index` are supported.
- `depcurfew check --hook claude-code` is a PreToolUse hook for Claude Code (the Bash, PowerShell and Monitor tools) that blocks install commands breaking the policy and asks when it cannot tell what a command installs. It is a safety net, not a sandbox.

### Python

- `apply`, `doctor`, `explain` and `check` support uv, pip, Poetry, PDM and Pipenv. Python packages are named with the `pypi:` prefix in the policy, and for Python `installScripts` covers packages built from source.
- After `apply` changes settings that a lockfile records (uv, PDM), lock again; `apply` and `doctor` say when.

### Messages and machine output

- `depcurfew apply --json` prints the changes with their diff, the warnings and the errors as one JSON document. Every warning and error has a code and says what to do.
- `doctor` reports an invalid `depcurfew.json` as a finding (`invalid-policy`); `check --json` and `explain --json` print JSON for it too.

### Behaviour changes and fixes

- `init` keeps the longest release-age delay the repository already sets, and `apply` warns before it would shorten one (`cooldown-shortened`).
- Without a directory, `apply`, `doctor` and `explain` use the nearest `depcurfew.json` up to the root of the repository, and only from a directory owned by the user that others cannot write to.
- `apply` writes every file or none, never makes a file it replaces readable by others, not even for a moment, keeps the line endings of the lines it does not change, and refuses files that are not UTF-8.
- `dependabot.yml`, `pnpm-workspace.yaml` and `.yarnrc.yml` with comments after the last entry are edited correctly; the result of every YAML, JSON and TOML edit is checked before anything is written.
- New `doctor` rule `python-config-ignored`, and more configuration that does nothing is found, among others `before=` and quoted keys in `.npmrc`, Yarn `npmScopes` age gates, pnpm `permissions.*.build`, broad Renovate rules and presets, and an out-of-date `pdm.lock`.
- Large lockfiles, `dependabot.yml`, `renovate.json` and SARIF output are processed much faster; YAML lockfiles over 16 MiB are reported instead of read.
- Windows: writes are tried again while another program holds a file, and the tests run on Windows in CI.

## 1.0.0

The first release.

- `depcurfew.json` holds one supply-chain policy: a release-age delay with exceptions (`cooldown`), an allow-list for install scripts (`installScripts`) and the dependency sources you allow (`sources`).
- `depcurfew init` writes the policy; `depcurfew apply` writes it into the configuration of npm, pnpm, Yarn (Berry), Bun, Deno, Renovate and Dependabot, keeping comments and formatting and marking what it manages; `--dry-run` prints a diff.
- `depcurfew doctor` reports configuration that silently does nothing and drift from the policy, as text, `--json` or `--sarif`.
- `depcurfew explain` shows what was detected and what the policy means for each tool.
- A GitHub Action runs `doctor` on every push and reports to code scanning.
- Node.js 22 or later; the library is ESM only. depcurfew does not use the network and has no telemetry.
