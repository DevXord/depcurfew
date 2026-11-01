# Changelog

All notable changes for users of depcurfew. The project follows [semantic versioning](https://semver.org/): the policy file (`version: 1`), the command-line options, the exit codes and the JSON and SARIF output (`schemaVersion: 1`) only change in a backward-incompatible way in a new major version.

## 1.3.0

### An MCP server for other coding agents

- `depcurfew mcp` is a Model Context Protocol server over stdio, so that Claude Desktop, VS Code, Cursor and other agents can ask before they install a package. It has two tools: `check_packages` (the same checks and the same document as `depcurfew check --json`) and `explain_policy` (which `depcurfew.json` applies and what it allows). It speaks both the `initialize` handshake (protocol revisions 2024-11-05 to 2025-11-25) and the stateless revision 2026-07-28 with `server/discover`.
- The registry and the Python index come only from the server's own options and `.npmrc`, never from a tool call, so an agent cannot point the check at a registry that approves anything. A `directory` argument must stay inside the project. Fixes that would change `depcurfew.json` are not offered to the agent.
- It limits what a client can send (1 MiB per line, nesting depth 64, 4 calls at once), stops on a cancelled request, and ends quietly when stdin or stdout closes or on SIGINT and SIGTERM. The README has configurations for Claude Code (`claude mcp add`, `.mcp.json`), Claude Desktop and VS Code. The server only advises; the configuration `apply` writes is what enforces.

### Several projects in one repository

- The new policy field `projects` lists directories that are independent projects, such as `frontend` and `backend`, each with its own manifest and lockfile. `apply`, `doctor` and `explain` in the root handle every project with the root's policy, and configure the update bots once, from the root, with a delay that covers every project's package managers. `init` in a root without a manifest proposes the directories that have one.
- A listed directory that is missing, is not a directory, is reached through a symlink, has its own `depcurfew.json` or is a workspace package of the root is an error (new `apply` codes `project-not-found`, `project-not-a-directory`, `project-symlink`, `project-has-policy`, `project-in-workspace`, and the `doctor` rule `invalid-project`); nothing is written. A target that no directory uses gets `target-not-found`. The user policy cannot list projects. Policies without the field are unchanged.

### The npm and pip that come with Node.js and Python

- `doctor` now knows which npm each Node.js release brings and which pip each Python release brings. Node.js 22, still supported until 2027-04-30, comes with npm 10, which has no release-age delay and ignores settings it does not know without a word; Node.js 24 brings npm 11.10 or later only from 24.14.1. `manager-version-too-old` reports a CI job that installs with npm after setting up such a Node.js, a Dockerfile stage that runs `npm ci` or `pip install` on such an image, and the version files developers use, with the npm or pip version to install or the Node.js or Python release to move to.
- It reads Node.js versions from `.nvmrc`, `.node-version`, `engines.node` of a private package, the files setup-node's `node-version-file` names, the values of `${{ matrix.<key> }}`, and Dockerfiles (`Dockerfile`, `*.Dockerfile`, `Dockerfile.<name>`, `Containerfile`): `FROM node:<tag>` and `FROM python:<tag>` with `ARG` substitution and stages, and `npm install -g npm@…` or `pip install pip==…` before the install. A setup step only counts for the installs that follow it, before the next setup step. `explain` shows the jobs and Dockerfiles it read.
- New rule `runtime-end-of-life` (warning): a declared Node.js version that only allows release lines past their end of life, where they install packages or run code.

### doctor and the GitHub Action

- `doctor --strict` (also with `--user`) exits with 1 for warnings too; notes never fail. The JSON has a new field `strict`.
- New policy section `doctor` with `failOn: "error" | "warning"` (also in the user policy). `init` and `init --user` write `"warning"`, so new policies make `doctor` and the Action fail on warnings too; a policy without the section fails on errors only, as before (the new checks can still find new errors, see "Upgrading from 1.2.0"). `doctor --fail-on error|warning` overrides it (`--strict` is `--fail-on warning`), and so does the Action input `fail-on`, which is now empty by default and follows the policy. The JSON of `doctor` has the new fields `failOn` and `failOnFrom` (`option`, `policy` or `default`).
- The rule list says "not applicable" for a check that does not concern the repository (Python rules in a JavaScript project, bot rules without a bot), instead of "passed".
- Action: new input `fail-on: error | warning`; with `warning`, warnings fail the step and the "depcurfew doctor" check like errors. `fail-on-error` still works and is deprecated; `false` keeps the step from failing whatever `fail-on` says, and now every other value counts as on.
- The "depcurfew doctor" check shows the findings as annotations on their lines (at most 100, errors first), and a workflow that runs on both `push` and `pull_request` updates the entry of the same commit instead of adding a second one.

### Protecting the whole machine

- `init --user` keeps the longest release-age delay already set in the user files of the installed tools, as `init` does in a project.
- Yarn's version is read from more places without running it: a global install of `@yarnpkg/cli-dist`, Corepack's `lastKnownGood.json`, and a `yarnPath` in `~/.yarnrc.yml` that names `yarn-<version>.cjs`. Bun from its official installer still needs `--for`.
- Poetry and PDM on macOS: the file they read depends on the platformdirs version installed next to them, which depcurfew now reads; when it cannot, `apply --user` writes where the documentation says and warns with both paths (`user-file-uncertain`).

### Claude Code hook and installation

- The README says what the hook does before depcurfew is installed: with `onFailure: "block"` a missing `node_modules/depcurfew` blocks every shell command, including the install that would bring it. It shows a `SessionStart` hook that installs the locked copy first, a layout for repositories without `package.json` in the root, and what to do in cloud sessions or when already locked out.
- `init` warns when it finds Python tools that the default policy also blocks building packages from source, so a package without wheels stops installing; run `doctor` before `apply`.
- The README recommends `--save-exact` and says what depcurfew does not do: it has no malware database, so use it together with a tool that blocks known malware.

### Fixes from the review before the release

- `apply` now considers every npm the repository runs: the pinned one, the npm that CI jobs and Dockerfiles install, and the npm that the declared Node.js versions bring (in a repository with `projects`, also the root's `.nvmrc`, `.node-version` and `.tool-versions` for projects without their own). If one of them is npm 11.16 to 11.x and install scripts are denied, it writes `strict-allow-scripts=true` (warning `strict-allow-scripts-for-npm-in-use`; with npm 12 an unreviewed script then fails the install instead of being skipped with a warning). `doctor` counts script blocking as the files stand, so the version it recommends really blocks them.
- `npm install -g <another package>` in CI or a Dockerfile no longer counts as a project install (npm ignores the project `.npmrc` in global mode). pnpm, Yarn and Bun installs in CI jobs count for `runtime-end-of-life`. In a repository with `projects`, a root CI job that installs with `working-directory` in a project is checked with that project's settings.
- Workflows and Dockerfiles from a pull request can no longer crash or stall `doctor` and the Action: large matrices are capped with a notice, the command and Dockerfile readers run in linear time, and `ARG` values are limited in size. A here-document marker inside quotes no longer swallows the rest of a Dockerfile. Identical findings are reported once, and findings at one place that differ only in numbers are capped with a count.
- `apply` checks again, right before writing, that no directory on the way to a file was replaced by a symlink that leads out of the repository.
- The Claude Code hook takes its policy from the project (`CLAUDE_PROJECT_DIR`) when the working directory is inside it, so a `depcurfew.json` in a vendored repository or package folder cannot relax it. The MCP server's `directory` argument cannot relax it either. Warnings without a decision (a deprecated version) reach Claude as context, and registry text is quoted and marked as data, with invisible format characters shown escaped.
- Node.js before 18 (npm 8 or older, which runs every install script) is no longer taken for an npm that blocks scripts: depcurfew knows the npm of every Node.js release, and an npm it cannot tell counts as running scripts (`scripts-not-enforceable`, and `lockfile-install-scripts` reports the packages). A Dockerfile `COPY` source is resolved from the build context as Docker does, so `COPY frontend/../ .` belongs to the root. A project inherits each root Node.js version file (`.nvmrc`, `.node-version`, `.tool-versions`) that it lacks, and `explain` shows what a project takes from the root.
- `check_packages` works on every Node.js that `engines` allows (it used `AbortSignal.any`, which needs Node.js 18.17 or 20.3).
- With `--json`, a usage error (an unknown option, `check` without a package, `--json` with `--sarif`) is a JSON document with `errors` on stdout, exit code 2, and stderr stays empty. `explain --json` warnings have `level`, `location` and `fix`, and an invalid project makes `explain` exit with 1.
- `doctor --user` warns when a tool in `PATH` is too old for the user policy instead of reporting no problems. In a project, bot files of a listed project are a note (bots read their configuration only from the repository root), and a project without a Dependabot entry for its directory is a warning.
- The "depcurfew doctor" check no longer keeps annotations of an earlier run with different findings: it replaces that entry. A symlink loop in the repository no longer crashes the Action.
- The Claude Code hook and `depcurfew mcp` apply the project's `depcurfew.json` and a nearer one together (the stricter answer counts) also when the project is not a git repository; when the project root has no policy, the nearest one applies alone, as in 1.2.0.
- A hook event that is not a JSON object, or a Bash, PowerShell or Monitor call without a readable command, now blocks the call (exit code 2) instead of letting it through.
- `check`, the hook and `check_packages` read `.npmrc` where npm reads it, so a listed project's own `.npmrc` counts. An `.npmrc` elsewhere, or a registry in `.yarnrc.yml`, `bunfig.toml` or uv's files, that names another registry than the one depcurfew checked makes the packages it applies to `unverified` (the hook asks); the fix says to pass `--registry` or `--index` to the hook command, `depcurfew mcp` or `check` when you trust that registry.
- The hook reads installs hidden in a `trap`, an alias defined in the command, grouped `env -S` options, `sudo -s`, `. npm …`, an interpreter that runs a package manager's script (`node /usr/bin/npm`, `node .yarn/releases/yarn-*.cjs`, `python3 -m pip.__main__`), and commands after a here-document with CRLF line endings.
- The hook asks when the command itself weakens the policy, also for `npm ci`: a shorter release-age delay (`--min-release-age=0`, `--before`, `UV_EXCLUDE_NEWER`), install scripts turned on where the policy denies them (`--ignore-scripts=false`, `npm_config_ignore_scripts=false`, `bun add --trust`), or a configuration or `package.json` change before an install (`npm config set registry … && npm ci`, `npm pkg set …`). `config get`, `config list`, an equal or longer delay and `--ignore-scripts` pass.
<!-- D-118 -->
- `doctor` checks the npm that a CI job or Dockerfile installs (`npm install -g npm@X`, also ranges such as `npm@^11.10.0`) for the project it installs in; `npm@latest` and `npm@${VAR}` count as an npm that may run every install script, in `doctor` and `apply` alike. A place that installs only with `npm ci` no longer needs a release-age setting, and one that installs with `--ignore-scripts` or `npm_config_ignore_scripts=true` no longer needs script blocking. Fixes no longer suggest an npm that cannot run on that Node.js.
- `doctor` reads job containers (`container: node:20`), `cd <dir> &&` before an install, `lts/-1` in `.nvmrc`, Poetry installed with `pipx install poetry==X`, and pip installs in Dockerfiles<!-- D-115 CI --> without `PIP_UPLOADED_PRIOR_TO`.
- `init` skips git submodules, and `apply` and `doctor` refuse them as projects (`project-is-repository`). `doctor frontend` and the Action's `directory: frontend` use the root policy when it lists the directory in `projects`.
- New `doctor` rule `lockfile-out-of-date` (warning): a `uv.lock` or `pdm.lock` locked with other settings than the project has now, for example after `apply` changed `exclude-newer`. `apply` warns about a Renovate `packageRules` entry with a shorter delay (`bot-rule-shortens-delay`) and about Yarn's `enableScripts: true` (`allow-all-replaced`).
- `config-drift` reports every changed place in a file, rules that did not run because the policy is invalid show as skipped, and a Renovate file depcurfew cannot read is a note instead of a passed check. Notes have a level, a code and a fix in JSON and start with `note` in the text; syntax errors and `depcurfew.json` problems point at their line and column; `doctor --user` shows user-file drift with its line and the expected value.
- `explain` shows, for each tool, what `installScripts` and `sources` mean before `apply`: the setting `apply` writes and its file, or why the tool cannot enforce it, with the same warning code and fix as `apply`. `explain --json` has them in `policy.installScripts`, `policy.sources` and per project.
- Smaller fixes: configuration files are read only as regular files of at most 1 MiB, so a named pipe in place of `~/.npmrc` no longer hangs `check`, the hook or `mcp`; registry documents with more than 100,000 versions are not checked, and two policies share each lookup; usage errors print as `error: … (usage)` with a fix, and an unknown `--hook` or a `--registry` or `--index` that is not an http(s) URL is a usage error (exit code 2); fixes given to agents tell them to ask the user; PyPI yank reasons are quoted, and line separators and Hangul fillers are escaped; `apply`'s diff hides the `.npmrc` client `key`; `apply --user` without a home directory reports `home-missing`; `doctor --user` calls Yarn 1.x Yarn Classic; `doctor: {}` counts as the default; `depcurfew-outdated` also reads `.claude/depcurfew`; the Action names an `http://` `GITHUB_API_URL`; `apply` removes an empty `[installer]` table it created in `poetry.toml`.

### Compatibility

- depcurfew runs on Node.js 18.3.0 or later (it needed 22 before); CI runs every command on the oldest supported version. Node.js 18 and 20 no longer get security fixes from the Node.js project.
- With `FORCE_COLOR` and `NO_COLOR` both set, and on Node.js 18 before 18.17 for `check`, Node.js no longer prints its own warnings to stderr, which stays empty with `--json`.

### Upgrading from 1.2.0

- Run `depcurfew apply` again after the upgrade. 1.3.0 knows which npm each Node.js release brings and writes `strict-allow-scripts=true` where an npm 11.16 to 11.x runs and install scripts are denied; until then `doctor` reports `config-drift`.
- `doctor` checks more than 1.2.0 did, so a repository that passed can get new findings: a CI job or Dockerfile stage that resolves packages (`npm install`, not `npm ci`) with an npm that has no release-age delay (Node.js 20 and 22 come with npm 10) is `manager-version-too-old` (error), and a `uv.lock` or `pdm.lock` locked before `apply` changed the delay is `lockfile-out-of-date` (warning).
- The hook may ask where 1.2.0 allowed: when the install would use another registry than the one depcurfew checked, or when the command itself weakens the policy.
- Use the same depcurfew version everywhere: on developer machines, in the `npx` cache, in the Action (pinned by commit SHA) and in the hook (`node_modules/depcurfew` or `.claude/depcurfew`). 1.2.0 `apply` rewrites the managed block without the lines 1.3.0 adds, and 1.3.0 `doctor` then reports them again.
- A policy with the `doctor` section, which `init` now writes, or with `projects` needs depcurfew 1.3.0: 1.2.0 rejects it as an unknown field (`invalid-policy` in `doctor` and the Action, `ask` in the hook).

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

- `doctor` and `doctor --user` say below the result what they checked: the package managers and bots found, with the version they checked against, the files read, and every check in plain words with its result (passed, the problems it found, or skipped because it needs a policy that is missing). `--json` has the same in the new `checked` field.
- The GitHub Action prints the same in the log, adds a "What was checked" table to the job summary and, when there is nothing to report, a notice with the list of checks, so a clean run no longer looks like one that did nothing.
- The GitHub Action adds the check "depcurfew doctor" to the commit, shown next to the code scanning entry in the Checks tab of a pull request, with the result as its title ("No problems found (13 checks: 13 passed)") and the table of checks and findings. It needs `checks: write` in the job's permissions; without it, or with `check-run: false`, the step only says so in the log. On a pull request it goes on the head commit.

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
