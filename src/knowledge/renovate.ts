import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');

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
      'A human-readable description allowed inside any configuration object; depgate uses it to recognize the packageRules entry it manages.',
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
