import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');

const CONFIG = 'https://docs.npmjs.com/cli/v12/using-npm/config';
const CONFIG_V11 = 'https://docs.npmjs.com/cli/v11/using-npm/config';
const NPMRC = 'https://docs.npmjs.com/cli/v12/configuring-npm/npmrc';
const release = (version: string) => `https://github.com/npm/cli/releases/tag/v${version}`;
const INSTALL_TIME_CONTROLS = 'https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/';

const SOURCE_FLAGS_SINCE_NOTE =
  'The 11.14.0 release notes add the flag; the GitHub changelog dates it to 11.15.0, which also moved enforcement into the resolver. Treat 11.15.0 as the safe minimum.';

const VALUES_NOTE = 'The 2026-05-22 GitHub changelog mentions only all and none; the config reference also lists root.';

const sourceFlagSince = () =>
  disputed<string | null>(
    SOURCE_FLAGS_SINCE_NOTE,
    evidence('11.14.0', release('11.14.0')),
    evidence('11.15.0', INSTALL_TIME_CONTROLS),
  );

const LOCKFILE_V12 = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md';
const PACKAGE_JSON = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md';
const NPM_DEFINITIONS = 'https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/definitions.js';

export const npm: ToolKnowledge = {
  id: 'npm',
  name: 'npm',
  kind: 'package-manager',
  cooldown: {
    setting: verified('min-release-age', `${CONFIG}#min-release-age`),
    configFiles: verified(
      ['.npmrc'],
      NPMRC,
      'Any npm config layer works: project .npmrc (read only at the project root and not for global installs), ~/.npmrc, the global npmrc, npm_config_min_release_age or the CLI. package.json cannot set it.',
    ),
    cliFlag: verified('--min-release-age=<days>', 'https://docs.npmjs.com/cli/v12/commands/npm-install#min-release-age'),
    unit: verified(
      'days',
      `${CONFIG}#min-release-age`,
      'Type is null or Number; 0 turns the delay off. Fractional days are not documented.',
    ),
    availableSince: verified('11.10.0', release('11.10.0')),
    default: verified([{ since: '11.10.0', value: null }], `${CONFIG}#min-release-age`, 'Unchanged in npm 12.'),
    exclude: {
      setting: verified('min-release-age-exclude', `${CONFIG}#min-release-age-exclude`),
      availableSince: verified('11.17.0', release('11.17.0')),
      patternSyntax: verified(
        'Package names or minimatch globs matched against the name, e.g. @myorg/*; only the named package is exempt, not its dependencies; also exempts from before',
        `${CONFIG}#min-release-age-exclude`,
      ),
    },
    securityUpdates: verified(
      'applies',
      `${CONFIG}#min-release-age`,
      'npm audit fix keeps the vulnerable version, warns that the fix was blocked (since 11.18.0) and exits non-zero. Add the package to min-release-age-exclude or relax the delay.',
    ),
  },
  installScripts: {
    defaultPolicy: disputed(
      'npm 12 blocking dependency scripts is undisputed. For npm 11.16-11.21 the install-scripts command page says scripts are blocked by default, while the v11 config reference, the 11.16.0 pull request and the GitHub changelog say unreviewed scripts still run with a notice.',
      evidence(
        [
          { since: '0.0.0', value: 'run' },
          { since: '11.16.0', value: 'run-with-warning' },
          { since: '12.0.0', value: 'deny-except-allowlist' },
        ],
        `${CONFIG_V11}#strict-allow-scripts`,
        'npm 12 also blocks implicit node-gyp builds and prepare scripts of git, file and link dependencies.',
      ),
      evidence(
        [
          { since: '0.0.0', value: 'run' },
          { since: '11.16.0', value: 'deny-except-allowlist' },
        ],
        'https://docs.npmjs.com/cli/v11/commands/npm-install-scripts',
      ),
    ),
    allowList: {
      setting: verified('allowScripts', 'https://docs.npmjs.com/cli/v12/commands/npm-install-scripts'),
      file: verified(
        'package.json',
        'https://docs.npmjs.com/cli/v12/commands/npm-install-scripts',
        'Only the root package.json counts; allowScripts in dependencies is ignored. npx, npm exec and global installs use the allow-scripts config instead.',
      ),
      availableSince: verified('11.16.0', release('11.16.0')),
      format: uncertain(
        'Object keyed by name, name@version or name@v1 || v2 with true (allow) or false (deny); npm install-scripts approve writes pinned name@version entries',
        'https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md',
        'The exact entry grammar (no semver ranges) is stated in accepted RFC 0054; the shipped docs describe entries only in prose.',
      ),
    },
    disableAll: verified(
      'ignore-scripts',
      `${CONFIG}#ignore-scripts`,
      'Default false. Overrides allowScripts and dangerously-allow-all-scripts. npm run/test/start still run the named script, but not its pre/post scripts.',
    ),
  },
  sources: {
    git: {
      setting: verified('allow-git', `${CONFIG}#allow-git`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-git`, 'root allows only git dependencies listed in the project package.json.'),
      availableSince: disputed(
        'The release notes add --allow-git in 11.9.0; the GitHub changelog says it was introduced in 11.10.0.',
        evidence('11.9.0', release('11.9.0')),
        evidence('11.10.0', INSTALL_TIME_CONTROLS),
      ),
      default: verified(
        [
          { since: '11.9.0', value: 'all' },
          { since: '12.0.0', value: 'none' },
        ],
        `${CONFIG}#allow-git`,
      ),
    },
    remoteTarball: {
      setting: verified('allow-remote', `${CONFIG}#allow-remote`),
      values: verified(
        ['all', 'none', 'root'],
        `${CONFIG}#allow-remote`,
        `Tarballs on the configured registry hostname are always allowed. ${VALUES_NOTE}`,
      ),
      availableSince: sourceFlagSince(),
      default: verified(
        [
          { since: '11.14.0', value: 'all' },
          { since: '12.0.0', value: 'none' },
        ],
        release('12.0.0'),
      ),
    },
    file: {
      setting: verified('allow-file', `${CONFIG}#allow-file`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-file`, VALUES_NOTE),
      availableSince: sourceFlagSince(),
      default: verified(
        [{ since: '11.14.0', value: 'all' }],
        'https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/',
        'npm 12 did not change the default.',
      ),
    },
    directory: {
      setting: verified('allow-directory', `${CONFIG}#allow-directory`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-directory`, VALUES_NOTE),
      availableSince: sourceFlagSince(),
      default: verified([{ since: '11.14.0', value: 'all' }], `${CONFIG}#allow-directory`, 'npm 12 did not change the default.'),
    },
  },
  project: {
    lockfiles: verified(
      [
        { since: '0.0.0', value: ['npm-shrinkwrap.json', 'package-lock.json'] },
        { since: '12.0.0', value: ['package-lock.json'] },
      ],
      LOCKFILE_V12,
      'npm 11 and earlier prefer npm-shrinkwrap.json over package-lock.json when both exist; npm 12 no longer reads or writes npm-shrinkwrap.json (same format, rename it).',
    ),
    manifests: verified(['package.json'], PACKAGE_JSON),
    workspaces: verified({ files: ['package.json'], key: 'workspaces' }, `${PACKAGE_JSON}#workspaces`, 'An array of folder paths or globs.'),
    workspacesObjectKey: uncertain(
      'packages',
      'https://github.com/npm/map-workspaces/blob/main/lib/index.js',
      'Not documented; npm’s map-workspaces also accepts { "packages": [...] } and negated patterns.',
    ),
  },
  extra: {
    npmrcScope: checked.verified(
      { read: 'project root', workspacePackages: 'ignored' },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md',
      'Only the .npmrc at the root of the project npm runs in is read. Inside a workspace package npm moves the prefix to the workspace root (using-npm/workspaces.md) and warns "ignoring workspace config" for the package .npmrc (workspaces/config/lib/index.js).',
    ),
    npmrcListSyntax: verified(
      '[]',
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md',
      'Array values are written by adding [] after the key, one line per value, e.g. min-release-age-exclude[]=@myorg/*.',
    ),
    allowAllScripts: verified(
      { setting: 'dangerously-allow-all-scripts', since: '11.16.0', value: true },
      NPM_DEFINITIONS,
      'Boolean, default false: runs every dependency install script whether or not allowScripts approves it; --ignore-scripts still wins. First present in the 11.16.0 definitions.',
    ),
    excludeWildcards: verified(
      { since: '11.17.0', trailingOnly: false },
      NPM_DEFINITIONS,
      'min-release-age-exclude takes package names or minimatch globs from its first version.',
    ),
    latestVersion: verified(
      '12.2.1',
      release('12.2.1'),
      'Marked as the latest GitHub release on 2026-10-28; the 11.x line is still maintained (11.21.1).',
    ),
    beforeInteraction: verified(
      [
        { since: '11.10.0', value: 'min-release-age and before are mutually exclusive' },
        { since: '11.15.0', value: 'both may be set; before wins within the same config source' },
      ],
      release('11.15.0'),
    ),
    strictAllowScripts: verified(
      'strict-allow-scripts=true makes dependency scripts not covered by allowScripts fail the install (default false)',
      'https://docs.npmjs.com/cli/v12/commands/npm-install#strict-allow-scripts',
    ),
    unknownNpmrcKeys: disputed(
      'Matters for generated .npmrc files: keys that npm does not know (e.g. pnpm-only keys) may break npm 12 installs.',
      evidence('npm 12 throws on unknown config keys', release('12.0.0')),
      evidence('unknown keys only warn; throwing is planned for a future major version', NPMRC),
    ),
    lockfileInstalls: uncertain(
      'npm ci installs versions pinned in package-lock.json without applying min-release-age',
      'https://docs.npmjs.com/cli/v12/commands/npm-ci',
      'Inferred: npm ci does not list min-release-age or before among its options, and a user report (npm/cli#9277) describes it installing a version younger than the window.',
    ),
  },
};
