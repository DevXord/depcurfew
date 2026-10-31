import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');
const rechecked = verifiedOn('2026-10-31');

// pip.pypa.io is built from docs/html in the repository.
const PIP = 'https://github.com/pypa/pip/blob/26.2.2';
const NEWS = `${PIP}/NEWS.rst`;
const USER_GUIDE = `${PIP}/docs/html/user_guide.rst`;
const CONFIGURATION = `${PIP}/docs/html/topics/configuration.md`;
const SECURE_INSTALLS = `${PIP}/docs/html/topics/secure-installs.md`;
const REQUIREMENTS_FORMAT = `${PIP}/docs/html/reference/requirements-file-format.md`;
const REQ_FILE = `${PIP}/src/pip/_internal/req/req_file.py`;
const FORMAT_CONTROL = `${PIP}/src/pip/_internal/models/format_control.py`;
const CMDOPTIONS = `${PIP}/src/pip/_internal/cli/cmdoptions.py`;
const PIPX = 'https://github.com/pypa/pipx/blob/1.18.10';
const PYLOCK = 'https://github.com/pypa/packaging.python.org/blob/6fa4790c1fb668830f6eb94bbfe832320a9b0a2b/source/specifications/pylock-toml.rst';
const PARSER = `${PIP}/src/pip/_internal/cli/parser.py`;
const user = verifiedOn('2026-10-31');

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${PIP}/src/pip/_internal/cli/cmdoptions.py`,
    `No option allows or forbids ${kind} requirements (concluded from the list of options). Hash-checking mode (--require-hashes, or any --hash) rejects VCS and local directory requirements, unless --no-require-hashes (26.2) turns the automatic mode off.`,
  ),
});

export const pip: ToolKnowledge = {
  id: 'pip',
  name: 'pip',
  kind: 'package-manager',
  ecosystem: 'pypi',
  cooldown: {
    setting: verified(
      'uploaded-prior-to',
      `${USER_GUIDE}#filtering-by-upload-time`,
      'Only files uploaded before the given time are considered; applies to packages from remote indexes, not to local files, find-links directories or VCS requirements. Isolated build environments get the same cutoff.',
    ),
    configFiles: verified(
      [],
      CONFIGURATION,
      'pip reads no configuration from the project: only the global, user and site (virtual environment) pip.conf, the file named by PIP_CONFIG_FILE and PIP_* environment variables. --uploaded-prior-to is not allowed in requirements files, so a project sets it through PIP_UPLOADED_PRIOR_TO or the command line, e.g. in CI.',
    ),
    cliFlag: verified('--uploaded-prior-to', `${USER_GUIDE}#filtering-by-upload-time`, 'pip install, download, wheel, lock, index and list; environment variable PIP_UPLOADED_PRIOR_TO.'),
    unit: verified(
      'days',
      `${PIP}/src/pip/_internal/cli/cmdoptions.py`,
      'A duration is written PnD, a whole number of days (P3D, matched by ^P(\\d+)D$); P1W, PT24H and "7 days" are rejected. An ISO 8601 date or time is a fixed cutoff instead. A day is always 24 hours.',
    ),
    availableSince: verified(
      '26.1.0',
      NEWS,
      'pip 26.1 accepts a duration in days ("P3D for 3 days ago"); the option itself exists since 26.0 with dates only.',
    ),
    default: verified([{ since: '26.1.0', value: null }], `${USER_GUIDE}#filtering-by-upload-time`, 'Off unless given.'),
    exclude: {
      setting: uncertain(null, `${USER_GUIDE}#filtering-by-upload-time`, 'No per-package exception (concluded from the list of options).'),
    },
    securityUpdates: uncertain(
      'applies',
      `${USER_GUIDE}#filtering-by-upload-time`,
      'pip does not know which versions fix vulnerabilities; the cutoff holds back every new upload.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      SECURE_INSTALLS,
      'pip builds a source distribution when no wheel fits, which runs its build backend; the secure-installs guide recommends --only-binary :all:. Installing a wheel runs no package code.',
    ),
    allowList: {
      setting: verified(
        '--no-binary',
        FORMAT_CONTROL,
        'After --only-binary=:all:, a package named in --no-binary may only be installed from source: a name wins over :all:, so its wheels are not used. --only-binary=:all: given after it clears the exception.',
      ),
      file: verified('requirements.txt', REQ_FILE, '--only-binary and --no-binary are among the options a requirements file may contain.'),
      availableSince: uncertain(
        '7.0.0',
        NEWS,
        '--no-binary and --only-binary exist since 7.0.0 and are read from pip.conf since 7.1.0; when requirements files started to accept them is not recorded.',
      ),
      format: verified(
        'One option line per package or a comma-separated list, e.g. --no-binary=docopt',
        `${PIP}/src/pip/_internal/cli/cmdoptions.py`,
        'Each use adds to the set; :all: and :none: are special values.',
      ),
    },
    disableAll: verified(
      '--only-binary=:all:',
      SECURE_INSTALLS,
      'Allowed in requirements files and pip.conf (only-binary). Enforced only for packages from indexes and find-links: VCS, local directory and direct URL source requirements are still built.',
    ),
  },
  sources: {
    git: noSetting('VCS'),
    remoteTarball: noSetting('direct URL'),
    file: noSetting('local archive'),
    directory: noSetting('local directory'),
  },
  project: {
    lockfiles: verified(
      [{ since: '25.1.0', value: ['pylock.toml'] }],
      `${PYLOCK}#file-name`,
      'pip lock (experimental since 25.1) writes pylock.toml; pip install -r pylock.toml is experimental since 26.1. The specification also allows pylock.<name>.toml (extra.lockfilePattern).',
    ),
    manifests: verified(
      ['requirements.txt'],
      REQUIREMENTS_FORMAT,
      '"requirements.txt is usually what these files are named (although, that is not a requirement)"; the format is meant only for pip.',
    ),
    workspaces: uncertain(null, REQUIREMENTS_FORMAT, 'pip has no workspaces.'),
    workspacesObjectKey: uncertain(null, REQUIREMENTS_FORMAT, 'No workspaces.'),
  },
  user: {
    files: user.verified(
      [
        {
          since: '0.0.0',
          value: {
            format: 'ini',
            locations: [
              {
                platforms: ['linux'],
                directories: [{ from: { env: 'XDG_CONFIG_HOME' }, path: 'pip' }, { from: 'home', path: '.config/pip' }],
                file: 'pip.conf',
              },
              {
                platforms: ['darwin'],
                directories: [{ from: 'home', path: 'Library/Application Support/pip', ifExists: true }, { from: 'home', path: '.config/pip' }],
                file: 'pip.conf',
              },
              {
                platforms: ['win32'],
                directories: [{ from: { env: 'APPDATA' }, path: 'pip' }, { from: 'home', path: 'AppData/Roaming/pip' }],
                file: 'pip.ini',
              },
            ],
          },
        },
      ],
      `${CONFIGURATION}#location`,
      'The user file is pip.conf (pip.ini on Windows) in appdirs.user_config_dir("pip") (configuration.py), written in INI with [global] and per-command sections. Linux: $HOME/.config/pip/pip.conf, "which respects the XDG_CONFIG_HOME environment variable" (used when it is not empty after stripping spaces, vendored platformdirs _xdg.py). macOS: ~/Library/Application Support/pip when that directory exists, else ~/.config/pip, where XDG_CONFIG_HOME is not used (utils/appdirs.py); since 26.2 $XDG_DATA_HOME/pip comes first when XDG_DATA_HOME is not empty and that directory exists, and with XDG_DATA_HOME set the Library directory is skipped. Windows: %APPDATA%\\pip\\pip.ini; platformdirs asks Windows for the Roaming AppData known folder, which APPDATA normally names. The legacy ~/.pip/pip.conf (%HOME%\\pip\\pip.ini) is loaded as well, below this file. Same path code in 25.0; earlier versions are not tracked.',
    ),
    settings: user.verified(
      [
        { purpose: 'cooldown', key: 'uploaded-prior-to', since: '26.1.0' },
        { purpose: 'buildsDeny', key: 'only-binary', since: '7.1.0' },
        { purpose: 'buildsAllow', key: 'no-binary', since: '7.1.0' },
      ],
      NEWS,
      'depcurfew writes them in [global], which reaches every command that has the option (install, download, wheel, lock, index, list) and the resolver of pipenv lock; [install] reaches only pip install. "Accept --no-binary and --only-binary via pip.conf" (7.1.0); uploaded-prior-to is read from pip.conf like every long option ("To override a duration set in configuration, pass P0D on the command line", user_guide.rst). 26.1.0 because depcurfew writes a PnD duration: pip 26.0 takes dates only and aborts on P7D, and 25.x ignores the key. uv does not read pip.conf.',
    ),
    unknownKeys: user.verified(
      'ignore',
      PARSER,
      '"Ignore options not present in this parser": a key that is not an option of the command is skipped without a word (same code in 25.0), so pip before 26.0 ignores uploaded-prior-to.',
    ),
    invalidValueFails: user.verified(
      true,
      PARSER,
      'A pip.conf that is not valid INI stops pip (ConfigurationFileCouldNotBeLoaded, configuration.py), and a value an option rejects ends the command with a usage error: pip 26.0 aborts on uploaded-prior-to = P7D in every command that has the option, as it rejected PIP_UPLOADED_PRIOR_TO=P100000D in a test on 2026-10-30 (configuration values and PIP_* variables go through the same parsing). Commands without the option ignore the key.',
    ),
    weakening: user.verified(
      [
        { key: 'no-binary', values: [':all:'], effect: 'builds every package from source and clears only-binary' },
        { key: 'only-binary', values: [':none:'], effect: 'clears only-binary, so source distributions are built again' },
        { key: 'uploaded-prior-to', values: ['P0D'], effect: 'turns the upload-time delay off' },
        { key: 'find-links', values: 'any', effect: 'adds find-links locations; packages from find-links directories skip uploaded-prior-to' },
      ],
      FORMAT_CONTROL,
      'In any section of any pip.conf: [install] beats [global], and a later file (a virtual environment pip.conf, PIP_CONFIG_FILE) beats the user file per key, an empty value removing it (cli/parser.py). :all: in one of the lists clears the other and :none: clears its own (handle_mutual_excludes). P0D overrides a configured duration, and "Local package files are allowed regardless of the --uploaded-prior-to setting", find-links directories included (user_guide.rst). A requirements file can also pass --no-binary or --only-binary, but not --uploaded-prior-to.',
    ),
    variables: user.verified(
      [
        { name: 'PIP_CONFIG_FILE', values: 'any', effect: 'pip loads this file last; when it exists the user pip.conf is not loaded, and os.devnull turns every configuration file off' },
        { name: 'PIP_UPLOADED_PRIOR_TO', values: 'any', effect: 'overrides uploaded-prior-to from every pip.conf' },
        { name: 'PIP_ONLY_BINARY', values: [':none:'], effect: 'is applied after every pip.conf and clears only-binary' },
        { name: 'PIP_NO_BINARY', values: 'any', effect: 'is applied after every pip.conf and builds these packages from source; :all: clears only-binary' },
      ],
      CONFIGURATION,
      '"Note that if a file exists at the location that this is set to, the user config file will not be loaded." PIP_<NAME> variables are applied after the [global] and command sections of all files, and the command line beats them (cli/parser.py, override_order). --isolated, a flag, ignores environment variables and user configuration. XDG_CONFIG_HOME (Linux) and XDG_DATA_HOME (macOS, 26.2) move the user directory (see files).',
    ),
  },
  extra: {
    configSections: user.verified(
      { global: 'global', commandsOverride: true },
      CONFIGURATION,
      '"Each subcommand can be configured optionally in its own section. This overrides the global setting with the same name", and "A command specific section in the config file `[<command>] host = bar` overrides the option with same name in the `[global]` config file section" (Precedence / Override order). pip reads only [global], the section of the running command and :env: (override_order = ["global", self.name, ":env:"] in cli/parser.py), so a managed key in [install] wins over [global] for pip install; depcurfew comments such keys out in every section other than [global].',
    ),
    pylockCreatedBy: verified('pip', `${PIP}/src/pip/_internal/utils/pylock.py`, 'pip lock writes created-by = "pip".'),
    requirementsOptions: rechecked.verified(
      [
        '-i', '--index-url', '--pypi-url', '--extra-index-url', '--no-index', '-c', '--constraint', '-r', '--requirement', '-e', '--editable',
        '-f', '--find-links', '--no-binary', '--only-binary', '--prefer-binary', '--require-hashes', '--no-require-hashes',
        '--pre', '--all-releases', '--only-final', '--trusted-host', '--use-feature',
      ],
      REQ_FILE,
      'SUPPORTED_OPTIONS in pip 26.2.2 (--pypi-url is a second name of --index-url in cmdoptions.py); per requirement also --hash and -C/--config-settings (extra.requirementsParser). Any other option, --uploaded-prior-to included, makes the file fail to parse.',
    ),
    requirementsParser: rechecked.verified(
      {
        longOptions: [
          '--index-url', '--pypi-url', '--extra-index-url', '--no-index', '--constraint', '--requirement', '--editable', '--find-links',
          '--no-binary', '--only-binary', '--prefer-binary', '--require-hashes', '--no-require-hashes', '--pre', '--all-releases',
          '--only-final', '--trusted-host', '--use-feature', '--hash', '--config-settings',
        ],
        shortOptions: ['-i', '-c', '-r', '-e', '-f', '-C'],
        abbreviations: true,
      },
      REQ_FILE,
      'build_parser reads each line with optparse.OptionParser(add_help_option=False) holding SUPPORTED_OPTIONS and SUPPORTED_OPTIONS_REQ (--hash, -C/--config-settings), with the names from cmdoptions.py in pip 26.2.2. optparse takes a long option shortened to a prefix that names exactly one of them (_match_abbrev; an exact name wins), so --no-bin :all: is --no-binary :all:, and an ambiguous prefix such as --no is an error. --hash and --config-settings belong to the requirement on their line; on a line of their own they are accepted and ignored.',
    ),
    buildSwitch: uncertain(
      { setting: '--only-binary', value: ':all:', since: '7.0.0', covers: ['registry'] },
      NEWS,
      'The option exists since 7.0.0; when requirements files started to accept it is not recorded. pip applies it only to packages found on indexes and find-links (format_control is used only by the package finder), so VCS, local directory and direct URL source requirements are still built.',
    ),
    configFileNames: verified(
      ['pip.conf', 'pip.ini'],
      `${PIP}/src/pip/_internal/configuration.py`,
      'CONFIG_BASENAME is pip.ini on Windows and pip.conf elsewhere; pip looks for it only in the global, user and site locations, never in the project.',
    ),
    configFileVariable: verified(
      'PIP_CONFIG_FILE',
      `${CONFIGURATION}#environment-variable`,
      'Names a configuration file pip loads last; set to os.devnull it turns all configuration files off.',
    ),
    environmentVariable: verified(
      'PIP_UPLOADED_PRIOR_TO',
      `${CONFIGURATION}#environment-variables`,
      'Every long option has a PIP_<UPPER_LONG_NAME> variable with dashes replaced by underscores. Tested on 2026-10-30: pip 25.3 ignored PIP_UPLOADED_PRIOR_TO=P100000D without a word, 26.0 rejected the duration (dates only), 26.1 and 26.2.2 found no version.',
    ),
    durationStrings: verified({ since: '26.1.0', syntax: 'iso8601' }, NEWS, 'Only whole days, written PnD, are accepted.'),
    missingUploadTime: verified(
      'Installation fails when an index gives no upload time while --uploaded-prior-to is set',
      `${USER_GUIDE}#filtering-by-upload-time`,
      'Upload times exist only in the JSON form of the simple repository API (PEP 700); indexes that serve only HTML have none.',
    ),
    lockfileFormat: verified(
      { packages: 'packages', vcs: 'vcs', directory: 'directory', archive: 'archive', sdist: 'sdist', wheels: 'wheels', index: 'index', createdBy: 'created-by', sources: { git: 'vcs', remoteTarball: 'archive', directory: 'directory' } },
      PYLOCK,
      'Each [[packages]] entry has exactly one of vcs (always built), directory (always built), archive (a source tree or wheel at a URL or path) or sdist and wheels from an index. A package with an sdist and no wheels is built when installed. A relative directory path is relative to the lock file. The required top-level created-by records the name of the tool that wrote the file, preferably its normalized Python package name.',
    ),
    requirementsForms: verified(
      'name==version with --hash options, name @ URL for an archive, a local archive or project path, and VCS URLs (name @ git+https://… or -e git+…)',
      REQUIREMENTS_FORMAT,
    ),
    requirementsFormat: verified(
      { vcs: { git: ['git+'], other: ['hg+', 'svn+', 'bzr+'] }, direct: ' @ ', editable: ['-e', '--editable'], egg: '#egg=', comment: '#', continuation: '\\' },
      `${PIP}/docs/html/topics/vcs-support.md`,
      'VCS requirements start with git+, hg+, svn+ or bzr+, alone or after "name @"; a direct reference is "name @ URL" (PEP 508); -e installs a project path or VCS URL in editable mode. The legacy #egg= fragment names the project of a VCS URL. Lines ending with a backslash continue on the next line, and # starts a comment (requirements-file-format.md).',
    ),
    requirementsIncludes: verified(
      { requirements: ['-r', '--requirement'], constraints: ['-c', '--constraint'] },
      `${REQUIREMENTS_FORMAT}#referring-to-other-requirements-files`,
      'Option names from cli/cmdoptions.py. A relative path is relative to the directory of the file that includes it, and a file given as an http, https or file URL is downloaded (req_file.py, _parse_and_recurse); a file that includes itself is an error.',
    ),
    requirementsPaths: verified(
      {
        separators: ['/', '\\'],
        currentDirectory: '.',
        archiveExtensions: ['.zip', '.whl', '.tar.bz2', '.tbz', '.tar.gz', '.tgz', '.tar', '.tar.xz', '.txz', '.tlz', '.tar.lz', '.tar.lzma'],
        urlSchemes: ['http', 'https', 'ftp'],
        fileScheme: 'file:',
      },
      `${PIP}/src/pip/_internal/req/constructors.py`,
      'A requirement that contains a path separator (/, and \\ on Windows) or starts with . looks like a path (_looks_like_path): a directory there is a project built from source. A name with an archive extension (utils/filetypes.py) is a local archive, even when the file does not exist. http, https, ftp and file URLs are links (utils/urls.py, is_url).',
    ),
    lockfilePattern: verified(
      '^pylock\\.([^.]+)\\.toml$',
      `${PYLOCK}#file-name`,
      'A named lock file, next to or instead of pylock.toml; pip lock -o writes any name.',
    ),
    commandLine: verified(
      {
        add: [['pip', 'install'], ['pip3', 'install']],
        run: [],
        create: [],
        valueOptions: [
          '-r', '--requirement', '-c', '--constraint', '--build-constraint', '--requirements-from-script', '-e', '--editable',
          '--group', '-t', '--target', '--platform', '--python-version', '--implementation', '--abi', '--root', '--prefix',
          '--src', '--source', '--source-dir', '--source-directory', '--upgrade-strategy', '-C', '--config-settings',
          '--progress-bar', '--root-user-action', '--report', '-i', '--index-url', '--pypi-url', '--extra-index-url', '-f',
          '--find-links', '--refresh-package', '--uploaded-prior-to', '--no-binary', '--only-binary', '--all-releases',
          '--only-final', '--python', '--log', '--log-file', '--local-log', '--keyring-provider', '--proxy', '--retries',
          '--resume-retries', '--timeout', '--default-timeout', '--exists-action', '--trusted-host', '--cert', '--client-cert',
          '--cache-dir', '--use-feature', '--use-deprecated',
        ],
        flagOptions: [
          '--no-deps', '--no-dependencies', '--only-deps', '--only-dependencies', '--dry-run', '--user', '--no-user', '-U',
          '--upgrade', '--force-reinstall', '-I', '--ignore-installed', '--ignore-requires-python', '--no-build-isolation',
          '--use-pep517', '--check-build-dependencies', '--break-system-packages', '--compile', '--no-compile',
          '--no-warn-script-location', '--no-warn-conflicts', '--require-hashes', '--no-require-hashes', '--no-clean',
          '--no-index', '--pre', '--prefer-binary', '-h', '--help', '--debug', '--isolated', '--require-virtualenv',
          '--require-venv', '-v', '--verbose', '-V', '--version', '-q', '--quiet', '--no-input', '--no-proxy-env',
          '--no-cache-dir', '--disable-pip-version-check', '--no-color', '--no-python-version-warning',
        ],
        parsing: { abbreviations: true, groupedShortOptions: true },
        editableOptions: ['-e', '--editable'],
      },
      `${PIP}/src/pip/_internal/commands/install.py`,
      'pip and pip3 are the console scripts of the package (pyproject.toml). The options of pip install (install.py) and the general options of every command (cmdoptions.py, general_group), which may also come before install. pip reads them with optparse: --opt value and --opt=value, -rFILE and -r FILE, grouped short flags, and a long option shortened to any prefix that names one option (cli/parser.py keeps optparse\'s matching), so --extra means --extra-index-url. -e takes a local project path or a VCS URL to install in editable mode. -r, -c, --requirements-from-script and --group read requirements from files of the project.',
    ),
    registryOverrides: verified(
      {
        registryOptions: ['-i', '--index-url', '--pypi-url', '--extra-index-url', '-f', '--find-links'],
        registryVariables: ['PIP_INDEX_URL', 'PIP_PYPI_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS'],
        configOptions: [],
        configVariables: ['PIP_CONFIG_FILE'],
      },
      CMDOPTIONS,
      'index_group: --index-url (alias -i, --pypi-url) is the base URL of the package index, --extra-index-url adds indexes, --find-links (-f) adds an HTML page or a directory of archives. Every long option can be set as PIP_<UPPER_LONG_NAME>, dashes replaced by underscores (docs/html/topics/configuration.md); PIP_CONFIG_FILE names a configuration file loaded last, which may set any index. Requirements files may set --index-url, --extra-index-url and --find-links too (req/req_file.py).',
    ),
    selection: verified(
      {
        prereleases: {
          onFlags: ['--pre'],
          onLists: ['--all-releases'],
          offLists: ['--only-final'],
          flagVariables: ['PIP_PRE'],
          onListVariables: ['PIP_ALL_RELEASES'],
          offListVariables: ['PIP_ONLY_FINAL'],
        },
        buildFromSource: {
          onLists: ['--no-binary'],
          offLists: ['--only-binary'],
          onListVariables: ['PIP_NO_BINARY'],
          offListVariables: ['PIP_ONLY_BINARY'],
        },
      },
      CMDOPTIONS,
      '--pre includes pre-release and development versions (pip only finds stable versions by default) and stands for --all-releases :all:; --all-releases and --only-final take :all:, :none: or package names separated by commas and allow or forbid pre-releases of those packages (models/release_control.py, allows_prereleases: a named package first, then :all:). --no-binary and --only-binary take the same lists: --no-binary keeps pip from using wheels, so the package is built from source, --only-binary from using source distributions (models/format_control.py, handle_mutual_excludes and get_allowed_formats). Each long option can also be set as PIP_<NAME> (docs/html/topics/configuration.md), which the command line overrides.',
    ),
    pipxSelection: verified(
      {
        prereleases: { flagVariables: ['PIP_PRE'], onListVariables: ['PIP_ALL_RELEASES'], offListVariables: ['PIP_ONLY_FINAL'] },
        buildFromSource: { onListVariables: ['PIP_NO_BINARY'], offListVariables: ['PIP_ONLY_BINARY'] },
      },
      `${PIPX}/docs/reference/environment-variables.rst`,
      'pipx forwards the standard PIP_* variables to pip (except PIP_USER, PIP_DISABLE_PIP_VERSION_CHECK, PIP_TARGET and PIP_KEYRING_PROVIDER); the uv backend ignores them (docs/how-to/use-private-index.rst). pipx has no option of its own for pre-releases or source builds; --pip-args may carry them.',
    ),
    pipxCommandLine: verified(
      {
        add: [['pipx', 'install']],
        run: [{ command: ['pipx', 'run'], packageOptions: ['--spec'], extraPackageOptions: ['--with'], scriptSuffixes: ['.py'] }],
        create: [],
        valueOptions: [
          '-i', '--index-url', '--pip-args', '--preinstall', '--lock', '--include-resources-from', '--upgrade-strategy',
          '--suffix', '--python', '--fetch-python', '--app', '--cooldown', '--backend', '--output', '--python-args',
        ],
        flagOptions: [
          '-q', '--quiet', '-v', '--verbose', '--skip-maintenance', '--global', '-f', '--force', '-U', '--upgrade',
          '--include-deps', '--system-site-packages', '--fetch-missing-python', '-e', '--editable', '--no-cache',
          '--refresh', '--no-path-check', '--path', '--pypackages', '--version',
        ],
        parsing: { abbreviations: true, groupedShortOptions: true },
        addPackageOptions: ['--preinstall'],
      },
      `${PIPX}/src/pipx/main.py`,
      'pipx installs applications from PyPI with pip (or uv) in environments of their own. pipx install takes one or more package specs, a VCS URL, a local path or archive, or a script (--preinstall adds packages to the environment; -f is --force, not find-links). pipx run takes the app first (argparse REMAINDER, so its options come before it), --spec names the package to install and run, --with adds packages; a first argument ending in .py is a local script, or a script to download when it is a URL (docs/how-to/run-scripts.rst). argparse accepts abbreviated long options.',
    ),
    pipxRegistryOverrides: verified(
      { registryOptions: ['-i', '--index-url'], registryVariables: [], configOptions: ['--pip-args'], configVariables: [] },
      `${PIPX}/src/pipx/main.py`,
      '--index-url is the base URL of the index; --pip-args is split and handed to pip, so it may carry --extra-index-url, --find-links or --no-index. With the pip backend pipx passes the PIP_* variables on to pip; with the uv backend it ignores them and uv reads its own (docs/how-to/use-uv-backend.rst); both kinds are registry variables of pip and uv.',
    ),
    latestVersion: verified('26.2.2', NEWS, 'Released on 2026-10-20.'),
  },
};
