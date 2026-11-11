# Contributing to depcurfew

depcurfew is a security tool: it writes the supply-chain settings of package managers and bots from one policy and reports configuration that silently does nothing. A change that makes it report "fine" for something that is not fine is worse than no change, so the rules below are strict.

## Before you start

- Open an issue first for anything larger than a fix of a few lines: another package manager, a new check, a new option. The issue forms ask for what is needed, above all links to the official documentation of the tool.
- Ask questions in [Discussions, Q&A](https://github.com/DevXord/depcurfew/discussions/categories/q-a) and talk over ideas in [Discussions, Ideas](https://github.com/DevXord/depcurfew/discussions/categories/ideas); issues are for bugs, wrong results and features.
- Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in an issue or a pull request.
- Identifiers such as D-099 in code comments and in the notes of the knowledge base point to internal notes of the maintainer, which are not in the repository.

## Setting up

Work on the repository needs Node.js 22.18 or later: the scripts in `scripts/` run from `.ts` files without a build step, and relative imports end in `.ts`. Users of the CLI need only the Node.js range in `engines` of `package.json`.

```bash
npm ci
npm test
```

| Command | What it does |
| --- | --- |
| `npm test` | builds with tsdown and runs the tests with Vitest, including the before and after fixtures |
| `npm run typecheck` | type checks with tsc, without emitting |
| `npm run check:pkg` | checks the package with publint and @arethetypeswrong/cli |
| `npm run docs:knowledge` | writes `docs/knowledge.md` from `src/knowledge/` |
| `npm run docs:readme` | rewrites the generated sections of `README.md` |
| `npm run schema` | writes `schema.json` from the policy definition in `src/policy/schema.ts` |
| `npm run build:action` | builds `action/depcurfew.mjs`, which is committed and must match the source |
| `npm run site` | builds the documentation site into `dist-site/` from `README.md`, `src/knowledge/` and `schema.json` (not committed) |
| `npm run site -- --versions` | the same, plus the documentation of every earlier release tag under `/<version>/` and a Versions page; reads the tags with git, as the workflow in `site/org-repo/` does for [depcurfew.github.io](https://depcurfew.github.io/) |

To try a change by hand: `node dist/cli.js explain tests/fixtures/repos/<name>`, `node dist/cli.js doctor tests/fixtures/doctor/<rule>/<case>/repo` (also with `--json` and `--sarif`) and `node dist/cli.js apply --dry-run <directory>`.

## Rules

- **Dependencies.** At run time depcurfew depends on `yaml` only, and everything else is written in the repository. Any new dependency, also a development one, needs agreement in an issue first, and the pull request says why it is needed.
- **Facts about package managers** (option names, files, units, versions, defaults) live only in `src/knowledge/`. Every entry has a `source` (the official documentation, source code at a release tag, or a changelog) and a `verifiedAt` date, and is checked at that source, never written from memory. Tests fail on an entry without a source.
- **Units** are converted towards the longer delay.
- **Editing other tools' files.** `apply` keeps comments and formatting, marks the parts it manages, never removes a setting it does not manage, and a second `apply` without a change of the policy changes no file.
- **Code.** ESM only, no top-level await.
- **Tests.** Write the test first (a fixture and the expected result), then the change. Tests use no network; recorded registry answers and repository fixtures live in `tests/fixtures`. Tests remove what they create, also when run with `-t`. A test that needs root (to give files to another user, or to work in the home directory of another user) is gated on `asRoot` from `tests/support/platform.ts` and on nothing else: CI runs every file that imports it as root, in the job `root` of `.github/workflows/ci.yml`, whose list a test keeps complete.

## Messages and output

- Every error and warning says what is wrong, where (file and line when known) and what to do (`fix` in `doctor`, a hint in `apply` and `check`), in plain English, with file and setting names written as they are.
- The level (`error`, `warning`, `note`) is always written as a word; color is used only on a terminal, with `NO_COLOR` and `FORCE_COLOR` respected.
- Every command that reports something has machine output (`--json`, and `--sarif` for `doctor`) with `schemaVersion`, a rule or code, the level, the location, `message` and `fix`. Only JSON goes to stdout, also for an invalid policy. Text and JSON come from one source.
- New fields, values and rules are added without changing `schemaVersion`; a removed field or a changed meaning needs a new `schemaVersion`. Exit codes are described in `--help` and keep their meaning. The codes of `apply` live in `src/apply/warnings.ts` and in the README.

## Pull requests

- Describe what the change does for users, why, and its consequences.
- Regenerate the generated files (the commands above) and add user-facing changes to `CHANGELOG.md`.
- The pull request template lists the checks that have to pass.
