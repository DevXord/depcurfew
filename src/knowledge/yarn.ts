import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');

const YARNRC = 'https://yarnpkg.com/configuration/yarnrc';
const MANIFEST = 'https://yarnpkg.com/configuration/manifest';
const SECURITY = 'https://yarnpkg.com/features/security';
const SCHEMA = 'https://github.com/yarnpkg/berry/blob/master/packages/docusaurus/static/configuration/yarnrc.json';
const release = (version: string) => `https://github.com/yarnpkg/berry/releases/tag/%40yarnpkg%2Fcli%2F${version}`;

const noSetting = (source: string, note: string): SourceKnowledge => ({ setting: uncertain(null, source, note) });

export const yarn: ToolKnowledge = {
  id: 'yarn',
  name: 'Yarn (Berry)',
  kind: 'package-manager',
  cooldown: {
    setting: verified('npmMinimalAgeGate', `${YARNRC}#npmMinimalAgeGate`),
    configFiles: verified(
      ['.yarnrc.yml'],
      YARNRC,
      'Also YARN_NPM_MINIMAL_AGE_GATE (general YARN_ env rule) and, since 4.17.0, npmScopes.<scope>.npmMinimalAgeGate. package.json cannot set it.',
    ),
    cliFlag: uncertain(
      null,
      'https://yarnpkg.com/cli/install',
      'No flag sets the gate. --no-time-gate on yarn add and yarn up (4.15.0+) disables it for one command; yarn install has no such flag.',
    ),
    unit: verified(
      'minutes',
      'https://github.com/yarnpkg/berry/pull/6942',
      'Bare numbers are minutes. Since 4.11.0 duration strings with ms, s, m, h, d or w (e.g. 3d, 1w) also work; on 4.10.x a string such as 7d silently had no effect.',
    ),
    availableSince: checked.verified(
      '4.10.2',
      release('4.10.2'),
      'The setting arrived in 4.10.0 (release notes, pull request and source; the security docs page at https://yarnpkg.com/features/security says 4.12). 4.10.2 fixed it: "Bust the metadata cache" (#6908) and "support registries without publish times using minimalAgeGate" (#6907). On 2026-10-29 Yarn 4.10.1 with npmMinimalAgeGate: 4320 refused zod@3.23.8 and esbuild@0.25.0, both over a year old ("No candidates found"), while 4.10.2, 4.10.3, 4.11.0 and 4.12.0 installed them and refused a version 4 hours old. depcurfew writes the setting from 4.10.2 on.',
    ),
    default: disputed(
      'The code is unambiguous: off until 4.14.x, 1d from 4.15.0. The published settings schema claimed 3d for 4.11.0-4.14.x and 0m in 4.16.0; the live yarnrc page shows "1w", which is an example value. Upgraded projects with an old lockfile get npmMinimalAgeGate: 0 written to .yarnrc.yml (see upgradeMigration).',
      evidence(
        [
          { since: '4.10.0', value: 0 },
          { since: '4.15.0', value: '1d' },
        ],
        release('4.15.0'),
      ),
      evidence(
        [
          { since: '4.10.0', value: 0 },
          { since: '4.11.0', value: '3d' },
          { since: '4.15.0', value: '1d' },
        ],
        'https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.11.0/packages/docusaurus/static/configuration/yarnrc.json',
      ),
    ),
    exclude: {
      setting: verified('npmPreapprovedPackages', `${YARNRC}#npmPreapprovedPackages`),
      availableSince: verified('4.10.0', release('4.10.0')),
      patternSyntax: verified(
        'Package descriptors or name globs, optionally with a semver range: @scope/*, package, package*, package@^1.0.0; global only, not per npmScopes',
        `${YARNRC}#npmPreapprovedPackages`,
      ),
    },
    securityUpdates: uncertain(
      'applies',
      'https://yarnpkg.com/cli/npm/audit',
      'No automatic bypass is documented and yarn npm audit only reports. Options: --no-time-gate on yarn add/up, a pinned npmPreapprovedPackages entry, or a per-scope gate of 0.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [
        { since: '2.0.0', value: 'run' },
        { since: '4.14.0', value: 'deny-except-allowlist' },
      ],
      release('4.14.0'),
      'Workspace scripts still run. Upgraded projects with an old lockfile get enableScripts: true written to .yarnrc.yml. Yarn 1 runs scripts unless --ignore-scripts is passed.',
    ),
    allowList: {
      setting: verified('dependenciesMeta.<package>.built', `${MANIFEST}#dependenciesMeta.built`),
      file: verified('package.json', `${MANIFEST}#dependenciesMeta`, 'Root package.json only; ignored inside workspaces.'),
      availableSince: uncertain(
        '2.0.0',
        'https://github.com/yarnpkg/berry/blob/master/CHANGELOG.md',
        'dependenciesMeta is documented in the changelog from the 2.x line; the exact first version was not pinned down.',
      ),
      format: verified(
        'Object keyed by package name or name@version: { built: true } allows a package when enableScripts is false; { built: false } denies it when enableScripts is true',
        `${MANIFEST}#dependenciesMeta.built`,
      ),
    },
    disableAll: verified(
      'enableScripts: false',
      `${YARNRC}#enableScripts`,
      'Set in .yarnrc.yml; the default since 4.14.0. yarn install --mode=skip-build skips builds for one run. Berry ignores YARN_IGNORE_SCRIPTS.',
    ),
  },
  sources: {
    git: {
      setting: verified('approvedGitRepositories', `${YARNRC}#approvedGitRepositories`),
      values: verified(
        ['repository URL glob patterns, e.g. https://github.com/org/*'],
        `${YARNRC}#approvedGitRepositories`,
      ),
      availableSince: verified('4.14.0', release('4.14.0')),
      default: verified(
        [{ since: '4.14.0', value: '[] (every git dependency is blocked)' }],
        SCHEMA,
        'Upgraded projects with an old lockfile get ["**"] written to .yarnrc.yml.',
      ),
    },
    remoteTarball: noSetting(
      YARNRC,
      'No setting restricts http(s) tarball dependencies (concluded from the full settings list); the closest are enableNetwork, networkSettings.<host>.enableNetwork and unsafeHttpWhitelist for plain http.',
    ),
    file: noSetting(
      'https://yarnpkg.com/protocol/file',
      'No setting restricts file:, link: or portal: dependencies (concluded from the settings list and plugin sources); only exec: is gated by enableScripts (4.14.0+).',
    ),
    directory: noSetting(
      'https://yarnpkg.com/protocol/file',
      'No setting restricts local directory dependencies (file:, link:, portal:), as for local tarballs.',
    ),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['yarn.lock'] }],
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-fslib/sources/path.ts',
      'Yarn Classic uses the same name; see berryLockfileMarker and classicLockfileHeader to tell them apart.',
    ),
    manifests: verified(['package.json'], MANIFEST),
    workspaces: verified({ files: ['package.json'], key: 'workspaces' }, `${MANIFEST}#workspaces`, 'Array of folder glob patterns.'),
    workspacesObjectKey: uncertain(
      'packages',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Manifest.ts',
      'Not documented; the manifest parser also accepts { "packages": [...] }.',
    ),
  },
  extra: {
    lockfileFormat: checked.verified(
      {
        installScripts: null,
        registry: 'npm:',
        workspace: 'workspace:',
        patch: 'patch:',
        file: 'file:',
        directory: ['portal:', 'link:'],
        gitCommit: '#commit=',
        tarball: '\\.(?:tar\\.gz|tgz)$',
      },
      'https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/yarnpkg-core/sources/Project.ts',
      'Each entry has resolution: name@<locator>: npm:<version> for the registry, <repository>#commit=<sha> for git (GitHub shortcuts become https://github.com/<owner>/<repo>.git), an http(s) URL for tarballs, file:<path> (a .tgz or .tar.gz path is a tarball, anything else a directory), portal: and link: for directories, workspace: for workspace packages, and patch: around the URL-encoded original locator. No field records install scripts; dependenciesMeta.built: false is a user opt-out.',
    ),
    durationStrings: verified(
      { since: '4.11.0', syntax: 'compact', before: 'no effect' },
      'https://github.com/yarnpkg/berry/pull/6942',
      'npmMinimalAgeGate accepts a number followed by ms, s, m, h, d or w (e.g. 3d, 1w) since 4.11.0; on 4.10.x such a string silently had no effect.',
    ),
    scriptsSwitch: verified({ setting: 'enableScripts', allow: true, deny: false }, `${YARNRC}#enableScripts`),
    excludeWildcards: verified(
      { since: '4.10.0', trailingOnly: false },
      `${YARNRC}#npmPreapprovedPackages`,
      'Name globs such as @scope/* or package* in npmPreapprovedPackages.',
    ),
    berryLockfileMarker: uncertain(
      '__metadata',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts',
      'Read from code: Yarn 2+ writes a __metadata key into yarn.lock and treats a lockfile without it but with "yarn lockfile v1" as Yarn Classic.',
    ),
    classicLockfileHeader: verified(
      '# yarn lockfile v1',
      'https://github.com/yarnpkg/yarn/blob/master/src/lockfile/stringify.js',
      'Written as # yarn lockfile v${LOCKFILE_VERSION} with LOCKFILE_VERSION = 1 (src/constants.js).',
    ),
    latestVersion: verified('4.18.1', release('4.18.1'), 'Yarn 6 is still in preview.'),
    bypassFlag: verified('--no-time-gate on yarn add and yarn up (4.15.0+)', 'https://yarnpkg.com/cli/add'),
    perScopeGate: verified('npmScopes.<scope>.npmMinimalAgeGate overrides the global gate (4.17.0+)', release('4.17.0')),
    upgradeMigration: verified(
      'When the lockfile predates the new defaults and the key is unset, yarn install writes enableScripts: true, approvedGitRepositories: ["**"] and npmMinimalAgeGate: 0 into .yarnrc.yml',
      'https://github.com/yarnpkg/berry/pull/7135',
      'Explicit values written by depcurfew prevent the migration.',
    ),
    missingPublishTime: verified(
      'Versions without a publish time are quarantined while the gate is on',
      'https://github.com/yarnpkg/berry/pull/6907',
    ),
    unknownSettings: uncertain(
      'Unknown keys in the project .yarnrc.yml throw (unless enableStrictSettings is false), so settings newer than the pinned Yarn break installs',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Configuration.ts',
      'Read from the current source code; older releases were not checked.',
    ),
  },
};
