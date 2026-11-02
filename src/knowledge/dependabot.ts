import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const python = verifiedOn('2026-10-30');
const review = verifiedOn('2026-10-31');
const projects = verifiedOn('2026-11-01');
const bots = verifiedOn('2026-11-02');
const composer = verifiedOn('2026-11-02');

const OPTIONS = 'https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference';
const COOLDOWN_GA = 'https://github.blog/changelog/2025-07-01-dependabot-supports-configuration-of-a-minimum-package-age/';
const DEFAULT_COOLDOWN = 'https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown/';
const CORE = 'https://github.com/dependabot/dependabot-core/blob/main';

export const dependabot: ToolKnowledge = {
  id: 'dependabot',
  name: 'Dependabot',
  kind: 'update-bot',
  cooldown: {
    setting: verified(
      'cooldown',
      `${OPTIONS}#cooldown`,
      'Per updates entry: default-days, semver-major-days, semver-minor-days, semver-patch-days, include, exclude. The semver-* keys apply only to SemVer ecosystems.',
    ),
    configFiles: verified(
      ['.github/dependabot.yml', '.github/dependabot.yaml'],
      'https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file',
      'On the default branch.',
    ),
    cliFlag: uncertain(
      null,
      'https://github.com/dependabot/cli',
      'Cooldown is configured only in dependabot.yml; the Dependabot CLI README mentions no such flag.',
    ),
    unit: verified('days', `${OPTIONS}#cooldown`, 'Integer days; the allowed range is disputed (see dayRange).'),
    availableSince: verified('2025-07-01', COOLDOWN_GA, 'GA date on github.com; NuGet and Helm since 2025-07-29.'),
    default: verified(
      [
        { since: '2025-07-01', value: null },
        { since: '2026-07-14', value: 3 },
      ],
      DEFAULT_COOLDOWN,
      'Version updates wait 3 days even without a cooldown block (GHES from 3.23); default-days is also 3 when cooldown is set without it.',
    ),
    exclude: {
      setting: verified('cooldown.exclude', `${OPTIONS}#cooldown`),
      availableSince: uncertain('2025-07-01', COOLDOWN_GA, 'Presumably shipped with cooldown GA; not confirmed separately.'),
      patternSyntax: verified(
        'Dependency names with * wildcards, up to 150 entries; exclude always wins over include',
        `${OPTIONS}#cooldown`,
      ),
    },
    securityUpdates: verified(
      'bypass',
      `${OPTIONS}#cooldown`,
      'Cooldown exists only for version updates. dependabot-core also passes a zero age to npm, pnpm and Yarn for security updates, overriding repository gates.',
    ),
  },
  installScripts: {
    defaultPolicy: uncertain(
      [{ since: '0.0.0', value: 'deny' }],
      `${CORE}/npm_and_yarn/lib/dependabot/npm_and_yarn/helpers.rb`,
      'From dependabot-core source, not the docs: npm, Yarn and Bun lockfile updates run with scripts disabled; for pnpm only --lockfile-only was found. bundler, mix and pip may execute external code.',
    ),
    allowList: {
      setting: verified(
        null,
        `${OPTIONS}#insecure-external-code-execution`,
        'insecure-external-code-execution: allow exists only for bundler, mix and pip; nothing allows npm, pnpm, Yarn or Bun scripts.',
      ),
    },
    disableAll: uncertain(
      null,
      `${OPTIONS}#insecure-external-code-execution`,
      'Nothing to configure for JavaScript ecosystems: scripts are always disabled (source code). For bundler, mix and pip, external code execution is disabled automatically when registries are configured.',
    ),
  },
  extra: {
    configLocation: projects.verified(
      { from: 'repository-root', branch: 'default' },
      'https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file',
      '"You must store this file in the .github directory of your repository in the default branch (typically main), at .github/dependabot.yml or .github/dependabot.yaml" (github/docs, content/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file.md, read 2026-11-01), so a .github/dependabot.yml in a subdirectory is not read.',
    ),
    directories: projects.verified(
      { keys: ['directory', 'directories'], relativeTo: 'repository-root', globsIn: 'directories' },
      'https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#directories-or-directory',
      'Required in each updates entry: directory for one directory of manifests, directories for a list; "Define directories relative to the root of the repository for most package managers"; "The directories key supports globbing and the wildcard character *. These features are not supported by the directory key." How a glob matches is not described further (github/docs, content/code-security/reference/supply-chain-security/dependabot-options-reference.md, read 2026-11-01).',
    ),
    yamlMergeKeys: review.uncertain(
      false,
      'https://github.com/dependabot/dependabot-core/pull/9653',
      'Not known. The options reference does not mention YAML anchors or merge keys, GitHub parses dependabot.yml in its own service, and the dependabot-core pull request that would allow aliases ("we can\'t use the YAML anchor (aliases) feature in dependabot.yml file") is still open and marked stale (read 2026-10-31). depcurfew reads dependabot.yml without merge keys: a cooldown that an entry would get only through <<: *defaults counts as missing, which bot-cooldown reports, and depcurfew apply writes the cooldown into the entry itself, which wins over merged keys where they apply.',
    ),
    cooldownKeys: verified(
      { days: 'default-days', exclude: 'exclude', semverDays: ['semver-major-days', 'semver-minor-days', 'semver-patch-days'] },
      `${OPTIONS}#cooldown`,
      'Keys inside the cooldown block of an updates entry; the semver-* keys override default-days for that kind of update.',
    ),
    excludeWildcards: verified({ since: '0.0.0', trailingOnly: false }, `${OPTIONS}#cooldown`, 'cooldown.exclude accepts * wildcards.'),
    cooldownInclude: python.verified(
      { key: 'include', everything: '*' },
      'https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates#setting-up-a-cooldown-period-for-dependency-updates',
      'An include list in the cooldown block limits the cooldown to the dependencies it names (* wildcards, up to 150 entries): the example applies the cooldown to requests, numpy and names starting with pandas or django, and to cover all dependencies one omits include or uses "*". The other dependencies get no cooldown at all, not even the default 3 days: dependabot-core skips the cooldown for a dependency that the include list does not match (ReleaseCooldownOptions#included? with File.fnmatch? and CooldownCalculation.skip_cooldown? in common/lib/dependabot, commit 03892a3e8ee26d43eb96f31c5136c98a85d63b14). exclude wins over include.',
    ),
    ecosystems: composer.verified(
      { npm: ['npm', 'pnpm', 'yarn'], bun: ['bun'], deno: ['deno'], pip: ['pip', 'poetry', 'pipenv'], uv: ['uv'], composer: ['composer'] },
      `${OPTIONS}#package-ecosystem`,
      'The npm ecosystem covers npm, pnpm and Yarn; bun needs Bun 1.1.39 or later and deno needs Deno 2. pip covers pip, pip-compile, pipenv and Poetry (v2); uv has its own ecosystem (the table lists uv v0.11). composer covers Composer v2. Cooldown, including the semver-* keys, is supported for all of them (the cooldown table of the same page lists Composer with default and SemVer-bump days, read 2026-11-02). PDM is not listed: dependabot-core skips the dependencies of pyproject.toml when pdm.lock exists (python/lib/dependabot/python/file_parser/pyproject_files_parser.rb at v0.402.0).',
    ),
    githubActions: bots.verified(
      { ecosystem: 'github-actions', semverDays: false },
      `${OPTIONS}#cooldown`,
      'package-ecosystem github-actions updates the actions the workflows run: with directory / Dependabot "will search the /.github/workflows directory, as well as the action.yml/action.yaml file from the root directory". The cooldown table lists GitHub Actions with default-days supported and the semver-major-days, semver-minor-days and semver-patch-days keys not supported, and the default cooldown of 3 days covers version updates without a cooldown block (github/docs, content/code-security/reference/supply-chain-security/dependabot-options-reference.md, main on 2026-11-02).',
    ),
    actionsReleaseDate: bots.uncertain(
      'the publication date of the GitHub release of the tag, else the date of the tag, else the date of the commit; with no date the update does not wait',
      'https://github.com/dependabot/dependabot-core/blob/v0.402.0/github_actions/lib/dependabot/github_actions/update_checker/latest_version_finder.rb',
      'Read from the code, not the docs. A proposed commit SHA is aged by published_at of the GitHub release of its tag, else the creatordate of the tag (git for-each-ref), else the commit date; version tags by the creatordate of each tag (refs_for_tag_with_detail in common/lib/dependabot/git_metadata_fetcher.rb), which is the tagger date of an annotated tag and the commit date of a lightweight one, both set in git by whoever makes them. Only default-days counts. A missing or unreadable date lets the update through (check_if_version_in_cooldown_period? returns false).',
    ),
    dayRange: disputed(
      'Matters for opting out of the default cooldown; cooldown.exclude: ["*"] works under the documented precedence rule either way. The announcement does not state its author\'s role.',
      evidence('1 to 90 days', 'https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates'),
      evidence('0 removes the cooldown', 'https://github.com/dependabot/dependabot-core/discussions/15582'),
    ),
    maximumDays: verified(
      90,
      'https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates',
      'The page says the number of cooldown days must be between 1 and 90; whether 0 is accepted is disputed (see dayRange).',
    ),
    missingPublishDate: verified(
      'Updates proceed when the registry gives no publication date (fail open); for Docker only Docker Hub tag_last_pushed is used',
      `${CORE}/docker/README.md`,
    ),
    transitiveGating: uncertain(
      'Regular updates pass the cooldown to npm (11.10+), pnpm (10.16+) and Yarn Berry to hold back transitive dependencies; the Bun updater passes none',
      `${CORE}/npm_and_yarn/lib/dependabot/npm_and_yarn/file_updater/npm_lockfile_updater.rb`,
      'Read from dependabot-core source.',
    ),
    composerReleaseTime: composer.verified(
      { field: 'time', ignores: 'published-time', composerVersion: '2.10.3' },
      'https://github.com/dependabot/dependabot-core/blob/v0.402.0/composer/lib/dependabot/composer/package/registry_package.rb',
      'For composer, the cooldown compares the release date with released_at, which parse_release takes from the time field of each version in the Packagist metadata: the date the package author sets, not published-time, the date Packagist received the version. Seen on 2026-11-02: intercom/intercom-php 5.0.2 has time 2026-01-30 and published-time 2026-04-30 (repo.packagist.org/p2/intercom/intercom-php.json). The updater runs Composer 2.10.3 (ARG COMPOSER_V2_VERSION in composer/Dockerfile at v0.402.0), which has no cooldown policy of its own.',
    ),
    semverKeysScope: verified(
      'semver-major/minor/patch-days apply only to SemVer ecosystems such as npm, Bun and Deno; others use default-days',
      `${OPTIONS}#cooldown`,
    ),
  },
};
