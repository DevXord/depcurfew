# Changelog

All notable changes for users of depcurfew. The project follows [semantic versioning](https://semver.org/): the policy file (`version: 1`), the command-line options, the exit codes and the JSON and SARIF output (`schemaVersion: 1`) only change in a backward-incompatible way in a new major version.

## 1.0.0

The first release.

### One policy for every tool

- `depcurfew.json` holds one supply-chain policy: a release-age delay with exceptions (`cooldown`), an allow-list for install scripts and, for Python, for packages built from source (`installScripts`), and the dependency sources you allow (`sources`). Python packages are named with the `pypi:` prefix.
- `depcurfew init` writes the policy and keeps the longest release-age delay the repository already sets.
- `depcurfew apply` writes the policy into the configuration of npm, pnpm, Yarn (Berry), Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate and Dependabot, converting units and writing only what the pinned version of each tool supports. It keeps comments, formatting and line endings, marks what it manages, never removes settings it does not manage, writes every file or none, and a second run with the same policy changes nothing. `--dry-run` prints a unified diff.
- `depcurfew explain` shows what was detected and what the policy means for each tool.

### A doctor for configuration that silently does nothing

- `depcurfew doctor` reports settings that the pinned tool version ignores, configuration that overrides the policy, bots that wait less than the package manager, exceptions that cover everything, lockfile entries from forbidden sources or with install scripts, drift from the policy and files it cannot read. Every finding says what is wrong, where and what to do.
- Text, `--json` and `--sarif` (SARIF 2.1.0) output; the GitHub Action runs doctor on every push and reports to code scanning.

### Guarding installs

- `depcurfew check <package...>` looks packages up in the npm registry or PyPI before you install them: names that do not exist or look like a popular package, versions younger than the delay, install scripts or builds from source the policy does not allow, yanked, deprecated or quarantined versions, and sources the policy denies.
- `depcurfew check --hook claude-code` is a PreToolUse hook for Claude Code (the Bash, PowerShell and Monitor tools) that blocks install commands breaking the policy and asks when it cannot tell what a command installs. It is a safety net, not a sandbox.

### Requirements and limits

- Node.js 22 or later on Linux, macOS and Windows; the library is ESM only (`require()` works from Node.js 22.12).
- Yarn Classic (1.x) is detected but not configured. Renovate configuration in JSON5 gets a snippet to add by hand.
- After `apply` changes settings that a lockfile records (uv, PDM), lock again; `apply` says when.
- Only `check` and the hook use the network; depcurfew has no telemetry.
