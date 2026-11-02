import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-02');

// getcomposer.org/doc is built from doc/ in the repository; the code is read at the same tag.
const COMPOSER = 'https://github.com/composer/composer/blob/2.11.1';
const CONFIG = `${COMPOSER}/doc/06-config.md`;
const CLI = `${COMPOSER}/doc/03-cli.md`;
const SCHEMA = `${COMPOSER}/doc/04-schema.md`;
const REPOSITORIES = `${COMPOSER}/doc/05-repositories.md`;
const CHANGELOG = `${COMPOSER}/CHANGELOG.md`;
const SRC = `${COMPOSER}/src/Composer`;

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
    latestVersion: verified('2.11.1', CHANGELOG, 'Released on 2026-10-30.'),
    durationStrings: verified(
      { since: '2.11.0', syntax: 'unit-word', numbers: 'seconds' },
      `${SRC}/Policy/CooldownPolicyConfig.php`,
      'parseDuration: an integer, or a string of digits, is a number of seconds; otherwise only /^(\\d+)\\s*(second|minute|hour|day|week)s?$/ is accepted (lowercase, one unit). null, "", 0 and "0" mean no cooldown; any other value makes the command fail with "Invalid policy.cooldown.period format", and so does such a COMPOSER_POLICY_COOLDOWN_PERIOD.',
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
      'getContentHash hashes name, version, require, require-dev, conflict, replace, provide, minimum-stability, prefer-stable, repositories, extra, config.platform and config.policy ("policy changes which versions an update may pick, so changing it should flag the lock as outdated"; CHANGELOG 2.11.0-RC1, #13149). With another hash composer install warns that "The lock file is not up to date with the latest changes in composer.json" (Installer.php) and composer validate fails (03-cli.md#validate); composer update --lock "Overwrites the lock file hash to suppress warning about the lock file being out of date without updating package versions" (03-cli.md#update-u-upgrade). allow-plugins is not hashed.',
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
        source: 'source',
        dist: 'dist',
        pathType: 'path',
        archiveTypes: ['zip', 'tar', 'gzip', 'xz', 'phar', 'rar'],
      },
      `${SRC}/Package/Dumper/ArrayDumper.php`,
      'Each entry of packages and packages-dev has name, version, type and the source { type, url, reference } and dist { type, url, reference, shasum } it installs from, time and, from a repository that gives it, published-time. A package of a path repository has dist type path with the path as url (PathRepository.php); one of an artifact repository has the archive type and its file path as url (ArtifactRepository.php). Plugins are packages of type composer-plugin (04-schema.md#type).',
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
      { setting: 'config.allow-plugins', value: true, patterns: ['*'] },
      `${CONFIG}#allow-plugins`,
      '"or true to allow all plugins to run (NOT recommended)"; a key "*" with true matches every package (BasePackage::packageNameToRegexp).',
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
        { name: 'COMPOSER_NO_BLOCKING', values: { except: ['', '0'] }, effect: 'turns off all policy blocking, the cooldown included' },
        { name: 'COMPOSER_NO_SECURITY_BLOCKING', values: { except: ['', '0'] }, effect: 'turns off blocking of advisories, abandoned packages and the cooldown' },
        { name: 'COMPOSER_POLICY_COOLDOWN_PERIOD', values: 'delay', effect: 'replaces the cooldown period' },
        { name: 'COMPOSER_POLICY_COOLDOWN_BLOCK', values: ['0', 'false', 'off'], effect: 'stops the cooldown from withholding new versions' },
        { name: 'COMPOSER_POLICY_MALWARE_BLOCK', values: ['0', 'false', 'off'], effect: 'stops blocking versions flagged as malware' },
      ],
      `${CLI}#environment-variables`,
      'COMPOSER_POLICY: "Set to 0 to disable all dependency policy enforcement" (read with Platform::getBoolEnv: 0, false and off are false). COMPOSER_NO_BLOCKING and COMPOSER_NO_SECURITY_BLOCKING set --no-blocking and --no-security-blocking when (bool) getenv() is true, so every value but "" and "0" (BaseCommand.php). COMPOSER_POLICY_COOLDOWN_PERIOD "overrides the configured period", 0 disabling it; COMPOSER_POLICY_COOLDOWN_BLOCK and COMPOSER_POLICY_MALWARE_BLOCK set 0 to disable blocking (PolicyConfig.php).',
    ),
  },
};
