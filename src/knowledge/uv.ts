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
const CLI = `${UV}/crates/uv-cli/src/lib.rs`;
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
      'Durations ("dependency cooldowns") since 0.9.17; before that exclude-newer took only dates, which do not move with time. Tested on 2026-10-30: uv 0.9.16 printed a warning that "100000 days" is not a date and resolved with no delay at all; 0.9.17 and later held back every version.',
    ),
    default: verified([{ since: '0.9.17', value: null }], SETTINGS, 'No default: without a value every upload time is accepted.'),
    exclude: {
      setting: verified(
        'exclude-newer-package',
        `${RESOLUTION}`,
        'A table mapping package names to false (exempt), a date or a duration; package values take precedence over the global and index values.',
      ),
      availableSince: verified(
        '0.9.25',
        changelog('0.9', '0.9.25'),
        'The table exists since 0.8.4 (dates); false, which exempts a package, since 0.9.25. Tested on 2026-10-30: with a false entry, uv 0.9.17 warned "data did not match any variant of untagged enum" and ignored the whole [tool.uv] table, the delay included; 0.9.25 and 0.13.6 exempted the package.',
      ),
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
    pylockCreatedBy: verified(
      'uv',
      `${UV}/crates/uv-lock/src/lock/export/pylock_toml.rs`,
      'uv export --format pylock.toml (and uv pip compile to pylock.toml) writes created-by = "uv". The project itself and workspace members are written as directory = { path = …, editable = true }, with the path relative to the lock file, "." for the project.',
    ),
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
    lockedSettings: verified(
      ['exclude-newer', 'exclude-newer-package'],
      SERIALIZE,
      'uv.lock records these in [options] (a relative exclude-newer as exclude-newer-span); after a change uv lock --check and uv sync --locked fail until uv lock runs again ("Resolving despite existing lockfile due to addition of global exclude newer", seen with uv 0.13.6 on 2026-10-30). no-build and no-binary-package are not recorded.',
    ),
    commandLine: verified(
      {
        add: [['uv', 'add'], ['uv', 'pip', 'install'], ['uv', 'tool', 'install']],
        run: [
          { command: ['uvx'], packageOptions: ['--from'], extraPackageOptions: ['-w', '--with', '--with-editable'] },
          { command: ['uv', 'tool', 'run'], packageOptions: ['--from'], extraPackageOptions: ['-w', '--with', '--with-editable'] },
          { command: ['uv', 'run'], packageOptions: [], extraPackageOptions: ['-w', '--with', '--with-editable'], packageArgument: false, scriptUrls: true },
        ],
        create: [],
        valueOptions: [
          '--cache-dir', '--config-file', '--color', '--allow-insecure-host', '--trusted-host', '--directory', '--project',
          '--python-preference', '--python-fetch', '--preview-features', '--preview-feature', '--index', '--default-index', '-i',
          '--index-url', '--extra-index-url', '-f', '--find-links', '-P', '--upgrade-package', '--upgrade-group',
          '--reinstall-package', '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--prerelease-package',
          '--fork-strategy', '-C', '--config-setting', '--config-settings', '--config-settings-package',
          '--no-build-isolation-package', '--exclude-newer', '--exclude-newer-package', '--link-mode', '--no-sources-package',
          '--refresh-package', '--no-build-package', '--no-binary-package', '-c', '--constraints', '--constraint', '--overrides',
          '--override', '--excludes', '--exclude', '-b', '--build-constraints', '--build-constraint', '-r', '--requirements',
          '--requirement', '--group', '--extra', '--no-editable-package', '-p', '--python', '-t', '--target', '--prefix',
          '--python-version', '--python-platform', '--output-format', '--torch-backend', '--optional', '--bounds', '--rev',
          '--tag', '--branch', '--package', '--script', '--no-install-package', '--only-install-package', '-w', '--with',
          '--with-editable', '--with-requirements', '--no-extra', '--no-group', '--only-group', '--env-file',
          '--max-recursion-depth', '--from', '--with-executables-from',
        ],
        parsing: { groupedShortOptions: true },
        addPackageOptions: ['-w', '--with', '--with-editable', '--with-executables-from'],
        editableOptions: ['--with-editable'],
        commaSeparatedOptions: ['-w', '--with', '--with-editable', '--with-executables-from'],
        interpreterNames: ['python', 'pythonw', 'cpython', 'pypy', 'graalpy', 'pyodide'],
        commandOptions: [
          { command: ['uv', 'pip', 'install'], valueOptions: ['-e', '--editable', '--no-binary', '--only-binary'], editableOptions: ['-e', '--editable'] },
          { command: ['uv', 'add'], valueOptions: ['-m', '--marker'] },
        ],
      },
      CLI,
      'clap arguments of uv add, uv pip install, uv tool install, uv run and uv tool run (uvx), with the global options, IndexArgs, ResolverInstallerArgs, BuildOptionsArgs and DependencyConstraintsArgs they share. --opt value, --opt=value, -o value and -ovalue all work; long options cannot be shortened. Options of uv run, uv tool run and uvx come before the command. --with, --with-editable and --with-executables-from add packages, as a list split at commas outside [...] that are not followed by !, =, <, > or ~ (comma.rs). uvx and uv tool run take the package from the first argument (name@version is ==version, name@latest the newest) unless --from names it; a first argument such as python, python3.12, pypy@3.8 or graalpy runs an interpreter (PythonRequest::try_from_tool_name in uv-python-types, implementation names cpython, pypy, graalpy and pyodide). uv run runs a command and downloads only what --with names, or a script given as an http or https URL. -e takes a path in uv pip install but is a flag in uv tool install, and --editable a flag in uv add; --no-binary and --only-binary take values in uv pip install only, -m is --marker in uv add and --module in uv run.',
    ),
    registryOverrides: verified(
      {
        registryOptions: ['--index', '--default-index', '-i', '--index-url', '--extra-index-url', '-f', '--find-links'],
        registryVariables: ['UV_INDEX', 'UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_FIND_LINKS'],
        configOptions: ['--config-file'],
        configVariables: ['UV_CONFIG_FILE'],
      },
      `${UV}/crates/uv-static/src/env_vars.rs`,
      'IndexArgs (lib.rs): --index adds an index (name=url allowed), --default-index replaces PyPI, --index-url and --extra-index-url are their deprecated forms, --find-links adds a page or directory of archives; each has the variable named here. --config-file and UV_CONFIG_FILE name a uv.toml that may set any index. uv does not read pip.conf or PIP_INDEX_URL (docs/pip/compatibility.md).',
    ),
    selection: verified(
      {
        prereleases: {
          onFlags: ['--pre'],
          modeOptions: ['--prerelease'],
          packageModeOptions: ['--prerelease-package'],
          onModes: ['allow'],
          offModes: ['disallow'],
          modeVariables: ['UV_PRERELEASE'],
        },
        buildFromSource: {
          onFlags: ['--no-binary'],
          offFlags: ['--binary'],
          onPackages: ['--no-binary-package'],
          flagVariables: ['UV_NO_BINARY'],
          onPackageVariables: ['UV_NO_BINARY_PACKAGE'],
        },
        commands: [{ command: ['uv', 'pip', 'install'], buildFromSource: { onLists: ['--no-binary'], offLists: ['--only-binary'] } }],
      },
      CLI,
      'VersionSelectionArgs: --prerelease takes disallow, allow, if-necessary, explicit or if-necessary-or-explicit (UV_PRERELEASE); allow considers pre-releases of every package and disallow none (docs/concepts/resolution.md); --prerelease-package takes PACKAGE=MODE; the hidden --pre means allow. BuildOptionsArgs of uv add, uv run, uv tool install and uv tool run (uvx): --no-binary (UV_NO_BINARY, a boolean) installs every package from source, --binary turns it off, --no-binary-package names one package (UV_NO_BINARY_PACKAGE, separated by spaces). uv pip install takes --no-binary and --only-binary as lists separated by commas with :all: and :none:, as pip does (PipInstallArgs).',
    ),
    latestVersion: verified('0.13.6', `${UV}/CHANGELOG.md`, 'Released on 2026-10-26.'),
  },
};
