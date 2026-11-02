# depcurfew.github.io

This repository publishes the documentation site of [depcurfew](https://github.com/DevXord/depcurfew) at https://depcurfew.github.io/. It holds no documentation of its own: every page is built from the main repository, https://github.com/DevXord/depcurfew.

## How it updates

The workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs once a day and by hand (Actions, Pages, Run workflow). It finds the published release of the main repository with the highest version (a pre-release only while there is no release), checks out its tag with every tag, and runs `npm ci --ignore-scripts` and `npm run site -- --versions`. The result is deployed to GitHub Pages: the current release at the root, each earlier release from 1.1.0 on under `/<version>/`, and the JSON Schema at `/schema.json` and `/schema/v1.json`. A new release therefore appears within a day, or at once when the workflow is run by hand. The site needs depcurfew 1.4.0 or later, the first release with `npm run site`: while the latest release is older, every run stops at "Find the latest release" with an error that names that release, and nothing is deployed.

The main repository is named once, in `SOURCE_REPOSITORY` at the top of the workflow. If it moves, change that value and the `repository` field of its `package.json`, which the site uses for its links to files on GitHub.

## Changing this repository

The files of this repository are kept in the main repository under `site/org-repo/`, where tests check the workflow, and are copied here by hand. Change them there first. Issues and pull requests about the documentation belong in the main repository: its README, `docs/knowledge.md` and the generator in `scripts/site/` are the sources of every page.

Settings this repository needs: Settings, Pages, Build and deployment, Source "GitHub Actions". In a public repository GitHub disables a scheduled workflow after 60 days without activity in the repository; enable it again under Actions, or run it by hand.
