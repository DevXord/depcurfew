import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-30');

// python-poetry.org/docs is built from docs/ in the repository.
const POETRY = 'https://github.com/python-poetry/poetry/blob/2.5.1';
const CONFIGURATION = `${POETRY}/docs/configuration.md`;
const CHANGELOG = `${POETRY}/CHANGELOG.md`;
const LOCKER = `${POETRY}/src/poetry/packages/locker.py`;
const CHOOSER = `${POETRY}/src/poetry/installation/chooser.py`;

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${CONFIGURATION}#available-settings`,
    `No setting allows or forbids ${kind} dependencies (concluded from the list of settings and Config.default_config); dependencies of dependencies may come from such sources too.`,
  ),
});

export const poetry: ToolKnowledge = {
  id: 'poetry',
  name: 'Poetry',
  kind: 'package-manager',
  ecosystem: 'pypi',
  cooldown: {
    setting: verified(
      'solver.min-release-age',
      `${CONFIGURATION}#solvermin-release-age`,
      'A version is ignored while any of its files was uploaded less than the given number of days ago. Applies when dependencies are resolved (poetry lock, add, update); poetry install installs the locked versions without checking.',
    ),
    configFiles: verified(
      ['poetry.toml'],
      `${CONFIGURATION}#local-configuration`,
      'The local configuration next to pyproject.toml (poetry config --local), not pyproject.toml itself. Environment variables (POETRY_SOLVER_MIN_RELEASE_AGE) win over poetry.toml, which wins over the user config.toml.',
    ),
    cliFlag: uncertain(null, `${POETRY}/docs/cli.md`, 'No command-line option; the environment variable POETRY_SOLVER_MIN_RELEASE_AGE sets it for one command.'),
    unit: verified('days', `${CONFIGURATION}#solvermin-release-age`, 'An integer; 0 (the default) turns it off.'),
    availableSince: verified(
      '2.4.0',
      `${CONFIGURATION}#solvermin-release-age`,
      '"Introduced in 2.4.0"; announced as dependency cooldowns. Tested on 2026-10-30: Poetry 2.3.4 locked with min-release-age = 100000 in poetry.toml without a word, while 2.4.0 and 2.5.1 found no version.',
    ),
    default: verified([{ since: '2.4.0', value: null }], `${CONFIGURATION}#solvermin-release-age`, 'Default 0: all versions are considered.'),
    exclude: {
      setting: verified('solver.min-release-age-exclude', `${CONFIGURATION}#solvermin-release-age-exclude`),
      availableSince: verified('2.4.0', `${CONFIGURATION}#solvermin-release-age-exclude`),
      patternSyntax: verified('Exact package names; no wildcards', `${CONFIGURATION}#solvermin-release-age-exclude`),
    },
    securityUpdates: uncertain(
      'applies',
      `${CONFIGURATION}#solvermin-release-age`,
      'Poetry does not know which versions fix vulnerabilities; the delay holds back every new version of a package not listed in solver.min-release-age-exclude.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      `${CONFIGURATION}#installeronly-binary`,
      'Without installer.only-binary, packages are built from source distributions when no wheel fits, which runs their build backend. Git and directory dependencies are always built. Installing a wheel runs no package code.',
    ),
    allowList: {
      setting: verified(
        'installer.no-binary',
        CHOOSER,
        'With installer.only-binary = [":all:"], the packages named in installer.no-binary are the only ones built from source; explicit names take precedence over :all: since 2.2.0. Their wheels are rejected, so they are always built.',
      ),
      file: verified('poetry.toml', `${CONFIGURATION}#installerno-binary`, 'The docs recommend configuring it with --local for a project.'),
      availableSince: verified(
        '2.2.0',
        CHANGELOG,
        '"explicit package names will take precedence over :all:" (#10278). Before 2.2.0 a package listed in both settings has no file left to install.',
      ),
      format: verified(
        'A list of package names, or :all: or :none:',
        `${CONFIGURATION}#installerno-binary`,
        'poetry config stores the value as a list; written by hand, a boolean is not normalized.',
      ),
    },
    disableAll: verified(
      'installer.only-binary',
      `${CONFIGURATION}#installeronly-binary`,
      'Since 2.0.0; the value [":all:"] forbids source distributions for every package. Applied only when installing: resolving dependencies may still build source distributions without static metadata, and git, path and url dependencies are built regardless.',
    ),
  },
  sources: {
    git: noSetting('git'),
    remoteTarball: noSetting('url'),
    file: noSetting('local file'),
    directory: noSetting('local directory'),
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['poetry.lock'] }], `${POETRY}/src/poetry/factory.py`, 'Next to pyproject.toml.'),
    manifests: verified(['pyproject.toml'], `${POETRY}/docs/pyproject.md`),
    workspaces: uncertain(
      null,
      'https://github.com/python-poetry/poetry/issues/2270',
      'Poetry has no workspaces: the 2.5.1 docs do not mention them and the request for subprojects is open.',
    ),
    workspacesObjectKey: uncertain(null, 'https://github.com/python-poetry/poetry/issues/2270', 'No workspaces.'),
  },
  extra: {
    configTable: verified(
      { solver: 'solver', installer: 'installer' },
      `${POETRY}/src/poetry/config/file_config_source.py`,
      'poetry config writes dotted settings as nested tables, e.g. [solver] min-release-age = 7.',
    ),
    pyprojectTable: verified(
      'tool.poetry',
      'https://github.com/python-poetry/poetry-core/blob/2.5.0/src/poetry/core/pyproject/toml.py',
      'A [tool.poetry] table marks a Poetry project; Poetry also accepts a [project] table with a static name and version, which other tools use as well.',
    ),
    configLocation: verified(
      'poetry.toml is read only from the directory of the pyproject.toml Poetry found (the current directory or the nearest parent with one)',
      `${POETRY}/src/poetry/factory.py`,
    ),
    buildSwitch: verified(
      { setting: 'installer.only-binary', value: [':all:'], since: '2.0.0', covers: ['registry'] },
      CHANGELOG,
      'installer.only-binary was added in 2.0.0; [":all:"] forbids source distributions of index packages when installing. Git and directory dependencies, and source archives from a URL or path, are built regardless (src/poetry/installation/executor.py at 2.5.1).',
    ),
    excludeFormat: disputed(
      'The 2.5.1 docs give the type string, a comma-separated list; the docs on main (pull request #11087, not released) give array and say to use a TOML array in poetry.toml. The 2.5.1 code iterates the value as it is, so a string would be read letter by letter. Tested on 2026-10-30: a TOML array exempted the package in Poetry 2.4.0 and 2.5.1.',
      evidence('comma-separated string', `${CONFIGURATION}#solvermin-release-age-exclude`),
      evidence('TOML array', 'https://github.com/python-poetry/poetry/pull/11087'),
    ),
    excludeWildcards: verified({ since: null, trailingOnly: false }, `${CONFIGURATION}#solvermin-release-age-exclude`, 'Package names only.'),
    missingUploadTime: verified(
      'A release whose source gives no upload times is not filtered by solver.min-release-age',
      `${CONFIGURATION}#solvermin-release-age`,
    ),
    lockedVersionsKept: uncertain(
      'poetry lock and poetry add keep versions already in poetry.lock even when they are newer than the delay allows; poetry update and poetry lock --regenerate resolve them again',
      `${POETRY}/src/poetry/mixology/version_solver.py`,
      'Read from the solver code, which takes the locked package without asking the repository; the docs do not say it.',
    ),
    requiredVersion: verified(
      { table: 'tool.poetry', key: 'requires-poetry', since: '2.0.0' },
      `${POETRY}/docs/pyproject.md#requires-poetry`,
      'A version constraint in pyproject.toml; a Poetry version outside it raises an error. Poetry 1.x does not know the key.',
    ),
    lockfileFormat: uncertain(
      {
        sources: { git: 'git', remoteTarball: 'url', file: 'file', directory: 'directory', registry: 'legacy' },
        packages: 'package',
        source: 'source',
        files: 'files',
      },
      LOCKER,
      'poetry.lock has no documented format. Each [[package]] from PyPI has no [package.source]; others have type git, url, file, directory or legacy (a named index). files lists {file, hash} for every distribution, empty for git and directory packages; a package from an index without a .whl file is built when installed.',
    ),
    commandLine: verified(
      {
        add: [['poetry', 'add']],
        run: [],
        create: [],
        valueOptions: ['-C', '--directory', '-P', '--project', '-G', '--group', '-E', '--extras', '--optional', '--python', '--platform', '--markers', '--source'],
        parsing: { groupedShortOptions: true },
      },
      `${POETRY}/docs/cli.md#add`,
      'poetry add takes package specs: a name, name@constraint, a PEP 508 requirement, a git URL, a path or an archive URL. Options with a value: --group (-G), --extras (-E), --optional, --python, --platform, --markers and --source of add, and the global --directory (-C) and --project (-P); -e/--editable, -D/--dev, --allow-prereleases, --dry-run and --lock are flags (src/poetry/console/commands/add.py). cleo reads -Gdocs and -G docs; long options cannot be shortened. poetry install takes no package specs.',
    ),
    registryOverrides: verified(
      { registryOptions: ['--source'], registryVariables: [], configOptions: [], configVariables: [] },
      `${POETRY}/docs/repositories.md`,
      '--source names a package source of [[tool.poetry.source]] in pyproject.toml (or pypi) to take the package from. The POETRY_REPOSITORIES_<NAME>_URL variables are for publishing only; no variable sets a package source.',
    ),
    versionConstraints: verified(
      { separator: '@', latest: 'latest', caret: '^', tilde: '~', any: '*' },
      `${POETRY}/docs/dependency-specification.md#using-the--operator`,
      'poetry add name@constraint takes any constraint valid in pyproject.toml, and name@latest the newest release; extras go before the @ (name[extra]@^4.0.0). ^ keeps the left-most non-zero part of major.minor.patch: ^1.2.3 is >=1.2.3 <2.0.0, ^1.2 is >=1.2.0 <2.0.0, ^1 is >=1.0.0 <2.0.0, ^0.2.3 is >=0.2.3 <0.3.0, ^0.0.3 is >=0.0.3 <0.0.4, ^0.0 is >=0.0.0 <0.1.0, ^0 is >=0.0.0 <1.0.0. ~ allows patch changes, or minor changes when only a major version is given: ~1.2.3 is >=1.2.3 <1.3.0, ~1.2 is >=1.2.0 <1.3.0, ~1 is >=1.0.0 <2.0.0. * is any version, 1.* is >=1.0.0 <2.0.0, 1.2.* is >=1.2.0 <1.3.0. ~=, inequalities and == as in PEP 440, several separated by commas; a bare version (1.2.3) is that version only. Poetry prefers stable releases and takes a pre-release only when no stable release satisfies the constraint.',
    ),
    selection: verified(
      {
        prereleases: { onFlags: ['--allow-prereleases'] },
        buildFromSource: { onListVariables: ['POETRY_INSTALLER_NO_BINARY'], offListVariables: ['POETRY_INSTALLER_ONLY_BINARY'], listBooleans: true },
      },
      CONFIGURATION,
      'installer.no-binary (POETRY_INSTALLER_NO_BINARY) disallows wheels for :all: or true, none for :none: or false, or the named packages separated by commas; installer.only-binary (POETRY_INSTALLER_ONLY_BINARY, since 2.0.0) takes the same values; explicit package names win over :all:. poetry add --allow-prereleases accepts pre-releases (src/poetry/console/commands/add.py).',
    ),
    latestVersion: verified('2.5.1', CHANGELOG, 'Released on 2026-09-20.'),
  },
};
