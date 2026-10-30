import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-30');

// pdm-project.org is built from docs/ in the repository.
const PDM = 'https://github.com/pdm-project/pdm/blob/2.29.5';
const LOCKFILE = `${PDM}/docs/usage/lockfile.md`;
const CHANGELOG = `${PDM}/CHANGELOG.md`;
const CANDIDATES = `${PDM}/src/pdm/models/candidates.py`;

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
    latestVersion: verified('2.29.5', CHANGELOG, 'Released on 2026-10-30.'),
  },
};
