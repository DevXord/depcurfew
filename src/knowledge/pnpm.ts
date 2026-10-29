import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');

const RESOLUTION = 'https://pnpm.io/settings/dependency-resolution';
const SETTINGS_V10 = 'https://pnpm.io/10.x/settings';
const BUILD = 'https://pnpm.io/settings/build';
// pnpm.io/11.x redirects to the current docs, so pnpm 11 docs are cited from their source in the docs repository.
const RESOLUTION_V11 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/dependency-resolution.md';
const BUILD_V11 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/build.md';
const release = (version: string) => `https://github.com/pnpm/pnpm/releases/tag/v${version}`;

const exoticSubdeps: SourceKnowledge = {
  setting: verified(
    'blockExoticSubdeps',
    SETTINGS_V10,
    'Blocks git repositories and tarball URLs for transitive dependencies only; no setting blocks them as direct dependencies.',
  ),
  values: verified(['true', 'false'], RESOLUTION),
  availableSince: verified('10.26.0', SETTINGS_V10),
  default: verified(
    [
      { since: '10.26.0', value: 'false' },
      { since: '11.0.0', value: 'true' },
    ],
    release('11.0.0'),
  ),
};

const localPaths: SourceKnowledge = {
  setting: uncertain(
    null,
    'https://pnpm.io/settings',
    'No setting restricts file: or link: dependencies (concluded from the full settings list); blockExoticSubdeps treats local paths and workspace links as trusted.',
  ),
};

const WORKSPACE_YAML_V10 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/pnpm-workspace_yaml.md';

export const pnpm: ToolKnowledge = {
  id: 'pnpm',
  name: 'pnpm',
  kind: 'package-manager',
  cooldown: {
    setting: verified('minimumReleaseAge', 'https://pnpm.io/blog/releases/10.16'),
    configFiles: verified(
      ['pnpm-workspace.yaml'],
      release('11.0.0'),
      'pnpm-workspace.yaml (or the global config.yaml) works in every version that has the setting. pnpm 10 also reads minimum-release-age from .npmrc; pnpm 11+ reads only auth and registry settings from .npmrc and ignores the package.json "pnpm" field.',
    ),
    cliFlag: uncertain(
      null,
      'https://pnpm.io/cli/install',
      'No dedicated flag is documented for install or add; release notes mention "a CLI flag" without syntax. Environment variable: PNPM_CONFIG_MINIMUM_RELEASE_AGE (pnpm 11+), npm_config_minimum_release_age (pnpm 10).',
    ),
    unit: verified('minutes', RESOLUTION, 'Integer number of minutes, e.g. 1440 = 1 day; no duration strings.'),
    availableSince: verified('10.16.0', release('10.16.0')),
    default: verified(
      [
        { since: '10.16.0', value: 0 },
        { since: '11.0.0', value: 1440 },
      ],
      RESOLUTION_V11,
      'The built-in 1440 is non-strict: pnpm adds immature versions to minimumReleaseAgeExclude instead of failing (see strictMode).',
    ),
    exclude: {
      setting: verified('minimumReleaseAgeExclude', SETTINGS_V10),
      availableSince: verified('10.16.0', release('10.16.0')),
      patternSyntax: verified(
        'Package names (all versions); globs such as @myorg/* since 10.17.0; exact versions name@1.2.3 or name@1.2.3 || 1.2.4 since 10.19.0; ranges are not documented',
        SETTINGS_V10,
      ),
    },
    securityUpdates: verified(
      'applies',
      'https://pnpm.io/cli/audit',
      'No setting bypasses the delay. Since 11.0.0, pnpm audit --fix adds the minimum patched version of each advisory to minimumReleaseAgeExclude (since 11.22.0 only while it is still inside the window).',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [
        { since: '0.0.0', value: 'run' },
        { since: '10.0.0', value: 'deny-except-allowlist' },
      ],
      release('10.0.0'),
      'Unreviewed builds only warn in pnpm 10; strictDepBuilds is true by default since 11.0.0, so they fail the install. Prepare scripts of git-hosted dependencies are blocked since 10.26.0.',
    ),
    allowList: {
      setting: verified(
        'allowBuilds',
        BUILD,
        'Replaced onlyBuiltDependencies, which was removed in 11.0.0 (see legacyAllowList). Since 12.11.0, permissions.<package>.build takes precedence over allowBuilds.',
      ),
      file: verified('pnpm-workspace.yaml', BUILD),
      availableSince: verified('10.26.0', SETTINGS_V10),
      format: verified(
        'Map of package matcher to true (allow) or false (deny), e.g. esbuild: true or "nx@21.6.4 || 21.6.5": true; a bare name never approves git or tarball dependencies (pnpm 11+)',
        BUILD_V11,
      ),
    },
    disableAll: verified(
      'ignoreScripts',
      'https://pnpm.io/cli/install',
      'Default false; --ignore-scripts on the CLI. Also skips the project\'s own scripts.',
    ),
  },
  sources: {
    git: exoticSubdeps,
    remoteTarball: exoticSubdeps,
    file: localPaths,
    directory: localPaths,
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['pnpm-lock.yaml'] }], 'https://github.com/pnpm/pnpm.io/blob/main/docs/git.md'),
    manifests: verified(
      ['package.json', 'package.json5', 'package.yaml'],
      'https://github.com/pnpm/pnpm.io/blob/main/docs/package_json.md',
    ),
    workspaces: verified(
      { files: ['pnpm-workspace.yaml'], key: 'packages' },
      WORKSPACE_YAML_V10,
      'Globs with ! exclusions. Without packages only the root is in the workspace; pnpm still reads settings from the file in single-package projects. pnpm ignores workspaces in package.json.',
    ),
    workspacesObjectKey: uncertain(null, WORKSPACE_YAML_V10, 'The docs show packages only as a list; concluded from the absence of an object form.'),
  },
  extra: {
    minimumReleaseAgeStrict: checked.verified(
      { setting: 'minimumReleaseAgeStrict', value: true, since: '11.0.0' },
      RESOLUTION,
      'When false, pnpm falls back to a version that does not meet minimumReleaseAge; when true, resolution fails. It defaults to true when minimumReleaseAge is set explicitly, except in 11.0.0-11.0.3 and 12.0.0-12.2.x (see strictMode): pnpm 11.0.0 and 12.0.0 installed a version 4 hours old with minimumReleaseAge: 4320 on 2026-10-29, and 12.0.0 added it to minimumReleaseAgeExclude.',
    ),
    cooldownExactVersions: checked.verified(
      '10.17.0',
      release('10.17.0'),
      'pnpm 10.17.0: "Don\'t ignore the minimumReleaseAge check, when the package is requested by exact version". pnpm 10.16.0 installed typescript@7.1.0-dev.20261029.1, 4 hours old, with minimumReleaseAge: 4320 on 2026-10-29.',
    ),
    lockfileDocuments: checked.verified(
      { bootMarker: '---', graph: 'last' },
      'https://github.com/pnpm/pnpm.io/blob/main/docs/lockfile.md',
      'A lockfile whose first line is --- has two YAML documents: a boot document with configDependencies and packageManagerDependencies, written when the project has config dependencies, declares devEngines.packageManager or pins pnpm 12 or newer; then the project lockfile (importers, packages, snapshots), which is always the last document. Seen with pnpm 12.16.1 and packageManager pnpm@12.16.1 on 2026-10-29.',
    ),
    lockfileFormat: checked.verified(
      {
        installScripts: null,
        gitKeyPrefix: 'git+',
        gitHostedFlag: 'gitHosted',
        gitHostedTarballHosts: ['codeload.github.com', 'bitbucket.org', 'gitlab.com'],
        gitType: 'git',
        directoryType: 'directory',
      },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/lockfile/types/src/index.ts',
      'lockfileVersion 9.0 (pnpm 9 to 12). Registry packages are keyed name@version; git dependencies name@git+<repo>#<commit> with resolution type git, or a tarball from a git host (gitHosted: true; older lockfiles lack the flag, so the host decides); tarball URLs name@https://…; local tarballs name@file:….tgz; local directories have resolution type directory; link: and workspace: dependencies appear only under importers. requiresBuild was removed in lockfile v9, so install scripts are not recorded. A tarball URL under the configured registry is resolved as that registry package and version (resolving/npm-resolver/src/parseBareSpecifier.ts in v10.34.9), so it is keyed name@version and keeps the URL only in the importer specifier; seen in lockfiles written by pnpm 10.34.9 and 12.16.1.',
    ),
    npmrcPrecedence: checked.verified(
      { winner: 'pnpm-workspace.yaml', over: ['.npmrc', 'npm_config_*'] },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/config/config/src/index.ts',
      'pnpm 10 applies pnpm-workspace.yaml settings over .npmrc and npm_config_* variables; command-line options win over both (same order on v10.16.0). The 10.18.3 changelog says pnpm config set --location=project writes to pnpm-workspace.yaml "matching read priority". The 10.x docs do not state the order.',
    ),
    sharedWorkspaceLockfile: checked.verified(
      { setting: 'sharedWorkspaceLockfile', npmrcKey: 'shared-workspace-lockfile', default: true },
      'https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/versioned_docs/version-10.x/workspaces.md',
      'Same name and default in pnpm 11 and 12, where it is read only from pnpm-workspace.yaml.',
    ),
    perProjectNpmrc: checked.uncertain(
      { sharedWorkspaceLockfile: false, until: '11.0.0' },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/pkg-manager/plugin-commands-installation/src/recursive.ts',
      'Without a shared lockfile, pnpm 10 installs every workspace project with its own .npmrc layered over the workspace settings, without filtering keys, so a package .npmrc can change minimum-release-age for that project. Read from code; no documentation or test covers it. No official source says this combination turns minimumReleaseAge off.',
    ),
    ignoredSince: verified(
      { since: '11.0.0', npmrc: 'auth and registry settings', packageJsonField: 'pnpm' },
      release('11.0.0'),
      'Structured form of npmrcIgnored: from 11.0.0 on, other .npmrc settings and the package.json "pnpm" field have no effect.',
    ),
    lockfileRecheck: uncertain(
      [
        { since: '10.16.0', value: false },
        { since: '11.1.3', value: true },
      ],
      release('11.1.3'),
      'Structured form of lockfileVerification: whether a frozen-lockfile install re-checks the age of versions already in the lockfile. trustLockfile: true (11.3.0) turns the check off.',
    ),
    allowAllBuilds: verified(
      { setting: 'dangerouslyAllowAllBuilds', since: '10.9.0', value: true },
      'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md',
      'Boolean, default false; packages denied in allowBuilds stay blocked.',
    ),
    excludeWildcards: verified(
      { since: '10.17.0', trailingOnly: false },
      SETTINGS_V10,
      'Globs such as @myorg/* in minimumReleaseAgeExclude since 10.17.0.',
    ),
    onlyBuiltDependencies: verified(
      { since: '10.0.0', workspaceFileSince: '10.5.0', removedIn: '11.0.0' },
      BUILD_V11,
      'The allow-list before allowBuilds: package.json pnpm.onlyBuiltDependencies, also pnpm-workspace.yaml since 10.5.0; removed in 11.0.0 (see legacyAllowList).',
    ),
    latestVersion: verified(
      '12.16.1',
      release('12.16.1'),
      'pnpm 12.0.0 shipped on 26 Aug and 11.0.0 on 28 Apr (GitHub shows no year; 2026 inferred from release order). 11.x and 10.x still receive patches.',
    ),
    npmrcIgnored: verified(
      'pnpm 11+ reads only auth and registry settings from .npmrc, ignores the package.json "pnpm" field and no longer reads npm_config_* variables',
      release('11.0.0'),
    ),
    legacyAllowList: verified(
      [
        { since: '10.0.0', value: 'onlyBuiltDependencies (package.json pnpm field; pnpm-workspace.yaml since 10.5.0)' },
        { since: '10.26.0', value: 'allowBuilds; onlyBuiltDependencies and ignoredBuiltDependencies deprecated' },
        { since: '11.0.0', value: 'allowBuilds only; onlyBuiltDependencies, neverBuiltDependencies and ignoredBuiltDependencies removed' },
      ],
      BUILD_V11,
    ),
    strictDepBuilds: verified(
      [
        { since: '10.3.0', value: 'false' },
        { since: '11.0.0', value: 'true' },
      ],
      release('11.0.0'),
      'When true, an unreviewed dependency build script fails the install.',
    ),
    strictMode: verified(
      [
        { since: '11.0.0', value: 'minimumReleaseAgeStrict defaults to false' },
        { since: '11.0.4', value: 'strict whenever minimumReleaseAge is set explicitly' },
        { since: '12.0.0', value: 'explicit values treated as non-strict (regression)' },
        { since: '12.3.0', value: 'strict whenever minimumReleaseAge is set explicitly' },
      ],
      release('12.3.0'),
      'In non-strict mode pnpm silently writes immature picks into minimumReleaseAgeExclude. Strict mode fails CI installs with ERR_PNPM_NO_MATURE_MATCHING_VERSION.',
    ),
    ignoreMissingTime: verified(
      'minimumReleaseAgeIgnoreMissingTime defaults to true: packages whose registry metadata has no publish time skip the age check',
      RESOLUTION,
    ),
    lockfileVerification: uncertain(
      [
        { since: '10.16.0', value: 'frozen-lockfile installs do not re-check versions already in the lockfile' },
        { since: '11.1.3', value: 'lockfile entries are re-checked; trustLockfile: true (11.3.0) turns this off' },
      ],
      release('11.1.3'),
      'The 11.1.3 release notes confirm re-validation (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION). The pnpm 10 behavior rests on maintainer comments in pnpm/pnpm#12450 (a Dependabot lockfile passed --frozen-lockfile on 10.34.5), not on docs.',
    ),
    unknownWorkspaceKeys: verified(
      'pnpm 11 and earlier silently ignore misspelled pnpm-workspace.yaml settings; pnpm 12 warns',
      'https://pnpm.io/blog/releases/12.0',
    ),
  },
};
