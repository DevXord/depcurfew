import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-03');

// bundler.io is built from the man pages in bundler/lib/bundler/man of ruby/rubygems; the code is read at the same tag.
// Since 4.0.18 RubyGems and Bundler share the tag v<version>; v4.0.23 (2026-10-14) is the latest release.
const RUBYGEMS = 'https://github.com/ruby/rubygems/blob/v4.0.23';
const BUNDLER = `${RUBYGEMS}/bundler`;
const LIB = `${BUNDLER}/lib/bundler`;
const CHANGELOG = `${BUNDLER}/CHANGELOG.md`;
const CONFIG = `${LIB}/man/bundle-config.1.ronn`;
const GEMFILE = `${LIB}/man/gemfile.5.ronn`;
const INSTALL = `${LIB}/man/bundle-install.1.ronn`;
const UPDATE = `${LIB}/man/bundle-update.1.ronn`;
const DSL = `${LIB}/dsl.rb`;
const SETTINGS = `${LIB}/settings.rb`;
const RESOLVER = `${LIB}/resolver.rb`;
const SHARED_HELPERS = `${LIB}/shared_helpers.rb`;
// The announcement on the RubyGems blog, read in its source repository (rubygems/rubygems.github.io, commit 40cef7c).
const BLOG = 'https://blog.rubygems.org/2026/06/03/cooldown-let-new-gems-be-vetted.html';

const noSourceSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(null, CONFIG, `No setting of bundle-config(1) allows or forbids ${kind} (concluded from the documented settings and the keys of settings.rb).`),
});

const noSourceKind = (kind: string): SourceKnowledge => ({
  setting: uncertain(
    null,
    GEMFILE,
    `Bundler has no ${kind} source: a gem comes from a gem server (source), a git repository (git:, github: and the other git sources) or a directory (path:, which "must point to a directory containing the gem's unpacked source code, not to a packaged .gem file"); plugin sources are not covered.`,
  ),
});

export const bundler: ToolKnowledge = {
  id: 'bundler',
  name: 'Bundler',
  kind: 'package-manager',
  ecosystem: 'rubygems',
  cooldown: {
    setting: verified(
      'cooldown',
      DSL,
      'The cooldown: keyword of a source call in the Gemfile (source "https://rubygems.org", cooldown: 7): Dsl#source raises InvalidOption unless it is an Integer of 0 or more. It applies to the versions that come from that source (Source::Rubygems::Remote#effective_cooldown), cooldown: 0 exempts the source. The cooldown setting (bundle config set cooldown N, BUNDLE_COOLDOWN) and --cooldown N take its place for every source, also one with cooldown: 0 (extra.cooldownSetting).',
    ),
    configFiles: verified(['Gemfile', 'gems.rb'], SHARED_HELPERS, 'The keyword is written in the Gemfile, or in gems.rb, which Bundler reads in its place (extra.gemfileNames).'),
    cliFlag: verified(
      '--cooldown',
      CHANGELOG,
      'bundle install, update, add and outdated take --cooldown N since 4.0.13, bundle lock and bundle cache since 4.0.18 ("Add --cooldown flag to bundle lock and bundle cache", #9725); method_option "cooldown" of these commands in lib/bundler/cli.rb. N is a whole number of days of 0 or more (CLI::Common.validate_cooldown!); it overrides the cooldown setting and the keyword of every source for that run, and 0 turns the cooldown off (bundle-install(1)).',
    ),
    unit: verified('days', RESOLVER, 'Resolver#cooldown_excluded? holds back a version while (now - created_at) < days * 86_400. The keyword and the flag take whole days only; the setting is read with to_i (extra.cooldownSetting).'),
    availableSince: verified(
      '4.0.13',
      CHANGELOG,
      '"Add `cooldown` to delay newly published gem" (#9576) under 4.0.13 / 2026-06-03. Bundler 4.0.12 and 2.7.2 ignore an option of source they do not know without a word (extra.olderVersions). Until 4.0.14 the keyword of a Gemfile source was lost once Gemfile.lock existed (extra.cooldownWithLockfile).',
    ),
    default: verified([{ since: '4.0.13', value: null }], CONFIG, '"Defaults to unset (no cooldown)"; the blog post calls the feature opt-in.'),
    exclude: {
      setting: uncertain(
        null,
        CONFIG,
        'No setting exempts single gems: the cooldown setting and --cooldown apply to every source, the keyword to one source, and settings.rb has no other cooldown key (concluded from the documented settings and the code). The documented way to take a newer version of one gem sooner is bundle update GEM --cooldown 0, with --conservative to keep its dependencies where they are (bundle-update(1)).',
      ),
    },
    securityUpdates: verified(
      'applies',
      BLOG,
      'The resolver holds back every version younger than the cooldown, a fix included (Resolver#cooldown_excluded? has no exception); the post names --cooldown 0 as the way to take "the freshest release" when "a fix lands for an actively exploited 0-day".',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      `${LIB}/rubygems_gem_installer.rb`,
      'Bundler::RubyGemsGemInstaller#install builds the native extensions of a gem whose gemspec lists any (build_extensions if spec.extensions.any?); Gem::Ext::Builder runs the extconf.rb, configure, Rakefile or mkrf_conf, CMakeLists.txt or Cargo.toml of the gem (lib/rubygems/ext/builder.rb at the same tag), code of the gem that runs when it is installed.',
    ),
    allowList: {
      setting: uncertain(
        null,
        CONFIG,
        'No setting allows or blocks the build of single gems (concluded from the documented settings); build.<gem> only passes flags to the build ("BUILD OPTIONS").',
      ),
    },
    disableAll: uncertain(
      null,
      CONFIG,
      'No setting or option turns the builds off (concluded from the documented settings of bundle-config(1) and the options of bundle-install(1)); force_ruby_platform even builds gems from source that have a precompiled platform gem.',
    ),
  },
  sources: {
    git: noSourceSetting('git sources'),
    remoteTarball: noSourceKind('archive URL'),
    file: noSourceKind('local archive'),
    directory: noSourceSetting('path sources'),
  },
  project: {
    lockfiles: verified(
      [{ since: '0.0.0', value: ['Gemfile.lock', 'gems.locked'] }],
      SHARED_HELPERS,
      'SharedHelpers#default_lockfile: gems.locked for gems.rb, else the name of the Gemfile with .lock; BUNDLE_LOCKFILE names another file.',
    ),
    manifests: verified(['Gemfile', 'gems.rb'], SHARED_HELPERS, 'SharedHelpers#gemfile_names; BUNDLE_GEMFILE names another file.'),
    workspaces: uncertain(null, GEMFILE, 'Bundler has no workspaces: a Gemfile describes one bundle (concluded from gemfile(5)).'),
    workspacesObjectKey: uncertain(null, GEMFILE, 'No workspaces.'),
  },
  extra: {
    latestVersion: verified(
      '4.0.23',
      'https://rubygems.org/api/v1/versions/bundler/latest.json',
      '{"version":"4.0.23"} on 2026-11-03; 4.0.23 / 2026-10-14 in bundler/CHANGELOG.md. 4.1.0.beta3 (2026-10-28) is a pre-release.',
    ),
    gemfileNames: verified(
      ['gems.rb', 'Gemfile'],
      SHARED_HELPERS,
      'SharedHelpers#find_gemfile looks for gems.rb, then Gemfile, from the current directory up; with both in one directory Bundler warns ("Multiple gemfiles (gems.rb and Gemfile) detected") and reads gems.rb.',
    ),
    rubygemsSource: verified(
      { url: 'https://rubygems.org', method: 'source' },
      GEMFILE,
      '"At the top of the Gemfile, add a single line for the RubyGems source": source "https://rubygems.org" ("GLOBAL SOURCE"); bundle init writes the same line (lib/bundler/templates/Gemfile). A source call with a block (source "…" do … end) declares a source for the gems in the block only.',
    ),
    cooldownWithLockfile: verified(
      { since: '4.0.14', scope: 'once Gemfile.lock exists' },
      CHANGELOG,
      '"Preserve per-source cooldown when converging sources from the lockfile" (#9601) under 4.0.14 / 2026-06-10. The test "applies per-source Gemfile cooldown on bundle update when a lockfile exists" (spec/install/cooldown_spec.rb) says: "Converging the Gemfile sources with the lockfile sources used to drop the per-source cooldown, so it only ever worked on a first resolve without a lockfile." SourceList#replace_rubygems_source carries remote_cooldowns over since then (lib/bundler/source_list.rb, missing at bundler-v4.0.13). The cooldown setting and --cooldown work from 4.0.13.',
    ),
    cooldownSetting: verified(
      { key: 'cooldown', variable: 'BUNDLE_COOLDOWN', localFile: '.bundle/config', localDirectoryVariable: 'BUNDLE_APP_CONFIG', order: ['--cooldown', 'local', 'environment', 'global', 'source'] },
      CONFIG,
      'cooldown (BUNDLE_COOLDOWN): "Number of days a published gem version must age before bundler will resolve to it"; "The CLI flag and this setting apply uniformly to every source, including ones declared with their own cooldown: value." Bundler reads settings from the local config (<project_root>/.bundle/config or $BUNDLE_APP_CONFIG/config), then the environment, then the global config (~/.bundle/config); BUNDLE_IGNORE_CONFIG ignores the files. Remote#effective_cooldown takes the setting when it is set and the keyword of the source otherwise (lib/bundler/source/rubygems/remote.rb).',
    ),
    cooldownSettingValues: verified(
      { conversion: 'to_i', falseValue: 'unset' },
      SETTINGS,
      'cooldown is one of NUMBER_KEYS, so Settings#converted_value reads its value with String#to_i: "7 days" is 7, and a value that does not start with a digit, the empty one included, is 0, which turns the cooldown off (the resolver skips 0 and less); "false" is read as false, which counts as unset, so the keyword of the source applies. Values are not checked when they are set (lib/bundler/settings/validator.rb has no rule for cooldown).',
    ),
    lockedVersions: verified(
      'exempt',
      RESOLVER,
      'Resolver#locked_by_lockfile?: "A version already written to the lockfile has been adopted, and cooldown only governs the adoption of new versions", except for the gems named on bundle update GEM or bundle lock --update GEM. bundle install with an existing Gemfile.lock installs the locked versions, a gem added to the Gemfile since then is resolved with the cooldown, and a frozen install reads the lockfile without resolving (the tests "bypasses cooldown when bundle install uses an existing lockfile", "applies per-source Gemfile cooldown to gems added after the lockfile was written" and "ignores cooldown and installs the locked version when frozen" in spec/install/cooldown_spec.rb). The blog post: "an existing Gemfile.lock is always honored as-is".',
    ),
    missingTimestamp: verified(
      'Versions without a created_at date are not held back (fail open)',
      CONFIG,
      'The cooldown "depends on the gem server providing a per-version created_at timestamp in the v2 compact-index format. Versions without that metadata - older gem servers, historical entries that predate the v2 cutover on rubygems.org, or private registries that still emit the v1 format - are treated as outside the cooldown window and remain resolvable." The test "cannot apply cooldown and installs the latest version" (spec/install/cooldown_spec.rb) shows the same for the dependency API.',
    ),
    allTooNew: verified(
      'excluded by the cooldown setting; pass `--cooldown 0` to bypass',
      RESOLVER,
      'Resolver#cooldown_hint adds "N versions excluded by the cooldown setting; pass `--cooldown 0` to bypass" to the error when the cooldown leaves no version that fits; Bundler stops instead of taking a newer version (test "surfaces a cooldown hint when bundle update filters every candidate").',
    ),
    olderVersions: verified(
      'ignored',
      'https://github.com/ruby/rubygems/blob/bundler-v4.0.12/bundler/lib/bundler/dsl.rb',
      'Dsl#source of 4.0.12 reads only the type option of source and drops the others without a word, as does that of 2.7.2 (https://github.com/ruby/rubygems/blob/bundler-v2.7.2/bundler/lib/bundler/dsl.rb), so a Gemfile with cooldown: works there and has no delay.',
    ),
    lockfileVersion: verified(
      { section: 'BUNDLED WITH', variable: 'BUNDLER_VERSION', setting: 'version', update: 'bundle update --bundler' },
      `${LIB}/self_manager.rb`,
      'Gemfile.lock ends with BUNDLED WITH and the version of the Bundler that wrote it (LockfileGenerator, LockfileParser::BUNDLED). bundle install installs that version and restarts with it, and the other commands restart with it when it is installed (SelfManager#install_locked_bundler_and_restart_with_it_if_needed and #restart_with_locked_bundler_if_needed), unless BUNDLER_VERSION is set or the version setting is system (its default is lockfile, bundle-config(1)). bundle update --bundler[=VERSION] changes the locked version ("With no argument, update to the latest released version", bundle-update(1)).',
    ),
    resolveCommands: verified(
      { executables: ['bundle', 'bundler'], commands: ['install', 'update', 'lock', 'add', 'cache'], option: '--cooldown' },
      INSTALL,
      'The gem installs the executables bundle and bundler (s.executables in bundler.gemspec). bundle install, update, lock (bundle-lock(1)), add (which runs bundle install) and cache resolve the Gemfile and take --cooldown (cli.rb); bundle outdated only reads versions.',
    ),
    gemInstall: verified(
      { command: ['gem', 'install'], name: 'bundler', versionOptions: ['-v', '--version'], separator: ':' },
      `${RUBYGEMS}/lib/rubygems/command.rb`,
      'gem install bundler -v 4.0.23 (or --version, Gem::VersionOption#add_version_option in lib/rubygems/version_option.rb) and gem install bundler:4.0.23 (Gem::Command#extract_gem_name_and_version) install that Bundler.',
    ),
    configLocal: verified(
      { file: '.bundle/config', ignoredBy: 'bundle gem' },
      `${LIB}/templates/newgem/gitignore.tt`,
      'bundle config set --local writes <project_root>/.bundle/config, which also holds machine paths such as path (bundle-config(1)); the .gitignore that bundle gem writes for a new gem ignores /.bundle/.',
    ),
    updateCommand: verified(
      'bundle update GEM --cooldown 0 --conservative',
      UPDATE,
      '--cooldown 0 disables the cooldown "for this run, overriding any per-source or global configuration. Combine with --conservative to minimize transitive churn when bypassing cooldown for an urgent update."',
    ),
    dependencySources: verified(
      ['git', 'directory'],
      GEMFILE,
      'Of the kinds of sources a policy names, a Gemfile can declare git sources (GIT, GITHUB and the other git sources) and path sources (PATH), with no setting that forbids them; it has no source for an archive URL or a local archive.',
    ),
  },
};
