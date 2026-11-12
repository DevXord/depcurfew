import { verifiedOn } from './define.ts';
import type { CommandNamesKnowledge, DirectoryOptionsKnowledge, EnvironmentNameRule, OptionValues, RunnerOptionsKnowledge, SourceKnowledge, ToolKnowledge, Versioned } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const user = verifiedOn('2026-10-31');
const runtimes = verifiedOn('2026-11-01');
const release14 = verifiedOn('2026-11-02');
const runners = verifiedOn('2026-11-03');
// The user file of Bun before and after 1.4.4 (decision D-170).
const d170 = verifiedOn('2026-11-03');
// The options of Bun 1.4.4 that take a value, and --minimum-release-age-excludes (decision D-201).
const d201 = verifiedOn('2026-11-11');
const BUN_V1_4_4 = 'https://github.com/oven-sh/bun/blob/bun-v1.4.4';
const BUNFIG_PARSER = `${BUN_V1_4_4}/src/bunfig/bunfig.rs`;
const COMMAND_LINE_ARGUMENTS = `${BUN_V1_4_4}/src/install/PackageManager/CommandLineArguments.rs`;

/** IGNORED_FOREIGN_FLAGS.options of CommandLineArguments.rs at bun-v1.4.4: options of npm, pnpm and Yarn that Bun skips with their value. */
const FOREIGN_VALUE_OPTIONS = [
  '--allow-build', '--allow-directory', '--allow-file', '--allow-git', '--allow-remote', '--allow-scripts',
  '--also', '--before', '--cache', '--cache-folder', '--cache-max', '--cache-min', '--cert',
  '--changed-files-ignore-pattern', '--child-concurrency', '--dir', '--enjoy-by', '--fetch-min-speed-ki-bps',
  '--fetch-retries', '--fetch-retry-factor', '--fetch-retry-maxtimeout', '--fetch-retry-mintimeout',
  '--fetch-timeout', '--fetch-warn-timeout-ms', '--filter-prod', '--global-folder', '--global-pnpmfile',
  '--globalconfig', '--hoist-pattern', '--http-proxy', '--https-proxy', '--include', '--install-strategy',
  '--key', '--link-folder', '--local-address', '--location', '--lockfile-dir', '--lockfile-version', '--loglevel',
  '--logs-dir', '--logs-max', '--maxsockets', '--merge-git-branch-lockfiles-branch-pattern', '--min-release-age',
  '--mode', '--mutex', '--network-timeout', '--node-gyp', '--node-linker', '--node-options', '--noproxy',
  '--npmrc-auth-file', '--only', '--otp', '--package-import-method', '--pnpmfile', '--pnpr-server',
  '--preferred-cache-folder', '--prefix', '--proxy', '--public-hoist-pattern', '--replace-registry-host',
  '--reporter', '--save-catalog-name', '--save-prefix', '--scope', '--script-shell', '--state-dir', '--store-dir',
  '--tag', '--test-pattern', '--umask', '--use-yarnrc', '--user-agent', '--userconfig', '--virtual-store-dir',
  '--workspace', '--workspace-concurrency', '--workspace-packages',
];

const BUNFIG = 'https://bun.com/docs/runtime/bunfig';
const INSTALL = 'https://bun.com/docs/pm/cli/install';
const LIFECYCLE = 'https://bun.com/docs/pm/lifecycle';
const ADD = 'https://bun.com/docs/pm/cli/add';
const BUN_1_4_4 = 'https://bun.com/blog/bun-v1.4.4#minimumreleaseage-supports-units-and-per-version-exclusions';
const DOCS_1_3_0 = 'https://github.com/oven-sh/bun/blob/bun-v1.3.0/docs/cli/install.md';

const noSetting = (anchor: string, kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${ADD}#${anchor}`,
    `${kind} dependencies are supported with no setting to allow or forbid them (concluded from the full bunfig [install] list); install.blockExoticSubdeps is proposed in oven-sh/bun#30340 but not shipped.`,
  ),
});

const WORKSPACES = `${BUN_V1_4_4}/docs/pm/workspaces.mdx`;

export const bun: ToolKnowledge = {
  id: 'bun',
  name: 'Bun',
  kind: 'package-manager',
  cooldown: {
    setting: verified('install.minimumReleaseAge', `${BUNFIG}#install-minimumreleaseage`),
    configFiles: verified(
      ['bunfig.toml'],
      BUNFIG,
      'Also the global $HOME/.bunfig.toml or $XDG_CONFIG_HOME/.bunfig.toml; local keys override global ones. Bun\'s .npmrc support has no min-release-age key.',
    ),
    cliFlag: verified(
      '--minimum-release-age',
      DOCS_1_3_0,
      'bun install, add and update; bunx honors it only since 1.4.4.',
    ),
    unit: verified(
      'seconds',
      `${BUNFIG}#install-minimumreleaseage`,
      'Plain numbers are seconds; 0 turns it off. Since 1.4.4 duration strings such as 90m, 12 hours, 3d or 2 weeks also work (the bunfig reference still documents seconds only).',
    ),
    availableSince: verified('1.3.0', 'https://bun.com/blog/bun-v1.3#minimum-release-age'),
    default: disputed<Versioned<number | null>>(
      'The bunfig reference says the default is null (off) and an open docs pull request (oven-sh/bun#41545) says the feature is off by default; the install page lists 259200 (3 days) under "These are the default values".',
      evidence([{ since: '1.3.0', value: null }], `${BUNFIG}#install-minimumreleaseage`),
      evidence([{ since: '1.3.0', value: 259200 }], INSTALL),
    ),
    exclude: {
      setting: verified('install.minimumReleaseAgeExcludes', `${BUNFIG}#install-minimumreleaseageexcludes`),
      availableSince: verified('1.3.0', DOCS_1_3_0),
      patternSyntax: verified(
        'Exact package names (all versions); since 1.4.4 also name@exactVersion. No wildcards; ranges and tags are ignored with a warning',
        BUN_1_4_4,
        'Since 1.4.4 --minimum-release-age-excludes replaces the bunfig list for one command.',
      ),
    },
    securityUpdates: uncertain(
      'applies',
      BUN_1_4_4,
      'No automatic bypass is documented; exempt the fixed release with name@version in minimumReleaseAgeExcludes (1.4.4+). Exact version requests still go through the gate.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'deny-except-allowlist' }],
      `${LIFECYCLE}#trusteddependencies`,
      'Dependency scripts run only for Bun\'s built-in trusted list (npm-registry packages only since 1.4) or trustedDependencies; the root project\'s scripts run. First version of this policy not tracked.',
    ),
    allowList: {
      setting: verified(
        'trustedDependencies',
        `${LIFECYCLE}#trusteddependencies`,
        'Replaces the built-in default list rather than extending it. bun pm trust and bun add --trust write it.',
      ),
      file: verified('package.json', `${LIFECYCLE}#trusteddependencies`),
      availableSince: uncertain(
        '1.0.5',
        'https://bun.com/blog/release-notes/bun-v1.0.5',
        'Upper bound: 1.0.5 already persists trustedDependencies in bun.lockb; the first version was not pinned down. bun pm trust and bun add --trust arrived in 1.0.31.',
      ),
      format: verified('Array of package names, e.g. ["node-sass"]', `${LIFECYCLE}#trusteddependencies`),
    },
    disableAll: verified(
      'install.ignoreScripts',
      `${BUNFIG}#install-ignorescripts`,
      'Default false. Also --ignore-scripts or ignore-scripts=true in .npmrc. Skips the project\'s own scripts and trustedDependencies too.',
    ),
  },
  sources: {
    git: noSetting('git-dependencies', 'Git'),
    remoteTarball: noSetting('tarball-dependencies', 'Tarball URL'),
    file: noSetting('local-paths', 'Local tarball'),
    directory: noSetting('local-paths', 'Local directory'),
  },
  project: {
    lockfiles: d170.uncertain(
      [
        { since: '0.0.0', value: ['bun.lockb'] },
        { since: '1.2.0', value: ['bun.lock', 'bun.lockb'] },
      ],
      `${BUN_V1_4_4}/docs/pm/lockfile.mdx`,
      'Bun 1.2 made the text bun.lock the default (verified). That bun.lockb is still read afterwards is inferred from the documented migration command and from saveTextLockfile = false, which writes bun.lockb.',
    ),
    manifests: d170.verified(['package.json'], WORKSPACES),
    workspaces: d170.verified({ files: ['package.json'], key: 'workspaces' }, WORKSPACES, 'Full glob syntax, including ! patterns.'),
    workspacesObjectKey: d170.verified('packages', `${BUN_V1_4_4}/docs/pm/catalogs.mdx`, 'The object form also holds catalog and catalogs.'),
  },
  user: {
    files: d170.verified(
      [
        {
          since: '0.0.0',
          value: {
            format: 'toml',
            locations: [
              {
                platforms: ['linux', 'darwin', 'win32'],
                directories: [
                  { from: { env: 'XDG_CONFIG_HOME', emptyCounts: true }, path: '' },
                  { from: 'home', path: '' },
                ],
                file: '.bunfig.toml',
              },
            ],
          },
        },
        {
          since: '1.4.4',
          value: {
            format: 'toml',
            locations: [
              {
                platforms: ['linux', 'darwin', 'win32'],
                directories: [
                  { from: { env: 'XDG_CONFIG_HOME', absolute: true }, path: '' },
                  { from: 'home', path: '' },
                ],
                file: '.bunfig.toml',
              },
            ],
          },
        },
      ],
      `${BUN_V1_4_4}/src/bunfig/arguments.rs`,
      'Since 1.4.4 get_home_config_path takes the first of XDG_CONFIG_HOME and HOME that is a fully qualified path ("The XDG specification says to ignore $XDG_CONFIG_HOME when it is empty or a relative path"; docs/runtime/bunfig.mdx at 1.4.4: "When XDG_CONFIG_HOME is set to an absolute path, Bun reads the file there and not the one in $HOME"); HOME is USERPROFILE on Windows (src/bun_core/env_var.rs). Before 1.4.4 Bun uses XDG_CONFIG_HOME whenever it is set, also to an empty or relative value (XDG_CONFIG_HOME.get().or_else(HOME) in src/bunfig/arguments.rs at bun-v1.4.3; the same in 1.4.0 and, in Zig, getHomeConfigPath in src/cli/Arguments.zig at bun-v1.3.0 and bun-v1.3.14), and joins it with join_abs_string_buf, which puts a / in place of the first character of a value without a leading separator (_joinAbsStringBuf in src/resolver/resolve_path.zig at bun-v1.3.0, src/paths/resolve_path.rs at bun-v1.4.0): XDG_CONFIG_HOME=cfg gives /fg/.bunfig.toml, an empty value /bunfig.toml, so Bun then reads neither the file below the current directory nor ~/.bunfig.toml. Only one file is read, with no fallback when the XDG one is missing. Only package manager commands read it (bun install, add, remove, update, pm, bunx and so on), before the project bunfig.toml, whose keys win. 1.2.0 already reads it; the first version was not tracked.',
    ),
    settings: user.verified(
      [
        { purpose: 'cooldown', key: 'install.minimumReleaseAge', since: '1.3.0' },
        { purpose: 'cooldownExclude', key: 'install.minimumReleaseAgeExcludes', since: '1.3.0' },
      ],
      BUNFIG_PARSER,
      'parse_install reads both from the user file as from bunfig.toml (only globalDir and globalBinDir are user-only), as in 1.3.0 (bunfig.zig). trustedDependencies exists only in package.json and bunfig has no such key, so Bun has no user-level allow-list; install.ignoreScripts only turns scripts off. Write whole seconds: duration strings need 1.4.4.',
    ),
    unknownKeys: user.verified(
      'ignore',
      BUNFIG_PARSER,
      'The parser looks up only the keys it knows (install_obj.get), so another key, such as install.minimumReleaseAge before 1.3.0, is neither read nor reported.',
    ),
    invalidValueFails: user.verified(
      true,
      `${BUN_V1_4_4}/src/bunfig/arguments.rs`,
      'load_global_bunfig ends the process through report_bunfig_load_failure when the user file has a value Bun cannot read, e.g. minimumReleaseAge = "3d" before 1.4.4 ("Expected number of seconds for minimumReleaseAge"), so every package manager command fails; 1.3.0 crashed the same way. A file Bun cannot read at all is skipped.',
    ),
    weakening: user.verified(
      [
        { key: 'install.minimumReleaseAge', values: [0], effect: 'turns the release-age delay off in every project whose bunfig.toml does not set it' },
        {
          key: 'install.minimumReleaseAgeExcludes',
          values: 'any',
          effect: 'exempts these packages from the release-age delay in every project without a non-empty list of its own',
        },
      ],
      BUNFIG_PARSER,
      'Both files fill one set of options, the user file first, so a key in the project bunfig.toml replaces the user value; an empty minimumReleaseAgeExcludes list is skipped, so a project\'s [] does not clear the user list. 0 turns the delay off (src/install/PackageManager/PackageManagerOptions.rs keeps only values above 0). The command line beats both files.',
    ),
    variables: user.uncertain(
      [],
      `${BUN_V1_4_4}/docs/pm/cli/install.mdx`,
      'No environment variable sets minimumReleaseAge or its exclusions: concluded from the install page, which lists registry, token, lockfile and retry variables only. NPM_CONFIG_IGNORE_SCRIPTS only turns scripts off. XDG_CONFIG_HOME moves the user file (user.files).',
    ),
  },
  extra: {
    environmentNames: release14.verified<EnvironmentNameRule[]>(
      [{ prefix: '', match: 'exact' }],
      `${BUN_V1_4_4}/src/install/PackageManager/PackageManagerOptions.rs`,
      'Options::load looks up BUN_CONFIG_REGISTRY, NPM_CONFIG_REGISTRY and npm_config_registry with env.get, each spelling as written; the map behind env.get (HashTable in src/dotenv/env_loader.rs, https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/dotenv/env_loader.rs) is a StringArrayHashMap outside Windows and a CaseInsensitiveAsciiStringArrayHashMap on Windows, where names are not told apart by case. Decision D-143.',
    ),
    registrySettings: runtimes.verified(
      [
        { file: 'bunfig.toml', path: ['install', 'registry'], applies: 'all', effect: 'replaces', urlKey: 'url' },
        { file: 'bunfig.toml', path: ['install', 'scopes', '*'], applies: 'scope', effect: 'replaces', urlKey: 'url' },
      ],
      `${BUN_V1_4_4}/docs/runtime/bunfig.mdx`,
      '"Put bunfig.toml in your project root, alongside your package.json"; the global $HOME/.bunfig.toml (or $XDG_CONFIG_HOME/.bunfig.toml) is loaded too, and local keys win. "The default registry is https://registry.npmjs.org/. To change it": [install] registry, a string or { url, token }. "To configure a registry for a particular scope (for example, @myorg/<package>), use install.scopes": a key per scope (myorg = "https://registry.myorg.com/" or a table with url).',
    ),
    projectInstall: runtimes.verified(
      { commands: ['install'], bare: false },
      'https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/pm/cli/install.mdx',
      '"if your project has a package.json, you can use bun install"; the page names no alias, so none is listed. bun add (commandLine.add) adds packages.',
    ),
    commandLine: checked.verified(
      {
        add: [['bun', 'add']],
        run: [
          { command: ['bunx'], packageOptions: ['-p', '--package'] },
          { command: ['bun', 'x'], packageOptions: ['-p', '--package'] },
        ],
        create: [{ command: ['bun', 'create'], packageOptions: [] }],
        createNames: 'prefix',
        valueOptions: [
          '--omit', '--filter', '--ca', '--cafile', '--registry', '--network-concurrency', '--backend', '--concurrent-scripts',
          '--cache-dir', '--config', '--cwd', '--env-file', '--minimum-release-age',
        ],
      },
      'https://github.com/oven-sh/bun/tree/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/snippets/cli',
      'Options of bun add (snippets/cli/add.mdx) and bunx (snippets/cli/bunx.mdx) typed string or number; --catalog takes its name only after =. -p is --package for bunx but the flag --production for bun add, so it is listed with bunx only. The short forms -F (--filter) and -c (--config) of bun add are left out because bunx does not document them, and an option wrongly read as taking a value would hide the package after it. bunx is an alias for bun x (docs/pm/bunx.mdx). bun create <template> runs the create-<template> package from npm unless a local template has that name; it also takes GitHub repositories and local paths (docs/runtime/templating/create.mdx).',
    ),
    runnerOptions: runners.verified<RunnerOptionsKnowledge>(
      { beforeCommand: [{ command: ['bun', 'x'], values: 'attached' }] },
      'https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/runtime/cli/bunx_command.rs',
      'bun x reads every option before the package name, also those before x: Options::parse gets the command line after bun, with x as the subcommand name, and takes --package <name>, --package=<name>, -p <name> and -p=<name> wherever they stand before it, so bun --package=x x y and bun -p=x x y download x. bun finds its command by skipping each word that starts with - (which in src/runtime/cli/mod.rs at bun-v1.4.4), so in bun --package x x y it takes the value x for the command, and bun x runs only when that value is x. Decision D-160.',
    ),
    commandNames: runners.verified<CommandNamesKnowledge>(
      {
        commands: [
          'add', 'audit', 'auth', 'build', 'check', 'ci', 'cloud', 'completions', 'config', 'create', 'dedupe', 'deploy',
          'discord', 'exec', 'fmt', 'getcompletes', 'help', 'info', 'init', 'install', 'link', 'lint', 'list', 'login',
          'logout', 'outdated', 'patch', 'patch-commit', 'pm', 'prune', 'publish', 'remove', 'repl', 'run', 'test',
          'unlink', 'update', 'upgrade', 'use', 'whoami', 'why', 'x',
        ],
        aliases: { a: 'add', c: 'create', i: 'install', up: 'update', r: 'remove', rm: 'remove', uninstall: 'remove', bun: 'build' },
        matching: 'exact',
      },
      `${BUN_V1_4_4}/src/runtime/cli/mod.rs`,
      'Command::which compares the first word that does not start with - with each name as written (RootCommandMatcher::case, no prefixes and no other case): add and a run AddCommand, create and c CreateCommand (bun_create, which reads the word after the command word as the template whatever the command word was, so bun c foo runs bunx create-foo), install and i InstallCommand, or AddCommand with -g or --global anywhere on the line, ci InstallCommand, update and up, r, remove, rm and uninstall, build and bun; deploy, cloud, config, use, auth, login and logout are reserved, whoami and list run bun pm. Any other word runs a script, a file or a binary of the project (AutoCommand). AddCommand runs the same Subcommand::Add whichever word chose it (src/runtime/cli/add_command.rs). Decision D-162.',
    ),
    packageSpecs: checked.verified(
      { git: ['github:', 'git+ssh://', 'git+https://'], local: [], workspace: [], scp: true },
      'https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/pm/cli/add.mdx',
      'Git dependencies: "Bun supports a variety of protocols, including github, git, git+ssh, and git+https", with the examples git@github.com:moment/moment.git and github:colinhacks/zod. Tarball URLs, local folders and local .tgz files are accepted too.',
    ),
    registryOverrides: checked.verified(
      { registryOptions: ['--registry'], registryVariables: ['BUN_CONFIG_REGISTRY'], configOptions: ['--config', '-c'], configVariables: [] },
      'https://github.com/oven-sh/bun/tree/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs',
      'bun add takes --registry and --config (-c), a configuration file (snippets/cli/add.mdx). BUN_CONFIG_REGISTRY sets the npm registry and environment variables take priority over bunfig.toml (pm/cli/install.mdx).',
    ),
    optionValues: d201.verified<OptionValues[]>(
      [
        { commands: ['add'], value: 'always', options: ['--linker', '--cpu', '--os'] },
        { commands: ['add'], value: 'always', since: '1.4.4', options: ['--libc'] },
        { commands: ['add'], value: 'always', since: '1.4.4', separator: ',', options: ['--minimum-release-age-excludes'] },
        { commands: ['add', 'run'], value: 'unless-dash', since: '1.4.4', options: FOREIGN_VALUE_OPTIONS },
        { commands: ['run'], value: 'unless-dash', since: '1.4.4', options: ['--npm', '--shell', '--cpu', '--libc', '--omit', '--os'] },
        { commands: ['run'], value: 'always', since: '1.4.4', options: ['--node-arg'] },
      ],
      COMMAND_LINE_ARGUMENTS,
      'bun install, add, update and remove share SHARED_TAIL_PARAMS, where --linker <STR>, --cpu <STR>..., --os <STR>..., --libc <STR>... and --minimum-release-age-excludes <STR>... ("comma-separated or repeated; replaces the bunfig.toml list") take a value, which clap takes from the next word whatever it is (src/clap/streaming.rs); an invalid --linker, --cpu, --os or --libc value ends the command. --linker, --cpu and --os take it in every Bun since 1.3.0 (CommandLineArguments.zig at bun-v1.3.0); older Bun skipped them alone and installed the next word (no --linker, --cpu or --os in CommandLineArguments.zig at bun-v1.2.18, --linker only at bun-v1.2.19, all three at bun-v1.2.23), and depcurfew does not check that word for them; --libc and --minimum-release-age-excludes are new in 1.4.4 (absent at bun-v1.4.3), and PackageManagerOptions.rs splits the exceptions at commas, trims them and drops empty ones. IGNORED_FOREIGN_FLAGS lists the "Flags of npm, yarn and pnpm that Bun has no equivalent for", which "bun install, add, remove, update and bunx skip"; its options take the next word for their value "unless value starts with a dash" (IgnoredLongFlags in src/clap/lib.rs), though bunx stops on userconfig, globalconfig, npmrc-auth-file, use-yarnrc, replace-registry-host and pnpr-server. "Only bunx skips" IGNORED_NPX_FLAGS, whose options are node-arg, npm, shell, cpu, libc, omit and os; bunx_skips_flag takes the next word after --node-arg whatever it is ("Its value is a flag for node"). The short options of FOREIGN_SHORT_OPTIONS are skipped only as -m=value, so none is listed. bunx 1.4.4 stops on any other option it does not know ("bunx has no ... flag", src/runtime/cli/bunx_command.rs), --linker and --minimum-release-age-excludes among them. Before 1.4.4 these options took no value: clap skipped a long option it did not know alone ("continue parsing after unrecognized flag", src/clap/streaming.rs at bun-v1.4.3 and src/deps/zig-clap/clap/streaming.zig at bun-v1.3.0), and bunx skipped every word that starts with - except --package and -p (Options::parse in bunx_command.rs at bun-v1.4.3, the same in bunx_command.zig at bun-v1.3.14), so bun add installed the word after them and bunx ran it; that word is checked as a package too, and one the registry does not have is a warning, since Bun 1.4.4 reads it as the value and older Bun fails on it. Not read: a flag of these lists that takes true or false from the next word (--yes false), and --no-<option> true or false. Decision D-201.',
    ),
    lockfileFormat: checked.verified(
      {
        installScripts: 'hasInstallScript',
        installScriptsSince: '1.4.4',
        git: ['git+', 'github:'],
        directory: ['file:', 'link:'],
        workspace: 'workspace:',
        tarball: '\\.(?:tar\\.gz|tgz)$',
      },
      'https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/install/lockfile/bun.lock.rs',
      'bun.lock (text, the default since 1.2) maps each package to a tuple starting with name@<spec>: name@<version> followed by the registry for npm, name@git+<repo>#<sha> and name@github:<owner>/<repo>#<sha> for git, name@https://… for tarball URLs, name@./x.tgz (without file:) for local tarballs, name@file:<dir> and name@link:<dir> for directories, name@workspace:<dir> for workspace packages. The info object carries hasInstallScript: true only since 1.4.4, with no lockfileVersion change, so a missing flag proves nothing for older files. bun.lockb is an undocumented binary format.',
    ),
    durationStrings: verified(
      { since: '1.4.4', syntax: 'compact-or-words' },
      BUN_1_4_4,
      'Since 1.4.4 minimumReleaseAge also takes duration strings such as 90m, 12 hours, 3d or 2 weeks; plain numbers stay seconds.',
    ),
    excludeWildcards: verified(
      { since: null, trailingOnly: false },
      BUN_1_4_4,
      'minimumReleaseAgeExcludes takes exact package names (and name@version since 1.4.4), no wildcards.',
    ),
    latestVersion: verified('1.4.4', 'https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4'),
    trustedDependenciesReplacesDefaults: checked.verified(
      'Adding trustedDependencies replaces the built-in trusted list, so default-trusted packages that are not listed stop running scripts',
      `${LIFECYCLE}#behavior-of-the-trusteddependencies-field`,
      'So an empty list trusts no package: without the field Bun 1.4.4 ran esbuild\'s postinstall (esbuild is on the built-in list); with "trustedDependencies": [] it blocked it (bun pm untrusted listed it), tested on 2026-10-29.',
    ),
    lockedVersionsNotRechecked: verified(
      'minimumReleaseAge only affects new resolutions; versions already in bun.lock are kept',
      `${INSTALL}#minimum-release-age`,
    ),
    bunxCooldown: verified('bunx applies --minimum-release-age only since 1.4.4', 'https://bun.com/blog/bun-v1.4.4'),
    directoryOptions: runtimes.verified<DirectoryOptionsKnowledge>(
      { options: [{ name: '--cwd', moves: 'directory' }], variables: [] },
      `${BUN_V1_4_4}/docs/snippets/cli/add.mdx`,
      'bun add: <ParamField path="--cwd" type="string"> "Set a specific current working directory" (Global Configuration & Context); bun install has the same option, "Set a specific cwd" (docs/snippets/cli/install.mdx at the same tag, General Configuration).',
    ),
    installOverrides: d201.verified(
      {
        options: [
          { name: '--minimum-release-age', weakens: 'delay', values: 'delay' },
          { name: '--minimum-release-age-excludes', weakens: 'delay', values: 'any' },
          { name: '--trust', weakens: 'scripts', values: 'any' },
        ],
        variables: [],
      },
      `${BUN_V1_4_4}/docs/pm/cli/install.mdx`,
      'bun add @types/bun --minimum-release-age 259200 # seconds: "A number is in seconds", or a number with a unit such as 90m, 12 hours, 3d or 2 weeks (durationStrings). The page lists no environment variable for it. Since 1.4.4 "--minimum-release-age-excludes takes the same entries as minimumReleaseAgeExcludes below and replaces that list" (bun install --minimum-release-age 259200 --minimum-release-age-excludes @types/node,typescript@5.4.5), comma-separated or repeated, in bun install, add, update and remove, not in bunx (optionValues); any value exempts packages from the delay for that command, and one that only narrows the list of bunfig.toml is reported too (fail closed). bun add --trust: "Add to trustedDependencies in the project\'s package.json and install the package(s)", so its lifecycle scripts run (docs/snippets/cli/add.mdx and docs/pm/lifecycle.mdx at bun-v1.4.4); lifecycle.mdx names no variable that turns scripts on, and ignore-scripts read from the environment "only turns scripts off".',
    ),
  },
};
