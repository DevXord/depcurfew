import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const python = verifiedOn('2026-10-30');
const reviewed = verifiedOn('2026-10-30');
const rules = verifiedOn('2026-10-30');

const AT = 'https://github.com/renovatebot/renovate/blob/44.198.2';

const OPTIONS = 'https://docs.renovatebot.com/configuration-options/';
const MINIMUM_RELEASE_AGE = 'https://docs.renovatebot.com/key-concepts/minimum-release-age/';
const release = (version: string) => `https://github.com/renovatebot/renovate/releases/tag/${version}`;

export const renovate: ToolKnowledge = {
  id: 'renovate',
  name: 'Renovate',
  kind: 'update-bot',
  cooldown: {
    setting: verified(
      'minimumReleaseAge',
      `${OPTIONS}#minimumreleaseage`,
      'Formerly stabilityDays; old configs are migrated to "N days". Can be scoped with packageRules, vulnerabilityAlerts and update types.',
    ),
    configFiles: verified(
      [
        'renovate.json',
        'renovate.jsonc',
        'renovate.json5',
        '.github/renovate.json',
        '.github/renovate.jsonc',
        '.github/renovate.json5',
        '.gitlab/renovate.json',
        '.gitlab/renovate.jsonc',
        '.gitlab/renovate.json5',
        '.renovaterc',
        '.renovaterc.json',
        '.renovaterc.jsonc',
        '.renovaterc.json5',
      ],
      OPTIONS,
      'Searched in this order. The "renovate" key in package.json still works but is deprecated. Shared presets (extends) can also set it.',
    ),
    cliFlag: verified(
      '--minimum-release-age',
      `${OPTIONS}#minimumreleaseage`,
      'Self-hosted CLI only; environment variable RENOVATE_MINIMUM_RELEASE_AGE.',
    ),
    unit: verified(
      'duration-string',
      MINIMUM_RELEASE_AGE,
      'For example "3 days" or "14 days". Since 42.19.5 "0 days" is treated like null.',
    ),
    availableSince: verified('35.46.0', release('35.46.0'), 'Earlier versions had the same feature as stabilityDays (first version not tracked).'),
    default: verified(
      [{ since: '0.0.0', value: null }],
      'https://github.com/renovatebot/renovate/blob/main/lib/config/options/index.ts',
      'Off unless configured; the docs table shows no default. config:best-practices adds "3 days" for npm (see presets). Since 44.96.0 minimumReleaseAgeBuffer adds 30 minutes once a delay is set.',
    ),
    exclude: {
      setting: verified(
        'packageRules: matchPackageNames + minimumReleaseAge: null',
        `${MINIMUM_RELEASE_AGE}#how-do-i-opt-out-dependencies-from-minimum-release-age-checks`,
        'No dedicated exclusion list.',
      ),
      availableSince: uncertain(
        '35.46.0',
        release('35.46.0'),
        'Assumed to work since the option exists with packageRule scope; not stated by a release note.',
      ),
      patternSyntax: verified(
        'matchPackageNames: exact names, globs such as @org/** (with ! negation) or /regex/; case-insensitive',
        `${OPTIONS}#matchpackagenames`,
        'Glob and regex patterns since 38.0.0.',
      ),
    },
    securityUpdates: verified(
      'bypass',
      `${MINIMUM_RELEASE_AGE}#what-happens-to-security-updates`,
      'The vulnerabilityAlerts defaults set minimumReleaseAge to null; a delay can still be set inside vulnerabilityAlerts.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'deny' }],
      `${OPTIONS}#ignorescripts`,
      'Renovate disables package manager scripts when it updates lockfiles; the Mend-hosted app never runs them.',
    ),
    allowList: {
      setting: uncertain(
        null,
        `${OPTIONS}#ignorescripts`,
        'No per-package allow-list was found: scripts are all or nothing, via allowScripts: true (self-hosted global config) plus ignoreScripts: false.',
      ),
    },
    disableAll: verified(
      'ignoreScripts: true',
      `${OPTIONS}#ignorescripts`,
      'The default; the self-hosted global allowScripts also defaults to false.',
    ),
  },
  extra: {
    durationStrings: verified(
      { since: null, syntax: 'words' },
      'https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md',
      'Values such as "3 days" or "1 hour", parsed by toMs (lib/util/pretty-time.ts).',
    ),
    minimumReleaseAgePresets: verified(
      { presets: ['config:best-practices', 'security:minimumReleaseAgeNpm'], value: '3 days', since: '42.0.0', datasource: 'npm' },
      'https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm',
      'config:best-practices extends security:minimumReleaseAgeNpm, which sets minimumReleaseAge "3 days" for the npm datasource (see presets).',
    ),
    excludeRule: verified(
      { list: 'packageRules', match: 'matchPackageNames', value: null },
      'https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md',
      'The documented opt-out: a packageRules entry with matchPackageNames and minimumReleaseAge: null.',
    ),
    securityUpdatesSetting: verified(
      ['vulnerabilityAlerts', 'minimumReleaseAge'],
      'https://github.com/renovatebot/renovate/blob/main/lib/config/options/index.ts',
      'The vulnerabilityAlerts default sets minimumReleaseAge to null, so security updates skip the delay unless a value is set there.',
    ),
    excludeWildcards: verified(
      { since: '38.0.0', trailingOnly: false },
      `${OPTIONS}#matchpackagenames`,
      'matchPackageNames accepts globs (and regex) since 38.0.0.',
    ),
    ruleDescription: verified(
      'description',
      'https://github.com/renovatebot/renovate/blob/main/docs/usage/configuration-options.md#description',
      'A human-readable description allowed inside any configuration object; depcurfew uses it to recognize the packageRules entry it manages.',
    ),
    packageJsonConfig: verified(
      { file: 'package.json', key: 'renovate' },
      'https://github.com/renovatebot/renovate/blob/main/lib/workers/repository/init/merge.ts',
      'Deprecated: the configuration options page warns that support may be removed, and Renovate logs that using package.json is deprecated.',
    ),
    durationUnits: verified(
      ['hours', 'days'],
      'https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md',
      'Units shown in the docs: minimumReleaseAge=1 hour on this page and "3 days" in the configuration options. The value is parsed by toMs (lib/util/pretty-time.ts), whose tests also accept 1 day, 1 week and combined values.',
    ),
    presets: verified(
      'config:best-practices extends security:minimumReleaseAgeNpm (since 42.0.0): "3 days" and internalChecksFilter "strict" for the npm datasource, except pin, replacement, lockFileMaintenance, bump, lockfileUpdate and rollback',
      'https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm',
    ),
    datasources: python.verified(
      { npm: 'npm', pypi: 'pypi' },
      'https://docs.renovatebot.com/modules/datasource/pypi/',
      'Datasource ids for matchDatasources: npm packages come from the npm datasource and Python packages from pypi, whose release timestamp is the earliest upload_time of the version\'s files.',
    ),
    negativeMatch: python.verified(
      '!',
      'https://docs.renovatebot.com/string-pattern-matching/',
      'Patterns starting with ! are negative matches, and none of them may match; matchDatasources is matched this way (matchRegexOrGlobList in lib/util/package-rules/datasources.ts at 44.198.0), so ["!pypi"] covers every datasource but PyPI.',
    ),
    packageRuleMatching: rules.verified(
      { negation: '!', allPatterns: '*', packageMatchers: ['matchPackageNames', 'matchDepNames'], datasourceMatcher: 'matchDatasources', updateTypeMatcher: 'matchUpdateTypes' },
      `${AT}/docs/usage/configuration-options.md#packagerules`,
      'A packageRules entry applies to a dependency when all of its matchers match. Within one matcher, at least one positive pattern must match when there are any, and no negative pattern (starting with !) may match, so a list of only negative patterns matches every name it does not exclude (docs/usage/string-pattern-matching.md and matchRegexOrGlobList in lib/util/string-match.ts). matchPackageNames, matchDepNames, matchDatasources and matchUpdateTypes all match this way; "*" alone matches everything.',
    ),
    packageRulesOrder: rules.verified(
      { presetsFirst: true, overridesTopLevel: true, laterWins: true },
      `${AT}/docs/usage/configuration-options.md#packagerules`,
      'All packageRules are evaluated and later rules override options set by earlier ones; a matching rule overrides the top-level configuration ("Package rule config overrides any existing config", lib/util/package-rules/index.ts). Presets in extends are merged before the repository configuration, and packageRules is mergeable, so the rules of presets come first and the repository\'s rules after them, while a top-level option of the repository replaces the same option of a preset (resolveConfigPresets in lib/config/presets/index.ts and mergeChildConfig in lib/config/utils.ts).',
    ),
    delayedUpdateTypes: rules.verified(
      ['major', 'minor', 'patch'],
      `${AT}/docs/usage/key-concepts/minimum-release-age.md#which-update-types-take-minimumreleaseage-into-account`,
      'The update types that take minimumReleaseAge into account; digest and pinDigest only for some datasources, and pin, lockFileMaintenance, lockfileUpdate, rollback, bump and replacement not at all.',
    ),
    internalPresets: rules.verified(
      {
        prefixes: [':', 'default:', 'abandonments:', 'config:', 'customManagers:', 'docker:', 'global:', 'group:', 'helpers:', 'mergeConfidence:', 'monorepo:', 'packages:', 'preview:', 'replacements:', 'schedule:', 'security:', 'workarounds:'],
        settingDelay: ['config:best-practices', 'security:minimumReleaseAgeCrate', 'security:minimumReleaseAgeNpm', 'security:minimumReleaseAgePypi'],
      },
      `${AT}/lib/config/presets/internal/index.ts`,
      'The built-in preset groups; a default preset is written :name or default:name. Other presets (github>, gitlab>, local>, npm packages and so on) are fetched from elsewhere. Among the built-in presets only the security:minimumReleaseAge* presets set minimumReleaseAge, each in a packageRules entry with matchDatasources for its datasource, and config:best-practices extends security:minimumReleaseAgeNpm (security.preset.ts and config.preset.ts in the same directory).',
    ),
    pypiPresets: python.verified(
      { presets: ['security:minimumReleaseAgePypi'], value: '3 days', since: '44.8.0', datasource: 'pypi' },
      'https://docs.renovatebot.com/presets-security/#securityminimumreleaseagepypi',
      'Added in 44.8.0; config:best-practices does not include it (it includes only security:minimumReleaseAgeNpm).',
    ),
    pnpmSecurityExclusions: reviewed.uncertain(
      { managers: ['pnpm'], file: 'pnpm-workspace.yaml', setting: 'minimumReleaseAgeExclude', comment: '# Renovate security update: ', versionSeparator: ' || ' },
      'https://github.com/renovatebot/renovate/blob/44.198.2/lib/modules/manager/npm/artifacts.ts',
      'updatePnpmWorkspace: when a security update (vulnerability alert) changes a project with a pnpm lockfile whose pnpm-workspace.yaml sets minimumReleaseAge, Renovate adds the entry <name>@<version> to minimumReleaseAgeExclude with the comment "# Renovate security update: <name>@<version>" on the line above it; a later fix of the same package appends " || <version>" to the entry (and to the comment), and an entry for the package that has no comment gets one. The tests next to it (artifacts.spec.ts) show the written file. No other package manager (npm, Yarn, Bun, Deno) has such code at this tag; read from the code.',
    ),
    pythonManagers: python.verified(
      { uv: 'pep621', poetry: 'poetry', pip: 'pip_requirements', pdm: 'pep621', pipenv: 'pipenv' },
      'https://docs.renovatebot.com/modules/manager/pep621/',
      'pep621 updates pyproject.toml with uv.lock (there is no uv manager) or pdm.lock; poetry updates pyproject.toml with poetry.lock; pipenv updates the Pipfile with Pipfile.lock; pip_requirements updates requirements files. pip-compile is off by default (lib/modules/manager/pep621/readme.md and pipenv/index.ts at 44.198.1).',
    ),
    passesDelayToManager: python.verified(
      [
        { since: '0.0.0', value: [] },
        { since: '44.34.0', value: ['poetry'] },
      ],
      MINIMUM_RELEASE_AGE,
      'Since 44.34.0 Renovate passes POETRY_SOLVER_MIN_RELEASE_AGE (rounded up to whole days) to Poetry 2.4.0 and later. It does not pass the delay to uv or read exclude-newer.',
    ),
    missingTimestamp: verified(
      [
        { since: '0.0.0', value: 'updates without a release timestamp pass the check' },
        { since: '42.0.0', value: 'minimumReleaseAgeBehaviour timestamp-required: such updates are held' },
      ],
      release('42.0.0'),
      'minimumReleaseAgeBehaviour was added in 41.150.0; timestamp-optional still fails open.',
    ),
    internalChecksFilter: verified(
      'Defaults to "strict" since 33.0.0; with "none" or "flexible" branches and PRs are created before the delay ends and only automerge waits',
      release('33.0.0'),
    ),
    independentOfPackageManager: verified(
      'minimumReleaseAge is set independently of the package manager\'s own release-age configuration',
      MINIMUM_RELEASE_AGE,
      'Source code passes --before to npm only; pnpm, Yarn and Bun gates are not read.',
    ),
    digestBypassFixed: disputed(
      'Digest updates could bypass minimumReleaseAge; the advisory and a maintainer comment give different fixed versions. Rebase requests could bypass strict checks before 44.61.3 (GHSA-2frq-pm48-6j4h).',
      evidence('44.3.1', 'https://github.com/renovatebot/renovate/security/advisories/GHSA-g4qr-hw2h-687r'),
      evidence('44.10.0', 'https://github.com/renovatebot/renovate/discussions/42260'),
    ),
  },
};
