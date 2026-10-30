import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');

// pipenv.pypa.io is built from docs/ in the repository.
const PIPENV = 'https://github.com/pypa/pipenv/blob/v2026.10.4';
const PIPFILE = `${PIPENV}/docs/pipfile.md`;
const CHANGELOG = `${PIPENV}/CHANGELOG.md`;
const CONFIGURATION = `${PIPENV}/docs/configuration.md`;

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
  extra: {
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
