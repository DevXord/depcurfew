import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const reviewed = verifiedOn('2026-10-30');
const user = verifiedOn('2026-10-31');
const leftovers = verifiedOn('2026-11-01');
const DENO_V2_9_8 = 'https://github.com/denoland/deno/blob/v2.9.8';
const NPMRC_PARSER = `${DENO_V2_9_8}/libs/npmrc/lib.rs`;
const X_VALUE_OPTIONS = [
  '--package', '-p', '--config', '-c', '--import-map', '--cert', '--min-dep-age', '--location', '--seed', '--preload', '--require',
  '--conditions', '--inspect-publish-uid',
];

const DENO_JSON = 'https://docs.deno.com/runtime/reference/deno_json/#minimum-dependency-age';
const SUPPLY_CHAIN = 'https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age';
const SCHEMA = 'https://github.com/denoland/deno/blob/v2.9.8/cli/schemas/config-file.v1.json';
const INSTALL = 'https://docs.deno.com/runtime/reference/cli/install/';
const NOT_SUPPORTED = 'https://docs.deno.com/examples/local_unpublished_packages_tutorial/#what-is-not-supported';
const release = (version: string) => `https://github.com/denoland/deno/releases/tag/v${version}`;

const unsupported = (note: string): SourceKnowledge => ({ setting: verified(null, NOT_SUPPORTED, note) });

const WORKSPACES = 'https://github.com/denoland/docs/blob/main/runtime/fundamentals/workspaces.md';

export const deno: ToolKnowledge = {
  id: 'deno',
  name: 'Deno',
  kind: 'package-manager',
  cooldown: {
    setting: verified(
      'minimumDependencyAge',
      DENO_JSON,
      'A number or string, or the object form { "age": ..., "exclude": [...] }. Covers npm and JSR packages.',
    ),
    configFiles: verified(
      ['deno.json', '.npmrc'],
      SUPPLY_CHAIN,
      'min-release-age in .npmrc since 2.8; also NPM_CONFIG_MIN_RELEASE_AGE. This page does not state precedence; denoland/deno#35458 gives CLI flag, deno.json, .npmrc, environment, built-in default.',
    ),
    cliFlag: verified(
      '--minimum-dependency-age',
      DENO_JSON,
      'Alias --min-dep-age since 2.9.3. deno install honors it since 2.5.5; deno add, deno remove and deno x since 2.9.4.',
    ),
    unit: verified(
      'minutes',
      SCHEMA,
      'Numbers are minutes; strings may be an ISO-8601 duration (P3D, PT72H), an absolute date or an RFC3339 timestamp; 0 turns it off. The .npmrc format differs (see npmrcFormat).',
    ),
    availableSince: disputed(
      'The 2.5.5 release notes ship the flag, the deno.json key and exclude as unstable; the release blog says the feature was introduced in 2.6.',
      evidence('2.5.5', release('2.5.5')),
      evidence('2.6.0', 'https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default'),
    ),
    default: verified(
      [
        { since: '0.0.0', value: null },
        { since: '2.9.0', value: 1440 },
      ],
      DENO_JSON,
      'Since 2.9 a 24-hour minimum applies when nothing is configured; set 0 to turn it off. Whether the default covers JSR is not stated.',
    ),
    exclude: {
      setting: verified('minimumDependencyAge.exclude', SCHEMA),
      availableSince: verified('2.5.5', release('2.5.5')),
      patternSyntax: verified(
        'Specifiers prefixed npm: or jsr:; a trailing * matches by prefix (npm:@scope/*) since 2.9.2',
        SCHEMA,
        'Before 2.9.2 wildcard entries were stored literally and never matched. No CLI flag or .npmrc key for exclusions.',
      ),
    },
    securityUpdates: uncertain(
      'applies',
      SUPPLY_CHAIN,
      'No security bypass is documented; only per-package exclude or an age of 0.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'deny-except-allowlist' }],
      INSTALL,
      'npm lifecycle scripts run only when approved, and only with a node_modules directory. deno x / dx runs them after its download prompt is accepted.',
    ),
    allowList: {
      setting: verified(
        'allowScripts',
        'https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts',
        'deno approve-scripts writes it. --allow-scripts=npm:pkg on the CLI exists since 1.45.',
      ),
      file: verified(
        'deno.json',
        'https://docs.deno.com/examples/npm_lifecycle_scripts_tutorial/',
        'Must be set at the workspace root.',
      ),
      availableSince: verified('2.6.0', 'https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts'),
      format: verified('true, an array of npm: constraints (semver ranges allowed, tags rejected) or { "allow": ..., "deny": [...] }', SCHEMA),
    },
    disableAll: uncertain(
      'allowScripts: false',
      SCHEMA,
      'Scripts do not run by default. The schema accepts a boolean allowScripts, but no page states that false turns all scripts off. deno x has --ignore-scripts.',
    ),
  },
  sources: {
    git: unsupported('git+https: and git+ssh: dependencies are not supported in package.json.'),
    remoteTarball: unsupported('Tarball URL dependencies are not supported in package.json.'),
    file: unsupported(
      'No setting. Since 2.8 file: and link: entries are silently skipped (scope disputed, see fileLinkSkipped); deno.json "links" overrides dependencies with local packages.',
    ),
    directory: unsupported('No setting; local directories behave like file: and link: entries (see fileLinkSkipped).'),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['deno.lock'] }],
      'https://github.com/denoland/docs/blob/main/runtime/reference/deno_json.md',
      'The default location; lock.path in deno.json can move it and "lock": false turns it off.',
    ),
    manifests: verified(['deno.json', 'deno.jsonc'], 'https://github.com/denoland/docs/blob/main/runtime/fundamentals/configuration.md'),
    workspaces: verified(
      { files: ['deno.json', 'deno.jsonc'], key: 'workspace' },
      WORKSPACES,
      'Paths of members; globs and ! exclusions since Deno 2.1.',
    ),
    workspacesObjectKey: verified('members', WORKSPACES),
  },
  user: {
    files: user.verified(
      [
        {
          since: '1.45.0',
          value: { format: 'ini', locations: [{ platforms: ['linux', 'darwin', 'win32'], directories: [{ from: 'home', path: '' }], file: '.npmrc' }] },
        },
      ],
      `${DENO_V2_9_8}/libs/resolver/npmrc.rs`,
      'Deno has no user configuration file of its own (deno.json is looked up from the working directory upwards). It reads .npmrc next to package.json or deno.json and in the home directory (HOME, USERPROFILE on Windows), not the file named by NPM_CONFIG_USERCONFIG and not under XDG_CONFIG_HOME. Home discovery arrived in 1.45.0 (#24021); since 2.1.8 (#27119) the project and home files are merged key by key, before that a project .npmrc hid the home one (Releases.md). This is the ~/.npmrc that npm reads. A home .npmrc Deno may not read is skipped; one that does not parse stops the command.',
    ),
    settings: user.verified(
      [{ purpose: 'cooldown', key: 'min-release-age', since: '2.8.0' }],
      `${DENO_V2_9_8}/Releases.md`,
      '2.8.0: "feat(npmrc): support min-release-age (#33983)". A whole number of days (cooldownUnit); the same line sets npm\'s min-release-age, also in days. minimumDependencyAge.exclude and allowScripts exist only in deno.json (allowScripts at the workspace root), so Deno has no user-level exclusions or script settings.',
    ),
    cooldownUnit: leftovers.verified(
      { key: 'min-release-age', unit: 'days', wholeNumbers: true, otherValues: 'ignored' },
      NPMRC_PARSER,
      'NpmRc::parse reads min-release-age "in days" (min_release_age_days: Option<u64>; "npm interprets the value as a number of days"): an INI number of 0 or more, or a text that parses as a whole number after ${VAR} expansion; anything else, such as 72h or 1.5, is ignored without a message, so the age comes from the next source. The project .npmrc wins over the home file (libs/resolver/npmrc.rs), and the days count only where deno.json and --min-dep-age set nothing; those take minutes, an ISO-8601 duration or an RFC 3339 date (libs/config/util.rs, libs/cli_parser/src/defs.rs).',
    ),
    unknownKeys: user.verified(
      'ignore',
      NPMRC_PARSER,
      'NpmRc::parse reads registry, auth, replace-registry-host, min-release-age and trust-policy keys and skips every other key without a message.',
    ),
    invalidValueFails: user.verified(
      false,
      NPMRC_PARSER,
      'A min-release-age that is not a whole number of days, such as 72h, is ignored without a message (test "invalid value is ignored"), so the age silently comes from the next source. A home .npmrc that does not parse at all stops the command (libs/resolver/npmrc.rs).',
    ),
    weakening: user.verified(
      [
        {
          key: 'min-release-age',
          values: [0],
          effect: 'turns the default minimum dependency age of 24 hours (2.9.0+) off in every project without minimumDependencyAge in deno.json or min-release-age in its own .npmrc',
        },
      ],
      `${DENO_V2_9_8}/libs/resolver/factory.rs`,
      'The age comes from the command line, then minimumDependencyAge in deno.json, then .npmrc (the project file over the home file), then NPM_CONFIG_MIN_RELEASE_AGE, then the built-in 1440 minutes; 0 from .npmrc turns it off (apply_minimum_dependency_age_fallbacks). The same line turns npm\'s delay off too.',
    ),
    variables: user.uncertain(
      [
        {
          name: 'NPM_CONFIG_MIN_RELEASE_AGE',
          values: 'any',
          effect: 'sets min-release-age where no .npmrc has the key, and hides the home value in projects whose .npmrc lacks it (2.9.0+)',
        },
        {
          name: 'npm_config_min_release_age',
          values: 'any',
          effect: 'sets min-release-age where no .npmrc has the key, and hides the home value in projects whose .npmrc lacks it (2.9.0+)',
        },
      ],
      NPMRC_PARSER,
      'Only these two spellings are read (min_release_age_days_from_env); 0 turns the default 24 hours off. Read from code: every parsed .npmrc starts from the variable and its own key overrides it (test ".npmrc value takes precedence over the environment fallback"), and the project file wins over the home file, so a project .npmrc without the key puts the variable above the home value. The first version is from denoland/deno#35458, which shipped in 2.9.0.',
    ),
  },
  extra: {
    denyList: user.verified(
      { file: 'deno.json', setting: 'allowScripts.deny', value: 'npm:<package>', since: '2.6.0' },
      'https://github.com/denoland/deno/blob/v2.9.8/libs/npm_installer/lifecycle_scripts.rs',
      'The object form "allowScripts": { "allow": [...], "deny": ["npm:pkg"] } (schema since 2.6.0: "List of npm package constraints to deny running lifecycle scripts for"); deny beats allow, and a denied package is not added to the packages whose scripts were not run, so Deno does not warn about it.',
    ),
    commandLine: reviewed.verified(
      {
        add: [
          ['deno', 'add'],
          ['deno', 'install'],
        ],
        run: [
          { command: ['deno', 'x'], packageOptions: ['--package', '-p'], binaryPath: true },
          { command: ['dx'], packageOptions: ['--package', '-p'], binaryPath: true },
          { command: ['denox'], packageOptions: ['--package', '-p'], binaryPath: true },
          { command: ['dnx'], packageOptions: ['--package', '-p'], binaryPath: true },
        ],
        create: [],
        createNames: 'prefix',
        fileOptions: ['--entrypoint', '-e'],
        valueOptions: ['--name', '-n', '--root', '--os', '--arch', '-L', '--log-level'],
        commandOptions: [
          { command: ['deno', 'x'], valueOptions: X_VALUE_OPTIONS },
          { command: ['dx'], valueOptions: X_VALUE_OPTIONS },
          { command: ['denox'], valueOptions: X_VALUE_OPTIONS },
          { command: ['dnx'], valueOptions: X_VALUE_OPTIONS },
        ],
      },
      'https://github.com/denoland/docs/tree/74beb7585f7e798fe0bc8d867295bff23fc2e38e/runtime/reference/cli',
      'install.md: deno install [PACKAGES] installs packages and adds them to deno.json or package.json, deno add is its alias, deno install --global installs a package or script as a binary, and deno install --entrypoint (-e) [FILES] installs what the files use. -n/--name, --root, --os and --arch take a value; --allow-scripts and --node-modules-dir are shown with =. Since Deno 2.8 a name without a prefix is an npm package; JSR packages need jsr: (add.md). x.md: deno x runs a package from npm or JSR without installing it, like npx (deno x npm:create-vite my-app); --package (-p) names the package when the binary differs (deno x -p typescript tsc), and npm:<package>/<binary> picks one binary; deno x --install-alias creates the dx alias. In Deno 2.9.8 (github.com/denoland/deno, cli/args/flags.rs) an executable whose name ends in dx, denox or dnx runs as deno x, and libs/cli_parser/src/defs.rs (X_SUBCOMMAND with COMPILE_ARGS, PERMISSION_ARGS, RUNTIME_MISC_ARGS and INSPECT_ARGS) gives the options of deno x that take a separate value; the permission flags take theirs after =. -L/--log-level is a global option with a value.',
    ),
    lockfileFormat: checked.verified(
      { installScripts: 'scripts', installScriptsSinceLockfile: '5', sources: null },
      'https://github.com/denoland/deno/blob/v2.9.8/libs/lockfile/printer.rs',
      'deno.lock version 5 (the default since Deno 2.3) marks npm packages with lifecycle scripts as scripts: true (hasInstallScript from the registry or a preinstall, install or postinstall script, libs/npm/resolution/graph.rs); version 4 has no such field. tarball is written only for registries other than the default one. Deno rejects git and http(s) dependencies in package.json and keeps file: dependencies out of the lockfile.',
    ),
    durationStrings: verified(
      { since: null, syntax: 'iso8601' },
      SCHEMA,
      'Strings are ISO-8601 durations (P3D, PT72H), an absolute date or an RFC3339 timestamp; the last two set a fixed cut-off instead of a delay.',
    ),
    ageObjectKey: verified('age', SCHEMA, 'In the object form of minimumDependencyAge, age holds the delay and exclude the exemptions.'),
    excludeWildcards: verified(
      { since: '2.9.2', trailingOnly: true },
      SCHEMA,
      'A trailing * matches by prefix (npm:@scope/*) since 2.9.2; earlier wildcard entries never matched.',
    ),
    npmSpecifierPrefix: verified('npm:', SCHEMA, 'Exclusions and allowScripts entries name npm packages as npm:<name>.'),
    allowAllScripts: user.verified(
      { setting: 'allowScripts', since: '2.6.0', value: true },
      SCHEMA,
      'allowScripts: true allows every npm lifecycle script. Only the JSON value true does: to_allow_scripts_config (libs/config/deno_json/mod.rs at v2.9.8) gives every package for true, none for false and null, and stops with "expected string array, boolean, or object" for a string or a number, so "true" or 1 cannot turn it on silently.',
    ),
    latestVersion: verified('2.9.8', release('2.9.8')),
    npmrcFormat: disputed(
      'The safe choice is an integer number of days, which also matches npm.',
      evidence('whole days only, e.g. min-release-age=3', SUPPLY_CHAIN),
      evidence('a duration with a unit, e.g. min-release-age=72h', 'https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default'),
    ),
    fileLinkSkipped: disputed(
      'Official pages disagree on whether the project\'s own file: and link: dependencies are skipped, or only those in published packages\' metadata.',
      evidence('file: and link: dependencies in the project package.json are silently skipped', NOT_SUPPORTED),
      evidence(
        'file: and link: specifiers in registry metadata of npm packages are skipped',
        'https://deno.com/blog/v2.8#file-and-link-dependencies-in-npm-packages',
      ),
    ),
    denoXCooldown: verified('deno x honors minimumDependencyAge only since 2.9.4', release('2.9.4')),
    installOverrides: leftovers.verified(
      {
        options: [
          { name: '--minimum-dependency-age', weakens: 'delay', values: 'delay' },
          { name: '--min-dep-age', weakens: 'delay', values: 'delay' },
          { name: '--allow-scripts', weakens: 'scripts', values: 'any' },
        ],
        variables: [],
      },
      'https://github.com/denoland/docs/blob/main/runtime/packages/supply_chain.md',
      'deno install --minimum-dependency-age=P3D: deno.json and the flag accept an ISO-8601 duration such as P3D or PT72H, or an integer of minutes, and 0 turns it off; --min-dep-age is its alias (cooldown.cliFlag). deno install --allow-scripts=<packages> lets those packages run their lifecycle scripts, which Deno does not run by default (runtime/reference/cli/install.md in denoland/docs).',
    ),
    dxRunsScripts: verified('dx defaults to --allow-all and runs lifecycle scripts once the download prompt is accepted', 'https://deno.com/blog/v2.6'),
  },
};
