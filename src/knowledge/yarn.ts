import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge, UserVariable } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const rechecked = verifiedOn('2026-10-31');
const user = verifiedOn('2026-10-31');
const leftovers = verifiedOn('2026-11-01');
const BERRY = 'https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1';
const CONFIGURATION = `${BERRY}/packages/yarnpkg-core/sources/Configuration.ts`;

/** Variables for settings with a single value, which both the docs and the code accept. */
const SCALAR_VARIABLES: readonly UserVariable[] = [
  { name: 'YARN_ENABLE_SCRIPTS', anyCase: true, values: { except: ['false', '0'] }, effect: 'runs dependency build scripts, whatever any .yarnrc.yml says' },
  { name: 'YARN_NPM_MINIMAL_AGE_GATE', anyCase: true, values: 'any', effect: 'replaces npmMinimalAgeGate from every .yarnrc.yml' },
];

const YARNRC = 'https://yarnpkg.com/configuration/yarnrc';
const MANIFEST = 'https://yarnpkg.com/configuration/manifest';
const SECURITY = 'https://yarnpkg.com/features/security';
const SCHEMA = 'https://github.com/yarnpkg/berry/blob/master/packages/docusaurus/static/configuration/yarnrc.json';
const release = (version: string) => `https://github.com/yarnpkg/berry/releases/tag/%40yarnpkg%2Fcli%2F${version}`;

const noSetting = (source: string, note: string): SourceKnowledge => ({ setting: uncertain(null, source, note) });

export const yarn: ToolKnowledge = {
  id: 'yarn',
  name: 'Yarn (Berry)',
  kind: 'package-manager',
  cooldown: {
    setting: verified('npmMinimalAgeGate', `${YARNRC}#npmMinimalAgeGate`),
    configFiles: verified(
      ['.yarnrc.yml'],
      YARNRC,
      'Also YARN_NPM_MINIMAL_AGE_GATE (general YARN_ env rule) and, since 4.17.0, npmScopes.<scope>.npmMinimalAgeGate. package.json cannot set it.',
    ),
    cliFlag: uncertain(
      null,
      'https://yarnpkg.com/cli/install',
      'No flag sets the gate. --no-time-gate on yarn add and yarn up (4.15.0+) disables it for one command; yarn install has no such flag.',
    ),
    unit: verified(
      'minutes',
      'https://github.com/yarnpkg/berry/pull/6942',
      'Bare numbers are minutes. Since 4.11.0 duration strings with ms, s, m, h, d or w (e.g. 3d, 1w) also work; on 4.10.x a string such as 7d silently had no effect.',
    ),
    availableSince: checked.verified(
      '4.10.2',
      release('4.10.2'),
      'The setting arrived in 4.10.0 (release notes, pull request and source; the security docs page at https://yarnpkg.com/features/security says 4.12). 4.10.2 fixed it: "Bust the metadata cache" (#6908) and "support registries without publish times using minimalAgeGate" (#6907). On 2026-10-29 Yarn 4.10.1 with npmMinimalAgeGate: 4320 refused zod@3.23.8 and esbuild@0.25.0, both over a year old ("No candidates found"), while 4.10.2, 4.10.3, 4.11.0 and 4.12.0 installed them and refused a version 4 hours old. depcurfew writes the setting from 4.10.2 on.',
    ),
    default: disputed(
      'The code is unambiguous: off until 4.14.x, 1d from 4.15.0. The published settings schema claimed 3d for 4.11.0-4.14.x and 0m in 4.16.0; the live yarnrc page shows "1w", which is an example value. Upgraded projects with an old lockfile get npmMinimalAgeGate: 0 written to .yarnrc.yml (see upgradeMigration).',
      evidence(
        [
          { since: '4.10.0', value: 0 },
          { since: '4.15.0', value: '1d' },
        ],
        release('4.15.0'),
      ),
      evidence(
        [
          { since: '4.10.0', value: 0 },
          { since: '4.11.0', value: '3d' },
          { since: '4.15.0', value: '1d' },
        ],
        'https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.11.0/packages/docusaurus/static/configuration/yarnrc.json',
      ),
    ),
    exclude: {
      setting: verified('npmPreapprovedPackages', `${YARNRC}#npmPreapprovedPackages`),
      availableSince: verified('4.10.0', release('4.10.0')),
      patternSyntax: verified(
        'Package descriptors or name globs, optionally with a semver range: @scope/*, package, package*, package@^1.0.0; global only, not per npmScopes',
        `${YARNRC}#npmPreapprovedPackages`,
      ),
    },
    securityUpdates: uncertain(
      'applies',
      'https://yarnpkg.com/cli/npm/audit',
      'No automatic bypass is documented and yarn npm audit only reports. Options: --no-time-gate on yarn add/up, a pinned npmPreapprovedPackages entry, or a per-scope gate of 0.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [
        { since: '2.0.0', value: 'run' },
        { since: '4.14.0', value: 'deny-except-allowlist' },
      ],
      release('4.14.0'),
      'Workspace scripts still run. Upgraded projects with an old lockfile get enableScripts: true written to .yarnrc.yml. Yarn 1 runs scripts unless --ignore-scripts is passed.',
    ),
    allowList: {
      setting: verified('dependenciesMeta.<package>.built', `${MANIFEST}#dependenciesMeta.built`),
      file: verified('package.json', `${MANIFEST}#dependenciesMeta`, 'Root package.json only; ignored inside workspaces.'),
      availableSince: uncertain(
        '2.0.0',
        'https://github.com/yarnpkg/berry/blob/master/CHANGELOG.md',
        'dependenciesMeta is documented in the changelog from the 2.x line; the exact first version was not pinned down.',
      ),
      format: verified(
        'Object keyed by package name or name@version: { built: true } allows a package when enableScripts is false; { built: false } denies it when enableScripts is true',
        `${MANIFEST}#dependenciesMeta.built`,
      ),
    },
    disableAll: verified(
      'enableScripts: false',
      `${YARNRC}#enableScripts`,
      'Set in .yarnrc.yml; the default since 4.14.0. yarn install --mode=skip-build skips builds for one run. Berry ignores YARN_IGNORE_SCRIPTS.',
    ),
  },
  sources: {
    git: {
      setting: verified('approvedGitRepositories', `${YARNRC}#approvedGitRepositories`),
      values: verified(
        ['repository URL glob patterns, e.g. https://github.com/org/*'],
        `${YARNRC}#approvedGitRepositories`,
      ),
      availableSince: verified('4.14.0', release('4.14.0')),
      default: verified(
        [{ since: '4.14.0', value: '[] (every git dependency is blocked)' }],
        SCHEMA,
        'Upgraded projects with an old lockfile get ["**"] written to .yarnrc.yml.',
      ),
    },
    remoteTarball: noSetting(
      YARNRC,
      'No setting restricts http(s) tarball dependencies (concluded from the full settings list); the closest are enableNetwork, networkSettings.<host>.enableNetwork and unsafeHttpWhitelist for plain http.',
    ),
    file: noSetting(
      'https://yarnpkg.com/protocol/file',
      'No setting restricts file:, link: or portal: dependencies (concluded from the settings list and plugin sources); only exec: is gated by enableScripts (4.14.0+).',
    ),
    directory: noSetting(
      'https://yarnpkg.com/protocol/file',
      'No setting restricts local directory dependencies (file:, link:, portal:), as for local tarballs.',
    ),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['yarn.lock'] }],
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-fslib/sources/path.ts',
      'Yarn Classic uses the same name; see berryLockfileMarker and classicLockfileHeader to tell them apart.',
    ),
    manifests: verified(['package.json'], MANIFEST),
    workspaces: verified({ files: ['package.json'], key: 'workspaces' }, `${MANIFEST}#workspaces`, 'Array of folder glob patterns.'),
    workspacesObjectKey: uncertain(
      'packages',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Manifest.ts',
      'Not documented; the manifest parser also accepts { "packages": [...] }.',
    ),
  },
  user: {
    files: user.verified(
      [
        {
          since: '0.0.0',
          value: { format: 'yaml', locations: [{ platforms: ['linux', 'darwin', 'win32'], directories: [{ from: 'home', path: '' }], file: '.yarnrc.yml' }] },
        },
      ],
      CONFIGURATION,
      'Configuration.find adds .yarnrc.yml from the home folder (folderUtils.getHomeFolder: os.homedir(), else /usr/local/share) with the lowest priority, also for projects outside the home folder; the name stays .yarnrc.yml even when YARN_RC_FILENAME is set. The yarnrc page does not describe it; yarn config set -H writes the home file (https://yarnpkg.com/cli/config/set). The lookup is the same in 4.0.0, and the 2.2.0 changelog already speaks of the home configuration file; the first version was not tracked.',
    ),
    settings: user.verified(
      [
        { purpose: 'cooldown', key: 'npmMinimalAgeGate', since: '4.10.2' },
        { purpose: 'cooldownExclude', key: 'npmPreapprovedPackages', since: '4.10.0' },
        { purpose: 'buildsDeny', key: 'enableScripts', since: '4.0.0' },
        { purpose: 'sourceGit', key: 'approvedGitRepositories', since: '4.14.0' },
      ],
      CONFIGURATION,
      'Configuration.use knows no project-only settings, so the home file sets these wherever the version has them; the first versions are those of cooldown, cooldown.exclude and sources.git, and enableScripts is checked in 4.0.0. enableScripts: false denies every dependency build script (scriptsSwitch); buildsDeny is the closest purpose, since Yarn has no strict mode. The allow-list dependenciesMeta.<package>.built is read from the root package.json only (Project.getDependencyMeta), so Yarn has no user-level allow-list. depcurfew does not write npmScopes.<scope>.npmMinimalAgeGate.',
    ),
    unknownKeys: user.verified(
      'ignore',
      CONFIGURATION,
      'Configuration.use sets a key it does not know aside without an error when it comes from the home file, even with enableStrictSettings; other files throw. The 2.2.0 changelog: "Unsupported options will simply be silently ignored."',
    ),
    invalidValueFails: user.uncertain(
      true,
      CONFIGURATION,
      'Read from code at 4.18.1: parseValue errors are rethrown with the file name while the configuration loads, so a value Yarn cannot parse, such as enableScripts: maybe or a malformed duration, stops every command, also from the home file. On 4.10.x a duration string such as 7d silently had no effect instead (durationStrings). Not tested.',
    ),
    weakening: user.uncertain(
      [
        { key: 'approvedGitRepositories', values: 'any', effect: 'approves these git repositories in every project, on top of the project\'s own list' },
        { key: 'npmPreapprovedPackages', values: 'any', effect: 'exempts these packages from the age gate in every project, on top of the project\'s own list' },
        { key: 'enableScripts', values: { except: [false, 0, 'false', '0'] }, effect: 'runs dependency build scripts in every project whose .yarnrc.yml does not set enableScripts' },
        { key: 'npmMinimalAgeGate', values: [0], effect: 'turns the age gate off in every project whose .yarnrc.yml does not set it' },
        { key: 'npmScopes.*.npmMinimalAgeGate', values: [0], effect: 'turns the age gate off for that scope in every project' },
      ],
      `${BERRY}/packages/yarnpkg-core/sources/configUtils.ts`,
      'Read from code (resolveRcFiles, the same since 4.0.0; not on yarnpkg.com, and no test was read): lists from every .yarnrc.yml are joined, so home entries add to a project\'s list unless the project uses the undocumented { onConflict: reset } form; objects such as npmScopes merge key by key; for single values the file closest to the project wins. Since 4.17.0 a scope listed in the home npmScopes only for its registry gets the default gate of 1d instead of the project\'s gate (perScopeGate). A .yarnrc.yml in any folder between the root and the project merges the same way. enableScripts is a switch that turns a protection off: Yarn reads every value as text (FAILSAFE_SCHEMA, see extra.yamlMergeKeys) and parseBoolean of miscUtils.ts takes true and 1 as true and false and 0 as false and stops on any other value, after replacing ${VARIABLE} references; depcurfew counts every value but false and 0 as on.',
    ),
    variables: user.disputed(
      'The yarnrc docs say environment variables cannot set lists, but parseValue splits a string on commas for list settings, so by the code YARN_APPROVED_GIT_REPOSITORIES and YARN_NPM_PREAPPROVED_PACKAGES work. The safe choice is to treat both as effective.',
      user.evidence(
        [
          ...SCALAR_VARIABLES,
          {
            name: 'YARN_APPROVED_GIT_REPOSITORIES',
            anyCase: true,
            values: 'any',
            effect: 'replaces approvedGitRepositories from every .yarnrc.yml (a comma-separated list)',
          },
          {
            name: 'YARN_NPM_PREAPPROVED_PACKAGES',
            anyCase: true,
            values: 'any',
            effect: 'replaces npmPreapprovedPackages from every .yarnrc.yml (a comma-separated list)',
          },
        ],
        CONFIGURATION,
        'A variable starting with yarn_ in any case sets the camel-cased setting before the rc files are read, and they cannot change it (Configuration.find and use; YARN_IGNORE_SCRIPTS is ignored); a list setting takes a comma-separated string (parseValue); enableScripts accepts true or 1 (parseBoolean), false or 0 turn it off, and any other value stops Yarn, so every value but false and 0 counts as on.',
      ),
      user.evidence(
        SCALAR_VARIABLES,
        `${BERRY}/packages/docusaurus/static/configuration/yarnrc.json`,
        'Most settings "can also be defined through environment variables (at least for the simpler ones; arrays and objects aren\'t supported yet)", and such values "will overwrite any that might have been defined in the RC files".',
      ),
    ),
  },
  extra: {
    registrySettings: leftovers.verified(
      [
        { file: '.yarnrc.yml', path: ['npmRegistryServer'], applies: 'all', effect: 'replaces' },
        { file: '.yarnrc.yml', path: ['npmScopes', '*', 'npmRegistryServer'], applies: 'scope', effect: 'replaces' },
      ],
      YARNRC,
      'npmRegistryServer: "Define the registry to use when fetching packages"; npmScopes: "Per-scope registry configurations", whose entries take npmRegistryServer ("See npmRegistryServer"), keyed by the scope without @. "While Yarn will automatically find them in the parent directories, they should usually be kept at the root of your project". Yarn (Berry) does not read registry= from .npmrc.',
    ),
    yamlMergeKeys: user.verified(
      false,
      `${BERRY}/packages/yarnpkg-parsers/sources/syml.ts`,
      'parseSyml reads .yarnrc.yml with load of js-yaml and FAILSAFE_SCHEMA, which has no merge type (only strings, sequences and maps), so <<: *defaults is an ordinary key named <<: Configuration.use rejects it as an unrecognized setting in a project .yarnrc.yml (enableStrictSettings, default true) and sets it aside in the home file, so merged values never apply. Every scalar is a string to Yarn, which parses it per setting (parseValue in packages/yarnpkg-core/sources/Configuration.ts).',
    ),
    classicUserFile: user.verified(
      { until: '2.0.0', file: '.yarnrc' },
      'https://github.com/yarnpkg/yarn/blob/v1.22.22/src/registries/yarn-registry.js',
      'Yarn Classic (1.x, last release 1.22.22) reads .yarnrc and .npmrc from the project, its parent folders, the home folder (homeConfigLoc = ~/.yarnrc) and the global prefix (getPossibleConfigLocations in src/registries/npm-registry.js), never .yarnrc.yml, which only Yarn 2 and later read. depcurfew does not configure Yarn Classic.',
    ),
    yarnPath: leftovers.uncertain(
      { key: 'yarnPath', releaseFile: 'yarn-<version>.cjs', variables: ['YARN_YARN_PATH', 'YARN_IGNORE_PATH'] },
      `${BERRY}/packages/plugin-essentials/sources/commands/set/version.ts`,
      'yarn set version saves the release as .yarn/releases/yarn-<version>.cjs and writes a relative yarnPath to it. Yarn 2 and later read yarnPath (an absolute path setting, resolved against the folder of the .yarnrc.yml that sets it) from every .yarnrc.yml, the home file included, before the project is found (Configuration.find, pickPrimaryCoreFields), and run node <yarnPath> instead of themselves (runYarnPath in packages/yarnpkg-cli/sources/lib.ts); a nearer .yarnrc.yml with its own yarnPath, YARN_YARN_PATH or YARN_IGNORE_PATH changes that. The file name is only a hint: a URL or a file given to yarn set version gives other names (yarn-remote.cjs), a hand-written yarnPath may name any file, and the version inside the bundle is minified, so depcurfew uses the name only when it is yarn-<exact version>.cjs and the file exists.',
    ),
    denyList: user.verified(
      { file: 'package.json', setting: 'dependenciesMeta.<package>.built', value: false, since: '2.0.0' },
      'https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/packages/plugin-pnp/sources/jsInstallUtils.ts',
      'With built: false in the root package.json, Yarn reports that the build "has been explicitly disabled through configuration" as an info message instead of the warning that all build scripts are disabled; built: false also wins over enableScripts: true. Only the top-level manifest counts (CHANGELOG 2.0.0).',
    ),
    projectInstall: leftovers.verified(
      { commands: ['install'], bare: true },
      `${BERRY}/packages/plugin-essentials/sources/commands/install.ts`,
      'The install command ("install the project dependencies") has the paths [`install`] and Command.Default, so yarn without a command installs too. yarn add (commandLine.add) adds packages.',
    ),
    commandLine: checked.verified(
      {
        add: [['yarn', 'add']],
        run: [{ command: ['yarn', 'dlx'], packageOptions: ['-p', '--package'] }],
        create: [{ command: ['yarn', 'create'], packageOptions: ['-p', '--package'] }],
        createNames: 'prefix-unless-prefixed',
        workspaceCommands: [{ command: ['yarn', 'workspace'], operands: 1 }],
        valueOptions: ['--mode'],
      },
      'https://github.com/yarnpkg/berry/tree/master/packages/plugin-dlx/sources/commands',
      'dlx.ts (documented at https://yarnpkg.com/cli/dlx) downloads the package named by the command, or the ones given with -p/--package, into a temporary environment and runs it. create.ts (yarn create, not on yarnpkg.com) takes -p/--package as well and runs create-<name>: @foo becomes @foo/create, @foo/app becomes @foo/create-app, foo becomes create-foo, and a name that already matches ^create(-|$) is kept (so is create alone). yarn add (https://yarnpkg.com/cli/add) takes packages as arguments; of its options only --mode takes a value. yarn workspace <workspaceName> <commandName> … runs a command within that workspace, e.g. yarn workspace components add -D react (https://yarnpkg.com/cli/workspace).',
    ),
    packageSpecs: checked.verified(
      { git: [], local: ['link:', 'portal:', 'file:'], workspace: ['workspace:'] },
      'https://yarnpkg.com/protocols',
      'Protocols besides npm: and git: exec:, file:, jsr:, link:, patch:, portal: and workspace:. link: connects an external directory (https://yarnpkg.com/protocol/link), portal: a relative path to a package folder (https://yarnpkg.com/protocol/portal) and file: copies a folder or tarball.',
    ),
    registryOverrides: checked.verified(
      { registryOptions: [], registryVariables: ['YARN_NPM_REGISTRY_SERVER'], configOptions: [], configVariables: ['YARN_RC_FILENAME'] },
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Configuration.ts',
      'Environment variables that start with yarn_ (any case) set the setting named by the camel-cased rest, so YARN_NPM_REGISTRY_SERVER sets npmRegistryServer, the registry packages are fetched from (https://yarnpkg.com/configuration/yarnrc#npmRegistryServer). getRcFilename reads yarn_rc_filename (any case) as the name of the configuration file instead of .yarnrc.yml. npmScopes, an object, cannot be set this way.',
    ),
    lockfileFormat: checked.verified(
      {
        installScripts: null,
        registry: 'npm:',
        workspace: 'workspace:',
        patch: 'patch:',
        file: 'file:',
        directory: ['portal:', 'link:'],
        gitCommit: '#commit=',
        tarball: '\\.(?:tar\\.gz|tgz)$',
      },
      'https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/yarnpkg-core/sources/Project.ts',
      'Each entry has resolution: name@<locator>: npm:<version> for the registry, <repository>#commit=<sha> for git (GitHub shortcuts become https://github.com/<owner>/<repo>.git), an http(s) URL for tarballs, file:<path> (a .tgz or .tar.gz path is a tarball, anything else a directory), portal: and link: for directories, workspace: for workspace packages, and patch: around the URL-encoded original locator. No field records install scripts; dependenciesMeta.built: false is a user opt-out.',
    ),
    durationStrings: verified(
      { since: '4.11.0', syntax: 'compact', before: 'no effect' },
      'https://github.com/yarnpkg/berry/pull/6942',
      'npmMinimalAgeGate accepts a number followed by ms, s, m, h, d or w (e.g. 3d, 1w) since 4.11.0; on 4.10.x such a string silently had no effect.',
    ),
    scriptsSwitch: verified({ setting: 'enableScripts', allow: true, deny: false }, `${YARNRC}#enableScripts`),
    excludeWildcards: verified(
      { since: '4.10.0', trailingOnly: false },
      `${YARNRC}#npmPreapprovedPackages`,
      'Name globs such as @scope/* or package* in npmPreapprovedPackages.',
    ),
    berryLockfileMarker: uncertain(
      '__metadata',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts',
      'Read from code: Yarn 2+ writes a __metadata key into yarn.lock and treats a lockfile without it but with "yarn lockfile v1" as Yarn Classic.',
    ),
    classicLockfileHeader: verified(
      '# yarn lockfile v1',
      'https://github.com/yarnpkg/yarn/blob/master/src/lockfile/stringify.js',
      'Written as # yarn lockfile v${LOCKFILE_VERSION} with LOCKFILE_VERSION = 1 (src/constants.js).',
    ),
    latestVersion: verified('4.18.1', release('4.18.1'), 'Yarn 6 is still in preview.'),
    bypassFlag: verified('--no-time-gate on yarn add and yarn up (4.15.0+)', 'https://yarnpkg.com/cli/add'),
    configCommands: leftovers.verified(
      [{ command: ['yarn', 'config'], writes: ['set', 'unset'] }],
      `${BERRY}/packages/plugin-essentials/sources/index.ts`,
      'plugin-essentials registers config get, config set and config unset next to config (commands/config/*.ts at 4.18.1). yarn config set updates the project configuration, or the home configuration with -H/--home (commands/config/set.ts); yarn config and yarn config get only print settings (commands/config.ts: "This command prints the current active configuration settings").',
    ),
    installOverrides: leftovers.verified(
      {
        options: [{ name: '--no-time-gate', weakens: 'delay', values: 'any' }],
        variables: [
          { name: 'YARN_NPM_MINIMAL_AGE_GATE', weakens: 'delay', values: 'delay' },
          { name: 'YARN_NPM_PREAPPROVED_PACKAGES', weakens: 'delay', values: 'any' },
          { name: 'YARN_ENABLE_SCRIPTS', weakens: 'scripts', values: { except: ['false', '0'] } },
        ],
      },
      `${BERRY}/packages/yarnpkg-core/sources/Configuration.ts`,
      'yarn add declares noTimeGate = Option.Boolean(`--no-time-gate`), "Disable the minimum release age check for this command" (plugin-essentials/sources/commands/add.ts at 4.18.1). getEnvironmentSettings lowercases every environment variable, keeps those starting with yarn_ and camel-cases the rest into a setting (ENVIRONMENT_PREFIX), so YARN_NPM_MINIMAL_AGE_GATE sets npmMinimalAgeGate, YARN_NPM_PREAPPROVED_PACKAGES npmPreapprovedPackages and YARN_ENABLE_SCRIPTS enableScripts; the values that keep scripts off are those of user.variables.',
    ),
    perScopeGate: rechecked.verified(
      { scopes: 'npmScopes', setting: 'npmMinimalAgeGate', since: '4.17.0', unset: '1d' },
      'https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.18.1/packages/plugin-npm/sources/npmConfigUtils.ts',
      'getMinimalAgeGate: for a scoped package, a number in npmScopes.<scope>.npmMinimalAgeGate (the scope name without @) replaces the global gate, longer or shorter, and 0 turns the gate off for that scope (acceptance tests "npmScopes override" in features/npmMinimalAgeGate.test.ts at 4.18.1; the code is the same in 4.17.0 and absent in 4.16.0). Each npmScopes entry is a shape whose unset properties get their defaults (parseShape and getDefaultValue in yarnpkg-core Configuration.ts), so a scope listed only for its registry gets the default of 1d (scopablePackageGateSettings in plugin-npm index.ts) instead of the global gate; read from the code, no test covers that case.',
    ),
    upgradeMigration: verified(
      'When the lockfile predates the new defaults and the key is unset, yarn install writes enableScripts: true, approvedGitRepositories: ["**"] and npmMinimalAgeGate: 0 into .yarnrc.yml',
      'https://github.com/yarnpkg/berry/pull/7135',
      'Explicit values written by depcurfew prevent the migration.',
    ),
    missingPublishTime: verified(
      'Versions without a publish time are quarantined while the gate is on',
      'https://github.com/yarnpkg/berry/pull/6907',
    ),
    unknownSettings: uncertain(
      'Unknown keys in the project .yarnrc.yml throw (unless enableStrictSettings is false), so settings newer than the pinned Yarn break installs',
      'https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Configuration.ts',
      'Read from the current source code; older releases were not checked.',
    ),
  },
};
