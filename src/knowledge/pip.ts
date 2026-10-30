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
      'pip lock (experimental since 25.1) writes pylock.toml; pip install -r pylock.toml is experimental since 26.1. The specification also allows pylock.<name>.toml.',
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
    environmentVariable: verified(
      'PIP_UPLOADED_PRIOR_TO',
      `${CONFIGURATION}#environment-variables`,
      'Every long option has a PIP_<UPPER_LONG_NAME> variable with dashes replaced by underscores.',
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
      { vcs: { git: ['git+'], other: ['hg+', 'svn+', 'bzr+'] }, direct: ' @ ', editable: ['-e', '--editable'], comment: '#', continuation: '\\' },
      `${PIP}/docs/html/topics/vcs-support.md`,
      'VCS requirements start with git+, hg+, svn+ or bzr+, alone or after "name @"; a direct reference is "name @ URL" (PEP 508); -e installs a project path or VCS URL in editable mode. Lines ending with a backslash continue on the next line, and # starts a comment (requirements-file-format.md).',
    ),
    latestVersion: verified('26.2.2', NEWS, 'Released on 2026-10-20.'),
  },
};
