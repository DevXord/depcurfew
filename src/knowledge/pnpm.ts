import { verifiedOn } from './define.ts';
import type {
  DirectoryOptionsKnowledge,
  EnvironmentNameRule,
  PnpmfilesKnowledge,
  PnpmIncludesKnowledge,
  PnpmKnownPlugin,
  PnpmPluginsKnowledge,
  RootLifecycleScriptsKnowledge,
  RunnerOptionsKnowledge,
  SourceKnowledge,
  ToolKnowledge,
  UserLocation,
} from './types.ts';

const { verified, uncertain } = verifiedOn('2026-10-28');
// Facts whose sources D-170 pinned to a release tag or commit, checked again on 2026-11-03.
const d170 = verifiedOn('2026-11-03');
const checked = verifiedOn('2026-10-29');
const reviewed = verifiedOn('2026-10-30');
const rechecked = verifiedOn('2026-10-31');
const user = verifiedOn('2026-10-31');
const runtimes = verifiedOn('2026-11-01');
const release14 = verifiedOn('2026-11-02');
const runners = verifiedOn('2026-11-03');
const includes = verifiedOn('2026-11-03');
const PNPM_V12 = 'https://github.com/pnpm/pnpm/blob/v12.16.1';
const PNPM_V12_17 = 'https://github.com/pnpm/pnpm/blob/v12.17.0';
const PNPM_V11_CODE = 'https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/config/reader/src';

/** A file in pnpm's config directory (getConfigDir): $XDG_CONFIG_HOME/pnpm when set, else the platform's own place. */
const inConfigDir = (file: string): readonly UserLocation[] => [
  { platforms: ['linux'], directories: [{ from: { env: 'XDG_CONFIG_HOME' }, path: 'pnpm' }, { from: 'home', path: '.config/pnpm' }], file },
  { platforms: ['darwin'], directories: [{ from: { env: 'XDG_CONFIG_HOME' }, path: 'pnpm' }, { from: 'home', path: 'Library/Preferences/pnpm' }], file },
  {
    platforms: ['win32'],
    directories: [
      { from: { env: 'XDG_CONFIG_HOME' }, path: 'pnpm' },
      { from: { env: 'LOCALAPPDATA' }, path: 'pnpm/config' },
      { from: 'home', path: '.config/pnpm' },
    ],
    file,
  },
];

const RESOLUTION = 'https://pnpm.io/settings/dependency-resolution';
const SETTINGS_V10 = 'https://pnpm.io/10.x/settings';
const BUILD = 'https://pnpm.io/settings/build';
// pnpm.io/11.x redirects to the current docs, so pnpm 11 docs are cited from their source in the docs repository.
const RESOLUTION_V11 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/dependency-resolution.md';
const BUILD_V11 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/build.md';
const release = (version: string) => `https://github.com/pnpm/pnpm/releases/tag/v${version}`;

const exoticSubdeps: SourceKnowledge = {
  setting: verified(
    'blockExoticSubdeps',
    SETTINGS_V10,
    'Blocks git repositories and tarball URLs for transitive dependencies only; no setting blocks them as direct dependencies.',
  ),
  values: verified(['true', 'false'], RESOLUTION),
  availableSince: verified('10.26.0', SETTINGS_V10),
  default: verified(
    [
      { since: '10.26.0', value: 'false' },
      { since: '11.0.0', value: 'true' },
    ],
    release('11.0.0'),
  ),
};

const localPaths: SourceKnowledge = {
  setting: uncertain(
    null,
    'https://pnpm.io/settings',
    'No setting restricts file: or link: dependencies (concluded from the full settings list); blockExoticSubdeps treats local paths and workspace links as trusted.',
  ),
};

const WORKSPACE_YAML_V10 = 'https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/pnpm-workspace_yaml.md';

export const pnpm: ToolKnowledge = {
  id: 'pnpm',
  name: 'pnpm',
  kind: 'package-manager',
  cooldown: {
    setting: verified('minimumReleaseAge', 'https://pnpm.io/blog/releases/10.16'),
    configFiles: rechecked.verified(
      ['pnpm-workspace.yaml'],
      release('11.0.0'),
      'pnpm-workspace.yaml works in every version that has the setting. The global config.yaml exists only from 11.0.0 ("the new global config.yaml"); pnpm 10 reads user-level settings from ~/.npmrc and <configDir>/rc instead (see user.files). pnpm 10 also reads minimum-release-age from .npmrc; pnpm 11+ reads only auth and registry settings from .npmrc and ignores the package.json "pnpm" field.',
    ),
    cliFlag: uncertain(
      null,
      'https://pnpm.io/cli/install',
      'No dedicated flag is documented for install or add; release notes mention "a CLI flag" without syntax. Environment variable: PNPM_CONFIG_MINIMUM_RELEASE_AGE (pnpm 11+), npm_config_minimum_release_age (pnpm 10).',
    ),
    unit: verified('minutes', RESOLUTION, 'Integer number of minutes, e.g. 1440 = 1 day; no duration strings.'),
    availableSince: verified('10.16.0', release('10.16.0')),
    default: verified(
      [
        { since: '10.16.0', value: 0 },
        { since: '11.0.0', value: 1440 },
      ],
      RESOLUTION_V11,
      'The built-in 1440 is non-strict: pnpm adds immature versions to minimumReleaseAgeExclude instead of failing (see strictMode).',
    ),
    exclude: {
      setting: verified('minimumReleaseAgeExclude', SETTINGS_V10),
      availableSince: verified('10.16.0', release('10.16.0')),
      patternSyntax: verified(
        'Package names (all versions); globs such as @myorg/* since 10.17.0; exact versions name@1.2.3 or name@1.2.3 || 1.2.4 since 10.19.0; ranges are not documented',
        SETTINGS_V10,
      ),
    },
    securityUpdates: verified(
      'applies',
      'https://pnpm.io/cli/audit',
      'No setting bypasses the delay. Since 11.0.0, pnpm audit --fix adds the minimum patched version of each advisory to minimumReleaseAgeExclude (since 11.22.0 only while it is still inside the window).',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [
        { since: '0.0.0', value: 'run' },
        { since: '10.0.0', value: 'deny-except-allowlist' },
      ],
      release('10.0.0'),
      'Unreviewed builds only warn in pnpm 10; strictDepBuilds is true by default since 11.0.0, so they fail the install. Prepare scripts of git-hosted dependencies are blocked since 10.26.0.',
    ),
    allowList: {
      setting: verified(
        'allowBuilds',
        BUILD,
        'Replaced onlyBuiltDependencies, which was removed in 11.0.0 (see legacyAllowList). Since 12.11.0, permissions.<package>.build takes precedence over allowBuilds (extra.buildPermissions).',
      ),
      file: verified('pnpm-workspace.yaml', BUILD),
      availableSince: verified('10.26.0', SETTINGS_V10),
      format: verified(
        'Map of package matcher to true (allow) or false (deny), e.g. esbuild: true or "nx@21.6.4 || 21.6.5": true; a bare name never approves git or tarball dependencies (pnpm 11+)',
        BUILD_V11,
      ),
    },
    disableAll: includes.verified(
      'ignoreScripts',
      'https://pnpm.io/cli/install',
      'Default false; --ignore-scripts on the CLI. Also skips the project\'s own scripts. It does not stop the pnpmfiles (.pnpmfile.mjs, .pnpmfile.cjs, the pnpmfile and globalPnpmfile settings and the pnpmfiles of config-dependency plugins, extra.pnpmfiles), whose hooks still run and can change every setting; only ignorePnpmfile does ("Useful together with --ignore-scripts when you want to make sure that no script gets executed during install", pnpm/docs/pnpmfile.md at v12.17.0). resolve_pnpmfile_paths in pnpm/crates/cli/src/config_deps/hooks.rs at v12.17.0 tests ignore_pnpmfile only.',
    ),
  },
  sources: {
    git: exoticSubdeps,
    remoteTarball: exoticSubdeps,
    file: localPaths,
    directory: localPaths,
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['pnpm-lock.yaml'] }], 'https://github.com/pnpm/pnpm.io/blob/main/docs/git.md'),
    manifests: verified(
      ['package.json', 'package.json5', 'package.yaml'],
      'https://github.com/pnpm/pnpm.io/blob/main/docs/package_json.md',
    ),
    workspaces: verified(
      { files: ['pnpm-workspace.yaml'], key: 'packages' },
      WORKSPACE_YAML_V10,
      'Globs with ! exclusions. Without packages only the root is in the workspace; pnpm still reads settings from the file in single-package projects. pnpm ignores workspaces in package.json.',
    ),
    workspacesObjectKey: uncertain(null, WORKSPACE_YAML_V10, 'The docs show packages only as a list; concluded from the absence of an object form.'),
  },
  user: {
    files: user.verified(
      [
        {
          since: '0.0.0',
          value: {
            format: 'ini',
            locations: inConfigDir('rc'),
            // ~/.npmrc (userconfig of @pnpm/npm-conf: path.resolve(os.homedir(), '.npmrc')) is loaded before rc and wins.
            overriddenBy: [{ format: 'ini', locations: [{ platforms: ['linux', 'darwin', 'win32'], directories: [{ from: 'home', path: '' }], file: '.npmrc' }] }],
          },
        },
        // read with read-yaml-file like pnpm-workspace.yaml, so merge keys (<<) apply (extra.yamlMergeKeys).
        { since: '11.0.0', value: { format: 'yaml', locations: inConfigDir('config.yaml'), mergeKeys: true } },
      ],
      `${PNPM_V11_CODE}/dirs.ts`,
      'getConfigDir: $XDG_CONFIG_HOME/pnpm when it is set, else ~/Library/Preferences/pnpm on macOS, %LOCALAPPDATA%/pnpm/config on Windows (~/.config/pnpm without LOCALAPPDATA) and ~/.config/pnpm elsewhere; the same in 10.34.9 (config/config/src/dirs.ts) and 12.17.0 (pnpm/crates/config-dir/src/lib.rs). pnpm 10 reads <configDir>/rc, INI with kebab-case keys (config/config/src/index.ts at 10.34.9; first version not tracked), and also ~/.npmrc for every setting, which beats rc: loadNpmConf reads the command line, npm_config_* variables, the project and workspace .npmrc, ~/.npmrc (userconfig, path.resolve(os.homedir(), ".npmrc") in https://github.com/pnpm/npm-conf/blob/v3.0.3/lib/defaults.js) and the global npmrc, and only then is rc added as "pnpm-global", below all of them (index.ts at 10.34.9). From 11.0.0 the settings file is <configDir>/config.yaml with camelCase keys (11.0.0 changelog: "the new global config.yaml"), and ~/.npmrc and <configDir>/auth.ini carry only auth, registry and network settings. The 11.x and 12.x docs page cli/config.md still names a global rc file for registry and auth settings, which that code no longer reads.',
    ),
    settings: user.verified(
      [
        { purpose: 'cooldown', key: 'minimum-release-age', since: '10.16.0', until: '11.0.0' },
        { purpose: 'cooldownExclude', key: 'minimum-release-age-exclude', since: '10.16.0', until: '11.0.0' },
        { purpose: 'buildsAllow', key: 'only-built-dependencies', since: '10.0.0', until: '11.0.0' },
        { purpose: 'scriptsStrict', key: 'strict-dep-builds', since: '10.3.0', until: '11.0.0' },
        { purpose: 'sourcesExotic', key: 'block-exotic-subdeps', since: '10.26.0', until: '11.0.0' },
        { purpose: 'cooldown', key: 'minimumReleaseAge', since: '11.0.0' },
        { purpose: 'cooldownExclude', key: 'minimumReleaseAgeExclude', since: '11.0.0' },
        { purpose: 'cooldownStrict', key: 'minimumReleaseAgeStrict', since: '11.0.0' },
        { purpose: 'scriptsStrict', key: 'strictDepBuilds', since: '11.0.7' },
        { purpose: 'sourcesExotic', key: 'blockExoticSubdeps', since: '11.0.0', until: '12.0.0' },
      ],
      `${PNPM_V11_CODE}/configFileKey.ts`,
      'pnpm 10 reads the kebab-case keys from rc as from any .npmrc (config/config/src/types.ts: only-built-dependencies at 10.0.0, strict-dep-builds at 10.3.0, minimum-release-age and minimum-release-age-exclude at 10.16.0, block-exotic-subdeps at 10.26.0); since 10.13.0 build settings from these files apply only to projects whose package.json "pnpm" field and pnpm-workspace.yaml set none of dangerouslyAllowAllBuilds, onlyBuiltDependencies(File), neverBuiltDependencies or allowBuilds, and always to global installs. pnpm 11+ applies a config.yaml key only when isConfigFileKey accepts it and it is camelCase: the minimumReleaseAge keys and blockExoticSubdeps since 11.0.0, strictDepBuilds since 11.0.7 (in excludedPnpmKeys in 11.0.0-11.0.6). allowBuilds is project-only from 11.0.0 and dropped with a warning, so pnpm 11+ has no user-level allow-list. pnpm 12 silently drops blockExoticSubdeps from config.yaml although its key gate accepts it (clear_workspace_resolution_fields in pnpm/crates/config/src/workspace_yaml/workspace_scope.rs, 12.0.0 to 12.17.0). pnpm self-update takes the minimumReleaseAge settings only from config.yaml, the environment and the command line, never from the project.',
    ),
    unknownKeys: user.uncertain(
      'warn',
      `${PNPM_V11_CODE}/getConfig/globalConfigYaml.ts`,
      'pnpm 11 drops config.yaml keys it does not accept (unknown, project-only or not camelCase) and prints a warning that names them; pnpm 12 warns about keys its port of isConfigFileKey rejects, but drops blockExoticSubdeps without a word. What pnpm 10 does with an unknown key in rc was not checked.',
    ),
    invalidValueFails: user.uncertain(
      true,
      `${PNPM_V11_CODE}/index.ts`,
      'Read from code: pnpm 11.28.10 stops when the global config.yaml cannot be read (readGlobalYamlConfig) or applied (applyGlobalYamlConfig), except in commands that skip unreadable settings. Which values fail, and what pnpm 10 (rc) and pnpm 12 do, was not checked; true is the safe assumption.',
    ),
    weakening: user.verified(
      [
        {
          key: 'dangerously-allow-all-builds',
          values: { except: ['false', 'null', 'undefined'] },
          effect: 'runs every dependency build script in projects without build settings of their own and in global installs (pnpm 10)',
        },
        { key: 'only-built-dependencies', values: 'any', effect: 'lets these packages run build scripts in projects without build settings of their own and in global installs (pnpm 10)' },
        { key: 'minimum-release-age-exclude', values: 'any', effect: 'exempts these packages from the release-age delay in every project without its own list (pnpm 10)' },
        {
          key: 'dangerouslyAllowAllBuilds',
          values: { except: [false, 0, null, ''] },
          effect: 'runs every dependency build script in projects that do not set it to false; before pnpm 12.12.0 also of packages denied in allowBuilds',
        },
        { key: 'minimumReleaseAge', values: [0], effect: 'turns the default release-age delay off (pnpm 11+)' },
        { key: 'minimumReleaseAgeExclude', values: 'any', effect: 'exempts these packages from the release-age delay in every project without its own list (pnpm 11+)' },
        { key: 'minimumReleaseAgeStrict', values: [false], effect: 'installs a version younger than minimumReleaseAge when no older one matches (pnpm 11+)' },
        { key: 'strictDepBuilds', values: [false], effect: 'lets unreviewed build scripts warn instead of failing the install (pnpm 11.0.7+)' },
        { key: 'trustLockfile', values: [true], effect: 'stops frozen-lockfile installs from re-checking the release age of lockfile entries (pnpm 11.3.0+)' },
        { key: 'blockExoticSubdeps', values: [false], effect: 'allows git and tarball subdependencies again (pnpm 11; pnpm 12 ignores the key in config.yaml)' },
      ],
      `${PNPM_V11_CODE}/getConfig/workspaceManifestSettings.ts`,
      'A key in pnpm-workspace.yaml replaces the user value, lists included (applyWorkspaceSetting: pnpmConfig[key] = value); PNPM_CONFIG_* variables and the command line beat both. In pnpm 10 the same keys in ~/.npmrc beat rc, and since 10.13.0 build settings from either file reach only projects without build settings of their own, and global installs (config/config/src/index.ts at 10.34.9; before 10.13.0 dangerously-allow-all-builds also joined a project\'s onlyBuiltDependencies). In config.yaml, dangerouslyAllowAllBuilds also overrides a project\'s allowBuilds: false in pnpm 11 and 12.0.0-12.11.x (see extra.allowAllBuilds). pnpm 10 has no default delay and its strict-dep-builds and block-exotic-subdeps default to false, so 0 or false there weakens nothing; trustLockfile is a global key since it appeared in 11.3.0. The switch that allows every build is on for any value pnpm does not read as off, because pnpm tests it for truth (see extra.allowAllBuilds): in config.yaml only false, 0, null and an empty string are off, so "false", yes and "true" (strings for js-yaml) are on; in rc and ~/.npmrc pnpm 10 parses values with parseField of @pnpm/npm-conf (lib/util.js at https://github.com/pnpm/npm-conf/blob/v3.0.2/lib/util.js, the same in 3.0.3, which pnpm 10.28.0 and 10.34.9 use), which turns only "false", "null" and "undefined" into falsy values, an empty value of a Boolean setting into true, and leaves yes, 1 and 0 as strings, which are true.',
    ),
    variables: user.verified(
      [
        { name: 'pnpm_config_minimum_release_age', values: 'any', effect: 'overrides minimumReleaseAge from every file (pnpm 11+)', since: '11.0.0' },
        { name: 'PNPM_CONFIG_MINIMUM_RELEASE_AGE', values: 'any', effect: 'overrides minimumReleaseAge from every file (pnpm 11+)', since: '11.0.0' },
        { name: 'pnpm_config_dangerously_allow_all_builds', values: ['true'], effect: 'runs every dependency build script (pnpm 11+)', since: '11.0.0' },
        { name: 'PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS', values: ['true'], effect: 'runs every dependency build script (pnpm 11+)', since: '11.0.0' },
        {
          name: 'npm_config_minimum_release_age',
          anyCase: true,
          values: 'any',
          effect: 'overrides minimum-release-age from every .npmrc and rc file; pnpm-workspace.yaml still wins (pnpm 10)',
          until: '11.0.0',
        },
        {
          name: 'npm_config_dangerously_allow_all_builds',
          anyCase: true,
          values: { except: ['false', 'null', 'undefined'] },
          effect: 'runs every dependency build script in projects without build settings of their own (pnpm 10)',
          until: '11.0.0',
        },
        {
          name: 'npm_config_userconfig',
          anyCase: true,
          values: 'any',
          effect: 'moves the user .npmrc, which pnpm 10 reads for every setting ahead of rc',
          until: '11.0.0',
          defaultPath: '.npmrc',
        },
      ],
      `${PNPM_V11_CODE}/env.ts`,
      'pnpm 11 reads pnpm_config_<key> in lower case or PNPM_CONFIG_<KEY> in upper case, not mixed case (getEnvKeySuffix), over pnpm-workspace.yaml and under the command line; pnpm 12 reads the same two forms (pnpm/crates/config/src/env_overlay.rs at 12.17.0). pnpm 11+ ignores npm_config_* except npm_config_userconfig, which then moves only the auth .npmrc. The 11.0.0 release notes (https://github.com/pnpm/pnpm/releases/tag/v11.0.0): "pnpm no longer reads npm_config_* environment variables", "Added support for loading environment variables whose names start with pnpm_config_ into config"; pnpm 10.34.9 reads pnpm_config_ only for verify-deps-before-run (config/config/src/index.ts). pnpm 10 reads npm_config_* in any case, skipping empty values (addEnv in lib/conf.js of @pnpm/npm-conf 3.0.3), under pnpm-workspace.yaml (npmrcPrecedence), and parses them with the same parseField as .npmrc, so npm_config_dangerously_allow_all_builds is off only for false, null and undefined (1 and yes stay true strings); its npm_config_userconfig defaults to ~/.npmrc (lib/defaults.js). pnpm 11 parses a Boolean pnpm_config_ value with parseBoolean of env.ts, which takes only true as true (false gives false, any other text no value). XDG_CONFIG_HOME and LOCALAPPDATA move the config directory (user.files).',
    ),
  },
  extra: {
    environmentNames: release14.verified<EnvironmentNameRule[]>(
      [
        { prefix: 'pnpm_config_', match: 'lower-or-upper' },
        { prefix: 'npm_config_', match: 'any-case' },
      ],
      `${PNPM_V11_CODE}/env.ts`,
      'pnpm 11 reads pnpm_config_<key> only with the prefix and the key in lower case, or PNPM_CONFIG_<KEY> with both in upper case (getEnvKeySuffix with isLowerSnakeCase and isUpperSnakeCase), so Pnpm_Config_Registry sets nothing; pnpm 12 looks up PNPM_CONFIG_<KEY> and then pnpm_config_<key> (read_env in pnpm/crates/config/src/env_overlay/string_reader.rs, https://github.com/pnpm/pnpm/blob/v12.17.0/pnpm/crates/config/src/env_overlay/string_reader.rs). pnpm 10 reads npm_config_* in any case: addEnv in lib/conf.js of @pnpm/npm-conf 3.0.3 filters with /^npm_config_/i, and envKeyToSetting lowercases the key (https://github.com/pnpm/npm-conf/blob/v3.0.3/lib/envKeyToSetting.js). Decision D-143.',
    ),
    denyList: user.verified(
      { file: 'pnpm-workspace.yaml', setting: 'allowBuilds', value: false, since: '10.26.0' },
      'https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/building/policy/src/index.ts',
      'allowBuilds: { pkg: false } records a denial: the build is decided, not reported as unreviewed and does not fail strictDepBuilds ("A recorded build the policy denies was decided on purpose"). pnpm 10.26 maps false to ignoredBuiltDependencies, which only silences the report. Under dangerouslyAllowAllBuilds a denied package still builds before pnpm 12.12.0.',
    ),
    projectInstall: runtimes.verified(
      { commands: ['install', 'i'], bare: false },
      'https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/cli/install.md',
      'Commands that install the dependencies of the project: "pnpm install is used to install all dependencies for a project", "Aliases: i". pnpm add (commandLine.add) adds packages. pnpm without a command does not install.',
    ),
    commandLine: rechecked.verified(
      {
        add: [['pnpm', 'add']],
        run: [
          { command: ['pnx'], packageOptions: ['--package'], shellOptions: ['--shell-mode', '-c'] },
          { command: ['pnpx'], packageOptions: ['--package'], shellOptions: ['--shell-mode', '-c'] },
          { command: ['pnpm', 'dlx'], packageOptions: ['--package'], shellOptions: ['--shell-mode', '-c'] },
        ],
        create: [{ command: ['pnpm', 'create'], packageOptions: [] }],
        createNames: 'prefix-unless-prefixed',
        valueOptions: [
          '--save-prefix', '--save-catalog-name', '--lockfile-dir', '--filter', '-F', '--registry', '--allow-build', '--cpu', '--os', '--libc', '-C', '--dir', '--workspace-packages', '--env-file',
          '--reporter', '--loglevel',
        ],
      },
      'https://github.com/pnpm/pnpm.io/tree/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/cli',
      'From cli/add.md, cli/pnx.md, cli/create.md and pnpm-cli.md at that commit. pnx (pnpm 12) has the aliases pnpm dlx and pnpx; pnpm 10 documents pnpm dlx with the alias pnpx (versioned_docs/version-10.x/cli/dlx.md). --shell-mode (-c) runs the command inside a shell, e.g. pnx --package cowsay -c \'echo hi | cowsay\'. pnpm create maps foo and create-foo to create-foo, @scope to @scope/create and @scope/foo to @scope/create-foo, and runs it with pnx. --registry and --allow-build are shown with =, the other value options with a separate value. --package belongs to pnx (pnpm dlx) only and is listed there; before dlx it counts too (runnerOptions). -F is the short form of --filter (filtering.md). --reporter takes the name of a reporter (cli/install.md) and --loglevel a level (the loglevel setting in settings/cli.md, given as a flag); both take a separate value too.',
    ),
    runnerOptions: runners.verified<RunnerOptionsKnowledge>(
      { beforeCommand: [{ command: ['pnpm', 'dlx'], values: 'separate' }] },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/cli/parse-cli-args/src/index.ts',
      'pnpm 10 parses the command line twice with @pnpm/nopt: first with the universal options and those of add and install, to find the command (there --package is taken for package-import-method, its only unambiguous expansion, so the word after it is its value), then the whole line with the options of that command, so the options of dlx count before dlx too, up to the first argument after dlx, from which on every word goes to the command (SPECIALLY_ESCAPED_CMDS). pnpm 11 does the same (https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/cli/parse-cli-args/src/index.ts; package-import-method is still the only option of add and install that starts with package). pnpm 12 moves the options of the invoked subcommand that stand before it to right after it (relocate_pre_subcommand_flags, https://github.com/pnpm/pnpm/blob/v12.17.0/pnpm/crates/cli/src/flag_relocation.rs), and its dlx has --package and -c (pnpm/crates/cli/src/cli_args/dlx.rs). The documentation shows pnpm --package=@pnpm/meta-updater dlx meta-updater --help and pnpm --package cowsay --package lolcatjs -c dlx \'echo "hi pnpm" | cowsay | lolcatjs\' (versioned_docs/version-10.x/cli/dlx.md in pnpm/pnpm.io). pnpm exec has no --package (exec/plugin-commands-script-runners/src/exec.ts at v10.34.9), and pnpm stops at an option the command does not know (pnpm/src/main.ts), so pnpm --package=x exec y downloads nothing. Decision D-160.',
    ),
    packageSpecs: checked.verified(
      {
        git: ['github:', 'bitbucket:', 'gitlab:', 'gist:', 'git+ssh://'],
        local: ['link:', 'file:'],
        workspace: ['workspace:'],
        remoteTarball: ['http://', 'https://'],
        tarballExtensions: ['.tar', '.tar.gz', '.tgz'],
        shorthand: 'github:',
      },
      'https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/package-sources.md',
      'Sources of pnpm add: the npm registry, jsr:, crate: and pypi: (other registries), workspace packages (the workspace: range protocol, docs/workspaces.md), local directories (./dir is saved as link:, file:./dir is copied), local tarballs ending in .tar, .tar.gz or .tgz, remote tarballs starting with http:// or https://, and git repositories as user/repo (github: by default), github:, bitbucket:, gitlab:, gist: or a full URL such as git+ssh://… or https://github.com/….git.',
    ),
    registryOverrides: reviewed.verified(
      {
        registryOptions: ['--registry', '--@<scope>:registry'],
        registryVariables: ['pnpm_config_registry'],
        configOptions: ['--userconfig', '--npmrc-auth-file'],
        configVariables: ['pnpm_config_npmrc_auth_file', 'pnpm_config_userconfig'],
      },
      `${PNPM_V12}/pnpm11/config/reader/src/index.ts`,
      'registry and @scope:registry are read from the command line over .npmrc (docs/npmrc.md in pnpm/pnpm.io). Every pnpm_config_<key> or PNPM_CONFIG_<KEY> variable whose key is a setting sets it (src/env.ts, parseEnvVars), registry included. The user-level .npmrc, which may set any registry, is the file named by --npmrc-auth-file, --userconfig, pnpm_config_npmrc_auth_file, pnpm_config_userconfig, npmrcAuthFile in the global config.yaml or npm_config_userconfig (getNpmrcAuthFile; src/loadNpmrcFiles.ts reads it in place of ~/.npmrc). pnpm 10 reads npm_config_* variables as npm does.',
    ),
    parsing: runtimes.verified(
      {
        abbreviations: true,
        anyDashes: true,
        negation: '--no-',
        settingPrefix: '--config.',
        shorthands: {
          s: ['--reporter=silent'], d: ['--loglevel=info'], dd: ['--loglevel=verbose'], ddd: ['--loglevel=silly'], L: ['--latest'],
          r: ['--recursive'], silent: ['--reporter=silent'], verbose: ['--loglevel=verbose'], quiet: ['--loglevel=warn'],
          q: ['--loglevel=warn'], h: ['--help'], H: ['--help'], '?': ['--help'], usage: ['--help'], v: ['--version'], f: ['--force'],
          local: ['--no-global'], l: ['--long'], p: ['--parseable'], porcelain: ['--parseable'], prod: ['--production'],
          development: ['--dev'], g: ['--global'], S: ['--save'], D: ['--save-dev'], P: ['--save-prod'], E: ['--save-exact'],
          O: ['--save-optional'], C: ['--dir'], w: ['--workspace-root'], i: ['--interactive'], F: ['--filter'], y: ['--yes'],
        },
      },
      `${PNPM_V12}/pnpm11/cli/parse-cli-args/src/index.ts`,
      'pnpm parses its command line with @pnpm/nopt 0.3.1 (github.com/pnpm/nopt, lib/nopt.js), a fork of nopt: every leading dash is stripped, an exact shorthand or a word of one-letter shorthands is expanded, and an unambiguous prefix of an option of the command is taken for that option, so pnpm add --reg=<url> sets registry; --no-<name> is a negated flag: lib/nopt.js strips every leading no- in any case, each one inverting it, before the prefix is resolved, so --no-ign is --no-ignore-scripts when no other option of the command starts with ign (parse-cli-args, shorthands.ts and pnpm/nopt read again 2026-11-01). Options pnpm does not know make it stop with an error (pnpm11/pnpm/src/main.ts, dropUnknownOptions). --config.<key>=<value> sets the setting <key> (separateConfigDotArgs, normalizeOptions), also in pnpm 10.34.9 (cli/parse-cli-args/src/index.ts). The shorthands are pnpm11/pnpm/src/shorthands.ts; pnpm 10.34.9 has the same without y.',
    ),
    booleanWords: d170.verified(
      true,
      'https://github.com/pnpm/nopt/blob/7f8522c60a84c04bed2ac792204d8c22172d295f/lib/nopt.js',
      'The nopt fork pnpm imports (@pnpm/nopt, imported by pnpm11/cli/parse-cli-args/src/index.ts at v12.16.1) reads a Boolean option followed by the word true or false as that value and skips the word, inverted after --no- (parse in lib/nopt.js).',
    ),
    directoryOptions: runtimes.verified<DirectoryOptionsKnowledge>(
      { options: [{ name: '--dir', moves: 'directory' }], variables: [] },
      'https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/pnpm-cli.md',
      '-C <path>, --dir <path>: "Run as if pnpm was started in <path> instead of the current working directory." -C is the shorthand of --dir (parsing.shorthands). pnpm11/cli/parse-cli-args/src/index.ts at v12.16.1 takes dir from the options nopt parsed from the whole command line ("let dir = parsedOpts[\'dir\']") and looks for the workspace from it ("findWorkspaceDir((dir ?? process.cwd()) as string)"). -w, --workspace-root ("Run as if pnpm was started in the root of the workspace") is not listed: it names no directory.',
    ),
    configCommands: runtimes.verified(
      [
        { command: ['pnpm', 'config'], writes: ['set', 'delete'] },
        { command: ['pnpm', 'c'], writes: ['set', 'delete'] },
        { command: ['pnpm', 'pkg'], writes: ['set', 'delete', 'fix'], manifest: true },
      ],
      'https://github.com/pnpm/pnpm.io/blob/main/docs/cli/config.md',
      'pnpm config (aliases: c) manages the configuration files: set <key> <value>, get <key>, delete <key> and list; get and list only read. pnpm pkg "Manages the contents of package.json from the command line": get, set, delete and fix, no aliases (docs/cli/pkg.md).',
    ),
    installOverrides: runtimes.verified(
      {
        options: [
          { name: '--ignore-scripts', weakens: 'scripts', values: { except: ['true'] } },
          { name: '--ignoreScripts', weakens: 'scripts', values: { except: ['true'] } },
          { name: '--allow-build', weakens: 'scripts', values: 'any' },
          { name: '--dangerouslyAllowAllBuilds', weakens: 'scripts', values: { except: ['false'] } },
          { name: '--dangerously-allow-all-builds', weakens: 'scripts', values: { except: ['false'] } },
          { name: '--minimumReleaseAge', weakens: 'delay', values: 'delay' },
          { name: '--minimum-release-age', weakens: 'delay', values: 'delay' },
          { name: '--minimumReleaseAgeExclude', weakens: 'delay', values: 'any' },
          { name: '--minimum-release-age-exclude', weakens: 'delay', values: 'any' },
          { name: '--minimumReleaseAgeStrict', weakens: 'delay', values: { except: ['true'] } },
          { name: '--minimum-release-age-strict', weakens: 'delay', values: { except: ['true'] } },
        ],
        variables: [
          { name: 'pnpm_config_minimum_release_age', weakens: 'delay', values: 'delay' },
          { name: 'pnpm_config_minimum_release_age_exclude', weakens: 'delay', values: 'any' },
          { name: 'pnpm_config_minimum_release_age_strict', weakens: 'delay', values: { except: ['true'] } },
          { name: 'pnpm_config_ignore_scripts', weakens: 'scripts', values: { except: ['true'] } },
          { name: 'pnpm_config_dangerously_allow_all_builds', weakens: 'scripts', values: ['true'] },
          { name: 'npm_config_minimum_release_age', weakens: 'delay', values: 'delay' },
          { name: 'npm_config_dangerously_allow_all_builds', weakens: 'scripts', values: { except: ['false', 'null', 'undefined'] } },
        ],
      },
      `${PNPM_V12}/pnpm11/config/reader/src/env.ts`,
      'pnpm add takes --ignore-scripts ("Same as the ignoreScripts setting") and --allow-build, which lists packages allowed to run postinstall scripts (docs/cli/add.md in pnpm/pnpm.io; a ! prefix denies one instead, still asked about). Any setting can be given as --config.<key>=<value>, the key kept as written (normalizeOptions in pnpm11/cli/parse-cli-args/src/index.ts at v12.16.1), so both spellings are listed and the scanner reads the key without --config.. pnpm_config_<key> and PNPM_CONFIG_<KEY> set the setting of the camel-cased key; a Boolean only from the exact words true and false, a number with Number (parseEnvVars in env.ts). pnpm 10 reads npm_config_* variables as npm does (registryOverrides). minimumReleaseAgeStrict false installs a younger version when no older one matches (user.weakening).',
    ),
    minimumReleaseAgeStrict: checked.verified(
      { setting: 'minimumReleaseAgeStrict', value: true, since: '11.0.0' },
      RESOLUTION,
      'When false, pnpm falls back to a version that does not meet minimumReleaseAge; when true, resolution fails. It defaults to true when minimumReleaseAge is set explicitly, except in 11.0.0-11.0.3 and 12.0.0-12.2.x (see strictMode): pnpm 11.0.0 and 12.0.0 installed a version 4 hours old with minimumReleaseAge: 4320 on 2026-10-29, and 12.0.0 added it to minimumReleaseAgeExclude.',
    ),
    cooldownExactVersions: checked.verified(
      '10.17.0',
      release('10.17.0'),
      'pnpm 10.17.0: "Don\'t ignore the minimumReleaseAge check, when the package is requested by exact version". pnpm 10.16.0 installed typescript@7.1.0-dev.20261029.1, 4 hours old, with minimumReleaseAge: 4320 on 2026-10-29.',
    ),
    lockfileDocuments: checked.verified(
      { bootMarker: '---', graph: 'last' },
      'https://github.com/pnpm/pnpm.io/blob/main/docs/lockfile.md',
      'A lockfile whose first line is --- has two YAML documents: a boot document with configDependencies and packageManagerDependencies, written when the project has config dependencies, declares devEngines.packageManager or pins pnpm 12 or newer; then the project lockfile (importers, packages, snapshots), which is always the last document. Seen with pnpm 12.16.1 and packageManager pnpm@12.16.1 on 2026-10-29.',
    ),
    lockfileFormat: checked.verified(
      {
        installScripts: null,
        gitKeyPrefix: 'git+',
        gitHostedFlag: 'gitHosted',
        gitHostedTarballHosts: ['codeload.github.com', 'bitbucket.org', 'gitlab.com'],
        gitType: 'git',
        directoryType: 'directory',
      },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/lockfile/types/src/index.ts',
      'lockfileVersion 9.0 (pnpm 9 to 12). Registry packages are keyed name@version; git dependencies name@git+<repo>#<commit> with resolution type git, or a tarball from a git host (gitHosted: true; older lockfiles lack the flag, so the host decides); tarball URLs name@https://…; local tarballs name@file:….tgz; local directories have resolution type directory; link: and workspace: dependencies appear only under importers. requiresBuild was removed in lockfile v9, so install scripts are not recorded. A tarball URL under the configured registry is resolved as that registry package and version (resolving/npm-resolver/src/parseBareSpecifier.ts in v10.34.9), so it is keyed name@version and keeps the URL only in the importer specifier; seen in lockfiles written by pnpm 10.34.9 and 12.16.1.',
    ),
    npmrcPrecedence: checked.verified(
      { winner: 'pnpm-workspace.yaml', over: ['.npmrc', 'npm_config_*'] },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/config/config/src/index.ts',
      'pnpm 10 applies pnpm-workspace.yaml settings over .npmrc and npm_config_* variables; command-line options win over both (same order on v10.16.0). The 10.18.3 changelog says pnpm config set --location=project writes to pnpm-workspace.yaml "matching read priority". The 10.x docs do not state the order.',
    ),
    npmrcCooldownKey: reviewed.verified(
      { key: 'minimum-release-age', until: '11.0.0' },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/config/config/src/types.ts',
      'pnpm 10 reads minimum-release-age from .npmrc as a number and maps it to minimumReleaseAge (minutes), so the value means the same in both files; pnpm-workspace.yaml wins when both set it (npmrcPrecedence). pnpm 11.0.0 stopped reading it from .npmrc (ignoredSince).',
    ),
    sharedWorkspaceLockfile: checked.verified(
      { setting: 'sharedWorkspaceLockfile', npmrcKey: 'shared-workspace-lockfile', default: true },
      'https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/versioned_docs/version-10.x/workspaces.md',
      'Same name and default in pnpm 11 and 12, where it is read only from pnpm-workspace.yaml.',
    ),
    perProjectNpmrc: checked.uncertain(
      { sharedWorkspaceLockfile: false, until: '11.0.0' },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/pkg-manager/plugin-commands-installation/src/recursive.ts',
      'Without a shared lockfile, pnpm 10 installs every workspace project with its own .npmrc layered over the workspace settings, without filtering keys, so a package .npmrc can change minimum-release-age for that project. Read from code; no documentation or test covers it. No official source says this combination turns minimumReleaseAge off.',
    ),
    ignoredSince: verified(
      { since: '11.0.0', npmrc: 'auth and registry settings', packageJsonField: 'pnpm' },
      release('11.0.0'),
      'Structured form of npmrcIgnored: from 11.0.0 on, other .npmrc settings and the package.json "pnpm" field have no effect.',
    ),
    lockfileRecheck: uncertain(
      [
        { since: '10.16.0', value: false },
        { since: '11.1.3', value: true },
      ],
      release('11.1.3'),
      'Structured form of lockfileVerification: whether a frozen-lockfile install re-checks the age of versions already in the lockfile. trustLockfile: true (11.3.0) turns the check off.',
    ),
    allowAllBuilds: rechecked.verified(
      { setting: 'dangerouslyAllowAllBuilds', since: '10.9.0', value: true, off: [false, 0, null, ''] },
      'https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/building/policy/src/index.ts',
      'off: the values that leave it off. pnpm tests the value for truth and checks no type: pnpm 10 and 11 read pnpm-workspace.yaml with js-yaml (extra.yamlMergeKeys) and copy each key as it is (getOptionsFromPnpmSettings at 10.28.0, applyWorkspaceSetting at 11.28.10), so a string such as "false", "no" or "true" is on; depcurfew treats every value but false, 0, null and an empty string as on. pnpm 12 reads it into an Option<bool> (dangerously_allow_all_builds in pnpm/crates/config/src/workspace_yaml/settings.rs at 12.16.1) with the YAML 1.1 words of serde-saphyr 0.0.29 (parse_yaml11_bool: true, yes, y, on and false, no, n, off, in any case and also quoted), and stops on any other value, so no value is on there that depcurfew reads as off. Boolean, default false; added in 10.9.0 ("Added a new setting, dangerouslyAllowAllBuilds, for automatically running any scripts of dependencies without the need to approve any builds", pnpm/CHANGELOG.md at v10.26.0). Packages set to false in allowBuilds (or build: false in permissions) stay blocked only from pnpm 12.12.0 (release notes at https://github.com/pnpm/pnpm/releases/tag/v12.12.0: "A package set to false in allowBuilds no longer runs its build scripts when dangerouslyAllowAllBuilds is true", "Previously, dangerouslyAllowAllBuilds ignored the denials"). pnpm 10, 11 and 12.0.0-12.11.x run them too: createAllowBuildFunction returns before it reads the lists ("if (opts.dangerouslyAllowAllBuilds) return () => true" in building/policy at 11.28.10 and builder/policy/src/index.ts at 10.34.9; allow_build_policy.rs at 12.0.0).',
    ),
    excludeWildcards: verified(
      { since: '10.17.0', trailingOnly: false },
      SETTINGS_V10,
      'Globs such as @myorg/* in minimumReleaseAgeExclude since 10.17.0.',
    ),
    onlyBuiltDependencies: rechecked.verified(
      { since: '6.32.1', workspaceFileSince: '10.5.0', removedIn: '11.0.0' },
      'https://github.com/pnpm/pnpm/blob/v10.26.0/pnpm/CHANGELOG.md',
      'The allow-list before allowBuilds: package.json pnpm.onlyBuiltDependencies, added in 6.32.0 ("If this field exists, only mentioned packages will be able to run install scripts") and working since 6.32.1 ("released with a bug in v6.32.0"); also pnpm-workspace.yaml since 10.5.0 (10.5.0 changelog); removed in 11.0.0 (settings/build.md, see legacyAllowList). Before pnpm 10 any list, even an empty one, lets only the listed packages build (createAllowBuildFunction in @pnpm/builder.policy 3.0.0, which pnpm 9.15.0 uses).',
    ),
    ignoredBuiltDependencies: rechecked.verified(
      { since: '10.1.0', workspaceFileSince: '10.5.0' },
      'https://github.com/pnpm/pnpm/blob/v10.26.0/pnpm/CHANGELOG.md',
      'The record of denied builds before allowBuilds (denyList): package.json pnpm.ignoredBuiltDependencies since 10.1.0 ("for explicitly listing packages that should not be built. When a package is in the list, pnpm will not print an info message about that package not being built"), and pnpm-workspace.yaml since 10.5.0 ("Allow to set the \\"pnpm\\" settings from package.json via the pnpm-workspace.yaml file"). The 10.26.0 entry for allowBuilds says that allowBuilds: { core-js: false } "achieves the same result as" ignoredBuiltDependencies: [core-js]. It only silences the report: createAllowBuildFunction (builder/policy/src/index.ts at v10.25.0) does not read it, so a package onlyBuiltDependencies names still builds. Deprecated in 10.26.0 and removed in 11.0.0 (see legacyAllowList).',
    ),
    npmrcBuildSettings: rechecked.verified(
      {
        allowAll: { key: 'dangerously-allow-all-builds', off: ['false', 'null', 'undefined'], since: '10.9.0' },
        until: '11.0.0',
        projectKeys: [
          { since: '10.13.0', value: ['dangerouslyAllowAllBuilds', 'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'neverBuiltDependencies'] },
          { since: '10.26.0', value: ['dangerouslyAllowAllBuilds', 'onlyBuiltDependencies', 'onlyBuiltDependenciesFile', 'neverBuiltDependencies', 'allowBuilds'] },
        ],
      },
      'https://github.com/pnpm/pnpm/blob/v10.28.0/config/config/src/dependencyBuildOptions.ts',
      'pnpm 10 reads dangerously-allow-all-builds from the project .npmrc as from every .npmrc, with parseField of @pnpm/npm-conf, so every value but false, null and undefined is on (user.weakening). From 10.13.0 config/config/src/index.ts takes the build settings of all .npmrc files and npm_config_* variables aside (extractAndRemoveDependencyBuildOptions) and applies them only when pnpm-workspace.yaml and the "pnpm" field of package.json (from which getOptionsFromRootManifest takes onlyBuiltDependencies, onlyBuiltDependenciesFile and neverBuiltDependencies) set none of projectKeys (hasDependencyBuildOptions: a key that is not null or undefined); the list gained allowBuilds in 10.26.0 (dependencyBuildOptions.ts at 10.13.0, 10.25.0, 10.26.0 and 10.28.0; the file does not exist in 10.12.1). Before 10.13.0 the .npmrc value applies unless pnpm-workspace.yaml sets dangerouslyAllowAllBuilds itself (npmrcPrecedence). pnpm 11 reads only auth and registry settings from .npmrc (ignoredSince).',
    ),
    yamlMergeKeys: rechecked.verified(
      true,
      'https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/workspace/workspace-manifest-reader/src/index.ts',
      'pnpm-workspace.yaml and the global config.yaml (readWorkspaceManifest with cfgFileName) are read with read-yaml-file, which calls load of js-yaml with its default schema, and that schema has the merge type: read-yaml-file 3.0.0 with @zkochan/js-yaml 0.0.11 in 11.28.10, read-yaml-file 2.1.0 with @zkochan/js-yaml 0.0.9 in 10.28.0 and 0.0.11 in 10.34.9 (workspace/read-manifest/src/index.ts and pnpm-lock.yaml at those tags; lib/schema/default.js of the packages). pnpm 12 reads both files with serde_saphyr::from_str (pnpm/crates/config/src/workspace_yaml/parse_settings.rs at 12.16.1), whose default MergeKeyPolicy is Merge (serde-saphyr 0.0.29). So <<: *defaults brings the keys of the anchored map into the map, and settings set that way apply (a review run with pnpm 10.28.0: pnpm config get dangerouslyAllowAllBuilds gave true and installs ran scripts). A key written in the map itself wins over a merged one whatever their order (mergeMappings of js-yaml adds only missing keys; serde-saphyr adds merged entries whose key is not seen), and earlier maps of <<: [*a, *b] win over later ones; a quoted "<<" is an ordinary key.',
    ),
    latestVersion: verified(
      '12.16.1',
      release('12.16.1'),
      'pnpm 12.0.0 shipped on 26 Aug and 11.0.0 on 28 Apr (GitHub shows no year; 2026 inferred from release order). 11.x and 10.x still receive patches.',
    ),
    npmrcIgnored: verified(
      'pnpm 11+ reads only auth and registry settings from .npmrc, ignores the package.json "pnpm" field and no longer reads npm_config_* variables',
      release('11.0.0'),
    ),
    buildPermissions: rechecked.verified(
      { setting: 'permissions', capability: 'build', since: '12.11.0', allow: true, deny: false },
      'https://github.com/pnpm/pnpm/blob/v12.16.1/pnpm/docs/settings/build.md',
      'permissions.<package>.build in pnpm-workspace.yaml: true lets the package run its build scripts, false denies them; the keys take the same forms as those of allowBuilds, and the entry outranks the package\'s allowBuilds entry (decided_build_approvals and apply_permissions in pnpm/crates/config/src/workspace_yaml/permissions.rs at v12.16.1, which warns when a package is in both). A string is an undecided placeholder (AllowBuild::Undecided in sections.rs). Added in 12.11.0 (docs/settings/build.md and docs/cli/permissions.md); pnpm approve writes a build decision there only when the file already has permissions.',
    ),
    legacyAllowList: verified(
      [
        { since: '10.0.0', value: 'onlyBuiltDependencies (package.json pnpm field; pnpm-workspace.yaml since 10.5.0)' },
        { since: '10.26.0', value: 'allowBuilds; onlyBuiltDependencies and ignoredBuiltDependencies deprecated' },
        { since: '11.0.0', value: 'allowBuilds only; onlyBuiltDependencies, neverBuiltDependencies and ignoredBuiltDependencies removed' },
      ],
      BUILD_V11,
    ),
    strictDepBuilds: verified(
      [
        { since: '10.3.0', value: 'false' },
        { since: '11.0.0', value: 'true' },
      ],
      release('11.0.0'),
      'When true, an unreviewed dependency build script fails the install.',
    ),
    strictMode: verified(
      [
        { since: '11.0.0', value: 'minimumReleaseAgeStrict defaults to false' },
        { since: '11.0.4', value: 'strict whenever minimumReleaseAge is set explicitly' },
        { since: '12.0.0', value: 'explicit values treated as non-strict (regression)' },
        { since: '12.3.0', value: 'strict whenever minimumReleaseAge is set explicitly' },
      ],
      release('12.3.0'),
      'In non-strict mode pnpm silently writes immature picks into minimumReleaseAgeExclude. Strict mode fails CI installs with ERR_PNPM_NO_MATURE_MATCHING_VERSION.',
    ),
    ignoreMissingTime: verified(
      'minimumReleaseAgeIgnoreMissingTime defaults to true: packages whose registry metadata has no publish time skip the age check',
      RESOLUTION,
    ),
    lockfileVerification: uncertain(
      [
        { since: '10.16.0', value: 'frozen-lockfile installs do not re-check versions already in the lockfile' },
        { since: '11.1.3', value: 'lockfile entries are re-checked; trustLockfile: true (11.3.0) turns this off' },
      ],
      release('11.1.3'),
      'The 11.1.3 release notes confirm re-validation (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION). The pnpm 10 behavior rests on maintainer comments in pnpm/pnpm#12450 (a Dependabot lockfile passed --frozen-lockfile on 10.34.5), not on docs.',
    ),
    unknownWorkspaceKeys: verified(
      'pnpm 11 and earlier silently ignore misspelled pnpm-workspace.yaml settings; pnpm 12 warns',
      'https://pnpm.io/blog/releases/12.0',
    ),
    tarballResolution: release14.verified(
      { field: 'tarball' },
      'https://github.com/pnpm/pnpm/blob/v10.34.9/lockfile/utils/src/pkgSnapshotToResolution.ts',
      'pnpm fetches a registry package of pnpm-lock.yaml (a key name@version) from the tarball URL get-npm-tarball-url builds from the name and version, unless its resolution has tarball: then from that URL, resolved against the registry (new url.URL(resolution.tarball, registry)). pnpm 11.28.10 does the same (resolveTarballUrl in pnpm11/lockfile/utils/src/pkgSnapshotToResolution.ts). assertRegistryShapedResolution (lockfile/utils/src/assertRegistryShapedResolution.ts at v10.34.9) accepts any http(s) URL there for such a key, and a relative path without a scheme or a leading slash, which "is resolved against the configured registry", while the allowBuild policy "derives a trusted package identity from that key shape". pnpm writes tarball for a registry package whose tarball is not at the URL it would build. The fetch requests the path and the query of the URL, never the fragment, and the registry serves the file the path names.',
    ),
    rootLifecycleScripts: release14.verified<RootLifecycleScriptsKnowledge>(
      { events: ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'], skippedBy: 'ignoreScripts', allowListApplies: false },
      'https://github.com/pnpm/pnpm/blob/v11.28.10/pnpm11/installing/deps-installer/src/install/linkResolvedProjects.ts',
      'pnpm 11.28.10 runs the projects\' own lifecycle scripts after linking "if (!opts.ignoreScripts && !opts.virtualStoreOnly)" (runProjectLifecycleScripts), with PROJECT_LIFECYCLE_STAGES = preinstall, install, postinstall, preprepare, prepare, postprepare for a full install and only the install stages for --prod or deploy (exec/lifecycle/src/runLifecycleHooksConcurrently.ts); allowBuilds only goes to the build of dependencies (allowBuild). pnpm 10.34.9 does the same in pkg-manager/core/src/install/index.ts and, for a frozen lockfile, pkg-manager/headless/src/index.ts ("if (!opts.ignoreScripts && !opts.ignorePackageManifest) await runLifecycleHooksConcurrently([preinstall, install, postinstall, preprepare, prepare, postprepare], ...)"). pnpm 12.16.1 picks PROJECT_LIFECYCLE_STAGES for a full install with devDependencies (project_script_stages in pnpm/crates/package-manager/src/install/lifecycle/uninstall.rs).',
    ),
    managesOwnVersion: release14.verified(
      { since: '10.0.0', field: 'packageManager' },
      'https://github.com/pnpm/pnpm/blob/v10.26.0/pnpm/CHANGELOG.md',
      '10.0.0: "manage-package-manager-versions: enabled by default. pnpm now manages its own version based on the packageManager field in package.json by default" (added in 9.7.0, off by default: "pnpm will switch to the version specified in the packageManager field of package.json ... This is the same field used by Corepack"). The 11.0.0 release notes replace the setting with pmOnFail, which "directly sets the onFail behavior of both packageManager and devEngines.packageManager" (https://github.com/pnpm/pnpm/releases/tag/v11.0.0); pnpm 12 documents pmOnFail with the default download: "download and run the declared pnpm version (this is the default and matches the previous managePackageManagerVersions: true behavior)" (pnpm/docs/settings/cli.md at v12.16.1). So any pnpm 10 or later honors a pnpm pin without Corepack.',
    ),
    configIncludes: includes.verified<PnpmIncludesKnowledge>(
      {
        since: '12.15.0',
        file: 'pnpm-workspace.yaml',
        key: 'include',
        unrestricted: '*',
        localPrefixes: ['./', '../'],
        localExtensions: ['.yaml', '.yml'],
        globCharacters: '*?[]{}',
        spellings: {
          enableGlobalVirtualStore: 'virtualStoreType',
          nodeExperimentalPackageMap: 'nodePackageMap',
          nodePackageMapType: 'nodePackageMap',
          noproxy: 'noProxy',
          proxy: 'httpsProxy',
          permissions: 'allowBuilds',
          auditConfig: 'audit',
          auditLevel: 'audit',
          cleanupUnusedCatalogs: 'catalogPrune',
          maxsockets: 'maxSockets',
          namedRegistries: 'registries',
          updateConfig: 'update',
        },
        notForDependencies: [
          'bootConfig', 'cacheDir', 'configDependencies', 'globalBinDir', 'globalDir', 'globalPnpmfile', 'globalVirtualStoreDir', 'lockfileDir', 'modulesDir', 'npmrcAuthFile',
          'onlyBuiltDependenciesFile', 'packages', 'patchedDependencies', 'patchesDir', 'pnpmfile', 'scriptShell', 'stateDir', 'storeDir', 'virtualStoreDir',
        ],
        dependencies: 'configDependencies',
      },
      `${PNPM_V12_17}/pnpm/docs/config-includes.md`,
      '"Added in: v12.15.0" (12.15.0 release notes, 21 Oct: "can now delegate settings to other YAML files and to config dependencies through a new include field"). include in the root pnpm-workspace.yaml maps a source to the settings it may define: a list of settings, which the source both may define and owns ("A list both permits and reserves its settings ... no other source may define them, even when the file omits them"), or \'*\' for a local file, which then owns the settings it defines that no other source owns. A local source starts with ./ or ../, is resolved from the workspace root, must end in .yaml or .yml and exist; a glob is rejected, and so is a file named twice or the root itself. Every other source is a config dependency named in configDependencies, which always needs a list. Settings defined in pnpm-workspace.yaml itself belong to it; a setting reserved twice, or defined where another source owns it, fails with ERR_PNPM_DUPLICATE_SETTING, a listed file that defines another setting with ERR_PNPM_SETTING_NOT_DELEGATED, a bad source with ERR_PNPM_INVALID_WORKSPACE_INCLUDE. A delegated setting the owner omits is not set by the project. Writes go to the owner: a delegated setting to its file even when the file omits it, a setting a \'*\' file defines stays there, one no source owns goes to pnpm-workspace.yaml, and one a config dependency owns cannot be changed (ERR_PNPM_SETTING_OWNED_BY_CONFIG_DEPENDENCY). Relative paths in an included file are relative to that file. The included files are read with merge keys like the root (normalize.rs applies <<). The spellings share one owner, so permissions and allowBuilds are one setting for ownership (canonical_setting_name in pnpm/crates/workspace/src/include/selector.rs); catalog is catalogs.default, catalogs.<name> one catalog and catalogs every catalog. Code: pnpm/crates/workspace/src/include.rs, include/selector.rs (parse_source, is_package_name_shaped, parse_delegation, SETTINGS_FORBIDDEN_TO_PACKAGES in include.rs), include/ownership.rs (reservations before definitions; the owner of a setting is its reservation, else its definition), include/package.rs (a config dependency\'s settings come from the YAML file its package.json names in pnpm.config, read from node_modules/.pnpm-config/<name> once installed); the same code at v12.15.0. Decision D-164.',
    ),
    bootConfig: includes.verified(
      {
        since: '12.15.0',
        setting: 'bootConfig',
        settings: ['minimumReleaseAge', 'minimumReleaseAgeExclude', 'minimumReleaseAgeStrict', 'minimumReleaseAgeIgnoreMissingTime', 'trustPolicy', 'trustPolicyExclude', 'trustPolicyIgnoreAfter'],
      },
      `${PNPM_V12_17}/pnpm/docs/config-includes.md`,
      'bootConfig in pnpm-workspace.yaml sets the release-age and trust policy pnpm resolves and installs config dependencies and the pnpm version of packageManager under, before the settings of config dependencies are loaded (12.15.0 release notes: "The new bootConfig setting sets the release-age and trust policy pnpm uses to install config dependencies"). A setting it leaves unset or null takes its regular value; for a setting a config dependency owns, the value of the global config.yaml, the environment or the built-in default. The environment and the command line beat bootConfig (for_boot in pnpm/crates/config/src/boot_config.rs at v12.17.0). A config dependency cannot be delegated bootConfig (configIncludes.notForDependencies). Config dependencies pinned with version+integrity keep that pin (docs/config-dependencies.md). depcurfew neither writes nor checks it.',
    ),
    pnpmfiles: includes.verified<PnpmfilesKnowledge>(
      {
        updateConfigSince: '10.8.0',
        defaults: [
          { since: '6.0.0', value: ['.pnpmfile.cjs'] },
          { since: '11.0.0', value: ['.pnpmfile.mjs', '.pnpmfile.cjs'] },
        ],
        setting: 'pnpmfile',
        ignore: 'ignorePnpmfile',
        global: 'globalPnpmfile',
      },
      `${PNPM_V12_17}/pnpm/docs/pnpmfile.md`,
      'hooks.updateConfig "Allows you to modify the configuration settings used by pnpm" and "runs after the settings are merged and can still change any of them" (config-includes.md); since v12.4.1 it receives the resolved configuration, and since v12.8.0 only a setting given on the command line wins over it. Added in 10.8.0 ("Experimental. A new hook is supported for updating configuration settings. The hook can be provided via .pnpmfile.cjs", pnpm/CHANGELOG.md at v10.34.9). The project pnpmfile sits next to the lockfile (the workspace root): .pnpmfile.cjs since 6.0.0 ("pnpmfile.js renamed to .pnpmfile.cjs"); since 11.0.0 .pnpmfile.mjs, which "takes priority over .pnpmfile.cjs when present" (11.0.0 release notes). When the pnpmfile setting is set, also to [], pnpm does not look for these files ("Set pnpmfile: [] in pnpm-workspace.yaml when the workspace has no pnpmfile, so a new .pnpmfile.mjs is not picked up automatically", config-includes.md); its paths are relative to the file that sets it. globalPnpmfile is loaded first. ignorePnpmfile: true loads no pnpmfile, those of config-dependency plugins included: cli/cli-utils/src/getConfig.ts at v10.34.9, pnpm11/pnpm/src/getConfig.ts at v11.28.10 (installConfigDepsAndLoadHooks, tryLoadDefaultPnpmfile = config.pnpmfile == null), pnpm/crates/hooks/src/finder.rs (find_pnpmfiles) and pnpm/crates/cli/src/config_deps/hooks.rs (resolve_pnpmfile_paths, may_update_config) at v12.17.0; pnpm 12 does not take ignorePnpmfile from the global config.yaml (workspace_scope.rs). With sharedWorkspaceLockfile: false each project also runs the pnpmfile in its own directory (pnpmfile.md). ignoreScripts does not stop any of them (installScripts.disableAll).',
    ),
    configPlugins: includes.verified<PnpmPluginsKnowledge>(
      {
        setting: 'configDependencies',
        patterns: [
          { since: '10.13.0', value: ['pnpm-plugin-*', '@pnpm/plugin-*'] },
          { since: '10.15.0', value: ['pnpm-plugin-*', '@pnpm/plugin-*', '@*/pnpm-plugin-*'] },
        ],
      },
      `${PNPM_V12_17}/pnpm/docs/config-dependencies.md`,
      '"If your config dependency is named following the pnpm-plugin-*, @*/pnpm-plugin-*, or @pnpm/plugin-* pattern, pnpm will automatically load its pnpmfile.mjs (falling back to pnpmfile.cjs) from the package root." 10.13.0: "pnpm will now automatically load the pnpmfile.cjs file from any config dependency named @pnpm/plugin-* or pnpm-plugin-*"; 10.15.0: "Automatically load pnpmfiles from config dependencies that are named @*/pnpm-plugin-*" (pnpm/CHANGELOG.md at v10.34.9). The test is a prefix pnpm-plugin- or @pnpm/plugin-, or a scoped name containing /pnpm-plugin- (isPluginName in cli/cli-utils/src/getConfig.ts at v10.34.9 and pnpm11/pnpm/src/getConfig.ts at v11.28.10, is_plugin_name in pnpm/crates/hooks/src/finder.rs at v12.17.0). Such a pnpmfile loads also when the package supplies settings through include ("A config dependency whose name follows the plugin naming pattern still loads its pnpmfile", config-includes.md), unless ignorePnpmfile is true (extra.pnpmfiles). Config dependencies came in 10.0.0 ("configurational dependencies", then in the pnpm field of package.json); the docs of 10.x, 11.x and 12.17.0 declare them in pnpm-workspace.yaml.',
    ),
    knownPlugins: includes.verified<PnpmKnownPlugin[]>(
      [{ name: '@pnpm/plugin-better-defaults', since: '0.3.0', settings: { minimumReleaseAge: 1440, blockExoticSubdeps: true } }],
      'https://github.com/pnpm/plugin-better-defaults/blob/v0.3.0/src/pnpmfile.cjs',
      'The official plugin\'s updateConfig sets minimumReleaseAge: 1 * 24 * 60 ("1 day in minutes") and blockExoticSubdeps: true with Object.assign, so it replaces a longer delay of pnpm-workspace.yaml. Versions 0.1.0 to 0.2.1 (the pnpmfile.cjs of the published packages on registry.npmjs.org) set neither; 0.3.0, published on 2026-03-01, is the latest. pnpm/docs/pnpmfile.md at v12.17.0 names it as the example of the hook.',
    ),
  },
};
