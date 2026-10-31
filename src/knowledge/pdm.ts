import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge, UserDirectory, UserFile, Versioned } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');
const rechecked = verifiedOn('2026-10-31');
const user = verifiedOn('2026-10-31');

// pdm-project.org is built from docs/ in the repository.
const PDM = 'https://github.com/pdm-project/pdm/blob/2.29.5';
const LOCKFILE = `${PDM}/docs/usage/lockfile.md`;
const CHANGELOG = `${PDM}/CHANGELOG.md`;
const CANDIDATES = `${PDM}/src/pdm/models/candidates.py`;
const CONFIG = `${PDM}/src/pdm/project/config.py`;

/** The home config.toml; only the macOS directories are disputed. */
const userFiles = (darwin: readonly UserDirectory[]): Versioned<UserFile> => [
  {
    since: '0.0.0',
    value: {
      format: 'toml',
      locations: [
        {
          platforms: ['linux'],
          directories: [{ from: { env: 'XDG_CONFIG_HOME' }, path: 'pdm' }, { from: 'home', path: '.config/pdm' }],
          file: 'config.toml',
        },
        { platforms: ['darwin'], directories: darwin, file: 'config.toml' },
        { platforms: ['win32'], directories: [{ from: 'home', path: 'AppData/Local/pdm/pdm' }], file: 'config.toml' },
      ],
    },
  },
];
const MACOS_DIRECTORY: UserDirectory = { from: 'home', path: 'Library/Application Support/pdm' };

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${PDM}/docs/reference/pep621.md`,
    `No setting allows or forbids ${kind} dependencies (concluded from the documented [tool.pdm] settings); only-binary does not stop them from being built.`,
  ),
});

export const pdm: ToolKnowledge = {
  id: 'pdm',
  name: 'PDM',
  kind: 'package-manager',
  ecosystem: 'pypi',
  cooldown: {
    setting: verified(
      'exclude-newer',
      `${LOCKFILE}#exclude-packages-newer-than-specific-date`,
      'In the [tool.pdm.resolution] table of pyproject.toml: distributions uploaded after the cutoff are left out when dependencies are resolved (pdm lock, add, update). The --exclude-newer option of pdm lock wins over it, and it wins over strategy.exclude-newer in the PDM configuration.',
    ),
    configFiles: verified(['pyproject.toml'], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'The [tool.pdm.resolution] table.'),
    cliFlag: verified('--exclude-newer', `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'pdm lock --exclude-newer, since 2.13.0.'),
    unit: verified(
      'duration-string',
      `${LOCKFILE}#exclude-packages-newer-than-specific-date`,
      'An RFC 3339 timestamp, a UTC date or a relative duration N{d|h|w} such as 7d, 12h or 3w, counted from the current UTC time.',
    ),
    availableSince: verified('2.26.9', CHANGELOG, '"Support exclude-newer in pyproject.toml in the [tool.pdm.resolution] table" (#3776); the pdm lock option exists since 2.13.0.'),
    default: verified([{ since: '2.26.9', value: null }], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'No default: without a value every upload time is accepted.'),
    exclude: {
      setting: verified(
        'exclude-newer-override',
        `${LOCKFILE}#exclude-packages-newer-than-specific-date`,
        'A table [tool.pdm.resolution.exclude-newer-override] of package = false (no cutoff) or package = another date or duration; package-specific values win over the global cutoff.',
      ),
      availableSince: verified('2.29.1', CHANGELOG, '"Allow package-specific overrides for exclude-newer resolution limits" (#3809).'),
      patternSyntax: verified('Package names, normalized before matching; no wildcards', `${LOCKFILE}#exclude-packages-newer-than-specific-date`),
    },
    securityUpdates: uncertain(
      'applies',
      `${LOCKFILE}#exclude-packages-newer-than-specific-date`,
      'PDM does not know which versions fix vulnerabilities; the cutoff holds back every newer distribution of a package without an override.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`,
      'Without only-binary, PDM locks and installs source distributions when they fit, which builds them and runs their build backend. Installing a wheel runs no package code.',
    ),
    allowList: {
      setting: verified(
        'no-binary',
        `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`,
        'The packages in no-binary are locked and installed from source distributions only. A name in no-binary wins over only-binary = ":all:" (FormatControl of unearth, which PDM uses), so with both the named packages are the only ones built, and always from source.',
      ),
      file: verified('pyproject.toml', `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`, 'The [tool.pdm.resolution] table.'),
      availableSince: verified('2.15.0', CHANGELOG, 'no-binary, only-binary and prefer-binary keys in [tool.pdm.resolution] (#2656).'),
      format: verified('A comma-separated string or a list of package names, or :all:', `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`),
    },
    disableAll: verified(
      'only-binary',
      `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`,
      'only-binary = ":all:" locks and installs only wheels. The variables PDM_ONLY_BINARY and PDM_NO_BINARY win over pyproject.toml.',
    ),
  },
  sources: {
    git: noSetting('git'),
    remoteTarball: noSetting('URL'),
    file: noSetting('local archive'),
    directory: noSetting('local directory'),
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['pdm.lock'] }], LOCKFILE, 'pdm.lock next to pyproject.toml; pdm lock --lockfile writes another name.'),
    manifests: verified(['pyproject.toml'], `${PDM}/docs/reference/pep621.md`),
    workspaces: uncertain(
      null,
      `${PDM}/docs/usage/workspace.md`,
      'Workspaces ([tool.pdm.workspace] members) are experimental since 2.28.0 and are locked and installed from the root only, so depcurfew configures the root and reads no members.',
    ),
    workspacesObjectKey: uncertain(null, `${PDM}/docs/usage/workspace.md`, 'Not read; see workspaces.'),
  },
  user: {
    files: user.disputed(
      'The docs give ~/Library/Application Support/pdm on macOS. The code asks the installed platformdirs (not pinned in pyproject.toml), and platformdirs 4.6.0 (2026-02-12) added the XDG variables on macOS, so with XDG_CONFIG_HOME set (not empty) PDM reads $XDG_CONFIG_HOME/pdm/config.toml instead (https://github.com/tox-dev/platformdirs/blob/4.6.0/src/platformdirs/_xdg.py); which one applies depends on the platformdirs version in PDM\'s environment. Linux and Windows agree. The home configuration is TOML whose nested tables are read as dotted keys ([strategy] exclude-newer is strategy.exclude-newer, load_config in src/pdm/project/config.py). -c/--config and PDM_CONFIG_FILE replace it; the site configuration is merged below it. Checked at 2.29.5; earlier versions are not tracked.',
      user.evidence(
        userFiles([MACOS_DIRECTORY]),
        `${PDM}/docs/usage/config.md`,
        '<CONFIG_ROOT> is "$XDG_CONFIG_HOME/pdm (~/.config/pdm in most cases) on Linux", "~/Library/Application Support/pdm on macOS" and "%USERPROFILE%\\AppData\\Local\\pdm\\pdm on Windows".',
      ),
      user.evidence(
        userFiles([{ from: { env: 'XDG_CONFIG_HOME' }, path: 'pdm' }, MACOS_DIRECTORY]),
        `${PDM}/src/pdm/project/core.py`,
        'global_config = platformdirs.user_config_path("pdm") / "config.toml", which on macOS honors XDG_CONFIG_HOME since platformdirs 4.6.0. On Windows the default appauthor repeats the name (pdm\\pdm) and roaming is off, so platformdirs asks for the Local AppData known folder.',
      ),
    ),
    settings: user.verified(
      [{ purpose: 'cooldown', key: 'strategy.exclude-newer', since: '2.27.0' }],
      CHANGELOG,
      '"Allow configuring the default lock --exclude-newer value with strategy.exclude-newer" (2.27.0, #3795): a TOML string such as "7d", a date or an RFC 3339 time. It applies where neither [tool.pdm.resolution] exclude-newer in pyproject.toml nor a project pdm.toml sets it (docs/usage/lockfile.md), and with it in effect pdm lock resolves every package again (src/pdm/cli/commands/lock.py). only-binary, no-binary and exclude-newer-override cannot be set in any PDM configuration file: PDM reads them from [tool.pdm.resolution] in pyproject.toml, only-binary and no-binary also from PDM_ONLY_BINARY and PDM_NO_BINARY (environments/base.py, Project.env_or_setting), so at user level they can be set only through those variables.',
    ),
    unknownKeys: user.uncertain(
      'ignore',
      CONFIG,
      'load_config keeps every key of config.toml without checking it, and only registered config items are ever read, so PDM before 2.27.0 ignores strategy.exclude-newer. Read from the code.',
    ),
    invalidValueFails: user.uncertain(
      true,
      CONFIG,
      'A config.toml that is not valid TOML stops every command (load_config catches only FileNotFoundError). Values are coerced when read, and src/pdm/core.py reads strategy.exclude-newer before every command, so a value convert_to_datetime cannot parse (anything but Nd, Nh, Nw, a date or an RFC 3339 time) fails every command. Read from the code.',
    ),
    weakening: user.verified(
      [
        {
          key: 'use_uv',
          values: [true],
          effect: 'makes PDM resolve and install with uv, whose uv sync --frozen gets no build settings, so only-binary is not enforced when installing',
        },
      ],
      `${PDM}/docs/usage/uv.md`,
      'use_uv (experimental since 2.19.0, PDM_USE_UV) can be set in config.toml and in a project pdm.toml, which wins. PDM passes the cutoff and the build settings to uv lock but not to uv sync --frozen (src/pdm/installers/uv.py), and passes no --no-config, so uv also reads the user uv.toml. A home strategy.exclude-newer cannot weaken a project that sets [tool.pdm.resolution] exclude-newer.',
    ),
    variables: user.verified(
      [
        { name: 'PDM_CONFIG_FILE', values: 'any', effect: 'makes PDM read this file in place of the user config.toml' },
        { name: 'PDM_ONLY_BINARY', values: 'any', effect: 'replaces only-binary of every pyproject.toml when not empty' },
        { name: 'PDM_NO_BINARY', values: 'any', effect: 'replaces no-binary of every pyproject.toml when not empty' },
        { name: 'PDM_USE_UV', values: 'any', effect: 'overrides use_uv from every configuration file' },
      ],
      `${PDM}/src/pdm/project/core.py`,
      'env_or_setting returns os.getenv(var) or the pyproject.toml setting, so a non-empty PDM_ONLY_BINARY or PDM_NO_BINARY wins (environments/base.py). -c/--config and PDM_CONFIG_FILE name the home config file (src/pdm/core.py). PDM_USE_UV is the variable of use_uv, and variables beat pdm.toml and config.toml (src/pdm/project/config.py).',
    ),
  },
  extra: {
    pylockCreatedBy: verified('pdm', `${PDM}/src/pdm/formats/pylock.py`, 'PDM\'s pylock.toml export writes created-by = "pdm".'),
    configTables: verified({ 'pyproject.toml': 'tool.pdm.resolution' }, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'exclude-newer, its overrides, only-binary and no-binary share the table.'),
    pyprojectTable: verified('tool.pdm', `${PDM}/docs/reference/pep621.md`, 'PDM keeps its settings in [tool.pdm] of pyproject.toml.'),
    buildSwitch: verified(
      { setting: 'only-binary', value: ':all:', since: '2.15.0', covers: ['registry'] },
      CHANGELOG,
      'only-binary in [tool.pdm.resolution] since 2.15.0 (#2656). It covers packages from an index: git, URL and path requirements already name their source and are built regardless (candidates.py).',
    ),
    durationStrings: verified({ since: '2.26.8', syntax: 'compact' }, CHANGELOG, '"pdm lock --exclude-newer now accepts relative durations in the format N{d|h|w}" (#3760).'),
    durationUnits: verified(['hours', 'days', 'weeks'], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'Written as Nh, Nd and Nw.'),
    excludeWildcards: verified({ since: null, trailingOnly: false }, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'Override keys are package names.'),
    excludeValue: verified(false, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, 'package = false disables the cutoff for that package.'),
    missingUploadTime: verified(
      'A distribution without an upload time is treated as unavailable while a cutoff applies to its package',
      `${LOCKFILE}#exclude-packages-newer-than-specific-date`,
      'The index must give upload-time (PEP 700); an override of false lifts it for the package.',
    ),
    lockfileFormat: uncertain(
      { packages: 'package', files: 'files', file: 'file', vcs: ['git', 'hg', 'svn', 'bzr'], url: 'url', path: 'path', editable: 'editable' },
      CANDIDATES,
      'pdm.lock (lock_version 4.5) has no documented format beyond the docs examples. Each [[package]] has name, version and files ({file, hash} for every distribution); a VCS package has its repository under the key of its VCS (git = "…") with ref and revision; a local archive or directory has path, a remote archive url, and editable packages editable = true (as_lockfile_entry). A package from an index without a .whl file is built when installed.',
    ),
    lockedSettings: rechecked.verified(
      { settings: 'table', lock: 'pdm lock', failing: ['pdm lock --check', 'pdm install --check'] },
      `${PDM}/src/pdm/project/project_file.py`,
      'pdm.lock keeps a content_hash of the whole [tool.pdm.resolution] table (PyProject.content_hash), or with canonical lock inputs (lock_inputs = true, since 2.28.1) the table itself (src/pdm/project/lockfile/freshness.py), so a change to any key in it, exclude-newer and only-binary included, makes the lockfile out of date. pdm lock --check and pdm install --check then exit with 1 ("Lockfile doesn\'t satisfy the project requirements"), pdm install without --check locks again first and pdm sync only warns (check_lockfile in src/pdm/cli/actions.py) until pdm lock runs again; with exclude-newer set, pdm lock resolves every package again (src/pdm/cli/commands/lock.py).',
    ),
    uvMode: uncertain(
      { file: 'pdm.toml', key: 'use_uv' },
      `${PDM}/docs/usage/uv.md`,
      'Experimental since 2.19.0: PDM resolves and installs with uv. It passes the cutoff and the build settings to uv lock, but runs uv sync --frozen without the build settings (src/pdm/installers/uv.py), and pdm.lock then lists source distributions even with only-binary.',
    ),
    commandLine: verified(
      {
        add: [['pdm', 'add']],
        run: [],
        create: [],
        valueOptions: ['-c', '--config', '--pep582', '-L', '--lockfile', '-G', '--group', '-k', '--skip', '-e', '--editable', '-p', '--project', '--venv', '--override'],
        flagOptions: [
          '-V', '--version', '-h', '--help', '-v', '--verbose', '-q', '--quiet', '--no-cache', '-I', '--ignore-python', '-n',
          '--non-interactive', '-g', '--global', '-d', '--dev', '--no-sync', '--frozen-lockfile', '--no-lock', '--save-compatible',
          '--save-safe-compatible', '--save-wildcard', '--save-exact', '--save-minimum', '--update-reuse', '--update-eager',
          '--update-all', '--update-reuse-installed', '--pre', '--prerelease', '--stable', '-u', '--unconstrained',
          '--no-editable', '--no-self', '-x', '--fail-fast', '--no-isolation', '--dry-run',
        ],
        parsing: { abbreviations: true, groupedShortOptions: true },
        editableOptions: ['-e', '--editable'],
      },
      `${PDM}/src/pdm/cli/commands/add.py`,
      'pdm add takes requirements as arguments and editable ones with -e; its options come from cli/options.py and the global ones (-c/--config, --pep582, -I, -n, --no-cache) from core.py. --venv and --pep582 take an optional value, so argparse takes the next word for it. PDM parses with argparse, which accepts abbreviated long options.',
    ),
    registryOverrides: verified(
      { registryOptions: [], registryVariables: ['PDM_PYPI_URL'], configOptions: ['-c', '--config'], configVariables: ['PDM_CONFIG_FILE'] },
      `${PDM}/src/pdm/project/config.py`,
      'pypi.url, the index PDM uses when pyproject.toml names no source called pypi, can be set with PDM_PYPI_URL (docs/usage/config.md); -c/--config and PDM_CONFIG_FILE name another configuration file, which may set any index.',
    ),
    selection: verified(
      {
        prereleases: { onFlags: ['--pre', '--prerelease'], offFlags: ['--stable'] },
        buildFromSource: { onListVariables: ['PDM_NO_BINARY'], offListVariables: ['PDM_ONLY_BINARY'] },
      },
      `${PDM}/src/pdm/cli/options.py`,
      'pdm add --pre/--prerelease allows pre-releases of the added packages to be pinned and --stable only stable versions (prerelease_option; commands/add.py sets req.prerelease). PDM_NO_BINARY and PDM_ONLY_BINARY are lists of packages separated by commas, :all: for every package, of which no wheel, or only wheels, are locked and installed (docs/usage/lockfile.md; environments/base.py, _setting_list).',
    ),
    latestVersion: verified('2.29.5', CHANGELOG, 'Released on 2026-10-30.'),
  },
};
