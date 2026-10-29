import { verifiedOn } from './define.ts';
import type { ToolKnowledge } from './types.ts';

const { verified, uncertain, disputed, evidence } = verifiedOn('2026-10-28');
const checked = verifiedOn('2026-10-29');

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
      'Not documented; npm’s map-workspaces also accepts { "packages": [...] } and negated patterns.',
    ),
  },
  extra: {
    trustedPublishing: checked.verified(
      { minimumNpm: '11.5.1', minimumNode: '22.14.0', githubPermission: 'id-token: write', automaticProvenance: true, firstPublishWithinDays: 2 },
      'https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/packages-and-modules/securing-your-code/trusted-publishers.mdx',
      'Publishing from GitHub-hosted runners with OIDC instead of a token. Provenance is generated automatically, only for a public package from a public repository. A new trusted publisher configuration expires unless its first publish succeeds within 2 days. It can be limited to npm stage publish (the default for configurations created after 2026-09-03).',
    ),
    stagedPublishing: checked.verified(
      { minimumNpm: '11.15.0', minimumNode: '22.14.0', stage: 'npm stage publish', approve: 'npm stage approve', reject: 'npm stage reject', newPackagePlaceholder: '0.0.0-stage' },
      'https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/cli/v12/commands/npm-stage.mdx',
      'Staging needs no 2FA, so CI can do it; approving or rejecting needs 2FA (CLI or npmjs.com). Staging a package that does not exist yet creates it with the public placeholder version 0.0.0-stage. Pre-release versions need an explicit --tag. --provenance also applies to npm stage publish.',
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
      },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md',
      'Entries under packages: resolved is the registry tarball URL, the git URL with its commit (git+ssh://… or git+https://…#sha), file:<path> for local tarballs and directories, or the link target when link is true. hasInstallScript marks a preinstall, install or postinstall script (prepare scripts of non-registry sources are not flagged). npm tells registry tarballs from other URLs with the registryTarball pattern (workspaces/arborist/lib/install-scripts.js), so a tarball URL on a registry host looks like a registry package. An entry without resolved is installed as <name>@<version> (workspaces/arborist/lib/arborist/reify.js, #extractOrLink, in 11.19.1 and 12.2.1), so its version field is the source then.',
    ),
    npmrcScope: checked.verified(
      { read: 'project root', workspacePackages: 'ignored' },
      'https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md',
      'Only the .npmrc at the root of the project npm runs in is read. Inside a workspace package npm moves the prefix to the workspace root (using-npm/workspaces.md) and warns "ignoring workspace config" for the package .npmrc (workspaces/config/lib/index.js).',
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
    beforeInteraction: verified(
      [
        { since: '11.10.0', value: 'min-release-age and before are mutually exclusive' },
        { since: '11.15.0', value: 'both may be set; before wins within the same config source' },
      ],
      release('11.15.0'),
    ),
    strictAllowScripts: checked.verified(
      { setting: 'strict-allow-scripts', value: true, since: '11.16.0' },
      NPM_DEFINITIONS_V11_16,
      'strict-allow-scripts=true makes the install fail on a dependency with install scripts that allowScripts does not cover, instead of running them with a notice (default false). Entries denied with false are skipped silently; --ignore-scripts and --dangerously-allow-all-scripts override it.',
    ),
    unknownNpmrcKeys: disputed(
      'Matters for generated .npmrc files: keys that npm does not know (e.g. pnpm-only keys) may break npm 12 installs.',
      evidence('npm 12 throws on unknown config keys', release('12.0.0')),
      evidence('unknown keys only warn; throwing is planned for a future major version', NPMRC),
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
    lockfileInstalls: uncertain(
      'npm ci installs versions pinned in package-lock.json without applying min-release-age',
      'https://docs.npmjs.com/cli/v12/commands/npm-ci',
      'Inferred: npm ci does not list min-release-age or before among its options, and a user report (npm/cli#9277) describes it installing a version younger than the window.',
    ),
  },
};
