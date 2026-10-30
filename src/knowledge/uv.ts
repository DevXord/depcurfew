import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');

// docs.astral.sh is built from docs/ in the repository; the settings and CLI references are generated from the code.
const UV = 'https://github.com/astral-sh/uv/blob/0.13.6';
const RESOLUTION = `${UV}/docs/concepts/resolution.md`;
const CONFIGURATION = `${UV}/docs/concepts/configuration-files.md`;
const SETTINGS = `${UV}/crates/uv-settings/src/settings.rs`;
const BUILD_OPTIONS = `${UV}/crates/uv-configuration/src/build_options.rs`;
const DEPENDENCIES = `${UV}/docs/concepts/projects/dependencies.md`;
const WORKSPACES = `${UV}/docs/concepts/projects/workspaces.md`;
const SERIALIZE = `${UV}/crates/uv-lock/src/lock/serialize.rs`;
const changelog = (minor: string, version: string) => `${UV}/changelogs/${minor}.x.md#${version.replaceAll('.', '')}`;

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${UV}/uv.schema.json`,
    `No setting allows or forbids ${kind} dependencies (concluded from the list of settings). no-sources only ignores the tool.uv.sources table; a URL dependency introduced by a registry package is rejected during resolution (docs/pip/compatibility.md).`,
  ),
});

export const uv: ToolKnowledge = {
  id: 'uv',
  name: 'uv',
  kind: 'package-manager',
  ecosystem: 'pypi',
  cooldown: {
    setting: verified(
      'exclude-newer',
      SETTINGS,
      'Limits candidate packages to those uploaded before a date or, since 0.9.17, a duration ago. Compared with the upload time of each file, not the release date. false turns off a value from a lower-priority source (since 0.11.24).',
    ),
    configFiles: verified(
      ['uv.toml', 'pyproject.toml'],
      CONFIGURATION,
      'Top level of uv.toml or the [tool.uv] table of pyproject.toml. uv searches the current directory and its parents and uses the first directory with uv.toml or a pyproject.toml that has [tool.uv]; uv.toml wins over [tool.uv] in the same directory, with a warning. In a workspace only the root is read. User (~/.config/uv/uv.toml) and system (/etc/uv/uv.toml) files are merged below the project file; uv tool and uvx read only those. UV_EXCLUDE_NEWER overrides the files.',
    ),
    cliFlag: verified('--exclude-newer', `${UV}/crates/uv-cli/src/lib.rs`, 'Also the UV_EXCLUDE_NEWER environment variable.'),
    unit: verified(
      'duration-string',
      RESOLUTION,
      'A "friendly" duration such as 24 hours, 1 week or 30 days, or an ISO 8601 duration such as P7D; months and years are rejected, a day is always 24 hours. An RFC 3339 timestamp is a fixed cutoff instead of a rolling delay.',
    ),
    availableSince: verified(
      '0.9.17',
      changelog('0.9', '0.9.17'),
      'Durations ("dependency cooldowns") since 0.9.17; before that exclude-newer took only dates, which do not move with time.',
    ),
    default: verified([{ since: '0.9.17', value: null }], SETTINGS, 'No default: without a value every upload time is accepted.'),
    exclude: {
      setting: verified(
        'exclude-newer-package',
        `${RESOLUTION}`,
        'A table mapping package names to false (exempt), a date or a duration; package values take precedence over the global and index values.',
      ),
      availableSince: verified('0.9.25', changelog('0.9', '0.9.25'), 'The table exists since 0.8.4 (dates); false, which exempts a package, since 0.9.25.'),
      patternSyntax: verified(
        'Exact package names as table keys; no wildcards',
        SETTINGS,
        'Keys are package names, compared after name normalization.',
      ),
    },
    securityUpdates: uncertain(
      'applies',
      RESOLUTION,
      'uv does not know which versions fix vulnerabilities; the delay holds back every new upload unless the package is listed in exclude-newer-package.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      SETTINGS,
      'no-build defaults to false: source distributions, git and directory dependencies are built, which runs their build backend. Installing a wheel runs no package code.',
    ),
    allowList: {
      setting: verified(
        'no-binary-package',
        BUILD_OPTIONS,
        'With no-build = true, the packages in no-binary-package are the only ones built from source ("Allow `all` to be overridden by specific binary exclusions"). Their wheels are not used, so they are always built.',
      ),
      file: verified('pyproject.toml', CONFIGURATION, 'Or uv.toml; the same table as exclude-newer.'),
      availableSince: verified('0.2.12', changelog('0.2', '0.2.12'), 'Project settings no-build, no-build-package, no-binary and no-binary-package; uv sync and related commands respect them since 0.4.6.'),
      format: verified('A list of package names', SETTINGS),
    },
    disableAll: verified(
      'no-build',
      SETTINGS,
      'Operations that need to build a source distribution fail. Workspace members, editable requirements and wheels built earlier and kept in the cache are still used. With uv 0.13.6 on 2026-10-30, uv sync refused a git dependency and a non-editable local directory dependency as well ("marked as --no-build but has no binary distribution"), so those need an exception too. An explicit no-build = false in a higher-priority file makes uv ignore no-build-package.',
    ),
  },
  sources: {
    git: noSetting('git'),
    remoteTarball: noSetting('URL'),
    file: noSetting('local archive'),
    directory: noSetting('local directory'),
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['uv.lock'] }], `${UV}/docs/concepts/projects/layout.md`, 'Created next to pyproject.toml.'),
    manifests: verified(['pyproject.toml'], `${UV}/docs/concepts/projects/layout.md`),
    workspaces: verified(
      { files: ['pyproject.toml'], key: 'tool.uv.workspace', excludeKey: 'exclude' },
      WORKSPACES,
      'The [tool.uv.workspace] table of the root pyproject.toml lists members and exclude (globs or paths); exclude wins over members, and the root is a member too.',
    ),
    workspacesObjectKey: verified(
      'members',
      WORKSPACES,
      'The workspace guide calls members required, while the settings reference (crates/uv-workspace/src/pyproject.rs) gives it a default of [].',
    ),
  },
  extra: {
    configTables: verified(
      { 'pyproject.toml': 'tool.uv', 'uv.toml': '' },
      CONFIGURATION,
      'Settings sit in [tool.uv] in pyproject.toml and at the top level of uv.toml. uv.toml cannot hold workspace, sources and a few other project fields.',
    ),
    pyprojectTable: verified(
      'tool.uv',
      CONFIGURATION,
      'A pyproject.toml without a [tool.uv] table is ignored when uv searches for configuration.',
    ),
    configPrecedence: verified(
      'uv.toml wins over [tool.uv] in the same directory; only the nearest directory with either is read, and in a workspace only the root',
      CONFIGURATION,
      'A nested pyproject.toml with any [tool.uv] table hides the configuration of its parent directories.',
    ),
    configFileOrder: verified(
      ['uv.toml', 'pyproject.toml'],
      CONFIGURATION,
      '"configuration will be read from uv.toml, and the [tool.uv] section in the accompanying pyproject.toml will be ignored"; uv prints a warning listing the ignored fields.',
    ),
    workspaceRootOnly: verified(
      true,
      CONFIGURATION,
      '"In workspaces, uv will begin its search at the workspace root, ignoring any configuration defined in workspace members." Project fields such as tool.uv.sources of a member still apply.',
    ),
    buildSwitch: verified(
      { setting: 'no-build', value: true, since: '0.2.12', covers: ['registry', 'git', 'remoteTarball', 'file', 'directory'] },
      changelog('0.2', '0.2.12'),
      'The project setting that forbids building source distributions. It also stops git and local directory dependencies (uv sync with uv 0.13.6 on 2026-10-30) and source archives, which also need a build; workspace members and editable requirements are still built.',
    ),
    durationStrings: verified(
      { since: '0.9.17', syntax: 'words-or-iso8601' },
      RESOLUTION,
      'Either a "friendly" duration (24 hours, 1 week, 30 days) or an ISO 8601 duration (PT24H, P7D, P30D).',
    ),
    durationUnits: verified(['hours', 'days', 'weeks'], RESOLUTION, 'Units in the documented examples: 24 hours, 1 week, 30 days.'),
    excludeWildcards: verified({ since: null, trailingOnly: false }, SETTINGS, 'exclude-newer-package keys are exact package names.'),
    excludeValue: verified(false, changelog('0.9', '0.9.25'), 'exclude-newer-package = { name = false } exempts the package from the delay.'),
    missingUploadTime: verified(
      'A file from an index that gives no upload time is treated as unavailable while a delay is set',
      RESOLUTION,
      'Unless the package is exempt, or the index has its own exclude-newer value or is exempt with [[tool.uv.index]] exclude-newer = false.',
    ),
    registryOnly: verified(
      'The delay applies only to packages read from a registry, not to git, URL or path dependencies',
      RESOLUTION,
    ),
    requiredVersion: verified(
      { table: 'tool.uv', key: 'required-version', since: '0.5.14' },
      SETTINGS,
      'A PEP 440 specifier; uv exits with an error when its version does not match. Also at the top level of uv.toml.',
    ),
    lockfileFormat: uncertain(
      {
        sources: { registry: 'registry', git: 'git', remoteTarball: 'url', file: 'path', directory: 'directory', editable: 'editable', virtual: 'virtual' },
        sdist: 'sdist',
        wheels: 'wheels',
        packages: 'package',
      },
      SERIALIZE,
      'uv.lock has no documented format (the docs say only that it is managed by uv). Each [[package]] has source = { registry = URL } for an index, { git = URL?rev#commit }, { url = URL }, { path = archive }, { directory = dir }, { editable = dir } or { virtual = dir } (a directory that is not built). Index packages list sdist and wheels; a package without wheels, or from git, a directory or a source archive, is built when installed.',
    ),
    ignoredByToolCommands: verified(
      'uv tool install, uv tool run and uvx ignore pyproject.toml and uv.toml in the project and read only user and system configuration',
      CONFIGURATION,
    ),
    latestVersion: verified('0.13.6', `${UV}/CHANGELOG.md`, 'Released on 2026-10-26.'),
  },
};
