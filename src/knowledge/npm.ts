import { verifiedOn } from './define.ts';
import type {
  DirectoryOptionsKnowledge,
  EnvironmentNameRule,
  ExecReleaseAgeKnowledge,
  LocalBinariesKnowledge,
  NpmGlobalConfigKnowledge,
  NpmRegistryHostKnowledge,
  OmitOptionalKnowledge,
  RootLifecycleScriptsKnowledge,
  RunnerOptionsKnowledge,
  ToolKnowledge,
} from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
// Facts whose sources D-170 pinned to a release tag or commit, checked again on 2026-11-03.
const d170 = verifiedOn('2026-11-03');
const checked = verifiedOn('2026-10-29');
const reviewed = verifiedOn('2026-10-30');
const rechecked = verifiedOn('2026-10-31');
const runtimes = verifiedOn('2026-11-01');
const finalReview = verifiedOn('2026-11-01');
const release14 = verifiedOn('2026-11-02');
const runners = verifiedOn('2026-11-03');
const secrets = verifiedOn('2026-11-03');
// The npm that npm install -g npm@<range> installs (decision D-173).
const d173 = verifiedOn('2026-11-03');
const d172 = verifiedOn('2026-11-03');
// npx, npm exec and npm x (decisions D-184 and D-185), read in the published npm 11.21.1, 11.21.2 and 12.2.2.
const d184 = verifiedOn('2026-11-09');
const LIBNPMEXEC_V11 = 'https://github.com/npm/cli/blob/v11.21.1/workspaces/libnpmexec/lib';
const EXEC_COMMANDS = [['npx'], ['npm', 'exec'], ['npm', 'x']];

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
    workspacesObjectKey: d170.uncertain(
      'packages',
      'https://github.com/npm/map-workspaces/blob/v6.0.0/lib/index.js',
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
    environmentNames: release14.verified<EnvironmentNameRule[]>(
      [{ prefix: 'npm_config_', match: 'any-case' }],
      `${NPM_CONFIG_LIB}/index.js`,
      'loadEnv takes every variable whose name matches /^npm_config_/i, cuts the prefix and lowercases the rest (with _ as - but for a leading _), so NPM_CONFIG_REGISTRY and Npm_Config_Registry set registry as npm_config_registry does (decision D-143).',
    ),
    localPrefix: runtimes.verified(
      { markers: { file: 'package.json', directory: 'node_modules' }, workspaceRoot: true, workspacesField: 'workspaces', workspacesObjectKey: 'packages', prefixOption: '--prefix', workspacesOption: '--workspaces', projectFile: '.npmrc' },
      `${NPM_CONFIG_LIB}/index.js`,
      'loadLocalPrefix: --prefix on the command line is the local prefix. Otherwise npm walks up from the current directory (walk-up-path yields the directory and each parent up to the root, with no other stop; "for (const p of walkUp(this.cwd))") and takes the first directory with a package.json file or a node_modules directory ("hasPackageJson || await dirExists(p, \'node_modules\')"). Unless workspaces are set to false on the command line ("this.#get(\'workspaces\', \'cli\')", so --no-workspaces or --workspaces=false; .npmrc and npm_config_workspaces do not count) or npm runs in global mode, it walks on: each higher directory with a package.json is read with @npmcli/package-json normalize, and one that cannot be read or normalized (".catch(() => ({ content: {} }))") or has no workspaces is passed over; the first whose mapped workspaces include that directory ("w === this.localPrefix", the same path) becomes the prefix, and a .npmrc of the workspace is skipped ("ignoring workspace config at ${this.localPrefix}/.npmrc"). Without a match the prefix is the current directory ("this.localPrefix = this.cwd"). loadProjectConfig reads "resolve(this.localPrefix, \'.npmrc\')" as the project configuration, except in global mode and when that path is the userconfig file. Workspaces (@npmcli/map-workspaces 6.0.0, the version npm 12.2.1 locks, with glob 13.0.6 and minimatch 10.2.5, https://github.com/npm/map-workspaces/blob/v6.0.0/lib/index.js): an array of patterns or an object with a packages array, else EWORKSPACESCONFIG, and an entry that is not text throws too; the leading ! are removed and an odd number of them negates, then a leading ./ or leading slashes ("pattern.replace(/^\\.?\\/+/, \'\')"); a pattern drops the earlier negated patterns it matches as text, and each negated pattern drops the patterns it matches as text and is given to glob as ignore, with **/node_modules/**; glob gets every pattern with a trailing / (directories only) and its defaults: * and ** do not match a name that starts with a dot, ** does not follow symlinked directories, and matching ignores case on macOS and Windows; a match without package.json (ENOENT, ENOTDIR) is no workspace, another error and two workspaces of one name throw, and npm stops. normalize (https://github.com/npm/package-json/blob/v8.0.0/lib/normalize.js, steps bin and binDir) throws for a bin list with an entry that is not text and for directories.bin that is not text when bin is not set. No .git or home directory stops the walk.',
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
    tarballIdentity: release14.verified(
      { separator: '/-/', extension: '.tgz', scopeSeparator: '/|%2f', version: 'semver' },
      'https://github.com/npm/cli/blob/v12.2.1/workspaces/arborist/lib/version-from-tgz.js',
      'What npm installs for an entry of package-lock.json is the tarball of resolved (after replace-registry-host), whatever its version field says: #extractOrLink in workspaces/arborist/lib/arborist/reify.js extracts <name>@<resolved> when resolved is set, and <name>@<version> only without it (12.2.1; the same code in 10.9.9). The allowScripts matcher of npm 12.2.1 takes the name and version of a registry package from resolved with this function (getTrustedRegistryIdentity in workspaces/arborist/lib/script-allowed.js: "Never use node.packageName / node.version here: those read from the tarball\'s own package.json and can be forged"): the path part after the last /-/ must be the file name of the URL, the part before it ends with the name, with the scope before it when that starts with @ (separated by / or %2f), and the file name is <name>-<version>.tgz with a version that semver.parse reads (semver 7.8.5 in npm 12.2.1: three numbers without leading zeros, an optional pre-release and build, an optional leading v, at most 256 characters; the version drops the v and the build). A path in another layout gives no name and version. versionFromTgz reads the whole URL, so a query or a fragment after the file name (.tgz?x=1, .tgz#x) gives none either, while npm still fetches the tarball: pacote 22.0.0 (the version npm 12.2.1 locks) fetches resolved as it is, or, when replace-registry-host replaces its host, new URL(path, registry) without query or fragment (lib/remote.js), and minipass-fetch 6.0.0 requests pathname and search, never the fragment (lib/request.js). The registry serves the file the path names, with its percent-escapes decoded as an HTTP server reads a path (decision D-136).',
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
    lineReleases: d173.verified(
      [
        '6.14.18', '7.24.2', '8.19.4',
        '9.0.1', '9.1.3', '9.2.0', '9.3.1', '9.4.2', '9.5.1', '9.6.7', '9.7.2', '9.8.1', '9.9.4',
        '10.0.0', '10.1.0', '10.2.5', '10.3.0', '10.4.0', '10.5.2', '10.6.0', '10.7.0', '10.8.3', '10.9.9',
        '11.0.0', '11.1.0', '11.2.0', '11.3.0', '11.4.2', '11.5.2', '11.6.4', '11.7.0', '11.8.0', '11.9.0', '11.10.1', '11.11.1', '11.12.1', '11.13.0', '11.14.1', '11.15.0', '11.16.0', '11.17.0', '11.18.0', '11.19.1', '11.20.0', '11.21.1',
        '12.0.2', '12.1.0', '12.2.1',
      ],
      'https://registry.npmjs.org/npm',
      'The newest release of each minor line from 9.0 to 12.2, and of the major lines 6, 7 and 8, among the versions of the npm package in the registry on 2026-11-03 (modified 2026-10-21); none of 10.x to 12.x is deprecated. The dist-tags agree (https://registry.npmjs.org/-/package/npm/dist-tags: latest 12.2.1, next-11 11.21.1, next-10 10.9.9, next-9 9.9.4, next-8 8.19.4, latest-7 7.24.2, latest-6 6.14.18), and so do the v<version> tags of npm/cli. npm does not publish a release twice, so a later run of npm install -g npm@11 installs this release or a newer 11.x.',
    ),
    rangeInstall: d173.verified(
      { picks: 'highest', prefersTag: 'latest', enginesFirst: true },
      'https://github.com/npm/npm-pick-manifest/blob/v12.0.0/lib/index.js',
      'npm 12.2.1 depends on npm-pick-manifest ^12.0.0 and npm 11.21.1 on ^11.0.3 (package.json of npm/cli at those tags). For a range (npm install -g npm@11, npm@^11.10.0) or a tag (npm@latest, a bare npm), pickManifest returns the version of the latest dist-tag when it satisfies the range, runs on the Node.js in use (engineOk with nodeVersion, process.version by default) and is not deprecated; otherwise it sorts the versions that satisfy the range by: not avoided, not restricted, not staged, not deprecated and engine ok, engine ok, not deprecated, then semver.rcompare, and returns the first. So npm installs the newest release of the range that runs on that Node.js, and the newest release of the range when none does.',
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
    execReleaseAge: d184.verified<ExecReleaseAgeKnowledge>(
      { commands: EXEC_COMMANDS, readsExclude: false },
      `${LIBNPMEXEC_V11}/index.js`,
      'getManifest in libnpmexec asks pacote.manifest for the package with the flat options of npm, which carry before (min-release-age turned into a date by its flatten in definitions.js) and minReleaseAgeExclude, which neither libnpmexec nor pacote reads: the registry fetcher of pacote passes before to npm-pick-manifest (lib/registry.js of npm/pacote at v21.5.1, the version npm 11.21.1 ships). Only Arborist reads min-release-age-exclude (isReleaseAgeExcluded in workspaces/arborist/lib/release-age-exclude.js, used by build-ideal-tree.js, audit-report.js and query-selector-all.js), and so do npm outdated and npm pack. So npx, npm exec and npm x pick the newest version older than the delay, also for a package the list exempts, and fail with ETARGET for an exact version younger than it. The same in npm 11.21.2 (libnpmexec 10.3.5, pacote 21.5.2) and 12.2.2 (libnpmexec 11.0.5, pacote 22.0.1), read in the packages on the registry.',
    ),
    localBinaries: d184.verified<LocalBinariesKnowledge>(
      {
        commands: EXEC_COMMANDS,
        directory: 'node_modules/.bin',
        bypassOptions: ['--package', '-p', '--workspace', '-w', '--workspaces', '--ws', '-ws', '--include-workspace-root', '--iwr', '-iwr'],
      },
      `${LIBNPMEXEC_V11}/index.js`,
      'Without --package, exec in libnpmexec looks for the first argument, before it asks any registry: as a bin of the package.json of npm\'s local prefix and of the workspace the command runs in (hasPkgBin; it then installs that package into the npx cache), then as a file in node_modules/.bin of the local prefix, or of that workspace, and of every directory above it (localFileExists in lib/file-exists.js: walkUp, stat, isFile), which it runs as it is, then in the global bin directory. Only then does it fetch the package of that name. npm takes a directory that a root package.json lists as a workspace for the default workspace, and exec does not ignore it (ignoreImplicitWorkspace = false and runPath in lib/commands/exec.js), so a command run in a workspace looks from there; --prefix sets the local prefix. --workspace (-w), --workspaces (--ws) and --include-workspace-root (--iwr) run it once per workspace; nopt takes the shorthands with one dash too (-ws, -iwr). The same code in npm 12.2.2.',
    ),
    runnerOptions: runners.verified<RunnerOptionsKnowledge>(
      {
        beforeCommand: [
          { command: ['npm', 'exec'], values: 'separate' },
          { command: ['npm', 'x'], values: 'separate' },
        ],
        amongArguments: [
          ['npm', 'exec'],
          ['npm', 'x'],
        ],
      },
      `${NPM_GITHUB_V12}/docs/lib/content/commands/npm-exec.md`,
      'npm parses its whole command line with nopt and the types of every setting (load in workspaces/config/lib/index.js at v12.2.1), and lib/commands/exec.js takes the packages from the setting package and the command line from call, so --package and --call count wherever they stand before --: before exec (npm --package=x exec y) and after the arguments. npm-exec.md ("npx vs npm exec"): "npm exec foo@latest bar --package=@npmcli/foo" resolves @npmcli/foo and runs foo@latest bar, and "a double-hyphen -- flag can be used to suppress npm\'s parsing of switches and options that should be sent to the executed command". npx puts -- before its first positional argument (bin/npx-cli.js), so there the options after it belong to the command. npm init and npm create do not pass --package on (lib/commands/init.js). Decision D-160.',
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
    parsing: runtimes.verified(
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
      'The shorthands npm passes to nopt: the list in definitions/index.js and the short names of the definitions (the same in 11.21.1). nopt (node_modules/nopt/lib/nopt-lib.js, versions 8.1.0 in npm 10.9.4, 9.0.0 in 11.21.1 and 10.0.1 in 12.2.1, same parse and resolveShort) strips every leading dash, so -reg, --reg and -registry work; takes an exact option first, then an exact shorthand, then a word of one-letter shorthands (-gD), then an unambiguous prefix of an option name (abbrev), then a prefix of a shorthand; and reads --no-<name> as a negated flag that takes no value. After the shorthands (resolveShort) nopt strips every leading no- in any case, each one inverting the flag, and then takes <name> as an exact option or an unambiguous prefix (abbrevs), so --no-ign is --no-ignore-scripts where no other option starts with ign (npm 11; npm 12 has ignore-existing too) and --no-no-ignore-scripts sets ignore-scripts to true; a negated flag takes a following true or false, inverted (definitions/index.js and definitions.js at v12.2.1 and lib/nopt-lib.js of nopt 10.0.1, read again 2026-11-01). npm 10 expands abbreviations silently, npm 11 warns "Expanding --regis to --registry. This will stop working in the next major version of npm." and npm 12 refuses them with EUNKNOWNCONFIG (abbrevHandler in workspaces/config/lib/index.js of 11.21.1 and 12.2.1). Shorthands are expanded only on the command line, not in .npmrc or npm_config_ variables. npx turns -p into --package and expands exact shorthands itself before npm exec reads the rest (bin/npx-cli.js).',
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
    globalConfig: secrets.verified<NpmGlobalConfigKnowledge>(
      {
        userKey: 'userconfig',
        globalKey: 'globalconfig',
        prefixKey: 'prefix',
        file: 'etc/npmrc',
        prefixVariable: 'PREFIX',
        destDirVariable: 'DESTDIR',
        execPathLevels: { win32: 1, other: 2 },
        order: ['cli', 'env', 'project', 'user', 'global', 'builtin'],
      },
      `${NPM_CONFIG_LIB}/index.js`,
      'load() reads the builtin config, the command line, the environment (loadEnv), the project .npmrc, the user file (#get("userconfig")) and the global file (#get("globalconfig")), and a key of an earlier source in the order above wins. loadGlobalPrefix: the default prefix is PREFIX of the environment, else on Windows the directory of the Node.js executable ("c:\\node\\node.exe --> prefix=c:\\node\\") and elsewhere the directory above it ("/usr/local/bin/node --> prefix=/usr/local"), with DESTDIR joined in front on POSIX only; the default of globalconfig is a getter, resolve(prefix, "etc/npmrc"), of the prefix the command line, the environment or the user file sets (loadDefaults). userconfig, globalconfig and prefix are of type path (definitions.js), which parseField (parse-field.js at the same tag) trims, expands ${VAR} in and resolves: ~/ against the home directory, anything else against the current directory.',
    ),
    registryHostTarballs: secrets.verified<NpmRegistryHostKnowledge>(
      { dependencies: 'registry specs', match: 'origin and path' },
      'https://github.com/npm/cli/blob/v12.2.1/workspaces/arborist/lib/arborist/reify.js',
      '#isRegistryResolvedTarball: a node whose every dependency edge has a registry spec (node.isRegistryDependency, workspaces/arborist/lib/node.js: npa(edge.spec).registry) and whose resolved URL, after replace-registry-host, has the origin of pickRegistry(npa(node.name)), the registry of its scope or else registry, and a path that starts with that registry\'s path, is extracted with allowRemote "all": "pacote\'s npa re-parses our name@URL spec as type=remote, so allowRemote would mis-fire on registry tarballs". The allow-remote definition says so for users: "Tarballs that share a hostname with the configured registry (the typical case for the npm registry, GitHub Packages, and most private registries) are still installed normally" (workspaces/config/lib/definitions/definitions.js).',
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
    linkCommands: d172.verified<readonly (readonly string[])[]>(
      [['npm', 'link']],
      `${NPM_GITHUB_V12}/lib/commands/link.js`,
      'npm link with package specs (linkInstall in lib/commands/link.js at v12.2.1, the same in 11.21.1): it loads the top-level packages of the global space, takes every spec that no package there matches (missingArgsFromTree), and installs those into the global space first (globalArb.reify with add: missing, after the strict-allow-scripts preflight of npm install and with its allow-scripts policy), so a registry name comes from the registry as with npm install -g; then it links each package into the project (localArb.reify with add: file:<global>/node_modules/<name>). A directory spec links that folder, and a spec that resolves to the project directory itself is dropped; without specs npm link links the current package into the global space (linkPkg). Its params include ignore-scripts, allow-directory, allow-file, allow-git and allow-remote; it refuses --global (ELINKGLOBAL). ln is its alias (commandNames), and unlink is an alias of uninstall.',
    ),
    commandNames: runners.verified(
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
      'deref resolves a command name: camelCase to kebab-case (installTest is install-test), an exact command, a direct alias, else a unique abbreviation of the commands and alias names (abbrev 5.0.0, node_modules/abbrev/lib/index.js: every prefix that only one name starts with, and each name itself), whose aliases are followed to the command (npm install-cl is install-clean, then ci). So npm c, npm con, npm conf and npm confi are npm config, npm pk is npm pkg, npm exe is npm exec, npm ini is npm init and npm cre is npm create, so npm init; npm ex (exec, explain, explore) and npm install- are ambiguous. lib/npm.js resolves the first word with deref, and lib/cli/entry.js prints the usage and exits with 1 when it finds no command. deref and its use are the same in v11.21.1 and v10.9.9; their lists differ (11.21.1 also has adduser, add-user, shrinkwrap, star, stars and unstar and not patch; 10.9.9 has hook and run-script with the alias run, and not approve-scripts, deny-scripts, install-scripts, stage, trust, undeprecate or u, which the 11.13.0 changelog adds), and with them no word is install, install-test, install-ci-test, ci, update, exec, init, config, set or pkg that is not one with the lists of 12.2.1 (ad is install only with those of 12.2.1, u is update from 11.13.0). Decision D-162.',
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
    settingOverrides: runners.verified(
      {
        optionPrefix: '--',
        negation: '--no-',
        variablePrefix: 'npm_config_',
        settings: [
          { setting: 'strict-allow-scripts', weakens: 'scripts', values: ['false', 'null', 'undefined'], when: 'written' },
          { setting: 'allow-git', weakens: 'sources', source: 'git', values: { except: ['none'] } },
          { setting: 'allow-remote', weakens: 'sources', source: 'remoteTarball', values: { except: ['none'] } },
          { setting: 'allow-file', weakens: 'sources', source: 'file', values: { except: ['none'] } },
          { setting: 'allow-directory', weakens: 'sources', source: 'directory', values: { except: ['none'] } },
        ],
      },
      `${NPM_GITHUB_V12}/docs/lib/content/using-npm/config.md`,
      'The settings depcurfew apply writes into .npmrc for installScripts and sources that installOverrides (the options and variables the install guard asks about) does not list, for doctor (decision D-166). npm takes its configuration from, "sorted by priority", the command line ("Putting --foo bar on the command line sets the foo configuration parameter", "Using --flag without specifying any value will set the value to true"), then the environment ("Any environment variables that start with npm_config_ will be interpreted as a configuration parameter", "Config values are case-insensitive", with underscores instead of dashes), then the .npmrc files, so either replaces a key of the project .npmrc for the commands it reaches; a --no- prefix sets false (booleanWords). In definitions.js at v12.2.1 strict-allow-scripts is a Boolean (default false), and parseField (workspaces/config/lib/parse-field.js) turns only "false", "null" and "undefined" into values that turn it off, so those weaken it where .npmrc sets it to true (apply writes it for an npm 11.16 to 11.x in use, which runs uncovered scripts without it). allow-git, allow-remote, allow-file and allow-directory take all, none or root; apply writes none for a source the policy denies, root allows the dependencies listed in the root package.json, and a value npm does not accept is reported as invalid and replaced by the default (all before npm 12; user.invalidValueFails), so every value but none weakens a denied source.',
    ),
    directoryOptions: runtimes.verified<DirectoryOptionsKnowledge>(
      { options: [{ name: '--prefix', moves: 'directory', localPrefix: true }], variables: [] },
      NPM_DEFINITIONS,
      'prefix (short C, so -C dir is --prefix dir): "The location to install global items. If set on the command line, then it forces non-global commands to run in the specified folder." loadLocalPrefix in workspaces/config/lib/index.js (v12.2.1) reads it only from the command line ("this.#get(\'prefix\', \'cli\')"), takes it as the local prefix as given and does not walk up, so npm_config_prefix and .npmrc do not move a command; the project .npmrc is the one in that folder.',
    ),
    booleanWords: runtimes.verified(
      true,
      'https://github.com/npm/nopt/blob/v10.0.1/lib/nopt-lib.js',
      'nopt, which parses the npm command line, also supports "--bool true or --bool false": a Boolean option followed by the word true or false takes it as its value and skips it, and a --no- prefix inverts the value (parse in lib/nopt-lib.js at v10.0.1, used by npm 12.2.1, and the same code at v9.0.0, used by npm 11.21.1).',
    ),
    installCommands: runners.verified(
      {
        install: INSTALL_ALIASES,
        clean: ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-ci-test', 'cit', 'clean-install-test', 'sit'],
        update: ['update', 'up', 'upgrade', 'udpate'],
      },
      CMD_LIST,
      'Commands that install packages into the project and their aliases: install (add, i, typo aliases, install-test and it), ci (clean-install, ic, install-clean, isntall-clean) with install-ci-test (cit, clean-install-test, sit), and update (up, upgrade, udpate; u only from npm 11.13.0, whose changelog adds it, so left out). The same in v10.9.9 (lib/utils/cmd-list.js). npm also accepts unique abbreviations of command names, which are not listed.',
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
    rootLifecycleScripts: release14.verified<RootLifecycleScriptsKnowledge>(
      { events: ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'], skippedBy: 'ignore-scripts', allowListApplies: false },
      `${NPM_GITHUB_V12}/lib/commands/install.js`,
      'A bare npm install in a project runs the lifecycle scripts of the project itself with runScript, outside arborist and its allowScripts gate: "const runRootLifecycle = !args.length && !isGlobalInstall && !ignoreScripts", preinstall before reify and install, postinstall, prepublish, preprepare, prepare and postprepare after it. npm ci does the same "if (!ignoreScripts)" (lib/commands/ci.js), and so do install.js and ci.js at v11.16.0. collectUnreviewedScripts in workspaces/arborist/lib/unreviewed-scripts.js skips "node.isProjectRoot || node.isWorkspace", so strict-allow-scripts never stops at them. using-npm/scripts.md: prepare "Runs on local npm install without package arguments (runs with flags like --production or --omit=dev, but does not run when installing specific packages like npm install express)".',
    ),
    omitOptional: release14.verified<OmitOptionalKnowledge>(
      { omit: { setting: 'omit', value: 'optional' }, alias: { setting: 'optional', off: false }, include: { setting: 'include' }, variablePrefix: 'npm_config_', listSeparator: '\n\n' },
      NPM_DEFINITIONS,
      'omit: [Array, "dev", "optional", "peer"], "Dependency types to omit from the installation tree on disk"; include: "Dependency types specified in --include will not be omitted, regardless of the order in which omit/include are specified on the command-line"; optional: deprecated, "Alias for --include=optional or --omit=optional" (buildOmitList: obj.optional === false pushes optional to omit, true to include; omit then drops what include lists). --no-optional sets optional to false. Each is one key: the value of the highest layer that sets it wins (command line, then npm_config_* variables in any case, then the project .npmrc). parseField in workspaces/config/lib/parse-field.js splits a list from the environment at two line breaks ("list types get put in the environment separated by double-\\n"), so NPM_CONFIG_OMIT=optional omits them and dev,optional is one unknown value.',
    ),
  },
};
