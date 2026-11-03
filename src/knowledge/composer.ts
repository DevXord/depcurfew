import { verifiedOn } from './define.ts';
import type {
  ApplicationOption,
  ComposerCommandsKnowledge,
  ComposerInstallPreferenceKnowledge,
  ComposerRootStabilityKnowledge,
  ComposerScriptCommandsKnowledge,
  ComposerConstraintsKnowledge,
  ComposerStabilitiesKnowledge,
  CommandLineKnowledge,
  CommandNamesKnowledge,
  ConfigCommand,
  DirectoryOptionsKnowledge,
  EnvironmentNameRule,
  InstallOverridesKnowledge,
  PackagistApiKnowledge,
  RegistryOverridesKnowledge,
  SourceKnowledge,
  ToolKnowledge,
  VersionCompareKnowledge,
} from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-02');
const ciOverrides = verifiedOn('2026-11-03');

// getcomposer.org/doc is built from doc/ in the repository; the code is read at the same tag.
const COMPOSER = 'https://github.com/composer/composer/blob/2.11.1';
const CONFIG = `${COMPOSER}/doc/06-config.md`;
const CLI = `${COMPOSER}/doc/03-cli.md`;
const SCHEMA = `${COMPOSER}/doc/04-schema.md`;
const REPOSITORIES = `${COMPOSER}/doc/05-repositories.md`;
const CHANGELOG = `${COMPOSER}/CHANGELOG.md`;
const SRC = `${COMPOSER}/src/Composer`;
const VERSIONS = `${COMPOSER}/doc/articles/versions.md`;
// composer/semver and composer/metadata-minifier at the versions composer.lock of Composer 2.11.1 locks.
const SEMVER = 'https://github.com/composer/semver/blob/3.6.0/src/VersionParser.php';
const MINIFIER = 'https://github.com/composer/metadata-minifier/blob/1.0.1/src/MetadataMinifier.php';
// symfony/console at the version composer.lock of Composer 2.11.1 locks, which reads its command line.
const CONSOLE = 'https://github.com/symfony/console/blob/v5.4.55';
const PACKAGIST_API = 'https://packagist.org/apidoc';
// WPackagist, the Composer repository of the WordPress plugin and theme directories, at the head of its develop branch.
const WPACKAGIST = 'https://github.com/outlandishideas/wpackagist/blob/9b5db4a9e7477c97de1c8562498ecfff4cab9678';

/** What composer --no-blocking and the variables that set it turn off (BaseCommand::createPolicyConfig at 2.11.1). */
/** Where composer config, repository and policy write with --global or --file, which depcurfew does not read (decision D-142). */
const GLOBAL_FILES = 'COMPOSER_HOME/config.json, or the file --file names';
const GLOBAL_OPTIONS = ['--global', '-g', '--file', '-f'];
/** Where the same commands write after composer global. */
const HOME_FILES = 'a file of COMPOSER_HOME';
const ALL_BLOCKING = "turns off all of Composer's policy blocking for the command, the cooldown and the blocking of versions flagged as malware included";

/** The commands of Composer 2.11.1 and of symfony/console v5.4.55 that Composer registers, and their aliases. */
const COMMAND_NAMES: CommandNamesKnowledge = {
  commands: [
    'about', 'archive', 'audit', 'browse', 'bump', 'check-platform-reqs', 'clear-cache', 'completion', 'config', 'create-project', 'depends', 'diagnose',
    'dump-autoload', 'exec', 'fund', 'global', 'help', 'init', 'install', 'licenses', 'list', 'outdated', 'policy', 'prohibits', 'reinstall', 'remove',
    'repository', 'require', 'run-script', 'search', 'self-update', 'show', 'status', 'suggests', 'update', 'validate', '_complete',
  ],
  aliases: {
    home: 'browse', clearcache: 'clear-cache', cc: 'clear-cache', why: 'depends', dumpautoload: 'dump-autoload', i: 'install', 'why-not': 'prohibits',
    rm: 'remove', uninstall: 'remove', repo: 'repository', r: 'require', run: 'run-script', selfupdate: 'self-update', info: 'show', u: 'update', upgrade: 'update',
  },
  matching: 'symfony-console',
  hidden: ['_complete'],
};

const noSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    `${SCHEMA}#repositories`,
    `No setting allows or forbids ${kind} dependencies (concluded from the config options in 06-config.md). Such packages come only from repositories declared in the root composer.json: "Repositories are not resolved recursively. You can only add them to your main composer.json. Repository declarations of dependencies' composer.jsons are ignored."`,
  ),
});

export const composer: ToolKnowledge = {
  id: 'composer',
  name: 'Composer',
  kind: 'package-manager',
  ecosystem: 'packagist',
  cooldown: {
    setting: verified(
      'config.policy.cooldown.period',
      `${CONFIG}#cooldown`,
      'Withholds versions published within the period when composer update or require resolves dependencies (also init and create-project when they pick a constraint). Measured from the publication time the repository reports (published-time, which Packagist.org provides and package authors cannot influence); a Composer repository that lacks it makes the command fail unless require-published-time is false on it, and packages from VCS, path or artifact repositories use the author-set time of their composer.json. Never withheld: dev versions, locked packages a partial update keeps, platform packages and versions without any date.',
    ),
    configFiles: verified(
      ['composer.json'],
      `${SCHEMA}#config`,
      'config is root-only: "It is only used for projects." COMPOSER_HOME/config.json is merged under it (only its config and repositories keys), and "the local configuration in the project\'s composer.json always wins" (03-cli.md#composer-home-config-json).',
    ),
    cliFlag: uncertain(
      null,
      `${CLI}#require-r`,
      'No option sets the period (concluded from the command options): --no-cooldown and --no-blocking turn the delay off for one command, show --cooldown-period and outdated --cooldown-period only change what is displayed, and COMPOSER_POLICY_COOLDOWN_PERIOD overrides the period.',
    ),
    unit: verified(
      'duration-string',
      `${CONFIG}#period`,
      '"A duration string in the form "<number> <unit>" where the unit is one of second, minute, hour, day or week (lowercase, singular or plural - e.g. "7 days", "24 hours", "30 minutes", "1 week"), an integer number of seconds, or null to disable."',
    ),
    availableSince: verified(
      '2.11.0',
      CHANGELOG,
      '"Added a cooldown policy to withhold newly released package versions for a configurable period" under 2.11.0-RC1 (2026-10-22); 2.11.0 was released on 2026-10-29.',
    ),
    default: verified([{ since: '2.11.0', value: null }], `${CONFIG}#period`, '"Defaults to null (no cooldown period). The policy only takes effect once a period is set."'),
    exclude: {
      setting: verified(
        'config.policy.cooldown.ignore',
        `${CONFIG}#cooldown`,
        '"Packages listed under ignore bypass the cooldown policy." The ignore format of the other policies: a list of names, or an object of names to a reason, to { constraint, reason, on-block, on-audit } or to a list of such rules.',
      ),
      availableSince: verified('2.11.0', CHANGELOG, 'Part of the cooldown policy added in 2.11.0-RC1.'),
      patternSyntax: verified('Package names with * wildcards, e.g. vendor/*', `${CONFIG}#cooldown`, '"package names support wildcards (e.g. vendor/*)".'),
    },
    securityUpdates: uncertain(
      'applies',
      `${CONFIG}#cooldown`,
      'The cooldown section names no exception for security fixes; its example lists symfony/security-bundle under ignore because "Security fixes need to be applied immediately".',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [
        { since: '0.0.0', value: 'run' },
        { since: '2.2.0', value: 'deny-except-allowlist' },
      ],
      `${CONFIG}#allow-plugins`,
      'Only the root package\'s scripts run (articles/scripts.md: "If a dependency of the root package specifies its own scripts, Composer does not execute those additional scripts"); dependency code runs during Composer commands through plugins, packages of type composer-plugin. allow-plugins (2.2.0) "Defaults to {} which does not allow any plugins to be loaded": a plugin it does not list makes Composer ask in an interactive run and fail in a non-interactive one, or skips it when the plugin declares plugin-optional (PluginManager::isPluginAllowed, articles/plugins.md).',
    ),
    allowList: {
      setting: verified('config.allow-plugins', `${CONFIG}#allow-plugins`, '"Use this setting to allow only packages you trust to execute code."'),
      file: verified('composer.json', `${SCHEMA}#config`, 'Root-only, like every config option.'),
      availableSince: verified('2.2.0', `${CONFIG}#allow-plugins`, '"As of Composer 2.2.0, the allow-plugins option adds a layer of security".'),
      format: verified(
        'An object of package name patterns (vendor/*) to true (allow) or false (disallow without asking); true allows every plugin and false none',
        `${SRC}/Plugin/PluginManager.php`,
        'parseAllowedPlugins turns each key into a pattern; isPluginAllowed returns the value of the first pattern that matches, in the order written. Config::merge puts the keys of COMPOSER_HOME/config.json after the project\'s, the project\'s values winning.',
      ),
    },
    disableAll: verified('config.allow-plugins: false', `${CONFIG}#allow-plugins`, '"You can also set the config option itself to false to disallow all plugins"; --no-plugins does the same for one command (03-cli.md#global-options).'),
  },
  sources: {
    git: noSetting('VCS'),
    remoteTarball: noSetting('package repository'),
    file: noSetting('artifact'),
    directory: noSetting('path repository'),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['composer.lock'] }],
      `${COMPOSER}/doc/01-basic-usage.md#commit-your-composer-lock-file-to-version-control`,
      'JSON next to composer.json. With COMPOSER=<name>.json Composer reads another manifest and writes <name>.lock (03-cli.md#composer); depcurfew reads composer.json and composer.lock only.',
    ),
    manifests: verified(['composer.json'], SCHEMA, 'The root package; repositories, config and scripts are read only from it.'),
    workspaces: uncertain(null, `${REPOSITORIES}#path`, 'Composer has no workspaces; a monorepo links its packages with path repositories.'),
    workspacesObjectKey: uncertain(null, `${REPOSITORIES}#path`, 'No workspaces.'),
  },
  extra: {
    environmentNames: verified<EnvironmentNameRule[]>(
      [{ prefix: '', match: 'exact' }],
      `${COMPOSER}/src/Composer/Util/Platform.php`,
      'Platform::getEnv looks the name up with array_key_exists($name, $_SERVER), then in $_ENV, then with getenv($name), so outside Windows only that spelling counts: COMPOSER and COMPOSER_HOME, not Composer or composer (decision D-143).',
    ),
    latestVersion: verified('2.11.1', CHANGELOG, 'Released on 2026-10-30.'),
    durationStrings: verified(
      { since: '2.11.0', syntax: 'unit-word', numbers: 'seconds', trim: false },
      `${SRC}/Policy/CooldownPolicyConfig.php`,
      'parseDuration: an integer, or a string of digits (/^\\d+$/D), is a number of seconds; otherwise only /^(\\d+)\\s*(second|minute|hour|day|week)s?$/D is accepted (lowercase, one unit). The string is matched as it is, so a space before or after the value (" 14 days") is not accepted. null, "", 0 and "0" mean no cooldown; any other value makes the command fail with "Invalid policy.cooldown.period format", and so does such a COMPOSER_POLICY_COOLDOWN_PERIOD.',
    ),
    durationUnits: verified(
      ['days'],
      `${CONFIG}#period`,
      'The documented examples are "7 days", "24 hours", "30 minutes" and "1 week"; depcurfew writes whole days, rounded up.',
    ),
    excludeWildcards: verified({ since: '2.11.0', trailingOnly: false }, `${CONFIG}#cooldown`, '"package names support wildcards (e.g. vendor/*)" in ignore.'),
    denyList: verified(
      { file: 'composer.json', setting: 'config.allow-plugins', value: false, since: '2.2.0' },
      `${CONFIG}#allow-plugins`,
      '"The values are true to allow and false to disallow while suppressing further warnings and prompts."',
    ),
    cooldownTime: verified(
      { published: 'published-time', author: 'time', requireSetting: 'require-published-time', authorTimeRepositories: ['vcs', 'path', 'artifact'] },
      `${SRC}/Policy/CooldownPolicyConfig.php`,
      'getEffectiveDate returns the published date, else the release date (time). A Composer repository must give published-time while a cooldown is configured, unless require-published-time is false on it (05-repositories.md#require-published-time: "That field is set by the package author, so the protection is weaker"); ArtifactRepository drops a published-time from the archive\'s composer.json.',
    ),
    lockedVersions: verified(
      'composer install installs the locked versions without the cooldown; a partial update keeps every other locked version, a full composer update re-evaluates them all',
      `${CONFIG}#cooldown`,
      '"The cooldown policy applies when resolving dependencies during composer update/require"; "Locked packages that are not being updated" are never withheld.',
    ),
    olderVersions: uncertain(
      'Composer 2.10 reads policy.cooldown as a custom dependency policy without sources, which blocks nothing; older versions ignore config.policy as an unknown config key',
      `https://github.com/composer/composer/blob/2.10.3/src/Composer/Policy/PolicyConfig.php`,
      'Read from the code at 2.10.3, not tested: fromConfig passes every key of policy but advisories, malware, abandoned and ignore-unreachable to CustomListPolicyConfig::fromRawConfig, which reads only block, audit, ignore and sources, and the schema at 2.10.3 does not reject period there. Config::merge keeps any unknown config key, and the schema of config has no additionalProperties: false.',
    ),
    contentHash: verified(
      { file: 'composer.lock', key: 'content-hash', settings: ['config.policy'], since: '2.11.0', command: 'composer update --lock' },
      `${SRC}/Package/Locker.php`,
      'getContentHash hashes name, version, require, require-dev, conflict, replace, provide, minimum-stability, prefer-stable, repositories, extra, config.platform and config.policy ("policy changes which versions an update may pick, so changing it should flag the lock as outdated"; CHANGELOG 2.11.0-RC1, #13149). With another hash composer install warns that "The lock file is not up to date with the latest changes in composer.json" (Installer.php) and composer validate fails (03-cli.md#validate); composer update --lock "Overwrites the lock file hash to suppress warning about the lock file being out of date without updating package versions" (03-cli.md#update-u-upgrade). allow-plugins is not hashed. Locker::getContentHash at 2.10.3 hashes config.platform but not config.policy, so a hash written by Composer 2.10 or older differs from what 2.11 computes for a composer.json with config.policy (https://github.com/composer/composer/blob/2.10.3/src/Composer/Package/Locker.php).',
    ),
    pluginApiVersion: verified(
      { key: 'plugin-api-version', cooldownApi: '2.11.0' },
      `${SRC}/Plugin/PluginInterface.php`,
      'Locker writes PluginInterface::PLUGIN_API_VERSION of the Composer that writes composer.lock into plugin-api-version (Locker.php; CHANGELOG 1.10.0: "so third-party tools can know which Composer version was used to generate a lock file"). It is 2.11.0 at 2.11.1 ("Bumped composer-plugin-api to 2.11.0" under 2.11.0-RC1) and 2.9.0 at 2.10.3, so a lower value was written by a Composer older than 2.11.0. It names the Composer that last wrote the lock, not every Composer that installs it.',
    ),
    lockfileFormat: verified(
      {
        sections: ['packages', 'packages-dev'],
        name: 'name',
        version: 'version',
        installScripts: 'type',
        pluginType: 'composer-plugin',
        pluginTypes: ['composer-plugin', 'composer-installer'],
        optionalPlugin: ['extra', 'plugin-optional'],
        source: 'source',
        dist: 'dist',
        pathType: 'path',
        archiveTypes: ['zip', 'tar', 'gzip', 'xz', 'phar', 'rar'],
      },
      `${SRC}/Package/Dumper/ArrayDumper.php`,
      'Each entry of packages and packages-dev has name, version, type and the source { type, url, reference } and dist { type, url, reference, shasum } it installs from, time and, from a repository that gives it, published-time. A package of a path repository has dist type path with the path as url (PathRepository.php); one of an artifact repository has the archive type and its file path as url (ArtifactRepository.php). Composer reads name and type in lower case (BasePackage::__construct and ArrayLoader::configureObject: strtolower), so "Composer-Plugin" is a plugin too. Plugins are packages of type composer-plugin (04-schema.md#type), and Composer also loads the legacy type composer-installer as a plugin, under the same allow-plugins check (PluginInstaller::supports, PluginManager::registerPackage). A plugin whose extra.plugin-optional is true is skipped without a question when Composer runs without a terminal and it is not allowed (PluginManager::isPluginAllowed: elseif ($optional) return false).',
    ),
    legacyLockPlugins: verified(
      { below: '2.2.0', missing: '1.1.0', allowsAllUntil: '2.10.0' },
      `${SRC}/Plugin/PluginManager.php`,
      'parseAllowedPlugins returns no rules when allow-plugins is empty ({} or missing) and composer.lock has a plugin-api-version below 2.2.0, or none (Locker::getPluginApi returns 1.1.0 then). In that mode Composer 2.2 to 2.9 load every plugin without asking when run without a terminal ("if no config is defined we allow all plugins for BC", PluginManager.php at 2.9.8); since 2.10.0-RC1 Composer stops with an error there instead ("Enforce allow-plugins even in non-interactive mode for very old pre-2.2 lock files", #12764 in CHANGELOG.md) and asks in a terminal.',
    ),
    manifestSyntax: verified(
      { comments: false, trailingCommas: false },
      `${SRC}/Json/JsonFile.php`,
      'JsonFile::parseJson at 2.11.1 reads composer.json with PHP\'s json_decode($json, true) and, when it fails, reports the error with JsonFile::validateSyntax (seld/jsonlint), so a comment or a trailing comma in composer.json stops every Composer command; json_decode takes strict JSON (RFC 8259), which has neither.',
    ),
    sourceInstall: verified(
      { source: 'source', dist: 'dist' },
      `${SRC}/Downloader/DownloadManager.php`,
      'getAvailableSources offers source when the package has a source type and dist when it has a dist type; a locked package without a dist is installed from its source, a checkout of the VCS repository the entry names, whatever repository composer.json declares.',
    ),
    registryDistHosts: verified(
      ['api.github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'],
      `${SRC}/Repository/Vcs/GitHubDriver.php`,
      'The archives Composer\'s VCS drivers give a package of the hosts Composer knows by default (github-domains github.com, gitlab-domains gitlab.com, forgejo-domains codeberg.org in Config.php, and Bitbucket): GitHubDriver::getDist https://api.github.com/repos/<owner>/<repo>/zipball/<ref>, GitLabDriver::getDist <scheme>://gitlab.com/api/v4/projects/<id>/repository/archive.zip, GitBitbucketDriver::getDist https://bitbucket.org/<owner>/<repo>/get/<ref>.zip, ForgejoDriver::getDist <host>/api/v1/repos/<owner>/<repo>/archive/<ref>.zip; GitDriver::getDist gives none.',
    ),
    repositoryArchiveHosts: verified(
      { 'wpackagist.org': ['downloads.wordpress.org'] },
      `${WPACKAGIST}/src/Entity/Plugin.php`,
      'The hosts the archives of a Composer repository other than Packagist.org come from, by the host of the repository URL. WPackagist (the Composer repository https://wpackagist.org that its README tells composer.json to declare) gives each plugin version the dist https://downloads.wordpress.org/plugin/<name>.<version>.zip (Plugin::getDownloadUrl) and each theme version https://downloads.wordpress.org/theme/<name>.<version>.zip (Theme::getDownloadUrl in src/Entity/Theme.php), with a dist of type zip and a source of type svn on plugins.svn.wordpress.org or themes.svn.wordpress.org (Package::getPackageVersion in src/Entity/Package.php), all at commit 9b5db4a of the develop branch (the repository has no tags). The archive host of packages.drupal.org could not be read at its source (drupal.org is not reachable from where this was checked), so it is not listed.',
    ),
    branchVersions: verified(
      { prefix: 'dev-', suffix: '-dev' },
      `${COMPOSER}/doc/articles/versions.md#stabilities`,
      'A locked version names a branch, not a release, when it starts with dev- or ends with -dev: "Composer automatically adds a -dev suffix to all numeric branches and prefixes all other branches imported from a VCS repository with dev-" (versions.md, Stabilities); a tag gives its own version (v7.3.4 or 3.9.0, as the tag is written).',
    ),
    repositoryTypes: verified(
      {
        vcs: ['vcs', 'git', 'github', 'gitlab', 'bitbucket', 'git-bitbucket', 'svn', 'hg', 'fossil', 'perforce'],
        directory: ['path'],
        file: ['artifact'],
        inline: ['package'],
        registry: ['composer'],
        disable: 'packagist.org',
      },
      `${SRC}/Repository/RepositoryFactory.php`,
      'The repository classes of createRepositoryManager; 05-repositories.md describes composer, vcs (with the drivers bitbucket, github, gitlab, perforce, fossil, git, svn and hg; git-bitbucket is deprecated), path, package and artifact, and { "packagist.org": false } to disable Packagist.org. repositories is root-only.',
    ),
    weakeningSettings: verified(
      [
        { path: ['config', 'policy'], when: 'false', effect: 'turns off every dependency policy, the cooldown and malware blocking included' },
        { path: ['config', 'policy', 'cooldown'], when: 'false', effect: 'turns off the cooldown' },
        { path: ['config', 'policy', 'cooldown', 'block'], when: 'php-false', effect: 'stops the cooldown from withholding new versions' },
        { path: ['config', 'policy', 'malware'], when: 'false', effect: 'turns off blocking of versions flagged as malware' },
        { path: ['config', 'policy', 'malware', 'block'], when: 'php-false', effect: 'stops blocking versions flagged as malware' },
        { path: ['config', 'policy', 'malware', 'block-scope'], when: 'update', effect: 'blocks versions flagged as malware only on update, so composer install still installs them from composer.lock' },
      ],
      `${CONFIG}#policy`,
      '"Set to false to disable all dependency policy enforcement"; malware "block: Defaults to true", "block-scope: Defaults to all", update blocks "only during update/require/remove"; cooldown block "Set to false to skip blocking for a cooldown period entirely". policy, cooldown and malware are compared with false exactly; block is read with PHP\'s (bool) cast after ?? true, so false, 0, "", "0" and [] turn blocking off, while a missing or null block keeps the default and "false" is true (Config.php, MalwarePolicyConfig.php, CooldownPolicyConfig.php).',
    ),
    transportSettings: verified(
      [
        { path: ['config', 'secure-http'], weakensWhen: false, effect: 'allows downloads over plain HTTP' },
        { path: ['config', 'disable-tls'], weakensWhen: true, effect: 'downloads without TLS and turns off secure-http' },
      ],
      `${CONFIG}#secure-http`,
      'secure-http "Defaults to true. If set to true only HTTPS URLs are allowed to be downloaded via Composer"; disable-tls "Defaults to false. If set to true all HTTPS URLs will be tried with HTTP instead" and "will implicitly disable the secure-http option". Config::get reads both as $value !== "false" && (bool) $value (Config.php), so "false", false, 0, "", "0" and null are false.',
    ),
    allowAllPlugins: verified(
      { setting: 'config.allow-plugins', value: true, patterns: ['*', '*/*'] },
      `${CONFIG}#allow-plugins`,
      '"or true to allow all plugins to run (NOT recommended)". BasePackage::packageNameToRegexp turns a key into {^...$}i with * as .*, so keys match without regard to case and * matches / too: a key made only of * with at most one / between them ("*", "*/*") with true allows every vendor/name plugin that no earlier key names.',
    ),
    repositoryWeakening: verified(
      [
        { key: 'require-published-time', when: 'false', effect: 'lets the cooldown count from the time the package author wrote into composer.json' },
        { key: 'filter', when: 'false', list: 'malware', effect: 'skips the malware list that the repository advertises' },
      ],
      `${REPOSITORIES}#require-published-time`,
      'require-published-time "Defaults to true"; false falls "back to the time field of each package\'s composer.json. That field is set by the package author, so the protection is weaker." Only false counts (ComposerRepository.php). "Set filter: false to opt out of every list this repository advertises", or an object that sets a list name to false to skip that list (#filter); Packagist.org advertises the list malware (repo.packagist.org/packages.json).',
    ),
    environmentOverrides: verified(
      [
        { name: 'COMPOSER_POLICY', values: ['0', 'false', 'off'], effect: 'turns off every dependency policy, the cooldown included' },
        { name: 'COMPOSER_NO_BLOCKING', values: ['1', 'true', 'on', 'false', 'off'], effect: 'turns off all policy blocking, the cooldown and malware blocking included' },
        { name: 'COMPOSER_NO_SECURITY_BLOCKING', values: ['1', 'true', 'on', 'false', 'off'], effect: 'turns off all policy blocking, the cooldown and malware blocking included' },
        { name: 'COMPOSER_POLICY_COOLDOWN_PERIOD', values: 'delay', effect: 'replaces the cooldown period' },
        { name: 'COMPOSER_POLICY_COOLDOWN_BLOCK', values: ['0', 'false', 'off'], effect: 'stops the cooldown from withholding new versions' },
        { name: 'COMPOSER_POLICY_MALWARE_BLOCK', values: ['0', 'false', 'off'], effect: 'stops blocking versions flagged as malware' },
      ],
      `${CLI}#environment-variables`,
      'COMPOSER_POLICY: "Set to 0 to disable all dependency policy enforcement" (read with Platform::getBoolEnv: 0, false and off are false). COMPOSER_NO_BLOCKING and COMPOSER_NO_SECURITY_BLOCKING: BaseCommand::createPolicyConfig reads both with Platform::getBoolEnv(..., false), which takes only 0, 1, false, true, off and on and makes update, require, install, remove and create-project stop with "Invalid value for COMPOSER_NO_BLOCKING" for any other value but ""; 1, true and on turn blocking off there (PolicyConfig::withBlockingDisabled: advisories, malware, abandoned packages, the cooldown and custom lists). BaseCommand::initialize also sets --no-blocking and --no-security-blocking when (bool) getenv() is true, so false and off turn blocking off as well for the commands that have the option (update, require, install, remove, create-project). COMPOSER_POLICY_COOLDOWN_PERIOD "overrides the configured period", 0 disabling it; COMPOSER_POLICY_COOLDOWN_BLOCK and COMPOSER_POLICY_MALWARE_BLOCK set 0 to disable blocking (PolicyConfig.php).',
    ),
    packagistApi: verified<PackagistApiKnowledge>(
      {
        url: 'https://repo.packagist.org',
        metadataPath: '/p2/{name}.json',
        devSuffix: '~dev',
        notFoundStatus: 404,
        packagesField: 'packages',
        minifiedField: 'minified',
        minifiedValue: 'composer/2.0',
        unsetValue: '__unset',
        versionField: 'version',
        normalizedField: 'version_normalized',
        timeField: 'time',
        publishedField: 'published-time',
        typeField: 'type',
        abandonedField: 'abandoned',
        packagePage: 'https://packagist.org/packages/{name}',
      },
      PACKAGIST_API,
      '"Using the Composer v2 metadata": GET https://repo.packagist.org/p2/[vendor]/[package].json gives {"packages": {"[vendor]/[package]": [versions]}, "minified": "composer/2.0"}, each version with version, "time": [release datetime, as set by the package author] and "published-time": [datetime the version was published on packagist.org, not influenced by the package author]; the list "requires you to use Composer\\MetadataMinifier\\MetadataMinifier::expand"; "The p2/$vendor/$package.json file contains only tagged releases", branches are in p2/$vendor/$package~dev.json; package pages are https://packagist.org/packages/[vendor]/[package]. https://repo.packagist.org is the url of the packagist.org repository Composer adds by default (Config::$defaultRepositories at 2.11.1). Composer reads a 404 as a package the repository does not have (ComposerRepository.php), expands a list marked composer/2.0 and loads each version with ArrayLoader.php: version_normalized (else the version normalized), type (lowercased, library when missing), time, published-time (an integer or a non-empty string) and abandoned (true or the name of a replacement).',
    ),
    metadataMinifier: verified(
      { firstEntry: 'whole', emptyIsFirst: true, unsetValue: '__unset' },
      MINIFIER,
      'MetadataMinifier::expand: the first entry is a whole version; each later entry holds only the keys that changed since the previous version, a key with the value "__unset" being removed; while the version built so far is empty (PHP: !$expandedVersion), the next entry is taken whole again. Composer 2.11.1 locks composer/metadata-minifier 1.0.1.',
    ),
    versionConstraints: verified<ComposerConstraintsKnowledge>(
      {
        and: [',', ' '],
        or: ['||', '|'],
        hyphen: ' - ',
        wildcards: ['*', 'x', 'X'],
        tilde: '~',
        caret: '^',
        operators: ['>=', '<=', '<>', '!=', '==', '>', '<', '='],
        stabilityFlag: '@',
        branchPrefix: 'dev-',
        branchSuffix: '-dev',
        alias: ' as ',
        reference: '#',
      },
      VERSIONS,
      'Exact version (1.0.2); ranges with >, >=, <, <=, != separated by a space or comma (logical AND) or || (logical OR, and | for backwards compatibility), AND binding tighter; the hyphenated range 1.0 - 2.0 (>=1.0.0 <2.1, a partial right end completed with a wildcard); wildcard 1.0.* (>=1.0 <1.1); ~1.2 (>=1.2 <2.0.0), ~1.2.3 (>=1.2.3 <1.3.0), ~1 like ~1.0; ^1.2.3 (>=1.2.3 <2.0.0), ^0.3 (>=0.3.0 <0.4.0), ^0.0.3 (>=0.0.3 <0.0.4); stability flags @<stability>; a branch as dev-<branch>, or <version>.x-dev for a branch named like a version (versions.md). composer/semver 3.6.0 (src/VersionParser.php, which Composer 2.11.1 locks, ' + SEMVER + ') also reads = and == as exact, <> as !=, x, X and * as wildcards, "<version> as <alias>", #<commit> after a branch, and appends -dev to the bound of < and >= without an explicit stability, so that pre-releases of the bound are below it.',
    ),
    stabilities: verified<ComposerStabilitiesKnowledge>(
      {
        order: ['stable', 'RC', 'beta', 'alpha', 'dev'],
        priorities: { stable: 0, RC: 5, beta: 10, alpha: 15, dev: 20 },
        minimumStability: 'stable',
        modifiers: { a: 'alpha', alpha: 'alpha', b: 'beta', beta: 'beta', rc: 'RC', p: 'patch', pl: 'patch', patch: 'patch', stable: 'stable' },
      },
      `${COMPOSER}/doc/04-schema.md#minimum-stability-root-only`,
      'minimum-stability "defaults to stable"; the options in order of stability are dev, alpha, beta, RC and stable, and stability flags allow another stability per package. BasePackage::STABILITIES at 2.11.1 gives the priorities (stable 0 to dev 20); StabilityFilter::isPackageAcceptable accepts a version whose stability priority is at most the flag of its package, else at most the minimum stability. RootPackageLoader::extractStabilityFlags takes the least stable @<stability> of a requirement as its flag, else the stability of an explicit unstable version in it (2.0.0-beta1) when that is less stable than the minimum stability. VersionParser::parseStability (composer/semver 3.6.0): a version starting with dev- or ending with -dev is dev; a modifier beta or b is beta, alpha or a is alpha, RC is RC (in any case), anything else (patch, pl, p, none) is stable. Versions without a stability suffix are stable (articles/versions.md#stabilities).',
    ),
    versionComparison: verified<VersionCompareKnowledge>(
      {
        separators: ['-', '_', '+'],
        specialForms: [
          ['dev', 0],
          ['alpha', 1],
          ['a', 1],
          ['beta', 2],
          ['b', 2],
          ['RC', 3],
          ['rc', 3],
          ['#', 4],
          ['pl', 5],
          ['p', 5],
        ],
        numberOrder: 4,
      },
      'https://github.com/php/php-src/blob/php-8.4.0/ext/standard/versioning.c',
      "Composer orders normalized versions with PHP's version_compare (VersionSelector.php at 2.11.1; Constraint::versionCompare in composer/semver 3.6.0, where a dev- branch only equals itself). php_canonicalize_version replaces -, _ and + with a dot and puts a dot between a digit and a non-digit; the parts are compared one by one, numbers as numbers, words by the first special form they start with (dev < alpha = a < beta = b < RC = rc < # < pl = p; a word that starts with none is lowest), a number against a word as the form # (#N#); when one version has parts left, a number makes it the greater and a word is compared with #N#.",
    ),
    commandLine: verified<CommandLineKnowledge>(
      {
        add: [
          ['composer', 'require'],
          ['composer', 'r'],
          ['composer', 'global', 'require'],
          ['composer', 'global', 'r'],
        ],
        run: [],
        create: [{ command: ['composer', 'create-project'], packageOptions: [] }],
        valueOptions: [
          '-d',
          '--working-dir',
          '--prefer-install',
          '--audit-format',
          '--ignore-platform-req',
          '--apcu-autoloader-prefix',
          '--with',
          '--bump-after-update',
          '-s',
          '--stability',
          '--repository',
          '--repository-url',
          '--require',
          '-f',
          '--file',
          '--before',
          '--after',
        ],
        parsing: { groupedShortOptions: true },
      },
      CLI,
      'composer require (alias r) takes packages as "vendor/package:2.*" or vendor/package2:dev-master, and picks a constraint itself for a package without one; composer global <command> runs the command "as if you were running them from the COMPOSER_HOME directory"; composer create-project <package> [<directory>] [<version>]; composer update (u, upgrade) takes packages, wildcards and constraints vendor/package:2.0.1, and --with foo/bar:1.0.0. "As Composer uses symfony/console you can call commands by short name if it\'s not ambiguous" (commandNames). The options with a value of require, update, create-project, install, config and repository (InputOption VALUE_REQUIRED or VALUE_OPTIONAL in src/Composer/Command/*Command.php at 2.11.1) and the global --working-dir (-d) of src/Composer/Console/Application.php; symfony/console v5.4.55 (Input/ArgvInput.php) groups short options (-nd dir), takes a value attached (-ddir, --working-dir=dir) or the next word when it does not start with -, accepts options before and after the command, reads every word after -- as an argument and does not shorten long options.',
    ),
    commandNames: verified<CommandNamesKnowledge>(
      COMMAND_NAMES,
      `${CONSOLE}/Application.php`,
      "Application::find: an exact command name or alias; otherwise every name and alias that starts with the word (for each part between colons, a name with more parts too), first with case and then without (ASCII letters only, PCRE without u), of which one must match the word whole; an alias is left out when the name of its command is in the list, a hidden command (_complete) when others remain; one name is run, more are ambiguous (an error) and none is not defined. The names and aliases are those of Composer's getDefaultCommands (src/Composer/Console/Application.php at 2.11.1, setName and setAliases in each src/Composer/Command/*Command.php) and of symfony/console (help, list, completion and the hidden _complete). Scripts of composer.json (extra.scriptCommands) and commands of plugins are added as commands too, unless a command of that name exists.",
    ),
    commandArguments: verified<ComposerCommandsKnowledge>(
      {
        require: 'require',
        update: 'update',
        createProject: 'create-project',
        global: 'global',
        pairSeparators: [':', '=', ' '],
        platformPackages: '^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|(?:ext|lib)-[a-z0-9]+(?:[_.-][a-z0-9]+)*|composer(?:-(?:plugin|runtime)-api)?)$',
        namePattern: '^[a-z0-9]+(?:[_.-][a-z0-9]+)*/[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*$',
        updateLockWords: ['lock', 'nothing', 'mirrors'],
        withOption: '--with',
        requireOption: '--require',
        stabilityOptions: ['--stability', '-s'],
      },
      `${SRC}/Package/Version/VersionParser.php`,
      'parseNameVersionPairs: an argument is split at the first =, : or space after the name; an argument without one takes the next argument as its constraint when that has no /, no * next to a letter, digit, _, / or - and is no platform package. require and create-project read their packages so (RequireCommand via PackageDiscoveryTrait, CreateProjectCommand::installRootPackage); update moves an argument with a constraint (\\S+[ =:]\\S+) to the temporary constraints of --with and takes lock, nothing and mirrors as --lock (UpdateCommand.php). create-project takes its stability from --stability (-s), else from the @<stability> of its version, else from the version itself. Platform packages are PlatformRepository::PLATFORM_PACKAGE_REGEX (case-insensitive). The name pattern is the one 04-schema.md#name gives (ValidatingArrayLoader::hasPackageNamingError checks the same with possessive quantifiers); Composer lowercases the names it looks up. Both are written here as patterns of the same names whose repeated group starts with its separator (X+(?:[sep]X+)*, decision D-136), so that a long name that fails at its end is read in linear time: X(?:[sep]?X+)* can split a run of letters in exponentially many ways.',
    ),
    registryOverrides: verified<RegistryOverridesKnowledge>(
      { registryOptions: ['--repository', '--repository-url'], registryVariables: [], configOptions: [], configVariables: ['COMPOSER', 'COMPOSER_HOME'] },
      `${CLI}#create-project`,
      'create-project --repository "Provide a custom repository to search for the package, which will be used instead of packagist" (and --repository-url, CreateProjectCommand.php at 2.11.1). COMPOSER sets the file name of composer.json, whose repositories then apply (#composer). COMPOSER_HOME sets the home directory (Factory::getHomeDir: "if ($home = Platform::getEnv(\'COMPOSER_HOME\')) return $home"), whose config.json Factory::createConfig merges under the configuration of every project, its repositories included (03-cli.md#composer-home-config-json), and in which composer global runs, with the composer.json there (GlobalCommand::prepareSubcommandInput changes to the home directory of the configuration). Other commands take their repositories from composer.json only.',
    ),
    installOverrides: verified<InstallOverridesKnowledge>(
      {
        options: [
          { name: '--no-blocking', weakens: 'protection', values: 'any', effect: ALL_BLOCKING },
          { name: '--no-security-blocking', weakens: 'protection', values: 'any', effect: ALL_BLOCKING },
          { name: '--no-cooldown', weakens: 'delay', values: 'any' },
          {
            name: '--no-secure-http',
            weakens: 'protection',
            values: 'any',
            effect: 'turns off secure-http while Composer installs the project package',
            protects: 'secure-http lets Composer download only over HTTPS, which keeps that download from being read or changed on the way',
          },
        ],
        variables: [
          { name: 'COMPOSER_NO_BLOCKING', weakens: 'protection', values: { except: ['', '0'] }, effect: ALL_BLOCKING },
          { name: 'COMPOSER_NO_SECURITY_BLOCKING', weakens: 'protection', values: { except: ['', '0'] }, effect: ALL_BLOCKING },
          {
            name: 'COMPOSER_POLICY',
            weakens: 'protection',
            values: ['0', 'false', 'off'],
            effect: 'turns off every dependency policy of Composer for the command, the cooldown and the blocking of versions flagged as malware included',
          },
          { name: 'COMPOSER_POLICY_COOLDOWN_PERIOD', weakens: 'delay', values: 'delay' },
          { name: 'COMPOSER_POLICY_COOLDOWN_BLOCK', weakens: 'delay', values: ['0', 'false', 'off'] },
          { name: 'COMPOSER_POLICY_MALWARE_BLOCK', weakens: 'protection', values: ['0', 'false', 'off'], effect: 'turns off the blocking of versions flagged as malware' },
        ],
      },
      `${SRC}/Command/BaseCommand.php`,
      'createPolicyConfig: --no-blocking, --no-security-blocking (deprecated), COMPOSER_NO_BLOCKING and COMPOSER_NO_SECURITY_BLOCKING "disable ALL blocking (advisories + malware + abandoned + cooldown + custom)" (PolicyConfig::withBlockingDisabled); --no-cooldown disables only the cooldown blocking. initialize sets --no-blocking and --no-security-blocking on each command that has them when (bool) getenv() is true, so for every value but "" and "0" ("false" and "off" too); createPolicyConfig also reads both with Platform::getBoolEnv, which makes the command fail for a value other than 0, 1, false, true, off and on (src/Composer/Util/Platform.php), so such a value installs nothing. COMPOSER_POLICY (Config::get), COMPOSER_POLICY_COOLDOWN_BLOCK and COMPOSER_POLICY_MALWARE_BLOCK (PolicyConfig::fromConfig) are read with getBoolEnv: 0, false and off turn them off. COMPOSER_POLICY_COOLDOWN_PERIOD replaces the period (CooldownPolicyConfig::getEnvPeriod, in the syntax of durationStrings). create-project --no-secure-http "Disable the secure-http config option temporarily while installing the root package" (03-cli.md#create-project): CreateProjectCommand::installRootPackage merges secure-http false into the configuration it installs the project package with, and secure-http "Defaults to true. If set to true only HTTPS URLs are allowed to be downloaded via Composer" (06-config.md#secure-http). The options are on require, update, install, create-project and remove (03-cli.md).',
    ),
    configCommands: verified<readonly ConfigCommand[]>(
      [
        { command: ['composer', 'config'], operands: 2, options: ['--unset', '--editor', '-e'], unread: { file: GLOBAL_FILES, options: GLOBAL_OPTIONS } },
        { command: ['composer', 'repository'], writes: ['add', 'remove', 'rm', 'delete', 'set-url', 'seturl', 'enable', 'disable'], unread: { file: GLOBAL_FILES, options: GLOBAL_OPTIONS } },
        { command: ['composer', 'policy'], writes: ['add-source'], unread: { file: GLOBAL_FILES, options: GLOBAL_OPTIONS } },
        { command: ['composer', 'global', 'config'], operands: 2, options: ['--unset', '--editor', '-e'], unread: { file: HOME_FILES } },
        { command: ['composer', 'global', 'repository'], writes: ['add', 'remove', 'rm', 'delete', 'set-url', 'seturl', 'enable', 'disable'], unread: { file: HOME_FILES } },
        { command: ['composer', 'global', 'policy'], writes: ['add-source'], unread: { file: HOME_FILES } },
      ],
      `${CLI}#config`,
      'composer config [options] [setting-key] [setting-value1] ... changes a setting of composer.json (with --global, -g, of COMPOSER_HOME/config.json; with --file, -f, of that file), --unset removes one and --editor (-e) opens the file; with a key alone it shows the value (src/Composer/Command/ConfigCommand.php at 2.11.1). composer repository (repo) add, remove (rm, delete), set-url (seturl), enable and disable change the repositories, list (ls, show) and get-url (geturl) only read them (RepositoryCommand.php). composer policy add-source changes config.policy (PolicyCommand.php). config, repository and policy all take --global (-g, "Apply command to the global config file") and --file (-f, "If you want to choose a different composer.json or config.json"). The same commands after composer global change the files of COMPOSER_HOME: GlobalCommand runs them in the home directory, where composer.json is the one of composer global and config.json the configuration that Factory::createConfig merges under that of every project. depcurfew reads neither file (decision D-133), so a change there counts also without an install next to it (unread).',
    ),
    configCommandValues: ciOverrides.verified(
      {
        command: ['composer', 'config'],
        section: 'config',
        booleans: ['policy', 'secure-http', 'disable-tls', 'allow-plugins'],
        accepted: ['true', 'false', '1', '0'],
        falseValues: ['false', '0'],
        period: 'policy.cooldown.period',
        otherFile: ['--global', '-g', '--file', '-f'],
      },
      `${SRC}/Command/ConfigCommand.php`,
      'composer config KEY VALUE writes the setting into config of composer.json (JsonConfigSource::addConfigSetting at 2.11.1; --global, -g, --file and -f write another file, configCommands). ConfigCommand::execute at 2.11.1 takes a key of the form policy.<list> (policy.cooldown, policy.malware) and the block keys (policy.cooldown.block, policy.malware.block), secure-http, disable-tls and allow-plugins only with true, false, 1 or 0 ($booleanValidator) and stores $val !== \'false\' && (bool) $val ($booleanNormalizer), so false and 0 are false; policy.cooldown.period takes a duration CooldownPolicyConfig::parseDuration reads, or null or the empty text for none, a number as an integer; policy.malware.block-scope one of all, update and install, as written. addConfigSetting nests a key that starts with policy. at its dots under config (policy.cooldown false gives "config": {"policy": {"cooldown": false}}), replacing the object that was there. So composer config policy.cooldown false in CI turns the cooldown off in the composer.json the later commands read.',
    ),
    applicationOptions: verified<readonly ApplicationOption[]>(
      [
        { name: 'help', shortcuts: ['h'], value: 'none' },
        { name: 'quiet', shortcuts: ['q'], value: 'none' },
        { name: 'verbose', shortcuts: ['v', 'vv', 'vvv'], value: 'none' },
        { name: 'version', shortcuts: ['V'], value: 'none' },
        { name: 'ansi', shortcuts: [], value: 'negatable' },
        { name: 'no-interaction', shortcuts: ['n'], value: 'none' },
        { name: 'profile', shortcuts: [], value: 'none' },
        { name: 'no-plugins', shortcuts: [], value: 'none' },
        { name: 'no-scripts', shortcuts: [], value: 'none' },
        { name: 'working-dir', shortcuts: ['d'], value: 'required' },
        { name: 'no-cache', shortcuts: [], value: 'none' },
      ],
      `${SRC}/Console/Application.php`,
      'Composer finds the command name before it knows the command (getCommandNameBeforeBinding: "This ensures we can find the correct command name even if a global input option is present before it"): it binds the words to the input definition of the application, ignoring the error that stops the binding (an option it does not define, a missing value, a second argument), and takes $input->getFirstArgument(). The definition is that of symfony/console (Application::getDefaultInputDefinition at v5.4.55: the command argument, --help -h, --quiet -q, --verbose -v|vv|vvv, --version -V, --ansi|--no-ansi, --no-interaction -n) with the --profile, --no-plugins, --no-scripts, --working-dir -d (with a value) and --no-cache of Composer. ArgvInput::getFirstArgument (v5.4.55) passes over each word that starts with -, and also over the next word when the option is one the binding set (a long name, or the last letter of a short one) and that word equals its bound value; the first other word is the command. So only -d and --working-dir take the word after them before the command, an option of a command (--ignore-platform-req) does not, and that command later binds the word after it as its value (Input/ArgvInput.php: parse, addLongOption, parseShortOptionSet).',
    ),
    scriptCommands: verified<ComposerScriptCommandsKnowledge>(
      {
        scripts: 'scripts',
        aliases: 'scripts-aliases',
        events: [
          'pre-install-cmd',
          'post-install-cmd',
          'pre-update-cmd',
          'post-update-cmd',
          'pre-status-cmd',
          'post-status-cmd',
          'pre-autoload-dump',
          'post-autoload-dump',
          'post-root-package-install',
          'post-create-project-cmd',
          'pre-archive-cmd',
          'post-archive-cmd',
        ],
        validName: '^[^:]+(?::[^:]+)*$',
      },
      `${SRC}/Console/Application.php`,
      'doRunComposer registers the scripts of the composer.json it runs with (Factory::getComposerFile, after -d) as commands when the command word is not the exact name of a command Composer found before (mayNeedScriptCommand: "$rawCommandName !== $commandName", so also for an alias, an abbreviation, another case or a word that names no command) or the command is run-script. Each key of scripts that is no event (the constants of src/Composer/Script/ScriptEvents.php, compared in upper case with - as _) and not already a command or alias ($this->has($script): "A script named ... would override a Composer command and has been skipped") becomes a ScriptAliasCommand with the aliases that scripts-aliases gives it. Application::add of symfony/console (v5.4.55) maps the name and each alias to it, over an alias or name of another command; Command::setName and setAliases reject a name that is not parts without a colon separated by single colons (validateName), and ScriptAliasCommand an alias that is not a string, which stops Composer. find() then resolves the word among all of them: the exact name or alias, else the names that start with it. ScriptAliasCommand runs the script as composer run-script does (src/Composer/Command/ScriptAliasCommand.php).',
    ),
    scriptAliases: verified(
      { key: 'scripts-aliases', since: '2.7.0' },
      CHANGELOG,
      '2.7.0: "Added `scripts-aliases` top level key in composer.json to define aliases for custom scripts you defined" (#11666). Application::doRunComposer at 2.6.6 and 2.2.25 (src/Composer/Console/Application.php) registers each script of composer.json as a ScriptAliasCommand without aliases ($this->add(new Command\\ScriptAliasCommand($script, $description))), and from 2.7.0 with $composer[\'scripts-aliases\'][$script]. So on Composer 2.2 LTS to 2.6 a word that scripts-aliases gives a script is still the Composer command or alias of that name (r is require).',
    ),
    rootStability: verified<ComposerRootStabilityKnowledge>(
      { minimumStability: 'minimum-stability', preferStable: 'prefer-stable', values: ['stable', 'rc', 'beta', 'alpha', 'dev'] },
      `${SRC}/Package/Loader/RootPackageLoader.php`,
      'RootPackageLoader reads minimum-stability of the root composer.json through VersionParser::normalizeStability (composer/semver 3.6.0: lower case, one of stable, RC, beta, alpha and dev, else an exception) and prefer-stable as (bool) $config[\'prefer-stable\']. composer require without a constraint takes the minimum stability of composer.json (PackageDiscoveryTrait::getMinimumStability) for the versions it considers and asks VersionSelector::findBestCandidate for a version with the preferred stability "stable" under prefer-stable, else the minimum stability (RequireCommand.php): versions at least that stable come first, the highest of them, else the most stable of the others. The solver orders the versions a constraint allows with DefaultPolicy::versionCompare: with prefer-stable the more stable one first, else the higher version, which a branch (dev-main aliased 3.x-dev) is. All at 2.11.1 (src/Composer/Package/Version/VersionSelector.php, src/Composer/DependencyResolver/DefaultPolicy.php, src/Composer/Command/PackageDiscoveryTrait.php).',
    ),
    installPreference: verified<ComposerInstallPreferenceKnowledge>(
      { setting: 'preferred-install', default: 'dist', dist: 'dist', source: 'source', auto: 'auto', everything: '*' },
      `${SRC}/Downloader/DownloadManager.php`,
      'DownloadManager::getAvailableSources offers source before dist (each only with a type) and reverses them "in case dist is the preferred source for this package": unless preferSource, when preferDist or resolvePackageInstallPreference says dist. BaseCommand::getPreferredInstallOptions sets preferSource for config.preferred-install "source" and preferDist for "dist" (Config::$defaultConfig has "dist"), and neither for "auto", another string or an object; Factory::createDownloadManager hands an object to setPreferences. resolvePackageInstallPreference takes the first key that matches the package name ({^pattern$}i with * as .*): "dist", or "auto" for a version that is not dev, gives dist, any other value source; with no match, source for a dev version (a branch) and dist for others. Config::merge turns the default "dist" into {"*": "dist"} under an object of composer.json and moves the "*" key to the end. --prefer-source, --prefer-dist and --prefer-install override it for one command. All at 2.11.1 (src/Composer/Command/BaseCommand.php, src/Composer/Factory.php, src/Composer/Config.php).',
    ),
    sourceFallback: verified(
      { since: '2.10.0', setting: 'source-fallback', removedIn: '2.11.0' },
      CHANGELOG,
      '2.10.0: "Disabled automatic fallback to source checkout if dist/zip install fails, we have introduced a new source-fallback config option as a temporary way to restore the old behavior" (#12885); 2.11.0-RC1: "Removed the source-fallback config option which was added in 2.10 as a temporary measure, dist installs no longer fall back to source" (#13050). DownloadManager::download at 2.11.1 only falls back from source to dist ("Only fallback from dist to source is risky as it can silently switch to less-trusted code"). Composer before 2.10.0 installs a package from its source when the download of its archive fails.',
    ),
    registrySourceHosts: verified(
      { 'api.github.com': 'github.com', 'gitlab.com': 'gitlab.com', 'bitbucket.org': 'bitbucket.org', 'codeberg.org': 'codeberg.org' },
      `${SRC}/Repository/Vcs/GitHubDriver.php`,
      'The host of the source that the VCS driver gives a package whose archive comes from a host of registryDistHosts: GitHubDriver::getSource https://github.com/<owner>/<repo>.git (git@github.com:<owner>/<repo>.git for a private repository) beside its archive on api.github.com; GitLabDriver::getSource the http_url_to_repo or ssh_url_to_repo of the project on gitlab.com; GitBitbucketDriver::getSource the URL of the repository on bitbucket.org; ForgejoDriver::getSource its clone URL on codeberg.org (src/Composer/Repository/Vcs/*Driver.php at 2.11.1).',
    ),
    sourceHostAliases: verified(
      { 'www.github.com': 'github.com' },
      `${SRC}/Repository/Vcs/GitHubDriver.php`,
      'GitHubDriver::initialize at 2.11.1 reads the host of the repository URL in lower case and takes www.github.com for github.com ("if ($this->originUrl === \'www.github.com\') { $this->originUrl = \'github.com\'; }"), and GitHubDriver::supports compares the host without www. with github-domains. GitLabDriver::determineOrigin compares the host (with its port) with gitlab-domains as written, GitBitbucketDriver::supports takes only https://bitbucket.org/…, and ForgejoDriver compares the host with forgejo-domains as written (src/Composer/Repository/Vcs/*Driver.php at 2.11.1), so only GitHub has such a host.',
    ),
    directoryOptions: verified<DirectoryOptionsKnowledge>(
      { options: [{ name: '--working-dir', moves: 'directory' }, { name: '-d', moves: 'directory' }], variables: [], lookup: 'first-token' },
      `${CLI}#global-options`,
      '"--working-dir (-d): If specified, use the given directory as working directory." Application::doRunComposer changes to it before it reads composer.json (src/Composer/Console/Application.php at 2.11.1). Without it and without composer.json in the current directory (and for a command other than list, init, about, help, diagnose, self-update, global, create-project and outdated), Composer looks for the nearest parent with one, stopping before the home directory and the root of the file system: an interactive run asks whether to use it, use-parent-dir true uses it without asking, and a run without a terminal (stdin not a TTY, or COMPOSER_NO_INTERACTION) with the default use-parent-dir "prompt" (Config::$defaultConfig in src/Composer/Config.php) stays in the current directory and only says so; with --working-dir it never looks at a parent. It then registers the scripts (Application.php) and reads minimum-stability (PackageDiscoveryTrait::getMinimumStability) of Factory::getComposerFile() in the directory it is in. getNewWorkingDir reads the directory with $input->getParameterOption([\'--working-dir\', \'-d\'], null, true), which in symfony/console v5.4.55 (Input/ArgvInput.php) takes the first word, up to --, that is --working-dir or -d (then the next word) or starts with --working-dir= or -d (then the rest of the word); a grouped -nd dir does not start with -d, so Composer stays where it is, although the command later binds -n and -d dir as options.',
    ),
  },
};
