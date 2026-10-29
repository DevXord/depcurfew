import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');

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
    cooldownKeys: verified(
      { days: 'default-days', exclude: 'exclude', semverDays: ['semver-major-days', 'semver-minor-days', 'semver-patch-days'] },
      `${OPTIONS}#cooldown`,
      'Keys inside the cooldown block of an updates entry; the semver-* keys override default-days for that kind of update.',
    ),
    excludeWildcards: verified({ since: '0.0.0', trailingOnly: false }, `${OPTIONS}#cooldown`, 'cooldown.exclude accepts * wildcards.'),
    ecosystems: verified(
      { npm: ['npm', 'pnpm', 'yarn'], bun: ['bun'], deno: ['deno'] },
      `${OPTIONS}#package-ecosystem`,
      'The npm ecosystem covers npm, pnpm and Yarn; bun needs Bun 1.1.39 or later and deno needs Deno 2. Cooldown is supported for all three.',
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
    semverKeysScope: verified(
      'semver-major/minor/patch-days apply only to SemVer ecosystems such as npm, Bun and Deno; others use default-days',
      `${OPTIONS}#cooldown`,
    ),
  },
};
