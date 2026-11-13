import { verifiedOn } from './define.ts';
import type { SourceKnowledge, ToolKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-12');
const toolchain = verifiedOn('2026-11-13');

/**
 * The cargo of Rust 1.100.0, the first Rust whose Cargo respects min-publish-age (E05). channel-rust-1.100.0.toml names
 * cargo 0.101.0 (3acc79c0c 2026-11-05), and the tag 0.101.0 of rust-lang/cargo (branch rust-1.100.0) is this commit.
 * Every fact about Cargo cites this commit, never a branch or a beta.
 */
export const CARGO_RELEASE = 'https://github.com/rust-lang/cargo/blob/3acc79c0c841844675bc53a605922dbfc441e750';
/** The release manifest of Rust 1.100.0, which names the cargo of that release. */
export const RUST_1_100_MANIFEST = 'https://static.rust-lang.org/dist/channel-rust-1.100.0.toml';
/** rustup 1.29.3, the latest release on 2026-11-13 (tag 1.29.3), which picks the toolchain of a directory (E06). */
export const RUSTUP_RELEASE = 'https://github.com/rust-lang/rustup/blob/edbc831cec44dc2858a4a4dce768c74361d027dc';
/** The manifest of the channel 1.99: rustup's channel X.Y is the latest X.Y.z release (it names 1.99.1). */
const RUST_1_99_CHANNEL = 'https://static.rust-lang.org/dist/channel-rust-1.99.toml';

const CONFIG = `${CARGO_RELEASE}/doc/book/src/reference/config.md`;
const ENVIRONMENT = `${CARGO_RELEASE}/doc/book/src/reference/environment-variables.md`;
const UNSTABLE = `${CARGO_RELEASE}/doc/book/src/reference/unstable.md`;
const RESOLVER_DOC = `${CARGO_RELEASE}/doc/book/src/reference/resolver.md`;
const BUILD_SCRIPTS = `${CARGO_RELEASE}/doc/book/src/reference/build-scripts.md`;
const SPECIFYING = `${CARGO_RELEASE}/doc/book/src/reference/specifying-dependencies.md`;
const MANIFEST = `${CARGO_RELEASE}/doc/book/src/reference/manifest.md`;
const WORKSPACES = `${CARGO_RELEASE}/doc/book/src/reference/workspaces.md`;
const VERSION_PREFS = `${CARGO_RELEASE}/src/resolver/version_prefs.rs`;
const TIME_SPAN = `${CARGO_RELEASE}/src/util/time_span.rs`;
const SCHEMA = `${CARGO_RELEASE}/src/context/schema.rs`;
const DE = `${CARGO_RELEASE}/src/context/de.rs`;
const TESTS = `${CARGO_RELEASE}/tests/testsuite/min_publish_age.rs`;

const noSourceSetting = (kind: string): SourceKnowledge => ({
  setting: uncertain(null, CONFIG, `No key of the Cargo configuration allows or forbids ${kind} (concluded from config.md, which lists every key).`),
});

const noSourceKind = (kind: string): SourceKnowledge => ({
  setting: uncertain(null, SPECIFYING, `Cargo has no ${kind} dependency: a dependency comes from a registry, a git repository or a path to a directory with a Cargo.toml.`),
});

export const cargo: ToolKnowledge = {
  id: 'cargo',
  name: 'Cargo',
  kind: 'package-manager',
  ecosystem: 'crates',
  cooldown: {
    setting: verified(
      'registry.global-min-publish-age',
      `${CONFIG}#registryglobal-min-publish-age`,
      'A TOML string in the [registry] table of a Cargo configuration file: "Specifies the global minimum timespan since a version\'s `pubtime` that it may be considered for `resolver.incompatible-publish-age`". registries.<name>.min-publish-age takes its place for one registry (extra.registryMinPublishAge), and resolver.incompatible-publish-age = "allow" turns the check off (extra.resolverSwitch).',
    ),
    configFiles: verified(
      ['.cargo/config.toml'],
      `${CONFIG}#hierarchical-structure`,
      'Cargo reads .cargo/config.toml in the current directory and every parent directory, then $CARGO_HOME/config.toml; .cargo/config without the extension is the older name, still read. --config and environment variables take precedence over the files.',
    ),
    cliFlag: verified(
      null,
      `${CONFIG}#command-line-overrides`,
      'No flag of its own: --config KEY=VALUE sets any key for one command, so --config \'registry.global-min-publish-age="0"\' turns the delay off for it.',
    ),
    unit: verified(
      'duration-string',
      TIME_SPAN,
      'parse_time_span: a whole number of 0 or more, at most one space, and second(s), minute(s), hour(s), day(s), week(s) or month(s) (a month is 2,629,746 seconds); "0" alone means no delay. Anything else is an error that stops resolution ("invalid value for `registry.global-min-publish-age`").',
    ),
    availableSince: verified(
      '1.100.0',
      UNSTABLE,
      '"Minimum publish-age configuration for dependency resolution was stabilized in Rust 1.100." Versions of Cargo are given as the version of the Rust release that ships it (cargo 0.101.0 ships with Rust 1.100.0); each key says "MSRV: Respected as of 1.100+".',
    ),
    default: verified([{ since: '1.100.0', value: null }], `${CONFIG}#registryglobal-min-publish-age`, 'Default: "0", which allows all packages: no delay.'),
    exclude: {
      setting: uncertain(
        null,
        CONFIG,
        'No key exempts single crates: min-publish-age is set for every registry (registry.global-min-publish-age) or for one registry (registries.<name>.min-publish-age), and config.md lists no other publish-age key (concluded from the documented keys and the schema).',
      ),
    },
    securityUpdates: verified(
      'applies',
      VERSION_PREFS,
      'PublishAgePolicy::too_new holds back every version whose pubtime is newer than the threshold, a fix included; the resolver docs name resolver.incompatible-publish-age = "allow" with cargo update --precise as the way to take one version sooner.',
    ),
  },
  installScripts: {
    defaultPolicy: verified(
      [{ since: '0.0.0', value: 'run' }],
      BUILD_SCRIPTS,
      'Placing a file named build.rs in the root of a package "will cause Cargo to compile that script and execute it just before building the package"; procedural macros run in the compiler as well. Both run at cargo build, check and test, from every dependency.',
    ),
    allowList: { setting: uncertain(null, CONFIG, 'No key of the Cargo configuration allows the build scripts of some dependencies only (concluded from config.md).') },
    disableAll: uncertain(null, CONFIG, 'No key or flag keeps build scripts or procedural macros of dependencies from running (concluded from config.md).'),
  },
  project: {
    lockfiles: verified([{ since: '0.0.0', value: ['Cargo.lock'] }], WORKSPACES, '"All packages share a common Cargo.lock file which resides in the workspace root"; a package that is no workspace member has its own next to Cargo.toml.'),
    manifests: verified(['Cargo.toml'], MANIFEST, '"The Cargo.toml file for each package is called its manifest."'),
    workspaces: verified(
      { files: ['Cargo.toml'], key: 'workspace', excludeKey: 'exclude' },
      WORKSPACES,
      'The [workspace] table of the root Cargo.toml lists members and exclude; members takes globs ("crates/*"), the root package is a member too, and path dependencies of members become members.',
    ),
    workspacesObjectKey: verified('members', `${WORKSPACES}#the-members-and-exclude-fields`, 'members = ["member1", "path/to/member2", "crates/*"] in [workspace].'),
  },
  sources: {
    git: noSourceSetting('git dependencies'),
    remoteTarball: noSourceKind('tarball URL'),
    file: noSourceKind('local archive'),
    directory: noSourceSetting('path dependencies'),
  },
  extra: {
    durationUnits: verified(
      ['minutes', 'hours', 'days', 'weeks'],
      TIME_SPAN,
      'The units depcurfew writes, each of which parse_time_span accepts in the singular and the plural; it also accepts seconds and months, which depcurfew does not write.',
    ),
    registryMinPublishAge: verified(
      { key: 'registries.<name>.min-publish-age', winsOverGlobal: true, cratesIo: 'crates-io' },
      VERSION_PREFS,
      'PublishAgePolicy::min_age takes registries.<name>.min-publish-age before registry.global-min-publish-age, and names crates.io crates-io (CRATES_IO_REGISTRY), so [registries.crates-io] min-publish-age = "0" turns the delay off for crates.io under any global value (test registries_crates_io_overrides_global in tests/testsuite/min_publish_age.rs). The comment "registries other than crates.io" in config.md is about the other keys of [registries.<name>].',
    ),
    resolverSwitch: verified(
      { key: 'resolver.incompatible-publish-age', values: ['allow', 'deny'], default: 'deny', turnsOff: 'allow' },
      `${CONFIG}#resolverincompatible-publish-age`,
      '"allow: treat pubtime-incompatible versions like any other version"; with it PublishAgePolicy::new returns no policy (src/resolver/version_prefs.rs). deny keeps versions already in Cargo.lock.',
    ),
    environment: verified(
      { global: 'CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE', resolver: 'CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE' },
      ENVIRONMENT,
      'The environment variables of registry.global-min-publish-age and resolver.incompatible-publish-age; they take precedence over the configuration files.',
    ),
    registryVariable: uncertain(
      { prefix: 'CARGO_REGISTRIES_', suffix: '_MIN_PUBLISH_AGE', name: 'as-written', needsTable: true },
      DE,
      'environment-variables.md documents CARGO_REGISTRIES_<name>_MIN_PUBLISH_AGE. The registries map takes its names from the tables of the configuration files and --config (ConfigMapAccess::new_map) and puts each into the variable as it is written (push_sensitive), so Cargo reads CARGO_REGISTRIES_crates-io_MIN_PUBLISH_AGE, and only when a file or --config defines [registries.crates-io]; without -Zadvanced-env a variable alone adds no registry. The spelling in capitals is not read on Linux; how Windows compares the names of variables is not established. Both spellings count (fail closed).',
    ),
    timeSpan: uncertain(
      {
        units: { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_629_746 },
        zero: '0',
        overflow: 'unchecked',
      },
      TIME_SPAN,
      'maybe_parse_time_span reads the number as a u64 and returns Duration::from_secs(factor * count) without checked_mul. Whether the Cargo that Rust ships checks the overflow of that product or wraps it is not established from the cargo sources, so a product above u64 counts as a possible weakening (fail closed). "0 days" is a delay of zero, like "0".',
    ),
    notCovered: verified(
      { install: true, withoutPubtime: true, lockedVersions: true },
      TESTS,
      'Tests cargo_install_ignores_min_publish_age, versions_without_pubtime_unaffected and locked_versions_preserved: cargo install of a crate from a registry takes no delay, versions a registry gives no pubtime are not held back ("Will be ignored if the registry does not support this", config.md), and versions already in Cargo.lock stay.',
    ),
    resolverDocs: verified(
      'publish-age',
      `${RESOLVER_DOC}#publish-age`,
      'The resolver chapter: versions newer than min-publish-age are pubtime-incompatible; with deny they are ignored unless already in Cargo.lock; allow with cargo update --precise pulls in a version and its transitive dependencies.',
    ),
    schema: verified(
      { registry: 'global-min-publish-age', registries: 'min-publish-age', resolver: 'incompatible-publish-age' },
      SCHEMA,
      'GlobalRegistryConfig, RegistryConfig and CargoResolverConfig in src/context/schema.rs: the keys are TOML strings; [registry] has no min-publish-age of its own (to_registry_config sets it to None).',
    ),
    toolchainFiles: toolchain.verified(
      { files: ['rust-toolchain', 'rust-toolchain.toml'], bothUse: 'rust-toolchain', legacyIn: 'rust-toolchain', key: 'toolchain.channel', walksUp: true },
      `${RUSTUP_RELEASE}/src/config.rs`,
      'Cfg::find_override_from_dir_walk looks in the current directory and each parent for rust-toolchain and rust-toolchain.toml (after the override database of rustup override set); when both are in a directory it uses rust-toolchain and warns. rust-toolchain.toml is TOML only ([toolchain] channel = "..."); rust-toolchain is TOML or the legacy format, a toolchain name alone (ParseMode::Both; doc/user-guide/src/overrides.md). RUSTUP_TOOLCHAIN and a +toolchain argument take precedence over the files.',
    ),
    toolchainChannels: toolchain.verified(
      { named: ['stable', 'beta', 'nightly'], versioned: ['major.minor', 'major.minor.patch'], latestPatchFor: 'major.minor' },
      `${RUSTUP_RELEASE}/doc/user-guide/src/concepts/toolchains.md`,
      '<channel> = stable|beta|nightly|<versioned>[-<prerelease>], <versioned> = <major.minor>|<major.minor.patch>, optionally followed by -<date> and -<host>; a name of any other form is a custom toolchain. The channel 1.99 is the latest 1.99 patch: static.rust-lang.org/dist/channel-rust-1.99.toml names rustc 1.99.1 (read 2026-11-13).',
    ),
    channelManifest: toolchain.verified('1.99.1', RUST_1_99_CHANNEL, 'The manifest of the channel 1.99 names rustc 1.99.1 (58cf8f9c3 2026-10-13), the latest 1.99 release, while channel-rust-1.99.0.toml names 1.99.0: a channel X.Y follows the latest X.Y.z (read 2026-11-13).'),
    latestVersion: verified('1.100.0', RUST_1_100_MANIFEST, 'Rust 1.100.0 (rustc 0ef1bc386 2026-11-09, cargo 0.101.0 3acc79c0c 2026-11-05) is the stable release of 2026-11-12, the date of the manifest.'),
  },
};
