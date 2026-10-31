# Changelog

All notable changes for users of depcurfew. The project follows [semantic versioning](https://semver.org/): the policy file (`version: 1`), the command-line options, the exit codes and the JSON and SARIF output (`schemaVersion: 1`) only change in a backward-incompatible way in a new major version.

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
