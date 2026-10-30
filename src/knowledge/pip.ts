import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');

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
  extra: {
    requirementsOptions: verified(
      [
        '-i', '--index-url', '--extra-index-url', '--no-index', '-c', '--constraint', '-r', '--requirement', '-e', '--editable',
        '-f', '--find-links', '--no-binary', '--only-binary', '--prefer-binary', '--require-hashes', '--no-require-hashes',
        '--pre', '--all-releases', '--only-final', '--trusted-host', '--use-feature',
      ],
      REQ_FILE,
      'SUPPORTED_OPTIONS in pip 26.2.2; per requirement also --hash and --config-settings. Any other option, --uploaded-prior-to included, makes the file fail to parse.',
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
      { packages: 'packages', vcs: 'vcs', directory: 'directory', archive: 'archive', sdist: 'sdist', wheels: 'wheels', index: 'index', sources: { git: 'vcs', remoteTarball: 'archive', directory: 'directory' } },
      PYLOCK,
      'Each [[packages]] entry has exactly one of vcs (always built), directory (always built), archive (a source tree or wheel at a URL or path) or sdist and wheels from an index. A package with an sdist and no wheels is built when installed.',
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
