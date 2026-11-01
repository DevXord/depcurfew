import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');
const reviewed = verifiedOn('2026-10-30');
const rechecked = verifiedOn('2026-10-31');
const runtimes = verifiedOn('2026-11-01');
const finalReview = verifiedOn('2026-11-01');

const CONFIG = 'https://docs.npmjs.com/cli/v12/using-npm/config';
const CONFIG_V11 = 'https://docs.npmjs.com/cli/v11/using-npm/config';
const NPMRC = 'https://docs.npmjs.com/cli/v12/configuring-npm/npmrc';
const release = (version: string) => `https://github.com/npm/cli/releases/tag/v${version}`;
const INSTALL_TIME_CONTROLS = 'https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/';

const SOURCE_FLAGS_SINCE_NOTE =
  'The 11.14.0 release notes add the flag; the GitHub changelog dates it to 11.15.0, which also moved enforcement into the resolver. Treat 11.15.0 as the safe minimum.';

const VALUES_NOTE = 'The 2026-05-22 GitHub changelog mentions only all and none; the config reference also lists root.';

const sourceFlagSince = () =>
  disputed<string | null>(
    SOURCE_FLAGS_SINCE_NOTE,
    evidence('11.14.0', release('11.14.0')),
    evidence('11.15.0', INSTALL_TIME_CONTROLS),
  );

const LOCKFILE_V12 = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md';
const PACKAGE_JSON = 'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md';
const NPM_DEFINITIONS = 'https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/definitions.js';
const CMD_LIST = 'https://github.com/npm/cli/blob/v12.2.1/lib/utils/cmd-list.js';
const INSTALL_ALIASES = ['install', 'add', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'install-test', 'it'];
const NPM_DEFINITIONS_V11_16 = 'https://github.com/npm/cli/blob/v11.16.0/workspaces/config/lib/definitions/definitions.js';
const NPM_GITHUB_V12 = 'https://github.com/npm/cli/blob/v12.2.1';
const NPM_CONFIG_LIB = `${NPM_GITHUB_V12}/workspaces/config/lib`;
const user = verifiedOn('2026-10-31');
const NPM_SHORTHANDS = 'https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/index.js';

export const npm: ToolKnowledge = {
  id: 'npm',
  name: 'npm',
  kind: 'package-manager',
  cooldown: {
    setting: verified('min-release-age', `${CONFIG}#min-release-age`),
    configFiles: verified(
      ['.npmrc'],
      NPMRC,
      'Any npm config layer works: project .npmrc (read only at the project root and not for global installs), ~/.npmrc, the global npmrc, npm_config_min_release_age or the CLI. package.json cannot set it.',
    ),
    cliFlag: verified('--min-release-age=<days>', 'https://docs.npmjs.com/cli/v12/commands/npm-install#min-release-age'),
    unit: verified(
      'days',
      `${CONFIG}#min-release-age`,
      'Type is null or Number; 0 turns the delay off. Fractional days are not documented.',
    ),
    availableSince: verified('11.10.0', release('11.10.0')),
    default: verified([{ since: '11.10.0', value: null }], `${CONFIG}#min-release-age`, 'Unchanged in npm 12.'),
    exclude: {
      setting: verified('min-release-age-exclude', `${CONFIG}#min-release-age-exclude`),
      availableSince: verified('11.17.0', release('11.17.0')),
      patternSyntax: verified(
        'Package names or minimatch globs matched against the name, e.g. @myorg/*; only the named package is exempt, not its dependencies; also exempts from before',
        `${CONFIG}#min-release-age-exclude`,
      ),
    },
    securityUpdates: verified(
      'applies',
      `${CONFIG}#min-release-age`,
      'npm audit fix keeps the vulnerable version, warns that the fix was blocked (since 11.18.0) and exits non-zero. Add the package to min-release-age-exclude or relax the delay.',
    ),
  },
  installScripts: {
    defaultPolicy: checked.verified(
      [
        { since: '0.0.0', value: 'run' },
        { since: '11.16.0', value: 'run-with-warning' },
        { since: '12.0.0', value: 'deny-except-allowlist' },
      ],
      NPM_DEFINITIONS_V11_16,
      'strict-allow-scripts (default false) turns a dependency script that allowScripts does not cover "from a warning into a hard error ... instead of running with a notice", so from 11.16.0 such scripts still run. npm 11.21.1 ran esbuild\'s postinstall on 2026-10-29 ("has install scripts not yet covered by allowScripts"); npm 12.2.1 blocked it ("had install scripts blocked"). The v11 install-scripts command page says scripts are blocked by default, which the config definition, the 11.16.0 pull request, the GitHub changelog and the test contradict. npm 12 also blocks implicit node-gyp builds and prepare scripts of git, file and link dependencies.',
    ),
    allowList: {
      setting: verified('allowScripts', 'https://docs.npmjs.com/cli/v12/commands/npm-install-scripts'),
      file: verified(
        'package.json',
        'https://docs.npmjs.com/cli/v12/commands/npm-install-scripts',
        'Only the root package.json counts; allowScripts in dependencies is ignored. npx, npm exec and global installs use the allow-scripts config instead.',
      ),
      availableSince: verified('11.16.0', release('11.16.0')),
      format: uncertain(
        'Object keyed by name, name@version or name@v1 || v2 with true (allow) or false (deny); npm install-scripts approve writes pinned name@version entries',
        'https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md',
        'The exact entry grammar (no semver ranges) is stated in accepted RFC 0054; the shipped docs describe entries only in prose.',
      ),
    },
    disableAll: verified(
      'ignore-scripts',
      `${CONFIG}#ignore-scripts`,
      'Default false. Overrides allowScripts and dangerously-allow-all-scripts. npm run/test/start still run the named script, but not its pre/post scripts.',
    ),
  },
  sources: {
    git: {
      setting: verified('allow-git', `${CONFIG}#allow-git`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-git`, 'root allows only git dependencies listed in the project package.json.'),
      availableSince: disputed(
        'The release notes add --allow-git in 11.9.0; the GitHub changelog says it was introduced in 11.10.0.',
        evidence('11.9.0', release('11.9.0')),
        evidence('11.10.0', INSTALL_TIME_CONTROLS),
      ),
      default: verified(
        [
          { since: '11.9.0', value: 'all' },
          { since: '12.0.0', value: 'none' },
        ],
        `${CONFIG}#allow-git`,
      ),
    },
    remoteTarball: {
      setting: verified('allow-remote', `${CONFIG}#allow-remote`),
      values: verified(
        ['all', 'none', 'root'],
        `${CONFIG}#allow-remote`,
        `Tarballs on the configured registry hostname are always allowed. ${VALUES_NOTE}`,
      ),
      availableSince: sourceFlagSince(),
      default: verified(
        [
          { since: '11.14.0', value: 'all' },
          { since: '12.0.0', value: 'none' },
        ],
        release('12.0.0'),
      ),
    },
    file: {
      setting: verified('allow-file', `${CONFIG}#allow-file`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-file`, VALUES_NOTE),
      availableSince: sourceFlagSince(),
      default: verified(
        [{ since: '11.14.0', value: 'all' }],
        'https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/',
        'npm 12 did not change the default.',
      ),
    },
    directory: {
      setting: verified('allow-directory', `${CONFIG}#allow-directory`),
      values: verified(['all', 'none', 'root'], `${CONFIG}#allow-directory`, VALUES_NOTE),
      availableSince: sourceFlagSince(),
      default: verified([{ since: '11.14.0', value: 'all' }], `${CONFIG}#allow-directory`, 'npm 12 did not change the default.'),
    },
  },
  project: {
    lockfiles: verified(
      [
        { since: '0.0.0', value: ['npm-shrinkwrap.json', 'package-lock.json'] },
        { since: '12.0.0', value: ['package-lock.json'] },
      ],
      LOCKFILE_V12,
      'npm 11 and earlier prefer npm-shrinkwrap.json over package-lock.json when both exist; npm 12 no longer reads or writes npm-shrinkwrap.json (same format, rename it).',
    ),
    manifests: verified(['package.json'], PACKAGE_JSON),
    workspaces: verified({ files: ['package.json'], key: 'workspaces' }, `${PACKAGE_JSON}#workspaces`, 'An array of folder paths or globs.'),
    workspacesObjectKey: uncertain(
      'packages',
      'https://github.com/npm/map-workspaces/blob/main/lib/index.js',
      'Not documented; npm\'s map-workspaces also accepts { "packages": [...] } and negated patterns.',
    ),
  },
  user: {
    files: user.verified(
      [
        {
          since: '0.0.0',
          value: {
            format: 'ini',
            locations: [
              // npm resolves ~ against HOME, else os.homedir() (USERPROFILE on Windows), so HOME wins on Windows too.
              { platforms: ['linux', 'darwin'], directories: [{ from: 'home', path: '' }], file: '.npmrc' },
              { platforms: ['win32'], directories: [{ from: { env: 'HOME', absolute: true }, path: '' }, { from: 'home', path: '' }], file: '.npmrc' },
            ],
            sections: [''],
          },
        },
      ],
      `${NPM_CONFIG_LIB}/index.js`,
      'userconfig defaults to ~/.npmrc ("The location of user-level configuration settings. This may be overridden by the npm_config_userconfig environment variable or the --userconfig command line option"); ~ is resolved against `this.env.HOME || homedir()`. Same in 11.21.1. The project .npmrc is loaded first and may set userconfig= itself. Only the keys above the first [section] header are settings (extra.npmrcFormat).',
    ),
    settings: user.verified(
      [
        { purpose: 'cooldown', key: 'min-release-age', since: '11.10.0' },
        { purpose: 'cooldownExclude', key: 'min-release-age-exclude', since: '11.17.0' },
        { purpose: 'scriptsStrict', key: 'strict-allow-scripts', since: '11.16.0' },
        { purpose: 'scriptsAllow', key: 'allow-scripts', since: '11.16.0' },
        { purpose: 'sourceGit', key: 'allow-git', since: '11.10.0' },
        { purpose: 'sourceRemote', key: 'allow-remote', since: '11.15.0' },
        { purpose: 'sourceFile', key: 'allow-file', since: '11.15.0' },
        { purpose: 'sourceDirectory', key: 'allow-directory', since: '11.15.0' },
      ],
      `${NPM_CONFIG_LIB}/definitions/definition.js`,
      'Every config definition is read from any config file; only prefix is refused in a project .npmrc. allowScripts in package.json is project-only: at user level the allow-list is the allow-scripts key (allow only, every name becomes true; resolve-allow-scripts.js), used where the root package.json has no allowScripts and for npx, npm exec and npm install -g. The source keys use the later of the disputed first versions.',
    ),
    unknownKeys: user.verified('warn', `${NPM_GITHUB_V12}/lib/base-cmd.js`, 'Unknown .npmrc (file) configs warn by default, matching pre-npm-12 behavior, but error when strict-npmrc is set.'),
    invalidValueFails: user.verified(false, `${NPM_CONFIG_LIB}/index.js`, 'A value of the wrong type is reported as invalid config and the default is used.'),
    weakening: user.verified(
      [
        { key: 'dangerously-allow-all-scripts', values: { except: ['false', 'null', 'undefined'] }, effect: 'runs every dependency install script, also those a package.json denies' },
        { key: 'allow-scripts', values: 'any', effect: 'approves the install scripts of these packages in every project without its own allowScripts, and in npx and global installs' },
        { key: 'min-release-age', values: [0], effect: 'turns the release-age delay off' },
        { key: 'min-release-age-exclude', values: 'any', effect: 'exempts these packages from the release-age delay in every project without its own list' },
        { key: 'before', values: 'any', effect: 'takes the place of min-release-age in the same file' },
        { key: 'allow-git', values: ['all', 'root'], effect: 'allows git dependencies' },
        { key: 'allow-remote', values: ['all', 'root'], effect: 'allows remote tarball dependencies' },
      ],
      `${NPM_CONFIG_LIB}/definitions/definitions.js`,
      'A key in the project .npmrc replaces the user value, lists included (prototype chain, no merging); the CLI and npm_config_* variables beat both. dangerously-allow-all-scripts is on for every value but false, null and undefined: npm reads .npmrc values and npm_config_* variables with parseField (https://github.com/npm/cli/blob/v11.21.1/workspaces/config/lib/parse-field.js), which trims them, turns an empty value of a Boolean setting into true and only "true", "false", "null" and "undefined" into their values, and leaves 0, 1, yes or no as strings; load() does not run the nopt type check (validate() runs only in npm config), and arborist tests the flat option for truth (!this.options.dangerouslyAllowAllScripts in workspaces/arborist/lib/arborist/rebuild.js at 11.21.1).',
    ),
    variables: user.verified(
      [
        { name: 'npm_config_userconfig', anyCase: true, values: 'any', effect: 'makes npm read another user file', defaultPath: '.npmrc' },
        { name: 'npm_config_min_release_age', anyCase: true, values: 'any', effect: 'overrides min-release-age in every .npmrc' },
        { name: 'npm_config_dangerously_allow_all_scripts', anyCase: true, values: { except: ['false', 'null', 'undefined'] }, effect: 'runs every dependency install script' },
        { name: 'npm_config_before', anyCase: true, values: 'any', effect: 'takes the place of min-release-age' },
      ],
      `${NPM_GITHUB_V12}/docs/lib/content/using-npm/config.md`,
      'Environment variables starting with npm_config_ are interpreted as configuration parameters; config values are case-insensitive, so NPM_CONFIG_FOO=bar works the same. loadEnv in workspaces/config/lib/index.js (11.21.1 and 12.2.1) skips variables whose value is empty and reads them in the order of the environment, so of two spellings the later one wins. userconfig defaults to ~/.npmrc (definitions.js), and npm exports the resolved path as npm_config_userconfig to every command it runs (see extra.childEnvironment), so that value names the default file.',
    ),
  },
  extra: {
    localPrefix: runtimes.verified(
      { markers: { file: 'package.json', directory: 'node_modules' }, workspaceRoot: true, workspacesField: 'workspaces', workspacesObjectKey: 'packages', prefixOption: '--prefix', projectFile: '.npmrc' },
      `${NPM_CONFIG_LIB}/index.js`,
      'loadLocalPrefix: --prefix on the command line is the local prefix. Otherwise npm walks up from the current directory (walk-up-path yields the directory and each parent up to the root, with no other stop; "for (const p of walkUp(this.cwd))") and takes the first directory with a package.json file or a node_modules directory ("hasPackageJson || await dirExists(p, \'node_modules\')"). Unless workspaces are turned off or npm runs in global mode it walks on: a higher directory with a package.json whose workspaces include that directory becomes the prefix, and a .npmrc of the workspace is skipped ("ignoring workspace config at ${this.localPrefix}/.npmrc"). Without a match the prefix is the current directory ("this.localPrefix = this.cwd"). loadProjectConfig reads "resolve(this.localPrefix, \'.npmrc\')" as the project configuration, except in global mode and when that path is the userconfig file. Workspaces (@npmcli/map-workspaces, lib/index.js on main): an array of patterns or an object with a packages array, patterns starting with ! exclude, the globs match directories (whose package.json is then read) and skip node_modules. No .git or home directory stops the walk.',
    ),
    childEnvironment: user.verified(
      { marker: 'npm_execpath', prefix: 'npm_config_' },
      'https://github.com/npm/cli/blob/v11.21.1/workspaces/config/lib/set-envs.js',
      'setEnvs gives the scripts and commands npm runs (npm run, npx, npm exec) every setting that is not its default as npm_config_<key> in lower case with - as _, whichever file or flag set it, unless the definition has envExport: false (allow-scripts, min-release-age and min-release-age-exclude in 11.21.1 and 12.2.1); keys npm does not know, such as pnpm keys in .npmrc, are exported too. userconfig is always exported, because its default is the literal ~/.npmrc and the value the resolved path. It also sets npm_execpath to the npm it runs. The same in 10.9.4 and 12.2.1 (12.x and 11.x also export npm_config_node_gyp and npm_config_npm_version).',
    ),
    denyList: user.verified(
      { file: 'package.json', setting: 'allowScripts', value: false, since: '11.16.0' },
      'https://github.com/npm/cli/blob/v12.2.1/workspaces/arborist/lib/unreviewed-scripts.js',
      'A false entry in the root package.json allowScripts is an explicit denial: deny wins over allow, and denied packages are skipped silently, also under strict-allow-scripts ("const verdict = isScriptAllowed(node, policy); if (verdict === true || verdict === false) { continue }", the same in 11.16.0 check-allow-scripts.js). npm install-scripts deny writes a name-only false entry.',
    ),
    trustedPublishing: checked.verified(
      { minimumNpm: '11.5.1', minimumNode: '22.14.0', githubPermission: 'id-token: write', automaticProvenance: true, firstPublishWithinDays: 2 },
      'https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/packages-and-modules/securing-your-code/trusted-publishers.mdx',
      'Publishing from GitHub-hosted runners with OIDC instead of a token. Provenance is generated automatically, only for a public package from a public repository. A new trusted publisher configuration expires unless its first publish succeeds within 2 days. It can be limited to npm stage publish (the default for configurations created after 2026-09-03).',
    ),
    stagedPublishing: checked.verified(
      { minimumNpm: '11.15.0', minimumNode: '22.14.0', stage: 'npm stage publish', approve: 'npm stage approve', reject: 'npm stage reject', newPackagePlaceholder: '0.0.0-stage' },
      'https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/cli/v12/commands/npm-stage.mdx',
      'Staging needs no 2FA, so CI can do it; approving or rejecting needs 2FA (CLI or npmjs.com). Staging a package that does not exist yet creates it with the public placeholder version 0.0.0-stage. Pre-release versions need an explicit --tag. --provenance also applies to npm stage publish. Rejecting the only staged version of such a new package also unpublished the placeholder (observed 2026-10-29 with npm 11.21.1), and after a whole package is unpublished its name is blocked for 24 hours (https://github.com/npm/documentation/blob/main/content/policies/unpublish.mdx).',
    ),
    trustCommand: checked.verified(
      { command: 'npm trust github', minimumNpm: '11.15.0', packageMustExist: true, permissions: ['--allow-publish', '--allow-stage-publish'] },
      'https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/cli/v12/commands/npm-trust.mdx',
      'Configures a trusted publisher from the CLI; needs 2FA on the account and write access, and the package must already exist. At least one permission flag is required.',
    ),
    lockfileFormat: checked.verified(
      {
        installScripts: 'hasInstallScript',
        gitPrefixes: ['git+', 'git:'],
        filePrefix: 'file:',
        linkFlag: 'link',
        registryTarball: '^https?://[^/]+/.+/-/[^/]+-\\d',
        specWithoutResolved: 'version',
        dependencyFields: ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'],
      },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md',
      'Entries under packages: resolved is the registry tarball URL, the git URL with its commit (git+ssh://… or git+https://…#sha), file:<path> for local tarballs and directories, or the link target when link is true. hasInstallScript marks a preinstall, install or postinstall script (prepare scripts of non-registry sources are not flagged). npm tells registry tarballs from other URLs with the registryTarball pattern (workspaces/arborist/lib/install-scripts.js), so a tarball URL on a registry host looks like a registry package. An entry without resolved is installed as <name>@<version> (workspaces/arborist/lib/arborist/reify.js, #extractOrLink, in 11.19.1 and 12.2.1), so its version field is the source then. Entries keep the dependency fields of their package.json: dependencies, optionalDependencies and peerDependencies for every package, devDependencies for the root (workspaces/arborist/lib/shrinkwrap.js, pkgMetaKeys and the isTop branch, in 11.21.1 and 12.2.1); a dependency declared there as a URL comes from that URL even when it is a registry tarball.',
    ),
    overrides: checked.verified(
      { field: 'overrides', selfKey: '.' },
      'https://github.com/npm/cli/blob/v11.21.1/docs/lib/content/configuring-npm/package-json.md#overrides',
      'Only the root package.json counts. Keys are package names, optionally with a version or range (name@range), and nest to any depth to scope an override under a parent; "." inside a nested object overrides the parent package itself; values take any dependency specifier, including tarball URLs, and $name refers to the spec of a direct dependency. Overrides are not written to package-lock.json (checked with npm 11.21.1), so a URL override of a registry tarball looks like a registry package there. With replace-registry-host at its default npmjs, npm writes the configured registry in place of registry.npmjs.org in resolved URLs (workspaces/config/lib/definitions/definitions.js).',
    ),
    npmrcScope: checked.verified(
      { read: 'project root', workspacePackages: 'ignored', globalMode: 'ignored' },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md',
      'Only the .npmrc at the root of the project npm runs in is read. Inside a workspace package npm moves the prefix to the workspace root (using-npm/workspaces.md) and warns "ignoring workspace config" for the package .npmrc (workspaces/config/lib/index.js). The project .npmrc "is not read in global mode, such as when running npm install -g" (same page, v11.21.1 and v12.2.1).',
    ),
    npmrcFormat: reviewed.verified(
      { commentLines: ['#', ';'], inlineComments: ['#', ';'], escape: '\\', sectionHeader: '^\\[([^\\]]*)\\]\\s*$', keyWithoutValue: 'true', settingsFrom: 'top level' },
      'https://github.com/npm/ini/blob/v7.0.0/lib/ini.js',
      'npm reads .npmrc with the ini package: 7.0.0 in npm 12.2.1, and 6.0.0, whose lib/ini.js is the same, in npm 11.10.0 to 11.21.1 (package-lock.json of npm/cli). A line whose first non-blank character is # or ; is a comment. An unquoted key or value ends at the first # or ; that is not escaped with a backslash, so ignore-scripts=true # note sets true; a value in double quotes is parsed as a JSON string and one in single quotes loses its quotes, both keeping # and ;. A line without = sets the key to true. A [name] header at the start of a line, with nothing but spaces after it, starts a section: the keys below it belong to that section until the next header. npm applies only the top-level keys as settings (#loadObject in workspaces/config/lib/index.js at v12.2.1), so a key below a header has no effect.',
    ),
    npmrcListSyntax: verified(
      '[]',
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md',
      'Array values are written by adding [] after the key, one line per value, e.g. min-release-age-exclude[]=@myorg/*.',
    ),
    allowAllScripts: verified(
      { setting: 'dangerously-allow-all-scripts', since: '11.16.0', value: true },
      NPM_DEFINITIONS,
      'Boolean, default false: runs every dependency install script whether or not allowScripts approves it; --ignore-scripts still wins. First present in the 11.16.0 definitions.',
    ),
    excludeWildcards: verified(
      { since: '11.17.0', trailingOnly: false },
      NPM_DEFINITIONS,
      'min-release-age-exclude takes package names or minimatch globs from its first version.',
    ),
    latestVersion: verified(
      '12.2.1',
      release('12.2.1'),
      'Marked as the latest GitHub release on 2026-10-28; the 11.x line is still maintained (11.21.1).',
    ),
    beforeInteraction: reviewed.verified(
      { setting: 'before', exclusive: { since: '11.10.0', until: '11.15.0' }, beforeWinsSince: '11.15.0' },
      'https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/definitions.js',
      'before is a date: npm installs only versions available on or before it. In 11.10.0 to 11.14.x the definitions of min-release-age and before name each other as exclusive, and npm stops with "--min-release-age cannot be provided when using --before" (or the reverse) once both are set in its config sources (#loadObject in workspaces/config/lib/index.js and definitions.js at v11.14.1). Since 11.15.0 both may be set: "If before and min-release-age are both set in the same source, before wins"; across sources the usual precedence applies (cli > env > project > user > global), so a before in the project .npmrc replaces its own min-release-age (definitions.js at v11.15.0 and v12.2.1; release notes of 11.15.0).',
    ),
    strictAllowScripts: checked.verified(
      { setting: 'strict-allow-scripts', value: true, since: '11.16.0' },
      NPM_DEFINITIONS_V11_16,
      'strict-allow-scripts=true makes the install fail on a dependency with install scripts that allowScripts does not cover, instead of running them with a notice (default false). Entries denied with false are skipped silently; --ignore-scripts and --dangerously-allow-all-scripts override it.',
    ),
    strictAllowScriptsEffect: runtimes.verified(
      [
        { since: '11.16.0', value: 'the install fails instead of running the script with a notice' },
        { since: '12.0.0', value: 'the install fails instead of blocking the script with a warning' },
      ],
      NPM_DEFINITIONS,
      'npm 12.2.1 still defines strict-allow-scripts (default false): "If true, turn the install-script policy from a warning into a hard error: any dependency with install scripts that is not covered by allowScripts will fail the install instead of being blocked with a warning." Dependencies denied with false are still skipped silently; --ignore-scripts and --dangerously-allow-all-scripts override it. So the same .npmrc line keeps npm 11.16 to 11.x from running such scripts and makes npm 12 stop the install at them. The 11.16.0 effect is the one in strictAllowScripts (definitions.js at v11.16.0).',
    ),
    unknownNpmrcKeys: rechecked.verified(
      'unknown keys in .npmrc files only warn unless strict-npmrc is set; unknown command-line flags throw since npm 12',
      `${NPM_GITHUB_V12}/CHANGELOG.md`,
      'Matters for generated .npmrc files: keys npm does not know (e.g. pnpm-only keys) print a warning on every npm command. The 12.0.0 entry: unknown CLI flags "now throw instead of warning. (Unknown .npmrc configs still warn by default; opt into erroring with the new strict-npmrc config.)"; lib/base-cmd.js at 12.2.1 does the same.',
    ),
    commandLine: checked.verified(
      {
        add: INSTALL_ALIASES.map((alias) => ['npm', alias]),
        run: [
          { command: ['npx'], packageOptions: ['--package', '-p'], lineOptions: ['--call', '-c'] },
          { command: ['npm', 'exec'], packageOptions: ['--package'], lineOptions: ['--call', '-c'] },
          { command: ['npm', 'x'], packageOptions: ['--package'], lineOptions: ['--call', '-c'] },
        ],
        create: [
          { command: ['npm', 'init'], packageOptions: [] },
          { command: ['npm', 'create'], packageOptions: [] },
          { command: ['npm', 'innit'], packageOptions: [] },
        ],
        createNames: 'prefix',
        valueOptions: [],
      },
      CMD_LIST,
      'Aliases of install (add, i and the typo aliases in, ins, inst, insta, instal, isnt, isnta, isntal, isntall), install-test (it), exec (x) and init (create, innit), the same in 11.19.1. install-test takes the same arguments as install (docs/lib/content/commands/npm-install-test.md). npm exec and npx take the packages to download from --package; -p means --package only in npx (in npm it is --parseable); without --package the first positional argument names the package, and -c/--call takes a command string that runs with the packages, shell operators included (npm-exec.md). npm init <initializer> runs npm exec create-<initializer>: foo → create-foo, @usr → @usr/create, @usr/foo@2.0.0 → @usr/create-foo@2.0.0 (npm-init.md).',
    ),
    valueOptions: checked.verified(
      [
        '--access', '--allow-directory', '--allow-file', '--allow-git', '--allow-remote', '--allow-scripts',
        '--also', '--audit-level', '--auth-type', '--before', '--ca', '--cache', '--cache-max', '--cache-min',
        '--cafile', '--call', '--cert', '--cidr', '--cpu', '--depth', '--diff', '--diff-dst-prefix',
        '--diff-src-prefix', '--diff-unified', '--edit-dir', '--editor', '--expect-result-count', '--expires',
        '--extension-file', '--fetch-retries', '--fetch-retry-factor', '--fetch-retry-maxtimeout',
        '--fetch-retry-mintimeout', '--fetch-timeout', '--git', '--global-ignore-file', '--globalconfig',
        '--heading', '--https-proxy', '--include', '--init-author-email', '--init-author-name', '--init-author-url',
        '--init-license', '--init-module', '--init-type', '--init-version', '--install-strategy', '--key', '--libc',
        '--local-address', '--location', '--lockfile-version', '--loglevel', '--logs-dir', '--logs-max',
        '--maxsockets', '--message', '--min-release-age', '--min-release-age-exclude', '--name', '--node-gyp',
        '--node-options', '--noproxy', '--omit', '--only', '--orgs', '--orgs-permission', '--os', '--otp',
        '--pack-destination', '--package', '--packages', '--packages-and-scopes-permission', '--password',
        '--patches-dir', '--prefix', '--preid', '--provenance-file', '--proxy', '--registry',
        '--replace-registry-host', '--save-prefix', '--sbom-format', '--sbom-type', '--scope', '--scopes',
        '--script-shell', '--searchexclude', '--searchlimit', '--searchopts', '--searchstaleness', '--shell',
        '--tag', '--tag-version-prefix', '--to', '--token-description', '--umask', '--user-agent', '--userconfig',
        '--viewer', '--which', '--workspace', '-C', '-L', '-c', '-m', '-w',
      ],
      NPM_DEFINITIONS,
      'npm options that always take a value: every definition whose type does not include Boolean, as --name, and the short forms -C (prefix), -L (location), -c (call), -m (message) and -w (workspace). Options whose type includes Boolean (such as color and browser) may stand alone, so they are taken for flags.',
    ),
    flagOptions: reviewed.verified(
      [
        '--all', '--allow-same-version', '--allow-scripts-pending', '--allow-scripts-pin', '--allow-unused-patches',
        '--audit', '--bin-links', '--browser', '--bypass-2fa', '--color', '--commit-hooks',
        '--dangerously-allow-all-scripts', '--description', '--dev', '--diff-ignore-all-space', '--diff-name-only',
        '--diff-no-prefix', '--diff-text', '--dry-run', '--engine-strict', '--expect-results', '--force',
        '--foreground-scripts', '--format-package-lock', '--fund', '--git-tag-version', '--global', '--global-style',
        '--if-present', '--ignore-existing', '--ignore-extension', '--ignore-patch-failures', '--ignore-scripts',
        '--include-attestations', '--include-staged', '--include-workspace-root', '--init-private', '--install-links',
        '--json', '--keep-edit-dir', '--legacy-bundling', '--legacy-peer-deps', '--link', '--long', '--offline',
        '--omit-lockfile-registry-resolved', '--optional', '--package-lock', '--package-lock-only', '--packages-all',
        '--parseable', '--prefer-dedupe', '--prefer-offline', '--prefer-online', '--production', '--progress',
        '--provenance', '--read-only', '--rebuild-bundle', '--save', '--save-bundle', '--save-dev', '--save-exact',
        '--save-optional', '--save-peer', '--save-prod', '--shrinkwrap', '--sign-git-commit', '--sign-git-tag',
        '--strict-allow-scripts', '--strict-npmrc', '--strict-peer-deps', '--strict-ssl', '--timing', '--unicode',
        '--update-notifier', '--usage', '--version', '--versions', '--workspaces', '--workspaces-update', '--yes',
      ],
      NPM_DEFINITIONS,
      'npm options whose type includes Boolean, which may stand alone: the definitions of 12.2.1 and of 11.21.1 (where shrinkwrap is one too; 12.2.1 adds ignore-existing, ignore-extension, ignore-patch-failures, allow-unused-patches, keep-edit-dir and strict-npmrc). With valueOptions they are every npm option, so an abbreviated option can be resolved as npm resolves it.',
    ),
    parsing: reviewed.verified(
      {
        abbreviations: true,
        anyDashes: true,
        negation: '--no-',
        shorthands: {
          'enjoy-by': ['--before'], d: ['--loglevel', 'info'], dd: ['--loglevel', 'verbose'], ddd: ['--loglevel', 'silly'],
          quiet: ['--loglevel', 'warn'], q: ['--loglevel', 'warn'], s: ['--loglevel', 'silent'], silent: ['--loglevel', 'silent'],
          verbose: ['--loglevel', 'verbose'], desc: ['--description'], help: ['--usage'], local: ['--no-global'], n: ['--no-yes'],
          no: ['--no-yes'], porcelain: ['--parseable'], readonly: ['--read-only'], reg: ['--registry'],
          iwr: ['--include-workspace-root'], ws: ['--workspaces'], a: ['--all'], c: ['--call'], f: ['--force'], g: ['--global'],
          L: ['--location'], l: ['--long'], m: ['--message'], p: ['--parseable'], C: ['--prefix'], S: ['--save'],
          B: ['--save-bundle'], D: ['--save-dev'], E: ['--save-exact'], O: ['--save-optional'], P: ['--save-prod'],
          '?': ['--usage'], H: ['--usage'], h: ['--usage'], v: ['--version'], w: ['--workspace'], y: ['--yes'],
        },
      },
      NPM_SHORTHANDS,
      'The shorthands npm passes to nopt: the list in definitions/index.js and the short names of the definitions (the same in 11.21.1). nopt (node_modules/nopt/lib/nopt-lib.js, versions 8.1.0 in npm 10.9.4, 9.0.0 in 11.21.1 and 10.0.1 in 12.2.1, same parse and resolveShort) strips every leading dash, so -reg, --reg and -registry work; takes an exact option first, then an exact shorthand, then a word of one-letter shorthands (-gD), then an unambiguous prefix of an option name (abbrev), then a prefix of a shorthand; and reads --no-<name> as a negated flag that takes no value. npm 10 expands abbreviations silently, npm 11 warns "Expanding --regis to --registry. This will stop working in the next major version of npm." and npm 12 refuses them with EUNKNOWNCONFIG (abbrevHandler in workspaces/config/lib/index.js of 11.21.1 and 12.2.1). Shorthands are expanded only on the command line, not in .npmrc or npm_config_ variables. npx turns -p into --package and expands exact shorthands itself before npm exec reads the rest (bin/npx-cli.js).',
    ),
    versionSelection: reviewed.verified(
      { tagOption: '--tag', tagVariable: 'npm_config_tag', tagKey: 'tag', bareRange: '*' },
      NPM_DEFINITIONS,
      'tag (default latest): "If you ask npm to install a package and don\'t tell it a specific version, then it will install the specified tag"; like any setting it comes from --tag, npm_config_tag or .npmrc. A name without a version is name@* (npm-package-arg 14.0.0, lib/npa.js). npm-pick-manifest 12.0.0 (node_modules/npm-pick-manifest/lib/index.js) picks the version of that dist-tag when the range is * or the version satisfies the range, unless it is deprecated; otherwise the highest satisfying version, preferring versions that are not deprecated; prereleases match a range only when it names one, so name@* with latest on a prerelease installs that prerelease. npm exec and npm init pick with the same settings.',
    ),
    packageSpecs: checked.verified(
      {
        git: ['git://', 'git+ssh://', 'git+http://', 'git+https://', 'git+file://', 'github:', 'gist:', 'bitbucket:', 'gitlab:'],
        local: ['file:'],
        workspace: [],
        alias: 'npm:',
        remoteTarball: ['http://', 'https://'],
        tarballExtensions: ['.tar', '.tar.gz', '.tgz'],
        shorthand: 'github:',
      },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/commands/npm-install.md',
      'Forms of npm install <spec>: a folder; a tarball file, whose name must end in .tar, .tar.gz or .tgz; a tarball URL, which must start with http:// or https://; a git remote URL with the protocol git, git+ssh, git+http, git+https or git+file; <githubname>/<githubrepo> or github:<githubname>/<githubrepo>; gist:, bitbucket: and gitlab: shorthands; <alias>@npm:<name>. The file: prefix for local paths is documented in docs/lib/content/configuring-npm/package-json.md (Local Paths).',
    ),
    registryConfig: checked.verified(
      { file: '.npmrc', userFile: '~/.npmrc', key: 'registry', scopeKeySuffix: ':registry' },
      NPM_DEFINITIONS,
      'userconfig, the location of user-level settings, defaults to ~/.npmrc; registry is the base URL of the npm registry (default https://registry.npmjs.org/); a per-project .npmrc can set it like any config key (docs/lib/content/using-npm/config.md). npm config set @myco:registry=http://reg.example.com associates a scope with a registry, and any npm install of a package with that scope then requests it from there (https://docs.npmjs.com/cli/v12/using-npm/scope#associating-a-scope-with-a-registry).',
    ),
    registryOverrides: checked.verified(
      {
        registryOptions: ['--registry', '--@<scope>:registry'],
        registryVariables: ['npm_config_registry'],
        configOptions: ['--userconfig', '--globalconfig'],
        configVariables: ['npm_config_userconfig', 'npm_config_globalconfig'],
      },
      NPM_DEFINITIONS,
      'registry is a URL; userconfig and globalconfig are the user and global configuration files. Putting --foo bar on the command line sets the foo configuration parameter, and environment variables that start with npm_config_ are configuration parameters too, without regard to case (docs/lib/content/using-npm/config.md); @scope:registry is the key of a scope\'s registry (https://docs.npmjs.com/cli/v12/using-npm/scope).',
    ),
    configCommands: runtimes.verified(
      [
        { command: ['npm', 'config'], writes: ['set', 'delete', 'rm', 'del', 'edit', 'fix'] },
        { command: ['npm', 'set'], operands: 1 },
        { command: ['npm', 'pkg'], writes: ['set', 'delete', 'fix'], manifest: true },
      ],
      'https://github.com/npm/cli/blob/v12.2.1/lib/commands/config.js',
      'npm config set sets keys (in the user configuration unless location is given), delete (also rm and del) removes keys from every configuration file, edit opens a configuration file in an editor and fix repairs invalid items; get and list (ls) only read (the switch in exec, and docs/lib/content/commands/npm-config.md). npm set <key>=<value> runs npm config set with its arguments and fails without any (lib/commands/set.js); npm get only reads (lib/commands/get.js). npm pkg set, delete and fix write package.json back, get only reads (lib/commands/pkg.js). Other spellings of these commands come from commandNames.',
    ),
    commandNames: runtimes.verified(
      {
        commands: [
          'access', 'approve-scripts', 'audit', 'bugs', 'cache', 'ci', 'completion', 'config', 'dedupe', 'deny-scripts',
          'deprecate', 'diff', 'dist-tag', 'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund',
          'get', 'help', 'help-search', 'init', 'install', 'install-ci-test', 'install-scripts', 'install-test', 'link', 'll',
          'login', 'logout', 'ls', 'org', 'outdated', 'owner', 'pack', 'patch', 'ping', 'pkg', 'prefix', 'profile', 'prune',
          'publish', 'query', 'rebuild', 'repo', 'restart', 'root', 'run', 'sbom', 'search', 'set', 'stage', 'start', 'stop',
          'team', 'test', 'token', 'trust', 'undeprecate', 'uninstall', 'unpublish', 'update', 'version', 'view', 'whoami'
        ],
        aliases: {
          author: 'owner', home: 'docs', issues: 'bugs', info: 'view', show: 'view', find: 'search', add: 'install',
          unlink: 'uninstall', remove: 'uninstall', rm: 'uninstall', r: 'uninstall', un: 'uninstall', rb: 'rebuild', list: 'ls',
          ln: 'link', create: 'init', i: 'install', it: 'install-test', cit: 'install-ci-test', u: 'update', up: 'update',
          c: 'config', s: 'search', se: 'search', tst: 'test', t: 'test', ddp: 'dedupe', v: 'view', 'run-script': 'run',
          'clean-install': 'ci', 'clean-install-test': 'install-ci-test', x: 'exec', why: 'explain', la: 'll',
          verison: 'version', ic: 'ci', innit: 'init', in: 'install', ins: 'install', inst: 'install', insta: 'install',
          instal: 'install', isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install', 'install-clean': 'ci',
          'isntall-clean': 'ci', hlep: 'help', 'dist-tags': 'dist-tag', upgrade: 'update', udpate: 'update', rum: 'run',
          sit: 'install-ci-test', urn: 'run', ogr: 'org'
        },
      },
      CMD_LIST,
      'deref resolves a command name: camelCase to kebab-case (installTest is install-test), an exact command, a direct alias, else a unique abbreviation of the commands and alias names (abbrev), whose aliases are followed to the command (npm install-cl is install-clean, then ci). So npm c, npm con, npm conf and npm confi are npm config, and npm pk is npm pkg.',
    ),
    installOverrides: runtimes.verified(
      {
        options: [
          { name: '--min-release-age', weakens: 'delay', values: 'delay' },
          { name: '--before', weakens: 'delay', values: 'any' },
          { name: '--min-release-age-exclude', weakens: 'delay', values: 'any' },
          { name: '--ignore-scripts', weakens: 'scripts', values: { except: ['true'] } },
          { name: '--dangerously-allow-all-scripts', weakens: 'scripts', values: { except: ['false', 'null', 'undefined'] } },
          { name: '--allow-scripts', weakens: 'scripts', values: 'any' },
        ],
        variables: [
          { name: 'npm_config_min_release_age', weakens: 'delay', values: 'delay' },
          { name: 'npm_config_before', weakens: 'delay', values: 'any' },
          { name: 'npm_config_min_release_age_exclude', weakens: 'delay', values: 'any' },
          { name: 'npm_config_ignore_scripts', weakens: 'scripts', values: { except: ['true', ''] } },
          { name: 'npm_config_dangerously_allow_all_scripts', weakens: 'scripts', values: { except: ['false', 'null', 'undefined'] } },
          { name: 'npm_config_allow_scripts', weakens: 'scripts', values: 'any' },
        ],
      },
      NPM_DEFINITIONS,
      'Settings that a single npm command can change on its command line or in its environment: "Putting --foo bar on the command line sets the foo configuration parameter", "--flag without specifying any value will set the value to true", "Any environment variables that start with npm_config_ will be interpreted as a configuration parameter", case-insensitive, and an environment configuration without a value is true (docs/lib/content/using-npm/config.md at v12.2.1). Types in definitions.js at v12.2.1: ignore-scripts Boolean, default false ("If true, npm does not run scripts specified in package.json files"); min-release-age null or Number of days; before null or Date; min-release-age-exclude a list exempt from min-release-age and before; dangerously-allow-all-scripts Boolean, which bypasses the allowScripts policy; allow-scripts a list of packages whose install scripts may run. A value other than true for ignore-scripts, any true value of dangerously-allow-all-scripts (the false values as in user.variables), any allow-scripts, before or min-release-age-exclude, and a min-release-age shorter than the policy weaken what depcurfew apply wrote.',
    ),
    booleanWords: runtimes.verified(
      true,
      'https://github.com/npm/nopt/blob/v10.0.1/lib/nopt-lib.js',
      'nopt, which parses the npm command line, also supports "--bool true or --bool false": a Boolean option followed by the word true or false takes it as its value and skips it, and a --no- prefix inverts the value (parse in lib/nopt-lib.js at v10.0.1, used by npm 12.2.1, and the same code at v9.0.0, used by npm 11.21.1).',
    ),
    installCommands: runtimes.verified(
      {
        install: INSTALL_ALIASES,
        clean: ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-ci-test', 'cit', 'clean-install-test', 'sit'],
        update: ['update', 'up', 'upgrade', 'udpate'],
      },
      CMD_LIST,
      'Commands that install packages into the project and their aliases: install (add, i, typo aliases, install-test and it), ci (clean-install, ic, install-clean, isntall-clean) with install-ci-test (cit, clean-install-test, sit), and update (up, upgrade, udpate; u only from npm 12, so left out). The same in v10.9.9 (lib/utils/cmd-list.js). npm also accepts unique abbreviations of command names, which are not listed.',
    ),
    globalOption: runtimes.verified(
      ['--global', '-g', '--location=global'],
      NPM_DEFINITIONS,
      'global (short g) "Operates in global mode, so that packages are installed into the prefix folder instead of the current working directory" and sets location to global; npm install -g npm@<version> replaces the npm that runs (docs/lib/content/commands/npm-install.md: "In global mode (ie, with -g or --global appended to the command)").',
    ),
    unknownConfigKeys: runtimes.verified(
      [
        { since: '0.0.0', value: 'ignored' },
        { since: '11.2.0', value: 'warning' },
      ],
      'https://github.com/npm/cli/blob/v10.9.9/workspaces/config/lib/index.js',
      'npm 10 loads every key of an .npmrc without checking whether it knows it (#loadObject only checks deprecated and exclusive keys), so a setting it does not have yet, such as min-release-age, is ignored without any message. checkUnknown first appears in v11.2.0 (workspaces/config/lib/index.js), which warns: Unknown project config "<key>". This will stop working in the next major version of npm. The 11.2.0 changelog does not name the change; the version comes from reading the code at the tags. npm 12 collects unknown keys to fail the command (v12.2.1), with the exact behavior not read.',
    ),
    lockfileInstalls: uncertain(
      'npm ci installs versions pinned in package-lock.json without applying min-release-age',
      'https://docs.npmjs.com/cli/v12/commands/npm-ci',
      'Inferred: npm ci does not list min-release-age or before among its options, and a user report (npm/cli#9277) describes it installing a version younger than the window.',
    ),
    cleanInstall: finalReview.verified(
      { commands: 'clean', installsLockedVersions: true, failsWhenOutOfSync: true, writesLockfile: false },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/commands/npm-ci.md',
      'npm ci (the clean commands of installCommands): "The project must have an existing package-lock.json"; "If dependencies in the package lock do not match those in package.json, npm ci will exit with an error, instead of updating the package lock"; "It will never write to package.json or package-lock.json: installs are essentially frozen." lib/commands/ci.js at v12.2.1 loads the lockfile (loadVirtual), builds the ideal tree, throws "`npm ci` can only install packages when your package.json and package-lock.json are in sync" when validateLockfile finds a difference, and reifies with packageLock: true and save: false. So npm ci installs exactly the versions package-lock.json records, and a release-age delay cannot change which versions it installs; the settings of its params (ignore-scripts, allow-scripts, strict-allow-scripts, allow-git, allow-remote, allow-file, allow-directory) still apply.',
    ),
    scriptsOff: finalReview.verified(
      { option: '--ignore-scripts', variable: 'npm_config_ignore_scripts', anyCase: true, value: 'true' },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/using-npm/config.md',
      'ignore-scripts (Boolean, default false; definitions.js at v12.2.1: "If true, npm does not run scripts specified in package.json files") is one of the params of npm ci and npm install (lib/commands/ci.js). On the command line --ignore-scripts sets it; "Any environment variables that start with npm_config_ will be interpreted as a configuration parameter", with underscores for dashes, and "Config values are case-insensitive, so NPM_CONFIG_FOO=bar will work the same". depcurfew counts only the value true (and the flag without a value) as off: parseField turns only "true" into true, and loadEnv skips empty values (user.variables).',
    ),
    nodeEngines: finalReview.verified(
      [
        { since: '11.0.0', node: '^20.17.0 || >=22.9.0' },
        { since: '12.0.0', node: '^22.22.2 || ^24.15.0 || >=26.0.0' },
      ],
      'https://github.com/npm/cli/blob/v11.19.1/package.json',
      'engines.node of npm/cli package.json, the same at the tags v11.0.0, v11.10.0, v11.16.0, v11.19.1 and v11.21.1 (^20.17.0 || >=22.9.0) and at v12.0.0 and v12.2.1 (^22.22.2 || ^24.15.0 || >=26.0.0, https://github.com/npm/cli/blob/v12.2.1/package.json). On a Node.js outside the range npm only warns that it does not support it: lib/cli/entry.js at v11.19.1 runs log.warn(\'cli\', validateEngines.unsupportedMessage) when !satisfies(node, engines), for a Node.js "still unsupported and untested and might not work reliably", and lib/cli/validate-engines.js prints "ERROR: npm ... is known not to run on Node.js ..." when it fails with a SyntaxError. So npm install -g npm@11 on Node.js 18 installs an npm that is not meant to run there.',
    ),
  },
};
