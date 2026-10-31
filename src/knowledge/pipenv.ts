import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');

// pipenv.pypa.io is built from docs/ in the repository.
const PIPENV = 'https://github.com/pypa/pipenv/blob/v2026.10.4';
const PIPFILE = `${PIPENV}/docs/pipfile.md`;
const CHANGELOG = `${PIPENV}/CHANGELOG.md`;
const CONFIGURATION = `${PIPENV}/docs/configuration.md`;
const user = verifiedOn('2026-10-31');

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(null, PIPFILE, `No Pipfile setting allows or forbids ${kind} dependencies (concluded from the documented [pipenv] directives).`),
});

export const pipenv: ToolKnowledge = {
  id: 'pipenv',
  name: 'Pipenv',
  kind: 'package-manager',
  ecosystem: 'pypi',
  cooldown: {
    setting: verified(
      'cool-down-period',
      `${PIPFILE}#cool-down-period`,
      'In the [pipenv] section of the Pipfile: the resolver considers only versions uploaded at least that many days ago. Pipenv computes a cutoff (now minus N days, UTC) and hands it to pip as uploaded-prior-to.',
    ),
    configFiles: verified(['Pipfile'], `${PIPFILE}#pipenv-directives`, 'The [pipenv] section.'),
    cliFlag: uncertain(null, `${PIPENV}/docs/commands.md`, 'No command-line option.'),
    unit: verified('duration-string', `${PIPFILE}#cool-down-period`, 'A string in <int>d format, e.g. "30d"; any other form is rejected (pipenv/vendor/plette/models/sections.py).'),
    availableSince: verified(
      '2026.6.2',
      CHANGELOG,
      '"Added support for cool-down-period in the [pipenv] section of the Pipfile" under 2026.6.2 (repeated under 2026.7.0 and 2026.7.1). Checked against the wheels on 2026-10-30: missing in 2026.6.1, present in 2026.6.2.',
    ),
    default: verified([{ since: '2026.6.2', value: null }], `${PIPFILE}#cool-down-period`, 'Off unless set.'),
    exclude: {
      setting: uncertain(null, `${PIPFILE}#cool-down-period`, 'No per-package exception: the cutoff applies to every package.'),
    },
    securityUpdates: uncertain('applies', `${PIPFILE}#cool-down-period`, 'The cutoff holds back every newer version, security fixes included.'),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      CONFIGURATION,
      'Pipenv installs with pip, which builds source distributions when no wheel fits. Pipenv honors pip configuration and PIP_* variables, which may forbid building (PIP_ONLY_BINARY=:all:), but the Pipfile has no setting for it.',
    ),
    allowList: {
      setting: uncertain(null, PIPFILE, 'No documented setting; a per-package no_binary = true exists in the code (pipenv/routines/install.py) but forces building rather than allowing it.'),
    },
    disableAll: uncertain(
      null,
      CONFIGURATION,
      'No Pipfile setting. Only pip configuration or PIP_ONLY_BINARY=:all: in the environment (Pipenv loads the project .env for every command) forbids building.',
    ),
  },
  sources: {
    git: noSetting('git'),
    remoteTarball: noSetting('URL'),
    file: noSetting('local archive'),
    directory: noSetting('local directory'),
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['Pipfile.lock'] }], `${PIPFILE}#pipfilelock`, 'JSON, generated next to the Pipfile.'),
    manifests: verified(['Pipfile'], `${PIPFILE}#pipfile`, 'TOML.'),
    workspaces: uncertain(null, PIPFILE, 'Pipenv has no workspaces.'),
    workspacesObjectKey: uncertain(null, PIPFILE, 'No workspaces.'),
  },
  user: {
    files: user.verified(
      [{ since: '0.0.0', value: null }],
      CONFIGURATION,
      'Pipenv has no user configuration file of its own: it reads environment variables (set in a shell profile), the project .env file and pip configuration; pipenv/environments.py looks up no file. Since 2026.3.0 the pip install step runs with PIP_CONFIG_FILE=/dev/null (pipenv/utils/pip.py; CHANGELOG.md, #6066), so a user pip.conf no longer protects pipenv install and sync. The lock resolver still reads pip.conf, but only [global], because its pip command is named InstallCommand (pipenv/utils/resolver.py), and a Pipfile cool-down-period replaces its uploaded-prior-to.',
    ),
    settings: user.verified([], CONFIGURATION, 'No user file to write to; at user level only PIP_* variables reach the pip install step (see variables).'),
    unknownKeys: user.verified('ignore', CONFIGURATION, 'No user file.'),
    invalidValueFails: user.verified(false, CONFIGURATION, 'No user file.'),
    weakening: user.verified([], CONFIGURATION, 'No user file; see variables.'),
    variables: user.uncertain(
      [
        { name: 'PIPENV_RESOLVER', values: ['pure-python'], effect: 'selects the pure-python resolver, which ignores cool-down-period' },
        { name: 'PIPENV_PYPI_MIRROR', values: 'any', effect: 'replaces PyPI; on a mirror without upload times cool-down-period has no effect' },
        { name: 'PIP_ONLY_BINARY', values: 'any', effect: 'sets only-binary of the pip Pipenv installs with, which no pip.conf reaches since 2026.3.0' },
        { name: 'PIP_NO_BINARY', values: 'any', effect: 'builds these packages from source when installing, and pipenv install records no_binary for a named package in the Pipfile' },
      ],
      `${PIPENV}/pipenv/utils/resolver.py`,
      'PIPENV_RESOLVER is not documented. The code ranks it above the resolver key of the Pipfile ("CLI/caller > env > current project\'s Pipfile > default"), and the pure-python backend locked the newest versions despite cool-down-period when chosen in the Pipfile (extra.resolverBypass, tested on 2026-10-30); the variable itself was not tested. PIPENV_PYPI_MIRROR: "When the index does not provide upload-time metadata (e.g. most private mirrors) the setting is accepted but has no filtering effect" (docs/pipfile.md). PIP_* variables are merged over the environment of the pip subprocess (pipenv/utils/processes.py), so they still reach it while pip.conf does not; pipenv/routines/install.py also reads PIP_NO_BINARY.',
    ),
  },
  extra: {
    pylockCreatedBy: verified(
      'pipenv',
      `${PIPENV}/pipenv/utils/pylock.py`,
      'Pipenv writes created-by = "pipenv" in the pylock.toml it generates (docs/pylock.md). pipenv install -e . writes the project itself as { path = ".", editable = true } (docs/pipfile.md), and Pipfile.lock keeps it as "path": ".".',
    ),
    configTables: verified({ Pipfile: 'pipenv' }, `${PIPFILE}#pipenv-directives`, 'Directives such as cool-down-period and allow_prereleases live in [pipenv].'),
    durationStrings: verified({ since: '2026.6.2', syntax: 'compact' }, `${PIPFILE}#cool-down-period`, 'Only whole days (<int>d) are accepted.'),
    durationUnits: verified(['days'], `${PIPFILE}#cool-down-period`, 'Whole days only.'),
    missingUploadTime: verified(
      'An index without upload times makes the setting accepted but without effect',
      `${PIPFILE}#cool-down-period`,
      '"When the index does not provide upload-time metadata (e.g. most private mirrors) the setting is accepted but has no filtering effect."',
    ),
    resolverBypass: uncertain(
      { table: 'pipenv', keys: ['resolver_backend', 'resolver'], value: 'pure-python' },
      `${PIPENV}/pipenv/routines/lock.py`,
      'Not documented. Tested on 2026-10-30 with 2026.10.4: with resolver_backend = "pure-python" in [pipenv], pipenv lock locked the newest versions despite cool-down-period = "100000d"; resolver is the older name of the key.',
    ),
    lockfileFormat: verified(
      { meta: '_meta', git: 'git', file: 'file', path: 'path', editable: 'editable', hashes: 'hashes' },
      `${PIPFILE}#pipfilelock-structure`,
      'Every key but _meta is a category (default, develop and custom ones) mapping names to entries: index packages have version, hashes and index; git entries git and ref; remote archives file; local projects path, and editable = true for editable installs (Pipfile "Packages Section"). The hashes of wheels and source distributions are listed together, so the lockfile does not show which packages are built.',
    ),
    commandLine: verified(
      {
        add: [['pipenv', 'install']],
        run: [],
        create: [],
        valueOptions: ['--pypi-mirror', '--python', '--extra-pip-args', '--resolver', '--categories', '--extras', '--config-settings', '-i', '--index', '-r', '--requirements', '-e', '--editable'],
        flagOptions: [
          '-h', '--help', '--version', '--where', '--venv', '--py', '--envs', '--rm', '--bare', '--man', '--support', '-v',
          '--verbose', '-q', '--quiet', '--clear', '--site-packages', '--no-site-packages', '--pre', '-d', '--dev', '--all',
          '--ignore-pipfile', '--skip-lock', '--system', '--deploy',
        ],
        parsing: { abbreviations: true, groupedShortOptions: true },
        editableOptions: ['-e', '--editable'],
      },
      `${PIPENV}/pipenv/cli/options.py`,
      'pipenv install takes packages as arguments (without any it installs the Pipfile) and editable ones with -e; -r imports a requirements file. The options of install and the global flags of pipenv, read with argparse, which accepts abbreviated long options.',
    ),
    registryOverrides: verified(
      { registryOptions: ['-i', '--index', '--pypi-mirror'], registryVariables: ['PIPENV_PYPI_MIRROR'], configOptions: ['--extra-pip-args'], configVariables: ['PIPENV_DOTENV_LOCATION'] },
      CONFIGURATION,
      '--index names a package index by URL or by a source name of the Pipfile; --pypi-mirror and PIPENV_PYPI_MIRROR replace PyPI. --extra-pip-args hands arguments to pip, which may name another index, and Pipenv loads PIP_* variables from the .env file that PIPENV_DOTENV_LOCATION names (options.py).',
    ),
    selection: verified(
      {
        prereleases: { onFlags: ['--pre'] },
        buildFromSource: { onListVariables: ['PIP_NO_BINARY'], offListVariables: ['PIP_ONLY_BINARY'] },
      },
      `${PIPENV}/pipenv/cli/options.py`,
      'pipenv install --pre allows pre-releases (and records allow_prereleases in the Pipfile, routines/install.py). Pipenv installs with pip, which reads PIP_NO_BINARY and PIP_ONLY_BINARY like --no-binary and --only-binary (see buildSwitch).',
    ),
    latestVersion: verified('2026.10.4', CHANGELOG, 'Released on 2026-10-28.'),
  },
};
