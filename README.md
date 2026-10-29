# depcurfew

One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, Renovate and Dependabot, and a doctor that finds configuration that silently does nothing.

## Why

Package managers and update bots now each protect you against freshly published malicious versions: a release-age delay, an allow-list for install scripts, limits on git and tarball dependencies. Each tool names these settings differently, counts time in its own unit, reads them from its own files and supports them only from some version on. A setting can also look right and do nothing, for example because CI pins an older version of the package manager, or because a bot proposes versions the package manager would refuse.

depcurfew keeps one policy file, `depcurfew.json`, writes it into the configuration of every tool in the repository, and checks that the result really works.

## Five-minute start

1. `npx depcurfew init` writes `depcurfew.json` with the default policy below and lists the tools it detected.
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
git clone https://github.com/depcurfew/depcurfew.git
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
| `installScripts` |  |  | Dependency lifecycle scripts. |
| `installScripts.default` | `"allow"`, `"deny"` |  | Whether dependency lifecycle scripts (preinstall, install, postinstall) run by default. |
| `installScripts.allow` |  | `[]` | Packages whose lifecycle scripts may run when the default is "deny". |
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
| `depcurfew init [directory] [--force]` | Writes `depcurfew.json` with the default policy; `--force` overwrites an existing one. |
| `depcurfew explain [directory] [--json]` | Describes the detected package managers, versions, bots and workspaces, and the policy values for each tool. |
| `depcurfew apply [directory] [--dry-run]` | Writes the policy into the configuration of every target tool; `--dry-run` prints a unified diff instead. |
| `depcurfew doctor [directory] [--json \| --sarif]` | Finds configuration that silently does not work and drift from the policy; `--sarif` prints SARIF 2.1.0 for code scanning. |

Exit codes: `0` success (warnings included), `1` an error (an invalid policy, a file that cannot be edited, a doctor finding with level error), `2` a usage error. `depcurfew <command> --help` describes a command with examples and its exit codes.

Every finding and warning says what to do about it. Text for people is colored on a terminal; `NO_COLOR=1` turns colors off and `FORCE_COLOR=1` turns them on, for example in a CI log that shows them. `--json`, `--sarif` and a diff written to a file stay plain, for programs and AI agents.

How `apply` edits files:

- It keeps comments, formatting, line endings and key order. In line-based files (INI, TOML) it writes a block between `# >>> depcurfew managed block` and `# <<< depcurfew managed block` markers and comments out older copies of the settings it manages; in YAML it marks the keys it writes with `# managed by depcurfew`; JSON files keep their comments and indentation.
- It never removes settings it does not manage. Allow-lists are only added to; exception lists follow the policy.
- If any file cannot be edited, nothing is written.
- It does not create bot configuration files; it creates a package manager's configuration file when it is missing.

## Supported tools

What depcurfew configures and checks for each tool, from its [knowledge base](docs/knowledge.md), where every value links to the official documentation or changelog it was verified against.

<!-- BEGIN GENERATED: tools -->
| Tool | Release-age delay | Exceptions | Install-script allow-list | Dependency sources | Verified |
| --- | --- | --- | --- | --- | --- |
| npm | `min-release-age` in `.npmrc` (days), since 11.10.0 | `min-release-age-exclude`, since 11.17.0 | `allowScripts` in `package.json` | git: `allow-git`<br>remote tarball: `allow-remote`<br>local tarball: `allow-file`<br>local directory: `allow-directory` | 2026-10-28 – 2026-10-29 |
| pnpm | `minimumReleaseAge` in `pnpm-workspace.yaml` (minutes), since 10.16.0 | `minimumReleaseAgeExclude`, since 10.16.0 | `allowBuilds` in `pnpm-workspace.yaml` | git: `blockExoticSubdeps`<br>remote tarball: `blockExoticSubdeps` | 2026-10-28 – 2026-10-29 |
| Yarn (Berry) | `npmMinimalAgeGate` in `.yarnrc.yml` (minutes), since 4.10.2 | `npmPreapprovedPackages`, since 4.10.0 | `dependenciesMeta.<package>.built` in `package.json` | git: `approvedGitRepositories` | 2026-10-28 – 2026-10-29 |
| Bun | `install.minimumReleaseAge` in `bunfig.toml` (seconds), since 1.3.0 | `install.minimumReleaseAgeExcludes`, since 1.3.0 | `trustedDependencies` in `package.json` | none | 2026-10-28 – 2026-10-29 |
| Deno | `minimumDependencyAge` in `deno.json`, `.npmrc` (minutes), since 2.5.5 / 2.6.0 ⚠️ | `minimumDependencyAge.exclude`, since 2.5.5 | `allowScripts` in `deno.json` | none | 2026-10-28 – 2026-10-29 |
| Renovate | `minimumReleaseAge` in `renovate.json`, `renovate.jsonc` … (duration string), since 35.46.0 | `packageRules: matchPackageNames + minimumReleaseAge: null`, since 35.46.0 ❓ | none | n/a | 2026-10-28 |
| Dependabot | `cooldown` in `.github/dependabot.yml`, `.github/dependabot.yaml` (days), since 2025 07 01 | `cooldown.exclude`, since 2025 07 01 ❓ | none | n/a | 2026-10-28 |

⚠️ official sources disagree (depcurfew takes the safer reading) · ❓ official sources are incomplete. Every value with its source: [docs/knowledge.md](docs/knowledge.md).
<!-- END GENERATED: tools -->

Yarn Classic (1.x) is detected but not supported.

## doctor rules

Findings have a level: an **error** makes `depcurfew doctor` exit with 1, a **warning** or a **note** does not. Things doctor could not check (a binary lockfile, a lockfile format without install-script data, a missing policy) are listed as notes after the findings, not as findings.

<!-- BEGIN GENERATED: rules -->
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

Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages, and pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy.

Fix: Keep security settings out of .npmrc files that are ignored or that override the policy; set them through depcurfew.json and depcurfew apply.

### `pnpm-shared-workspace-lockfile`

**warning** · pnpm 10 without a shared lockfile lets a package .npmrc change the release-age delay.

With sharedWorkspaceLockfile: false, pnpm 10 installs every workspace project separately with that project's own .npmrc layered over the workspace settings (read from the pnpm 10 source code), so a setting such as minimum-release-age=0 in a package .npmrc applies to that package.

Fix: Remove security settings from package .npmrc files, or keep the default shared lockfile.

### `config-drift`

**error** · needs depcurfew.json · A configuration file does not match what depcurfew apply writes for depcurfew.json.

A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy.

Fix: Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.

### `bot-cooldown-mismatch`

**error** · An update bot waits less than the package manager before proposing a new version.

The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile.

Fix: Give the bot a delay at least as long as the package manager's (depcurfew apply does this).

### `broad-exclusion`

**error** · An exception list matches every package, which turns the protection off.

A release-age exception such as "*" (or a policy allow-list entry such as "@*/*") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies.

Fix: Replace the pattern with the packages or scopes that really need the exception.

### `lockfile-forbidden-source`

**error** · needs depcurfew.json · The lockfile installs a package from a source depcurfew.json denies.

A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.

Fix: Replace the dependency with a registry version, or allow that source in depcurfew.json.

### `lockfile-install-scripts`

**error** · needs depcurfew.json · The lockfile has packages with install scripts that depcurfew.json does not allow.

Install scripts run arbitrary code during installation. Where the package manager runs them by default, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile.

Fix: Remove or replace the package, or add it to installScripts.allow in depcurfew.json after reviewing its scripts.

### `unreadable-config`

**error** · A configuration file or lockfile cannot be read, parsed or edited, so depcurfew cannot check it.

A package manager or bot may still read the file and its settings may weaken the policy; depcurfew fails closed and reports an error instead of passing silently.

Fix: Fix what the message describes: invalid syntax, a symlink, a file over the size limit or a style depcurfew apply cannot edit.
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
      - uses: depcurfew/depcurfew@<full-commit-sha> # pin a commit, not a tag
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

## Library

The same functions are available from the package: `detectProject`, `planApply` and `applyProject`, `runDoctor` with `toSarif`, and the policy parser and converters. See `src/index.ts`.

## Contributing

Facts about package managers live only in `src/knowledge/`, each with the official URL it was verified against and the date. A correction is welcome with a link to the official documentation or changelog. `npm test` builds the project and runs every test without network access.

## License

[MIT](LICENSE)
