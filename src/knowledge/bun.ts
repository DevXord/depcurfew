import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge, Versioned } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const user = verifiedOn('2026-10-31');
const runtimes = verifiedOn('2026-11-01');
const BUN_V1_4_4 = 'https://github.com/oven-sh/bun/blob/bun-v1.4.4';
const BUNFIG_PARSER = `${BUN_V1_4_4}/src/bunfig/bunfig.rs`;

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

const WORKSPACES = 'https://github.com/oven-sh/bun/blob/main/docs/pm/workspaces.mdx';

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
    lockfiles: uncertain(
      [
        { since: '0.0.0', value: ['bun.lockb'] },
        { since: '1.2.0', value: ['bun.lock', 'bun.lockb'] },
      ],
      'https://github.com/oven-sh/bun/blob/main/docs/pm/lockfile.mdx',
      'Bun 1.2 made the text bun.lock the default (verified). That bun.lockb is still read afterwards is inferred from the documented migration command and from saveTextLockfile = false, which writes bun.lockb.',
    ),
    manifests: verified(['package.json'], WORKSPACES),
    workspaces: verified({ files: ['package.json'], key: 'workspaces' }, WORKSPACES, 'Full glob syntax, including ! patterns.'),
    workspacesObjectKey: verified('packages', 'https://github.com/oven-sh/bun/blob/main/docs/pm/catalogs.mdx', 'The object form also holds catalog and catalogs.'),
  },
  user: {
    files: user.verified(
      [
        {
          since: '0.0.0',
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
      `${BUN_V1_4_4}/docs/runtime/bunfig.mdx`,
      '"When XDG_CONFIG_HOME is set to an absolute path, Bun reads the file there and not the one in $HOME"; HOME is USERPROFILE on Windows (src/bun_core/env_var.rs). Only one file is read, with no fallback when the XDG one is missing (get_home_config_path in src/bunfig/arguments.rs). Only package manager commands read it (bun install, add, remove, update, pm, bunx and so on), before the project bunfig.toml, whose keys win. 1.2.0 already reads it, and the first version was not tracked; 1.2.0 and 1.3.0 used XDG_CONFIG_HOME whenever it was set, and the version that started requiring an absolute path was not pinned.',
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
    installOverrides: runtimes.verified(
      { options: [{ name: '--minimum-release-age', weakens: 'delay', values: 'delay' }], variables: [] },
      'https://github.com/oven-sh/bun/blob/main/docs/pm/cli/install.mdx',
      'bun add @types/bun --minimum-release-age 259200 # seconds: "A number is in seconds", or a number with a unit such as 90m, 12 hours, 3d or 2 weeks (durationStrings). The page lists no environment variable for it.',
    ),
  },
};
