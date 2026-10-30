import { createRequire } from "node:module";
import { appendFileSync, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

// \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

// src/knowledge/facts.ts
/** The evidence behind a fact: one entry, or every variant of a disputed fact. */
function evidenceOf(fact) {
	return fact.status === "disputed" ? fact.variants : [fact];
}

// src/apply/version.ts
/** An exact version such as 11.6.0 or v2.9.8; ranges, tags and expressions are not exact. */
function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim());
	return match === null ? void 0 : [
		Number(match[1]),
		Number(match[2]),
		Number(match[3])
	];
}
function compareVersions$1(a, b) {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function formatVersion(version) {
	return version.join(".");
}
/** The first exact version the repository pins, in the order of the detection (packageManager first). */
function pinnedVersion(manager) {
	for (const declaration of manager.versions) {
		const version = "version" in declaration ? parseVersion(declaration.version) : void 0;
		if (version !== void 0) return version;
	}
}

// src/apply/facts.ts
function values$1(fact) {
	return evidenceOf(fact).map((evidence) => evidence.value);
}
/** The first file of a list of configuration files. */
function firstFile(fact) {
	return values$1(fact)[0]?.[0];
}
/** The setting name, or null if any official source says it does not exist. */
function settingOf(fact) {
	if (fact === void 0) return null;
	const all = values$1(fact);
	return all.includes(null) ? null : all[0] ?? null;
}
/** The latest first version among the variants; undefined when not recorded. */
function sinceOf(fact) {
	if (fact === void 0) return void 0;
	const versions = values$1(fact).filter((value) => value !== null && parseVersion(value) !== void 0);
	if (versions.length === 0) return void 0;
	return versions.sort((a, b) => compareVersions$1(parseVersion(a) ?? [
		0,
		0,
		0
	], parseVersion(b) ?? [
		0,
		0,
		0
	])).at(-1);
}
/** A structured fact from `extra`; throws when the knowledge base lacks it, which tests catch. */
function extraOf(tool, key, check) {
	const fact = tool.extra?.[key];
	const value = fact === void 0 ? void 0 : values$1(fact)[0];
	if (!check(value)) throw new Error(`knowledge base: ${tool.id} extra.${key} is missing or malformed`);
	return value;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSwitch(value) {
	return isRecord(value) && typeof value["setting"] === "string" && "value" in value;
}
function isWildcards(value) {
	return isRecord(value) && (typeof value["since"] === "string" || value["since"] === null) && typeof value["trailingOnly"] === "boolean";
}

// src/knowledge/define.ts
/** Fact constructors that stamp every fact of one tool module with the date it was verified. */
function verifiedOn(verifiedAt) {
	function evidence(value, source, note) {
		return note === void 0 ? {
			value,
			source,
			verifiedAt
		} : {
			value,
			source,
			verifiedAt,
			note
		};
	}
	return {
		evidence,
		verified: (value, source, note) => ({
			status: "verified",
			...evidence(value, source, note)
		}),
		uncertain: (value, source, note) => ({
			status: "uncertain",
			...evidence(value, source),
			note
		}),
		disputed: (note, ...variants) => ({
			status: "disputed",
			note,
			variants
		})
	};
}

// src/knowledge/bun.ts
const { verified: verified$12, uncertain: uncertain$11, disputed: disputed$6, evidence: evidence$6 } = verifiedOn("2026-10-28");
const checked$5 = verifiedOn("2026-10-29");
const BUNFIG = "https://bun.com/docs/runtime/bunfig";
const INSTALL$1 = "https://bun.com/docs/pm/cli/install";
const LIFECYCLE = "https://bun.com/docs/pm/lifecycle";
const ADD = "https://bun.com/docs/pm/cli/add";
const BUN_1_4_4 = "https://bun.com/blog/bun-v1.4.4#minimumreleaseage-supports-units-and-per-version-exclusions";
const DOCS_1_3_0 = "https://github.com/oven-sh/bun/blob/bun-v1.3.0/docs/cli/install.md";
const noSetting$6 = (anchor, kind) => ({ setting: uncertain$11(null, `${ADD}#${anchor}`, `${kind} dependencies are supported with no setting to allow or forbid them (concluded from the full bunfig [install] list); install.blockExoticSubdeps is proposed in oven-sh/bun#30340 but not shipped.`) });
const WORKSPACES$2 = "https://github.com/oven-sh/bun/blob/main/docs/pm/workspaces.mdx";
const bun$1 = {
	id: "bun",
	name: "Bun",
	kind: "package-manager",
	cooldown: {
		setting: verified$12("install.minimumReleaseAge", `${BUNFIG}#install-minimumreleaseage`),
		configFiles: verified$12(["bunfig.toml"], BUNFIG, "Also the global $HOME/.bunfig.toml or $XDG_CONFIG_HOME/.bunfig.toml; local keys override global ones. Bun's .npmrc support has no min-release-age key."),
		cliFlag: verified$12("--minimum-release-age", DOCS_1_3_0, "bun install, add and update; bunx honors it only since 1.4.4."),
		unit: verified$12("seconds", `${BUNFIG}#install-minimumreleaseage`, "Plain numbers are seconds; 0 turns it off. Since 1.4.4 duration strings such as 90m, 12 hours, 3d or 2 weeks also work (the bunfig reference still documents seconds only)."),
		availableSince: verified$12("1.3.0", "https://bun.com/blog/bun-v1.3#minimum-release-age"),
		default: disputed$6("The bunfig reference says the default is null (off) and an open docs pull request (oven-sh/bun#41545) says the feature is off by default; the install page lists 259200 (3 days) under \"These are the default values\".", evidence$6([{
			since: "1.3.0",
			value: null
		}], `${BUNFIG}#install-minimumreleaseage`), evidence$6([{
			since: "1.3.0",
			value: 259200
		}], INSTALL$1)),
		exclude: {
			setting: verified$12("install.minimumReleaseAgeExcludes", `${BUNFIG}#install-minimumreleaseageexcludes`),
			availableSince: verified$12("1.3.0", DOCS_1_3_0),
			patternSyntax: verified$12("Exact package names (all versions); since 1.4.4 also name@exactVersion. No wildcards; ranges and tags are ignored with a warning", BUN_1_4_4, "Since 1.4.4 --minimum-release-age-excludes replaces the bunfig list for one command.")
		},
		securityUpdates: uncertain$11("applies", BUN_1_4_4, "No automatic bypass is documented; exempt the fixed release with name@version in minimumReleaseAgeExcludes (1.4.4+). Exact version requests still go through the gate.")
	},
	installScripts: {
		defaultPolicy: verified$12([{
			since: "0.0.0",
			value: "deny-except-allowlist"
		}], `${LIFECYCLE}#trusteddependencies`, "Dependency scripts run only for Bun's built-in trusted list (npm-registry packages only since 1.4) or trustedDependencies; the root project's scripts run. First version of this policy not tracked."),
		allowList: {
			setting: verified$12("trustedDependencies", `${LIFECYCLE}#trusteddependencies`, "Replaces the built-in default list rather than extending it. bun pm trust and bun add --trust write it."),
			file: verified$12("package.json", `${LIFECYCLE}#trusteddependencies`),
			availableSince: uncertain$11("1.0.5", "https://bun.com/blog/release-notes/bun-v1.0.5", "Upper bound: 1.0.5 already persists trustedDependencies in bun.lockb; the first version was not pinned down. bun pm trust and bun add --trust arrived in 1.0.31."),
			format: verified$12("Array of package names, e.g. [\"node-sass\"]", `${LIFECYCLE}#trusteddependencies`)
		},
		disableAll: verified$12("install.ignoreScripts", `${BUNFIG}#install-ignorescripts`, "Default false. Also --ignore-scripts or ignore-scripts=true in .npmrc. Skips the project's own scripts and trustedDependencies too.")
	},
	sources: {
		git: noSetting$6("git-dependencies", "Git"),
		remoteTarball: noSetting$6("tarball-dependencies", "Tarball URL"),
		file: noSetting$6("local-paths", "Local tarball"),
		directory: noSetting$6("local-paths", "Local directory")
	},
	project: {
		lockfiles: uncertain$11([{
			since: "0.0.0",
			value: ["bun.lockb"]
		}, {
			since: "1.2.0",
			value: ["bun.lock", "bun.lockb"]
		}], "https://github.com/oven-sh/bun/blob/main/docs/pm/lockfile.mdx", "Bun 1.2 made the text bun.lock the default (verified). That bun.lockb is still read afterwards is inferred from the documented migration command and from saveTextLockfile = false, which writes bun.lockb."),
		manifests: verified$12(["package.json"], WORKSPACES$2),
		workspaces: verified$12({
			files: ["package.json"],
			key: "workspaces"
		}, WORKSPACES$2, "Full glob syntax, including ! patterns."),
		workspacesObjectKey: verified$12("packages", "https://github.com/oven-sh/bun/blob/main/docs/pm/catalogs.mdx", "The object form also holds catalog and catalogs.")
	},
	extra: {
		commandLine: checked$5.verified({
			add: [["bun", "add"]],
			run: [{
				command: ["bunx"],
				packageOptions: ["-p", "--package"]
			}, {
				command: ["bun", "x"],
				packageOptions: ["-p", "--package"]
			}],
			create: [{
				command: ["bun", "create"],
				packageOptions: []
			}],
			createNames: "prefix",
			valueOptions: [
				"--omit",
				"--filter",
				"--ca",
				"--cafile",
				"--registry",
				"--network-concurrency",
				"--backend",
				"--concurrent-scripts",
				"--cache-dir",
				"--config",
				"--cwd",
				"--env-file",
				"--minimum-release-age"
			]
		}, "https://github.com/oven-sh/bun/tree/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/snippets/cli", "Options of bun add (snippets/cli/add.mdx) and bunx (snippets/cli/bunx.mdx) typed string or number; --catalog takes its name only after =. -p is --package for bunx but the flag --production for bun add, so it is listed with bunx only. The short forms -F (--filter) and -c (--config) of bun add are left out because bunx does not document them, and an option wrongly read as taking a value would hide the package after it. bunx is an alias for bun x (docs/pm/bunx.mdx). bun create <template> runs the create-<template> package from npm unless a local template has that name; it also takes GitHub repositories and local paths (docs/runtime/templating/create.mdx)."),
		packageSpecs: checked$5.verified({
			git: [
				"github:",
				"git+ssh://",
				"git+https://"
			],
			local: [],
			workspace: [],
			scp: true
		}, "https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs/pm/cli/add.mdx", "Git dependencies: \"Bun supports a variety of protocols, including github, git, git+ssh, and git+https\", with the examples git@github.com:moment/moment.git and github:colinhacks/zod. Tarball URLs, local folders and local .tgz files are accepted too."),
		registryOverrides: checked$5.verified({
			registryOptions: ["--registry"],
			registryVariables: ["BUN_CONFIG_REGISTRY"],
			configOptions: ["--config", "-c"],
			configVariables: []
		}, "https://github.com/oven-sh/bun/tree/da867c60bf0bcbf9d6d36994f8ca0efa42075115/docs", "bun add takes --registry and --config (-c), a configuration file (snippets/cli/add.mdx). BUN_CONFIG_REGISTRY sets the npm registry and environment variables take priority over bunfig.toml (pm/cli/install.mdx)."),
		lockfileFormat: checked$5.verified({
			installScripts: "hasInstallScript",
			installScriptsSince: "1.4.4",
			git: ["git+", "github:"],
			directory: ["file:", "link:"],
			workspace: "workspace:",
			tarball: "\\.(?:tar\\.gz|tgz)$"
		}, "https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/install/lockfile/bun.lock.rs", "bun.lock (text, the default since 1.2) maps each package to a tuple starting with name@<spec>: name@<version> followed by the registry for npm, name@git+<repo>#<sha> and name@github:<owner>/<repo>#<sha> for git, name@https://… for tarball URLs, name@./x.tgz (without file:) for local tarballs, name@file:<dir> and name@link:<dir> for directories, name@workspace:<dir> for workspace packages. The info object carries hasInstallScript: true only since 1.4.4, with no lockfileVersion change, so a missing flag proves nothing for older files. bun.lockb is an undocumented binary format."),
		durationStrings: verified$12({
			since: "1.4.4",
			syntax: "compact-or-words"
		}, BUN_1_4_4, "Since 1.4.4 minimumReleaseAge also takes duration strings such as 90m, 12 hours, 3d or 2 weeks; plain numbers stay seconds."),
		excludeWildcards: verified$12({
			since: null,
			trailingOnly: false
		}, BUN_1_4_4, "minimumReleaseAgeExcludes takes exact package names (and name@version since 1.4.4), no wildcards."),
		latestVersion: verified$12("1.4.4", "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4"),
		trustedDependenciesReplacesDefaults: checked$5.verified("Adding trustedDependencies replaces the built-in trusted list, so default-trusted packages that are not listed stop running scripts", `${LIFECYCLE}#behavior-of-the-trusteddependencies-field`, "So an empty list trusts no package: without the field Bun 1.4.4 ran esbuild's postinstall (esbuild is on the built-in list); with \"trustedDependencies\": [] it blocked it (bun pm untrusted listed it), tested on 2026-10-29."),
		lockedVersionsNotRechecked: verified$12("minimumReleaseAge only affects new resolutions; versions already in bun.lock are kept", `${INSTALL$1}#minimum-release-age`),
		bunxCooldown: verified$12("bunx applies --minimum-release-age only since 1.4.4", "https://bun.com/blog/bun-v1.4.4")
	}
};

// src/knowledge/deno.ts
const { verified: verified$11, uncertain: uncertain$10, disputed: disputed$5, evidence: evidence$5 } = verifiedOn("2026-10-28");
const checked$4 = verifiedOn("2026-10-29");
const reviewed$2 = verifiedOn("2026-10-30");
const X_VALUE_OPTIONS = [
	"--package",
	"-p",
	"--config",
	"-c",
	"--import-map",
	"--cert",
	"--min-dep-age",
	"--location",
	"--seed",
	"--preload",
	"--require",
	"--conditions",
	"--inspect-publish-uid"
];
const DENO_JSON = "https://docs.deno.com/runtime/reference/deno_json/#minimum-dependency-age";
const SUPPLY_CHAIN = "https://docs.deno.com/runtime/packages/supply_chain/#minimum-dependency-age";
const SCHEMA$1 = "https://github.com/denoland/deno/blob/v2.9.8/cli/schemas/config-file.v1.json";
const INSTALL = "https://docs.deno.com/runtime/reference/cli/install/";
const NOT_SUPPORTED = "https://docs.deno.com/examples/local_unpublished_packages_tutorial/#what-is-not-supported";
const release$4 = (version) => `https://github.com/denoland/deno/releases/tag/v${version}`;
const unsupported = (note) => ({ setting: verified$11(null, NOT_SUPPORTED, note) });
const WORKSPACES$1 = "https://github.com/denoland/docs/blob/main/runtime/fundamentals/workspaces.md";
const deno$1 = {
	id: "deno",
	name: "Deno",
	kind: "package-manager",
	cooldown: {
		setting: verified$11("minimumDependencyAge", DENO_JSON, "A number or string, or the object form { \"age\": ..., \"exclude\": [...] }. Covers npm and JSR packages."),
		configFiles: verified$11(["deno.json", ".npmrc"], SUPPLY_CHAIN, "min-release-age in .npmrc since 2.8; also NPM_CONFIG_MIN_RELEASE_AGE. This page does not state precedence; denoland/deno#35458 gives CLI flag, deno.json, .npmrc, environment, built-in default."),
		cliFlag: verified$11("--minimum-dependency-age", DENO_JSON, "Alias --min-dep-age since 2.9.3. deno install honors it since 2.5.5; deno add, deno remove and deno x since 2.9.4."),
		unit: verified$11("minutes", SCHEMA$1, "Numbers are minutes; strings may be an ISO-8601 duration (P3D, PT72H), an absolute date or an RFC3339 timestamp; 0 turns it off. The .npmrc format differs (see npmrcFormat)."),
		availableSince: disputed$5("The 2.5.5 release notes ship the flag, the deno.json key and exclude as unstable; the release blog says the feature was introduced in 2.6.", evidence$5("2.5.5", release$4("2.5.5")), evidence$5("2.6.0", "https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default")),
		default: verified$11([{
			since: "0.0.0",
			value: null
		}, {
			since: "2.9.0",
			value: 1440
		}], DENO_JSON, "Since 2.9 a 24-hour minimum applies when nothing is configured; set 0 to turn it off. Whether the default covers JSR is not stated."),
		exclude: {
			setting: verified$11("minimumDependencyAge.exclude", SCHEMA$1),
			availableSince: verified$11("2.5.5", release$4("2.5.5")),
			patternSyntax: verified$11("Specifiers prefixed npm: or jsr:; a trailing * matches by prefix (npm:@scope/*) since 2.9.2", SCHEMA$1, "Before 2.9.2 wildcard entries were stored literally and never matched. No CLI flag or .npmrc key for exclusions.")
		},
		securityUpdates: uncertain$10("applies", SUPPLY_CHAIN, "No security bypass is documented; only per-package exclude or an age of 0.")
	},
	installScripts: {
		defaultPolicy: verified$11([{
			since: "0.0.0",
			value: "deny-except-allowlist"
		}], INSTALL, "npm lifecycle scripts run only when approved, and only with a node_modules directory. deno x / dx runs them after its download prompt is accepted."),
		allowList: {
			setting: verified$11("allowScripts", "https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts", "deno approve-scripts writes it. --allow-scripts=npm:pkg on the CLI exists since 1.45."),
			file: verified$11("deno.json", "https://docs.deno.com/examples/npm_lifecycle_scripts_tutorial/", "Must be set at the workspace root."),
			availableSince: verified$11("2.6.0", "https://deno.com/blog/v2.6#granular-control-over-postinstall-scripts-with-deno-approve-scripts"),
			format: verified$11("true, an array of npm: constraints (semver ranges allowed, tags rejected) or { \"allow\": ..., \"deny\": [...] }", SCHEMA$1)
		},
		disableAll: uncertain$10("allowScripts: false", SCHEMA$1, "Scripts do not run by default. The schema accepts a boolean allowScripts, but no page states that false turns all scripts off. deno x has --ignore-scripts.")
	},
	sources: {
		git: unsupported("git+https: and git+ssh: dependencies are not supported in package.json."),
		remoteTarball: unsupported("Tarball URL dependencies are not supported in package.json."),
		file: unsupported("No setting. Since 2.8 file: and link: entries are silently skipped (scope disputed, see fileLinkSkipped); deno.json \"links\" overrides dependencies with local packages."),
		directory: unsupported("No setting; local directories behave like file: and link: entries (see fileLinkSkipped).")
	},
	project: {
		lockfiles: verified$11([{
			since: "0.0.0",
			value: ["deno.lock"]
		}], "https://github.com/denoland/docs/blob/main/runtime/reference/deno_json.md", "The default location; lock.path in deno.json can move it and \"lock\": false turns it off."),
		manifests: verified$11(["deno.json", "deno.jsonc"], "https://github.com/denoland/docs/blob/main/runtime/fundamentals/configuration.md"),
		workspaces: verified$11({
			files: ["deno.json", "deno.jsonc"],
			key: "workspace"
		}, WORKSPACES$1, "Paths of members; globs and ! exclusions since Deno 2.1."),
		workspacesObjectKey: verified$11("members", WORKSPACES$1)
	},
	extra: {
		commandLine: reviewed$2.verified({
			add: [["deno", "add"], ["deno", "install"]],
			run: [
				{
					command: ["deno", "x"],
					packageOptions: ["--package", "-p"],
					binaryPath: true
				},
				{
					command: ["dx"],
					packageOptions: ["--package", "-p"],
					binaryPath: true
				},
				{
					command: ["denox"],
					packageOptions: ["--package", "-p"],
					binaryPath: true
				},
				{
					command: ["dnx"],
					packageOptions: ["--package", "-p"],
					binaryPath: true
				}
			],
			create: [],
			createNames: "prefix",
			fileOptions: ["--entrypoint", "-e"],
			valueOptions: [
				"--name",
				"-n",
				"--root",
				"--os",
				"--arch",
				"-L",
				"--log-level"
			],
			commandOptions: [
				{
					command: ["deno", "x"],
					valueOptions: X_VALUE_OPTIONS
				},
				{
					command: ["dx"],
					valueOptions: X_VALUE_OPTIONS
				},
				{
					command: ["denox"],
					valueOptions: X_VALUE_OPTIONS
				},
				{
					command: ["dnx"],
					valueOptions: X_VALUE_OPTIONS
				}
			]
		}, "https://github.com/denoland/docs/tree/74beb7585f7e798fe0bc8d867295bff23fc2e38e/runtime/reference/cli", "install.md: deno install [PACKAGES] installs packages and adds them to deno.json or package.json, deno add is its alias, deno install --global installs a package or script as a binary, and deno install --entrypoint (-e) [FILES] installs what the files use. -n/--name, --root, --os and --arch take a value; --allow-scripts and --node-modules-dir are shown with =. Since Deno 2.8 a name without a prefix is an npm package; JSR packages need jsr: (add.md). x.md: deno x runs a package from npm or JSR without installing it, like npx (deno x npm:create-vite my-app); --package (-p) names the package when the binary differs (deno x -p typescript tsc), and npm:<package>/<binary> picks one binary; deno x --install-alias creates the dx alias. In Deno 2.9.8 (github.com/denoland/deno, cli/args/flags.rs) an executable whose name ends in dx, denox or dnx runs as deno x, and libs/cli_parser/src/defs.rs (X_SUBCOMMAND with COMPILE_ARGS, PERMISSION_ARGS, RUNTIME_MISC_ARGS and INSPECT_ARGS) gives the options of deno x that take a separate value; the permission flags take theirs after =. -L/--log-level is a global option with a value."),
		lockfileFormat: checked$4.verified({
			installScripts: "scripts",
			installScriptsSinceLockfile: "5",
			sources: null
		}, "https://github.com/denoland/deno/blob/v2.9.8/libs/lockfile/printer.rs", "deno.lock version 5 (the default since Deno 2.3) marks npm packages with lifecycle scripts as scripts: true (hasInstallScript from the registry or a preinstall, install or postinstall script, libs/npm/resolution/graph.rs); version 4 has no such field. tarball is written only for registries other than the default one. Deno rejects git and http(s) dependencies in package.json and keeps file: dependencies out of the lockfile."),
		durationStrings: verified$11({
			since: null,
			syntax: "iso8601"
		}, SCHEMA$1, "Strings are ISO-8601 durations (P3D, PT72H), an absolute date or an RFC3339 timestamp; the last two set a fixed cut-off instead of a delay."),
		ageObjectKey: verified$11("age", SCHEMA$1, "In the object form of minimumDependencyAge, age holds the delay and exclude the exemptions."),
		excludeWildcards: verified$11({
			since: "2.9.2",
			trailingOnly: true
		}, SCHEMA$1, "A trailing * matches by prefix (npm:@scope/*) since 2.9.2; earlier wildcard entries never matched."),
		npmSpecifierPrefix: verified$11("npm:", SCHEMA$1, "Exclusions and allowScripts entries name npm packages as npm:<name>."),
		allowAllScripts: verified$11({
			setting: "allowScripts",
			since: "2.6.0",
			value: true
		}, SCHEMA$1, "allowScripts: true allows every npm lifecycle script."),
		latestVersion: verified$11("2.9.8", release$4("2.9.8")),
		npmrcFormat: disputed$5("The safe choice is an integer number of days, which also matches npm.", evidence$5("whole days only, e.g. min-release-age=3", SUPPLY_CHAIN), evidence$5("a duration with a unit, e.g. min-release-age=72h", "https://deno.com/blog/v2.9#minimum-dependency-age-enabled-by-default")),
		fileLinkSkipped: disputed$5("Official pages disagree on whether the project's own file: and link: dependencies are skipped, or only those in published packages' metadata.", evidence$5("file: and link: dependencies in the project package.json are silently skipped", NOT_SUPPORTED), evidence$5("file: and link: specifiers in registry metadata of npm packages are skipped", "https://deno.com/blog/v2.8#file-and-link-dependencies-in-npm-packages")),
		denoXCooldown: verified$11("deno x honors minimumDependencyAge only since 2.9.4", release$4("2.9.4")),
		dxRunsScripts: verified$11("dx defaults to --allow-all and runs lifecycle scripts once the download prompt is accepted", "https://deno.com/blog/v2.6")
	}
};

// src/knowledge/dependabot.ts
const { verified: verified$10, uncertain: uncertain$9, disputed: disputed$4, evidence: evidence$4 } = verifiedOn("2026-10-28");
const python$2 = verifiedOn("2026-10-30");
const OPTIONS$1 = "https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference";
const COOLDOWN_GA = "https://github.blog/changelog/2025-07-01-dependabot-supports-configuration-of-a-minimum-package-age/";
const DEFAULT_COOLDOWN = "https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown/";
const CORE = "https://github.com/dependabot/dependabot-core/blob/main";
const dependabot$1 = {
	id: "dependabot",
	name: "Dependabot",
	kind: "update-bot",
	cooldown: {
		setting: verified$10("cooldown", `${OPTIONS$1}#cooldown`, "Per updates entry: default-days, semver-major-days, semver-minor-days, semver-patch-days, include, exclude. The semver-* keys apply only to SemVer ecosystems."),
		configFiles: verified$10([".github/dependabot.yml", ".github/dependabot.yaml"], "https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file", "On the default branch."),
		cliFlag: uncertain$9(null, "https://github.com/dependabot/cli", "Cooldown is configured only in dependabot.yml; the Dependabot CLI README mentions no such flag."),
		unit: verified$10("days", `${OPTIONS$1}#cooldown`, "Integer days; the allowed range is disputed (see dayRange)."),
		availableSince: verified$10("2025-07-01", COOLDOWN_GA, "GA date on github.com; NuGet and Helm since 2025-07-29."),
		default: verified$10([{
			since: "2025-07-01",
			value: null
		}, {
			since: "2026-07-14",
			value: 3
		}], DEFAULT_COOLDOWN, "Version updates wait 3 days even without a cooldown block (GHES from 3.23); default-days is also 3 when cooldown is set without it."),
		exclude: {
			setting: verified$10("cooldown.exclude", `${OPTIONS$1}#cooldown`),
			availableSince: uncertain$9("2025-07-01", COOLDOWN_GA, "Presumably shipped with cooldown GA; not confirmed separately."),
			patternSyntax: verified$10("Dependency names with * wildcards, up to 150 entries; exclude always wins over include", `${OPTIONS$1}#cooldown`)
		},
		securityUpdates: verified$10("bypass", `${OPTIONS$1}#cooldown`, "Cooldown exists only for version updates. dependabot-core also passes a zero age to npm, pnpm and Yarn for security updates, overriding repository gates.")
	},
	installScripts: {
		defaultPolicy: uncertain$9([{
			since: "0.0.0",
			value: "deny"
		}], `${CORE}/npm_and_yarn/lib/dependabot/npm_and_yarn/helpers.rb`, "From dependabot-core source, not the docs: npm, Yarn and Bun lockfile updates run with scripts disabled; for pnpm only --lockfile-only was found. bundler, mix and pip may execute external code."),
		allowList: { setting: verified$10(null, `${OPTIONS$1}#insecure-external-code-execution`, "insecure-external-code-execution: allow exists only for bundler, mix and pip; nothing allows npm, pnpm, Yarn or Bun scripts.") },
		disableAll: uncertain$9(null, `${OPTIONS$1}#insecure-external-code-execution`, "Nothing to configure for JavaScript ecosystems: scripts are always disabled (source code). For bundler, mix and pip, external code execution is disabled automatically when registries are configured.")
	},
	extra: {
		cooldownKeys: verified$10({
			days: "default-days",
			exclude: "exclude",
			semverDays: [
				"semver-major-days",
				"semver-minor-days",
				"semver-patch-days"
			]
		}, `${OPTIONS$1}#cooldown`, "Keys inside the cooldown block of an updates entry; the semver-* keys override default-days for that kind of update."),
		excludeWildcards: verified$10({
			since: "0.0.0",
			trailingOnly: false
		}, `${OPTIONS$1}#cooldown`, "cooldown.exclude accepts * wildcards."),
		ecosystems: python$2.verified({
			npm: [
				"npm",
				"pnpm",
				"yarn"
			],
			bun: ["bun"],
			deno: ["deno"],
			pip: [
				"pip",
				"poetry",
				"pipenv"
			],
			uv: ["uv"]
		}, `${OPTIONS$1}#package-ecosystem`, "The npm ecosystem covers npm, pnpm and Yarn; bun needs Bun 1.1.39 or later and deno needs Deno 2. pip covers pip, pip-compile, pipenv and Poetry (v2); uv has its own ecosystem (the table lists uv v0.11). Cooldown, including the semver-* keys, is supported for all of them. PDM is not listed: dependabot-core skips the dependencies of pyproject.toml when pdm.lock exists (python/lib/dependabot/python/file_parser/pyproject_files_parser.rb at v0.402.0)."),
		dayRange: disputed$4("Matters for opting out of the default cooldown; cooldown.exclude: [\"*\"] works under the documented precedence rule either way. The announcement does not state its author's role.", evidence$4("1 to 90 days", "https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates"), evidence$4("0 removes the cooldown", "https://github.com/dependabot/dependabot-core/discussions/15582")),
		maximumDays: verified$10(90, "https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates", "The page says the number of cooldown days must be between 1 and 90; whether 0 is accepted is disputed (see dayRange)."),
		missingPublishDate: verified$10("Updates proceed when the registry gives no publication date (fail open); for Docker only Docker Hub tag_last_pushed is used", `${CORE}/docker/README.md`),
		transitiveGating: uncertain$9("Regular updates pass the cooldown to npm (11.10+), pnpm (10.16+) and Yarn Berry to hold back transitive dependencies; the Bun updater passes none", `${CORE}/npm_and_yarn/lib/dependabot/npm_and_yarn/file_updater/npm_lockfile_updater.rb`, "Read from dependabot-core source."),
		semverKeysScope: verified$10("semver-major/minor/patch-days apply only to SemVer ecosystems such as npm, Bun and Deno; others use default-days", `${OPTIONS$1}#cooldown`)
	}
};

// src/knowledge/npm.ts
const { verified: verified$9, uncertain: uncertain$8, disputed: disputed$3, evidence: evidence$3 } = verifiedOn("2026-10-28");
const checked$3 = verifiedOn("2026-10-29");
const reviewed$1 = verifiedOn("2026-10-30");
const CONFIG = "https://docs.npmjs.com/cli/v12/using-npm/config";
const NPMRC = "https://docs.npmjs.com/cli/v12/configuring-npm/npmrc";
const release$3 = (version) => `https://github.com/npm/cli/releases/tag/v${version}`;
const INSTALL_TIME_CONTROLS = "https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/";
const SOURCE_FLAGS_SINCE_NOTE = "The 11.14.0 release notes add the flag; the GitHub changelog dates it to 11.15.0, which also moved enforcement into the resolver. Treat 11.15.0 as the safe minimum.";
const VALUES_NOTE = "The 2026-05-22 GitHub changelog mentions only all and none; the config reference also lists root.";
const sourceFlagSince = () => disputed$3(SOURCE_FLAGS_SINCE_NOTE, evidence$3("11.14.0", release$3("11.14.0")), evidence$3("11.15.0", INSTALL_TIME_CONTROLS));
const LOCKFILE_V12 = "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md";
const PACKAGE_JSON$1 = "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md";
const NPM_DEFINITIONS = "https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/definitions.js";
const CMD_LIST = "https://github.com/npm/cli/blob/v12.2.1/lib/utils/cmd-list.js";
const INSTALL_ALIASES = [
	"install",
	"add",
	"i",
	"in",
	"ins",
	"inst",
	"insta",
	"instal",
	"isnt",
	"isnta",
	"isntal",
	"isntall",
	"install-test",
	"it"
];
const NPM_DEFINITIONS_V11_16 = "https://github.com/npm/cli/blob/v11.16.0/workspaces/config/lib/definitions/definitions.js";
const NPM_SHORTHANDS = "https://github.com/npm/cli/blob/v12.2.1/workspaces/config/lib/definitions/index.js";
const npm$1 = {
	id: "npm",
	name: "npm",
	kind: "package-manager",
	cooldown: {
		setting: verified$9("min-release-age", `${CONFIG}#min-release-age`),
		configFiles: verified$9([".npmrc"], NPMRC, "Any npm config layer works: project .npmrc (read only at the project root and not for global installs), ~/.npmrc, the global npmrc, npm_config_min_release_age or the CLI. package.json cannot set it."),
		cliFlag: verified$9("--min-release-age=<days>", "https://docs.npmjs.com/cli/v12/commands/npm-install#min-release-age"),
		unit: verified$9("days", `${CONFIG}#min-release-age`, "Type is null or Number; 0 turns the delay off. Fractional days are not documented."),
		availableSince: verified$9("11.10.0", release$3("11.10.0")),
		default: verified$9([{
			since: "11.10.0",
			value: null
		}], `${CONFIG}#min-release-age`, "Unchanged in npm 12."),
		exclude: {
			setting: verified$9("min-release-age-exclude", `${CONFIG}#min-release-age-exclude`),
			availableSince: verified$9("11.17.0", release$3("11.17.0")),
			patternSyntax: verified$9("Package names or minimatch globs matched against the name, e.g. @myorg/*; only the named package is exempt, not its dependencies; also exempts from before", `${CONFIG}#min-release-age-exclude`)
		},
		securityUpdates: verified$9("applies", `${CONFIG}#min-release-age`, "npm audit fix keeps the vulnerable version, warns that the fix was blocked (since 11.18.0) and exits non-zero. Add the package to min-release-age-exclude or relax the delay.")
	},
	installScripts: {
		defaultPolicy: checked$3.verified([
			{
				since: "0.0.0",
				value: "run"
			},
			{
				since: "11.16.0",
				value: "run-with-warning"
			},
			{
				since: "12.0.0",
				value: "deny-except-allowlist"
			}
		], NPM_DEFINITIONS_V11_16, "strict-allow-scripts (default false) turns a dependency script that allowScripts does not cover \"from a warning into a hard error ... instead of running with a notice\", so from 11.16.0 such scripts still run. npm 11.21.1 ran esbuild's postinstall on 2026-10-29 (\"has install scripts not yet covered by allowScripts\"); npm 12.2.1 blocked it (\"had install scripts blocked\"). The v11 install-scripts command page says scripts are blocked by default, which the config definition, the 11.16.0 pull request, the GitHub changelog and the test contradict. npm 12 also blocks implicit node-gyp builds and prepare scripts of git, file and link dependencies."),
		allowList: {
			setting: verified$9("allowScripts", "https://docs.npmjs.com/cli/v12/commands/npm-install-scripts"),
			file: verified$9("package.json", "https://docs.npmjs.com/cli/v12/commands/npm-install-scripts", "Only the root package.json counts; allowScripts in dependencies is ignored. npx, npm exec and global installs use the allow-scripts config instead."),
			availableSince: verified$9("11.16.0", release$3("11.16.0")),
			format: uncertain$8("Object keyed by name, name@version or name@v1 || v2 with true (allow) or false (deny); npm install-scripts approve writes pinned name@version entries", "https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md", "The exact entry grammar (no semver ranges) is stated in accepted RFC 0054; the shipped docs describe entries only in prose.")
		},
		disableAll: verified$9("ignore-scripts", `${CONFIG}#ignore-scripts`, "Default false. Overrides allowScripts and dangerously-allow-all-scripts. npm run/test/start still run the named script, but not its pre/post scripts.")
	},
	sources: {
		git: {
			setting: verified$9("allow-git", `${CONFIG}#allow-git`),
			values: verified$9([
				"all",
				"none",
				"root"
			], `${CONFIG}#allow-git`, "root allows only git dependencies listed in the project package.json."),
			availableSince: disputed$3("The release notes add --allow-git in 11.9.0; the GitHub changelog says it was introduced in 11.10.0.", evidence$3("11.9.0", release$3("11.9.0")), evidence$3("11.10.0", INSTALL_TIME_CONTROLS)),
			default: verified$9([{
				since: "11.9.0",
				value: "all"
			}, {
				since: "12.0.0",
				value: "none"
			}], `${CONFIG}#allow-git`)
		},
		remoteTarball: {
			setting: verified$9("allow-remote", `${CONFIG}#allow-remote`),
			values: verified$9([
				"all",
				"none",
				"root"
			], `${CONFIG}#allow-remote`, `Tarballs on the configured registry hostname are always allowed. ${VALUES_NOTE}`),
			availableSince: sourceFlagSince(),
			default: verified$9([{
				since: "11.14.0",
				value: "all"
			}, {
				since: "12.0.0",
				value: "none"
			}], release$3("12.0.0"))
		},
		file: {
			setting: verified$9("allow-file", `${CONFIG}#allow-file`),
			values: verified$9([
				"all",
				"none",
				"root"
			], `${CONFIG}#allow-file`, VALUES_NOTE),
			availableSince: sourceFlagSince(),
			default: verified$9([{
				since: "11.14.0",
				value: "all"
			}], "https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/", "npm 12 did not change the default.")
		},
		directory: {
			setting: verified$9("allow-directory", `${CONFIG}#allow-directory`),
			values: verified$9([
				"all",
				"none",
				"root"
			], `${CONFIG}#allow-directory`, VALUES_NOTE),
			availableSince: sourceFlagSince(),
			default: verified$9([{
				since: "11.14.0",
				value: "all"
			}], `${CONFIG}#allow-directory`, "npm 12 did not change the default.")
		}
	},
	project: {
		lockfiles: verified$9([{
			since: "0.0.0",
			value: ["npm-shrinkwrap.json", "package-lock.json"]
		}, {
			since: "12.0.0",
			value: ["package-lock.json"]
		}], LOCKFILE_V12, "npm 11 and earlier prefer npm-shrinkwrap.json over package-lock.json when both exist; npm 12 no longer reads or writes npm-shrinkwrap.json (same format, rename it)."),
		manifests: verified$9(["package.json"], PACKAGE_JSON$1),
		workspaces: verified$9({
			files: ["package.json"],
			key: "workspaces"
		}, `${PACKAGE_JSON$1}#workspaces`, "An array of folder paths or globs."),
		workspacesObjectKey: uncertain$8("packages", "https://github.com/npm/map-workspaces/blob/main/lib/index.js", "Not documented; npm's map-workspaces also accepts { \"packages\": [...] } and negated patterns.")
	},
	extra: {
		trustedPublishing: checked$3.verified({
			minimumNpm: "11.5.1",
			minimumNode: "22.14.0",
			githubPermission: "id-token: write",
			automaticProvenance: true,
			firstPublishWithinDays: 2
		}, "https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/packages-and-modules/securing-your-code/trusted-publishers.mdx", "Publishing from GitHub-hosted runners with OIDC instead of a token. Provenance is generated automatically, only for a public package from a public repository. A new trusted publisher configuration expires unless its first publish succeeds within 2 days. It can be limited to npm stage publish (the default for configurations created after 2026-09-03)."),
		stagedPublishing: checked$3.verified({
			minimumNpm: "11.15.0",
			minimumNode: "22.14.0",
			stage: "npm stage publish",
			approve: "npm stage approve",
			reject: "npm stage reject",
			newPackagePlaceholder: "0.0.0-stage"
		}, "https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/cli/v12/commands/npm-stage.mdx", "Staging needs no 2FA, so CI can do it; approving or rejecting needs 2FA (CLI or npmjs.com). Staging a package that does not exist yet creates it with the public placeholder version 0.0.0-stage. Pre-release versions need an explicit --tag. --provenance also applies to npm stage publish. Rejecting the only staged version of such a new package also unpublished the placeholder (observed 2026-10-29 with npm 11.21.1), and after a whole package is unpublished its name is blocked for 24 hours (https://github.com/npm/documentation/blob/main/content/policies/unpublish.mdx)."),
		trustCommand: checked$3.verified({
			command: "npm trust github",
			minimumNpm: "11.15.0",
			packageMustExist: true,
			permissions: ["--allow-publish", "--allow-stage-publish"]
		}, "https://github.com/npm/documentation/blob/514e6c9e84ef5b29dd8e11b7e743ab573ba10a0b/content/cli/v12/commands/npm-trust.mdx", "Configures a trusted publisher from the CLI; needs 2FA on the account and write access, and the package must already exist. At least one permission flag is required."),
		lockfileFormat: checked$3.verified({
			installScripts: "hasInstallScript",
			gitPrefixes: ["git+", "git:"],
			filePrefix: "file:",
			linkFlag: "link",
			registryTarball: "^https?://[^/]+/.+/-/[^/]+-\\d",
			specWithoutResolved: "version",
			dependencyFields: [
				"dependencies",
				"optionalDependencies",
				"peerDependencies",
				"devDependencies"
			]
		}, "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-lock-json.md", "Entries under packages: resolved is the registry tarball URL, the git URL with its commit (git+ssh://… or git+https://…#sha), file:<path> for local tarballs and directories, or the link target when link is true. hasInstallScript marks a preinstall, install or postinstall script (prepare scripts of non-registry sources are not flagged). npm tells registry tarballs from other URLs with the registryTarball pattern (workspaces/arborist/lib/install-scripts.js), so a tarball URL on a registry host looks like a registry package. An entry without resolved is installed as <name>@<version> (workspaces/arborist/lib/arborist/reify.js, #extractOrLink, in 11.19.1 and 12.2.1), so its version field is the source then. Entries keep the dependency fields of their package.json: dependencies, optionalDependencies and peerDependencies for every package, devDependencies for the root (workspaces/arborist/lib/shrinkwrap.js, pkgMetaKeys and the isTop branch, in 11.21.1 and 12.2.1); a dependency declared there as a URL comes from that URL even when it is a registry tarball."),
		overrides: checked$3.verified({
			field: "overrides",
			selfKey: "."
		}, "https://github.com/npm/cli/blob/v11.21.1/docs/lib/content/configuring-npm/package-json.md#overrides", "Only the root package.json counts. Keys are package names, optionally with a version or range (name@range), and nest to any depth to scope an override under a parent; \".\" inside a nested object overrides the parent package itself; values take any dependency specifier, including tarball URLs, and $name refers to the spec of a direct dependency. Overrides are not written to package-lock.json (checked with npm 11.21.1), so a URL override of a registry tarball looks like a registry package there. With replace-registry-host at its default npmjs, npm writes the configured registry in place of registry.npmjs.org in resolved URLs (workspaces/config/lib/definitions/definitions.js)."),
		npmrcScope: checked$3.verified({
			read: "project root",
			workspacePackages: "ignored",
			globalMode: "ignored"
		}, "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md", "Only the .npmrc at the root of the project npm runs in is read. Inside a workspace package npm moves the prefix to the workspace root (using-npm/workspaces.md) and warns \"ignoring workspace config\" for the package .npmrc (workspaces/config/lib/index.js). The project .npmrc \"is not read in global mode, such as when running npm install -g\" (same page, v11.21.1 and v12.2.1)."),
		npmrcListSyntax: verified$9("[]", "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/npmrc.md", "Array values are written by adding [] after the key, one line per value, e.g. min-release-age-exclude[]=@myorg/*."),
		allowAllScripts: verified$9({
			setting: "dangerously-allow-all-scripts",
			since: "11.16.0",
			value: true
		}, NPM_DEFINITIONS, "Boolean, default false: runs every dependency install script whether or not allowScripts approves it; --ignore-scripts still wins. First present in the 11.16.0 definitions."),
		excludeWildcards: verified$9({
			since: "11.17.0",
			trailingOnly: false
		}, NPM_DEFINITIONS, "min-release-age-exclude takes package names or minimatch globs from its first version."),
		latestVersion: verified$9("12.2.1", release$3("12.2.1"), "Marked as the latest GitHub release on 2026-10-28; the 11.x line is still maintained (11.21.1)."),
		beforeInteraction: verified$9([{
			since: "11.10.0",
			value: "min-release-age and before are mutually exclusive"
		}, {
			since: "11.15.0",
			value: "both may be set; before wins within the same config source"
		}], release$3("11.15.0")),
		strictAllowScripts: checked$3.verified({
			setting: "strict-allow-scripts",
			value: true,
			since: "11.16.0"
		}, NPM_DEFINITIONS_V11_16, "strict-allow-scripts=true makes the install fail on a dependency with install scripts that allowScripts does not cover, instead of running them with a notice (default false). Entries denied with false are skipped silently; --ignore-scripts and --dangerously-allow-all-scripts override it."),
		unknownNpmrcKeys: disputed$3("Matters for generated .npmrc files: keys that npm does not know (e.g. pnpm-only keys) may break npm 12 installs.", evidence$3("npm 12 throws on unknown config keys", release$3("12.0.0")), evidence$3("unknown keys only warn; throwing is planned for a future major version", NPMRC)),
		commandLine: checked$3.verified({
			add: INSTALL_ALIASES.map((alias) => ["npm", alias]),
			run: [
				{
					command: ["npx"],
					packageOptions: ["--package", "-p"],
					lineOptions: ["--call", "-c"]
				},
				{
					command: ["npm", "exec"],
					packageOptions: ["--package"],
					lineOptions: ["--call", "-c"]
				},
				{
					command: ["npm", "x"],
					packageOptions: ["--package"],
					lineOptions: ["--call", "-c"]
				}
			],
			create: [
				{
					command: ["npm", "init"],
					packageOptions: []
				},
				{
					command: ["npm", "create"],
					packageOptions: []
				},
				{
					command: ["npm", "innit"],
					packageOptions: []
				}
			],
			createNames: "prefix",
			valueOptions: []
		}, CMD_LIST, "Aliases of install (add, i and the typo aliases in, ins, inst, insta, instal, isnt, isnta, isntal, isntall), install-test (it), exec (x) and init (create, innit), the same in 11.19.1. install-test takes the same arguments as install (docs/lib/content/commands/npm-install-test.md). npm exec and npx take the packages to download from --package; -p means --package only in npx (in npm it is --parseable); without --package the first positional argument names the package, and -c/--call takes a command string that runs with the packages, shell operators included (npm-exec.md). npm init <initializer> runs npm exec create-<initializer>: foo → create-foo, @usr → @usr/create, @usr/foo@2.0.0 → @usr/create-foo@2.0.0 (npm-init.md)."),
		valueOptions: checked$3.verified([
			"--access",
			"--allow-directory",
			"--allow-file",
			"--allow-git",
			"--allow-remote",
			"--allow-scripts",
			"--also",
			"--audit-level",
			"--auth-type",
			"--before",
			"--ca",
			"--cache",
			"--cache-max",
			"--cache-min",
			"--cafile",
			"--call",
			"--cert",
			"--cidr",
			"--cpu",
			"--depth",
			"--diff",
			"--diff-dst-prefix",
			"--diff-src-prefix",
			"--diff-unified",
			"--edit-dir",
			"--editor",
			"--expect-result-count",
			"--expires",
			"--extension-file",
			"--fetch-retries",
			"--fetch-retry-factor",
			"--fetch-retry-maxtimeout",
			"--fetch-retry-mintimeout",
			"--fetch-timeout",
			"--git",
			"--global-ignore-file",
			"--globalconfig",
			"--heading",
			"--https-proxy",
			"--include",
			"--init-author-email",
			"--init-author-name",
			"--init-author-url",
			"--init-license",
			"--init-module",
			"--init-type",
			"--init-version",
			"--install-strategy",
			"--key",
			"--libc",
			"--local-address",
			"--location",
			"--lockfile-version",
			"--loglevel",
			"--logs-dir",
			"--logs-max",
			"--maxsockets",
			"--message",
			"--min-release-age",
			"--min-release-age-exclude",
			"--name",
			"--node-gyp",
			"--node-options",
			"--noproxy",
			"--omit",
			"--only",
			"--orgs",
			"--orgs-permission",
			"--os",
			"--otp",
			"--pack-destination",
			"--package",
			"--packages",
			"--packages-and-scopes-permission",
			"--password",
			"--patches-dir",
			"--prefix",
			"--preid",
			"--provenance-file",
			"--proxy",
			"--registry",
			"--replace-registry-host",
			"--save-prefix",
			"--sbom-format",
			"--sbom-type",
			"--scope",
			"--scopes",
			"--script-shell",
			"--searchexclude",
			"--searchlimit",
			"--searchopts",
			"--searchstaleness",
			"--shell",
			"--tag",
			"--tag-version-prefix",
			"--to",
			"--token-description",
			"--umask",
			"--user-agent",
			"--userconfig",
			"--viewer",
			"--which",
			"--workspace",
			"-C",
			"-L",
			"-c",
			"-m",
			"-w"
		], NPM_DEFINITIONS, "npm options that always take a value: every definition whose type does not include Boolean, as --name, and the short forms -C (prefix), -L (location), -c (call), -m (message) and -w (workspace). Options whose type includes Boolean (such as color and browser) may stand alone, so they are taken for flags."),
		flagOptions: reviewed$1.verified([
			"--all",
			"--allow-same-version",
			"--allow-scripts-pending",
			"--allow-scripts-pin",
			"--allow-unused-patches",
			"--audit",
			"--bin-links",
			"--browser",
			"--bypass-2fa",
			"--color",
			"--commit-hooks",
			"--dangerously-allow-all-scripts",
			"--description",
			"--dev",
			"--diff-ignore-all-space",
			"--diff-name-only",
			"--diff-no-prefix",
			"--diff-text",
			"--dry-run",
			"--engine-strict",
			"--expect-results",
			"--force",
			"--foreground-scripts",
			"--format-package-lock",
			"--fund",
			"--git-tag-version",
			"--global",
			"--global-style",
			"--if-present",
			"--ignore-existing",
			"--ignore-extension",
			"--ignore-patch-failures",
			"--ignore-scripts",
			"--include-attestations",
			"--include-staged",
			"--include-workspace-root",
			"--init-private",
			"--install-links",
			"--json",
			"--keep-edit-dir",
			"--legacy-bundling",
			"--legacy-peer-deps",
			"--link",
			"--long",
			"--offline",
			"--omit-lockfile-registry-resolved",
			"--optional",
			"--package-lock",
			"--package-lock-only",
			"--packages-all",
			"--parseable",
			"--prefer-dedupe",
			"--prefer-offline",
			"--prefer-online",
			"--production",
			"--progress",
			"--provenance",
			"--read-only",
			"--rebuild-bundle",
			"--save",
			"--save-bundle",
			"--save-dev",
			"--save-exact",
			"--save-optional",
			"--save-peer",
			"--save-prod",
			"--shrinkwrap",
			"--sign-git-commit",
			"--sign-git-tag",
			"--strict-allow-scripts",
			"--strict-npmrc",
			"--strict-peer-deps",
			"--strict-ssl",
			"--timing",
			"--unicode",
			"--update-notifier",
			"--usage",
			"--version",
			"--versions",
			"--workspaces",
			"--workspaces-update",
			"--yes"
		], NPM_DEFINITIONS, "npm options whose type includes Boolean, which may stand alone: the definitions of 12.2.1 and of 11.21.1 (where shrinkwrap is one too; 12.2.1 adds ignore-existing, ignore-extension, ignore-patch-failures, allow-unused-patches, keep-edit-dir and strict-npmrc). With valueOptions they are every npm option, so an abbreviated option can be resolved as npm resolves it."),
		parsing: reviewed$1.verified({
			abbreviations: true,
			anyDashes: true,
			negation: "--no-",
			shorthands: {
				"enjoy-by": ["--before"],
				d: ["--loglevel", "info"],
				dd: ["--loglevel", "verbose"],
				ddd: ["--loglevel", "silly"],
				quiet: ["--loglevel", "warn"],
				q: ["--loglevel", "warn"],
				s: ["--loglevel", "silent"],
				silent: ["--loglevel", "silent"],
				verbose: ["--loglevel", "verbose"],
				desc: ["--description"],
				help: ["--usage"],
				local: ["--no-global"],
				n: ["--no-yes"],
				no: ["--no-yes"],
				porcelain: ["--parseable"],
				readonly: ["--read-only"],
				reg: ["--registry"],
				iwr: ["--include-workspace-root"],
				ws: ["--workspaces"],
				a: ["--all"],
				c: ["--call"],
				f: ["--force"],
				g: ["--global"],
				L: ["--location"],
				l: ["--long"],
				m: ["--message"],
				p: ["--parseable"],
				C: ["--prefix"],
				S: ["--save"],
				B: ["--save-bundle"],
				D: ["--save-dev"],
				E: ["--save-exact"],
				O: ["--save-optional"],
				P: ["--save-prod"],
				"?": ["--usage"],
				H: ["--usage"],
				h: ["--usage"],
				v: ["--version"],
				w: ["--workspace"],
				y: ["--yes"]
			}
		}, NPM_SHORTHANDS, "The shorthands npm passes to nopt: the list in definitions/index.js and the short names of the definitions (the same in 11.21.1). nopt (node_modules/nopt/lib/nopt-lib.js, versions 8.1.0 in npm 10.9.4, 9.0.0 in 11.21.1 and 10.0.1 in 12.2.1, same parse and resolveShort) strips every leading dash, so -reg, --reg and -registry work; takes an exact option first, then an exact shorthand, then a word of one-letter shorthands (-gD), then an unambiguous prefix of an option name (abbrev), then a prefix of a shorthand; and reads --no-<name> as a negated flag that takes no value. npm 10 expands abbreviations silently, npm 11 warns \"Expanding --regis to --registry. This will stop working in the next major version of npm.\" and npm 12 refuses them with EUNKNOWNCONFIG (abbrevHandler in workspaces/config/lib/index.js of 11.21.1 and 12.2.1). Shorthands are expanded only on the command line, not in .npmrc or npm_config_ variables. npx turns -p into --package and expands exact shorthands itself before npm exec reads the rest (bin/npx-cli.js)."),
		versionSelection: reviewed$1.verified({
			tagOption: "--tag",
			tagVariable: "npm_config_tag",
			tagKey: "tag",
			bareRange: "*"
		}, NPM_DEFINITIONS, "tag (default latest): \"If you ask npm to install a package and don't tell it a specific version, then it will install the specified tag\"; like any setting it comes from --tag, npm_config_tag or .npmrc. A name without a version is name@* (npm-package-arg 14.0.0, lib/npa.js). npm-pick-manifest 12.0.0 (node_modules/npm-pick-manifest/lib/index.js) picks the version of that dist-tag when the range is * or the version satisfies the range, unless it is deprecated; otherwise the highest satisfying version, preferring versions that are not deprecated; prereleases match a range only when it names one, so name@* with latest on a prerelease installs that prerelease. npm exec and npm init pick with the same settings."),
		packageSpecs: checked$3.verified({
			git: [
				"git://",
				"git+ssh://",
				"git+http://",
				"git+https://",
				"git+file://",
				"github:",
				"gist:",
				"bitbucket:",
				"gitlab:"
			],
			local: ["file:"],
			workspace: [],
			alias: "npm:",
			remoteTarball: ["http://", "https://"],
			tarballExtensions: [
				".tar",
				".tar.gz",
				".tgz"
			],
			shorthand: "github:"
		}, "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/commands/npm-install.md", "Forms of npm install <spec>: a folder; a tarball file, whose name must end in .tar, .tar.gz or .tgz; a tarball URL, which must start with http:// or https://; a git remote URL with the protocol git, git+ssh, git+http, git+https or git+file; <githubname>/<githubrepo> or github:<githubname>/<githubrepo>; gist:, bitbucket: and gitlab: shorthands; <alias>@npm:<name>. The file: prefix for local paths is documented in docs/lib/content/configuring-npm/package-json.md (Local Paths)."),
		registryConfig: checked$3.verified({
			file: ".npmrc",
			userFile: "~/.npmrc",
			key: "registry",
			scopeKeySuffix: ":registry"
		}, NPM_DEFINITIONS, "userconfig, the location of user-level settings, defaults to ~/.npmrc; registry is the base URL of the npm registry (default https://registry.npmjs.org/); a per-project .npmrc can set it like any config key (docs/lib/content/using-npm/config.md). npm config set @myco:registry=http://reg.example.com associates a scope with a registry, and any npm install of a package with that scope then requests it from there (https://docs.npmjs.com/cli/v12/using-npm/scope#associating-a-scope-with-a-registry)."),
		registryOverrides: checked$3.verified({
			registryOptions: ["--registry", "--@<scope>:registry"],
			registryVariables: ["npm_config_registry"],
			configOptions: ["--userconfig", "--globalconfig"],
			configVariables: ["npm_config_userconfig", "npm_config_globalconfig"]
		}, NPM_DEFINITIONS, "registry is a URL; userconfig and globalconfig are the user and global configuration files. Putting --foo bar on the command line sets the foo configuration parameter, and environment variables that start with npm_config_ are configuration parameters too, without regard to case (docs/lib/content/using-npm/config.md); @scope:registry is the key of a scope's registry (https://docs.npmjs.com/cli/v12/using-npm/scope)."),
		lockfileInstalls: uncertain$8("npm ci installs versions pinned in package-lock.json without applying min-release-age", "https://docs.npmjs.com/cli/v12/commands/npm-ci", "Inferred: npm ci does not list min-release-age or before among its options, and a user report (npm/cli#9277) describes it installing a version younger than the window.")
	}
};

// src/knowledge/pip.ts
const { verified: verified$8, uncertain: uncertain$7 } = verifiedOn("2026-10-30");
const PIP = "https://github.com/pypa/pip/blob/26.2.2";
const NEWS = `${PIP}/NEWS.rst`;
const USER_GUIDE = `${PIP}/docs/html/user_guide.rst`;
const CONFIGURATION$3 = `${PIP}/docs/html/topics/configuration.md`;
const SECURE_INSTALLS = `${PIP}/docs/html/topics/secure-installs.md`;
const REQUIREMENTS_FORMAT = `${PIP}/docs/html/reference/requirements-file-format.md`;
const REQ_FILE = `${PIP}/src/pip/_internal/req/req_file.py`;
const FORMAT_CONTROL = `${PIP}/src/pip/_internal/models/format_control.py`;
const CMDOPTIONS = `${PIP}/src/pip/_internal/cli/cmdoptions.py`;
const PIPX = "https://github.com/pypa/pipx/blob/1.18.10";
const PYLOCK = "https://github.com/pypa/packaging.python.org/blob/6fa4790c1fb668830f6eb94bbfe832320a9b0a2b/source/specifications/pylock-toml.rst";
const noSetting$5 = (kind) => ({ setting: uncertain$7(null, `${PIP}/src/pip/_internal/cli/cmdoptions.py`, `No option allows or forbids ${kind} requirements (concluded from the list of options). Hash-checking mode (--require-hashes, or any --hash) rejects VCS and local directory requirements, unless --no-require-hashes (26.2) turns the automatic mode off.`) });
const pip$1 = {
	id: "pip",
	name: "pip",
	kind: "package-manager",
	ecosystem: "pypi",
	cooldown: {
		setting: verified$8("uploaded-prior-to", `${USER_GUIDE}#filtering-by-upload-time`, "Only files uploaded before the given time are considered; applies to packages from remote indexes, not to local files, find-links directories or VCS requirements. Isolated build environments get the same cutoff."),
		configFiles: verified$8([], CONFIGURATION$3, "pip reads no configuration from the project: only the global, user and site (virtual environment) pip.conf, the file named by PIP_CONFIG_FILE and PIP_* environment variables. --uploaded-prior-to is not allowed in requirements files, so a project sets it through PIP_UPLOADED_PRIOR_TO or the command line, e.g. in CI."),
		cliFlag: verified$8("--uploaded-prior-to", `${USER_GUIDE}#filtering-by-upload-time`, "pip install, download, wheel, lock, index and list; environment variable PIP_UPLOADED_PRIOR_TO."),
		unit: verified$8("days", `${PIP}/src/pip/_internal/cli/cmdoptions.py`, "A duration is written PnD, a whole number of days (P3D, matched by ^P(\\d+)D$); P1W, PT24H and \"7 days\" are rejected. An ISO 8601 date or time is a fixed cutoff instead. A day is always 24 hours."),
		availableSince: verified$8("26.1.0", NEWS, "pip 26.1 accepts a duration in days (\"P3D for 3 days ago\"); the option itself exists since 26.0 with dates only."),
		default: verified$8([{
			since: "26.1.0",
			value: null
		}], `${USER_GUIDE}#filtering-by-upload-time`, "Off unless given."),
		exclude: { setting: uncertain$7(null, `${USER_GUIDE}#filtering-by-upload-time`, "No per-package exception (concluded from the list of options).") },
		securityUpdates: uncertain$7("applies", `${USER_GUIDE}#filtering-by-upload-time`, "pip does not know which versions fix vulnerabilities; the cutoff holds back every new upload.")
	},
	installScripts: {
		defaultPolicy: verified$8([{
			since: "0.0.0",
			value: "run"
		}], SECURE_INSTALLS, "pip builds a source distribution when no wheel fits, which runs its build backend; the secure-installs guide recommends --only-binary :all:. Installing a wheel runs no package code."),
		allowList: {
			setting: verified$8("--no-binary", FORMAT_CONTROL, "After --only-binary=:all:, a package named in --no-binary may only be installed from source: a name wins over :all:, so its wheels are not used. --only-binary=:all: given after it clears the exception."),
			file: verified$8("requirements.txt", REQ_FILE, "--only-binary and --no-binary are among the options a requirements file may contain."),
			availableSince: uncertain$7("7.0.0", NEWS, "--no-binary and --only-binary exist since 7.0.0 and are read from pip.conf since 7.1.0; when requirements files started to accept them is not recorded."),
			format: verified$8("One option line per package or a comma-separated list, e.g. --no-binary=docopt", `${PIP}/src/pip/_internal/cli/cmdoptions.py`, "Each use adds to the set; :all: and :none: are special values.")
		},
		disableAll: verified$8("--only-binary=:all:", SECURE_INSTALLS, "Allowed in requirements files and pip.conf (only-binary). Enforced only for packages from indexes and find-links: VCS, local directory and direct URL source requirements are still built.")
	},
	sources: {
		git: noSetting$5("VCS"),
		remoteTarball: noSetting$5("direct URL"),
		file: noSetting$5("local archive"),
		directory: noSetting$5("local directory")
	},
	project: {
		lockfiles: verified$8([{
			since: "25.1.0",
			value: ["pylock.toml"]
		}], `${PYLOCK}#file-name`, "pip lock (experimental since 25.1) writes pylock.toml; pip install -r pylock.toml is experimental since 26.1. The specification also allows pylock.<name>.toml (extra.lockfilePattern)."),
		manifests: verified$8(["requirements.txt"], REQUIREMENTS_FORMAT, "\"requirements.txt is usually what these files are named (although, that is not a requirement)\"; the format is meant only for pip."),
		workspaces: uncertain$7(null, REQUIREMENTS_FORMAT, "pip has no workspaces."),
		workspacesObjectKey: uncertain$7(null, REQUIREMENTS_FORMAT, "No workspaces.")
	},
	extra: {
		requirementsOptions: verified$8([
			"-i",
			"--index-url",
			"--extra-index-url",
			"--no-index",
			"-c",
			"--constraint",
			"-r",
			"--requirement",
			"-e",
			"--editable",
			"-f",
			"--find-links",
			"--no-binary",
			"--only-binary",
			"--prefer-binary",
			"--require-hashes",
			"--no-require-hashes",
			"--pre",
			"--all-releases",
			"--only-final",
			"--trusted-host",
			"--use-feature"
		], REQ_FILE, "SUPPORTED_OPTIONS in pip 26.2.2; per requirement also --hash and --config-settings. Any other option, --uploaded-prior-to included, makes the file fail to parse."),
		buildSwitch: uncertain$7({
			setting: "--only-binary",
			value: ":all:",
			since: "7.0.0",
			covers: ["registry"]
		}, NEWS, "The option exists since 7.0.0; when requirements files started to accept it is not recorded. pip applies it only to packages found on indexes and find-links (format_control is used only by the package finder), so VCS, local directory and direct URL source requirements are still built."),
		configFileNames: verified$8(["pip.conf", "pip.ini"], `${PIP}/src/pip/_internal/configuration.py`, "CONFIG_BASENAME is pip.ini on Windows and pip.conf elsewhere; pip looks for it only in the global, user and site locations, never in the project."),
		configFileVariable: verified$8("PIP_CONFIG_FILE", `${CONFIGURATION$3}#environment-variable`, "Names a configuration file pip loads last; set to os.devnull it turns all configuration files off."),
		environmentVariable: verified$8("PIP_UPLOADED_PRIOR_TO", `${CONFIGURATION$3}#environment-variables`, "Every long option has a PIP_<UPPER_LONG_NAME> variable with dashes replaced by underscores. Tested on 2026-10-30: pip 25.3 ignored PIP_UPLOADED_PRIOR_TO=P100000D without a word, 26.0 rejected the duration (dates only), 26.1 and 26.2.2 found no version."),
		durationStrings: verified$8({
			since: "26.1.0",
			syntax: "iso8601"
		}, NEWS, "Only whole days, written PnD, are accepted."),
		missingUploadTime: verified$8("Installation fails when an index gives no upload time while --uploaded-prior-to is set", `${USER_GUIDE}#filtering-by-upload-time`, "Upload times exist only in the JSON form of the simple repository API (PEP 700); indexes that serve only HTML have none."),
		lockfileFormat: verified$8({
			packages: "packages",
			vcs: "vcs",
			directory: "directory",
			archive: "archive",
			sdist: "sdist",
			wheels: "wheels",
			index: "index",
			sources: {
				git: "vcs",
				remoteTarball: "archive",
				directory: "directory"
			}
		}, PYLOCK, "Each [[packages]] entry has exactly one of vcs (always built), directory (always built), archive (a source tree or wheel at a URL or path) or sdist and wheels from an index. A package with an sdist and no wheels is built when installed."),
		requirementsForms: verified$8("name==version with --hash options, name @ URL for an archive, a local archive or project path, and VCS URLs (name @ git+https://… or -e git+…)", REQUIREMENTS_FORMAT),
		requirementsFormat: verified$8({
			vcs: {
				git: ["git+"],
				other: [
					"hg+",
					"svn+",
					"bzr+"
				]
			},
			direct: " @ ",
			editable: ["-e", "--editable"],
			egg: "#egg=",
			comment: "#",
			continuation: "\\"
		}, `${PIP}/docs/html/topics/vcs-support.md`, "VCS requirements start with git+, hg+, svn+ or bzr+, alone or after \"name @\"; a direct reference is \"name @ URL\" (PEP 508); -e installs a project path or VCS URL in editable mode. The legacy #egg= fragment names the project of a VCS URL. Lines ending with a backslash continue on the next line, and # starts a comment (requirements-file-format.md)."),
		requirementsIncludes: verified$8({
			requirements: ["-r", "--requirement"],
			constraints: ["-c", "--constraint"]
		}, `${REQUIREMENTS_FORMAT}#referring-to-other-requirements-files`, "Option names from cli/cmdoptions.py. A relative path is relative to the directory of the file that includes it, and a file given as an http, https or file URL is downloaded (req_file.py, _parse_and_recurse); a file that includes itself is an error."),
		requirementsPaths: verified$8({
			separators: ["/", "\\"],
			currentDirectory: ".",
			archiveExtensions: [
				".zip",
				".whl",
				".tar.bz2",
				".tbz",
				".tar.gz",
				".tgz",
				".tar",
				".tar.xz",
				".txz",
				".tlz",
				".tar.lz",
				".tar.lzma"
			],
			urlSchemes: [
				"http",
				"https",
				"ftp"
			],
			fileScheme: "file:"
		}, `${PIP}/src/pip/_internal/req/constructors.py`, "A requirement that contains a path separator (/, and \\ on Windows) or starts with . looks like a path (_looks_like_path): a directory there is a project built from source. A name with an archive extension (utils/filetypes.py) is a local archive, even when the file does not exist. http, https, ftp and file URLs are links (utils/urls.py, is_url)."),
		lockfilePattern: verified$8("^pylock\\.([^.]+)\\.toml$", `${PYLOCK}#file-name`, "A named lock file, next to or instead of pylock.toml; pip lock -o writes any name."),
		commandLine: verified$8({
			add: [["pip", "install"], ["pip3", "install"]],
			run: [],
			create: [],
			valueOptions: [
				"-r",
				"--requirement",
				"-c",
				"--constraint",
				"--build-constraint",
				"--requirements-from-script",
				"-e",
				"--editable",
				"--group",
				"-t",
				"--target",
				"--platform",
				"--python-version",
				"--implementation",
				"--abi",
				"--root",
				"--prefix",
				"--src",
				"--source",
				"--source-dir",
				"--source-directory",
				"--upgrade-strategy",
				"-C",
				"--config-settings",
				"--progress-bar",
				"--root-user-action",
				"--report",
				"-i",
				"--index-url",
				"--pypi-url",
				"--extra-index-url",
				"-f",
				"--find-links",
				"--refresh-package",
				"--uploaded-prior-to",
				"--no-binary",
				"--only-binary",
				"--all-releases",
				"--only-final",
				"--python",
				"--log",
				"--log-file",
				"--local-log",
				"--keyring-provider",
				"--proxy",
				"--retries",
				"--resume-retries",
				"--timeout",
				"--default-timeout",
				"--exists-action",
				"--trusted-host",
				"--cert",
				"--client-cert",
				"--cache-dir",
				"--use-feature",
				"--use-deprecated"
			],
			flagOptions: [
				"--no-deps",
				"--no-dependencies",
				"--only-deps",
				"--only-dependencies",
				"--dry-run",
				"--user",
				"--no-user",
				"-U",
				"--upgrade",
				"--force-reinstall",
				"-I",
				"--ignore-installed",
				"--ignore-requires-python",
				"--no-build-isolation",
				"--use-pep517",
				"--check-build-dependencies",
				"--break-system-packages",
				"--compile",
				"--no-compile",
				"--no-warn-script-location",
				"--no-warn-conflicts",
				"--require-hashes",
				"--no-require-hashes",
				"--no-clean",
				"--no-index",
				"--pre",
				"--prefer-binary",
				"-h",
				"--help",
				"--debug",
				"--isolated",
				"--require-virtualenv",
				"--require-venv",
				"-v",
				"--verbose",
				"-V",
				"--version",
				"-q",
				"--quiet",
				"--no-input",
				"--no-proxy-env",
				"--no-cache-dir",
				"--disable-pip-version-check",
				"--no-color",
				"--no-python-version-warning"
			],
			parsing: {
				abbreviations: true,
				groupedShortOptions: true
			},
			editableOptions: ["-e", "--editable"]
		}, `${PIP}/src/pip/_internal/commands/install.py`, "pip and pip3 are the console scripts of the package (pyproject.toml). The options of pip install (install.py) and the general options of every command (cmdoptions.py, general_group), which may also come before install. pip reads them with optparse: --opt value and --opt=value, -rFILE and -r FILE, grouped short flags, and a long option shortened to any prefix that names one option (cli/parser.py keeps optparse's matching), so --extra means --extra-index-url. -e takes a local project path or a VCS URL to install in editable mode. -r, -c, --requirements-from-script and --group read requirements from files of the project."),
		registryOverrides: verified$8({
			registryOptions: [
				"-i",
				"--index-url",
				"--pypi-url",
				"--extra-index-url",
				"-f",
				"--find-links"
			],
			registryVariables: [
				"PIP_INDEX_URL",
				"PIP_PYPI_URL",
				"PIP_EXTRA_INDEX_URL",
				"PIP_FIND_LINKS"
			],
			configOptions: [],
			configVariables: ["PIP_CONFIG_FILE"]
		}, CMDOPTIONS, "index_group: --index-url (alias -i, --pypi-url) is the base URL of the package index, --extra-index-url adds indexes, --find-links (-f) adds an HTML page or a directory of archives. Every long option can be set as PIP_<UPPER_LONG_NAME>, dashes replaced by underscores (docs/html/topics/configuration.md); PIP_CONFIG_FILE names a configuration file loaded last, which may set any index. Requirements files may set --index-url, --extra-index-url and --find-links too (req/req_file.py)."),
		selection: verified$8({
			prereleases: {
				onFlags: ["--pre"],
				onLists: ["--all-releases"],
				offLists: ["--only-final"],
				flagVariables: ["PIP_PRE"],
				onListVariables: ["PIP_ALL_RELEASES"],
				offListVariables: ["PIP_ONLY_FINAL"]
			},
			buildFromSource: {
				onLists: ["--no-binary"],
				offLists: ["--only-binary"],
				onListVariables: ["PIP_NO_BINARY"],
				offListVariables: ["PIP_ONLY_BINARY"]
			}
		}, CMDOPTIONS, "--pre includes pre-release and development versions (pip only finds stable versions by default) and stands for --all-releases :all:; --all-releases and --only-final take :all:, :none: or package names separated by commas and allow or forbid pre-releases of those packages (models/release_control.py, allows_prereleases: a named package first, then :all:). --no-binary and --only-binary take the same lists: --no-binary keeps pip from using wheels, so the package is built from source, --only-binary from using source distributions (models/format_control.py, handle_mutual_excludes and get_allowed_formats). Each long option can also be set as PIP_<NAME> (docs/html/topics/configuration.md), which the command line overrides."),
		pipxSelection: verified$8({
			prereleases: {
				flagVariables: ["PIP_PRE"],
				onListVariables: ["PIP_ALL_RELEASES"],
				offListVariables: ["PIP_ONLY_FINAL"]
			},
			buildFromSource: {
				onListVariables: ["PIP_NO_BINARY"],
				offListVariables: ["PIP_ONLY_BINARY"]
			}
		}, `${PIPX}/docs/reference/environment-variables.rst`, "pipx forwards the standard PIP_* variables to pip (except PIP_USER, PIP_DISABLE_PIP_VERSION_CHECK, PIP_TARGET and PIP_KEYRING_PROVIDER); the uv backend ignores them (docs/how-to/use-private-index.rst). pipx has no option of its own for pre-releases or source builds; --pip-args may carry them."),
		pipxCommandLine: verified$8({
			add: [["pipx", "install"]],
			run: [{
				command: ["pipx", "run"],
				packageOptions: ["--spec"],
				extraPackageOptions: ["--with"],
				scriptSuffixes: [".py"]
			}],
			create: [],
			valueOptions: [
				"-i",
				"--index-url",
				"--pip-args",
				"--preinstall",
				"--lock",
				"--include-resources-from",
				"--upgrade-strategy",
				"--suffix",
				"--python",
				"--fetch-python",
				"--app",
				"--cooldown",
				"--backend",
				"--output",
				"--python-args"
			],
			flagOptions: [
				"-q",
				"--quiet",
				"-v",
				"--verbose",
				"--skip-maintenance",
				"--global",
				"-f",
				"--force",
				"-U",
				"--upgrade",
				"--include-deps",
				"--system-site-packages",
				"--fetch-missing-python",
				"-e",
				"--editable",
				"--no-cache",
				"--refresh",
				"--no-path-check",
				"--path",
				"--pypackages",
				"--version"
			],
			parsing: {
				abbreviations: true,
				groupedShortOptions: true
			},
			addPackageOptions: ["--preinstall"]
		}, `${PIPX}/src/pipx/main.py`, "pipx installs applications from PyPI with pip (or uv) in environments of their own. pipx install takes one or more package specs, a VCS URL, a local path or archive, or a script (--preinstall adds packages to the environment; -f is --force, not find-links). pipx run takes the app first (argparse REMAINDER, so its options come before it), --spec names the package to install and run, --with adds packages; a first argument ending in .py is a local script, or a script to download when it is a URL (docs/how-to/run-scripts.rst). argparse accepts abbreviated long options."),
		pipxRegistryOverrides: verified$8({
			registryOptions: ["-i", "--index-url"],
			registryVariables: [],
			configOptions: ["--pip-args"],
			configVariables: []
		}, `${PIPX}/src/pipx/main.py`, "--index-url is the base URL of the index; --pip-args is split and handed to pip, so it may carry --extra-index-url, --find-links or --no-index. With the pip backend pipx passes the PIP_* variables on to pip; with the uv backend it ignores them and uv reads its own (docs/how-to/use-uv-backend.rst); both kinds are registry variables of pip and uv."),
		latestVersion: verified$8("26.2.2", NEWS, "Released on 2026-10-20.")
	}
};

// src/knowledge/pdm.ts
const { verified: verified$7, uncertain: uncertain$6 } = verifiedOn("2026-10-30");
const PDM = "https://github.com/pdm-project/pdm/blob/2.29.5";
const LOCKFILE = `${PDM}/docs/usage/lockfile.md`;
const CHANGELOG$2 = `${PDM}/CHANGELOG.md`;
const CANDIDATES = `${PDM}/src/pdm/models/candidates.py`;
const noSetting$4 = (kind) => ({ setting: uncertain$6(null, `${PDM}/docs/reference/pep621.md`, `No setting allows or forbids ${kind} dependencies (concluded from the documented [tool.pdm] settings); only-binary does not stop them from being built.`) });
const pdm$1 = {
	id: "pdm",
	name: "PDM",
	kind: "package-manager",
	ecosystem: "pypi",
	cooldown: {
		setting: verified$7("exclude-newer", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "In the [tool.pdm.resolution] table of pyproject.toml: distributions uploaded after the cutoff are left out when dependencies are resolved (pdm lock, add, update). The --exclude-newer option of pdm lock wins over it, and it wins over strategy.exclude-newer in the PDM configuration."),
		configFiles: verified$7(["pyproject.toml"], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "The [tool.pdm.resolution] table."),
		cliFlag: verified$7("--exclude-newer", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "pdm lock --exclude-newer, since 2.13.0."),
		unit: verified$7("duration-string", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "An RFC 3339 timestamp, a UTC date or a relative duration N{d|h|w} such as 7d, 12h or 3w, counted from the current UTC time."),
		availableSince: verified$7("2.26.9", CHANGELOG$2, "\"Support exclude-newer in pyproject.toml in the [tool.pdm.resolution] table\" (#3776); the pdm lock option exists since 2.13.0."),
		default: verified$7([{
			since: "2.26.9",
			value: null
		}], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "No default: without a value every upload time is accepted."),
		exclude: {
			setting: verified$7("exclude-newer-override", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "A table [tool.pdm.resolution.exclude-newer-override] of package = false (no cutoff) or package = another date or duration; package-specific values win over the global cutoff."),
			availableSince: verified$7("2.29.1", CHANGELOG$2, "\"Allow package-specific overrides for exclude-newer resolution limits\" (#3809)."),
			patternSyntax: verified$7("Package names, normalized before matching; no wildcards", `${LOCKFILE}#exclude-packages-newer-than-specific-date`)
		},
		securityUpdates: uncertain$6("applies", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "PDM does not know which versions fix vulnerabilities; the cutoff holds back every newer distribution of a package without an override.")
	},
	installScripts: {
		defaultPolicy: verified$7([{
			since: "0.0.0",
			value: "run"
		}], `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`, "Without only-binary, PDM locks and installs source distributions when they fit, which builds them and runs their build backend. Installing a wheel runs no package code."),
		allowList: {
			setting: verified$7("no-binary", `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`, "The packages in no-binary are locked and installed from source distributions only. A name in no-binary wins over only-binary = \":all:\" (FormatControl of unearth, which PDM uses), so with both the named packages are the only ones built, and always from source."),
			file: verified$7("pyproject.toml", `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`, "The [tool.pdm.resolution] table."),
			availableSince: verified$7("2.15.0", CHANGELOG$2, "no-binary, only-binary and prefer-binary keys in [tool.pdm.resolution] (#2656)."),
			format: verified$7("A comma-separated string or a list of package names, or :all:", `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`)
		},
		disableAll: verified$7("only-binary", `${LOCKFILE}#set-acceptable-format-for-locking-or-installing`, "only-binary = \":all:\" locks and installs only wheels. The variables PDM_ONLY_BINARY and PDM_NO_BINARY win over pyproject.toml.")
	},
	sources: {
		git: noSetting$4("git"),
		remoteTarball: noSetting$4("URL"),
		file: noSetting$4("local archive"),
		directory: noSetting$4("local directory")
	},
	project: {
		lockfiles: verified$7([{
			since: "0.0.0",
			value: ["pdm.lock"]
		}], LOCKFILE, "pdm.lock next to pyproject.toml; pdm lock --lockfile writes another name."),
		manifests: verified$7(["pyproject.toml"], `${PDM}/docs/reference/pep621.md`),
		workspaces: uncertain$6(null, `${PDM}/docs/usage/workspace.md`, "Workspaces ([tool.pdm.workspace] members) are experimental since 2.28.0 and are locked and installed from the root only, so depcurfew configures the root and reads no members."),
		workspacesObjectKey: uncertain$6(null, `${PDM}/docs/usage/workspace.md`, "Not read; see workspaces.")
	},
	extra: {
		configTables: verified$7({ "pyproject.toml": "tool.pdm.resolution" }, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "exclude-newer, its overrides, only-binary and no-binary share the table."),
		pyprojectTable: verified$7("tool.pdm", `${PDM}/docs/reference/pep621.md`, "PDM keeps its settings in [tool.pdm] of pyproject.toml."),
		buildSwitch: verified$7({
			setting: "only-binary",
			value: ":all:",
			since: "2.15.0",
			covers: ["registry"]
		}, CHANGELOG$2, "only-binary in [tool.pdm.resolution] since 2.15.0 (#2656). It covers packages from an index: git, URL and path requirements already name their source and are built regardless (candidates.py)."),
		durationStrings: verified$7({
			since: "2.26.8",
			syntax: "compact"
		}, CHANGELOG$2, "\"pdm lock --exclude-newer now accepts relative durations in the format N{d|h|w}\" (#3760)."),
		durationUnits: verified$7([
			"hours",
			"days",
			"weeks"
		], `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "Written as Nh, Nd and Nw."),
		excludeWildcards: verified$7({
			since: null,
			trailingOnly: false
		}, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "Override keys are package names."),
		excludeValue: verified$7(false, `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "package = false disables the cutoff for that package."),
		missingUploadTime: verified$7("A distribution without an upload time is treated as unavailable while a cutoff applies to its package", `${LOCKFILE}#exclude-packages-newer-than-specific-date`, "The index must give upload-time (PEP 700); an override of false lifts it for the package."),
		lockfileFormat: uncertain$6({
			packages: "package",
			files: "files",
			file: "file",
			vcs: [
				"git",
				"hg",
				"svn",
				"bzr"
			],
			url: "url",
			path: "path",
			editable: "editable"
		}, CANDIDATES, "pdm.lock (lock_version 4.5) has no documented format beyond the docs examples. Each [[package]] has name, version and files ({file, hash} for every distribution); a VCS package has its repository under the key of its VCS (git = \"…\") with ref and revision; a local archive or directory has path, a remote archive url, and editable packages editable = true (as_lockfile_entry). A package from an index without a .whl file is built when installed."),
		uvMode: uncertain$6({
			file: "pdm.toml",
			key: "use_uv"
		}, `${PDM}/docs/usage/uv.md`, "Experimental since 2.19.0: PDM resolves and installs with uv. It passes the cutoff and the build settings to uv lock, but runs uv sync --frozen without the build settings (src/pdm/installers/uv.py), and pdm.lock then lists source distributions even with only-binary."),
		commandLine: verified$7({
			add: [["pdm", "add"]],
			run: [],
			create: [],
			valueOptions: [
				"-c",
				"--config",
				"--pep582",
				"-L",
				"--lockfile",
				"-G",
				"--group",
				"-k",
				"--skip",
				"-e",
				"--editable",
				"-p",
				"--project",
				"--venv",
				"--override"
			],
			flagOptions: [
				"-V",
				"--version",
				"-h",
				"--help",
				"-v",
				"--verbose",
				"-q",
				"--quiet",
				"--no-cache",
				"-I",
				"--ignore-python",
				"-n",
				"--non-interactive",
				"-g",
				"--global",
				"-d",
				"--dev",
				"--no-sync",
				"--frozen-lockfile",
				"--no-lock",
				"--save-compatible",
				"--save-safe-compatible",
				"--save-wildcard",
				"--save-exact",
				"--save-minimum",
				"--update-reuse",
				"--update-eager",
				"--update-all",
				"--update-reuse-installed",
				"--pre",
				"--prerelease",
				"--stable",
				"-u",
				"--unconstrained",
				"--no-editable",
				"--no-self",
				"-x",
				"--fail-fast",
				"--no-isolation",
				"--dry-run"
			],
			parsing: {
				abbreviations: true,
				groupedShortOptions: true
			},
			editableOptions: ["-e", "--editable"]
		}, `${PDM}/src/pdm/cli/commands/add.py`, "pdm add takes requirements as arguments and editable ones with -e; its options come from cli/options.py and the global ones (-c/--config, --pep582, -I, -n, --no-cache) from core.py. --venv and --pep582 take an optional value, so argparse takes the next word for it. PDM parses with argparse, which accepts abbreviated long options."),
		registryOverrides: verified$7({
			registryOptions: [],
			registryVariables: ["PDM_PYPI_URL"],
			configOptions: ["-c", "--config"],
			configVariables: ["PDM_CONFIG_FILE"]
		}, `${PDM}/src/pdm/project/config.py`, "pypi.url, the index PDM uses when pyproject.toml names no source called pypi, can be set with PDM_PYPI_URL (docs/usage/config.md); -c/--config and PDM_CONFIG_FILE name another configuration file, which may set any index."),
		selection: verified$7({
			prereleases: {
				onFlags: ["--pre", "--prerelease"],
				offFlags: ["--stable"]
			},
			buildFromSource: {
				onListVariables: ["PDM_NO_BINARY"],
				offListVariables: ["PDM_ONLY_BINARY"]
			}
		}, `${PDM}/src/pdm/cli/options.py`, "pdm add --pre/--prerelease allows pre-releases of the added packages to be pinned and --stable only stable versions (prerelease_option; commands/add.py sets req.prerelease). PDM_NO_BINARY and PDM_ONLY_BINARY are lists of packages separated by commas, :all: for every package, of which no wheel, or only wheels, are locked and installed (docs/usage/lockfile.md; environments/base.py, _setting_list)."),
		latestVersion: verified$7("2.29.5", CHANGELOG$2, "Released on 2026-10-30.")
	}
};

// src/knowledge/pipenv.ts
const { verified: verified$6, uncertain: uncertain$5 } = verifiedOn("2026-10-30");
const PIPENV = "https://github.com/pypa/pipenv/blob/v2026.10.4";
const PIPFILE = `${PIPENV}/docs/pipfile.md`;
const CHANGELOG$1 = `${PIPENV}/CHANGELOG.md`;
const CONFIGURATION$2 = `${PIPENV}/docs/configuration.md`;
const noSetting$3 = (kind) => ({ setting: uncertain$5(null, PIPFILE, `No Pipfile setting allows or forbids ${kind} dependencies (concluded from the documented [pipenv] directives).`) });
const pipenv$1 = {
	id: "pipenv",
	name: "Pipenv",
	kind: "package-manager",
	ecosystem: "pypi",
	cooldown: {
		setting: verified$6("cool-down-period", `${PIPFILE}#cool-down-period`, "In the [pipenv] section of the Pipfile: the resolver considers only versions uploaded at least that many days ago. Pipenv computes a cutoff (now minus N days, UTC) and hands it to pip as uploaded-prior-to."),
		configFiles: verified$6(["Pipfile"], `${PIPFILE}#pipenv-directives`, "The [pipenv] section."),
		cliFlag: uncertain$5(null, `${PIPENV}/docs/commands.md`, "No command-line option."),
		unit: verified$6("duration-string", `${PIPFILE}#cool-down-period`, "A string in <int>d format, e.g. \"30d\"; any other form is rejected (pipenv/vendor/plette/models/sections.py)."),
		availableSince: verified$6("2026.6.2", CHANGELOG$1, "\"Added support for cool-down-period in the [pipenv] section of the Pipfile\" under 2026.6.2 (repeated under 2026.7.0 and 2026.7.1). Checked against the wheels on 2026-10-30: missing in 2026.6.1, present in 2026.6.2."),
		default: verified$6([{
			since: "2026.6.2",
			value: null
		}], `${PIPFILE}#cool-down-period`, "Off unless set."),
		exclude: { setting: uncertain$5(null, `${PIPFILE}#cool-down-period`, "No per-package exception: the cutoff applies to every package.") },
		securityUpdates: uncertain$5("applies", `${PIPFILE}#cool-down-period`, "The cutoff holds back every newer version, security fixes included.")
	},
	installScripts: {
		defaultPolicy: verified$6([{
			since: "0.0.0",
			value: "run"
		}], CONFIGURATION$2, "Pipenv installs with pip, which builds source distributions when no wheel fits. Pipenv honors pip configuration and PIP_* variables, which may forbid building (PIP_ONLY_BINARY=:all:), but the Pipfile has no setting for it."),
		allowList: { setting: uncertain$5(null, PIPFILE, "No documented setting; a per-package no_binary = true exists in the code (pipenv/routines/install.py) but forces building rather than allowing it.") },
		disableAll: uncertain$5(null, CONFIGURATION$2, "No Pipfile setting. Only pip configuration or PIP_ONLY_BINARY=:all: in the environment (Pipenv loads the project .env for every command) forbids building.")
	},
	sources: {
		git: noSetting$3("git"),
		remoteTarball: noSetting$3("URL"),
		file: noSetting$3("local archive"),
		directory: noSetting$3("local directory")
	},
	project: {
		lockfiles: verified$6([{
			since: "0.0.0",
			value: ["Pipfile.lock"]
		}], `${PIPFILE}#pipfilelock`, "JSON, generated next to the Pipfile."),
		manifests: verified$6(["Pipfile"], `${PIPFILE}#pipfile`, "TOML."),
		workspaces: uncertain$5(null, PIPFILE, "Pipenv has no workspaces."),
		workspacesObjectKey: uncertain$5(null, PIPFILE, "No workspaces.")
	},
	extra: {
		configTables: verified$6({ Pipfile: "pipenv" }, `${PIPFILE}#pipenv-directives`, "Directives such as cool-down-period and allow_prereleases live in [pipenv]."),
		durationStrings: verified$6({
			since: "2026.6.2",
			syntax: "compact"
		}, `${PIPFILE}#cool-down-period`, "Only whole days (<int>d) are accepted."),
		durationUnits: verified$6(["days"], `${PIPFILE}#cool-down-period`, "Whole days only."),
		missingUploadTime: verified$6("An index without upload times makes the setting accepted but without effect", `${PIPFILE}#cool-down-period`, "\"When the index does not provide upload-time metadata (e.g. most private mirrors) the setting is accepted but has no filtering effect.\""),
		resolverBypass: uncertain$5({
			table: "pipenv",
			keys: ["resolver_backend", "resolver"],
			value: "pure-python"
		}, `${PIPENV}/pipenv/routines/lock.py`, "Not documented. Tested on 2026-10-30 with 2026.10.4: with resolver_backend = \"pure-python\" in [pipenv], pipenv lock locked the newest versions despite cool-down-period = \"100000d\"; resolver is the older name of the key."),
		lockfileFormat: verified$6({
			meta: "_meta",
			git: "git",
			file: "file",
			path: "path",
			editable: "editable",
			hashes: "hashes"
		}, `${PIPFILE}#pipfilelock-structure`, "Every key but _meta is a category (default, develop and custom ones) mapping names to entries: index packages have version, hashes and index; git entries git and ref; remote archives file; local projects path, and editable = true for editable installs (Pipfile \"Packages Section\"). The hashes of wheels and source distributions are listed together, so the lockfile does not show which packages are built."),
		commandLine: verified$6({
			add: [["pipenv", "install"]],
			run: [],
			create: [],
			valueOptions: [
				"--pypi-mirror",
				"--python",
				"--extra-pip-args",
				"--resolver",
				"--categories",
				"--extras",
				"--config-settings",
				"-i",
				"--index",
				"-r",
				"--requirements",
				"-e",
				"--editable"
			],
			flagOptions: [
				"-h",
				"--help",
				"--version",
				"--where",
				"--venv",
				"--py",
				"--envs",
				"--rm",
				"--bare",
				"--man",
				"--support",
				"-v",
				"--verbose",
				"-q",
				"--quiet",
				"--clear",
				"--site-packages",
				"--no-site-packages",
				"--pre",
				"-d",
				"--dev",
				"--all",
				"--ignore-pipfile",
				"--skip-lock",
				"--system",
				"--deploy"
			],
			parsing: {
				abbreviations: true,
				groupedShortOptions: true
			},
			editableOptions: ["-e", "--editable"]
		}, `${PIPENV}/pipenv/cli/options.py`, "pipenv install takes packages as arguments (without any it installs the Pipfile) and editable ones with -e; -r imports a requirements file. The options of install and the global flags of pipenv, read with argparse, which accepts abbreviated long options."),
		registryOverrides: verified$6({
			registryOptions: [
				"-i",
				"--index",
				"--pypi-mirror"
			],
			registryVariables: ["PIPENV_PYPI_MIRROR"],
			configOptions: ["--extra-pip-args"],
			configVariables: ["PIPENV_DOTENV_LOCATION"]
		}, CONFIGURATION$2, "--index names a package index by URL or by a source name of the Pipfile; --pypi-mirror and PIPENV_PYPI_MIRROR replace PyPI. --extra-pip-args hands arguments to pip, which may name another index, and Pipenv loads PIP_* variables from the .env file that PIPENV_DOTENV_LOCATION names (options.py)."),
		selection: verified$6({
			prereleases: { onFlags: ["--pre"] },
			buildFromSource: {
				onListVariables: ["PIP_NO_BINARY"],
				offListVariables: ["PIP_ONLY_BINARY"]
			}
		}, `${PIPENV}/pipenv/cli/options.py`, "pipenv install --pre allows pre-releases (and records allow_prereleases in the Pipfile, routines/install.py). Pipenv installs with pip, which reads PIP_NO_BINARY and PIP_ONLY_BINARY like --no-binary and --only-binary (see buildSwitch)."),
		latestVersion: verified$6("2026.10.4", CHANGELOG$1, "Released on 2026-10-28.")
	}
};

// src/knowledge/pnpm.ts
const { verified: verified$5, uncertain: uncertain$4 } = verifiedOn("2026-10-28");
const checked$2 = verifiedOn("2026-10-29");
const reviewed = verifiedOn("2026-10-30");
const PNPM_V12 = "https://github.com/pnpm/pnpm/blob/v12.16.1";
const RESOLUTION$1 = "https://pnpm.io/settings/dependency-resolution";
const SETTINGS_V10 = "https://pnpm.io/10.x/settings";
const BUILD = "https://pnpm.io/settings/build";
const RESOLUTION_V11 = "https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/dependency-resolution.md";
const BUILD_V11 = "https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-11.x/settings/build.md";
const release$2 = (version) => `https://github.com/pnpm/pnpm/releases/tag/v${version}`;
const exoticSubdeps = {
	setting: verified$5("blockExoticSubdeps", SETTINGS_V10, "Blocks git repositories and tarball URLs for transitive dependencies only; no setting blocks them as direct dependencies."),
	values: verified$5(["true", "false"], RESOLUTION$1),
	availableSince: verified$5("10.26.0", SETTINGS_V10),
	default: verified$5([{
		since: "10.26.0",
		value: "false"
	}, {
		since: "11.0.0",
		value: "true"
	}], release$2("11.0.0"))
};
const localPaths = { setting: uncertain$4(null, "https://pnpm.io/settings", "No setting restricts file: or link: dependencies (concluded from the full settings list); blockExoticSubdeps treats local paths and workspace links as trusted.") };
const WORKSPACE_YAML_V10 = "https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/pnpm-workspace_yaml.md";
const pnpm$1 = {
	id: "pnpm",
	name: "pnpm",
	kind: "package-manager",
	cooldown: {
		setting: verified$5("minimumReleaseAge", "https://pnpm.io/blog/releases/10.16"),
		configFiles: verified$5(["pnpm-workspace.yaml"], release$2("11.0.0"), "pnpm-workspace.yaml (or the global config.yaml) works in every version that has the setting. pnpm 10 also reads minimum-release-age from .npmrc; pnpm 11+ reads only auth and registry settings from .npmrc and ignores the package.json \"pnpm\" field."),
		cliFlag: uncertain$4(null, "https://pnpm.io/cli/install", "No dedicated flag is documented for install or add; release notes mention \"a CLI flag\" without syntax. Environment variable: PNPM_CONFIG_MINIMUM_RELEASE_AGE (pnpm 11+), npm_config_minimum_release_age (pnpm 10)."),
		unit: verified$5("minutes", RESOLUTION$1, "Integer number of minutes, e.g. 1440 = 1 day; no duration strings."),
		availableSince: verified$5("10.16.0", release$2("10.16.0")),
		default: verified$5([{
			since: "10.16.0",
			value: 0
		}, {
			since: "11.0.0",
			value: 1440
		}], RESOLUTION_V11, "The built-in 1440 is non-strict: pnpm adds immature versions to minimumReleaseAgeExclude instead of failing (see strictMode)."),
		exclude: {
			setting: verified$5("minimumReleaseAgeExclude", SETTINGS_V10),
			availableSince: verified$5("10.16.0", release$2("10.16.0")),
			patternSyntax: verified$5("Package names (all versions); globs such as @myorg/* since 10.17.0; exact versions name@1.2.3 or name@1.2.3 || 1.2.4 since 10.19.0; ranges are not documented", SETTINGS_V10)
		},
		securityUpdates: verified$5("applies", "https://pnpm.io/cli/audit", "No setting bypasses the delay. Since 11.0.0, pnpm audit --fix adds the minimum patched version of each advisory to minimumReleaseAgeExclude (since 11.22.0 only while it is still inside the window).")
	},
	installScripts: {
		defaultPolicy: verified$5([{
			since: "0.0.0",
			value: "run"
		}, {
			since: "10.0.0",
			value: "deny-except-allowlist"
		}], release$2("10.0.0"), "Unreviewed builds only warn in pnpm 10; strictDepBuilds is true by default since 11.0.0, so they fail the install. Prepare scripts of git-hosted dependencies are blocked since 10.26.0."),
		allowList: {
			setting: verified$5("allowBuilds", BUILD, "Replaced onlyBuiltDependencies, which was removed in 11.0.0 (see legacyAllowList). Since 12.11.0, permissions.<package>.build takes precedence over allowBuilds."),
			file: verified$5("pnpm-workspace.yaml", BUILD),
			availableSince: verified$5("10.26.0", SETTINGS_V10),
			format: verified$5("Map of package matcher to true (allow) or false (deny), e.g. esbuild: true or \"nx@21.6.4 || 21.6.5\": true; a bare name never approves git or tarball dependencies (pnpm 11+)", BUILD_V11)
		},
		disableAll: verified$5("ignoreScripts", "https://pnpm.io/cli/install", "Default false; --ignore-scripts on the CLI. Also skips the project's own scripts.")
	},
	sources: {
		git: exoticSubdeps,
		remoteTarball: exoticSubdeps,
		file: localPaths,
		directory: localPaths
	},
	project: {
		lockfiles: verified$5([{
			since: "0.0.0",
			value: ["pnpm-lock.yaml"]
		}], "https://github.com/pnpm/pnpm.io/blob/main/docs/git.md"),
		manifests: verified$5([
			"package.json",
			"package.json5",
			"package.yaml"
		], "https://github.com/pnpm/pnpm.io/blob/main/docs/package_json.md"),
		workspaces: verified$5({
			files: ["pnpm-workspace.yaml"],
			key: "packages"
		}, WORKSPACE_YAML_V10, "Globs with ! exclusions. Without packages only the root is in the workspace; pnpm still reads settings from the file in single-package projects. pnpm ignores workspaces in package.json."),
		workspacesObjectKey: uncertain$4(null, WORKSPACE_YAML_V10, "The docs show packages only as a list; concluded from the absence of an object form.")
	},
	extra: {
		commandLine: checked$2.verified({
			add: [["pnpm", "add"]],
			run: [
				{
					command: ["pnx"],
					packageOptions: ["--package"],
					shellOptions: ["--shell-mode", "-c"]
				},
				{
					command: ["pnpx"],
					packageOptions: ["--package"],
					shellOptions: ["--shell-mode", "-c"]
				},
				{
					command: ["pnpm", "dlx"],
					packageOptions: ["--package"],
					shellOptions: ["--shell-mode", "-c"]
				}
			],
			create: [{
				command: ["pnpm", "create"],
				packageOptions: []
			}],
			createNames: "prefix-unless-prefixed",
			valueOptions: [
				"--save-prefix",
				"--save-catalog-name",
				"--lockfile-dir",
				"--filter",
				"-F",
				"--registry",
				"--allow-build",
				"--cpu",
				"--os",
				"--libc",
				"-C",
				"--dir",
				"--workspace-packages",
				"--env-file"
			]
		}, "https://github.com/pnpm/pnpm.io/tree/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/cli", "From cli/add.md, cli/pnx.md, cli/create.md and pnpm-cli.md at that commit. pnx (pnpm 12) has the aliases pnpm dlx and pnpx; pnpm 10 documents pnpm dlx with the alias pnpx (versioned_docs/version-10.x/cli/dlx.md). --shell-mode (-c) runs the command inside a shell, e.g. pnx --package cowsay -c 'echo hi | cowsay'. pnpm create maps foo and create-foo to create-foo, @scope to @scope/create and @scope/foo to @scope/create-foo, and runs it with pnx. --registry and --allow-build are shown with =, the other value options with a separate value. --package belongs to pnx only and is listed there. -F is the short form of --filter (filtering.md)."),
		packageSpecs: checked$2.verified({
			git: [
				"github:",
				"bitbucket:",
				"gitlab:",
				"gist:",
				"git+ssh://"
			],
			local: ["link:", "file:"],
			workspace: ["workspace:"],
			remoteTarball: ["http://", "https://"],
			tarballExtensions: [
				".tar",
				".tar.gz",
				".tgz"
			],
			shorthand: "github:"
		}, "https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/docs/package-sources.md", "Sources of pnpm add: the npm registry, jsr:, crate: and pypi: (other registries), workspace packages (the workspace: range protocol, docs/workspaces.md), local directories (./dir is saved as link:, file:./dir is copied), local tarballs ending in .tar, .tar.gz or .tgz, remote tarballs starting with http:// or https://, and git repositories as user/repo (github: by default), github:, bitbucket:, gitlab:, gist: or a full URL such as git+ssh://… or https://github.com/….git."),
		registryOverrides: reviewed.verified({
			registryOptions: ["--registry", "--@<scope>:registry"],
			registryVariables: ["pnpm_config_registry"],
			configOptions: ["--userconfig", "--npmrc-auth-file"],
			configVariables: ["pnpm_config_npmrc_auth_file", "pnpm_config_userconfig"]
		}, `${PNPM_V12}/pnpm11/config/reader/src/index.ts`, "registry and @scope:registry are read from the command line over .npmrc (docs/npmrc.md in pnpm/pnpm.io). Every pnpm_config_<key> or PNPM_CONFIG_<KEY> variable whose key is a setting sets it (src/env.ts, parseEnvVars), registry included. The user-level .npmrc, which may set any registry, is the file named by --npmrc-auth-file, --userconfig, pnpm_config_npmrc_auth_file, pnpm_config_userconfig, npmrcAuthFile in the global config.yaml or npm_config_userconfig (getNpmrcAuthFile; src/loadNpmrcFiles.ts reads it in place of ~/.npmrc). pnpm 10 reads npm_config_* variables as npm does."),
		parsing: reviewed.verified({
			abbreviations: true,
			anyDashes: true,
			negation: "--no-",
			settingPrefix: "--config.",
			shorthands: {
				s: ["--reporter=silent"],
				d: ["--loglevel=info"],
				dd: ["--loglevel=verbose"],
				ddd: ["--loglevel=silly"],
				L: ["--latest"],
				r: ["--recursive"],
				silent: ["--reporter=silent"],
				verbose: ["--loglevel=verbose"],
				quiet: ["--loglevel=warn"],
				q: ["--loglevel=warn"],
				h: ["--help"],
				H: ["--help"],
				"?": ["--help"],
				usage: ["--help"],
				v: ["--version"],
				f: ["--force"],
				local: ["--no-global"],
				l: ["--long"],
				p: ["--parseable"],
				porcelain: ["--parseable"],
				prod: ["--production"],
				development: ["--dev"],
				g: ["--global"],
				S: ["--save"],
				D: ["--save-dev"],
				P: ["--save-prod"],
				E: ["--save-exact"],
				O: ["--save-optional"],
				C: ["--dir"],
				w: ["--workspace-root"],
				i: ["--interactive"],
				F: ["--filter"],
				y: ["--yes"]
			}
		}, `${PNPM_V12}/pnpm11/cli/parse-cli-args/src/index.ts`, "pnpm parses its command line with @pnpm/nopt 0.3.1 (github.com/pnpm/nopt, lib/nopt.js), a fork of nopt: every leading dash is stripped, an exact shorthand or a word of one-letter shorthands is expanded, and an unambiguous prefix of an option of the command is taken for that option, so pnpm add --reg=<url> sets registry; --no-<name> is a negated flag. Options pnpm does not know make it stop with an error (pnpm11/pnpm/src/main.ts, dropUnknownOptions). --config.<key>=<value> sets the setting <key> (separateConfigDotArgs, normalizeOptions), also in pnpm 10.34.9 (cli/parse-cli-args/src/index.ts). The shorthands are pnpm11/pnpm/src/shorthands.ts; pnpm 10.34.9 has the same without y."),
		minimumReleaseAgeStrict: checked$2.verified({
			setting: "minimumReleaseAgeStrict",
			value: true,
			since: "11.0.0"
		}, RESOLUTION$1, "When false, pnpm falls back to a version that does not meet minimumReleaseAge; when true, resolution fails. It defaults to true when minimumReleaseAge is set explicitly, except in 11.0.0-11.0.3 and 12.0.0-12.2.x (see strictMode): pnpm 11.0.0 and 12.0.0 installed a version 4 hours old with minimumReleaseAge: 4320 on 2026-10-29, and 12.0.0 added it to minimumReleaseAgeExclude."),
		cooldownExactVersions: checked$2.verified("10.17.0", release$2("10.17.0"), "pnpm 10.17.0: \"Don't ignore the minimumReleaseAge check, when the package is requested by exact version\". pnpm 10.16.0 installed typescript@7.1.0-dev.20261029.1, 4 hours old, with minimumReleaseAge: 4320 on 2026-10-29."),
		lockfileDocuments: checked$2.verified({
			bootMarker: "---",
			graph: "last"
		}, "https://github.com/pnpm/pnpm.io/blob/main/docs/lockfile.md", "A lockfile whose first line is --- has two YAML documents: a boot document with configDependencies and packageManagerDependencies, written when the project has config dependencies, declares devEngines.packageManager or pins pnpm 12 or newer; then the project lockfile (importers, packages, snapshots), which is always the last document. Seen with pnpm 12.16.1 and packageManager pnpm@12.16.1 on 2026-10-29."),
		lockfileFormat: checked$2.verified({
			installScripts: null,
			gitKeyPrefix: "git+",
			gitHostedFlag: "gitHosted",
			gitHostedTarballHosts: [
				"codeload.github.com",
				"bitbucket.org",
				"gitlab.com"
			],
			gitType: "git",
			directoryType: "directory"
		}, "https://github.com/pnpm/pnpm/blob/v10.34.9/lockfile/types/src/index.ts", "lockfileVersion 9.0 (pnpm 9 to 12). Registry packages are keyed name@version; git dependencies name@git+<repo>#<commit> with resolution type git, or a tarball from a git host (gitHosted: true; older lockfiles lack the flag, so the host decides); tarball URLs name@https://…; local tarballs name@file:….tgz; local directories have resolution type directory; link: and workspace: dependencies appear only under importers. requiresBuild was removed in lockfile v9, so install scripts are not recorded. A tarball URL under the configured registry is resolved as that registry package and version (resolving/npm-resolver/src/parseBareSpecifier.ts in v10.34.9), so it is keyed name@version and keeps the URL only in the importer specifier; seen in lockfiles written by pnpm 10.34.9 and 12.16.1."),
		npmrcPrecedence: checked$2.verified({
			winner: "pnpm-workspace.yaml",
			over: [".npmrc", "npm_config_*"]
		}, "https://github.com/pnpm/pnpm/blob/v10.34.9/config/config/src/index.ts", "pnpm 10 applies pnpm-workspace.yaml settings over .npmrc and npm_config_* variables; command-line options win over both (same order on v10.16.0). The 10.18.3 changelog says pnpm config set --location=project writes to pnpm-workspace.yaml \"matching read priority\". The 10.x docs do not state the order."),
		sharedWorkspaceLockfile: checked$2.verified({
			setting: "sharedWorkspaceLockfile",
			npmrcKey: "shared-workspace-lockfile",
			default: true
		}, "https://github.com/pnpm/pnpm.io/blob/7aded9fe30ceb31d4302b4189fcac84c958582b0/versioned_docs/version-10.x/workspaces.md", "Same name and default in pnpm 11 and 12, where it is read only from pnpm-workspace.yaml."),
		perProjectNpmrc: checked$2.uncertain({
			sharedWorkspaceLockfile: false,
			until: "11.0.0"
		}, "https://github.com/pnpm/pnpm/blob/v10.34.9/pkg-manager/plugin-commands-installation/src/recursive.ts", "Without a shared lockfile, pnpm 10 installs every workspace project with its own .npmrc layered over the workspace settings, without filtering keys, so a package .npmrc can change minimum-release-age for that project. Read from code; no documentation or test covers it. No official source says this combination turns minimumReleaseAge off."),
		ignoredSince: verified$5({
			since: "11.0.0",
			npmrc: "auth and registry settings",
			packageJsonField: "pnpm"
		}, release$2("11.0.0"), "Structured form of npmrcIgnored: from 11.0.0 on, other .npmrc settings and the package.json \"pnpm\" field have no effect."),
		lockfileRecheck: uncertain$4([{
			since: "10.16.0",
			value: false
		}, {
			since: "11.1.3",
			value: true
		}], release$2("11.1.3"), "Structured form of lockfileVerification: whether a frozen-lockfile install re-checks the age of versions already in the lockfile. trustLockfile: true (11.3.0) turns the check off."),
		allowAllBuilds: verified$5({
			setting: "dangerouslyAllowAllBuilds",
			since: "10.9.0",
			value: true
		}, "https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md", "Boolean, default false; packages denied in allowBuilds stay blocked."),
		excludeWildcards: verified$5({
			since: "10.17.0",
			trailingOnly: false
		}, SETTINGS_V10, "Globs such as @myorg/* in minimumReleaseAgeExclude since 10.17.0."),
		onlyBuiltDependencies: verified$5({
			since: "10.0.0",
			workspaceFileSince: "10.5.0",
			removedIn: "11.0.0"
		}, BUILD_V11, "The allow-list before allowBuilds: package.json pnpm.onlyBuiltDependencies, also pnpm-workspace.yaml since 10.5.0; removed in 11.0.0 (see legacyAllowList)."),
		latestVersion: verified$5("12.16.1", release$2("12.16.1"), "pnpm 12.0.0 shipped on 26 Aug and 11.0.0 on 28 Apr (GitHub shows no year; 2026 inferred from release order). 11.x and 10.x still receive patches."),
		npmrcIgnored: verified$5("pnpm 11+ reads only auth and registry settings from .npmrc, ignores the package.json \"pnpm\" field and no longer reads npm_config_* variables", release$2("11.0.0")),
		legacyAllowList: verified$5([
			{
				since: "10.0.0",
				value: "onlyBuiltDependencies (package.json pnpm field; pnpm-workspace.yaml since 10.5.0)"
			},
			{
				since: "10.26.0",
				value: "allowBuilds; onlyBuiltDependencies and ignoredBuiltDependencies deprecated"
			},
			{
				since: "11.0.0",
				value: "allowBuilds only; onlyBuiltDependencies, neverBuiltDependencies and ignoredBuiltDependencies removed"
			}
		], BUILD_V11),
		strictDepBuilds: verified$5([{
			since: "10.3.0",
			value: "false"
		}, {
			since: "11.0.0",
			value: "true"
		}], release$2("11.0.0"), "When true, an unreviewed dependency build script fails the install."),
		strictMode: verified$5([
			{
				since: "11.0.0",
				value: "minimumReleaseAgeStrict defaults to false"
			},
			{
				since: "11.0.4",
				value: "strict whenever minimumReleaseAge is set explicitly"
			},
			{
				since: "12.0.0",
				value: "explicit values treated as non-strict (regression)"
			},
			{
				since: "12.3.0",
				value: "strict whenever minimumReleaseAge is set explicitly"
			}
		], release$2("12.3.0"), "In non-strict mode pnpm silently writes immature picks into minimumReleaseAgeExclude. Strict mode fails CI installs with ERR_PNPM_NO_MATURE_MATCHING_VERSION."),
		ignoreMissingTime: verified$5("minimumReleaseAgeIgnoreMissingTime defaults to true: packages whose registry metadata has no publish time skip the age check", RESOLUTION$1),
		lockfileVerification: uncertain$4([{
			since: "10.16.0",
			value: "frozen-lockfile installs do not re-check versions already in the lockfile"
		}, {
			since: "11.1.3",
			value: "lockfile entries are re-checked; trustLockfile: true (11.3.0) turns this off"
		}], release$2("11.1.3"), "The 11.1.3 release notes confirm re-validation (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION). The pnpm 10 behavior rests on maintainer comments in pnpm/pnpm#12450 (a Dependabot lockfile passed --frozen-lockfile on 10.34.5), not on docs."),
		unknownWorkspaceKeys: verified$5("pnpm 11 and earlier silently ignore misspelled pnpm-workspace.yaml settings; pnpm 12 warns", "https://pnpm.io/blog/releases/12.0")
	}
};

// src/knowledge/poetry.ts
const { verified: verified$4, uncertain: uncertain$3, disputed: disputed$2, evidence: evidence$2 } = verifiedOn("2026-10-30");
const POETRY = "https://github.com/python-poetry/poetry/blob/2.5.1";
const CONFIGURATION$1 = `${POETRY}/docs/configuration.md`;
const CHANGELOG = `${POETRY}/CHANGELOG.md`;
const LOCKER = `${POETRY}/src/poetry/packages/locker.py`;
const CHOOSER = `${POETRY}/src/poetry/installation/chooser.py`;
const noSetting$2 = (kind) => ({ setting: uncertain$3(null, `${CONFIGURATION$1}#available-settings`, `No setting allows or forbids ${kind} dependencies (concluded from the list of settings and Config.default_config); dependencies of dependencies may come from such sources too.`) });
const poetry$1 = {
	id: "poetry",
	name: "Poetry",
	kind: "package-manager",
	ecosystem: "pypi",
	cooldown: {
		setting: verified$4("solver.min-release-age", `${CONFIGURATION$1}#solvermin-release-age`, "A version is ignored while any of its files was uploaded less than the given number of days ago. Applies when dependencies are resolved (poetry lock, add, update); poetry install installs the locked versions without checking."),
		configFiles: verified$4(["poetry.toml"], `${CONFIGURATION$1}#local-configuration`, "The local configuration next to pyproject.toml (poetry config --local), not pyproject.toml itself. Environment variables (POETRY_SOLVER_MIN_RELEASE_AGE) win over poetry.toml, which wins over the user config.toml."),
		cliFlag: uncertain$3(null, `${POETRY}/docs/cli.md`, "No command-line option; the environment variable POETRY_SOLVER_MIN_RELEASE_AGE sets it for one command."),
		unit: verified$4("days", `${CONFIGURATION$1}#solvermin-release-age`, "An integer; 0 (the default) turns it off."),
		availableSince: verified$4("2.4.0", `${CONFIGURATION$1}#solvermin-release-age`, "\"Introduced in 2.4.0\"; announced as dependency cooldowns. Tested on 2026-10-30: Poetry 2.3.4 locked with min-release-age = 100000 in poetry.toml without a word, while 2.4.0 and 2.5.1 found no version."),
		default: verified$4([{
			since: "2.4.0",
			value: null
		}], `${CONFIGURATION$1}#solvermin-release-age`, "Default 0: all versions are considered."),
		exclude: {
			setting: verified$4("solver.min-release-age-exclude", `${CONFIGURATION$1}#solvermin-release-age-exclude`),
			availableSince: verified$4("2.4.0", `${CONFIGURATION$1}#solvermin-release-age-exclude`),
			patternSyntax: verified$4("Exact package names; no wildcards", `${CONFIGURATION$1}#solvermin-release-age-exclude`)
		},
		securityUpdates: uncertain$3("applies", `${CONFIGURATION$1}#solvermin-release-age`, "Poetry does not know which versions fix vulnerabilities; the delay holds back every new version of a package not listed in solver.min-release-age-exclude.")
	},
	installScripts: {
		defaultPolicy: verified$4([{
			since: "0.0.0",
			value: "run"
		}], `${CONFIGURATION$1}#installeronly-binary`, "Without installer.only-binary, packages are built from source distributions when no wheel fits, which runs their build backend. Git and directory dependencies are always built. Installing a wheel runs no package code."),
		allowList: {
			setting: verified$4("installer.no-binary", CHOOSER, "With installer.only-binary = [\":all:\"], the packages named in installer.no-binary are the only ones built from source; explicit names take precedence over :all: since 2.2.0. Their wheels are rejected, so they are always built."),
			file: verified$4("poetry.toml", `${CONFIGURATION$1}#installerno-binary`, "The docs recommend configuring it with --local for a project."),
			availableSince: verified$4("2.2.0", CHANGELOG, "\"explicit package names will take precedence over :all:\" (#10278). Before 2.2.0 a package listed in both settings has no file left to install."),
			format: verified$4("A list of package names, or :all: or :none:", `${CONFIGURATION$1}#installerno-binary`, "poetry config stores the value as a list; written by hand, a boolean is not normalized.")
		},
		disableAll: verified$4("installer.only-binary", `${CONFIGURATION$1}#installeronly-binary`, "Since 2.0.0; the value [\":all:\"] forbids source distributions for every package. Applied only when installing: resolving dependencies may still build source distributions without static metadata, and git, path and url dependencies are built regardless.")
	},
	sources: {
		git: noSetting$2("git"),
		remoteTarball: noSetting$2("url"),
		file: noSetting$2("local file"),
		directory: noSetting$2("local directory")
	},
	project: {
		lockfiles: verified$4([{
			since: "0.0.0",
			value: ["poetry.lock"]
		}], `${POETRY}/src/poetry/factory.py`, "Next to pyproject.toml."),
		manifests: verified$4(["pyproject.toml"], `${POETRY}/docs/pyproject.md`),
		workspaces: uncertain$3(null, "https://github.com/python-poetry/poetry/issues/2270", "Poetry has no workspaces: the 2.5.1 docs do not mention them and the request for subprojects is open."),
		workspacesObjectKey: uncertain$3(null, "https://github.com/python-poetry/poetry/issues/2270", "No workspaces.")
	},
	extra: {
		configTable: verified$4({
			solver: "solver",
			installer: "installer"
		}, `${POETRY}/src/poetry/config/file_config_source.py`, "poetry config writes dotted settings as nested tables, e.g. [solver] min-release-age = 7."),
		pyprojectTable: verified$4("tool.poetry", "https://github.com/python-poetry/poetry-core/blob/2.5.0/src/poetry/core/pyproject/toml.py", "A [tool.poetry] table marks a Poetry project; Poetry also accepts a [project] table with a static name and version, which other tools use as well."),
		configLocation: verified$4("poetry.toml is read only from the directory of the pyproject.toml Poetry found (the current directory or the nearest parent with one)", `${POETRY}/src/poetry/factory.py`),
		buildSwitch: verified$4({
			setting: "installer.only-binary",
			value: [":all:"],
			since: "2.0.0",
			covers: ["registry"]
		}, CHANGELOG, "installer.only-binary was added in 2.0.0; [\":all:\"] forbids source distributions of index packages when installing. Git and directory dependencies, and source archives from a URL or path, are built regardless (src/poetry/installation/executor.py at 2.5.1)."),
		excludeFormat: disputed$2("The 2.5.1 docs give the type string, a comma-separated list; the docs on main (pull request #11087, not released) give array and say to use a TOML array in poetry.toml. The 2.5.1 code iterates the value as it is, so a string would be read letter by letter. Tested on 2026-10-30: a TOML array exempted the package in Poetry 2.4.0 and 2.5.1.", evidence$2("comma-separated string", `${CONFIGURATION$1}#solvermin-release-age-exclude`), evidence$2("TOML array", "https://github.com/python-poetry/poetry/pull/11087")),
		excludeWildcards: verified$4({
			since: null,
			trailingOnly: false
		}, `${CONFIGURATION$1}#solvermin-release-age-exclude`, "Package names only."),
		missingUploadTime: verified$4("A release whose source gives no upload times is not filtered by solver.min-release-age", `${CONFIGURATION$1}#solvermin-release-age`),
		lockedVersionsKept: uncertain$3("poetry lock and poetry add keep versions already in poetry.lock even when they are newer than the delay allows; poetry update and poetry lock --regenerate resolve them again", `${POETRY}/src/poetry/mixology/version_solver.py`, "Read from the solver code, which takes the locked package without asking the repository; the docs do not say it."),
		requiredVersion: verified$4({
			table: "tool.poetry",
			key: "requires-poetry",
			since: "2.0.0"
		}, `${POETRY}/docs/pyproject.md#requires-poetry`, "A version constraint in pyproject.toml; a Poetry version outside it raises an error. Poetry 1.x does not know the key."),
		lockfileFormat: uncertain$3({
			sources: {
				git: "git",
				remoteTarball: "url",
				file: "file",
				directory: "directory",
				registry: "legacy"
			},
			packages: "package",
			source: "source",
			files: "files"
		}, LOCKER, "poetry.lock has no documented format. Each [[package]] from PyPI has no [package.source]; others have type git, url, file, directory or legacy (a named index). files lists {file, hash} for every distribution, empty for git and directory packages; a package from an index without a .whl file is built when installed."),
		commandLine: verified$4({
			add: [["poetry", "add"]],
			run: [],
			create: [],
			valueOptions: [
				"-C",
				"--directory",
				"-P",
				"--project",
				"-G",
				"--group",
				"-E",
				"--extras",
				"--optional",
				"--python",
				"--platform",
				"--markers",
				"--source"
			],
			parsing: { groupedShortOptions: true }
		}, `${POETRY}/docs/cli.md#add`, "poetry add takes package specs: a name, name@constraint, a PEP 508 requirement, a git URL, a path or an archive URL. Options with a value: --group (-G), --extras (-E), --optional, --python, --platform, --markers and --source of add, and the global --directory (-C) and --project (-P); -e/--editable, -D/--dev, --allow-prereleases, --dry-run and --lock are flags (src/poetry/console/commands/add.py). cleo reads -Gdocs and -G docs; long options cannot be shortened. poetry install takes no package specs."),
		registryOverrides: verified$4({
			registryOptions: ["--source"],
			registryVariables: [],
			configOptions: [],
			configVariables: []
		}, `${POETRY}/docs/repositories.md`, "--source names a package source of [[tool.poetry.source]] in pyproject.toml (or pypi) to take the package from. The POETRY_REPOSITORIES_<NAME>_URL variables are for publishing only; no variable sets a package source."),
		versionConstraints: verified$4({
			separator: "@",
			latest: "latest",
			caret: "^",
			tilde: "~",
			any: "*"
		}, `${POETRY}/docs/dependency-specification.md#using-the--operator`, "poetry add name@constraint takes any constraint valid in pyproject.toml, and name@latest the newest release; extras go before the @ (name[extra]@^4.0.0). ^ keeps the left-most non-zero part of major.minor.patch: ^1.2.3 is >=1.2.3 <2.0.0, ^1.2 is >=1.2.0 <2.0.0, ^1 is >=1.0.0 <2.0.0, ^0.2.3 is >=0.2.3 <0.3.0, ^0.0.3 is >=0.0.3 <0.0.4, ^0.0 is >=0.0.0 <0.1.0, ^0 is >=0.0.0 <1.0.0. ~ allows patch changes, or minor changes when only a major version is given: ~1.2.3 is >=1.2.3 <1.3.0, ~1.2 is >=1.2.0 <1.3.0, ~1 is >=1.0.0 <2.0.0. * is any version, 1.* is >=1.0.0 <2.0.0, 1.2.* is >=1.2.0 <1.3.0. ~=, inequalities and == as in PEP 440, several separated by commas; a bare version (1.2.3) is that version only. Poetry prefers stable releases and takes a pre-release only when no stable release satisfies the constraint."),
		selection: verified$4({
			prereleases: { onFlags: ["--allow-prereleases"] },
			buildFromSource: {
				onListVariables: ["POETRY_INSTALLER_NO_BINARY"],
				offListVariables: ["POETRY_INSTALLER_ONLY_BINARY"],
				listBooleans: true
			}
		}, CONFIGURATION$1, "installer.no-binary (POETRY_INSTALLER_NO_BINARY) disallows wheels for :all: or true, none for :none: or false, or the named packages separated by commas; installer.only-binary (POETRY_INSTALLER_ONLY_BINARY, since 2.0.0) takes the same values; explicit package names win over :all:. poetry add --allow-prereleases accepts pre-releases (src/poetry/console/commands/add.py)."),
		latestVersion: verified$4("2.5.1", CHANGELOG, "Released on 2026-09-20.")
	}
};

// src/knowledge/renovate.ts
const { verified: verified$3, uncertain: uncertain$2, disputed: disputed$1, evidence: evidence$1 } = verifiedOn("2026-10-28");
const python$1 = verifiedOn("2026-10-30");
const OPTIONS = "https://docs.renovatebot.com/configuration-options/";
const MINIMUM_RELEASE_AGE = "https://docs.renovatebot.com/key-concepts/minimum-release-age/";
const release$1 = (version) => `https://github.com/renovatebot/renovate/releases/tag/${version}`;
const renovate$1 = {
	id: "renovate",
	name: "Renovate",
	kind: "update-bot",
	cooldown: {
		setting: verified$3("minimumReleaseAge", `${OPTIONS}#minimumreleaseage`, "Formerly stabilityDays; old configs are migrated to \"N days\". Can be scoped with packageRules, vulnerabilityAlerts and update types."),
		configFiles: verified$3([
			"renovate.json",
			"renovate.jsonc",
			"renovate.json5",
			".github/renovate.json",
			".github/renovate.jsonc",
			".github/renovate.json5",
			".gitlab/renovate.json",
			".gitlab/renovate.jsonc",
			".gitlab/renovate.json5",
			".renovaterc",
			".renovaterc.json",
			".renovaterc.jsonc",
			".renovaterc.json5"
		], OPTIONS, "Searched in this order. The \"renovate\" key in package.json still works but is deprecated. Shared presets (extends) can also set it."),
		cliFlag: verified$3("--minimum-release-age", `${OPTIONS}#minimumreleaseage`, "Self-hosted CLI only; environment variable RENOVATE_MINIMUM_RELEASE_AGE."),
		unit: verified$3("duration-string", MINIMUM_RELEASE_AGE, "For example \"3 days\" or \"14 days\". Since 42.19.5 \"0 days\" is treated like null."),
		availableSince: verified$3("35.46.0", release$1("35.46.0"), "Earlier versions had the same feature as stabilityDays (first version not tracked)."),
		default: verified$3([{
			since: "0.0.0",
			value: null
		}], "https://github.com/renovatebot/renovate/blob/main/lib/config/options/index.ts", "Off unless configured; the docs table shows no default. config:best-practices adds \"3 days\" for npm (see presets). Since 44.96.0 minimumReleaseAgeBuffer adds 30 minutes once a delay is set."),
		exclude: {
			setting: verified$3("packageRules: matchPackageNames + minimumReleaseAge: null", `${MINIMUM_RELEASE_AGE}#how-do-i-opt-out-dependencies-from-minimum-release-age-checks`, "No dedicated exclusion list."),
			availableSince: uncertain$2("35.46.0", release$1("35.46.0"), "Assumed to work since the option exists with packageRule scope; not stated by a release note."),
			patternSyntax: verified$3("matchPackageNames: exact names, globs such as @org/** (with ! negation) or /regex/; case-insensitive", `${OPTIONS}#matchpackagenames`, "Glob and regex patterns since 38.0.0.")
		},
		securityUpdates: verified$3("bypass", `${MINIMUM_RELEASE_AGE}#what-happens-to-security-updates`, "The vulnerabilityAlerts defaults set minimumReleaseAge to null; a delay can still be set inside vulnerabilityAlerts.")
	},
	installScripts: {
		defaultPolicy: verified$3([{
			since: "0.0.0",
			value: "deny"
		}], `${OPTIONS}#ignorescripts`, "Renovate disables package manager scripts when it updates lockfiles; the Mend-hosted app never runs them."),
		allowList: { setting: uncertain$2(null, `${OPTIONS}#ignorescripts`, "No per-package allow-list was found: scripts are all or nothing, via allowScripts: true (self-hosted global config) plus ignoreScripts: false.") },
		disableAll: verified$3("ignoreScripts: true", `${OPTIONS}#ignorescripts`, "The default; the self-hosted global allowScripts also defaults to false.")
	},
	extra: {
		durationStrings: verified$3({
			since: null,
			syntax: "words"
		}, "https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md", "Values such as \"3 days\" or \"1 hour\", parsed by toMs (lib/util/pretty-time.ts)."),
		minimumReleaseAgePresets: verified$3({
			presets: ["config:best-practices", "security:minimumReleaseAgeNpm"],
			value: "3 days",
			since: "42.0.0",
			datasource: "npm"
		}, "https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm", "config:best-practices extends security:minimumReleaseAgeNpm, which sets minimumReleaseAge \"3 days\" for the npm datasource (see presets)."),
		excludeRule: verified$3({
			list: "packageRules",
			match: "matchPackageNames",
			value: null
		}, "https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md", "The documented opt-out: a packageRules entry with matchPackageNames and minimumReleaseAge: null."),
		securityUpdatesSetting: verified$3(["vulnerabilityAlerts", "minimumReleaseAge"], "https://github.com/renovatebot/renovate/blob/main/lib/config/options/index.ts", "The vulnerabilityAlerts default sets minimumReleaseAge to null, so security updates skip the delay unless a value is set there."),
		excludeWildcards: verified$3({
			since: "38.0.0",
			trailingOnly: false
		}, `${OPTIONS}#matchpackagenames`, "matchPackageNames accepts globs (and regex) since 38.0.0."),
		ruleDescription: verified$3("description", "https://github.com/renovatebot/renovate/blob/main/docs/usage/configuration-options.md#description", "A human-readable description allowed inside any configuration object; depcurfew uses it to recognize the packageRules entry it manages."),
		packageJsonConfig: verified$3({
			file: "package.json",
			key: "renovate"
		}, "https://github.com/renovatebot/renovate/blob/main/lib/workers/repository/init/merge.ts", "Deprecated: the configuration options page warns that support may be removed, and Renovate logs that using package.json is deprecated."),
		durationUnits: verified$3(["hours", "days"], "https://github.com/renovatebot/renovate/blob/main/docs/usage/key-concepts/minimum-release-age.md", "Units shown in the docs: minimumReleaseAge=1 hour on this page and \"3 days\" in the configuration options. The value is parsed by toMs (lib/util/pretty-time.ts), whose tests also accept 1 day, 1 week and combined values."),
		presets: verified$3("config:best-practices extends security:minimumReleaseAgeNpm (since 42.0.0): \"3 days\" and internalChecksFilter \"strict\" for the npm datasource, except pin, replacement, lockFileMaintenance, bump, lockfileUpdate and rollback", "https://docs.renovatebot.com/presets-security/#securityminimumreleaseagenpm"),
		datasources: python$1.verified({
			npm: "npm",
			pypi: "pypi"
		}, "https://docs.renovatebot.com/modules/datasource/pypi/", "Datasource ids for matchDatasources: npm packages come from the npm datasource and Python packages from pypi, whose release timestamp is the earliest upload_time of the version's files."),
		negativeMatch: python$1.verified("!", "https://docs.renovatebot.com/string-pattern-matching/", "Patterns starting with ! are negative matches, and none of them may match; matchDatasources is matched this way (matchRegexOrGlobList in lib/util/package-rules/datasources.ts at 44.198.0), so [\"!pypi\"] covers every datasource but PyPI."),
		pypiPresets: python$1.verified({
			presets: ["security:minimumReleaseAgePypi"],
			value: "3 days",
			since: "44.8.0",
			datasource: "pypi"
		}, "https://docs.renovatebot.com/presets-security/#securityminimumreleaseagepypi", "Added in 44.8.0; config:best-practices does not include it (it includes only security:minimumReleaseAgeNpm)."),
		pythonManagers: python$1.verified({
			uv: "pep621",
			poetry: "poetry",
			pip: "pip_requirements",
			pdm: "pep621",
			pipenv: "pipenv"
		}, "https://docs.renovatebot.com/modules/manager/pep621/", "pep621 updates pyproject.toml with uv.lock (there is no uv manager) or pdm.lock; poetry updates pyproject.toml with poetry.lock; pipenv updates the Pipfile with Pipfile.lock; pip_requirements updates requirements files. pip-compile is off by default (lib/modules/manager/pep621/readme.md and pipenv/index.ts at 44.198.1)."),
		passesDelayToManager: python$1.verified([{
			since: "0.0.0",
			value: []
		}, {
			since: "44.34.0",
			value: ["poetry"]
		}], MINIMUM_RELEASE_AGE, "Since 44.34.0 Renovate passes POETRY_SOLVER_MIN_RELEASE_AGE (rounded up to whole days) to Poetry 2.4.0 and later. It does not pass the delay to uv or read exclude-newer."),
		missingTimestamp: verified$3([{
			since: "0.0.0",
			value: "updates without a release timestamp pass the check"
		}, {
			since: "42.0.0",
			value: "minimumReleaseAgeBehaviour timestamp-required: such updates are held"
		}], release$1("42.0.0"), "minimumReleaseAgeBehaviour was added in 41.150.0; timestamp-optional still fails open."),
		internalChecksFilter: verified$3("Defaults to \"strict\" since 33.0.0; with \"none\" or \"flexible\" branches and PRs are created before the delay ends and only automerge waits", release$1("33.0.0")),
		independentOfPackageManager: verified$3("minimumReleaseAge is set independently of the package manager's own release-age configuration", MINIMUM_RELEASE_AGE, "Source code passes --before to npm only; pnpm, Yarn and Bun gates are not read."),
		digestBypassFixed: disputed$1("Digest updates could bypass minimumReleaseAge; the advisory and a maintainer comment give different fixed versions. Rebase requests could bypass strict checks before 44.61.3 (GHSA-2frq-pm48-6j4h).", evidence$1("44.3.1", "https://github.com/renovatebot/renovate/security/advisories/GHSA-g4qr-hw2h-687r"), evidence$1("44.10.0", "https://github.com/renovatebot/renovate/discussions/42260"))
	}
};

// src/knowledge/uv.ts
const { verified: verified$2, uncertain: uncertain$1 } = verifiedOn("2026-10-30");
const UV = "https://github.com/astral-sh/uv/blob/0.13.6";
const RESOLUTION = `${UV}/docs/concepts/resolution.md`;
const CONFIGURATION = `${UV}/docs/concepts/configuration-files.md`;
const SETTINGS = `${UV}/crates/uv-settings/src/settings.rs`;
const BUILD_OPTIONS = `${UV}/crates/uv-configuration/src/build_options.rs`;
const WORKSPACES = `${UV}/docs/concepts/projects/workspaces.md`;
const SERIALIZE = `${UV}/crates/uv-lock/src/lock/serialize.rs`;
const CLI = `${UV}/crates/uv-cli/src/lib.rs`;
const changelog = (minor, version) => `${UV}/changelogs/${minor}.x.md#${version.replaceAll(".", "")}`;
const noSetting$1 = (kind) => ({ setting: uncertain$1(null, `${UV}/uv.schema.json`, `No setting allows or forbids ${kind} dependencies (concluded from the list of settings). no-sources only ignores the tool.uv.sources table; a URL dependency introduced by a registry package is rejected during resolution (docs/pip/compatibility.md).`) });
const uv$1 = {
	id: "uv",
	name: "uv",
	kind: "package-manager",
	ecosystem: "pypi",
	cooldown: {
		setting: verified$2("exclude-newer", SETTINGS, "Limits candidate packages to those uploaded before a date or, since 0.9.17, a duration ago. Compared with the upload time of each file, not the release date. false turns off a value from a lower-priority source (since 0.11.24)."),
		configFiles: verified$2(["uv.toml", "pyproject.toml"], CONFIGURATION, "Top level of uv.toml or the [tool.uv] table of pyproject.toml. uv searches the current directory and its parents and uses the first directory with uv.toml or a pyproject.toml that has [tool.uv]; uv.toml wins over [tool.uv] in the same directory, with a warning. In a workspace only the root is read. User (~/.config/uv/uv.toml) and system (/etc/uv/uv.toml) files are merged below the project file; uv tool and uvx read only those. UV_EXCLUDE_NEWER overrides the files."),
		cliFlag: verified$2("--exclude-newer", `${UV}/crates/uv-cli/src/lib.rs`, "Also the UV_EXCLUDE_NEWER environment variable."),
		unit: verified$2("duration-string", RESOLUTION, "A \"friendly\" duration such as 24 hours, 1 week or 30 days, or an ISO 8601 duration such as P7D; months and years are rejected, a day is always 24 hours. An RFC 3339 timestamp is a fixed cutoff instead of a rolling delay."),
		availableSince: verified$2("0.9.17", changelog("0.9", "0.9.17"), "Durations (\"dependency cooldowns\") since 0.9.17; before that exclude-newer took only dates, which do not move with time. Tested on 2026-10-30: uv 0.9.16 printed a warning that \"100000 days\" is not a date and resolved with no delay at all; 0.9.17 and later held back every version."),
		default: verified$2([{
			since: "0.9.17",
			value: null
		}], SETTINGS, "No default: without a value every upload time is accepted."),
		exclude: {
			setting: verified$2("exclude-newer-package", `${RESOLUTION}`, "A table mapping package names to false (exempt), a date or a duration; package values take precedence over the global and index values."),
			availableSince: verified$2("0.9.25", changelog("0.9", "0.9.25"), "The table exists since 0.8.4 (dates); false, which exempts a package, since 0.9.25. Tested on 2026-10-30: with a false entry, uv 0.9.17 warned \"data did not match any variant of untagged enum\" and ignored the whole [tool.uv] table, the delay included; 0.9.25 and 0.13.6 exempted the package."),
			patternSyntax: verified$2("Exact package names as table keys; no wildcards", SETTINGS, "Keys are package names, compared after name normalization.")
		},
		securityUpdates: uncertain$1("applies", RESOLUTION, "uv does not know which versions fix vulnerabilities; the delay holds back every new upload unless the package is listed in exclude-newer-package.")
	},
	installScripts: {
		defaultPolicy: verified$2([{
			since: "0.0.0",
			value: "run"
		}], SETTINGS, "no-build defaults to false: source distributions, git and directory dependencies are built, which runs their build backend. Installing a wheel runs no package code."),
		allowList: {
			setting: verified$2("no-binary-package", BUILD_OPTIONS, "With no-build = true, the packages in no-binary-package are the only ones built from source (\"Allow `all` to be overridden by specific binary exclusions\"). Their wheels are not used, so they are always built."),
			file: verified$2("pyproject.toml", CONFIGURATION, "Or uv.toml; the same table as exclude-newer."),
			availableSince: verified$2("0.2.12", changelog("0.2", "0.2.12"), "Project settings no-build, no-build-package, no-binary and no-binary-package; uv sync and related commands respect them since 0.4.6."),
			format: verified$2("A list of package names", SETTINGS)
		},
		disableAll: verified$2("no-build", SETTINGS, "Operations that need to build a source distribution fail. Workspace members, editable requirements and wheels built earlier and kept in the cache are still used. With uv 0.13.6 on 2026-10-30, uv sync refused a git dependency and a non-editable local directory dependency as well (\"marked as --no-build but has no binary distribution\"), so those need an exception too. An explicit no-build = false in a higher-priority file makes uv ignore no-build-package.")
	},
	sources: {
		git: noSetting$1("git"),
		remoteTarball: noSetting$1("URL"),
		file: noSetting$1("local archive"),
		directory: noSetting$1("local directory")
	},
	project: {
		lockfiles: verified$2([{
			since: "0.0.0",
			value: ["uv.lock"]
		}], `${UV}/docs/concepts/projects/layout.md`, "Created next to pyproject.toml."),
		manifests: verified$2(["pyproject.toml"], `${UV}/docs/concepts/projects/layout.md`),
		workspaces: verified$2({
			files: ["pyproject.toml"],
			key: "tool.uv.workspace",
			excludeKey: "exclude"
		}, WORKSPACES, "The [tool.uv.workspace] table of the root pyproject.toml lists members and exclude (globs or paths); exclude wins over members, and the root is a member too."),
		workspacesObjectKey: verified$2("members", WORKSPACES, "The workspace guide calls members required, while the settings reference (crates/uv-workspace/src/pyproject.rs) gives it a default of [].")
	},
	extra: {
		configTables: verified$2({
			"pyproject.toml": "tool.uv",
			"uv.toml": ""
		}, CONFIGURATION, "Settings sit in [tool.uv] in pyproject.toml and at the top level of uv.toml. uv.toml cannot hold workspace, sources and a few other project fields."),
		pyprojectTable: verified$2("tool.uv", CONFIGURATION, "A pyproject.toml without a [tool.uv] table is ignored when uv searches for configuration."),
		configPrecedence: verified$2("uv.toml wins over [tool.uv] in the same directory; only the nearest directory with either is read, and in a workspace only the root", CONFIGURATION, "A nested pyproject.toml with any [tool.uv] table hides the configuration of its parent directories."),
		configFileOrder: verified$2(["uv.toml", "pyproject.toml"], CONFIGURATION, "\"configuration will be read from uv.toml, and the [tool.uv] section in the accompanying pyproject.toml will be ignored\"; uv prints a warning listing the ignored fields."),
		workspaceRootOnly: verified$2(true, CONFIGURATION, "\"In workspaces, uv will begin its search at the workspace root, ignoring any configuration defined in workspace members.\" Project fields such as tool.uv.sources of a member still apply."),
		buildSwitch: verified$2({
			setting: "no-build",
			value: true,
			since: "0.2.12",
			covers: [
				"registry",
				"git",
				"remoteTarball",
				"file",
				"directory"
			]
		}, changelog("0.2", "0.2.12"), "The project setting that forbids building source distributions. It also stops git and local directory dependencies (uv sync with uv 0.13.6 on 2026-10-30) and source archives, which also need a build; workspace members and editable requirements are still built."),
		durationStrings: verified$2({
			since: "0.9.17",
			syntax: "words-or-iso8601"
		}, RESOLUTION, "Either a \"friendly\" duration (24 hours, 1 week, 30 days) or an ISO 8601 duration (PT24H, P7D, P30D)."),
		durationUnits: verified$2([
			"hours",
			"days",
			"weeks"
		], RESOLUTION, "Units in the documented examples: 24 hours, 1 week, 30 days."),
		excludeWildcards: verified$2({
			since: null,
			trailingOnly: false
		}, SETTINGS, "exclude-newer-package keys are exact package names."),
		excludeValue: verified$2(false, changelog("0.9", "0.9.25"), "exclude-newer-package = { name = false } exempts the package from the delay."),
		missingUploadTime: verified$2("A file from an index that gives no upload time is treated as unavailable while a delay is set", RESOLUTION, "Unless the package is exempt, or the index has its own exclude-newer value or is exempt with [[tool.uv.index]] exclude-newer = false."),
		registryOnly: verified$2("The delay applies only to packages read from a registry, not to git, URL or path dependencies", RESOLUTION),
		requiredVersion: verified$2({
			table: "tool.uv",
			key: "required-version",
			since: "0.5.14"
		}, SETTINGS, "A PEP 440 specifier; uv exits with an error when its version does not match. Also at the top level of uv.toml."),
		lockfileFormat: uncertain$1({
			sources: {
				registry: "registry",
				git: "git",
				remoteTarball: "url",
				file: "path",
				directory: "directory",
				editable: "editable",
				virtual: "virtual"
			},
			sdist: "sdist",
			wheels: "wheels",
			packages: "package"
		}, SERIALIZE, "uv.lock has no documented format (the docs say only that it is managed by uv). Each [[package]] has source = { registry = URL } for an index, { git = URL?rev#commit }, { url = URL }, { path = archive }, { directory = dir }, { editable = dir } or { virtual = dir } (a directory that is not built). Index packages list sdist and wheels; a package without wheels, or from git, a directory or a source archive, is built when installed."),
		ignoredByToolCommands: verified$2("uv tool install, uv tool run and uvx ignore pyproject.toml and uv.toml in the project and read only user and system configuration", CONFIGURATION),
		lockedSettings: verified$2(["exclude-newer", "exclude-newer-package"], SERIALIZE, "uv.lock records these in [options] (a relative exclude-newer as exclude-newer-span); after a change uv lock --check and uv sync --locked fail until uv lock runs again (\"Resolving despite existing lockfile due to addition of global exclude newer\", seen with uv 0.13.6 on 2026-10-30). no-build and no-binary-package are not recorded."),
		commandLine: verified$2({
			add: [
				["uv", "add"],
				[
					"uv",
					"pip",
					"install"
				],
				[
					"uv",
					"tool",
					"install"
				]
			],
			run: [
				{
					command: ["uvx"],
					packageOptions: ["--from"],
					extraPackageOptions: [
						"-w",
						"--with",
						"--with-editable"
					]
				},
				{
					command: [
						"uv",
						"tool",
						"run"
					],
					packageOptions: ["--from"],
					extraPackageOptions: [
						"-w",
						"--with",
						"--with-editable"
					]
				},
				{
					command: ["uv", "run"],
					packageOptions: [],
					extraPackageOptions: [
						"-w",
						"--with",
						"--with-editable"
					],
					packageArgument: false,
					scriptUrls: true
				}
			],
			create: [],
			valueOptions: [
				"--cache-dir",
				"--config-file",
				"--color",
				"--allow-insecure-host",
				"--trusted-host",
				"--directory",
				"--project",
				"--python-preference",
				"--python-fetch",
				"--preview-features",
				"--preview-feature",
				"--index",
				"--default-index",
				"-i",
				"--index-url",
				"--extra-index-url",
				"-f",
				"--find-links",
				"-P",
				"--upgrade-package",
				"--upgrade-group",
				"--reinstall-package",
				"--index-strategy",
				"--keyring-provider",
				"--resolution",
				"--prerelease",
				"--prerelease-package",
				"--fork-strategy",
				"-C",
				"--config-setting",
				"--config-settings",
				"--config-settings-package",
				"--no-build-isolation-package",
				"--exclude-newer",
				"--exclude-newer-package",
				"--link-mode",
				"--no-sources-package",
				"--refresh-package",
				"--no-build-package",
				"--no-binary-package",
				"-c",
				"--constraints",
				"--constraint",
				"--overrides",
				"--override",
				"--excludes",
				"--exclude",
				"-b",
				"--build-constraints",
				"--build-constraint",
				"-r",
				"--requirements",
				"--requirement",
				"--group",
				"--extra",
				"--no-editable-package",
				"-p",
				"--python",
				"-t",
				"--target",
				"--prefix",
				"--python-version",
				"--python-platform",
				"--output-format",
				"--torch-backend",
				"--optional",
				"--bounds",
				"--rev",
				"--tag",
				"--branch",
				"--package",
				"--script",
				"--no-install-package",
				"--only-install-package",
				"-w",
				"--with",
				"--with-editable",
				"--with-requirements",
				"--no-extra",
				"--no-group",
				"--only-group",
				"--env-file",
				"--max-recursion-depth",
				"--from",
				"--with-executables-from"
			],
			parsing: { groupedShortOptions: true },
			addPackageOptions: [
				"-w",
				"--with",
				"--with-editable",
				"--with-executables-from"
			],
			editableOptions: ["--with-editable"],
			commaSeparatedOptions: [
				"-w",
				"--with",
				"--with-editable",
				"--with-executables-from"
			],
			interpreterNames: [
				"python",
				"pythonw",
				"cpython",
				"pypy",
				"graalpy",
				"pyodide"
			],
			commandOptions: [{
				command: [
					"uv",
					"pip",
					"install"
				],
				valueOptions: [
					"-e",
					"--editable",
					"--no-binary",
					"--only-binary"
				],
				editableOptions: ["-e", "--editable"]
			}, {
				command: ["uv", "add"],
				valueOptions: ["-m", "--marker"]
			}]
		}, CLI, "clap arguments of uv add, uv pip install, uv tool install, uv run and uv tool run (uvx), with the global options, IndexArgs, ResolverInstallerArgs, BuildOptionsArgs and DependencyConstraintsArgs they share. --opt value, --opt=value, -o value and -ovalue all work; long options cannot be shortened. Options of uv run, uv tool run and uvx come before the command. --with, --with-editable and --with-executables-from add packages, as a list split at commas outside [...] that are not followed by !, =, <, > or ~ (comma.rs). uvx and uv tool run take the package from the first argument (name@version is ==version, name@latest the newest) unless --from names it; a first argument such as python, python3.12, pypy@3.8 or graalpy runs an interpreter (PythonRequest::try_from_tool_name in uv-python-types, implementation names cpython, pypy, graalpy and pyodide). uv run runs a command and downloads only what --with names, or a script given as an http or https URL. -e takes a path in uv pip install but is a flag in uv tool install, and --editable a flag in uv add; --no-binary and --only-binary take values in uv pip install only, -m is --marker in uv add and --module in uv run."),
		registryOverrides: verified$2({
			registryOptions: [
				"--index",
				"--default-index",
				"-i",
				"--index-url",
				"--extra-index-url",
				"-f",
				"--find-links"
			],
			registryVariables: [
				"UV_INDEX",
				"UV_DEFAULT_INDEX",
				"UV_INDEX_URL",
				"UV_EXTRA_INDEX_URL",
				"UV_FIND_LINKS"
			],
			configOptions: ["--config-file"],
			configVariables: ["UV_CONFIG_FILE"]
		}, `${UV}/crates/uv-static/src/env_vars.rs`, "IndexArgs (lib.rs): --index adds an index (name=url allowed), --default-index replaces PyPI, --index-url and --extra-index-url are their deprecated forms, --find-links adds a page or directory of archives; each has the variable named here. --config-file and UV_CONFIG_FILE name a uv.toml that may set any index. uv does not read pip.conf or PIP_INDEX_URL (docs/pip/compatibility.md)."),
		selection: verified$2({
			prereleases: {
				onFlags: ["--pre"],
				modeOptions: ["--prerelease"],
				packageModeOptions: ["--prerelease-package"],
				onModes: ["allow"],
				offModes: ["disallow"],
				modeVariables: ["UV_PRERELEASE"]
			},
			buildFromSource: {
				onFlags: ["--no-binary"],
				offFlags: ["--binary"],
				onPackages: ["--no-binary-package"],
				flagVariables: ["UV_NO_BINARY"],
				onPackageVariables: ["UV_NO_BINARY_PACKAGE"]
			},
			commands: [{
				command: [
					"uv",
					"pip",
					"install"
				],
				buildFromSource: {
					onLists: ["--no-binary"],
					offLists: ["--only-binary"]
				}
			}]
		}, CLI, "VersionSelectionArgs: --prerelease takes disallow, allow, if-necessary, explicit or if-necessary-or-explicit (UV_PRERELEASE); allow considers pre-releases of every package and disallow none (docs/concepts/resolution.md); --prerelease-package takes PACKAGE=MODE; the hidden --pre means allow. BuildOptionsArgs of uv add, uv run, uv tool install and uv tool run (uvx): --no-binary (UV_NO_BINARY, a boolean) installs every package from source, --binary turns it off, --no-binary-package names one package (UV_NO_BINARY_PACKAGE, separated by spaces). uv pip install takes --no-binary and --only-binary as lists separated by commas with :all: and :none:, as pip does (PipInstallArgs)."),
		latestVersion: verified$2("0.13.6", `${UV}/CHANGELOG.md`, "Released on 2026-10-26.")
	}
};

// src/knowledge/yarn.ts
const { verified: verified$1, uncertain, disputed, evidence } = verifiedOn("2026-10-28");
const checked$1 = verifiedOn("2026-10-29");
const YARNRC = "https://yarnpkg.com/configuration/yarnrc";
const MANIFEST = "https://yarnpkg.com/configuration/manifest";
const SCHEMA = "https://github.com/yarnpkg/berry/blob/master/packages/docusaurus/static/configuration/yarnrc.json";
const release = (version) => `https://github.com/yarnpkg/berry/releases/tag/%40yarnpkg%2Fcli%2F${version}`;
const noSetting = (source, note) => ({ setting: uncertain(null, source, note) });
const yarn$1 = {
	id: "yarn",
	name: "Yarn (Berry)",
	kind: "package-manager",
	cooldown: {
		setting: verified$1("npmMinimalAgeGate", `${YARNRC}#npmMinimalAgeGate`),
		configFiles: verified$1([".yarnrc.yml"], YARNRC, "Also YARN_NPM_MINIMAL_AGE_GATE (general YARN_ env rule) and, since 4.17.0, npmScopes.<scope>.npmMinimalAgeGate. package.json cannot set it."),
		cliFlag: uncertain(null, "https://yarnpkg.com/cli/install", "No flag sets the gate. --no-time-gate on yarn add and yarn up (4.15.0+) disables it for one command; yarn install has no such flag."),
		unit: verified$1("minutes", "https://github.com/yarnpkg/berry/pull/6942", "Bare numbers are minutes. Since 4.11.0 duration strings with ms, s, m, h, d or w (e.g. 3d, 1w) also work; on 4.10.x a string such as 7d silently had no effect."),
		availableSince: checked$1.verified("4.10.2", release("4.10.2"), "The setting arrived in 4.10.0 (release notes, pull request and source; the security docs page at https://yarnpkg.com/features/security says 4.12). 4.10.2 fixed it: \"Bust the metadata cache\" (#6908) and \"support registries without publish times using minimalAgeGate\" (#6907). On 2026-10-29 Yarn 4.10.1 with npmMinimalAgeGate: 4320 refused zod@3.23.8 and esbuild@0.25.0, both over a year old (\"No candidates found\"), while 4.10.2, 4.10.3, 4.11.0 and 4.12.0 installed them and refused a version 4 hours old. depcurfew writes the setting from 4.10.2 on."),
		default: disputed("The code is unambiguous: off until 4.14.x, 1d from 4.15.0. The published settings schema claimed 3d for 4.11.0-4.14.x and 0m in 4.16.0; the live yarnrc page shows \"1w\", which is an example value. Upgraded projects with an old lockfile get npmMinimalAgeGate: 0 written to .yarnrc.yml (see upgradeMigration).", evidence([{
			since: "4.10.0",
			value: 0
		}, {
			since: "4.15.0",
			value: "1d"
		}], release("4.15.0")), evidence([
			{
				since: "4.10.0",
				value: 0
			},
			{
				since: "4.11.0",
				value: "3d"
			},
			{
				since: "4.15.0",
				value: "1d"
			}
		], "https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.11.0/packages/docusaurus/static/configuration/yarnrc.json")),
		exclude: {
			setting: verified$1("npmPreapprovedPackages", `${YARNRC}#npmPreapprovedPackages`),
			availableSince: verified$1("4.10.0", release("4.10.0")),
			patternSyntax: verified$1("Package descriptors or name globs, optionally with a semver range: @scope/*, package, package*, package@^1.0.0; global only, not per npmScopes", `${YARNRC}#npmPreapprovedPackages`)
		},
		securityUpdates: uncertain("applies", "https://yarnpkg.com/cli/npm/audit", "No automatic bypass is documented and yarn npm audit only reports. Options: --no-time-gate on yarn add/up, a pinned npmPreapprovedPackages entry, or a per-scope gate of 0.")
	},
	installScripts: {
		defaultPolicy: verified$1([{
			since: "2.0.0",
			value: "run"
		}, {
			since: "4.14.0",
			value: "deny-except-allowlist"
		}], release("4.14.0"), "Workspace scripts still run. Upgraded projects with an old lockfile get enableScripts: true written to .yarnrc.yml. Yarn 1 runs scripts unless --ignore-scripts is passed."),
		allowList: {
			setting: verified$1("dependenciesMeta.<package>.built", `${MANIFEST}#dependenciesMeta.built`),
			file: verified$1("package.json", `${MANIFEST}#dependenciesMeta`, "Root package.json only; ignored inside workspaces."),
			availableSince: uncertain("2.0.0", "https://github.com/yarnpkg/berry/blob/master/CHANGELOG.md", "dependenciesMeta is documented in the changelog from the 2.x line; the exact first version was not pinned down."),
			format: verified$1("Object keyed by package name or name@version: { built: true } allows a package when enableScripts is false; { built: false } denies it when enableScripts is true", `${MANIFEST}#dependenciesMeta.built`)
		},
		disableAll: verified$1("enableScripts: false", `${YARNRC}#enableScripts`, "Set in .yarnrc.yml; the default since 4.14.0. yarn install --mode=skip-build skips builds for one run. Berry ignores YARN_IGNORE_SCRIPTS.")
	},
	sources: {
		git: {
			setting: verified$1("approvedGitRepositories", `${YARNRC}#approvedGitRepositories`),
			values: verified$1(["repository URL glob patterns, e.g. https://github.com/org/*"], `${YARNRC}#approvedGitRepositories`),
			availableSince: verified$1("4.14.0", release("4.14.0")),
			default: verified$1([{
				since: "4.14.0",
				value: "[] (every git dependency is blocked)"
			}], SCHEMA, "Upgraded projects with an old lockfile get [\"**\"] written to .yarnrc.yml.")
		},
		remoteTarball: noSetting(YARNRC, "No setting restricts http(s) tarball dependencies (concluded from the full settings list); the closest are enableNetwork, networkSettings.<host>.enableNetwork and unsafeHttpWhitelist for plain http."),
		file: noSetting("https://yarnpkg.com/protocol/file", "No setting restricts file:, link: or portal: dependencies (concluded from the settings list and plugin sources); only exec: is gated by enableScripts (4.14.0+)."),
		directory: noSetting("https://yarnpkg.com/protocol/file", "No setting restricts local directory dependencies (file:, link:, portal:), as for local tarballs.")
	},
	project: {
		lockfiles: verified$1([{
			since: "0.0.0",
			value: ["yarn.lock"]
		}], "https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-fslib/sources/path.ts", "Yarn Classic uses the same name; see berryLockfileMarker and classicLockfileHeader to tell them apart."),
		manifests: verified$1(["package.json"], MANIFEST),
		workspaces: verified$1({
			files: ["package.json"],
			key: "workspaces"
		}, `${MANIFEST}#workspaces`, "Array of folder glob patterns."),
		workspacesObjectKey: uncertain("packages", "https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Manifest.ts", "Not documented; the manifest parser also accepts { \"packages\": [...] }.")
	},
	extra: {
		commandLine: checked$1.verified({
			add: [["yarn", "add"]],
			run: [{
				command: ["yarn", "dlx"],
				packageOptions: ["-p", "--package"]
			}],
			create: [{
				command: ["yarn", "create"],
				packageOptions: ["-p", "--package"]
			}],
			createNames: "prefix-unless-prefixed",
			workspaceCommands: [{
				command: ["yarn", "workspace"],
				operands: 1
			}],
			valueOptions: ["--mode"]
		}, "https://github.com/yarnpkg/berry/tree/master/packages/plugin-dlx/sources/commands", "dlx.ts (documented at https://yarnpkg.com/cli/dlx) downloads the package named by the command, or the ones given with -p/--package, into a temporary environment and runs it. create.ts (yarn create, not on yarnpkg.com) takes -p/--package as well and runs create-<name>: @foo becomes @foo/create, @foo/app becomes @foo/create-app, foo becomes create-foo, and a name that already matches ^create(-|$) is kept (so is create alone). yarn add (https://yarnpkg.com/cli/add) takes packages as arguments; of its options only --mode takes a value. yarn workspace <workspaceName> <commandName> … runs a command within that workspace, e.g. yarn workspace components add -D react (https://yarnpkg.com/cli/workspace)."),
		packageSpecs: checked$1.verified({
			git: [],
			local: [
				"link:",
				"portal:",
				"file:"
			],
			workspace: ["workspace:"]
		}, "https://yarnpkg.com/protocols", "Protocols besides npm: and git: exec:, file:, jsr:, link:, patch:, portal: and workspace:. link: connects an external directory (https://yarnpkg.com/protocol/link), portal: a relative path to a package folder (https://yarnpkg.com/protocol/portal) and file: copies a folder or tarball."),
		registryOverrides: checked$1.verified({
			registryOptions: [],
			registryVariables: ["YARN_NPM_REGISTRY_SERVER"],
			configOptions: [],
			configVariables: ["YARN_RC_FILENAME"]
		}, "https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Configuration.ts", "Environment variables that start with yarn_ (any case) set the setting named by the camel-cased rest, so YARN_NPM_REGISTRY_SERVER sets npmRegistryServer, the registry packages are fetched from (https://yarnpkg.com/configuration/yarnrc#npmRegistryServer). getRcFilename reads yarn_rc_filename (any case) as the name of the configuration file instead of .yarnrc.yml. npmScopes, an object, cannot be set this way."),
		lockfileFormat: checked$1.verified({
			installScripts: null,
			registry: "npm:",
			workspace: "workspace:",
			patch: "patch:",
			file: "file:",
			directory: ["portal:", "link:"],
			gitCommit: "#commit=",
			tarball: "\\.(?:tar\\.gz|tgz)$"
		}, "https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.18.1/packages/yarnpkg-core/sources/Project.ts", "Each entry has resolution: name@<locator>: npm:<version> for the registry, <repository>#commit=<sha> for git (GitHub shortcuts become https://github.com/<owner>/<repo>.git), an http(s) URL for tarballs, file:<path> (a .tgz or .tar.gz path is a tarball, anything else a directory), portal: and link: for directories, workspace: for workspace packages, and patch: around the URL-encoded original locator. No field records install scripts; dependenciesMeta.built: false is a user opt-out."),
		durationStrings: verified$1({
			since: "4.11.0",
			syntax: "compact",
			before: "no effect"
		}, "https://github.com/yarnpkg/berry/pull/6942", "npmMinimalAgeGate accepts a number followed by ms, s, m, h, d or w (e.g. 3d, 1w) since 4.11.0; on 4.10.x such a string silently had no effect."),
		scriptsSwitch: verified$1({
			setting: "enableScripts",
			allow: true,
			deny: false
		}, `${YARNRC}#enableScripts`),
		excludeWildcards: verified$1({
			since: "4.10.0",
			trailingOnly: false
		}, `${YARNRC}#npmPreapprovedPackages`, "Name globs such as @scope/* or package* in npmPreapprovedPackages."),
		berryLockfileMarker: uncertain("__metadata", "https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts", "Read from code: Yarn 2+ writes a __metadata key into yarn.lock and treats a lockfile without it but with \"yarn lockfile v1\" as Yarn Classic."),
		classicLockfileHeader: verified$1("# yarn lockfile v1", "https://github.com/yarnpkg/yarn/blob/master/src/lockfile/stringify.js", "Written as # yarn lockfile v${LOCKFILE_VERSION} with LOCKFILE_VERSION = 1 (src/constants.js)."),
		latestVersion: verified$1("4.18.1", release("4.18.1"), "Yarn 6 is still in preview."),
		bypassFlag: verified$1("--no-time-gate on yarn add and yarn up (4.15.0+)", "https://yarnpkg.com/cli/add"),
		perScopeGate: verified$1("npmScopes.<scope>.npmMinimalAgeGate overrides the global gate (4.17.0+)", release("4.17.0")),
		upgradeMigration: verified$1("When the lockfile predates the new defaults and the key is unset, yarn install writes enableScripts: true, approvedGitRepositories: [\"**\"] and npmMinimalAgeGate: 0 into .yarnrc.yml", "https://github.com/yarnpkg/berry/pull/7135", "Explicit values written by depcurfew prevent the migration."),
		missingPublishTime: verified$1("Versions without a publish time are quarantined while the gate is on", "https://github.com/yarnpkg/berry/pull/6907"),
		unknownSettings: uncertain("Unknown keys in the project .yarnrc.yml throw (unless enableStrictSettings is false), so settings newer than the pinned Yarn break installs", "https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Configuration.ts", "Read from the current source code; older releases were not checked.")
	}
};

// src/knowledge/environment.ts
const { verified } = verifiedOn("2026-10-28");
const checked = verifiedOn("2026-10-29");
const python = verifiedOn("2026-10-30");
const COREPACK_README = "https://github.com/nodejs/corepack/blob/main/README.md";
const COREPACK_CHANGELOG = "https://github.com/nodejs/corepack/blob/main/CHANGELOG.md";
const NPM_PACKAGE_JSON = "https://github.com/npm/cli/blob/v12.2.1/docs/lib/content/configuring-npm/package-json.md";
const SPECIFICATIONS = "https://github.com/pypa/packaging.python.org/blob/6fa4790c1fb668830f6eb94bbfe832320a9b0a2b/source/specifications";
const environment = {
	corepack: {
		packageManagerField: verified({
			key: "packageManager",
			managers: [
				"npm",
				"pnpm",
				"yarn"
			]
		}, COREPACK_README, "Format name@x.y.z, optionally followed by +<hash algorithm>.<hash>; a URL to a .js or .tgz file is also allowed. setup-bun also reads bun@x from this key."),
		devEnginesSince: verified("0.32.0", COREPACK_CHANGELOG, "Limited support at first; since 0.36.0 Corepack uses the devEngines.packageManager range when packageManager is missing."),
		envFileSince: verified("0.32.0", COREPACK_CHANGELOG, "Corepack reads COREPACK_* keys from .corepack.env; since 0.36.0 only the closest file. COREPACK_ENV_FILE=0 turns it off."),
		bundledWithNode: verified([
			{
				since: "0.0.0",
				value: false
			},
			{
				since: "14.19.0",
				value: true
			},
			{
				since: "25.0.0",
				value: false
			}
		], "https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V25.md", "Node.js 25.0.0 stopped distributing Corepack; the Corepack README says it ships with Node.js from 14.19.0 up to (but not including) 25.0.0.")
	},
	devEngines: verified({
		key: "devEngines",
		packageManagerKey: "packageManager",
		runtimeKey: "runtime"
	}, `${NPM_PACKAGE_JSON}#devengines`, "Each entry is an object or a list of objects with name (required), version and onFail (warn, error by default, or ignore). Corepack and the setup actions read it too."),
	devEnginesSince: verified("10.9.0", "https://github.com/npm/cli/blob/v10.9.0/CHANGELOG.md", "npm version that introduced devEngines."),
	volta: {
		manifest: verified({
			key: "volta",
			tools: [
				"node",
				"npm",
				"pnpm",
				"yarn"
			]
		}, "https://github.com/volta-cli/volta/blob/main/crates/volta-core/src/project/serial.rs", "Also extends: a path to another JSON file with a volta key. pnpm support is experimental and needs VOLTA_FEATURE_PNPM=1."),
		maintained: verified(false, "https://github.com/volta-cli/volta/blob/main/README.md", "The README says Volta is unmaintained and recommends migrating to mise.")
	},
	asdf: {
		toolVersionsFile: verified(".tool-versions", "https://github.com/asdf-vm/asdf/blob/master/docs/manage/configuration.md", "One tool per line followed by one or more versions separated by spaces (fallbacks); # starts a comment."),
		plugins: verified({
			nodejs: "node",
			pnpm: "pnpm",
			yarn: "yarn",
			bun: "bun",
			deno: "deno",
			python: "python",
			uv: "uv",
			poetry: "poetry"
		}, "https://github.com/asdf-vm/asdf-plugins/tree/master/plugins", "Short names in the asdf plugin index; there is no plugin named node. python, uv and poetry checked on 2026-10-30 (danhper/asdf-python, asdf-community/asdf-uv, asdf-community/asdf-poetry).")
	},
	githubActions: {
		workflows: verified({
			directory: ".github/workflows",
			extensions: [".yml", ".yaml"]
		}, "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax"),
		setupNode: verified({
			action: "actions/setup-node",
			installs: ["node"],
			inputs: [{
				name: "node-version",
				kind: "version",
				tool: "node"
			}, {
				name: "node-version-file",
				kind: "version-file",
				tool: "node"
			}]
		}, "https://github.com/actions/setup-node/blob/main/action.yml", "Current major v7. node-version-file reads package.json, .nvmrc, .node-version, .tool-versions or mise.toml; node-version wins when both are set."),
		pnpmActionSetup: verified({
			action: "pnpm/action-setup",
			installs: ["pnpm"],
			inputs: [{
				name: "version",
				kind: "version",
				tool: "pnpm"
			}]
		}, "https://github.com/pnpm/action-setup/blob/master/action.yml", "Current major v6. Without version the action reads devEngines.packageManager or packageManager from package.json (package_json_file)."),
		pnpmSetup: verified({
			action: "pnpm/setup",
			installs: ["pnpm"],
			inputs: [
				{
					name: "version",
					kind: "version",
					tool: "pnpm"
				},
				{
					name: "runtime",
					kind: "runtime"
				},
				{
					name: "node-version-file",
					kind: "version-file",
					tool: "node"
				}
			]
		}, "https://github.com/pnpm/setup/blob/main/action.yml", "For pnpm 11 and later. Without version it reads devEngines.packageManager or packageManager; runtime takes <name>@<version> for node, bun or deno."),
		setupBun: verified({
			action: "oven-sh/setup-bun",
			installs: ["bun"],
			inputs: [{
				name: "bun-version",
				kind: "version",
				tool: "bun"
			}, {
				name: "bun-version-file",
				kind: "version-file",
				tool: "bun"
			}]
		}, "https://github.com/oven-sh/setup-bun/blob/main/action.yml", "Current major v2. Without bun-version it reads packageManager (bun@x), then engines.bun, then installs latest."),
		setupDeno: verified({
			action: "denoland/setup-deno",
			installs: ["deno"],
			inputs: [{
				name: "deno-version",
				kind: "version",
				tool: "deno"
			}, {
				name: "deno-version-file",
				kind: "version-file",
				tool: "deno"
			}]
		}, "https://github.com/denoland/setup-deno/blob/main/action.yml", "Current major v2. deno-version defaults to 2.x; deno-version-file reads .dvmrc or .tool-versions."),
		setupPython: python.verified({
			action: "actions/setup-python",
			installs: ["python"],
			inputs: [
				{
					name: "python-version",
					kind: "version",
					tool: "python"
				},
				{
					name: "python-version-file",
					kind: "version-file",
					tool: "python"
				},
				{
					name: "pip-version",
					kind: "version",
					tool: "pip"
				}
			]
		}, "https://github.com/actions/setup-python/blob/v7.1.0/action.yml", "Current version v7.1.0. Without python-version it reads .python-version; python-version wins over python-version-file. pip-version (major[.minor][.patch], CPython only) since v6.0.0. Python comes with pip, but the step alone does not show that pip installs the project."),
		setupUv: python.verified({
			action: "astral-sh/setup-uv",
			installs: ["uv"],
			inputs: [{
				name: "version",
				kind: "version",
				tool: "uv"
			}, {
				name: "version-file",
				kind: "version-file",
				tool: "uv"
			}]
		}, "https://github.com/astral-sh/setup-uv/blob/v10.3.3/action.yml", "Current version v10.3.3, with no moving v10 tag. Without version or version-file it reads required-version from uv.toml, then pyproject.toml, in the working directory, and installs the latest uv when neither has one."),
		installPoetry: python.verified({
			action: "snok/install-poetry",
			installs: ["poetry"],
			inputs: [{
				name: "version",
				kind: "version",
				tool: "poetry"
			}]
		}, "https://github.com/snok/install-poetry/blob/v1.4.2/action.yml", "A third-party action (current v1.4.2); version defaults to latest, so without it the Poetry version is not pinned."),
		actionsPoetry: python.verified({
			action: "abatilo/actions-poetry",
			installs: ["poetry"],
			inputs: [{
				name: "poetry-version",
				kind: "version",
				tool: "poetry"
			}]
		}, "https://github.com/abatilo/actions-poetry/blob/v4.0.0/action.yml", "A third-party action (current v4.0.0); poetry-version defaults to latest."),
		codeScanningUpload: checked.verified({
			action: "github/codeql-action/upload-sarif",
			inputs: {
				sarifFile: "sarif_file",
				category: "category"
			},
			permissions: {
				always: { "security-events": "write" },
				privateRepositories: {
					actions: "read",
					contents: "read"
				}
			}
		}, "https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file", "The example workflow on this page needs security-events: write in every repository and actions: read with contents: read only in private ones. The inputs come from upload-sarif/action.yml in github/codeql-action (current major v4, v4.39.1 checked); category tells analyses of the same tool and commit apart."),
		stopCommands: checked.verified({
			stop: "::stop-commands::{token}",
			resume: "::{token}::"
		}, "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#stopping-and-starting-workflow-commands", "Lines between the two are logged without being processed as workflow commands. The token must be randomly generated and unique for each run. Read from the page source in github/docs."),
		annotations: checked.verified({
			commands: {
				error: "error",
				warning: "warning",
				note: "notice"
			},
			properties: {
				file: "file",
				line: "line",
				title: "title"
			},
			escape: [
				["%", "%25"],
				["\r", "%0D"],
				["\n", "%0A"]
			],
			escapeProperty: [[":", "%3A"], [",", "%2C"]]
		}, "https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts", "escapeData and escapeProperty in @actions/core: the message and property values replace %, CR and LF; property values also replace : and , because properties are separated by commas. The commands and their file, line and title parameters are on https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands (line counts from 1)."),
		annotationLimits: checked.verified({
			perLevelPerStep: 10,
			perJob: 50
		}, "https://github.com/actions/toolkit/blob/main/docs/problem-matchers.md#limitations", "10 error, 10 warning and 10 notice annotations per step; 50 annotations per job, summed over all steps. Annotations over the limit are not shown."),
		stepSummary: checked.verified({
			variable: "GITHUB_STEP_SUMMARY",
			maxBytes: 1048576
		}, "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary", "GitHub flavored Markdown appended to the file named by the variable; at most 1 MiB per step (over that the upload fails with an error annotation), and at most 20 step summaries are shown per job.")
	},
	npmRegistry: {
		api: checked.verified({
			url: "https://registry.npmjs.org/",
			packagePath: "/{escaped name}",
			timeField: "time",
			distTagsField: "dist-tags",
			defaultTag: "latest",
			versionsField: "versions",
			scriptsField: "scripts",
			deprecatedField: "deprecated",
			installScripts: [
				"preinstall",
				"install",
				"postinstall"
			]
		}, "https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md", "GET /{package} returns the full document by default: dist-tags maps tags to versions (every package has latest), versions maps versions to version objects, time maps every version to its publish time, and a version object carries scripts (from its package.json) and deprecated. The abbreviated document (Accept: application/vnd.npm.install-v1+json) has no time field and adds hasInstallScript. Scoped names are escaped with %2f (escapedName in github.com/npm/npm-package-arg); the registry answered the same document for @types/node and @types%2fnode on 2026-10-29. Install scripts: preinstall, install and postinstall run for a dependency, and npm runs node-gyp rebuild as install when the package has binding.gyp and no install or preinstall script (github.com/npm/cli/blob/v12.2.1/docs/lib/content/using-npm/scripts.md); binding.gyp is not visible in the document."),
		notFoundStatus: checked.uncertain(404, "https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md", "The API description leaves its Errors section empty; a name that does not exist answered 404 with {\"error\":\"Not found\"} on 2026-10-29."),
		search: checked.uncertain({
			path: "/-/v1/search",
			maxSize: 250,
			weeklyDownloadsField: "downloads.weekly"
		}, "https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md", "The description documents text, size (at most 250) and from. Results carried downloads.weekly on 2026-10-29, which the description does not list, and from was ignored, so one query returns at most 250 packages.")
	},
	pypiIndex: {
		api: python.verified({
			url: "https://pypi.org/simple/",
			accept: "application/vnd.pypi.simple.v1+json",
			notFoundStatus: 404,
			filesField: "files",
			filenameField: "filename",
			uploadTimeField: "upload-time",
			yankedField: "yanked",
			versionsField: "versions",
			statusField: "project-status",
			statusValueField: "status",
			statusReasonField: "reason"
		}, `${SPECIFICATIONS}/simple-repository-api.rst`, "GET /simple/<project>/ with Accept: application/vnd.pypi.simple.v1+json returns name, files, meta, versions and project-status; the project is matched case-insensitively with _, - and . considered equal (index-api.md in pypi/warehouse, the source of docs.pypi.org/api/index-api/, which recommends the JSON form for new integrations; the JSON API of /pypi/<project>/json marks its releases key deprecated). A file has filename, url, hashes, size, an optional upload-time (yyyy-mm-ddThh:mm:ss.ffffffZ, UTC) and an optional yanked (true or a reason string). Every file belongs to a version listed in versions, but the response does not say which: the version is part of the file name. On 2026-10-30 pypi.org answered api-version 1.4 for requests and 404 for a name it does not know."),
		projectStatus: python.verified({
			blocked: ["quarantined"],
			warned: ["archived", "deprecated"]
		}, `${SPECIFICATIONS}/project-status-markers.rst`, "A project has exactly one status, active when none is given. quarantined: considered generally unsafe (for example malware), and the index must not offer any of its files. archived: no new uploads, existing files stay; installers may warn. deprecated: obsolete, perhaps superseded by another project; installers may warn.")
	},
	claudeCode: { hooks: checked.verified({
		settingsFile: ".claude/settings.json",
		event: "PreToolUse",
		shellTool: "Bash",
		input: {
			event: "hook_event_name",
			tool: "tool_name",
			command: "tool_input.command",
			cwd: "cwd"
		},
		output: {
			container: "hookSpecificOutput",
			event: "hookEventName",
			decision: "permissionDecision",
			reason: "permissionDecisionReason"
		},
		decisions: {
			deny: "deny",
			ask: "ask"
		},
		blockingExitCode: 2,
		onFailure: {
			field: "onFailure",
			value: "block",
			since: "2.1.295"
		},
		projectDir: "${CLAUDE_PROJECT_DIR}",
		settings: {
			hooks: "hooks",
			matcher: "matcher",
			handlers: "hooks",
			type: "type",
			commandType: "command",
			command: "command",
			args: "args"
		}
	}, "https://code.claude.com/docs/en/hooks", "A PreToolUse command hook gets the event as JSON on stdin and decides by printing one JSON object and exiting 0: deny prevents the call and shows the reason to Claude, ask prompts the user (also in auto mode), deny wins over ask. With args set, command runs as an executable without a shell, which also works on Windows. Without onFailure, a hook that fails to start, crashes or times out lets the call through. The if filter is best-effort; the docs recommend the permission system for hard allow or deny rules.") },
	python: {
		nameNormalization: python.verified({
			separators: "[-_.]+",
			replacement: "-"
		}, "https://packaging.python.org/en/latest/specifications/name-normalization/", "Names are lowercased and every run of ., - or _ becomes a single -, before lookups and comparisons (PEP 503): Friendly.Bard and friendly_bard are the same package. Read from the page source in pypa/packaging.python.org."),
		namePattern: python.verified("^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$", "https://packaging.python.org/en/latest/specifications/name-normalization/", "The specification gives ^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])\\Z run with re.IGNORECASE (PEP 508)."),
		projectFile: python.verified("pyproject.toml", "https://packaging.python.org/en/latest/specifications/pyproject-toml/", "The configuration file of a Python project, in the project root; tools keep their own settings in its [tool.<name>] tables."),
		wheelExtension: python.verified(".whl", "https://packaging.python.org/en/latest/specifications/binary-distribution-format/", "A wheel is a ZIP archive with the .whl extension; installing it unpacks files and runs no build code. Read from the page source in pypa/packaging.python.org."),
		sourceDistributionExtensions: python.verified([
			".tar.gz",
			".zip",
			".tar.bz2",
			".tbz",
			".tgz",
			".tar",
			".tar.xz",
			".txz",
			".tlz",
			".tar.lz",
			".tar.lzma"
		], "https://github.com/pypa/pip/blob/26.2.2/src/pip/_internal/utils/filetypes.py", "ARCHIVE_EXTENSIONS of pip without .whl: the archives pip accepts from an index besides wheels (index/package_finder.py rejects any other extension), all of them built when installed. A standard sdist is named {name}-{version}.tar.gz with the name normalized (PEP 625, source-distribution-format.rst); older uploads use the other extensions and names that are not normalized."),
		hatch: python.verified({
			pyprojectTable: "tool.hatch",
			configFile: "hatch.toml"
		}, "https://github.com/pypa/hatch/blob/hatch-v1.18.2/docs/intro.md", "Hatch reads its project configuration from [tool.hatch] of pyproject.toml or from hatch.toml. It has no setting of its own for a release-age delay, building from source or dependency sources; its environments install with uv (installer = \"uv\", the default of its internal environments) or pip (docs/how-to/environment/select-installer.md), and uv reads [tool.uv] of the project under Hatch too (tested on 2026-10-30 with Hatch 1.18.2 and uv 0.13.6)."),
		interpreter: python.verified({
			executables: [
				"python",
				"python3",
				"py"
			],
			moduleOption: "-m",
			commandOption: "-c",
			valueOptions: [
				"-W",
				"-X",
				"--check-hash-based-pycs"
			]
		}, "https://github.com/python/cpython/blob/v3.14.0/Doc/using/cmdline.rst", "python [-bBdEhiIOPqRsSuvVWx?] [-c command | -m module-name | script | - ] [args]: -m and -c end the interpreter options, and what follows goes to the module or the command; -W arg, -X option and --check-hash-based-pycs mode take a value, the other options are flags. pip documents running itself as python -m pip, and as py -m pip with the Windows launcher (github.com/pypa/pip/blob/26.2.2/docs/html/cli/pip_install.rst).")
	}
};

// src/knowledge/index.ts
const knowledgeBase = [
	npm$1,
	pnpm$1,
	yarn$1,
	bun$1,
	deno$1,
	uv$1,
	pip$1,
	poetry$1,
	pdm$1,
	pipenv$1,
	renovate$1,
	dependabot$1
];

// src/cli/describe.ts
/** Tools that `targets: "auto"` resolves to: supported package managers, then bots. */
function detectedTargets(detection) {
	return [...detection.packageManagers.filter((manager) => manager.supported).map((manager) => manager.id), ...detection.bots.map((bot) => bot.id)];
}

// node_modules/yaml/dist/nodes/identity.js
var require_identity = /* @__PURE__ */ __commonJSMin(((exports) => {
	const ALIAS = Symbol.for("yaml.alias");
	const DOC = Symbol.for("yaml.document");
	const MAP = Symbol.for("yaml.map");
	const PAIR = Symbol.for("yaml.pair");
	const SCALAR = Symbol.for("yaml.scalar");
	const SEQ = Symbol.for("yaml.seq");
	const NODE_TYPE = Symbol.for("yaml.node.type");
	const isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
	const isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
	const isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
	const isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
	const isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
	const isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
	function isCollection(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case MAP:
			case SEQ: return true;
		}
		return false;
	}
	function isNode(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case ALIAS:
			case MAP:
			case SCALAR:
			case SEQ: return true;
		}
		return false;
	}
	const hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
	exports.ALIAS = ALIAS;
	exports.DOC = DOC;
	exports.MAP = MAP;
	exports.NODE_TYPE = NODE_TYPE;
	exports.PAIR = PAIR;
	exports.SCALAR = SCALAR;
	exports.SEQ = SEQ;
	exports.hasAnchor = hasAnchor;
	exports.isAlias = isAlias;
	exports.isCollection = isCollection;
	exports.isDocument = isDocument;
	exports.isMap = isMap;
	exports.isNode = isNode;
	exports.isPair = isPair;
	exports.isScalar = isScalar;
	exports.isSeq = isSeq;
}));

// node_modules/yaml/dist/visit.js
var require_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove node");
	/**
	* Apply a visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	function visit(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (visit_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else visit_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visit.SKIP = SKIP;
	/** Remove the current node */
	visit.REMOVE = REMOVE;
	function visit_(key, node, visitor, path) {
		const ctrl = callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visit_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = visit_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = visit_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = visit_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	/**
	* Apply an async visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `Promise`: Must resolve to one of the following values
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	async function visitAsync(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (await visitAsync_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else await visitAsync_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visitAsync.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visitAsync.SKIP = SKIP;
	/** Remove the current node */
	visitAsync.REMOVE = REMOVE;
	async function visitAsync_(key, node, visitor, path) {
		const ctrl = await callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visitAsync_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = await visitAsync_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = await visitAsync_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = await visitAsync_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	function initVisitor(visitor) {
		if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) return Object.assign({
			Alias: visitor.Node,
			Map: visitor.Node,
			Scalar: visitor.Node,
			Seq: visitor.Node
		}, visitor.Value && {
			Map: visitor.Value,
			Scalar: visitor.Value,
			Seq: visitor.Value
		}, visitor.Collection && {
			Map: visitor.Collection,
			Seq: visitor.Collection
		}, visitor);
		return visitor;
	}
	function callVisitor(key, node, visitor, path) {
		if (typeof visitor === "function") return visitor(key, node, path);
		if (identity.isMap(node)) return visitor.Map?.(key, node, path);
		if (identity.isSeq(node)) return visitor.Seq?.(key, node, path);
		if (identity.isPair(node)) return visitor.Pair?.(key, node, path);
		if (identity.isScalar(node)) return visitor.Scalar?.(key, node, path);
		if (identity.isAlias(node)) return visitor.Alias?.(key, node, path);
	}
	function replaceNode(key, path, node) {
		const parent = path[path.length - 1];
		if (identity.isCollection(parent)) parent.items[key] = node;
		else if (identity.isPair(parent)) {
			if (key === "key") parent.key = node;
			else parent.value = node;
		} else if (identity.isDocument(parent)) parent.contents = node;
		else {
			const pt = identity.isAlias(parent) ? "alias" : "scalar";
			throw new Error(`Cannot replace node with ${pt} parent`);
		}
	}
	exports.visit = visit;
	exports.visitAsync = visitAsync;
}));

// node_modules/yaml/dist/doc/directives.js
var require_directives = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	const escapeChars = {
		"!": "%21",
		",": "%2C",
		"[": "%5B",
		"]": "%5D",
		"{": "%7B",
		"}": "%7D"
	};
	const escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
	var Directives = class Directives {
		constructor(yaml, tags) {
			/**
			* The directives-end/doc-start marker `---`. If `null`, a marker may still be
			* included in the document's stringified representation.
			*/
			this.docStart = null;
			/** The doc-end marker `...`.  */
			this.docEnd = false;
			this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
			this.tags = Object.assign({}, Directives.defaultTags, tags);
		}
		clone() {
			const copy = new Directives(this.yaml, this.tags);
			copy.docStart = this.docStart;
			return copy;
		}
		/**
		* During parsing, get a Directives instance for the current document and
		* update the stream state according to the current version's spec.
		*/
		atDocument() {
			const res = new Directives(this.yaml, this.tags);
			switch (this.yaml.version) {
				case "1.1":
					this.atNextDocument = true;
					break;
				case "1.2":
					this.atNextDocument = false;
					this.yaml = {
						explicit: Directives.defaultYaml.explicit,
						version: "1.2"
					};
					this.tags = Object.assign({}, Directives.defaultTags);
			}
			return res;
		}
		/**
		* @param onError - May be called even if the action was successful
		* @returns `true` on success
		*/
		add(line, onError) {
			if (this.atNextDocument) {
				this.yaml = {
					explicit: Directives.defaultYaml.explicit,
					version: "1.1"
				};
				this.tags = Object.assign({}, Directives.defaultTags);
				this.atNextDocument = false;
			}
			const parts = line.trim().split(/[ \t]+/);
			const name = parts.shift();
			switch (name) {
				case "%TAG": {
					if (parts.length !== 2) {
						onError(0, "%TAG directive should contain exactly two parts");
						if (parts.length < 2) return false;
					}
					const [handle, prefix] = parts;
					this.tags[handle] = prefix;
					return true;
				}
				case "%YAML": {
					this.yaml.explicit = true;
					if (parts.length !== 1) {
						onError(0, "%YAML directive should contain exactly one part");
						return false;
					}
					const [version] = parts;
					if (version === "1.1" || version === "1.2") {
						this.yaml.version = version;
						return true;
					} else {
						const isValid = /^\d+\.\d+$/.test(version);
						onError(6, `Unsupported YAML version ${version}`, isValid);
						return false;
					}
				}
				default:
					onError(0, `Unknown directive ${name}`, true);
					return false;
			}
		}
		/**
		* Resolves a tag, matching handles to those defined in %TAG directives.
		*
		* @returns Resolved tag, which may also be the non-specific tag `'!'` or a
		*   `'!local'` tag, or `null` if unresolvable.
		*/
		tagName(source, onError) {
			if (source === "!") return "!";
			if (source[0] !== "!") {
				onError(`Not a valid tag: ${source}`);
				return null;
			}
			if (source[1] === "<") {
				const verbatim = source.slice(2, -1);
				if (verbatim === "!" || verbatim === "!!") {
					onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
					return null;
				}
				if (source[source.length - 1] !== ">") onError("Verbatim tags must end with a >");
				return verbatim;
			}
			const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
			if (!suffix) onError(`The ${source} tag has no suffix`);
			const prefix = this.tags[handle];
			if (prefix) try {
				return prefix + decodeURIComponent(suffix);
			} catch (error) {
				onError(String(error));
				return null;
			}
			if (handle === "!") return source;
			onError(`Could not resolve tag: ${source}`);
			return null;
		}
		/**
		* Given a fully resolved tag, returns its printable string form,
		* taking into account current tag prefixes and defaults.
		*/
		tagString(tag) {
			for (const [handle, prefix] of Object.entries(this.tags)) if (tag.startsWith(prefix)) return handle + escapeTagName(tag.substring(prefix.length));
			return tag[0] === "!" ? tag : `!<${tag}>`;
		}
		toString(doc) {
			const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
			const tagEntries = Object.entries(this.tags);
			let tagNames;
			if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
				const tags = {};
				visit.visit(doc.contents, (_key, node) => {
					if (identity.isNode(node) && node.tag) tags[node.tag] = true;
				});
				tagNames = Object.keys(tags);
			} else tagNames = [];
			for (const [handle, prefix] of tagEntries) {
				if (handle === "!!" && prefix === "tag:yaml.org,2002:") continue;
				if (!doc || tagNames.some((tn) => tn.startsWith(prefix))) lines.push(`%TAG ${handle} ${prefix}`);
			}
			return lines.join("\n");
		}
	};
	Directives.defaultYaml = {
		explicit: false,
		version: "1.2"
	};
	Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
	exports.Directives = Directives;
}));

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	/**
	* Verify that the input string is a valid anchor.
	*
	* Will throw on errors.
	*/
	function anchorIsValid(anchor) {
		if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
			const msg = `Anchor must not contain whitespace or control characters: ${JSON.stringify(anchor)}`;
			throw new Error(msg);
		}
		return true;
	}
	function anchorNames(root) {
		const anchors = /* @__PURE__ */ new Set();
		visit.visit(root, { Value(_key, node) {
			if (node.anchor) anchors.add(node.anchor);
		} });
		return anchors;
	}
	/** Find a new anchor name with the given `prefix` and a one-indexed suffix. */
	function findNewAnchor(prefix, exclude) {
		for (let i = 1;; ++i) {
			const name = `${prefix}${i}`;
			if (!exclude.has(name)) return name;
		}
	}
	function createNodeAnchors(doc, prefix) {
		const aliasObjects = [];
		const sourceObjects = /* @__PURE__ */ new Map();
		let prevAnchors = null;
		return {
			onAnchor: (source) => {
				aliasObjects.push(source);
				prevAnchors ?? (prevAnchors = anchorNames(doc));
				const anchor = findNewAnchor(prefix, prevAnchors);
				prevAnchors.add(anchor);
				return anchor;
			},
			/**
			* With circular references, the source node is only resolved after all
			* of its child nodes are. This is why anchors are set only after all of
			* the nodes have been created.
			*/
			setAnchors: () => {
				for (const source of aliasObjects) {
					const ref = sourceObjects.get(source);
					if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) ref.node.anchor = ref.anchor;
					else {
						const error = /* @__PURE__ */ new Error("Failed to resolve repeated object (this should not happen)");
						error.source = source;
						throw error;
					}
				}
			},
			sourceObjects
		};
	}
	exports.anchorIsValid = anchorIsValid;
	exports.anchorNames = anchorNames;
	exports.createNodeAnchors = createNodeAnchors;
	exports.findNewAnchor = findNewAnchor;
}));

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Applies the JSON.parse reviver algorithm as defined in the ECMA-262 spec,
	* in section 24.5.1.1 "Runtime Semantics: InternalizeJSONProperty" of the
	* 2021 edition: https://tc39.es/ecma262/#sec-json.parse
	*
	* Includes extensions for handling Map and Set objects.
	*/
	function applyReviver(reviver, obj, key, val) {
		if (val && typeof val === "object") {
			if (Array.isArray(val)) for (let i = 0, len = val.length; i < len; ++i) {
				const v0 = val[i];
				const v1 = applyReviver(reviver, val, String(i), v0);
				if (v1 === void 0) delete val[i];
				else if (v1 !== v0) val[i] = v1;
			}
			else if (val instanceof Map) for (const k of Array.from(val.keys())) {
				const v0 = val.get(k);
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) val.delete(k);
				else if (v1 !== v0) val.set(k, v1);
			}
			else if (val instanceof Set) for (const v0 of Array.from(val)) {
				const v1 = applyReviver(reviver, val, v0, v0);
				if (v1 === void 0) val.delete(v0);
				else if (v1 !== v0) {
					val.delete(v0);
					val.add(v1);
				}
			}
			else for (const [k, v0] of Object.entries(val)) {
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) delete val[k];
				else if (v1 !== v0) val[k] = v1;
			}
		}
		return reviver.call(obj, key, val);
	}
	exports.applyReviver = applyReviver;
}));

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	/**
	* Recursively convert any node or its contents to native JavaScript
	*
	* @param value - The input value
	* @param arg - If `value` defines a `toJSON()` method, use this
	*   as its first argument
	* @param ctx - Conversion context, originally set in Document#toJS(). If
	*   `{ keep: true }` is not set, output should be suitable for JSON
	*   stringification.
	*/
	function toJS(value, arg, ctx) {
		if (Array.isArray(value)) return value.map((v, i) => toJS(v, String(i), ctx));
		if (value && typeof value.toJSON === "function") {
			if (!ctx || !identity.hasAnchor(value)) return value.toJSON(arg, ctx);
			const data = {
				aliasCount: 0,
				count: 1,
				res: void 0
			};
			ctx.anchors.set(value, data);
			ctx.onCreate = (res) => {
				data.res = res;
				delete ctx.onCreate;
			};
			const res = value.toJSON(arg, ctx);
			if (ctx.onCreate) ctx.onCreate(res);
			return res;
		}
		if (typeof value === "bigint" && !ctx?.keep) return Number(value);
		return value;
	}
	exports.toJS = toJS;
}));

// node_modules/yaml/dist/nodes/Node.js
var require_Node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var applyReviver = require_applyReviver();
	var identity = require_identity();
	var toJS = require_toJS();
	var NodeBase = class {
		constructor(type) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: type });
		}
		/** Create a copy of this node.  */
		clone() {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** A plain JavaScript representation of this node. */
		toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			if (!identity.isDocument(doc)) throw new TypeError("A document argument is required");
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc,
				keep: true,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this, "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
	};
	exports.NodeBase = NodeBase;
}));

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var visit = require_visit();
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	var Alias = class extends Node.NodeBase {
		constructor(source) {
			super(identity.ALIAS);
			this.source = source;
			Object.defineProperty(this, "tag", { set() {
				throw new Error("Alias nodes cannot have tags");
			} });
		}
		/**
		* Resolve the value of this alias within `doc`, finding the last
		* instance of the `source` anchor before this node.
		*/
		resolve(doc, ctx) {
			if (ctx?.maxAliasCount === 0) throw new ReferenceError("Alias resolution is disabled");
			let nodes;
			if (ctx?.aliasResolveCache) nodes = ctx.aliasResolveCache;
			else {
				nodes = [];
				visit.visit(doc, { Node: (_key, node) => {
					if (identity.isAlias(node) || identity.hasAnchor(node)) nodes.push(node);
				} });
				if (ctx) ctx.aliasResolveCache = nodes;
			}
			let found = void 0;
			for (const node of nodes) {
				if (node === this) break;
				if (node.anchor === this.source) found = node;
			}
			if (found && ctx) {
				const { anchors, doc, maxAliasCount } = ctx;
				let data = anchors.get(found);
				if (!data) {
					toJS.toJS(found, null, ctx);
					data = anchors.get(found);
				}
				/* istanbul ignore if */
				if (data?.res === void 0) throw new ReferenceError("This should not happen: Alias anchor was not resolved?");
				if (maxAliasCount >= 0) {
					data.count += 1;
					if (data.aliasCount === 0) data.aliasCount = getAliasCount(doc, found, anchors);
					if (data.count * data.aliasCount > maxAliasCount) throw new ReferenceError("Excessive alias count indicates a resource exhaustion attack");
				}
			}
			return found;
		}
		toJSON(_arg, ctx) {
			if (!ctx) return { source: this.source };
			const source = this.resolve(ctx.doc, ctx);
			if (!source) {
				const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
				throw new ReferenceError(msg);
			}
			return ctx.anchors.get(source).res;
		}
		toString(ctx, _onComment, _onChompKeep) {
			const src = `*${this.source}`;
			if (ctx) {
				anchors.anchorIsValid(this.source);
				if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
					const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
					throw new Error(msg);
				}
				if (ctx.implicitKey) return `${src} `;
			}
			return src;
		}
	};
	function getAliasCount(doc, node, anchors) {
		if (identity.isAlias(node)) {
			const source = node.resolve(doc);
			const anchor = anchors && source && anchors.get(source);
			return anchor ? anchor.count * anchor.aliasCount : 0;
		} else if (identity.isCollection(node)) {
			let count = 0;
			for (const item of node.items) {
				const c = getAliasCount(doc, item, anchors);
				if (c > count) count = c;
			}
			return count;
		} else if (identity.isPair(node)) {
			const kc = getAliasCount(doc, node.key, anchors);
			const vc = getAliasCount(doc, node.value, anchors);
			return Math.max(kc, vc);
		}
		return 1;
	}
	exports.Alias = Alias;
}));

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	const isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
	var Scalar = class extends Node.NodeBase {
		constructor(value) {
			super(identity.SCALAR);
			this.value = value;
		}
		toJSON(arg, ctx) {
			return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
		}
		toString() {
			return String(this.value);
		}
	};
	Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
	Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
	Scalar.PLAIN = "PLAIN";
	Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
	Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
	exports.Scalar = Scalar;
	exports.isScalarValue = isScalarValue;
}));

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var Scalar = require_Scalar();
	const defaultTagPrefix = "tag:yaml.org,2002:";
	function findTagObject(value, tagName, tags) {
		if (tagName) {
			const match = tags.filter((t) => t.tag === tagName);
			const tagObj = match.find((t) => !t.format) ?? match[0];
			if (!tagObj) throw new Error(`Tag ${tagName} not found`);
			return tagObj;
		}
		return tags.find((t) => t.identify?.(value) && !t.format);
	}
	function createNode(value, tagName, ctx) {
		if (identity.isDocument(value)) value = value.contents;
		if (identity.isNode(value)) return value;
		if (identity.isPair(value)) {
			const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
			map.items.push(value);
			return map;
		}
		if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) value = value.valueOf();
		const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
		let ref = void 0;
		if (aliasDuplicateObjects && value && typeof value === "object") {
			ref = sourceObjects.get(value);
			if (ref) {
				ref.anchor ?? (ref.anchor = onAnchor(value));
				return new Alias.Alias(ref.anchor);
			} else {
				ref = {
					anchor: null,
					node: null
				};
				sourceObjects.set(value, ref);
			}
		}
		if (tagName?.startsWith("!!")) tagName = defaultTagPrefix + tagName.slice(2);
		let tagObj = findTagObject(value, tagName, schema.tags);
		if (!tagObj) {
			if (value && typeof value.toJSON === "function") value = value.toJSON();
			if (!value || typeof value !== "object") {
				const node = new Scalar.Scalar(value);
				if (ref) ref.node = node;
				return node;
			}
			tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
		}
		if (onTagObj) {
			onTagObj(tagObj);
			delete ctx.onTagObj;
		}
		const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
		if (tagName) node.tag = tagName;
		else if (!tagObj.default) node.tag = tagObj.tag;
		if (ref) ref.node = node;
		return node;
	}
	exports.createNode = createNode;
}));

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var identity = require_identity();
	var Node = require_Node();
	function collectionFromPath(schema, path, value) {
		let v = value;
		for (let i = path.length - 1; i >= 0; --i) {
			const k = path[i];
			if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
				const a = [];
				a[k] = v;
				v = a;
			} else v = /* @__PURE__ */ new Map([[k, v]]);
		}
		return createNode.createNode(v, void 0, {
			aliasDuplicateObjects: false,
			keepUndefined: false,
			onAnchor: () => {
				throw new Error("This should not happen, please report a bug.");
			},
			schema,
			sourceObjects: /* @__PURE__ */ new Map()
		});
	}
	const isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
	var Collection = class extends Node.NodeBase {
		constructor(type, schema) {
			super(type);
			Object.defineProperty(this, "schema", {
				value: schema,
				configurable: true,
				enumerable: false,
				writable: true
			});
		}
		/**
		* Create a copy of this collection.
		*
		* @param schema - If defined, overwrites the original's schema
		*/
		clone(schema) {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (schema) copy.schema = schema;
			copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/**
		* Adds a value to the collection. For `!!map` and `!!omap` the value must
		* be a Pair instance or a `{ key, value }` object, which may not have a key
		* that already exists in the map.
		*/
		addIn(path, value) {
			if (isEmptyPath(path)) this.add(value);
			else {
				const [key, ...rest] = path;
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.addIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
		/**
		* Removes a value from the collection.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.delete(key);
			const node = this.get(key, true);
			if (identity.isCollection(node)) return node.deleteIn(rest);
			else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			const [key, ...rest] = path;
			const node = this.get(key, true);
			if (rest.length === 0) return !keepScalar && identity.isScalar(node) ? node.value : node;
			else return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
		}
		hasAllNullValues(allowScalar) {
			return this.items.every((node) => {
				if (!identity.isPair(node)) return false;
				const n = node.value;
				return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
			});
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*/
		hasIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.has(key);
			const node = this.get(key, true);
			return identity.isCollection(node) ? node.hasIn(rest) : false;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			const [key, ...rest] = path;
			if (rest.length === 0) this.set(key, value);
			else {
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.setIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
	};
	exports.Collection = Collection;
	exports.collectionFromPath = collectionFromPath;
	exports.isEmptyPath = isEmptyPath;
}));

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringifies a comment.
	*
	* Empty comment lines are left empty,
	* lines consisting of a single space are replaced by `#`,
	* and all other lines are prefixed with a `#`.
	*/
	const stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
	function indentComment(comment, indent) {
		if (/^\n+$/.test(comment)) return comment.substring(1);
		return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
	}
	const lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
	exports.indentComment = indentComment;
	exports.lineComment = lineComment;
	exports.stringifyComment = stringifyComment;
}));

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = /* @__PURE__ */ __commonJSMin(((exports) => {
	const FOLD_FLOW = "flow";
	const FOLD_BLOCK = "block";
	const FOLD_QUOTED = "quoted";
	/**
	* Tries to keep input at up to `lineWidth` characters, splitting only on spaces
	* not followed by newlines or spaces unless `mode` is `'quoted'`. Lines are
	* terminated with `\n` and started with `indent`.
	*/
	function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
		if (!lineWidth || lineWidth < 0) return text;
		if (lineWidth < minContentWidth) minContentWidth = 0;
		const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
		if (text.length <= endStep) return text;
		const folds = [];
		const escapedFolds = {};
		let end = lineWidth - indent.length;
		if (typeof indentAtStart === "number") {
			if (indentAtStart > lineWidth - Math.max(2, minContentWidth)) folds.push(0);
			else end = lineWidth - indentAtStart;
		}
		let split = void 0;
		let prev = void 0;
		let overflow = false;
		let i = -1;
		let escStart = -1;
		let escEnd = -1;
		if (mode === FOLD_BLOCK) {
			i = consumeMoreIndentedLines(text, i, indent.length);
			if (i !== -1) end = i + endStep;
		}
		for (let ch; ch = text[i += 1];) {
			if (mode === FOLD_QUOTED && ch === "\\") {
				escStart = i;
				switch (text[i + 1]) {
					case "x":
						i += 3;
						break;
					case "u":
						i += 5;
						break;
					case "U":
						i += 9;
						break;
					default: i += 1;
				}
				escEnd = i;
			}
			if (ch === "\n") {
				if (mode === FOLD_BLOCK) i = consumeMoreIndentedLines(text, i, indent.length);
				end = i + indent.length + endStep;
				split = void 0;
			} else {
				if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
					const next = text[i + 1];
					if (next && next !== " " && next !== "\n" && next !== "	") split = i;
				}
				if (i >= end) {
					if (split) {
						folds.push(split);
						end = split + endStep;
						split = void 0;
					} else if (mode === FOLD_QUOTED) {
						while (prev === " " || prev === "	") {
							prev = ch;
							ch = text[i += 1];
							overflow = true;
						}
						const j = i > escEnd + 1 ? i - 2 : escStart - 1;
						if (escapedFolds[j]) return text;
						folds.push(j);
						escapedFolds[j] = true;
						end = j + endStep;
						split = void 0;
					} else overflow = true;
				}
			}
			prev = ch;
		}
		if (overflow && onOverflow) onOverflow();
		if (folds.length === 0) return text;
		if (onFold) onFold();
		let res = text.slice(0, folds[0]);
		for (let i = 0; i < folds.length; ++i) {
			const fold = folds[i];
			const end = folds[i + 1] || text.length;
			if (fold === 0) res = `\n${indent}${text.slice(0, end)}`;
			else {
				if (mode === FOLD_QUOTED && escapedFolds[fold]) res += `${text[fold]}\\`;
				res += `\n${indent}${text.slice(fold + 1, end)}`;
			}
		}
		return res;
	}
	/**
	* Presumes `i + 1` is at the start of a line
	* @returns index of last newline in more-indented block
	*/
	function consumeMoreIndentedLines(text, i, indent) {
		let end = i;
		let start = i + 1;
		let ch = text[start];
		while (ch === " " || ch === "	") if (i < start + indent) ch = text[++i];
		else {
			do
				ch = text[++i];
			while (ch && ch !== "\n");
			end = i;
			start = i + 1;
			ch = text[start];
		}
		return end;
	}
	exports.FOLD_BLOCK = FOLD_BLOCK;
	exports.FOLD_FLOW = FOLD_FLOW;
	exports.FOLD_QUOTED = FOLD_QUOTED;
	exports.foldFlowLines = foldFlowLines;
}));

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var foldFlowLines = require_foldFlowLines();
	const getFoldOptions = (ctx, isBlock) => ({
		indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
		lineWidth: ctx.options.lineWidth,
		minContentWidth: ctx.options.minContentWidth
	});
	const containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
	function lineLengthOverLimit(str, lineWidth, indentLength) {
		if (!lineWidth || lineWidth < 0) return false;
		const limit = lineWidth - indentLength;
		const strLen = str.length;
		if (strLen <= limit) return false;
		for (let i = 0, start = 0; i < strLen; ++i) if (str[i] === "\n") {
			if (i - start > limit) return true;
			start = i + 1;
			if (strLen - start <= limit) return false;
		}
		return true;
	}
	function doubleQuotedString(value, ctx) {
		const json = JSON.stringify(value);
		if (ctx.options.doubleQuotedAsJSON) return json;
		const { implicitKey } = ctx;
		const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		let str = "";
		let start = 0;
		for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
			if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
				str += json.slice(start, i) + "\\ ";
				i += 1;
				start = i;
				ch = "\\";
			}
			if (ch === "\\") switch (json[i + 1]) {
				case "u":
					{
						str += json.slice(start, i);
						const code = json.substr(i + 2, 4);
						switch (code) {
							case "0000":
								str += "\\0";
								break;
							case "0007":
								str += "\\a";
								break;
							case "000b":
								str += "\\v";
								break;
							case "001b":
								str += "\\e";
								break;
							case "0085":
								str += "\\N";
								break;
							case "00a0":
								str += "\\_";
								break;
							case "2028":
								str += "\\L";
								break;
							case "2029":
								str += "\\P";
								break;
							default: if (code.substr(0, 2) === "00") str += "\\x" + code.substr(2);
							else str += json.substr(i, 6);
						}
						i += 5;
						start = i + 1;
					}
					break;
				case "n":
					if (implicitKey || json[i + 2] === "\"" || json.length < minMultiLineLength) i += 1;
					else {
						str += json.slice(start, i) + "\n\n";
						while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== "\"") {
							str += "\n";
							i += 2;
						}
						str += indent;
						if (json[i + 2] === " ") str += "\\";
						i += 1;
						start = i + 1;
					}
					break;
				default: i += 1;
			}
		}
		str = start ? str + json.slice(start) : json;
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
	}
	function singleQuotedString(value, ctx) {
		if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value)) return doubleQuotedString(value, ctx);
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&\n${indent}`) + "'";
		return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function quotedString(value, ctx) {
		const { singleQuote } = ctx.options;
		let qs;
		if (singleQuote === false) qs = doubleQuotedString;
		else {
			const hasDouble = value.includes("\"");
			const hasSingle = value.includes("'");
			if (hasDouble && !hasSingle) qs = singleQuotedString;
			else if (hasSingle && !hasDouble) qs = doubleQuotedString;
			else qs = singleQuote ? singleQuotedString : doubleQuotedString;
		}
		return qs(value, ctx);
	}
	let blockEndNewlines;
	try {
		blockEndNewlines = /* @__PURE__ */ new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
	} catch {
		blockEndNewlines = /\n+(?!\n|$)/g;
	}
	function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
		const { blockQuote, commentString, lineWidth } = ctx.options;
		if (!blockQuote || /\n[\t ]+$/.test(value)) return quotedString(value, ctx);
		const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
		const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
		if (!value) return literal ? "|\n" : ">\n";
		let chomp;
		let endStart;
		for (endStart = value.length; endStart > 0; --endStart) {
			const ch = value[endStart - 1];
			if (ch !== "\n" && ch !== "	" && ch !== " ") break;
		}
		let end = value.substring(endStart);
		const endNlPos = end.indexOf("\n");
		if (endNlPos === -1) chomp = "-";
		else if (value === end || endNlPos !== end.length - 1) {
			chomp = "+";
			if (onChompKeep) onChompKeep();
		} else chomp = "";
		if (end) {
			value = value.slice(0, -end.length);
			if (end[end.length - 1] === "\n") end = end.slice(0, -1);
			end = end.replace(blockEndNewlines, `$&${indent}`);
		}
		let startWithSpace = false;
		let startEnd;
		let startNlPos = -1;
		for (startEnd = 0; startEnd < value.length; ++startEnd) {
			const ch = value[startEnd];
			if (ch === " ") startWithSpace = true;
			else if (ch === "\n") startNlPos = startEnd;
			else break;
		}
		let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
		if (start) {
			value = value.substring(start.length);
			start = start.replace(/\n+/g, `$&${indent}`);
		}
		let header = (startWithSpace ? indent ? "2" : "1" : "") + chomp;
		if (comment) {
			header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
			if (onComment) onComment();
		}
		if (!literal) {
			const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
			let literalFallback = false;
			const foldOptions = getFoldOptions(ctx, true);
			if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) foldOptions.onOverflow = () => {
				literalFallback = true;
			};
			const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
			if (!literalFallback) return `>${header}\n${indent}${body}`;
		}
		value = value.replace(/\n+/g, `$&${indent}`);
		return `|${header}\n${indent}${start}${value}${end}`;
	}
	function plainString(item, ctx, onComment, onChompKeep) {
		const { type, value } = item;
		const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
		if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) return quotedString(value, ctx);
		if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
		if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) return blockString(item, ctx, onComment, onChompKeep);
		if (containsDocumentMarker(value)) {
			if (indent === "") {
				ctx.forceBlockIndent = true;
				return blockString(item, ctx, onComment, onChompKeep);
			} else if (implicitKey && indent === indentStep) return quotedString(value, ctx);
		}
		const str = value.replace(/\n+/g, `$&\n${indent}`);
		if (actualString) {
			const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
			const { compat, tags } = ctx.doc.schema;
			if (tags.some(test) || compat?.some(test)) return quotedString(value, ctx);
		}
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function stringifyString(item, ctx, onComment, onChompKeep) {
		const { implicitKey, inFlow } = ctx;
		const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
		let { type } = item;
		if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
			if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value)) type = Scalar.Scalar.QUOTE_DOUBLE;
		}
		const _stringify = (_type) => {
			switch (_type) {
				case Scalar.Scalar.BLOCK_FOLDED:
				case Scalar.Scalar.BLOCK_LITERAL: return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
				case Scalar.Scalar.QUOTE_DOUBLE: return doubleQuotedString(ss.value, ctx);
				case Scalar.Scalar.QUOTE_SINGLE: return singleQuotedString(ss.value, ctx);
				case Scalar.Scalar.PLAIN: return plainString(ss, ctx, onComment, onChompKeep);
				default: return null;
			}
		};
		let res = _stringify(type);
		if (res === null) {
			const { defaultKeyType, defaultStringType } = ctx.options;
			const t = implicitKey && defaultKeyType || defaultStringType;
			res = _stringify(t);
			if (res === null) throw new Error(`Unsupported default string type ${t}`);
		}
		return res;
	}
	exports.stringifyString = stringifyString;
}));

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var identity = require_identity();
	var stringifyComment = require_stringifyComment();
	var stringifyString = require_stringifyString();
	function createStringifyContext(doc, options) {
		const opt = Object.assign({
			blockQuote: true,
			commentString: stringifyComment.stringifyComment,
			defaultKeyType: null,
			defaultStringType: "PLAIN",
			directives: null,
			doubleQuotedAsJSON: false,
			doubleQuotedMinMultiLineLength: 40,
			falseStr: "false",
			flowCollectionPadding: true,
			indentSeq: true,
			lineWidth: 80,
			minContentWidth: 20,
			nullStr: "null",
			simpleKeys: false,
			singleQuote: null,
			trailingComma: false,
			trueStr: "true",
			verifyAliasOrder: true
		}, doc.schema.toStringOptions, options);
		let inFlow;
		switch (opt.collectionStyle) {
			case "block":
				inFlow = false;
				break;
			case "flow":
				inFlow = true;
				break;
			default: inFlow = null;
		}
		return {
			anchors: /* @__PURE__ */ new Set(),
			doc,
			flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
			indent: "",
			indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
			inFlow,
			options: opt
		};
	}
	function getTagObject(tags, item) {
		if (item.tag) {
			const match = tags.filter((t) => t.tag === item.tag);
			if (match.length > 0) return match.find((t) => t.format === item.format) ?? match[0];
		}
		let tagObj = void 0;
		let obj;
		if (identity.isScalar(item)) {
			obj = item.value;
			let match = tags.filter((t) => t.identify?.(obj));
			if (match.length > 1) {
				const testMatch = match.filter((t) => t.test);
				if (testMatch.length > 0) match = testMatch;
			}
			tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
		} else {
			obj = item;
			tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
		}
		if (!tagObj) {
			const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
			throw new Error(`Tag not resolved for ${name} value`);
		}
		return tagObj;
	}
	function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
		if (!doc.directives) return "";
		const props = [];
		const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
		if (anchor && anchors.anchorIsValid(anchor)) {
			anchors$1.add(anchor);
			props.push(`&${anchor}`);
		}
		const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
		if (tag) props.push(doc.directives.tagString(tag));
		return props.join(" ");
	}
	function stringify(item, ctx, onComment, onChompKeep) {
		if (identity.isPair(item)) return item.toString(ctx, onComment, onChompKeep);
		if (identity.isAlias(item)) {
			if (ctx.doc.directives) return item.toString(ctx);
			if (ctx.resolvedAliases?.has(item)) throw new TypeError(`Cannot stringify circular structure without alias nodes`);
			else {
				if (ctx.resolvedAliases) ctx.resolvedAliases.add(item);
				else ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
				item = item.resolve(ctx.doc);
			}
		}
		let tagObj = void 0;
		const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
		tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
		const props = stringifyProps(node, tagObj, ctx);
		if (props.length > 0) ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
		const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
		if (!props) return str;
		return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}\n${ctx.indent}${str}`;
	}
	exports.createStringifyContext = createStringifyContext;
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
		const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
		let keyComment = identity.isNode(key) && key.comment || null;
		if (simpleKeys) {
			if (keyComment) throw new Error("With simple keys, key nodes cannot have comments");
			if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") throw new Error("With simple keys, collection cannot be used as a key value");
		}
		let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
		ctx = Object.assign({}, ctx, {
			allNullValues: false,
			implicitKey: !explicitKey && (simpleKeys || !allNullValues),
			indent: indent + indentStep
		});
		let keyCommentDone = false;
		let chompKeep = false;
		let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
		if (!explicitKey && !ctx.inFlow && str.length > 1024) {
			if (simpleKeys) throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
			explicitKey = true;
		}
		if (ctx.inFlow) {
			if (allNullValues || value == null) {
				if (keyCommentDone && onComment) onComment();
				return str === "" ? "?" : explicitKey ? `? ${str}` : str;
			}
		} else if (allNullValues && !simpleKeys || value == null && explicitKey) {
			str = `? ${str}`;
			if (keyComment && !keyCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			else if (chompKeep && onChompKeep) onChompKeep();
			return str;
		}
		if (keyCommentDone) keyComment = null;
		if (explicitKey) {
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			str = `? ${str}\n${indent}:`;
		} else {
			str = `${str}:`;
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
		}
		let vsb, vcb, valueComment;
		if (identity.isNode(value)) {
			vsb = !!value.spaceBefore;
			vcb = value.commentBefore;
			valueComment = value.comment;
		} else {
			vsb = false;
			vcb = null;
			valueComment = null;
			if (value && typeof value === "object") value = doc.createNode(value);
		}
		ctx.implicitKey = false;
		if (!explicitKey && !keyComment && identity.isScalar(value)) ctx.indentAtStart = str.length + 1;
		chompKeep = false;
		if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) ctx.indent = ctx.indent.substring(2);
		let valueCommentDone = false;
		const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
		let ws = " ";
		if (keyComment || vsb || vcb) {
			ws = vsb ? "\n" : "";
			if (vcb) {
				const cs = commentString(vcb);
				ws += `\n${stringifyComment.indentComment(cs, ctx.indent)}`;
			}
			if (valueStr === "" && !ctx.inFlow) {
				if (ws === "\n" && valueComment) ws = "\n\n";
			} else ws += `\n${ctx.indent}`;
		} else if (!explicitKey && identity.isCollection(value)) {
			const vs0 = valueStr[0];
			const nl0 = valueStr.indexOf("\n");
			const hasNewline = nl0 !== -1;
			const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
			if (hasNewline || !flow) {
				let hasPropsLine = false;
				if (hasNewline && (vs0 === "&" || vs0 === "!")) {
					let sp0 = valueStr.indexOf(" ");
					if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") sp0 = valueStr.indexOf(" ", sp0 + 1);
					if (sp0 === -1 || nl0 < sp0) hasPropsLine = true;
				}
				if (!hasPropsLine) ws = `\n${ctx.indent}`;
			}
		} else if (valueStr === "" || valueStr[0] === "\n") ws = "";
		str += ws + valueStr;
		if (ctx.inFlow) {
			if (valueCommentDone && onComment) onComment();
		} else if (valueComment && !valueCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
		else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	exports.stringifyPair = stringifyPair;
}));

// node_modules/yaml/dist/log.js
var require_log = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	function debug(logLevel, ...messages) {
		if (logLevel === "debug") console.log(...messages);
	}
	function warn(logLevel, warning) {
		if (logLevel === "debug" || logLevel === "warn") {
			if (typeof node_process.emitWarning === "function") node_process.emitWarning(warning);
			else console.warn(warning);
		}
	}
	exports.debug = debug;
	exports.warn = warn;
}));

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	const MERGE_KEY = "<<";
	const merge = {
		identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
		default: "key",
		tag: "tag:yaml.org,2002:merge",
		test: /^<<$/,
		resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), { addToJSMap: addMergeToJSMap }),
		stringify: () => MERGE_KEY
	};
	const isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
	function addMergeToJSMap(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (identity.isSeq(source)) for (const it of source.items) mergeValue(ctx, map, it);
		else if (Array.isArray(source)) for (const it of source) mergeValue(ctx, map, it);
		else mergeValue(ctx, map, source);
	}
	function mergeValue(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (!identity.isMap(source)) throw new Error("Merge sources must be maps or map aliases");
		const srcMap = source.toJSON(null, ctx, Map);
		for (const [key, value] of srcMap) if (map instanceof Map) {
			if (!map.has(key)) map.set(key, value);
		} else if (map instanceof Set) map.add(key);
		else if (!Object.prototype.hasOwnProperty.call(map, key)) Object.defineProperty(map, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
		return map;
	}
	function resolveAliasValue(ctx, value) {
		return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
	}
	exports.addMergeToJSMap = addMergeToJSMap;
	exports.isMergeKey = isMergeKey;
	exports.merge = merge;
}));

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var log = require_log();
	var merge = require_merge();
	var stringify = require_stringify();
	var identity = require_identity();
	var toJS = require_toJS();
	function addPairToJSMap(ctx, map, { key, value }) {
		if (identity.isNode(key) && key.addToJSMap) key.addToJSMap(ctx, map, value);
		else if (merge.isMergeKey(ctx, key)) merge.addMergeToJSMap(ctx, map, value);
		else {
			const jsKey = toJS.toJS(key, "", ctx);
			if (map instanceof Map) map.set(jsKey, toJS.toJS(value, jsKey, ctx));
			else if (map instanceof Set) map.add(jsKey);
			else {
				const stringKey = stringifyKey(key, jsKey, ctx);
				const jsValue = toJS.toJS(value, stringKey, ctx);
				if (stringKey in map) Object.defineProperty(map, stringKey, {
					value: jsValue,
					writable: true,
					enumerable: true,
					configurable: true
				});
				else map[stringKey] = jsValue;
			}
		}
		return map;
	}
	function stringifyKey(key, jsKey, ctx) {
		if (jsKey === null) return "";
		if (typeof jsKey !== "object") return String(jsKey);
		if (identity.isNode(key) && ctx?.doc) {
			const strCtx = stringify.createStringifyContext(ctx.doc, {});
			strCtx.anchors = /* @__PURE__ */ new Set();
			for (const node of ctx.anchors.keys()) strCtx.anchors.add(node.anchor);
			strCtx.inFlow = true;
			strCtx.inStringifyKey = true;
			const strKey = key.toString(strCtx);
			if (!ctx.mapKeyWarned) {
				let jsonStr = JSON.stringify(strKey);
				if (jsonStr.length > 40) jsonStr = jsonStr.substring(0, 36) + "...\"";
				log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
				ctx.mapKeyWarned = true;
			}
			return strKey;
		}
		return JSON.stringify(jsKey);
	}
	exports.addPairToJSMap = addPairToJSMap;
}));

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyPair = require_stringifyPair();
	var addPairToJSMap = require_addPairToJSMap();
	var identity = require_identity();
	function createPair(key, value, ctx) {
		const k = createNode.createNode(key, void 0, ctx);
		const v = createNode.createNode(value, void 0, ctx);
		return new Pair(k, v);
	}
	var Pair = class Pair {
		constructor(key, value = null) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
			this.key = key;
			this.value = value;
		}
		clone(schema) {
			let { key, value } = this;
			if (identity.isNode(key)) key = key.clone(schema);
			if (identity.isNode(value)) value = value.clone(schema);
			return new Pair(key, value);
		}
		toJSON(_, ctx) {
			const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			return addPairToJSMap.addPairToJSMap(ctx, pair, this);
		}
		toString(ctx, onComment, onChompKeep) {
			return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
		}
	};
	exports.Pair = Pair;
	exports.createPair = createPair;
}));

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyCollection(collection, ctx, options) {
		return (ctx.inFlow ?? collection.flow ? stringifyFlowCollection : stringifyBlockCollection)(collection, ctx, options);
	}
	function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
		const { indent, options: { commentString } } = ctx;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			type: null
		});
		let chompKeep = false;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (!chompKeep && item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (!chompKeep && ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
				}
			}
			chompKeep = false;
			let str = stringify.stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			if (chompKeep && comment) chompKeep = false;
			lines.push(blockItemPrefix + str);
		}
		let str;
		if (lines.length === 0) str = flowChars.start + flowChars.end;
		else {
			str = lines[0];
			for (let i = 1; i < lines.length; ++i) {
				const line = lines[i];
				str += line ? `\n${indent}${line}` : "\n";
			}
		}
		if (comment) {
			str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
			if (onComment) onComment();
		} else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
		const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
		itemIndent += indentStep;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			inFlow: true,
			type: null
		});
		let reqNewline = false;
		let linesAtValue = 0;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, false);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, false);
					if (ik.comment) reqNewline = true;
				}
				const iv = identity.isNode(item.value) ? item.value : null;
				if (iv) {
					if (iv.comment) comment = iv.comment;
					if (iv.commentBefore) reqNewline = true;
				} else if (item.value == null && ik?.comment) comment = ik.comment;
			}
			if (comment) reqNewline = true;
			let str = stringify.stringify(item, itemCtx, () => comment = null);
			reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
			if (i < items.length - 1) str += ",";
			else if (ctx.options.trailingComma) {
				if (ctx.options.lineWidth > 0) reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
				if (reqNewline) str += ",";
			}
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			lines.push(str);
			linesAtValue = lines.length;
		}
		const { start, end } = flowChars;
		if (lines.length === 0) return start + end;
		else {
			if (!reqNewline) {
				const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
				reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
			}
			if (reqNewline) {
				let str = start;
				for (const line of lines) str += line ? `\n${indentStep}${indent}${line}` : "\n";
				return `${str}\n${indent}${end}`;
			} else return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
		}
	}
	function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
		if (comment && chompKeep) comment = comment.replace(/^\n+/, "");
		if (comment) {
			const ic = stringifyComment.indentComment(commentString(comment), indent);
			lines.push(ic.trimStart());
		}
	}
	exports.stringifyCollection = stringifyCollection;
}));

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyCollection = require_stringifyCollection();
	var addPairToJSMap = require_addPairToJSMap();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	function findPair(items, key) {
		const k = identity.isScalar(key) ? key.value : key;
		for (const it of items) if (identity.isPair(it)) {
			if (it.key === key || it.key === k) return it;
			if (identity.isScalar(it.key) && it.key.value === k) return it;
		}
	}
	var YAMLMap = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:map";
		}
		constructor(schema) {
			super(identity.MAP, schema);
			this.items = [];
		}
		/**
		* A generic collection parsing method that can be extended
		* to other node classes that inherit from YAMLMap
		*/
		static from(schema, obj, ctx) {
			const { keepUndefined, replacer } = ctx;
			const map = new this(schema);
			const add = (key, value) => {
				if (typeof replacer === "function") value = replacer.call(obj, key, value);
				else if (Array.isArray(replacer) && !replacer.includes(key)) return;
				if (value !== void 0 || keepUndefined) map.items.push(Pair.createPair(key, value, ctx));
			};
			if (obj instanceof Map) for (const [key, value] of obj) add(key, value);
			else if (obj && typeof obj === "object") for (const key of Object.keys(obj)) add(key, obj[key]);
			if (typeof schema.sortMapEntries === "function") map.items.sort(schema.sortMapEntries);
			return map;
		}
		/**
		* Adds a value to the collection.
		*
		* @param overwrite - If not set `true`, using a key that is already in the
		*   collection will throw. Otherwise, overwrites the previous value.
		*/
		add(pair, overwrite) {
			let _pair;
			if (identity.isPair(pair)) _pair = pair;
			else if (!pair || typeof pair !== "object" || !("key" in pair)) _pair = new Pair.Pair(pair, pair?.value);
			else _pair = new Pair.Pair(pair.key, pair.value);
			const prev = findPair(this.items, _pair.key);
			const sortEntries = this.schema?.sortMapEntries;
			if (prev) {
				if (!overwrite) throw new Error(`Key ${_pair.key} already set`);
				if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value)) prev.value.value = _pair.value;
				else prev.value = _pair.value;
			} else if (sortEntries) {
				const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
				if (i === -1) this.items.push(_pair);
				else this.items.splice(i, 0, _pair);
			} else this.items.push(_pair);
		}
		delete(key) {
			const it = findPair(this.items, key);
			if (!it) return false;
			return this.items.splice(this.items.indexOf(it), 1).length > 0;
		}
		get(key, keepScalar) {
			const node = findPair(this.items, key)?.value;
			return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
		}
		has(key) {
			return !!findPair(this.items, key);
		}
		set(key, value) {
			this.add(new Pair.Pair(key, value), true);
		}
		/**
		* @param ctx - Conversion context, originally set in Document#toJS()
		* @param {Class} Type - If set, forces the returned collection type
		* @returns Instance of Type, Map, or Object
		*/
		toJSON(_, ctx, Type) {
			const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const item of this.items) addPairToJSMap.addPairToJSMap(ctx, map, item);
			return map;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			for (const item of this.items) if (!identity.isPair(item)) throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
			if (!ctx.allNullValues && this.hasAllNullValues(false)) ctx = Object.assign({}, ctx, { allNullValues: true });
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "",
				flowChars: {
					start: "{",
					end: "}"
				},
				itemIndent: ctx.indent || "",
				onChompKeep,
				onComment
			});
		}
	};
	exports.YAMLMap = YAMLMap;
	exports.findPair = findPair;
}));

// node_modules/yaml/dist/schema/common/map.js
var require_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLMap = require_YAMLMap();
	const map = {
		collection: "map",
		default: true,
		nodeClass: YAMLMap.YAMLMap,
		tag: "tag:yaml.org,2002:map",
		resolve(map, onError) {
			if (!identity.isMap(map)) onError("Expected a mapping for this tag");
			return map;
		},
		createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
	};
	exports.map = map;
}));

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyCollection = require_stringifyCollection();
	var Collection = require_Collection();
	var identity = require_identity();
	var Scalar = require_Scalar();
	var toJS = require_toJS();
	var YAMLSeq = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:seq";
		}
		constructor(schema) {
			super(identity.SEQ, schema);
			this.items = [];
		}
		add(value) {
			this.items.push(value);
		}
		/**
		* Removes a value from the collection.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return false;
			return this.items.splice(idx, 1).length > 0;
		}
		get(key, keepScalar) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return void 0;
			const it = this.items[idx];
			return !keepScalar && identity.isScalar(it) ? it.value : it;
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*/
		has(key) {
			const idx = asItemIndex(key);
			return typeof idx === "number" && idx < this.items.length;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*
		* If `key` does not contain a representation of an integer, this will throw.
		* It may be wrapped in a `Scalar`.
		*/
		set(key, value) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") throw new Error(`Expected a valid index, not ${key}.`);
			const prev = this.items[idx];
			if (identity.isScalar(prev) && Scalar.isScalarValue(value)) prev.value = value;
			else this.items[idx] = value;
		}
		toJSON(_, ctx) {
			const seq = [];
			if (ctx?.onCreate) ctx.onCreate(seq);
			let i = 0;
			for (const item of this.items) seq.push(toJS.toJS(item, String(i++), ctx));
			return seq;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "- ",
				flowChars: {
					start: "[",
					end: "]"
				},
				itemIndent: (ctx.indent || "") + "  ",
				onChompKeep,
				onComment
			});
		}
		static from(schema, obj, ctx) {
			const { replacer } = ctx;
			const seq = new this(schema);
			if (obj && Symbol.iterator in Object(obj)) {
				let i = 0;
				for (let it of obj) {
					if (typeof replacer === "function") {
						const key = obj instanceof Set ? it : String(i++);
						it = replacer.call(obj, key, it);
					}
					seq.items.push(createNode.createNode(it, void 0, ctx));
				}
			}
			return seq;
		}
	};
	function asItemIndex(key) {
		let idx = identity.isScalar(key) ? key.value : key;
		if (idx && typeof idx === "string") idx = Number(idx);
		return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
	}
	exports.YAMLSeq = YAMLSeq;
}));

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLSeq = require_YAMLSeq();
	const seq = {
		collection: "seq",
		default: true,
		nodeClass: YAMLSeq.YAMLSeq,
		tag: "tag:yaml.org,2002:seq",
		resolve(seq, onError) {
			if (!identity.isSeq(seq)) onError("Expected a sequence for this tag");
			return seq;
		},
		createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
	};
	exports.seq = seq;
}));

// node_modules/yaml/dist/schema/common/string.js
var require_string = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyString = require_stringifyString();
	const string = {
		identify: (value) => typeof value === "string",
		default: true,
		tag: "tag:yaml.org,2002:str",
		resolve: (str) => str,
		stringify(item, ctx, onComment, onChompKeep) {
			ctx = Object.assign({ actualString: true }, ctx);
			return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
		}
	};
	exports.string = string;
}));

// node_modules/yaml/dist/schema/common/null.js
var require_null = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const nullTag = {
		identify: (value) => value == null,
		createNode: () => new Scalar.Scalar(null),
		default: true,
		tag: "tag:yaml.org,2002:null",
		test: /^(?:~|[Nn]ull|NULL)?$/,
		resolve: () => new Scalar.Scalar(null),
		stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
	};
	exports.nullTag = nullTag;
}));

// node_modules/yaml/dist/schema/core/bool.js
var require_bool$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const boolTag = {
		identify: (value) => typeof value === "boolean",
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
		resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
		stringify({ source, value }, ctx) {
			if (source && boolTag.test.test(source)) {
				if (value === (source[0] === "t" || source[0] === "T")) return source;
			}
			return value ? ctx.options.trueStr : ctx.options.falseStr;
		}
	};
	exports.boolTag = boolTag;
}));

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = /* @__PURE__ */ __commonJSMin(((exports) => {
	function stringifyNumber({ format, minFractionDigits, tag, value }) {
		if (typeof value === "bigint") return String(value);
		const num = typeof value === "number" ? value : Number(value);
		if (!isFinite(num)) return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
		let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
		if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
			let i = n.indexOf(".");
			if (i < 0) {
				i = n.length;
				n += ".";
			}
			let d = minFractionDigits - (n.length - i - 1);
			while (d-- > 0) n += "0";
		}
		return n;
	}
	exports.stringifyNumber = stringifyNumber;
}));

// node_modules/yaml/dist/schema/core/float.js
var require_float$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	const float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str));
			const dot = str.indexOf(".");
			if (dot !== -1 && str[str.length - 1] === "0") node.minFractionDigits = str.length - dot - 1;
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.float = float;
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));

// node_modules/yaml/dist/schema/core/int.js
var require_int$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	const intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value) && value >= 0) return prefix + value.toString(radix);
		return stringifyNumber.stringifyNumber(node);
	}
	const intOct = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^0o[0-7]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
		stringify: (node) => intStringify(node, 8, "0o")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^0x[0-9a-fA-F]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));

// node_modules/yaml/dist/schema/core/schema.js
var require_schema$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	const schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.boolTag,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float
	];
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/json/schema.js
var require_schema$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var map = require_map();
	var seq = require_seq();
	function intIdentify(value) {
		return typeof value === "bigint" || Number.isInteger(value);
	}
	const stringifyJSON = ({ value }) => JSON.stringify(value);
	const jsonScalars = [
		{
			identify: (value) => typeof value === "string",
			default: true,
			tag: "tag:yaml.org,2002:str",
			resolve: (str) => str,
			stringify: stringifyJSON
		},
		{
			identify: (value) => value == null,
			createNode: () => new Scalar.Scalar(null),
			default: true,
			tag: "tag:yaml.org,2002:null",
			test: /^null$/,
			resolve: () => null,
			stringify: stringifyJSON
		},
		{
			identify: (value) => typeof value === "boolean",
			default: true,
			tag: "tag:yaml.org,2002:bool",
			test: /^true$|^false$/,
			resolve: (str) => str === "true",
			stringify: stringifyJSON
		},
		{
			identify: intIdentify,
			default: true,
			tag: "tag:yaml.org,2002:int",
			test: /^-?(?:0|[1-9][0-9]*)$/,
			resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
			stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
		},
		{
			identify: (value) => typeof value === "number",
			default: true,
			tag: "tag:yaml.org,2002:float",
			test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
			resolve: (str) => parseFloat(str),
			stringify: stringifyJSON
		}
	];
	const schema = [map.map, seq.seq].concat(jsonScalars, {
		default: true,
		tag: "",
		test: /^/,
		resolve(str, onError) {
			onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
			return str;
		}
	});
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_buffer = __require("buffer");
	var Scalar = require_Scalar();
	var stringifyString = require_stringifyString();
	const binary = {
		identify: (value) => value instanceof Uint8Array,
		default: false,
		tag: "tag:yaml.org,2002:binary",
		/**
		* Returns a Buffer in node and an Uint8Array in browsers
		*
		* To use the resulting buffer as an image, you'll want to do something like:
		*
		*   const blob = new Blob([buffer], { type: 'image/jpeg' })
		*   document.querySelector('#photo').src = URL.createObjectURL(blob)
		*/
		resolve(src, onError) {
			if (typeof node_buffer.Buffer === "function") return node_buffer.Buffer.from(src, "base64");
			else if (typeof atob === "function") {
				const str = atob(src.replace(/[\n\r]/g, ""));
				const buffer = new Uint8Array(str.length);
				for (let i = 0; i < str.length; ++i) buffer[i] = str.charCodeAt(i);
				return buffer;
			} else {
				onError("This environment does not support reading binary tags; either Buffer or atob is required");
				return src;
			}
		},
		stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
			if (!value) return "";
			const buf = value;
			let str;
			if (typeof node_buffer.Buffer === "function") str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
			else if (typeof btoa === "function") {
				let s = "";
				for (let i = 0; i < buf.length; ++i) s += String.fromCharCode(buf[i]);
				str = btoa(s);
			} else throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
			type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
			if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
				const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
				const n = Math.ceil(str.length / lineWidth);
				const lines = new Array(n);
				for (let i = 0, o = 0; i < n; ++i, o += lineWidth) lines[i] = str.substr(o, lineWidth);
				str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
			}
			return stringifyString.stringifyString({
				comment,
				type,
				value: str
			}, ctx, onComment, onChompKeep);
		}
	};
	exports.binary = binary;
}));

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLSeq = require_YAMLSeq();
	function resolvePairs(seq, onError) {
		if (identity.isSeq(seq)) for (let i = 0; i < seq.items.length; ++i) {
			let item = seq.items[i];
			if (identity.isPair(item)) continue;
			else if (identity.isMap(item)) {
				if (item.items.length > 1) onError("Each pair must have its own sequence indicator");
				const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
				if (item.commentBefore) pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}\n${pair.key.commentBefore}` : item.commentBefore;
				if (item.comment) {
					const cn = pair.value ?? pair.key;
					cn.comment = cn.comment ? `${item.comment}\n${cn.comment}` : item.comment;
				}
				item = pair;
			}
			seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
		}
		else onError("Expected a sequence for this tag");
		return seq;
	}
	function createPairs(schema, iterable, ctx) {
		const { replacer } = ctx;
		const pairs = new YAMLSeq.YAMLSeq(schema);
		pairs.tag = "tag:yaml.org,2002:pairs";
		let i = 0;
		if (iterable && Symbol.iterator in Object(iterable)) for (let it of iterable) {
			if (typeof replacer === "function") it = replacer.call(iterable, String(i++), it);
			let key, value;
			if (Array.isArray(it)) {
				if (it.length === 2) {
					key = it[0];
					value = it[1];
				} else throw new TypeError(`Expected [key, value] tuple: ${it}`);
			} else if (it && it instanceof Object) {
				const keys = Object.keys(it);
				if (keys.length === 1) {
					key = keys[0];
					value = it[key];
				} else throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
			} else key = it;
			pairs.items.push(Pair.createPair(key, value, ctx));
		}
		return pairs;
	}
	const pairs = {
		collection: "seq",
		default: false,
		tag: "tag:yaml.org,2002:pairs",
		resolve: resolvePairs,
		createNode: createPairs
	};
	exports.createPairs = createPairs;
	exports.pairs = pairs;
	exports.resolvePairs = resolvePairs;
}));

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var toJS = require_toJS();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var pairs = require_pairs();
	var YAMLOMap = class YAMLOMap extends YAMLSeq.YAMLSeq {
		constructor() {
			super();
			this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
			this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
			this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
			this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
			this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
			this.tag = YAMLOMap.tag;
		}
		/**
		* If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
		* but TypeScript won't allow widening the signature of a child method.
		*/
		toJSON(_, ctx) {
			if (!ctx) return super.toJSON(_);
			const map = /* @__PURE__ */ new Map();
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const pair of this.items) {
				let key, value;
				if (identity.isPair(pair)) {
					key = toJS.toJS(pair.key, "", ctx);
					value = toJS.toJS(pair.value, key, ctx);
				} else key = toJS.toJS(pair, "", ctx);
				if (map.has(key)) throw new Error("Ordered maps must not include duplicate keys");
				map.set(key, value);
			}
			return map;
		}
		static from(schema, iterable, ctx) {
			const pairs$1 = pairs.createPairs(schema, iterable, ctx);
			const omap = new this();
			omap.items = pairs$1.items;
			return omap;
		}
	};
	YAMLOMap.tag = "tag:yaml.org,2002:omap";
	const omap = {
		collection: "seq",
		identify: (value) => value instanceof Map,
		nodeClass: YAMLOMap,
		default: false,
		tag: "tag:yaml.org,2002:omap",
		resolve(seq, onError) {
			const pairs$1 = pairs.resolvePairs(seq, onError);
			const seenKeys = [];
			for (const { key } of pairs$1.items) if (identity.isScalar(key)) {
				if (seenKeys.includes(key.value)) onError(`Ordered maps must not include duplicate keys: ${key.value}`);
				else seenKeys.push(key.value);
			}
			return Object.assign(new YAMLOMap(), pairs$1);
		},
		createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
	};
	exports.YAMLOMap = YAMLOMap;
	exports.omap = omap;
}));

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function boolStringify({ value, source }, ctx) {
		if (source && (value ? trueTag : falseTag).test.test(source)) return source;
		return value ? ctx.options.trueStr : ctx.options.falseStr;
	}
	const trueTag = {
		identify: (value) => value === true,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
		resolve: () => new Scalar.Scalar(true),
		stringify: boolStringify
	};
	const falseTag = {
		identify: (value) => value === false,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
		resolve: () => new Scalar.Scalar(false),
		stringify: boolStringify
	};
	exports.falseTag = falseTag;
	exports.trueTag = trueTag;
}));

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str.replace(/_/g, "")),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	const float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
			const dot = str.indexOf(".");
			if (dot !== -1) {
				const f = str.substring(dot + 1).replace(/_/g, "");
				if (f[f.length - 1] === "0") node.minFractionDigits = f.length;
			}
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.float = float;
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	function intResolve(str, offset, radix, { intAsBigInt }) {
		const sign = str[0];
		if (sign === "-" || sign === "+") offset += 1;
		str = str.substring(offset).replace(/_/g, "");
		if (intAsBigInt) {
			switch (radix) {
				case 2:
					str = `0b${str}`;
					break;
				case 8:
					str = `0o${str}`;
					break;
				case 16: str = `0x${str}`;
			}
			const n = BigInt(str);
			return sign === "-" ? BigInt(-1) * n : n;
		}
		const n = parseInt(str, radix);
		return sign === "-" ? -1 * n : n;
	}
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value)) {
			const str = value.toString(radix);
			return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
		}
		return stringifyNumber.stringifyNumber(node);
	}
	const intBin = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "BIN",
		test: /^[-+]?0b[0-1_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
		stringify: (node) => intStringify(node, 2, "0b")
	};
	const intOct = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^[-+]?0[0-7_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
		stringify: (node) => intStringify(node, 8, "0")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9][0-9_]*$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^[-+]?0x[0-9a-fA-F_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intBin = intBin;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSet = class YAMLSet extends YAMLMap.YAMLMap {
		constructor(schema) {
			super(schema);
			this.tag = YAMLSet.tag;
		}
		add(key) {
			let pair;
			if (identity.isPair(key)) pair = key;
			else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null) pair = new Pair.Pair(key.key, null);
			else pair = new Pair.Pair(key, null);
			if (!YAMLMap.findPair(this.items, pair.key)) this.items.push(pair);
		}
		/**
		* If `keepPair` is `true`, returns the Pair matching `key`.
		* Otherwise, returns the value of that Pair's key.
		*/
		get(key, keepPair) {
			const pair = YAMLMap.findPair(this.items, key);
			return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
		}
		set(key, value) {
			if (typeof value !== "boolean") throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
			const prev = YAMLMap.findPair(this.items, key);
			if (prev && !value) this.items.splice(this.items.indexOf(prev), 1);
			else if (!prev && value) this.items.push(new Pair.Pair(key));
		}
		toJSON(_, ctx) {
			return super.toJSON(_, ctx, Set);
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			if (this.hasAllNullValues(true)) return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
			else throw new Error("Set items must all have null values");
		}
		static from(schema, iterable, ctx) {
			const { replacer } = ctx;
			const set = new this(schema);
			if (iterable && Symbol.iterator in Object(iterable)) for (let value of iterable) {
				if (typeof replacer === "function") value = replacer.call(iterable, value, value);
				set.items.push(Pair.createPair(value, null, ctx));
			}
			return set;
		}
	};
	YAMLSet.tag = "tag:yaml.org,2002:set";
	const set = {
		collection: "map",
		identify: (value) => value instanceof Set,
		nodeClass: YAMLSet,
		default: false,
		tag: "tag:yaml.org,2002:set",
		createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
		resolve(map, onError) {
			if (identity.isMap(map)) {
				if (map.hasAllNullValues(true)) return Object.assign(new YAMLSet(), map);
				else onError("Set items must all have null values");
			} else onError("Expected a mapping for this tag");
			return map;
		}
	};
	exports.YAMLSet = YAMLSet;
	exports.set = set;
}));

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	/** Internal types handle bigint as number, because TS can't figure it out. */
	function parseSexagesimal(str, asBigInt) {
		const sign = str[0];
		const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
		const num = (n) => asBigInt ? BigInt(n) : Number(n);
		const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
		return sign === "-" ? num(-1) * res : res;
	}
	/**
	* hhhh:mm:ss.sss
	*
	* Internal types handle bigint as number, because TS can't figure it out.
	*/
	function stringifySexagesimal(node) {
		let { value } = node;
		let num = (n) => n;
		if (typeof value === "bigint") num = (n) => BigInt(n);
		else if (isNaN(value) || !isFinite(value)) return stringifyNumber.stringifyNumber(node);
		let sign = "";
		if (value < 0) {
			sign = "-";
			value *= num(-1);
		}
		const _60 = num(60);
		const parts = [value % _60];
		if (value < 60) parts.unshift(0);
		else {
			value = (value - parts[0]) / _60;
			parts.unshift(value % _60);
			if (value >= 60) {
				value = (value - parts[0]) / _60;
				parts.unshift(value);
			}
		}
		return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
	}
	const intTime = {
		identify: (value) => typeof value === "bigint" || Number.isInteger(value),
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
		resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
		stringify: stringifySexagesimal
	};
	const floatTime = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
		resolve: (str) => parseSexagesimal(str, false),
		stringify: stringifySexagesimal
	};
	const timestamp = {
		identify: (value) => value instanceof Date,
		default: true,
		tag: "tag:yaml.org,2002:timestamp",
		test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
		resolve(str) {
			const match = str.match(timestamp.test);
			if (!match) throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
			const [, year, month, day, hour, minute, second] = match.map(Number);
			const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
			let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
			const tz = match[8];
			if (tz && tz !== "Z") {
				let d = parseSexagesimal(tz, false);
				if (Math.abs(d) < 30) d *= 60;
				date -= 6e4 * d;
			}
			return new Date(date);
		},
		stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
	};
	exports.floatTime = floatTime;
	exports.intTime = intTime;
	exports.timestamp = timestamp;
}));

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var binary = require_binary();
	var bool = require_bool();
	var float = require_float();
	var int = require_int();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var set = require_set();
	var timestamp = require_timestamp();
	const schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.trueTag,
		bool.falseTag,
		int.intBin,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float,
		binary.binary,
		merge.merge,
		omap.omap,
		pairs.pairs,
		set.set,
		timestamp.intTime,
		timestamp.floatTime,
		timestamp.timestamp
	];
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/tags.js
var require_tags = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	var schema = require_schema$2();
	var schema$1 = require_schema$1();
	var binary = require_binary();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var schema$2 = require_schema();
	var set = require_set();
	var timestamp = require_timestamp();
	const schemas = /* @__PURE__ */ new Map([
		["core", schema.schema],
		["failsafe", [
			map.map,
			seq.seq,
			string.string
		]],
		["json", schema$1.schema],
		["yaml11", schema$2.schema],
		["yaml-1.1", schema$2.schema]
	]);
	const tagsByName = {
		binary: binary.binary,
		bool: bool.boolTag,
		float: float.float,
		floatExp: float.floatExp,
		floatNaN: float.floatNaN,
		floatTime: timestamp.floatTime,
		int: int.int,
		intHex: int.intHex,
		intOct: int.intOct,
		intTime: timestamp.intTime,
		map: map.map,
		merge: merge.merge,
		null: _null.nullTag,
		omap: omap.omap,
		pairs: pairs.pairs,
		seq: seq.seq,
		set: set.set,
		timestamp: timestamp.timestamp
	};
	const coreKnownTags = {
		"tag:yaml.org,2002:binary": binary.binary,
		"tag:yaml.org,2002:merge": merge.merge,
		"tag:yaml.org,2002:omap": omap.omap,
		"tag:yaml.org,2002:pairs": pairs.pairs,
		"tag:yaml.org,2002:set": set.set,
		"tag:yaml.org,2002:timestamp": timestamp.timestamp
	};
	function getTags(customTags, schemaName, addMergeTag) {
		const schemaTags = schemas.get(schemaName);
		if (schemaTags && !customTags) return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
		let tags = schemaTags;
		if (!tags) {
			if (Array.isArray(customTags)) tags = [];
			else {
				const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
			}
		}
		if (Array.isArray(customTags)) for (const tag of customTags) tags = tags.concat(tag);
		else if (typeof customTags === "function") tags = customTags(tags.slice());
		if (addMergeTag) tags = tags.concat(merge.merge);
		return tags.reduce((tags, tag) => {
			const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
			if (!tagObj) {
				const tagName = JSON.stringify(tag);
				const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
			}
			if (!tags.includes(tagObj)) tags.push(tagObj);
			return tags;
		}, []);
	}
	exports.coreKnownTags = coreKnownTags;
	exports.getTags = getTags;
}));

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var map = require_map();
	var seq = require_seq();
	var string = require_string();
	var tags = require_tags();
	const sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	var Schema = class Schema {
		constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
			this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
			this.name = typeof schema === "string" && schema || "core";
			this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
			this.tags = tags.getTags(customTags, this.name, merge);
			this.toStringOptions = toStringDefaults ?? null;
			Object.defineProperty(this, identity.MAP, { value: map.map });
			Object.defineProperty(this, identity.SCALAR, { value: string.string });
			Object.defineProperty(this, identity.SEQ, { value: seq.seq });
			this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
		}
		clone() {
			const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
			copy.tags = this.tags.slice();
			return copy;
		}
	};
	exports.Schema = Schema;
}));

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyDocument(doc, options) {
		const lines = [];
		let hasDirectives = options.directives === true;
		if (options.directives !== false && doc.directives) {
			const dir = doc.directives.toString(doc);
			if (dir) {
				lines.push(dir);
				hasDirectives = true;
			} else if (doc.directives.docStart) hasDirectives = true;
		}
		if (hasDirectives) lines.push("---");
		const ctx = stringify.createStringifyContext(doc, options);
		const { commentString } = ctx.options;
		if (doc.commentBefore) {
			if (lines.length !== 1) lines.unshift("");
			const cs = commentString(doc.commentBefore);
			lines.unshift(stringifyComment.indentComment(cs, ""));
		}
		let chompKeep = false;
		let contentComment = null;
		if (doc.contents) {
			if (identity.isNode(doc.contents)) {
				if (doc.contents.spaceBefore && hasDirectives) lines.push("");
				if (doc.contents.commentBefore) {
					const cs = commentString(doc.contents.commentBefore);
					lines.push(stringifyComment.indentComment(cs, ""));
				}
				ctx.forceBlockIndent = !!doc.comment;
				contentComment = doc.contents.comment;
			}
			const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
			let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
			if (contentComment) body += stringifyComment.lineComment(body, "", commentString(contentComment));
			if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") lines[lines.length - 1] = `--- ${body}`;
			else lines.push(body);
		} else lines.push(stringify.stringify(doc.contents, ctx));
		if (doc.directives?.docEnd) {
			if (doc.comment) {
				const cs = commentString(doc.comment);
				if (cs.includes("\n")) {
					lines.push("...");
					lines.push(stringifyComment.indentComment(cs, ""));
				} else lines.push(`... ${cs}`);
			} else lines.push("...");
		} else {
			let dc = doc.comment;
			if (dc && chompKeep) dc = dc.replace(/^\n+/, "");
			if (dc) {
				if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "") lines.push("");
				lines.push(stringifyComment.indentComment(commentString(dc), ""));
			}
		}
		return lines.join("\n") + "\n";
	}
	exports.stringifyDocument = stringifyDocument;
}));

// node_modules/yaml/dist/doc/Document.js
var require_Document = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var toJS = require_toJS();
	var Schema = require_Schema();
	var stringifyDocument = require_stringifyDocument();
	var anchors = require_anchors();
	var applyReviver = require_applyReviver();
	var createNode = require_createNode();
	var directives = require_directives();
	var Document = class Document {
		constructor(value, replacer, options) {
			/** A comment before this Document */
			this.commentBefore = null;
			/** A comment immediately after this Document */
			this.comment = null;
			/** Errors encountered during parsing. */
			this.errors = [];
			/** Warnings encountered during parsing. */
			this.warnings = [];
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
			let _replacer = null;
			if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
			else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const opt = Object.assign({
				intAsBigInt: false,
				keepSourceTokens: false,
				logLevel: "warn",
				prettyErrors: true,
				strict: true,
				stringKeys: false,
				uniqueKeys: true,
				version: "1.2"
			}, options);
			this.options = opt;
			let { version } = opt;
			if (options?._directives) {
				this.directives = options._directives.atDocument();
				if (this.directives.yaml.explicit) version = this.directives.yaml.version;
			} else this.directives = new directives.Directives({ version });
			this.setSchema(version, options);
			this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
		}
		/**
		* Create a deep copy of this Document and its contents.
		*
		* Custom Node values that inherit from `Object` still refer to their original instances.
		*/
		clone() {
			const copy = Object.create(Document.prototype, { [identity.NODE_TYPE]: { value: identity.DOC } });
			copy.commentBefore = this.commentBefore;
			copy.comment = this.comment;
			copy.errors = this.errors.slice();
			copy.warnings = this.warnings.slice();
			copy.options = Object.assign({}, this.options);
			if (this.directives) copy.directives = this.directives.clone();
			copy.schema = this.schema.clone();
			copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** Adds a value to the document. */
		add(value) {
			if (assertCollection(this.contents)) this.contents.add(value);
		}
		/** Adds a value to the document. */
		addIn(path, value) {
			if (assertCollection(this.contents)) this.contents.addIn(path, value);
		}
		/**
		* Create a new `Alias` node, ensuring that the target `node` has the required anchor.
		*
		* If `node` already has an anchor, `name` is ignored.
		* Otherwise, the `node.anchor` value will be set to `name`,
		* or if an anchor with that name is already present in the document,
		* `name` will be used as a prefix for a new unique anchor.
		* If `name` is undefined, the generated anchor will use 'a' as a prefix.
		*/
		createAlias(node, name) {
			if (!node.anchor) {
				const prev = anchors.anchorNames(this);
				node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
			}
			return new Alias.Alias(node.anchor);
		}
		createNode(value, replacer, options) {
			let _replacer = void 0;
			if (typeof replacer === "function") {
				value = replacer.call({ "": value }, "", value);
				_replacer = replacer;
			} else if (Array.isArray(replacer)) {
				const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
				const asStr = replacer.filter(keyToStr).map(String);
				if (asStr.length > 0) replacer = replacer.concat(asStr);
				_replacer = replacer;
			} else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
			const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
			const ctx = {
				aliasDuplicateObjects: aliasDuplicateObjects ?? true,
				keepUndefined: keepUndefined ?? false,
				onAnchor,
				onTagObj,
				replacer: _replacer,
				schema: this.schema,
				sourceObjects
			};
			const node = createNode.createNode(value, tag, ctx);
			if (flow && identity.isCollection(node)) node.flow = true;
			setAnchors();
			return node;
		}
		/**
		* Convert a key and a value into a `Pair` using the current schema,
		* recursively wrapping all values as `Scalar` or `Collection` nodes.
		*/
		createPair(key, value, options = {}) {
			const k = this.createNode(key, null, options);
			const v = this.createNode(value, null, options);
			return new Pair.Pair(k, v);
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			return assertCollection(this.contents) ? this.contents.delete(key) : false;
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			if (Collection.isEmptyPath(path)) {
				if (this.contents == null) return false;
				this.contents = null;
				return true;
			}
			return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		get(key, keepScalar) {
			return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
		}
		/**
		* Returns item at `path`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			if (Collection.isEmptyPath(path)) return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
			return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
		}
		/**
		* Checks if the document includes a value with the key `key`.
		*/
		has(key) {
			return identity.isCollection(this.contents) ? this.contents.has(key) : false;
		}
		/**
		* Checks if the document includes a value at `path`.
		*/
		hasIn(path) {
			if (Collection.isEmptyPath(path)) return this.contents !== void 0;
			return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		set(key, value) {
			if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, [key], value);
			else if (assertCollection(this.contents)) this.contents.set(key, value);
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			if (Collection.isEmptyPath(path)) this.contents = value;
			else if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
			else if (assertCollection(this.contents)) this.contents.setIn(path, value);
		}
		/**
		* Change the YAML version and schema used by the document.
		* A `null` version disables support for directives, explicit tags, anchors, and aliases.
		* It also requires the `schema` option to be given as a `Schema` instance value.
		*
		* Overrides all previously set schema options.
		*/
		setSchema(version, options = {}) {
			if (typeof version === "number") version = String(version);
			let opt;
			switch (version) {
				case "1.1":
					if (this.directives) this.directives.yaml.version = "1.1";
					else this.directives = new directives.Directives({ version: "1.1" });
					opt = {
						resolveKnownTags: false,
						schema: "yaml-1.1"
					};
					break;
				case "1.2":
				case "next":
					if (this.directives) this.directives.yaml.version = version;
					else this.directives = new directives.Directives({ version });
					opt = {
						resolveKnownTags: true,
						schema: "core"
					};
					break;
				case null:
					if (this.directives) delete this.directives;
					opt = null;
					break;
				default: {
					const sv = JSON.stringify(version);
					throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
				}
			}
			if (options.schema instanceof Object) this.schema = options.schema;
			else if (opt) this.schema = new Schema.Schema(Object.assign(opt, options));
			else throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
		}
		toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc: this,
				keep: !json,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
		/**
		* A JSON representation of the document `contents`.
		*
		* @param jsonArg Used by `JSON.stringify` to indicate the array index or
		*   property name.
		*/
		toJSON(jsonArg, onAnchor) {
			return this.toJS({
				json: true,
				jsonArg,
				mapAsMap: false,
				onAnchor
			});
		}
		/** A YAML representation of the document. */
		toString(options = {}) {
			if (this.errors.length > 0) throw new Error("Document with errors cannot be stringified");
			if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
				const s = JSON.stringify(options.indent);
				throw new Error(`"indent" option must be a positive integer, not ${s}`);
			}
			return stringifyDocument.stringifyDocument(this, options);
		}
	};
	function assertCollection(contents) {
		if (identity.isCollection(contents)) return true;
		throw new Error("Expected a YAML collection as document contents");
	}
	exports.Document = Document;
}));

// node_modules/yaml/dist/errors.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLError = class extends Error {
		constructor(name, pos, code, message) {
			super();
			this.name = name;
			this.code = code;
			this.message = message;
			this.pos = pos;
		}
	};
	var YAMLParseError = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLParseError", pos, code, message);
		}
	};
	var YAMLWarning = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLWarning", pos, code, message);
		}
	};
	const prettifyError = (src, lc) => (error) => {
		if (error.pos[0] === -1) return;
		error.linePos = error.pos.map((pos) => lc.linePos(pos));
		const { line, col } = error.linePos[0];
		error.message += ` at line ${line}, column ${col}`;
		let ci = col - 1;
		let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
		if (ci >= 60 && lineStr.length > 80) {
			const trimStart = Math.min(ci - 39, lineStr.length - 79);
			lineStr = "…" + lineStr.substring(trimStart);
			ci -= trimStart - 1;
		}
		if (lineStr.length > 80) lineStr = lineStr.substring(0, 79) + "…";
		if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
			let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
			if (prev.length > 80) prev = prev.substring(0, 79) + "…\n";
			lineStr = prev + lineStr;
		}
		if (/[^ ]/.test(lineStr)) {
			let count = 1;
			const end = error.linePos[1];
			if (end?.line === line && end.col > col) count = Math.max(1, Math.min(end.col - col, 80 - ci));
			const pointer = " ".repeat(ci) + "^".repeat(count);
			error.message += `:\n\n${lineStr}\n${pointer}\n`;
		}
	};
	exports.YAMLError = YAMLError;
	exports.YAMLParseError = YAMLParseError;
	exports.YAMLWarning = YAMLWarning;
	exports.prettifyError = prettifyError;
}));

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
		let spaceBefore = false;
		let atNewline = startOnNewline;
		let hasSpace = startOnNewline;
		let comment = "";
		let commentSep = "";
		let hasNewline = false;
		let reqSpace = false;
		let tab = null;
		let anchor = null;
		let tag = null;
		let newlineAfterProp = null;
		let comma = null;
		let found = null;
		let start = null;
		for (const token of tokens) {
			if (reqSpace) {
				if (token.type !== "space" && token.type !== "newline" && token.type !== "comma") onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
				reqSpace = false;
			}
			if (tab) {
				if (atNewline && token.type !== "comment" && token.type !== "newline") onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
				tab = null;
			}
			switch (token.type) {
				case "space":
					if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) tab = token;
					hasSpace = true;
					break;
				case "comment": {
					if (!hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					const cb = token.source.substring(1) || " ";
					if (!comment) comment = cb;
					else comment += commentSep + cb;
					commentSep = "";
					atNewline = false;
					break;
				}
				case "newline":
					if (atNewline) {
						if (comment) comment += token.source;
						else if (!found || indicator !== "seq-item-ind") spaceBefore = true;
					} else commentSep += token.source;
					atNewline = true;
					hasNewline = true;
					if (anchor || tag) newlineAfterProp = token;
					hasSpace = true;
					break;
				case "anchor":
					if (anchor) onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
					if (token.source.endsWith(":")) onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
					anchor = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case "tag":
					if (tag) onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
					tag = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case indicator:
					if (anchor || tag) onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
					if (found) onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
					found = token;
					atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
					hasSpace = false;
					break;
				case "comma": if (flow) {
					if (comma) onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
					comma = token;
					atNewline = false;
					hasSpace = false;
					break;
				}
				default:
					onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
					atNewline = false;
					hasSpace = false;
			}
		}
		const last = tokens[tokens.length - 1];
		const end = last ? last.offset + last.source.length : offset;
		if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
		if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq")) onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
		return {
			comma,
			found,
			spaceBefore,
			comment,
			hasNewline,
			anchor,
			tag,
			newlineAfterProp,
			end,
			start: start ?? end
		};
	}
	exports.resolveProps = resolveProps;
}));

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = /* @__PURE__ */ __commonJSMin(((exports) => {
	function containsNewline(key) {
		if (!key) return null;
		switch (key.type) {
			case "alias":
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				if (key.source.includes("\n")) return true;
				if (key.end) {
					for (const st of key.end) if (st.type === "newline") return true;
				}
				return false;
			case "flow-collection":
				for (const it of key.items) {
					for (const st of it.start) if (st.type === "newline") return true;
					if (it.sep) {
						for (const st of it.sep) if (st.type === "newline") return true;
					}
					if (containsNewline(it.key) || containsNewline(it.value)) return true;
				}
				return false;
			default: return true;
		}
	}
	exports.containsNewline = containsNewline;
}));

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = /* @__PURE__ */ __commonJSMin(((exports) => {
	var utilContainsNewline = require_util_contains_newline();
	function flowIndentCheck(indent, fc, onError) {
		if (fc?.type === "flow-collection") {
			const end = fc.end[0];
			if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) onError(end, "BAD_INDENT", "Flow end indicator should be more indented than parent", true);
		}
	}
	exports.flowIndentCheck = flowIndentCheck;
}));

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	function mapIncludes(ctx, items, search) {
		const { uniqueKeys } = ctx.options;
		if (uniqueKeys === false) return false;
		const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
		return items.some((pair) => isEqual(pair.key, search));
	}
	exports.mapIncludes = mapIncludes;
}));

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	var utilMapIncludes = require_util_map_includes();
	const startColMsg = "All mapping items must start at the same column";
	function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
		const map = new ((tag?.nodeClass) ?? YAMLMap.YAMLMap)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		let offset = bm.offset;
		let commentEnd = null;
		for (const collItem of bm.items) {
			const { start, key, sep, value } = collItem;
			const keyProps = resolveProps.resolveProps(start, {
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: bm.indent,
				startOnNewline: true
			});
			const implicitKey = !keyProps.found;
			if (implicitKey) {
				if (key) {
					if (key.type === "block-seq") onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
					else if ("indent" in key && key.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
				}
				if (!keyProps.anchor && !keyProps.tag && !sep) {
					commentEnd = keyProps.end;
					if (keyProps.comment) {
						if (map.comment) map.comment += "\n" + keyProps.comment;
						else map.comment = keyProps.comment;
					}
					continue;
				}
				if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
			} else if (keyProps.found?.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
			ctx.atKey = true;
			const keyStart = keyProps.end;
			const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
			ctx.atKey = false;
			if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
			const valueProps = resolveProps.resolveProps(sep ?? [], {
				indicator: "map-value-ind",
				next: value,
				offset: keyNode.range[2],
				onError,
				parentIndent: bm.indent,
				startOnNewline: !key || key.type === "block-scalar"
			});
			offset = valueProps.end;
			if (valueProps.found) {
				if (implicitKey) {
					if (value?.type === "block-map" && !valueProps.hasNewline) onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
					if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024) onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
				if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
				offset = valueNode.range[2];
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			} else {
				if (implicitKey) onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
				if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			}
		}
		if (commentEnd && commentEnd < offset) onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
		map.range = [
			bm.offset,
			offset,
			commentEnd ?? offset
		];
		return map;
	}
	exports.resolveBlockMap = resolveBlockMap;
}));

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLSeq = require_YAMLSeq();
	var resolveProps = require_resolve_props();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
		const seq = new ((tag?.nodeClass) ?? YAMLSeq.YAMLSeq)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = bs.offset;
		let commentEnd = null;
		for (const { start, value } of bs.items) {
			const props = resolveProps.resolveProps(start, {
				indicator: "seq-item-ind",
				next: value,
				offset,
				onError,
				parentIndent: bs.indent,
				startOnNewline: true
			});
			if (!props.found) {
				if (props.anchor || props.tag || value) {
					if (value?.type === "block-seq") onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
					else onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
				} else {
					commentEnd = props.end;
					if (props.comment) seq.comment = props.comment;
					continue;
				}
			}
			const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
			offset = node.range[2];
			seq.items.push(node);
		}
		seq.range = [
			bs.offset,
			offset,
			commentEnd ?? offset
		];
		return seq;
	}
	exports.resolveBlockSeq = resolveBlockSeq;
}));

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveEnd(end, offset, reqSpace, onError) {
		let comment = "";
		if (end) {
			let hasSpace = false;
			let sep = "";
			for (const token of end) {
				const { source, type } = token;
				switch (type) {
					case "space":
						hasSpace = true;
						break;
					case "comment": {
						if (reqSpace && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
						const cb = source.substring(1) || " ";
						if (!comment) comment = cb;
						else comment += sep + cb;
						sep = "";
						break;
					}
					case "newline":
						if (comment) sep += source;
						hasSpace = true;
						break;
					default: onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
				}
				offset += source.length;
			}
		}
		return {
			comment,
			offset
		};
	}
	exports.resolveEnd = resolveEnd;
}));

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilMapIncludes = require_util_map_includes();
	const blockMsg = "Block collections are not allowed within flow collections";
	const isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
	function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
		const isMap = fc.start.source === "{";
		const fcName = isMap ? "flow map" : "flow sequence";
		const coll = new ((tag?.nodeClass) ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq))(ctx.schema);
		coll.flow = true;
		const atRoot = ctx.atRoot;
		if (atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = fc.offset + fc.start.source.length;
		for (let i = 0; i < fc.items.length; ++i) {
			const collItem = fc.items[i];
			const { start, key, sep, value } = collItem;
			const props = resolveProps.resolveProps(start, {
				flow: fcName,
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: fc.indent,
				startOnNewline: false
			});
			if (!props.found) {
				if (!props.anchor && !props.tag && !sep && !value) {
					if (i === 0 && props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
					else if (i < fc.items.length - 1) onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
					if (props.comment) {
						if (coll.comment) coll.comment += "\n" + props.comment;
						else coll.comment = props.comment;
					}
					offset = props.end;
					continue;
				}
				if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key)) onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
			}
			if (i === 0) {
				if (props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
			} else {
				if (!props.comma) onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
				if (props.comment) {
					let prevItemComment = "";
					loop: for (const st of start) switch (st.type) {
						case "comma":
						case "space": break;
						case "comment":
							prevItemComment = st.source.substring(1);
							break loop;
						default: break loop;
					}
					if (prevItemComment) {
						let prev = coll.items[coll.items.length - 1];
						if (identity.isPair(prev)) prev = prev.value ?? prev.key;
						if (prev.comment) prev.comment += "\n" + prevItemComment;
						else prev.comment = prevItemComment;
						props.comment = props.comment.substring(prevItemComment.length + 1);
					}
				}
			}
			if (!isMap && !sep && !props.found) {
				const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
				coll.items.push(valueNode);
				offset = valueNode.range[2];
				if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
			} else {
				ctx.atKey = true;
				const keyStart = props.end;
				const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
				if (isBlock(key)) onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
				ctx.atKey = false;
				const valueProps = resolveProps.resolveProps(sep ?? [], {
					flow: fcName,
					indicator: "map-value-ind",
					next: value,
					offset: keyNode.range[2],
					onError,
					parentIndent: fc.indent,
					startOnNewline: false
				});
				if (valueProps.found) {
					if (!isMap && !props.found && ctx.options.strict) {
						if (sep) for (const st of sep) {
							if (st === valueProps.found) break;
							if (st.type === "newline") {
								onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
								break;
							}
						}
						if (props.start < valueProps.found.offset - 1024) onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
					}
				} else if (value) {
					if ("source" in value && value.source?.[0] === ":") onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
					else onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
				if (valueNode) {
					if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
				} else if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				if (isMap) {
					const map = coll;
					if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
					map.items.push(pair);
				} else {
					const map = new YAMLMap.YAMLMap(ctx.schema);
					map.flow = true;
					map.items.push(pair);
					const endRange = (valueNode ?? keyNode).range;
					map.range = [
						keyNode.range[0],
						endRange[1],
						endRange[2]
					];
					coll.items.push(map);
				}
				offset = valueNode ? valueNode.range[2] : valueProps.end;
			}
		}
		const expectedEnd = isMap ? "}" : "]";
		const [ce, ...ee] = fc.end;
		let cePos = offset;
		if (ce?.source === expectedEnd) cePos = ce.offset + ce.source.length;
		else {
			const name = fcName[0].toUpperCase() + fcName.substring(1);
			const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
			onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
			if (ce && ce.source.length !== 1) ee.unshift(ce);
		}
		if (ee.length > 0) {
			const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
			if (end.comment) {
				if (coll.comment) coll.comment += "\n" + end.comment;
				else coll.comment = end.comment;
			}
			coll.range = [
				fc.offset,
				cePos,
				end.offset
			];
		} else coll.range = [
			fc.offset,
			cePos,
			cePos
		];
		return coll;
	}
	exports.resolveFlowCollection = resolveFlowCollection;
}));

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveBlockMap = require_resolve_block_map();
	var resolveBlockSeq = require_resolve_block_seq();
	var resolveFlowCollection = require_resolve_flow_collection();
	function resolveCollection(CN, ctx, token, onError, tagName, tag) {
		const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
		const Coll = coll.constructor;
		if (tagName === "!" || tagName === Coll.tagName) {
			coll.tag = Coll.tagName;
			return coll;
		}
		if (tagName) coll.tag = tagName;
		return coll;
	}
	function composeCollection(CN, ctx, token, props, onError) {
		const tagToken = props.tag;
		const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
		if (token.type === "block-seq") {
			const { anchor, newlineAfterProp: nl } = props;
			const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
			if (lastProp && (!nl || nl.offset < lastProp.offset)) onError(lastProp, "MISSING_CHAR", "Missing newline after block sequence props");
		}
		const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
		if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") return resolveCollection(CN, ctx, token, onError, tagName);
		let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
		if (!tag) {
			const kt = ctx.schema.knownTags[tagName];
			if (kt?.collection === expType) {
				ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
				tag = kt;
			} else {
				if (kt) onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
				else onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
				return resolveCollection(CN, ctx, token, onError, tagName);
			}
		}
		const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
		const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
		const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
		node.range = coll.range;
		node.tag = tagName;
		if (tag?.format) node.format = tag.format;
		return node;
	}
	exports.composeCollection = composeCollection;
}));

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function resolveBlockScalar(ctx, scalar, onError) {
		const start = scalar.offset;
		const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
		if (!header) return {
			value: "",
			type: null,
			comment: "",
			range: [
				start,
				start,
				start
			]
		};
		const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
		const lines = scalar.source ? splitLines(scalar.source) : [];
		let chompStart = lines.length;
		for (let i = lines.length - 1; i >= 0; --i) {
			const content = lines[i][1];
			if (content === "" || content === "\r") chompStart = i;
			else break;
		}
		if (chompStart === 0) {
			const value = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
			let end = start + header.length;
			if (scalar.source) end += scalar.source.length;
			return {
				value,
				type,
				comment: header.comment,
				range: [
					start,
					end,
					end
				]
			};
		}
		let trimIndent = scalar.indent + header.indent;
		let offset = scalar.offset + header.length;
		let contentStart = 0;
		for (let i = 0; i < chompStart; ++i) {
			const [indent, content] = lines[i];
			if (content === "" || content === "\r") {
				if (header.indent === 0 && indent.length > trimIndent) trimIndent = indent.length;
			} else {
				if (indent.length < trimIndent) onError(offset + indent.length, "MISSING_CHAR", "Block scalars with more-indented leading empty lines must use an explicit indentation indicator");
				if (header.indent === 0) trimIndent = indent.length;
				contentStart = i;
				if (trimIndent === 0 && !ctx.atRoot) onError(offset, "BAD_INDENT", "Block scalar values in collections must be indented");
				break;
			}
			offset += indent.length + content.length + 1;
		}
		for (let i = lines.length - 1; i >= chompStart; --i) if (lines[i][0].length > trimIndent) chompStart = i + 1;
		let value = "";
		let sep = "";
		let prevMoreIndented = false;
		for (let i = 0; i < contentStart; ++i) value += lines[i][0].slice(trimIndent) + "\n";
		for (let i = contentStart; i < chompStart; ++i) {
			let [indent, content] = lines[i];
			offset += indent.length + content.length + 1;
			const crlf = content[content.length - 1] === "\r";
			if (crlf) content = content.slice(0, -1);
			/* istanbul ignore if already caught in lexer */
			if (content && indent.length < trimIndent) {
				const message = `Block scalar lines must not be less indented than their ${header.indent ? "explicit indentation indicator" : "first line"}`;
				onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
				indent = "";
			}
			if (type === Scalar.Scalar.BLOCK_LITERAL) {
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
			} else if (indent.length > trimIndent || content[0] === "	") {
				if (sep === " ") sep = "\n";
				else if (!prevMoreIndented && sep === "\n") sep = "\n\n";
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
				prevMoreIndented = true;
			} else if (content === "") {
				if (sep === "\n") value += "\n";
				else sep = "\n";
			} else {
				value += sep + content;
				sep = " ";
				prevMoreIndented = false;
			}
		}
		switch (header.chomp) {
			case "-": break;
			case "+":
				for (let i = chompStart; i < lines.length; ++i) value += "\n" + lines[i][0].slice(trimIndent);
				if (value[value.length - 1] !== "\n") value += "\n";
				break;
			default: value += "\n";
		}
		const end = start + header.length + scalar.source.length;
		return {
			value,
			type,
			comment: header.comment,
			range: [
				start,
				end,
				end
			]
		};
	}
	function parseBlockScalarHeader({ offset, props }, strict, onError) {
		/* istanbul ignore if should not happen */
		if (props[0].type !== "block-scalar-header") {
			onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
			return null;
		}
		const { source } = props[0];
		const mode = source[0];
		let indent = 0;
		let chomp = "";
		let error = -1;
		for (let i = 1; i < source.length; ++i) {
			const ch = source[i];
			if (!chomp && (ch === "-" || ch === "+")) chomp = ch;
			else {
				const n = Number(ch);
				if (!indent && n) indent = n;
				else if (error === -1) error = offset + i;
			}
		}
		if (error !== -1) onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
		let hasSpace = false;
		let comment = "";
		let length = source.length;
		for (let i = 1; i < props.length; ++i) {
			const token = props[i];
			switch (token.type) {
				case "space": hasSpace = true;
				case "newline":
					length += token.source.length;
					break;
				case "comment":
					if (strict && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					length += token.source.length;
					comment = token.source.substring(1);
					break;
				case "error":
					onError(token, "UNEXPECTED_TOKEN", token.message);
					length += token.source.length;
					break;
				/* istanbul ignore next should not happen */
				default: {
					onError(token, "UNEXPECTED_TOKEN", `Unexpected token in block scalar header: ${token.type}`);
					const ts = token.source;
					if (ts && typeof ts === "string") length += ts.length;
				}
			}
		}
		return {
			mode,
			indent,
			chomp,
			comment,
			length
		};
	}
	/** @returns Array of lines split up as `[indent, content]` */
	function splitLines(source) {
		const split = source.split(/\n( *)/);
		const first = split[0];
		const m = first.match(/^( *)/);
		const lines = [m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first]];
		for (let i = 1; i < split.length; i += 2) lines.push([split[i], split[i + 1]]);
		return lines;
	}
	exports.resolveBlockScalar = resolveBlockScalar;
}));

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var resolveEnd = require_resolve_end();
	function resolveFlowScalar(scalar, strict, onError) {
		const { offset, type, source, end } = scalar;
		let _type;
		let value;
		const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
		switch (type) {
			case "scalar":
				_type = Scalar.Scalar.PLAIN;
				value = plainValue(source, _onError);
				break;
			case "single-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_SINGLE;
				value = singleQuotedValue(source, _onError);
				break;
			case "double-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_DOUBLE;
				value = doubleQuotedValue(source, _onError);
				break;
			/* istanbul ignore next should not happen */
			default:
				onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
				return {
					value: "",
					type: null,
					comment: "",
					range: [
						offset,
						offset + source.length,
						offset + source.length
					]
				};
		}
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
		return {
			value,
			type: _type,
			comment: re.comment,
			range: [
				offset,
				valueEnd,
				re.offset
			]
		};
	}
	function plainValue(source, onError) {
		let badChar = "";
		switch (source[0]) {
			/* istanbul ignore next should not happen */
			case "	":
				badChar = "a tab character";
				break;
			case ",":
				badChar = "flow indicator character ,";
				break;
			case "%":
				badChar = "directive indicator character %";
				break;
			case "|":
			case ">":
				badChar = `block scalar indicator ${source[0]}`;
				break;
			case "@":
			case "`": badChar = `reserved character ${source[0]}`;
		}
		if (badChar) onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
		return unfoldLines(source);
	}
	function singleQuotedValue(source, onError) {
		if (source[source.length - 1] !== "'" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
		return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
	}
	function unfoldLines(source) {
		const line = /(.*?)\r?\n/sy;
		let match = line.exec(source);
		if (!match) return source;
		/**
		* The negative lookbehinds in these RegExps are to
		* prevent causing a polynomial search time in certain cases.
		*
		* The try-catch is for Safari < 16.4 and other old browsers:
		* https://caniuse.com/js-regexp-lookbehind
		*/
		let trimEnd, trimBoth;
		try {
			trimEnd = /* @__PURE__ */ new RegExp("(?<![ 	])[ 	]+$");
			trimBoth = /* @__PURE__ */ new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
		} catch {
			trimEnd = /[ \t]+$/;
			trimBoth = /^[ \t]+|[ \t]+$/g;
		}
		let res = match[1].replace(trimEnd, "");
		let sep = " ";
		let pos = line.lastIndex;
		while (match = line.exec(source)) {
			const lm = match[1].replace(trimBoth, "");
			if (lm === "") {
				if (sep === "\n") res += sep;
				else sep = "\n";
			} else {
				res += sep + lm;
				sep = " ";
			}
			pos = line.lastIndex;
		}
		const last = /[ \t]*(.*)/sy;
		last.lastIndex = pos;
		match = last.exec(source);
		return res + sep + (match?.[1] ?? "");
	}
	function doubleQuotedValue(source, onError) {
		let res = "";
		for (let i = 1; i < source.length - 1; ++i) {
			const ch = source[i];
			if (ch === "\r" && source[i + 1] === "\n") continue;
			if (ch === "\n") {
				const { fold, offset } = foldNewline(source, i);
				res += fold;
				i = offset;
			} else if (ch === "\\") {
				let next = source[++i];
				const cc = escapeCodes[next];
				if (cc) res += cc;
				else if (next === "\n") {
					next = source[i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "\r" && source[i + 1] === "\n") {
					next = source[++i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "x" || next === "u" || next === "U") {
					const length = next === "x" ? 2 : next === "u" ? 4 : 8;
					res += parseCharCode(source, i + 1, length, onError);
					i += length;
				} else {
					const raw = source.substr(i - 1, 2);
					onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
					res += raw;
				}
			} else if (ch === " " || ch === "	") {
				const wsStart = i;
				let next = source[i + 1];
				while (next === " " || next === "	") next = source[++i + 1];
				if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n")) res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
			} else res += ch;
		}
		if (source[source.length - 1] !== "\"" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing \"quote");
		return res;
	}
	/**
	* Fold a single newline into a space, multiple newlines to N - 1 newlines.
	* Presumes `source[offset] === '\n'`
	*/
	function foldNewline(source, offset) {
		let fold = "";
		let ch = source[offset + 1];
		while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
			if (ch === "\r" && source[offset + 2] !== "\n") break;
			if (ch === "\n") fold += "\n";
			offset += 1;
			ch = source[offset + 1];
		}
		if (!fold) fold = " ";
		return {
			fold,
			offset
		};
	}
	const escapeCodes = {
		"0": "\0",
		a: "\x07",
		b: "\b",
		e: "\x1B",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "	",
		v: "\v",
		N: "",
		_: "\xA0",
		L: "\u2028",
		P: "\u2029",
		" ": " ",
		"\"": "\"",
		"/": "/",
		"\\": "\\",
		"	": "	"
	};
	function parseCharCode(source, offset, length, onError) {
		const cc = source.substr(offset, length);
		const code = cc.length === length && /^[0-9a-fA-F]+$/.test(cc) ? parseInt(cc, 16) : NaN;
		try {
			return String.fromCodePoint(code);
		} catch {
			const raw = source.substr(offset - 2, length + 2);
			onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
			return raw;
		}
	}
	exports.resolveFlowScalar = resolveFlowScalar;
}));

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	function composeScalar(ctx, token, tagToken, onError) {
		const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
		const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
		let tag;
		if (ctx.options.stringKeys && ctx.atKey) tag = ctx.schema[identity.SCALAR];
		else if (tagName) tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
		else if (token.type === "scalar") tag = findScalarTagByTest(ctx, value, token, onError);
		else tag = ctx.schema[identity.SCALAR];
		let scalar;
		try {
			const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
			scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
			scalar = new Scalar.Scalar(value);
		}
		scalar.range = range;
		scalar.source = value;
		if (type) scalar.type = type;
		if (tagName) scalar.tag = tagName;
		if (tag.format) scalar.format = tag.format;
		if (comment) scalar.comment = comment;
		return scalar;
	}
	function findScalarTagByName(schema, value, tagName, tagToken, onError) {
		if (tagName === "!") return schema[identity.SCALAR];
		const matchWithTest = [];
		for (const tag of schema.tags) if (!tag.collection && tag.tag === tagName) {
			if (tag.default && tag.test) matchWithTest.push(tag);
			else return tag;
		}
		for (const tag of matchWithTest) if (tag.test?.test(value)) return tag;
		const kt = schema.knownTags[tagName];
		if (kt && !kt.collection) {
			schema.tags.push(Object.assign({}, kt, {
				default: false,
				test: void 0
			}));
			return kt;
		}
		onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
		return schema[identity.SCALAR];
	}
	function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
		const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[identity.SCALAR];
		if (schema.compat) {
			const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[identity.SCALAR];
			if (tag.tag !== compat.tag) onError(token, "TAG_RESOLVE_FAILED", `Value may be parsed as either ${directives.tagString(tag.tag)} or ${directives.tagString(compat.tag)}`, true);
		}
		return tag;
	}
	exports.composeScalar = composeScalar;
}));

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = /* @__PURE__ */ __commonJSMin(((exports) => {
	function emptyScalarPosition(offset, before, pos) {
		if (before) {
			pos ?? (pos = before.length);
			for (let i = pos - 1; i >= 0; --i) {
				let st = before[i];
				switch (st.type) {
					case "space":
					case "comment":
					case "newline":
						offset -= st.source.length;
						continue;
				}
				st = before[++i];
				while (st?.type === "space") {
					offset += st.source.length;
					st = before[++i];
				}
				break;
			}
		}
		return offset;
	}
	exports.emptyScalarPosition = emptyScalarPosition;
}));

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var composeCollection = require_compose_collection();
	var composeScalar = require_compose_scalar();
	var resolveEnd = require_resolve_end();
	var utilEmptyScalarPosition = require_util_empty_scalar_position();
	const CN = {
		composeNode,
		composeEmptyNode
	};
	function composeNode(ctx, token, props, onError) {
		const atKey = ctx.atKey;
		const { spaceBefore, comment, anchor, tag } = props;
		let node;
		let isSrcToken = true;
		switch (token.type) {
			case "alias":
				node = composeAlias(ctx, token, onError);
				if (anchor || tag) onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
				break;
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "block-scalar":
				node = composeScalar.composeScalar(ctx, token, tag, onError);
				if (anchor) node.anchor = anchor.source.substring(1);
				break;
			case "block-map":
			case "block-seq":
			case "flow-collection":
				try {
					node = composeCollection.composeCollection(CN, ctx, token, props, onError);
					if (anchor) node.anchor = anchor.source.substring(1);
				} catch (error) {
					onError(token, "RESOURCE_EXHAUSTION", error instanceof Error ? error.message : String(error));
				}
				break;
			default:
				onError(token, "UNEXPECTED_TOKEN", token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`);
				isSrcToken = false;
		}
		node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
		if (anchor && node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) onError(tag ?? token, "NON_STRING_KEY", "With stringKeys, all keys must be strings");
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			if (token.type === "scalar" && token.source === "") node.comment = comment;
			else node.commentBefore = comment;
		}
		if (ctx.options.keepSourceTokens && isSrcToken) node.srcToken = token;
		return node;
	}
	function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
		const token = {
			type: "scalar",
			offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
			indent: -1,
			source: ""
		};
		const node = composeScalar.composeScalar(ctx, token, tag, onError);
		if (anchor) {
			node.anchor = anchor.source.substring(1);
			if (node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		}
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			node.comment = comment;
			node.range[2] = end;
		}
		return node;
	}
	function composeAlias({ options }, { offset, source, end }, onError) {
		const alias = new Alias.Alias(source.substring(1));
		if (alias.source === "") onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
		if (alias.source.endsWith(":")) onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
		alias.range = [
			offset,
			valueEnd,
			re.offset
		];
		if (re.comment) alias.comment = re.comment;
		return alias;
	}
	exports.composeEmptyNode = composeEmptyNode;
	exports.composeNode = composeNode;
}));

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Document = require_Document();
	var composeNode = require_compose_node();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	function composeDoc(options, directives, { offset, start, value, end }, onError) {
		const opts = Object.assign({ _directives: directives }, options);
		const doc = new Document.Document(void 0, opts);
		const ctx = {
			atKey: false,
			atRoot: true,
			directives: doc.directives,
			options: doc.options,
			schema: doc.schema
		};
		const props = resolveProps.resolveProps(start, {
			indicator: "doc-start",
			next: value ?? end?.[0],
			offset,
			onError,
			parentIndent: 0,
			startOnNewline: true
		});
		if (props.found) {
			doc.directives.docStart = true;
			if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline) onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
		}
		doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
		const contentEnd = doc.contents.range[2];
		const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
		if (re.comment) doc.comment = re.comment;
		doc.range = [
			offset,
			contentEnd,
			re.offset
		];
		return doc;
	}
	exports.composeDoc = composeDoc;
}));

// node_modules/yaml/dist/compose/composer.js
var require_composer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	var directives = require_directives();
	var Document = require_Document();
	var errors = require_errors();
	var identity = require_identity();
	var composeDoc = require_compose_doc();
	var resolveEnd = require_resolve_end();
	function getErrorPos(src) {
		if (typeof src === "number") return [src, src + 1];
		if (Array.isArray(src)) return src.length === 2 ? src : [src[0], src[1]];
		const { offset, source } = src;
		return [offset, offset + (typeof source === "string" ? source.length : 1)];
	}
	function parsePrelude(prelude) {
		let comment = "";
		let atComment = false;
		let afterEmptyLine = false;
		for (let i = 0; i < prelude.length; ++i) {
			const source = prelude[i];
			switch (source[0]) {
				case "#":
					comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
					atComment = true;
					afterEmptyLine = false;
					break;
				case "%":
					if (prelude[i + 1]?.[0] !== "#") i += 1;
					atComment = false;
					break;
				default:
					if (!atComment) afterEmptyLine = true;
					atComment = false;
			}
		}
		return {
			comment,
			afterEmptyLine
		};
	}
	/**
	* Compose a stream of CST nodes into a stream of YAML Documents.
	*
	* ```ts
	* import { Composer, Parser } from 'yaml'
	*
	* const src: string = ...
	* const tokens = new Parser().parse(src)
	* const docs = new Composer().compose(tokens)
	* ```
	*/
	var Composer = class {
		constructor(options = {}) {
			this.doc = null;
			this.atDirectives = false;
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
			this.onError = (source, code, message, warning) => {
				const pos = getErrorPos(source);
				if (warning) this.warnings.push(new errors.YAMLWarning(pos, code, message));
				else this.errors.push(new errors.YAMLParseError(pos, code, message));
			};
			this.directives = new directives.Directives({ version: options.version || "1.2" });
			this.options = options;
		}
		decorate(doc, afterDoc) {
			const { comment, afterEmptyLine } = parsePrelude(this.prelude);
			if (comment) {
				const dc = doc.contents;
				if (afterDoc) doc.comment = doc.comment ? `${doc.comment}\n${comment}` : comment;
				else if (afterEmptyLine || doc.directives.docStart || !dc) doc.commentBefore = comment;
				else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
					let it = dc.items[0];
					if (identity.isPair(it)) it = it.key;
					const cb = it.commentBefore;
					it.commentBefore = cb ? `${comment}\n${cb}` : comment;
				} else {
					const cb = dc.commentBefore;
					dc.commentBefore = cb ? `${comment}\n${cb}` : comment;
				}
			}
			if (afterDoc) {
				for (let i = 0; i < this.errors.length; ++i) doc.errors.push(this.errors[i]);
				for (let i = 0; i < this.warnings.length; ++i) doc.warnings.push(this.warnings[i]);
			} else {
				doc.errors = this.errors;
				doc.warnings = this.warnings;
			}
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
		}
		/**
		* Current stream status information.
		*
		* Mostly useful at the end of input for an empty stream.
		*/
		streamInfo() {
			return {
				comment: parsePrelude(this.prelude).comment,
				directives: this.directives,
				errors: this.errors,
				warnings: this.warnings
			};
		}
		/**
		* Compose tokens into documents.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*compose(tokens, forceDoc = false, endOffset = -1) {
			for (const token of tokens) yield* this.next(token);
			yield* this.end(forceDoc, endOffset);
		}
		/** Advance the composer by one CST token. */
		*next(token) {
			if (node_process.env.LOG_STREAM) console.dir(token, { depth: null });
			switch (token.type) {
				case "directive":
					this.directives.add(token.source, (offset, message, warning) => {
						const pos = getErrorPos(token);
						pos[0] += offset;
						this.onError(pos, "BAD_DIRECTIVE", message, warning);
					});
					this.prelude.push(token.source);
					this.atDirectives = true;
					break;
				case "document": {
					const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
					if (this.atDirectives && !doc.directives.docStart) this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
					this.decorate(doc, false);
					if (this.doc) yield this.doc;
					this.doc = doc;
					this.atDirectives = false;
					break;
				}
				case "byte-order-mark":
				case "space": break;
				case "comment":
				case "newline":
					this.prelude.push(token.source);
					break;
				case "error": {
					const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
					const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
					if (this.atDirectives || !this.doc) this.errors.push(error);
					else this.doc.errors.push(error);
					break;
				}
				case "doc-end": {
					if (!this.doc) {
						this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", "Unexpected doc-end without preceding document"));
						break;
					}
					this.doc.directives.docEnd = true;
					const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
					this.decorate(this.doc, true);
					if (end.comment) {
						const dc = this.doc.comment;
						this.doc.comment = dc ? `${dc}\n${end.comment}` : end.comment;
					}
					this.doc.range[2] = end.offset;
					break;
				}
				default: this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
			}
		}
		/**
		* Call at end of input to yield any remaining document.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*end(forceDoc = false, endOffset = -1) {
			if (this.doc) {
				this.decorate(this.doc, true);
				yield this.doc;
				this.doc = null;
			} else if (forceDoc) {
				const opts = Object.assign({ _directives: this.directives }, this.options);
				const doc = new Document.Document(void 0, opts);
				if (this.atDirectives) this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
				doc.range = [
					0,
					endOffset,
					endOffset
				];
				this.decorate(doc, false);
				yield doc;
			}
		}
	};
	exports.Composer = Composer;
}));

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	var errors = require_errors();
	var stringifyString = require_stringifyString();
	function resolveAsScalar(token, strict = true, onError) {
		if (token) {
			const _onError = (pos, code, message) => {
				const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
				if (onError) onError(offset, code, message);
				else throw new errors.YAMLParseError([offset, offset + 1], code, message);
			};
			switch (token.type) {
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
				case "block-scalar": return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
			}
		}
		return null;
	}
	/**
	* Create a new scalar token with `value`
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.end Comments and whitespace after the end of the value, or after the block scalar header. If undefined, a newline will be added.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.indent The indent level of the token.
	* @param context.inFlow Is this scalar within a flow collection? This may affect the resolved type of the token's value.
	* @param context.offset The offset position of the token.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function createScalarToken(value, context) {
		const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey,
			indent: indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		const end = context.end ?? [{
			type: "newline",
			offset: -1,
			indent,
			source: "\n"
		}];
		switch (source[0]) {
			case "|":
			case ">": {
				const he = source.indexOf("\n");
				const head = source.substring(0, he);
				const body = source.substring(he + 1) + "\n";
				const props = [{
					type: "block-scalar-header",
					offset,
					indent,
					source: head
				}];
				if (!addEndtoBlockProps(props, end)) props.push({
					type: "newline",
					offset: -1,
					indent,
					source: "\n"
				});
				return {
					type: "block-scalar",
					offset,
					indent,
					props,
					source: body
				};
			}
			case "\"": return {
				type: "double-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			case "'": return {
				type: "single-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			default: return {
				type: "scalar",
				offset,
				indent,
				source,
				end
			};
		}
	}
	/**
	* Set the value of `token` to the given string `value`, overwriting any previous contents and type that it may have.
	*
	* Best efforts are made to retain any comments previously associated with the `token`,
	* though all contents within a collection's `items` will be overwritten.
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param token Any token. If it does not include an `indent` value, the value will be stringified as if it were an implicit key.
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.afterKey In most cases, values after a key should have an additional level of indentation.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.inFlow Being within a flow collection may affect the resolved type of the token's value.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function setScalarValue(token, value, context = {}) {
		let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
		let indent = "indent" in token ? token.indent : null;
		if (afterKey && typeof indent === "number") indent += 2;
		if (!type) switch (token.type) {
			case "single-quoted-scalar":
				type = "QUOTE_SINGLE";
				break;
			case "double-quoted-scalar":
				type = "QUOTE_DOUBLE";
				break;
			case "block-scalar": {
				const header = token.props[0];
				if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
				type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
				break;
			}
			default: type = "PLAIN";
		}
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey: implicitKey || indent === null,
			indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		switch (source[0]) {
			case "|":
			case ">":
				setBlockScalarValue(token, source);
				break;
			case "\"":
				setFlowScalarValue(token, source, "double-quoted-scalar");
				break;
			case "'":
				setFlowScalarValue(token, source, "single-quoted-scalar");
				break;
			default: setFlowScalarValue(token, source, "scalar");
		}
	}
	function setBlockScalarValue(token, source) {
		const he = source.indexOf("\n");
		const head = source.substring(0, he);
		const body = source.substring(he + 1) + "\n";
		if (token.type === "block-scalar") {
			const header = token.props[0];
			if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
			header.source = head;
			token.source = body;
		} else {
			const { offset } = token;
			const indent = "indent" in token ? token.indent : -1;
			const props = [{
				type: "block-scalar-header",
				offset,
				indent,
				source: head
			}];
			if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0)) props.push({
				type: "newline",
				offset: -1,
				indent,
				source: "\n"
			});
			for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
			Object.assign(token, {
				type: "block-scalar",
				indent,
				props,
				source: body
			});
		}
	}
	/** @returns `true` if last token is a newline */
	function addEndtoBlockProps(props, end) {
		if (end) for (const st of end) switch (st.type) {
			case "space":
			case "comment":
				props.push(st);
				break;
			case "newline":
				props.push(st);
				return true;
		}
		return false;
	}
	function setFlowScalarValue(token, source, type) {
		switch (token.type) {
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				token.type = type;
				token.source = source;
				break;
			case "block-scalar": {
				const end = token.props.slice(1);
				let oa = source.length;
				if (token.props[0].type === "block-scalar-header") oa -= token.props[0].source.length;
				for (const tok of end) tok.offset += oa;
				delete token.props;
				Object.assign(token, {
					type,
					source,
					end
				});
				break;
			}
			case "block-map":
			case "block-seq": {
				const nl = {
					type: "newline",
					offset: token.offset + source.length,
					indent: token.indent,
					source: "\n"
				};
				delete token.items;
				Object.assign(token, {
					type,
					source,
					end: [nl]
				});
				break;
			}
			default: {
				const indent = "indent" in token ? token.indent : -1;
				const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
				for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
				Object.assign(token, {
					type,
					indent,
					source,
					end
				});
			}
		}
	}
	exports.createScalarToken = createScalarToken;
	exports.resolveAsScalar = resolveAsScalar;
	exports.setScalarValue = setScalarValue;
}));

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringify a CST document, token, or collection item
	*
	* Fair warning: This applies no validation whatsoever, and
	* simply concatenates the sources in their logical order.
	*/
	const stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
	function stringifyToken(token) {
		switch (token.type) {
			case "block-scalar": {
				let res = "";
				for (const tok of token.props) res += stringifyToken(tok);
				return res + token.source;
			}
			case "block-map":
			case "block-seq": {
				let res = "";
				for (const item of token.items) res += stringifyItem(item);
				return res;
			}
			case "flow-collection": {
				let res = token.start.source;
				for (const item of token.items) res += stringifyItem(item);
				for (const st of token.end) res += st.source;
				return res;
			}
			case "document": {
				let res = stringifyItem(token);
				if (token.end) for (const st of token.end) res += st.source;
				return res;
			}
			default: {
				let res = token.source;
				if ("end" in token && token.end) for (const st of token.end) res += st.source;
				return res;
			}
		}
	}
	function stringifyItem({ start, key, sep, value }) {
		let res = "";
		for (const st of start) res += st.source;
		if (key) res += stringifyToken(key);
		if (sep) for (const st of sep) res += st.source;
		if (value) res += stringifyToken(value);
		return res;
	}
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove item");
	/**
	* Apply a visitor to a CST document or item.
	*
	* Walks through the tree (depth-first) starting from the root, calling a
	* `visitor` function with two arguments when entering each item:
	*   - `item`: The current item, which included the following members:
	*     - `start: SourceToken[]` – Source tokens before the key or value,
	*       possibly including its anchor or tag.
	*     - `key?: Token | null` – Set for pair values. May then be `null`, if
	*       the key before the `:` separator is empty.
	*     - `sep?: SourceToken[]` – Source tokens between the key and the value,
	*       which should include the `:` map value indicator if `value` is set.
	*     - `value?: Token` – The value of a sequence item, or of a map pair.
	*   - `path`: The steps from the root to the current node, as an array of
	*     `['key' | 'value', number]` tuples.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this token, continue with
	*      next sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current item, then continue with the next one
	*   - `number`: Set the index of the next step. This is useful especially if
	*     the index of the current token has changed.
	*   - `function`: Define the next visitor for this item. After the original
	*     visitor is called on item entry, next visitors are called after handling
	*     a non-empty `key` and when exiting the item.
	*/
	function visit(cst, visitor) {
		if ("type" in cst && cst.type === "document") cst = {
			start: cst.start,
			value: cst.value
		};
		_visit(Object.freeze([]), cst, visitor);
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current item */
	visit.SKIP = SKIP;
	/** Remove the current item */
	visit.REMOVE = REMOVE;
	/** Find the item at `path` from `cst` as the root */
	visit.itemAtPath = (cst, path) => {
		let item = cst;
		for (const [field, index] of path) {
			const tok = item?.[field];
			if (tok && "items" in tok) item = tok.items[index];
			else return void 0;
		}
		return item;
	};
	/**
	* Get the immediate parent collection of the item at `path` from `cst` as the root.
	*
	* Throws an error if the collection is not found, which should never happen if the item itself exists.
	*/
	visit.parentCollection = (cst, path) => {
		const parent = visit.itemAtPath(cst, path.slice(0, -1));
		const field = path[path.length - 1][0];
		const coll = parent?.[field];
		if (coll && "items" in coll) return coll;
		throw new Error("Parent collection not found");
	};
	function _visit(path, item, visitor) {
		let ctrl = visitor(item, path);
		if (typeof ctrl === "symbol") return ctrl;
		for (const field of ["key", "value"]) {
			const token = item[field];
			if (token && "items" in token) {
				for (let i = 0; i < token.items.length; ++i) {
					const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						token.items.splice(i, 1);
						i -= 1;
					}
				}
				if (typeof ctrl === "function" && field === "key") ctrl = ctrl(item, path);
			}
		}
		return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
	}
	exports.visit = visit;
}));

// node_modules/yaml/dist/parse/cst.js
var require_cst = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cstScalar = require_cst_scalar();
	var cstStringify = require_cst_stringify();
	var cstVisit = require_cst_visit();
	/** The byte order mark */
	const BOM = "﻿";
	/** Start of doc-mode */
	const DOCUMENT = "";
	/** Unexpected end of flow-mode */
	const FLOW_END = "";
	/** Next token is a scalar value */
	const SCALAR = "";
	/** @returns `true` if `token` is a flow or block collection */
	const isCollection = (token) => !!token && "items" in token;
	/** @returns `true` if `token` is a flow or block scalar; not an alias */
	const isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
	/* istanbul ignore next */
	/** Get a printable representation of a lexer token */
	function prettyToken(token) {
		switch (token) {
			case BOM: return "<BOM>";
			case DOCUMENT: return "<DOC>";
			case FLOW_END: return "<FLOW_END>";
			case SCALAR: return "<SCALAR>";
			default: return JSON.stringify(token);
		}
	}
	/** Identify the type of a lexer token. May return `null` for unknown tokens. */
	function tokenType(source) {
		switch (source) {
			case BOM: return "byte-order-mark";
			case DOCUMENT: return "doc-mode";
			case FLOW_END: return "flow-error-end";
			case SCALAR: return "scalar";
			case "---": return "doc-start";
			case "...": return "doc-end";
			case "":
			case "\n":
			case "\r\n": return "newline";
			case "-": return "seq-item-ind";
			case "?": return "explicit-key-ind";
			case ":": return "map-value-ind";
			case "{": return "flow-map-start";
			case "}": return "flow-map-end";
			case "[": return "flow-seq-start";
			case "]": return "flow-seq-end";
			case ",": return "comma";
		}
		switch (source[0]) {
			case " ":
			case "	": return "space";
			case "#": return "comment";
			case "%": return "directive-line";
			case "*": return "alias";
			case "&": return "anchor";
			case "!": return "tag";
			case "'": return "single-quoted-scalar";
			case "\"": return "double-quoted-scalar";
			case "|":
			case ">": return "block-scalar-header";
		}
		return null;
	}
	exports.createScalarToken = cstScalar.createScalarToken;
	exports.resolveAsScalar = cstScalar.resolveAsScalar;
	exports.setScalarValue = cstScalar.setScalarValue;
	exports.stringify = cstStringify.stringify;
	exports.visit = cstVisit.visit;
	exports.BOM = BOM;
	exports.DOCUMENT = DOCUMENT;
	exports.FLOW_END = FLOW_END;
	exports.SCALAR = SCALAR;
	exports.isCollection = isCollection;
	exports.isScalar = isScalar;
	exports.prettyToken = prettyToken;
	exports.tokenType = tokenType;
}));

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cst = require_cst();
	function isEmpty(ch) {
		switch (ch) {
			case void 0:
			case " ":
			case "\n":
			case "\r":
			case "	": return true;
			default: return false;
		}
	}
	const hexDigits = /* @__PURE__ */ new Set("0123456789ABCDEFabcdef");
	const tagChars = /* @__PURE__ */ new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
	const flowIndicatorChars = /* @__PURE__ */ new Set(",[]{}");
	const invalidAnchorChars = /* @__PURE__ */ new Set(" ,[]{}\n\r	");
	const isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
	/**
	* Splits an input string into lexical tokens, i.e. smaller strings that are
	* easily identifiable by `tokens.tokenType()`.
	*
	* Lexing starts always in a "stream" context. Incomplete input may be buffered
	* until a complete token can be emitted.
	*
	* In addition to slices of the original input, the following control characters
	* may also be emitted:
	*
	* - `\x02` (Start of Text): A document starts with the next token
	* - `\x18` (Cancel): Unexpected end of flow-mode (indicates an error)
	* - `\x1f` (Unit Separator): Next token is a scalar value
	* - `\u{FEFF}` (Byte order mark): Emitted separately outside documents
	*/
	var Lexer = class {
		constructor() {
			/**
			* Flag indicating whether the end of the current buffer marks the end of
			* all input
			*/
			this.atEnd = false;
			/**
			* Explicit indent set in block scalar header, as an offset from the current
			* minimum indent, so e.g. set to 1 from a header `|2+`. Set to -1 if not
			* explicitly set.
			*/
			this.blockScalarIndent = -1;
			/**
			* Block scalars that include a + (keep) chomping indicator in their header
			* include trailing empty lines, which are otherwise excluded from the
			* scalar's contents.
			*/
			this.blockScalarKeep = false;
			/** Current input */
			this.buffer = "";
			/**
			* Flag noting whether the map value indicator : can immediately follow this
			* node within a flow context.
			*/
			this.flowKey = false;
			/** Count of surrounding flow collection levels. */
			this.flowLevel = 0;
			/**
			* Minimum level of indentation required for next lines to be parsed as a
			* part of the current scalar value.
			*/
			this.indentNext = 0;
			/** Indentation level of the current line. */
			this.indentValue = 0;
			/** Position of the next \n character. */
			this.lineEndPos = null;
			/** Stores the state of the lexer if reaching the end of incpomplete input */
			this.next = null;
			/** A pointer to `buffer`; the current position of the lexer. */
			this.pos = 0;
		}
		/**
		* Generate YAML tokens from the `source` string. If `incomplete`,
		* a part of the last line may be left as a buffer for the next call.
		*
		* @returns A generator of lexical tokens
		*/
		*lex(source, incomplete = false) {
			if (source) {
				if (typeof source !== "string") throw TypeError("source is not a string");
				this.buffer = this.buffer ? this.buffer + source : source;
				this.lineEndPos = null;
			}
			this.atEnd = !incomplete;
			let next = this.next ?? "stream";
			while (next && (incomplete || this.hasChars(1))) next = yield* this.parseNext(next);
		}
		atLineEnd() {
			let i = this.pos;
			let ch = this.buffer[i];
			while (ch === " " || ch === "	") ch = this.buffer[++i];
			if (!ch || ch === "#" || ch === "\n") return true;
			if (ch === "\r") return this.buffer[i + 1] === "\n";
			return false;
		}
		charAt(n) {
			return this.buffer[this.pos + n];
		}
		continueScalar(offset) {
			let ch = this.buffer[offset];
			if (this.indentNext > 0) {
				let indent = 0;
				while (ch === " ") ch = this.buffer[++indent + offset];
				if (ch === "\r") {
					const next = this.buffer[indent + offset + 1];
					if (next === "\n" || !next && !this.atEnd) return offset + indent + 1;
				}
				return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
			}
			if (ch === "-" || ch === ".") {
				const dt = this.buffer.substr(offset, 3);
				if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3])) return -1;
			}
			return offset;
		}
		getLine() {
			let end = this.lineEndPos;
			if (typeof end !== "number" || end !== -1 && end < this.pos) {
				end = this.buffer.indexOf("\n", this.pos);
				this.lineEndPos = end;
			}
			if (end === -1) return this.atEnd ? this.buffer.substring(this.pos) : null;
			if (this.buffer[end - 1] === "\r") end -= 1;
			return this.buffer.substring(this.pos, end);
		}
		hasChars(n) {
			return this.pos + n <= this.buffer.length;
		}
		setNext(state) {
			this.buffer = this.buffer.substring(this.pos);
			this.pos = 0;
			this.lineEndPos = null;
			this.next = state;
			return null;
		}
		peek(n) {
			return this.buffer.substr(this.pos, n);
		}
		*parseNext(next) {
			switch (next) {
				case "stream": return yield* this.parseStream();
				case "line-start": return yield* this.parseLineStart();
				case "block-start": return yield* this.parseBlockStart();
				case "doc": return yield* this.parseDocument();
				case "flow": return yield* this.parseFlowCollection();
				case "quoted-scalar": return yield* this.parseQuotedScalar();
				case "block-scalar": return yield* this.parseBlockScalar();
				case "plain-scalar": return yield* this.parsePlainScalar();
			}
		}
		*parseStream() {
			let line = this.getLine();
			if (line === null) return this.setNext("stream");
			if (line[0] === cst.BOM) {
				yield* this.pushCount(1);
				line = line.substring(1);
			}
			if (line[0] === "%") {
				let dirEnd = line.length;
				let cs = line.indexOf("#");
				while (cs !== -1) {
					const ch = line[cs - 1];
					if (ch === " " || ch === "	") {
						dirEnd = cs - 1;
						break;
					} else cs = line.indexOf("#", cs + 1);
				}
				while (true) {
					const ch = line[dirEnd - 1];
					if (ch === " " || ch === "	") dirEnd -= 1;
					else break;
				}
				const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
				yield* this.pushCount(line.length - n);
				this.pushNewline();
				return "stream";
			}
			if (this.atLineEnd()) {
				const sp = yield* this.pushSpaces(true);
				yield* this.pushCount(line.length - sp);
				yield* this.pushNewline();
				return "stream";
			}
			yield cst.DOCUMENT;
			return yield* this.parseLineStart();
		}
		*parseLineStart() {
			const ch = this.charAt(0);
			if (!ch && !this.atEnd) return this.setNext("line-start");
			if (ch === "-" || ch === ".") {
				if (!this.atEnd && !this.hasChars(4)) return this.setNext("line-start");
				const s = this.peek(3);
				if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
					yield* this.pushCount(3);
					this.indentValue = 0;
					this.indentNext = 0;
					return s === "---" ? "doc" : "stream";
				}
			}
			this.indentValue = yield* this.pushSpaces(false);
			if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1))) this.indentNext = this.indentValue;
			return yield* this.parseBlockStart();
		}
		*parseBlockStart() {
			const [ch0, ch1] = this.peek(2);
			if (!ch1 && !this.atEnd) return this.setNext("block-start");
			if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
				const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
				this.indentNext = this.indentValue + 1;
				this.indentValue += n;
				return "block-start";
			}
			return "doc";
		}
		*parseDocument() {
			yield* this.pushSpaces(true);
			const line = this.getLine();
			if (line === null) return this.setNext("doc");
			let n = yield* this.pushIndicators();
			switch (line[n]) {
				case "#": yield* this.pushCount(line.length - n);
				case void 0:
					yield* this.pushNewline();
					return yield* this.parseLineStart();
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel = 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					return "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "doc";
				case "\"":
				case "'": return yield* this.parseQuotedScalar();
				case "|":
				case ">":
					n += yield* this.parseBlockScalarHeader();
					n += yield* this.pushSpaces(true);
					yield* this.pushCount(line.length - n);
					yield* this.pushNewline();
					return yield* this.parseBlockScalar();
				default: return yield* this.parsePlainScalar();
			}
		}
		*parseFlowCollection() {
			let nl, sp;
			let indent = -1;
			do {
				nl = yield* this.pushNewline();
				if (nl > 0) {
					sp = yield* this.pushSpaces(false);
					this.indentValue = indent = sp;
				} else sp = 0;
				sp += yield* this.pushSpaces(true);
			} while (nl + sp > 0);
			const line = this.getLine();
			if (line === null) return this.setNext("flow");
			if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
				if (!(indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}"))) {
					this.flowLevel = 0;
					yield cst.FLOW_END;
					return yield* this.parseLineStart();
				}
			}
			let n = 0;
			while (line[n] === ",") {
				n += yield* this.pushCount(1);
				n += yield* this.pushSpaces(true);
				this.flowKey = false;
			}
			n += yield* this.pushIndicators();
			switch (line[n]) {
				case void 0: return "flow";
				case "#":
					yield* this.pushCount(line.length - n);
					return "flow";
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel += 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					this.flowKey = true;
					this.flowLevel -= 1;
					return this.flowLevel ? "flow" : "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "flow";
				case "\"":
				case "'":
					this.flowKey = true;
					return yield* this.parseQuotedScalar();
				case ":": {
					const next = this.charAt(1);
					if (this.flowKey || isEmpty(next) || next === ",") {
						this.flowKey = false;
						yield* this.pushCount(1);
						yield* this.pushSpaces(true);
						return "flow";
					}
				}
				default:
					this.flowKey = false;
					return yield* this.parsePlainScalar();
			}
		}
		*parseQuotedScalar() {
			const quote = this.charAt(0);
			let end = this.buffer.indexOf(quote, this.pos + 1);
			if (quote === "'") while (end !== -1 && this.buffer[end + 1] === "'") end = this.buffer.indexOf("'", end + 2);
			else while (end !== -1) {
				let n = 0;
				while (this.buffer[end - 1 - n] === "\\") n += 1;
				if (n % 2 === 0) break;
				end = this.buffer.indexOf("\"", end + 1);
			}
			const qb = this.buffer.substring(0, end);
			let nl = qb.indexOf("\n", this.pos);
			if (nl !== -1) {
				while (nl !== -1) {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = qb.indexOf("\n", cs);
				}
				if (nl !== -1) end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
			}
			if (end === -1) {
				if (!this.atEnd) return this.setNext("quoted-scalar");
				end = this.buffer.length;
			}
			yield* this.pushToIndex(end + 1, false);
			return this.flowLevel ? "flow" : "doc";
		}
		*parseBlockScalarHeader() {
			this.blockScalarIndent = -1;
			this.blockScalarKeep = false;
			let i = this.pos;
			while (true) {
				const ch = this.buffer[++i];
				if (ch === "+") this.blockScalarKeep = true;
				else if (ch > "0" && ch <= "9") this.blockScalarIndent = Number(ch) - 1;
				else if (ch !== "-") break;
			}
			return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
		}
		*parseBlockScalar() {
			let nl = this.pos - 1;
			let indent = 0;
			let ch;
			loop: for (let i = this.pos; ch = this.buffer[i]; ++i) switch (ch) {
				case " ":
					indent += 1;
					break;
				case "\n":
					nl = i;
					indent = 0;
					break;
				case "\r": {
					const next = this.buffer[i + 1];
					if (!next && !this.atEnd) return this.setNext("block-scalar");
					if (next === "\n") break;
				}
				default: break loop;
			}
			if (!ch && !this.atEnd) return this.setNext("block-scalar");
			if (indent >= this.indentNext) {
				if (this.blockScalarIndent === -1) this.indentNext = indent;
				else this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
				do {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = this.buffer.indexOf("\n", cs);
				} while (nl !== -1);
				if (nl === -1) {
					if (!this.atEnd) return this.setNext("block-scalar");
					nl = this.buffer.length;
				}
			}
			let i = nl + 1;
			ch = this.buffer[i];
			while (ch === " ") ch = this.buffer[++i];
			if (ch === "	") {
				while (ch === "	" || ch === " " || ch === "\r" || ch === "\n") ch = this.buffer[++i];
				nl = i - 1;
			} else if (!this.blockScalarKeep) do {
				let i = nl - 1;
				let ch = this.buffer[i];
				if (ch === "\r") ch = this.buffer[--i];
				const lastChar = i;
				while (ch === " ") ch = this.buffer[--i];
				if (ch === "\n" && i >= this.pos && i + 1 + indent > lastChar) nl = i;
				else break;
			} while (true);
			yield cst.SCALAR;
			yield* this.pushToIndex(nl + 1, true);
			return yield* this.parseLineStart();
		}
		*parsePlainScalar() {
			const inFlow = this.flowLevel > 0;
			let end = this.pos - 1;
			let i = this.pos - 1;
			let ch;
			while (ch = this.buffer[++i]) if (ch === ":") {
				const next = this.buffer[i + 1];
				if (isEmpty(next) || inFlow && flowIndicatorChars.has(next)) break;
				end = i;
			} else if (isEmpty(ch)) {
				let next = this.buffer[i + 1];
				if (ch === "\r") {
					if (next === "\n") {
						i += 1;
						ch = "\n";
						next = this.buffer[i + 1];
					} else end = i;
				}
				if (next === "#" || inFlow && flowIndicatorChars.has(next)) break;
				if (ch === "\n") {
					const cs = this.continueScalar(i + 1);
					if (cs === -1) break;
					i = Math.max(i, cs - 2);
				}
			} else {
				if (inFlow && flowIndicatorChars.has(ch)) break;
				end = i;
			}
			if (!ch && !this.atEnd) return this.setNext("plain-scalar");
			yield cst.SCALAR;
			yield* this.pushToIndex(end + 1, true);
			return inFlow ? "flow" : "doc";
		}
		*pushCount(n) {
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos += n;
				return n;
			}
			return 0;
		}
		*pushToIndex(i, allowEmpty) {
			const s = this.buffer.slice(this.pos, i);
			if (s) {
				yield s;
				this.pos += s.length;
				return s.length;
			} else if (allowEmpty) yield "";
			return 0;
		}
		*pushIndicators() {
			let n = 0;
			loop: while (true) {
				switch (this.charAt(0)) {
					case "!":
						n += yield* this.pushTag();
						n += yield* this.pushSpaces(true);
						continue loop;
					case "&":
						n += yield* this.pushUntil(isNotAnchorChar);
						n += yield* this.pushSpaces(true);
						continue loop;
					case "-":
					case "?":
					case ":": {
						const inFlow = this.flowLevel > 0;
						const ch1 = this.charAt(1);
						if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
							if (!inFlow) this.indentNext = this.indentValue + 1;
							else if (this.flowKey) this.flowKey = false;
							n += yield* this.pushCount(1);
							n += yield* this.pushSpaces(true);
							continue loop;
						}
					}
				}
				break loop;
			}
			return n;
		}
		*pushTag() {
			if (this.charAt(1) === "<") {
				let i = this.pos + 2;
				let ch = this.buffer[i];
				while (!isEmpty(ch) && ch !== ">") ch = this.buffer[++i];
				return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
			} else {
				let i = this.pos + 1;
				let ch = this.buffer[i];
				while (ch) if (tagChars.has(ch)) ch = this.buffer[++i];
				else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) ch = this.buffer[i += 3];
				else break;
				return yield* this.pushToIndex(i, false);
			}
		}
		*pushNewline() {
			const ch = this.buffer[this.pos];
			if (ch === "\n") return yield* this.pushCount(1);
			else if (ch === "\r" && this.charAt(1) === "\n") return yield* this.pushCount(2);
			else return 0;
		}
		*pushSpaces(allowTabs) {
			let i = this.pos - 1;
			let ch;
			do
				ch = this.buffer[++i];
			while (ch === " " || allowTabs && ch === "	");
			const n = i - this.pos;
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos = i;
			}
			return n;
		}
		*pushUntil(test) {
			let i = this.pos;
			let ch = this.buffer[i];
			while (!test(ch)) ch = this.buffer[++i];
			return yield* this.pushToIndex(i, false);
		}
	};
	exports.Lexer = Lexer;
}));

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Tracks newlines during parsing in order to provide an efficient API for
	* determining the one-indexed `{ line, col }` position for any offset
	* within the input.
	*/
	var LineCounter = class {
		constructor() {
			this.lineStarts = [];
			/**
			* Should be called in ascending order. Otherwise, call
			* `lineCounter.lineStarts.sort()` before calling `linePos()`.
			*/
			this.addNewLine = (offset) => this.lineStarts.push(offset);
			/**
			* Performs a binary search and returns the 1-indexed { line, col }
			* position of `offset`. If `line === 0`, `addNewLine` has never been
			* called or `offset` is before the first known newline.
			*/
			this.linePos = (offset) => {
				let low = 0;
				let high = this.lineStarts.length;
				while (low < high) {
					const mid = low + high >> 1;
					if (this.lineStarts[mid] < offset) low = mid + 1;
					else high = mid;
				}
				if (this.lineStarts[low] === offset) return {
					line: low + 1,
					col: 1
				};
				if (low === 0) return {
					line: 0,
					col: offset
				};
				const start = this.lineStarts[low - 1];
				return {
					line: low,
					col: offset - start + 1
				};
			};
		}
	};
	exports.LineCounter = LineCounter;
}));

// node_modules/yaml/dist/parse/parser.js
var require_parser = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	var cst = require_cst();
	var lexer = require_lexer();
	function includesToken(list, type) {
		for (let i = 0; i < list.length; ++i) if (list[i].type === type) return true;
		return false;
	}
	function findNonEmptyIndex(list) {
		for (let i = 0; i < list.length; ++i) switch (list[i].type) {
			case "space":
			case "comment":
			case "newline": break;
			default: return i;
		}
		return -1;
	}
	function isFlowToken(token) {
		switch (token?.type) {
			case "alias":
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "flow-collection": return true;
			default: return false;
		}
	}
	function getPrevProps(parent) {
		switch (parent.type) {
			case "document": return parent.start;
			case "block-map": {
				const it = parent.items[parent.items.length - 1];
				return it.sep ?? it.start;
			}
			case "block-seq": return parent.items[parent.items.length - 1].start;
			/* istanbul ignore next should not happen */
			default: return [];
		}
	}
	/** Note: May modify input array */
	function getFirstKeyStartProps(prev) {
		if (prev.length === 0) return [];
		let i = prev.length;
		loop: while (--i >= 0) switch (prev[i].type) {
			case "doc-start":
			case "explicit-key-ind":
			case "map-value-ind":
			case "seq-item-ind":
			case "newline": break loop;
		}
		while (prev[++i]?.type === "space");
		return prev.splice(i, prev.length);
	}
	function arrayPushArray(target, source) {
		if (source.length < 1e5) Array.prototype.push.apply(target, source);
		else for (let i = 0; i < source.length; ++i) target.push(source[i]);
	}
	function fixFlowSeqItems(fc) {
		if (fc.start.type === "flow-seq-start") {
			for (const it of fc.items) if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
				if (it.key) it.value = it.key;
				delete it.key;
				if (isFlowToken(it.value)) {
					if (it.value.end) arrayPushArray(it.value.end, it.sep);
					else it.value.end = it.sep;
				} else arrayPushArray(it.start, it.sep);
				delete it.sep;
			}
		}
	}
	/**
	* A YAML concrete syntax tree (CST) parser
	*
	* ```ts
	* const src: string = ...
	* for (const token of new Parser().parse(src)) {
	*   // token: Token
	* }
	* ```
	*
	* To use the parser with a user-provided lexer:
	*
	* ```ts
	* function* parse(source: string, lexer: Lexer) {
	*   const parser = new Parser()
	*   for (const lexeme of lexer.lex(source))
	*     yield* parser.next(lexeme)
	*   yield* parser.end()
	* }
	*
	* const src: string = ...
	* const lexer = new Lexer()
	* for (const token of parse(src, lexer)) {
	*   // token: Token
	* }
	* ```
	*/
	var Parser = class {
		/**
		* @param onNewLine - If defined, called separately with the start position of
		*   each new line (in `parse()`, including the start of input).
		*/
		constructor(onNewLine) {
			/** If true, space and sequence indicators count as indentation */
			this.atNewLine = true;
			/** If true, next token is a scalar value */
			this.atScalar = false;
			/** Current indentation level */
			this.indent = 0;
			/** Current offset since the start of parsing */
			this.offset = 0;
			/** On the same line with a block map key */
			this.onKeyLine = false;
			/** Top indicates the node that's currently being built */
			this.stack = [];
			/** The source of the current token, set in parse() */
			this.source = "";
			/** The type of the current token, set in parse() */
			this.type = "";
			this.lexer = new lexer.Lexer();
			this.onNewLine = onNewLine;
		}
		/**
		* Parse `source` as a YAML stream.
		* If `incomplete`, a part of the last line may be left as a buffer for the next call.
		*
		* Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
		*
		* @returns A generator of tokens representing each directive, document, and other structure.
		*/
		*parse(source, incomplete = false) {
			if (this.onNewLine && this.offset === 0) this.onNewLine(0);
			for (const lexeme of this.lexer.lex(source, incomplete)) yield* this.next(lexeme);
			if (!incomplete) yield* this.end();
		}
		/**
		* Advance the parser by the `source` of one lexical token.
		*/
		*next(source) {
			this.source = source;
			if (node_process.env.LOG_TOKENS) console.log("|", cst.prettyToken(source));
			if (this.atScalar) {
				this.atScalar = false;
				yield* this.step();
				this.offset += source.length;
				return;
			}
			const type = cst.tokenType(source);
			if (!type) {
				const message = `Not a YAML token: ${source}`;
				yield* this.pop({
					type: "error",
					offset: this.offset,
					message,
					source
				});
				this.offset += source.length;
			} else if (type === "scalar") {
				this.atNewLine = false;
				this.atScalar = true;
				this.type = "scalar";
			} else {
				this.type = type;
				yield* this.step();
				switch (type) {
					case "newline":
						this.atNewLine = true;
						this.indent = 0;
						if (this.onNewLine) this.onNewLine(this.offset + source.length);
						break;
					case "space":
						if (this.atNewLine && source[0] === " ") this.indent += source.length;
						break;
					case "explicit-key-ind":
					case "map-value-ind":
					case "seq-item-ind":
						if (this.atNewLine) this.indent += source.length;
						break;
					case "doc-mode":
					case "flow-error-end": return;
					default: this.atNewLine = false;
				}
				this.offset += source.length;
			}
		}
		/** Call at end of input to push out any remaining constructions */
		*end() {
			while (this.stack.length > 0) yield* this.pop();
		}
		get sourceToken() {
			return {
				type: this.type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		*step() {
			const top = this.peek(1);
			if (this.type === "doc-end" && top?.type !== "doc-end") {
				while (this.stack.length > 0) yield* this.pop();
				this.stack.push({
					type: "doc-end",
					offset: this.offset,
					source: this.source
				});
				return;
			}
			if (!top) return yield* this.stream();
			switch (top.type) {
				case "document": return yield* this.document(top);
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return yield* this.scalar(top);
				case "block-scalar": return yield* this.blockScalar(top);
				case "block-map": return yield* this.blockMap(top);
				case "block-seq": return yield* this.blockSequence(top);
				case "flow-collection": return yield* this.flowCollection(top);
				case "doc-end": return yield* this.documentEnd(top);
			}
			/* istanbul ignore next should not happen */
			yield* this.pop();
		}
		peek(n) {
			return this.stack[this.stack.length - n];
		}
		*pop(error) {
			const token = error ?? this.stack.pop();
			/* istanbul ignore if should not happen */
			if (!token) yield {
				type: "error",
				offset: this.offset,
				source: "",
				message: "Tried to pop an empty stack"
			};
			else if (this.stack.length === 0) yield token;
			else {
				const top = this.peek(1);
				if (token.type === "block-scalar") token.indent = "indent" in top ? top.indent : 0;
				else if (token.type === "flow-collection" && top.type === "document") token.indent = 0;
				if (token.type === "flow-collection") fixFlowSeqItems(token);
				switch (top.type) {
					case "document":
						top.value = token;
						break;
					case "block-scalar":
						top.props.push(token);
						break;
					case "block-map": {
						const it = top.items[top.items.length - 1];
						if (it.value) {
							top.items.push({
								start: [],
								key: token,
								sep: []
							});
							this.onKeyLine = true;
							return;
						} else if (it.sep) it.value = token;
						else {
							Object.assign(it, {
								key: token,
								sep: []
							});
							this.onKeyLine = !it.explicitKey;
							return;
						}
						break;
					}
					case "block-seq": {
						const it = top.items[top.items.length - 1];
						if (it.value) top.items.push({
							start: [],
							value: token
						});
						else it.value = token;
						break;
					}
					case "flow-collection": {
						const it = top.items[top.items.length - 1];
						if (!it || it.value) top.items.push({
							start: [],
							key: token,
							sep: []
						});
						else if (it.sep) it.value = token;
						else Object.assign(it, {
							key: token,
							sep: []
						});
						return;
					}
					/* istanbul ignore next should not happen */
					default:
						yield* this.pop();
						yield* this.pop(token);
				}
				if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
					const last = token.items[token.items.length - 1];
					if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
						if (top.type === "document") top.end = last.start;
						else top.items.push({ start: last.start });
						token.items.splice(-1, 1);
					}
				}
			}
		}
		*stream() {
			switch (this.type) {
				case "directive-line":
					yield {
						type: "directive",
						offset: this.offset,
						source: this.source
					};
					return;
				case "byte-order-mark":
				case "space":
				case "comment":
				case "newline":
					yield this.sourceToken;
					return;
				case "doc-mode":
				case "doc-start": {
					const doc = {
						type: "document",
						offset: this.offset,
						start: []
					};
					if (this.type === "doc-start") doc.start.push(this.sourceToken);
					this.stack.push(doc);
					return;
				}
			}
			yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML stream`,
				source: this.source
			};
		}
		*document(doc) {
			if (doc.value) return yield* this.lineEnd(doc);
			switch (this.type) {
				case "doc-start":
					if (findNonEmptyIndex(doc.start) !== -1) {
						yield* this.pop();
						yield* this.step();
					} else doc.start.push(this.sourceToken);
					return;
				case "anchor":
				case "tag":
				case "space":
				case "comment":
				case "newline":
					doc.start.push(this.sourceToken);
					return;
			}
			const bv = this.startBlockValue(doc);
			if (bv) this.stack.push(bv);
			else yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML document`,
				source: this.source
			};
		}
		*scalar(scalar) {
			if (this.type === "map-value-ind") {
				const start = getFirstKeyStartProps(getPrevProps(this.peek(2)));
				let sep;
				if (scalar.end) {
					sep = scalar.end;
					sep.push(this.sourceToken);
					delete scalar.end;
				} else sep = [this.sourceToken];
				const map = {
					type: "block-map",
					offset: scalar.offset,
					indent: scalar.indent,
					items: [{
						start,
						key: scalar,
						sep
					}]
				};
				this.onKeyLine = true;
				this.stack[this.stack.length - 1] = map;
			} else yield* this.lineEnd(scalar);
		}
		*blockScalar(scalar) {
			switch (this.type) {
				case "space":
				case "comment":
				case "newline":
					scalar.props.push(this.sourceToken);
					return;
				case "scalar":
					scalar.source = this.source;
					this.atNewLine = true;
					this.indent = 0;
					if (this.onNewLine) {
						let nl = this.source.indexOf("\n") + 1;
						while (nl !== 0) {
							this.onNewLine(this.offset + nl);
							nl = this.source.indexOf("\n", nl) + 1;
						}
					}
					yield* this.pop();
					break;
				/* istanbul ignore next should not happen */
				default:
					yield* this.pop();
					yield* this.step();
			}
		}
		*blockMap(map) {
			const it = map.items[map.items.length - 1];
			switch (this.type) {
				case "newline":
					this.onKeyLine = false;
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else map.items.push({ start: [this.sourceToken] });
					} else if (it.sep) it.sep.push(this.sourceToken);
					else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) map.items.push({ start: [this.sourceToken] });
					else if (it.sep) it.sep.push(this.sourceToken);
					else {
						if (this.atIndentedComment(it.start, map.indent)) {
							const end = map.items[map.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								map.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
			}
			if (this.indent >= map.indent) {
				const atMapIndent = !this.onKeyLine && this.indent === map.indent;
				const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
				let start = [];
				if (atNextItem && it.sep && !it.value) {
					const nl = [];
					for (let i = 0; i < it.sep.length; ++i) {
						const st = it.sep[i];
						switch (st.type) {
							case "newline":
								nl.push(i);
								break;
							case "space": break;
							case "comment":
								if (st.indent > map.indent) nl.length = 0;
								break;
							default: nl.length = 0;
						}
					}
					if (nl.length >= 2) start = it.sep.splice(nl[1]);
				}
				switch (this.type) {
					case "anchor":
					case "tag":
						if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({ start });
							this.onKeyLine = true;
						} else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "explicit-key-ind":
						if (!it.sep && !it.explicitKey) {
							it.start.push(this.sourceToken);
							it.explicitKey = true;
						} else if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({
								start,
								explicitKey: true
							});
						} else this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [this.sourceToken],
								explicitKey: true
							}]
						});
						this.onKeyLine = true;
						return;
					case "map-value-ind":
						if (it.explicitKey) {
							if (!it.sep) {
								if (includesToken(it.start, "newline")) Object.assign(it, {
									key: null,
									sep: [this.sourceToken]
								});
								else {
									const start = getFirstKeyStartProps(it.start);
									this.stack.push({
										type: "block-map",
										offset: this.offset,
										indent: this.indent,
										items: [{
											start,
											key: null,
											sep: [this.sourceToken]
										}]
									});
								}
							} else if (it.value) map.items.push({
								start: [],
								key: null,
								sep: [this.sourceToken]
							});
							else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
								type: "block-map",
								offset: this.offset,
								indent: this.indent,
								items: [{
									start,
									key: null,
									sep: [this.sourceToken]
								}]
							});
							else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
								const start = getFirstKeyStartProps(it.start);
								const key = it.key;
								const sep = it.sep;
								sep.push(this.sourceToken);
								delete it.key;
								delete it.sep;
								this.stack.push({
									type: "block-map",
									offset: this.offset,
									indent: this.indent,
									items: [{
										start,
										key,
										sep
									}]
								});
							} else if (start.length > 0) it.sep = it.sep.concat(start, this.sourceToken);
							else it.sep.push(this.sourceToken);
						} else if (!it.sep) Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.value || atNextItem) map.items.push({
							start,
							key: null,
							sep: [this.sourceToken]
						});
						else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [],
								key: null,
								sep: [this.sourceToken]
							}]
						});
						else it.sep.push(this.sourceToken);
						this.onKeyLine = true;
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (atNextItem || it.value) {
							map.items.push({
								start,
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						} else if (it.sep) this.stack.push(fs);
						else {
							Object.assign(it, {
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						}
						return;
					}
					default: {
						const bv = this.startBlockValue(map);
						if (bv) {
							if (bv.type === "block-seq") {
								if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
									yield* this.pop({
										type: "error",
										offset: this.offset,
										message: "Unexpected block-seq-ind on same line with key",
										source: this.source
									});
									return;
								}
							} else if (atMapIndent) map.items.push({ start });
							this.stack.push(bv);
							return;
						}
					}
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*blockSequence(seq) {
			const it = seq.items[seq.items.length - 1];
			switch (this.type) {
				case "newline":
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else seq.items.push({ start: [this.sourceToken] });
					} else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) seq.items.push({ start: [this.sourceToken] });
					else {
						if (this.atIndentedComment(it.start, seq.indent)) {
							const end = seq.items[seq.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								seq.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
				case "anchor":
				case "tag":
					if (it.value || this.indent <= seq.indent) break;
					it.start.push(this.sourceToken);
					return;
				case "seq-item-ind":
					if (this.indent !== seq.indent) break;
					if (it.value || includesToken(it.start, "seq-item-ind")) seq.items.push({ start: [this.sourceToken] });
					else it.start.push(this.sourceToken);
					return;
			}
			if (this.indent > seq.indent) {
				const bv = this.startBlockValue(seq);
				if (bv) {
					this.stack.push(bv);
					return;
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*flowCollection(fc) {
			const it = fc.items[fc.items.length - 1];
			if (this.type === "flow-error-end") {
				let top;
				do {
					yield* this.pop();
					top = this.peek(1);
				} while (top?.type === "flow-collection");
			} else if (fc.end.length === 0) {
				switch (this.type) {
					case "comma":
					case "explicit-key-ind":
						if (!it || it.sep) fc.items.push({ start: [this.sourceToken] });
						else it.start.push(this.sourceToken);
						return;
					case "map-value-ind":
						if (!it || it.value) fc.items.push({
							start: [],
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.sep) it.sep.push(this.sourceToken);
						else Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						return;
					case "space":
					case "comment":
					case "newline":
					case "anchor":
					case "tag":
						if (!it || it.value) fc.items.push({ start: [this.sourceToken] });
						else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (!it || it.value) fc.items.push({
							start: [],
							key: fs,
							sep: []
						});
						else if (it.sep) this.stack.push(fs);
						else Object.assign(it, {
							key: fs,
							sep: []
						});
						return;
					}
					case "flow-map-end":
					case "flow-seq-end":
						fc.end.push(this.sourceToken);
						return;
				}
				const bv = this.startBlockValue(fc);
				/* istanbul ignore else should not happen */
				if (bv) this.stack.push(bv);
				else {
					yield* this.pop();
					yield* this.step();
				}
			} else {
				const parent = this.peek(2);
				if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
					yield* this.pop();
					yield* this.step();
				} else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
					const start = getFirstKeyStartProps(getPrevProps(parent));
					fixFlowSeqItems(fc);
					const sep = fc.end.splice(1, fc.end.length);
					sep.push(this.sourceToken);
					const map = {
						type: "block-map",
						offset: fc.offset,
						indent: fc.indent,
						items: [{
							start,
							key: fc,
							sep
						}]
					};
					this.onKeyLine = true;
					this.stack[this.stack.length - 1] = map;
				} else yield* this.lineEnd(fc);
			}
		}
		flowScalar(type) {
			if (this.onNewLine) {
				let nl = this.source.indexOf("\n") + 1;
				while (nl !== 0) {
					this.onNewLine(this.offset + nl);
					nl = this.source.indexOf("\n", nl) + 1;
				}
			}
			return {
				type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		startBlockValue(parent) {
			switch (this.type) {
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return this.flowScalar(this.type);
				case "block-scalar-header": return {
					type: "block-scalar",
					offset: this.offset,
					indent: this.indent,
					props: [this.sourceToken],
					source: ""
				};
				case "flow-map-start":
				case "flow-seq-start": return {
					type: "flow-collection",
					offset: this.offset,
					indent: this.indent,
					start: this.sourceToken,
					items: [],
					end: []
				};
				case "seq-item-ind": return {
					type: "block-seq",
					offset: this.offset,
					indent: this.indent,
					items: [{ start: [this.sourceToken] }]
				};
				case "explicit-key-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					start.push(this.sourceToken);
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							explicitKey: true
						}]
					};
				}
				case "map-value-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							key: null,
							sep: [this.sourceToken]
						}]
					};
				}
			}
			return null;
		}
		atIndentedComment(start, indent) {
			if (this.type !== "comment") return false;
			if (this.indent <= indent) return false;
			return start.every((st) => st.type === "newline" || st.type === "space");
		}
		*documentEnd(docEnd) {
			if (this.type !== "doc-mode") {
				if (docEnd.end) docEnd.end.push(this.sourceToken);
				else docEnd.end = [this.sourceToken];
				if (this.type === "newline") yield* this.pop();
			}
		}
		*lineEnd(token) {
			switch (this.type) {
				case "comma":
				case "doc-start":
				case "doc-end":
				case "flow-seq-end":
				case "flow-map-end":
				case "map-value-ind":
					yield* this.pop();
					yield* this.step();
					break;
				case "newline": this.onKeyLine = false;
				default:
					if (token.end) token.end.push(this.sourceToken);
					else token.end = [this.sourceToken];
					if (this.type === "newline") yield* this.pop();
			}
		}
	};
	exports.Parser = Parser;
}));

// node_modules/yaml/dist/public-api.js
var require_public_api = /* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var errors = require_errors();
	var log = require_log();
	var identity = require_identity();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	function parseOptions(options) {
		const prettyErrors = options.prettyErrors !== false;
		return {
			lineCounter: options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null,
			prettyErrors
		};
	}
	/**
	* Parse the input as a stream of YAML documents.
	*
	* Documents should be separated from each other by `...` or `---` marker lines.
	*
	* @returns If an empty `docs` array is returned, it will be of type
	*   EmptyStream and contain additional stream information. In
	*   TypeScript, you should use `'empty' in docs` as a type guard for it.
	*/
	function parseAllDocuments(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		const docs = Array.from(composer$1.compose(parser$1.parse(source)));
		if (prettyErrors && lineCounter) for (const doc of docs) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		if (docs.length > 0) return docs;
		return Object.assign([], { empty: true }, composer$1.streamInfo());
	}
	/** Parse an input string into a single YAML.Document */
	function parseDocument(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		let doc = null;
		for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) if (!doc) doc = _doc;
		else if (doc.options.logLevel !== "silent") {
			doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
			break;
		}
		if (prettyErrors && lineCounter) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		return doc;
	}
	function parse(src, reviver, options) {
		let _reviver = void 0;
		if (typeof reviver === "function") _reviver = reviver;
		else if (options === void 0 && reviver && typeof reviver === "object") options = reviver;
		const doc = parseDocument(src, options);
		if (!doc) return null;
		doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
		if (doc.errors.length > 0) {
			if (doc.options.logLevel !== "silent") throw doc.errors[0];
			else doc.errors = [];
		}
		return doc.toJS(Object.assign({ reviver: _reviver }, options));
	}
	function stringify(value, replacer, options) {
		let _replacer = null;
		if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
		else if (options === void 0 && replacer) options = replacer;
		if (typeof options === "string") options = options.length;
		if (typeof options === "number") {
			const indent = Math.round(options);
			options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
		}
		if (value === void 0) {
			const { keepUndefined } = options ?? replacer ?? {};
			if (!keepUndefined) return void 0;
		}
		if (identity.isDocument(value) && !_replacer) return value.toString(options);
		return new Document.Document(value, _replacer, options).toString(options);
	}
	exports.parse = parse;
	exports.parseAllDocuments = parseAllDocuments;
	exports.parseDocument = parseDocument;
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var Schema = require_Schema();
	var errors = require_errors();
	var Alias = require_Alias();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var cst = require_cst();
	var lexer = require_lexer();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	var publicApi = require_public_api();
	var visit = require_visit();
	exports.Composer = composer.Composer;
	exports.Document = Document.Document;
	exports.Schema = Schema.Schema;
	exports.YAMLError = errors.YAMLError;
	exports.YAMLParseError = errors.YAMLParseError;
	exports.YAMLWarning = errors.YAMLWarning;
	exports.Alias = Alias.Alias;
	exports.isAlias = identity.isAlias;
	exports.isCollection = identity.isCollection;
	exports.isDocument = identity.isDocument;
	exports.isMap = identity.isMap;
	exports.isNode = identity.isNode;
	exports.isPair = identity.isPair;
	exports.isScalar = identity.isScalar;
	exports.isSeq = identity.isSeq;
	exports.Pair = Pair.Pair;
	exports.Scalar = Scalar.Scalar;
	exports.YAMLMap = YAMLMap.YAMLMap;
	exports.YAMLSeq = YAMLSeq.YAMLSeq;
	exports.Lexer = lexer.Lexer;
	exports.LineCounter = lineCounter.LineCounter;
	exports.Parser = parser.Parser;
	exports.parse = publicApi.parse;
	exports.parseAllDocuments = publicApi.parseAllDocuments;
	exports.parseDocument = publicApi.parseDocument;
	exports.stringify = publicApi.stringify;
	exports.visit = visit.visit;
	exports.visitAsync = visit.visitAsync;
}));

// src/detect/jsonc.ts
var import_dist = require_dist();
/** The index of the first character from `from` on that is neither whitespace nor inside a comment. */
function nextSignificant(text, from) {
	let index = from;
	for (;;) {
		while (index < text.length && /\s/u.test(text[index])) index += 1;
		if (text.startsWith("//", index)) while (index < text.length && text[index] !== "\n") index += 1;
		else if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return text.length;
			index = end + 2;
		} else return index;
	}
}
/** Parses JSON that may contain comments and trailing commas (JSONC), as used by deno.json and deno.jsonc. */
function parseJsonc(text) {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const next = text[index + 1];
		if (char === "\"") {
			const start = index;
			index += 1;
			while (index < text.length && text[index] !== "\"") index += text[index] === "\\" ? 2 : 1;
			index += 1;
			output += text.slice(start, index);
		} else if (char === "/" && next === "/") while (index < text.length && text[index] !== "\n") index += 1;
		else if (char === "/" && next === "*") {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) throw new SyntaxError("unterminated block comment");
			output += text.slice(index, end + 2).replace(/[^\n]/gu, " ");
			index = end + 2;
		} else if (char === ",") {
			const following = text[nextSignificant(text, index + 1)];
			output += following === "}" || following === "]" ? " " : ",";
			index += 1;
		} else {
			output += char;
			index += 1;
		}
	}
	return JSON.parse(output);
}

// src/detect/knowledge.ts
const PACKAGE_MANAGERS = [
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"uv",
	"pip",
	"poetry",
	"pdm",
	"pipenv"
];
const BOTS$1 = ["renovate", "dependabot"];
/** Files several tools read; a Python tool counts the project file only when it has the tool's table. */
const SHARED_FILES = ["package.json", ".npmrc"];
function values(fact) {
	return evidenceOf(fact).map((evidence) => evidence.value);
}
/** The value of a fact; for a disputed fact the first variant, which must agree with the others in shape. */
function first(fact) {
	const [value] = values(fact);
	return value;
}
function unique(items) {
	return [...new Set(items)];
}
function allVersions(versioned) {
	return versioned.flatMap((entry) => [...entry.value]);
}
function extraString(tool, key) {
	const fact = tool.extra?.[key];
	const value = fact === void 0 ? void 0 : first(fact);
	if (typeof value !== "string") throw new Error(`knowledge base: ${tool.id} extra.${key} must be a string`);
	return value;
}
function extraValue(tool, key) {
	const fact = tool.extra?.[key];
	return fact === void 0 ? void 0 : first(fact);
}
/** required-version in [tool.uv] of pyproject.toml and at the top of uv.toml; requires-poetry in [tool.poetry]. */
function requiredVersions(tool, pythonProject) {
	const required = extraValue(tool, "requiredVersion");
	if (!isRecord(required) || typeof required["table"] !== "string" || typeof required["key"] !== "string") return [];
	const key = required["key"];
	const tables = extraValue(tool, "configTables");
	return (isRecord(tables) ? Object.entries(tables).filter((entry) => typeof entry[1] === "string") : [[pythonProject, required["table"]]]).map(([file, table]) => ({
		file,
		path: [...table === "" ? [] : table.split("."), key]
	}));
}
function workspaceFacts(declaration, objectKey) {
	return declaration === null ? null : {
		...declaration,
		objectKey
	};
}
function tool$1(tools, id) {
	const found = tools.find((entry) => entry.id === id);
	if (found === void 0) throw new Error(`knowledge base: no entry for ${id}`);
	return found;
}
function detectionFacts(tools, environment) {
	const pythonProject = first(environment.python.projectFile);
	const shared = /* @__PURE__ */ new Set([...SHARED_FILES, pythonProject]);
	const managers = PACKAGE_MANAGERS.map((id) => {
		const entry = tool$1(tools, id);
		const project = entry.project;
		if (project === void 0) throw new Error(`knowledge base: ${id} has no project facts`);
		const manifests = unique(values(project.manifests).flat());
		const ownConfig = values(entry.cooldown.configFiles).flat();
		const pyprojectTable = extraValue(entry, "pyprojectTable");
		const order = extraValue(entry, "configFileOrder");
		const pattern = extraValue(entry, "lockfilePattern");
		return {
			id,
			ecosystem: entry.ecosystem ?? "npm",
			lockfiles: unique(values(project.lockfiles).flatMap(allVersions)),
			manifests,
			configFiles: unique([...ownConfig, ...manifests]).filter((file) => !shared.has(file)),
			workspaces: workspaceFacts(first(project.workspaces), first(project.workspacesObjectKey)),
			pyprojectTable: typeof pyprojectTable === "string" ? pyprojectTable : null,
			requiredVersions: requiredVersions(entry, pythonProject),
			configFileOrder: Array.isArray(order) && order.every((file) => typeof file === "string") ? order : null,
			lockfilePattern: typeof pattern === "string" ? new RegExp(pattern, "u") : null
		};
	});
	const bots = BOTS$1.map((id) => {
		const entry = tool$1(tools, id);
		const packageJson = entry.extra?.["packageJsonConfig"];
		const key = packageJson === void 0 ? null : first(packageJson).key;
		return {
			id,
			configFiles: unique(values(entry.cooldown.configFiles).flat()),
			packageJsonKey: typeof key === "string" ? key : null
		};
	});
	const yarn = tool$1(tools, "yarn");
	const actions = environment.githubActions;
	return {
		managers,
		pythonProject,
		hatch: first(environment.python.hatch),
		bots,
		yarn: {
			berryMarker: extraString(yarn, "berryLockfileMarker"),
			classicHeader: extraString(yarn, "classicLockfileHeader")
		},
		packageManagerKey: first(environment.corepack.packageManagerField).key,
		devEngines: first(environment.devEngines),
		volta: first(environment.volta.manifest),
		toolVersions: {
			file: first(environment.asdf.toolVersionsFile),
			plugins: first(environment.asdf.plugins)
		},
		workflows: first(actions.workflows),
		setupActions: [
			actions.setupNode,
			actions.pnpmActionSetup,
			actions.pnpmSetup,
			actions.setupBun,
			actions.setupDeno,
			actions.setupPython,
			actions.setupUv,
			actions.installPoetry,
			actions.actionsPoetry
		].map(first)
	};
}

// src/detect/repository.ts
const MAX_FILE_SIZE = 1048576;
/** Directories never searched for workspace packages or configuration. */
const SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", ".git"]);
function errorMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n", 1)[0] ?? message;
}
var Repository = class {
	root;
	warnings = [];
	#warned = /* @__PURE__ */ new Set();
	#parsed = /* @__PURE__ */ new Map();
	constructor(root) {
		this.root = realpathSync(root);
	}
	warn(code, message, files) {
		const key = `${code}\0${message}`;
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.warnings.push({
			code,
			message,
			files: [...files]
		});
	}
	#inside(real) {
		return real === this.root || real.startsWith(this.root + sep);
	}
	/** The real path of a repository-relative path, or undefined if it is missing or leads outside. */
	#resolve(path, report) {
		const full = join(this.root, path);
		try {
			lstatSync(full);
		} catch {
			return;
		}
		let real;
		try {
			real = realpathSync(full);
		} catch {
			return;
		}
		if (!this.#inside(real)) {
			if (report) this.warn("outside-repository", `${path} points outside the repository and was not read`, [path]);
			return;
		}
		return real;
	}
	isFile(path) {
		const real = this.#resolve(path, true);
		return real !== void 0 && statSync(real).isFile();
	}
	/** The text of a file, without a byte order mark; undefined (with a warning when useful) if it cannot be read. */
	readText(path, limit = MAX_FILE_SIZE) {
		const real = this.#resolve(path, true);
		if (real === void 0) return void 0;
		const stats = statSync(real);
		if (!stats.isFile()) return void 0;
		if (stats.size > limit) {
			this.warn("file-too-large", `${path} is larger than ${limit / 1048576} MiB and was not read`, [path]);
			return;
		}
		const text = readFileSync(real, "utf8");
		return text.startsWith("﻿") ? text.slice(1) : text;
	}
	/** The first bytes of a file, e.g. to recognize a lockfile format without reading a large file. */
	readHead(path, bytes = 4096) {
		const real = this.#resolve(path, true);
		if (real === void 0 || !statSync(real).isFile()) return void 0;
		const buffer = Buffer.alloc(bytes);
		const descriptor = openSync(real, "r");
		try {
			return buffer.subarray(0, readSync(descriptor, buffer, 0, bytes, 0)).toString("utf8");
		} finally {
			closeSync(descriptor);
		}
	}
	/** Names of the files in a directory (following symlinks only inside the repository). */
	listFiles(path) {
		return this.#entries(path).filter((entry) => entry.isFile).map((entry) => entry.name);
	}
	/** Names of the subdirectories of a directory, skipping node_modules, .git and symlinks that lead outside. */
	listDirectories(path) {
		return this.#entries(path).filter((entry) => entry.isDirectory && !SKIPPED_DIRECTORIES.has(entry.name)).map((entry) => entry.name);
	}
	#entries(path) {
		const real = this.#resolve(path, false);
		if (real === void 0) return [];
		let names;
		try {
			names = readdirSync(real).sort();
		} catch {
			return [];
		}
		const entries = [];
		for (const name of names) {
			const target = this.#resolve(path === "." ? name : `${path}/${name}`, false);
			if (target === void 0) continue;
			const stats = statSync(target);
			entries.push({
				name,
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory()
			});
		}
		return entries;
	}
	/** Parses a file with the given parser, reporting failures as warnings. */
	parse(path, parser) {
		const text = this.readText(path);
		if (text === void 0) return void 0;
		try {
			return parser(text);
		} catch (error) {
			this.warn("invalid-file", `cannot parse ${path}: ${errorMessage(error)}`, [path]);
			return;
		}
	}
	/** Like parse, but each file is read and parsed once per parser: several rules read the same file. */
	parseOnce(path, parser) {
		let cache = this.#parsed.get(parser);
		if (cache === void 0) {
			cache = /* @__PURE__ */ new Map();
			this.#parsed.set(parser, cache);
		}
		if (!cache.has(path)) cache.set(path, this.parse(path, parser));
		return cache.get(path);
	}
	relative(absolute) {
		return relative(this.root, absolute).split(sep).join("/");
	}
};
/** Joins repository-relative paths with `/`, treating `.` as the root. */
function joinPath(directory, name) {
	return directory === "." ? name : `${directory}/${name}`;
}

// src/detect/toml.ts
/** A date or time value, kept as written. */
var TomlDateTime = class {
	text;
	kind;
	constructor(text, kind) {
		this.text = text;
		this.kind = kind;
	}
	toString() {
		return this.text;
	}
};
const BARE_KEY = /^[A-Za-z0-9_-]+/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/u;
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?)/u;
const ESCAPES = {
	b: "\b",
	t: "	",
	n: "\n",
	f: "\f",
	r: "\r",
	e: "\x1B",
	"\"": "\"",
	"\\": "\\"
};
function parseToml(input) {
	const text = input.startsWith("﻿") ? input.slice(1) : input;
	const origins = /* @__PURE__ */ new WeakMap();
	const arraysOfTables = /* @__PURE__ */ new WeakSet();
	const lines = /* @__PURE__ */ new Map();
	let index = 0;
	let line = 1;
	const fail = (message, at = line) => {
		throw new SyntaxError(`invalid TOML at line ${at}: ${message}`);
	};
	const record = (path) => {
		lines.set(JSON.stringify(path), line);
	};
	const advance = (count = 1) => {
		for (let step = 0; step < count; step++) if (text[index++] === "\n") line += 1;
	};
	const skipSpaces = () => {
		while (text[index] === " " || text[index] === "	") index += 1;
	};
	const skipComment = () => {
		if (text[index] === "#") while (index < text.length && text[index] !== "\n") index += 1;
	};
	/** Spaces, comments and line breaks, as allowed inside arrays and (multi-line) inline tables. */
	const skipBlank = () => {
		for (;;) {
			skipSpaces();
			skipComment();
			if (text[index] === "\n") advance();
			else if (text.startsWith("\r\n", index)) advance(2);
			else return;
		}
	};
	const endOfLine = () => {
		skipSpaces();
		skipComment();
		if (index >= text.length) return;
		if (text[index] === "\n") advance();
		else if (text.startsWith("\r\n", index)) advance(2);
		else fail("expected a new line after the value");
	};
	const newTable = (origin) => {
		const table = {};
		origins.set(table, origin);
		return table;
	};
	const isTable = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof TomlDateTime);
	const own = (table, key) => Object.hasOwn(table, key) ? table[key] : void 0;
	const put = (table, key, value) => {
		Object.defineProperty(table, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
	};
	const unicode = (digits) => {
		const hex = text.slice(index, index + digits);
		if (!/^[0-9A-Fa-f]+$/u.test(hex) || hex.length !== digits) fail(`invalid unicode escape \\${digits === 4 ? "u" : "U"}${hex}`);
		const code = Number.parseInt(hex, 16);
		if (code > 1114111 || code >= 55296 && code <= 57343) fail(`invalid unicode code point ${hex}`);
		index += digits;
		return String.fromCodePoint(code);
	};
	const escape = () => {
		const char = text[index] ?? "";
		index += 1;
		if (char === "u") return unicode(4);
		if (char === "U") return unicode(8);
		if (char === "x") return unicode(2);
		return ESCAPES[char] ?? fail(`invalid escape \\${char}`);
	};
	const basicString = () => {
		const start = line;
		index += 1;
		let value = "";
		for (;;) {
			const char = text[index];
			if (char === void 0 || char === "\n" || char === "\r" && text[index + 1] === "\n") return fail("unterminated string", start);
			index += 1;
			if (char === "\"") return value;
			value += char === "\\" ? escape() : char;
		}
	};
	const literalString = () => {
		const start = line;
		const end = text.indexOf("'", index + 1);
		const newline = text.indexOf("\n", index + 1);
		if (end === -1 || newline !== -1 && newline < end) fail("unterminated string", start);
		const value = text.slice(index + 1, end).replace(/\r$/u, "");
		index = end + 1;
		return value;
	};
	const multiLineString = (quote) => {
		const start = line;
		advance(3);
		if (text[index] === "\n") advance();
		else if (text.startsWith("\r\n", index)) advance(2);
		let value = "";
		for (;;) {
			if (index >= text.length) return fail("unterminated string", start);
			if (text.startsWith(quote, index)) {
				let extra = 0;
				while (extra < 2 && text[index + 3 + extra] === quote[0]) extra += 1;
				value += quote[0]?.repeat(extra) ?? "";
				advance(3 + extra);
				return value;
			}
			const char = text[index] ?? "";
			if (quote === "\"\"\"" && char === "\\") {
				const rest = /^\\[ \t]*\r?\n/u.exec(text.slice(index, index + 64));
				if (rest !== null) {
					advance(rest[0].length);
					while (/[ \t\r\n]/u.test(text[index] ?? "")) advance();
					continue;
				}
				index += 1;
				value += escape();
				continue;
			}
			if (char === "\r" && text[index + 1] === "\n") {
				value += "\n";
				advance(2);
				continue;
			}
			value += char;
			advance();
		}
	};
	const simpleKey = () => {
		const char = text[index];
		if (char === "\"") return text.startsWith("\"\"\"", index) ? fail("a key cannot be a multi-line string") : basicString();
		if (char === "'") return text.startsWith("'''", index) ? fail("a key cannot be a multi-line string") : literalString();
		const match = BARE_KEY.exec(text.slice(index, index + 256));
		if (match === null) return fail("expected a key");
		index += match[0].length;
		return match[0];
	};
	const key = () => {
		const parts = [simpleKey()];
		for (;;) {
			skipSpaces();
			if (text[index] !== ".") return parts;
			index += 1;
			skipSpaces();
			parts.push(simpleKey());
		}
	};
	const number = (raw) => {
		const clean = raw.replaceAll("_", "");
		if (/^[+-]?inf$/u.test(clean)) return clean.startsWith("-") ? -Infinity : Infinity;
		if (/^[+-]?nan$/u.test(clean)) return NaN;
		if (/^0[xob]/u.test(clean)) {
			const value = BigInt(clean);
			return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
		}
		if (/^[+-]?\d+$/u.test(clean)) {
			const value = BigInt(clean);
			return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
		}
		const value = Number(clean);
		return Number.isNaN(value) ? fail(`invalid number ${raw}`) : value;
	};
	const value = (path) => {
		const char = text[index];
		if (char === "\"") return text.startsWith("\"\"\"", index) ? multiLineString("\"\"\"") : basicString();
		if (char === "'") return text.startsWith("'''", index) ? multiLineString("'''") : literalString();
		if (char === "[") return array(path);
		if (char === "{") return inlineTable(path);
		const rest = text.slice(index, index + 64);
		if (/^true(?![A-Za-z0-9_-])/u.test(rest)) {
			index += 4;
			return true;
		}
		if (/^false(?![A-Za-z0-9_-])/u.test(rest)) {
			index += 5;
			return false;
		}
		const date = DATE_TIME.exec(rest);
		if (date !== null) {
			index += date[0].length;
			const kind = date[0].includes(":") ? date[0].includes("-") ? /(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(date[0]) ? "offset-date-time" : "local-date-time" : "local-time" : "local-date";
			return new TomlDateTime(date[0], kind);
		}
		const match = NUMBER.exec(rest);
		if (match !== null) {
			index += match[0].length;
			return number(match[0]);
		}
		return fail("expected a value");
	};
	const array = (path) => {
		index += 1;
		const items = [];
		for (;;) {
			skipBlank();
			if (text[index] === "]") {
				index += 1;
				return items;
			}
			items.push(value([...path, items.length]));
			skipBlank();
			if (text[index] === ",") index += 1;
			else if (text[index] !== "]") fail("expected , or ] in the array");
		}
	};
	/** Puts `item` at the dotted `parts` below `table`, creating tables on the way as `origin`. */
	const assign = (table, parts, item, path, origin) => {
		let current = table;
		const walked = [...path];
		for (const part of parts.slice(0, -1)) {
			walked.push(part);
			const next = own(current, part);
			if (next === void 0) {
				const created = newTable(origin);
				put(current, part, created);
				current = created;
			} else if (isTable(next)) {
				if (origins.get(next) === "inline" && origin !== "inline") fail(`${walked.join(".")} is an inline table, which cannot be extended`);
				if (origins.get(next) === "header" && origin === "dotted") fail(`${walked.join(".")} is a table defined by a header, which dotted keys cannot extend`);
				current = next;
			} else fail(`${walked.join(".")} is already a value, not a table`);
		}
		const last = parts.at(-1);
		if (Object.hasOwn(current, last)) fail(`${[...walked, last].join(".")} is defined twice`);
		put(current, last, item);
		record([...walked, last]);
	};
	const inlineTable = (path) => {
		index += 1;
		const table = newTable("inline");
		for (;;) {
			skipBlank();
			if (text[index] === "}") {
				index += 1;
				return table;
			}
			const parts = key();
			skipSpaces();
			if (text[index] !== "=") fail("expected = after the key");
			index += 1;
			skipSpaces();
			const keyLine = line;
			const item = value([...path, ...parts]);
			const valueLine = line;
			line = keyLine;
			assign(table, parts, item, path, "inline");
			line = valueLine;
			skipBlank();
			if (text[index] === ",") index += 1;
			else if (text[index] !== "}") fail("expected , or } in the inline table");
		}
	};
	const root = newTable("header");
	let current = root;
	let currentPath = [];
	/** Walks the header's parent keys, creating implicit tables and stepping into the last element of arrays of tables. */
	const parentOf = (parts) => {
		let table = root;
		const path = [];
		for (const part of parts.slice(0, -1)) {
			path.push(part);
			const next = own(table, part);
			if (next === void 0) {
				const created = newTable("implicit");
				put(table, part, created);
				table = created;
			} else if (Array.isArray(next) && arraysOfTables.has(next)) {
				const element = next.at(-1);
				if (!isTable(element)) return fail(`${path.join(".")} is already a value, not a table`);
				path.push(next.length - 1);
				table = element;
			} else if (isTable(next)) {
				if (origins.get(next) === "inline") fail(`${path.join(".")} is an inline table, which cannot be extended`);
				table = next;
			} else fail(`${path.join(".")} is already a value, not a table`);
		}
		return {
			table,
			path
		};
	};
	const header = () => {
		const isArray = text.startsWith("[[", index);
		index += isArray ? 2 : 1;
		skipSpaces();
		const parts = key();
		skipSpaces();
		if (!text.startsWith(isArray ? "]]" : "]", index)) fail(`expected ${isArray ? "]]" : "]"} after the table name`);
		index += isArray ? 2 : 1;
		const name = parts.join(".");
		const { table: parent, path } = parentOf(parts);
		const last = parts.at(-1);
		const existing = own(parent, last);
		if (isArray) {
			let list;
			if (existing === void 0) {
				list = [];
				arraysOfTables.add(list);
				put(parent, last, list);
			} else if (Array.isArray(existing) && arraysOfTables.has(existing)) list = existing;
			else return fail(`${name} is not an array of tables`);
			current = newTable("header");
			currentPath = [
				...path,
				last,
				list.length
			];
			list.push(current);
		} else {
			if (existing === void 0) {
				current = newTable("header");
				put(parent, last, current);
			} else if (isTable(existing)) {
				const origin = origins.get(existing);
				if (origin === "inline") fail(`${name} is an inline table, which cannot be extended`);
				if (origin !== "implicit") fail(`table ${name} is defined twice`);
				origins.set(existing, "header");
				current = existing;
			} else return fail(Array.isArray(existing) ? `${name} is an array, not a table` : `${name} is already a value, not a table`);
			currentPath = [...path, last];
		}
		record(currentPath);
		endOfLine();
	};
	const keyValue = () => {
		const parts = key();
		skipSpaces();
		if (text[index] !== "=") fail("expected = after the key");
		index += 1;
		skipSpaces();
		const keyLine = line;
		const item = value([...currentPath, ...parts]);
		const valueLine = line;
		line = keyLine;
		assign(current, parts, item, currentPath, "dotted");
		line = valueLine;
		endOfLine();
	};
	for (;;) {
		skipBlank();
		if (index >= text.length) break;
		if (text[index] === "[") header();
		else keyValue();
	}
	return {
		root,
		lineOf: (path) => lines.get(JSON.stringify(path))
	};
}
/** The value at a key path of a parsed document, or undefined when a key on the way is missing or not a table. */
function tomlValueAt(document, path) {
	let node = document.root;
	for (const key of path) node = typeof node === "object" && node !== null && !Array.isArray(node) && !(node instanceof TomlDateTime) && Object.hasOwn(node, key) ? node[key] : void 0;
	return node;
}

// src/detect/workflows.ts
const NPM_GLOBAL_UPGRADE = /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+npm@([^\s'"`;&|]+)/gu;
function scalarText(node) {
	if (!(0, import_dist.isScalar)(node) || node.value === null || node.value === void 0) return void 0;
	return String(node.value);
}
function findAction(actions, uses) {
	const name = uses.split("@", 1)[0]?.toLowerCase();
	return actions.find((action) => action.action.toLowerCase() === name);
}
function readWorkflows(repository, facts) {
	const { directory, extensions } = facts.workflows;
	const files = repository.listFiles(directory).filter((name) => extensions.some((extension) => name.endsWith(extension))).map((name) => joinPath(directory, name));
	const findings = {
		files,
		versions: [],
		installs: []
	};
	for (const file of files) {
		const text = repository.readText(file);
		if (text === void 0) continue;
		const lineCounter = new import_dist.LineCounter();
		const document = (0, import_dist.parseDocument)(text, { lineCounter });
		if (document.errors.length > 0) {
			const message = document.errors[0]?.message.split("\n", 1)[0] ?? "invalid YAML";
			repository.warn("invalid-file", `cannot parse ${file}: ${message}`, [file]);
			continue;
		}
		const lineOf = (node) => node.range === void 0 || node.range === null ? void 0 : lineCounter.linePos(node.range[0]).line;
		const declare = (tool, value, node) => {
			const line = lineOf(node);
			findings.versions.push({
				tool,
				declaration: {
					...value,
					source: "github-actions",
					file,
					...line === void 0 ? {} : { line }
				}
			});
		};
		const jobs = document.get("jobs");
		if (!(0, import_dist.isMap)(jobs)) continue;
		for (const job of jobs.items) {
			const steps = (0, import_dist.isMap)(job.value) ? job.value.get("steps") : void 0;
			if (!(0, import_dist.isSeq)(steps)) continue;
			for (const step of steps.items) {
				if (!(0, import_dist.isMap)(step)) continue;
				const uses = scalarText(step.get("uses", true));
				const action = uses === void 0 ? void 0 : findAction(facts.setupActions, uses);
				if (action !== void 0) {
					for (const tool of action.installs) findings.installs.push({
						tool,
						file
					});
					const inputs = step.get("with");
					if ((0, import_dist.isMap)(inputs)) for (const input of action.inputs) {
						const node = inputs.get(input.name, true);
						const value = scalarText(node);
						if (value === void 0 || !(0, import_dist.isScalar)(node)) continue;
						if (input.kind === "version" && input.tool !== void 0) declare(input.tool, { version: value }, node);
						if (input.kind === "version-file" && input.tool !== void 0) declare(input.tool, { versionFile: value }, node);
						if (input.kind === "runtime") {
							const [name, version] = value.split("@");
							if ((name === "node" || name === "bun" || name === "deno") && version !== void 0 && version !== "") declare(name, { version }, node);
						}
					}
				}
				const run = step.get("run", true);
				if ((0, import_dist.isScalar)(run) && typeof run.value === "string" && run.range !== void 0 && run.range !== null) {
					const source = text.slice(run.range[0], run.range[1]);
					for (const match of source.matchAll(NPM_GLOBAL_UPGRADE)) {
						const line = lineCounter.linePos(run.range[0] + match.index).line;
						findings.versions.push({
							tool: "npm",
							declaration: {
								version: match[1] ?? "",
								source: "github-actions",
								file,
								line
							}
						});
					}
				}
			}
		}
	}
	return findings;
}

// src/detect/wildcard.ts
/** Whether `text` matches `pattern`, in which `*` stands for any run of characters (including none). */
function matchSegment(text, pattern) {
	let at = 0;
	let index = 0;
	let star = -1;
	let resume = 0;
	while (at < text.length) if (index < pattern.length && pattern[index] === "*") {
		star = index;
		index += 1;
		resume = at;
	} else if (index < pattern.length && pattern[index] === text[at]) {
		index += 1;
		at += 1;
	} else if (star !== -1) {
		index = star + 1;
		resume += 1;
		at = resume;
	} else return false;
	while (pattern[index] === "*") index += 1;
	return index === pattern.length;
}
/** Whether `text` matches `pattern`, in which `*` stands for any characters except `/`. */
function wildcardMatch(text, pattern) {
	const parts = text.split("/");
	const patternParts = pattern.split("/");
	return parts.length === patternParts.length && parts.every((part, index) => matchSegment(part, patternParts[index] ?? ""));
}

// src/detect/workspaces.ts
function segmentsOf(pattern) {
	const segments = [];
	for (const segment of pattern.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "**") {
			if (segments.at(-1)?.kind !== "any-depth") segments.push({ kind: "any-depth" });
		} else segments.push({
			kind: "pattern",
			pattern: segment
		});
	}
	return segments;
}
/**
* Adds to `found` the directories under `directory` that match the segments from `index` on. Each pair of directory
* and segment is visited once, so several ** in one pattern cannot multiply the walk.
*/
function matchDirectories(repository, segments, index, directory, found, visited) {
	const key = `${index}\0${directory}`;
	if (visited.has(key)) return;
	visited.add(key);
	const segment = segments[index];
	if (segment === void 0) {
		found.add(directory);
		return;
	}
	if (segment.kind === "any-depth") {
		matchDirectories(repository, segments, index + 1, directory, found, visited);
		for (const child of repository.listDirectories(directory)) matchDirectories(repository, segments, index, joinPath(directory, child), found, visited);
		return;
	}
	for (const child of repository.listDirectories(directory)) if (wildcardMatch(child, segment.pattern)) matchDirectories(repository, segments, index + 1, joinPath(directory, child), found, visited);
}
/** Package directories (without the root) matched by the patterns that contain one of the manifests. */
function expandWorkspaces(repository, patterns, manifests, declaredIn) {
	const included = /* @__PURE__ */ new Set();
	const excluded = /* @__PURE__ */ new Set();
	for (const raw of patterns) {
		const negated = raw.startsWith("!");
		const pattern = negated ? raw.slice(1) : raw;
		if (pattern.startsWith("/") || pattern.split("/").includes("..")) {
			repository.warn("workspace-outside-repository", `workspace pattern "${raw}" points outside the repository`, [declaredIn]);
			continue;
		}
		matchDirectories(repository, segmentsOf(pattern), 0, ".", negated ? excluded : included, /* @__PURE__ */ new Set());
	}
	return [...included].filter((directory) => directory !== "." && !excluded.has(directory)).filter((directory) => manifests.some((manifest) => repository.isFile(joinPath(directory, manifest)))).sort();
}

// src/detect/index.ts
const EVIDENCE_ORDER = [
	"lockfile",
	"packageManager",
	"devEngines",
	"config",
	"ci",
	"default"
];
const SOURCE_ORDER = [
	"packageManager",
	"tool-config",
	"devEngines",
	"volta",
	"tool-versions",
	"github-actions"
];
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringList(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : void 0;
}
/** devEngines entries may be one object or a list of objects with a name and an optional version. */
function devEngineEntries(value) {
	return (Array.isArray(value) ? value : [value]).flatMap((entry) => isObject(entry) && typeof entry["name"] === "string" ? [{
		name: entry["name"],
		...typeof entry["version"] === "string" ? { version: entry["version"] } : {}
	}] : []);
}
function compareVersions(a, b) {
	return SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
}
function compareEvidence(a, b) {
	return EVIDENCE_ORDER.indexOf(a.kind) - EVIDENCE_ORDER.indexOf(b.kind) || a.file.localeCompare(b.file);
}
function byPath(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}
function tomlAt(document, path) {
	return document === void 0 ? void 0 : tomlValueAt(document, path);
}
/** A required version as written; an exact one (==1.2.3) without the operator, so that it counts as pinned. */
function requiredVersionText(value) {
	return /^\s*===?\s*(\d+(?:\.\d+)*)\s*$/u.exec(value)?.[1] ?? value.trim();
}
/** A TOML file, parsed once per repository; undefined when it is missing or cannot be parsed (a warning says so). */
function readToml(repository, file) {
	return repository.parseOnce(file, parseToml);
}
function orList(items) {
	return items.length < 2 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}
var Collector = class {
	evidence = /* @__PURE__ */ new Map();
	versions = /* @__PURE__ */ new Map();
	addEvidence(manager, kind, file) {
		const list = this.evidence.get(manager) ?? [];
		if (!list.some((item) => item.kind === kind && item.file === file)) list.push({
			kind,
			file
		});
		this.evidence.set(manager, list);
	}
	addVersion(tool, declaration) {
		const list = this.versions.get(tool) ?? [];
		list.push(declaration);
		this.versions.set(tool, list);
	}
};
function readPackageJson(repository) {
	if (!repository.isFile("package.json")) return void 0;
	const parsed = repository.parse("package.json", (text) => JSON.parse(text));
	return isObject(parsed) ? parsed : void 0;
}
function readPackageManagerField(repository, facts, manifest, collector) {
	const value = manifest[facts.packageManagerKey];
	if (value === void 0) return void 0;
	const match = typeof value === "string" ? /^(@?[^@\s]+)@([^+\s]+)(?:\+.*)?$/u.exec(value) : null;
	if (match === null) {
		repository.warn("invalid-package-manager", `${facts.packageManagerKey} ${JSON.stringify(value)} is not in the form name@version`, ["package.json"]);
		return;
	}
	const [, name = "", version = ""] = match;
	const manager = facts.managers.find((entry) => entry.id === name);
	if (manager === void 0) {
		repository.warn("invalid-package-manager", `${facts.packageManagerKey} names ${name}, which depcurfew does not know`, ["package.json"]);
		return;
	}
	collector.addEvidence(manager.id, "packageManager", "package.json");
	collector.addVersion(manager.id, {
		version,
		source: "packageManager",
		file: "package.json"
	});
	return manager.id;
}
function readDevEngines(facts, manifest, collector) {
	const devEngines = manifest[facts.devEngines.key];
	if (!isObject(devEngines)) return;
	for (const entry of devEngineEntries(devEngines[facts.devEngines.packageManagerKey])) {
		const manager = facts.managers.find((item) => item.id === entry.name);
		if (manager === void 0) continue;
		collector.addEvidence(manager.id, "devEngines", "package.json");
		if (entry.version !== void 0) collector.addVersion(manager.id, {
			version: entry.version,
			source: "devEngines",
			file: "package.json"
		});
	}
	for (const entry of devEngineEntries(devEngines[facts.devEngines.runtimeKey])) if (entry.name === "node" && entry.version !== void 0) collector.addVersion("node", {
		version: entry.version,
		source: "devEngines",
		file: "package.json"
	});
}
function readVolta(facts, manifest, collector) {
	const volta = manifest[facts.volta.key];
	if (!isObject(volta)) return;
	for (const tool of facts.volta.tools) {
		const version = volta[tool];
		if (typeof version === "string") collector.addVersion(tool, {
			version,
			source: "volta",
			file: "package.json"
		});
	}
}
function readToolVersions(repository, facts, collector) {
	const file = facts.toolVersions.file;
	const text = repository.isFile(file) ? repository.readText(file) : void 0;
	if (text === void 0) return;
	text.split(/\r?\n/u).forEach((raw, index) => {
		const [plugin, version] = (raw.split("#", 1)[0] ?? "").trim().split(/\s+/u);
		const tool = plugin === void 0 ? void 0 : facts.toolVersions.plugins[plugin];
		if (tool !== void 0 && version !== void 0) collector.addVersion(tool, {
			version,
			source: "tool-versions",
			file,
			line: index + 1
		});
	});
}
function yarnVariant(repository, facts, collector) {
	if (repository.isFile("yarn.lock")) {
		const head = repository.readHead("yarn.lock") ?? "";
		if (head.includes(facts.yarn.classicHeader)) return {
			variant: "classic",
			file: "yarn.lock"
		};
		if (new RegExp(`^${facts.yarn.berryMarker}:`, "mu").test(head)) return {
			variant: "berry",
			file: "yarn.lock"
		};
	}
	const declared = collector.versions.get("yarn")?.find((entry) => entry.source === "packageManager");
	if (declared !== void 0 && "version" in declared && /^1\./u.test(declared.version)) return {
		variant: "classic",
		file: "package.json"
	};
	return {
		variant: "berry",
		file: "package.json"
	};
}
function readWorkspaces(repository, facts, manifest) {
	const declarations = [];
	const seen = /* @__PURE__ */ new Set();
	for (const manager of facts.managers) {
		if (manager.workspaces === null) continue;
		const { files, key, objectKey, excludeKey } = manager.workspaces;
		for (const file of files) {
			const id = `${file}#${key}`;
			if (seen.has(id) || !repository.isFile(file)) continue;
			seen.add(id);
			const document = file.endsWith(".toml") ? readToml(repository, file)?.root : readDocument(repository, file, manifest);
			if (!isObject(document)) continue;
			const value = key.split(".").reduce((node, part) => isObject(node) && Object.hasOwn(node, part) ? node[part] : void 0, document);
			const patterns = stringList(value) ?? (objectKey !== null && isObject(value) ? stringList(value[objectKey]) : void 0);
			const excluded = excludeKey !== void 0 && isObject(value) ? stringList(value[excludeKey]) ?? [] : [];
			const manifests = [...new Set(facts.managers.filter((other) => other.ecosystem === manager.ecosystem).flatMap((other) => other.manifests))];
			if (patterns !== void 0) declarations.push({
				file,
				patterns: [...patterns, ...excluded.map((pattern) => `!${pattern}`)],
				manifests
			});
			break;
		}
	}
	if (declarations.length === 0) return null;
	const packages = /* @__PURE__ */ new Set();
	for (const declaration of declarations) for (const directory of expandWorkspaces(repository, declaration.patterns, declaration.manifests, declaration.file)) packages.add(directory);
	return {
		declarations: declarations.map(({ file, patterns }) => ({
			file,
			patterns
		})),
		packages: [...packages].sort(byPath)
	};
}
/** A workspace declaration file: package.json is already parsed, others are YAML or JSONC. */
function readDocument(repository, file, manifest) {
	return file === "package.json" ? manifest : repository.parse(file, /\.ya?ml$/u.test(file) ? (text) => (0, import_dist.parse)(text) : parseJsonc);
}
/** Python tools: a pyproject.toml with the tool's table is configuration, and required versions are pinned versions. */
function readPythonConfig(repository, facts, collector) {
	const project = facts.pythonProject;
	for (const manager of facts.managers) {
		if (manager.pyprojectTable !== null && tomlAt(readToml(repository, project), manager.pyprojectTable.split(".")) !== void 0) collector.addEvidence(manager.id, "config", project);
		const read = manager.configFileOrder?.find((file) => repository.isFile(file));
		for (const { file, path } of manager.requiredVersions) {
			if (read !== void 0 && file !== read) continue;
			const document = readToml(repository, file);
			const value = tomlAt(document, path);
			if (typeof value !== "string") continue;
			const line = document?.lineOf(path);
			collector.addVersion(manager.id, {
				version: requiredVersionText(value),
				source: "tool-config",
				file,
				...line === void 0 ? {} : { line }
			});
		}
	}
}
function configFiles(repository, manager, directories, project) {
	const table = manager.pyprojectTable?.split(".");
	return directories.flatMap((directory) => [...manager.configFiles.map((file) => joinPath(directory, file)).filter((file) => repository.isFile(file)), ...table !== void 0 && tomlAt(readToml(repository, joinPath(directory, project)), table) !== void 0 ? [joinPath(directory, project)] : []]).sort(byPath);
}
/**
* Describes the repository at `root`. Never executes anything from the repository and never leaves it;
* problems with individual files become warnings.
*/
function detectProject(root, tools = knowledgeBase, environment$1 = environment) {
	const repository = new Repository(root);
	const facts = detectionFacts(tools, environment$1);
	const collector = new Collector();
	const managerIds = new Set(facts.managers.map((manager) => manager.id));
	const ecosystemOf = (id) => facts.managers.find((manager) => manager.id === id)?.ecosystem ?? "npm";
	const manifest = readPackageJson(repository);
	const declaredManager = manifest === void 0 ? void 0 : readPackageManagerField(repository, facts, manifest, collector);
	if (manifest !== void 0) {
		readDevEngines(facts, manifest, collector);
		readVolta(facts, manifest, collector);
	}
	readToolVersions(repository, facts, collector);
	readPythonConfig(repository, facts, collector);
	const lockfiles = /* @__PURE__ */ new Map();
	for (const manager of facts.managers) {
		const named = manager.lockfilePattern === null ? [] : repository.listFiles(".").filter((name) => manager.lockfilePattern?.test(name) === true);
		const present = [.../* @__PURE__ */ new Set([...manager.lockfiles.filter((file) => repository.isFile(file)), ...named])].sort(byPath);
		if (present.length > 0) lockfiles.set(manager.id, present);
		for (const file of present) collector.addEvidence(manager.id, "lockfile", file);
		for (const file of manager.configFiles.filter((name) => repository.isFile(name))) collector.addEvidence(manager.id, "config", file);
	}
	const workflows = readWorkflows(repository, facts);
	for (const { tool, file } of workflows.installs) if (managerIds.has(tool)) collector.addEvidence(tool, "ci", file);
	for (const { tool, declaration } of workflows.versions) collector.addVersion(tool, declaration);
	const workspaces = readWorkspaces(repository, facts, manifest);
	const directories = [".", ...workspaces?.packages ?? []];
	const hasEvidence = (ecosystem) => [...collector.evidence.keys()].some((id) => ecosystemOf(id) === ecosystem);
	if (manifest !== void 0 && !hasEvidence("npm")) {
		collector.addEvidence("npm", "default", "package.json");
		repository.warn("package-manager-assumed", "no lockfile, packageManager or devEngines found; assuming npm", ["package.json"]);
	}
	const packageManagers = [];
	for (const manager of facts.managers) {
		const evidence = collector.evidence.get(manager.id);
		if (evidence === void 0) continue;
		const yarn = manager.id === "yarn" ? yarnVariant(repository, facts, collector) : void 0;
		if (yarn?.variant === "classic") repository.warn("yarn-classic-unsupported", "Yarn Classic (1.x) is not supported; depcurfew configures Yarn 2 and later", [yarn.file]);
		packageManagers.push({
			id: manager.id,
			...yarn === void 0 ? {} : { variant: yarn.variant },
			supported: yarn?.variant !== "classic",
			evidence: [...evidence].sort(compareEvidence),
			versions: [...collector.versions.get(manager.id) ?? []].sort(compareVersions),
			configFiles: configFiles(repository, manager, directories, facts.pythonProject)
		});
	}
	const bots = [];
	for (const bot of facts.bots) {
		const files = bot.configFiles.filter((file) => repository.isFile(file));
		if (bot.packageJsonKey !== null && manifest !== void 0 && bot.packageJsonKey in manifest) {
			files.push("package.json");
			repository.warn("renovate-config-in-package-json", "Renovate configuration in package.json is deprecated and depcurfew does not edit it; move it to renovate.json", ["package.json"]);
		}
		if (files.length > 0) bots.push({
			id: bot.id,
			configFiles: files
		});
	}
	const withLockfiles = [...lockfiles.entries()];
	for (const ecosystem of ["npm", "pypi"]) {
		const competing = withLockfiles.filter(([id]) => ecosystemOf(id) === ecosystem && id !== "pip");
		if (competing.length < 2) continue;
		const files = competing.flatMap(([, list]) => list).sort(byPath);
		repository.warn("multiple-lockfiles", `lockfiles of several package managers: ${files.join(", ")}`, files);
	}
	const npmLockfiles = withLockfiles.filter(([id]) => ecosystemOf(id) === "npm");
	if (declaredManager !== void 0 && !lockfiles.has(declaredManager) && npmLockfiles.length > 0) repository.warn("package-manager-mismatch", `${facts.packageManagerKey} names ${declaredManager}, but no ${declaredManager} lockfile exists`, ["package.json"]);
	const python = facts.managers.filter((manager) => manager.ecosystem === "pypi");
	if (repository.isFile(facts.pythonProject) && readToml(repository, facts.pythonProject) !== void 0 && !hasEvidence("pypi")) {
		const tables = python.flatMap((manager) => manager.pyprojectTable === null ? [] : [`[${manager.pyprojectTable}]`]);
		const files = [...python.flatMap((manager) => manager.lockfiles), ...python.flatMap((manager) => manager.manifests.filter((file) => file !== facts.pythonProject))];
		const hatch = repository.isFile(facts.hatch.configFile) || tomlAt(readToml(repository, facts.pythonProject), facts.hatch.pyprojectTable.split(".")) !== void 0;
		repository.warn("python-tool-unknown", `${facts.pythonProject} has no ${orList(tables)} table, and there is no ${orList(files)}; depcurfew cannot tell which tool installs this project, so it configures none${hatch ? ". Hatch has no supply-chain settings of its own: if its environments use the uv installer, add \"uv\" to targets in depcurfew.json" : ""}`, [facts.pythonProject]);
	}
	if (manifest === void 0 && packageManagers.length === 0 && !repository.isFile("package.json") && !repository.isFile(facts.pythonProject)) repository.warn("nothing-detected", "no package.json, deno.json, pyproject.toml, requirements.txt or lockfile found", []);
	return {
		packageManagers,
		node: { versions: [...collector.versions.get("node") ?? []].sort(compareVersions) },
		bots,
		workspaces,
		npmrcFiles: directories.map((directory) => joinPath(directory, ".npmrc")).filter((file) => repository.isFile(file)).sort(byPath),
		workflows: workflows.files,
		warnings: [...repository.warnings].sort((a, b) => a.code.localeCompare(b.code) || a.files.join().localeCompare(b.files.join()))
	};
}

// src/apply/requirements.ts
/** "a", "a and b", "a, b and c". */
function listing(items) {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}
function describeRequirements(requirements) {
	const groups = /* @__PURE__ */ new Map();
	for (const { setting, since, disputed } of requirements) {
		const group = groups.get(since) ?? {
			settings: [],
			disputed: false
		};
		if (!group.settings.includes(setting)) group.settings.push(setting);
		group.disputed ||= disputed === true;
		groups.set(since, group);
	}
	const order = (a, b) => compareVersions$1(parseVersion(a) ?? [
		0,
		0,
		0
	], parseVersion(b) ?? [
		0,
		0,
		0
	]);
	const text = [...groups.entries()].sort(([a], [b]) => order(a, b)).map(([since, group]) => `${listing(group.settings)} (since ${since})`).join(", ");
	return [...groups.values()].some((group) => group.disputed) ? `${text}; where official sources disagree on the version, depcurfew assumes the later one` : text;
}

// src/policy/python-names.ts
const [rule] = evidenceOf(environment.python.nameNormalization);
const SEPARATORS = new RegExp(rule?.value.separators ?? "[-_.]+", "gu");
const REPLACEMENT = rule?.value.replacement ?? "-";
/** The normalized form of a Python package name or name pattern; `*` stays as it is. */
function normalizePythonName(name) {
	return name.replace(SEPARATORS, REPLACEMENT).toLowerCase();
}

// src/doctor/python-lockfiles.ts
const WHEEL = evidenceOf(environment.python.wheelExtension)[0]?.value ?? ".whl";
const SDISTS = evidenceOf(environment.python.sourceDistributionExtensions)[0]?.value ?? [];
function text$1(value) {
	return typeof value === "string" ? value : void 0;
}
function list$1(value) {
	return Array.isArray(value) ? value : [];
}
function strings$1(value) {
	return list$1(value).filter((item) => typeof item === "string");
}
function isWheel(location) {
	return (location.split(/[?#]/u, 1)[0] ?? "").toLowerCase().endsWith(WHEEL);
}
function entry(name, spec, source, builds, line) {
	return {
		name: normalizePythonName(name),
		spec,
		source,
		installScript: builds,
		anchor: name,
		...line === void 0 ? {} : { line }
	};
}
/** uv.lock: [[package]] with source = { registry | git | url | path | directory | editable | virtual = ... }. */
function uvEntries(input, format, workspaces) {
	const document = parseToml(input);
	const keys = isRecord(format["sources"]) ? format["sources"] : {};
	const kind = (source) => Object.entries(keys).flatMap(([name, key]) => typeof key === "string" && typeof source[key] === "string" ? [[name, source[key]]] : [])[0];
	const members = /* @__PURE__ */ new Set([".", ...workspaces]);
	return list$1(document.root[String(format["packages"])]).flatMap((item, index) => {
		if (!isRecord(item) || typeof item["name"] !== "string") return [];
		const line = document.lineOf([String(format["packages"]), index]);
		const found = isRecord(item["source"]) ? kind(item["source"]) : void 0;
		if (found === void 0) return [entry(item["name"], "no source given", "unknown", void 0, line)];
		const [name, location] = found;
		const wheels = list$1(item[String(format["wheels"])]);
		switch (name) {
			case "registry": return [entry(item["name"], location, "registry", item[String(format["sdist"])] !== void 0 && wheels.length === 0, line)];
			case "git": return [entry(item["name"], location, "git", true, line)];
			case "remoteTarball": return [entry(item["name"], location, "remoteTarball", !isWheel(location), line)];
			case "file": return [entry(item["name"], location, "file", !isWheel(location), line)];
			case "directory":
			case "editable": return members.has(location) ? [entry(item["name"], location, "workspace", false, line)] : [entry(item["name"], location, "directory", true, line)];
			case "virtual": return [entry(item["name"], location, "workspace", false, line)];
			default: return [entry(item["name"], location, "unknown", void 0, line)];
		}
	});
}
/** poetry.lock: [[package]] without [package.source] comes from PyPI; files list every distribution. */
function poetryEntries(input, format) {
	const document = parseToml(input);
	const types = isRecord(format["sources"]) ? format["sources"] : {};
	const kindOf = (type) => Object.entries(types).find(([, value]) => value === type)?.[0];
	return list$1(document.root[String(format["packages"])]).flatMap((item, index) => {
		if (!isRecord(item) || typeof item["name"] !== "string") return [];
		const line = document.lineOf([String(format["packages"]), index]);
		const files = list$1(item[String(format["files"])]).map((file) => isRecord(file) ? text$1(file["file"]) : void 0).filter((file) => file !== void 0);
		const source = item[String(format["source"])];
		if (!isRecord(source)) return [entry(item["name"], "PyPI", "registry", files.length > 0 && !files.some(isWheel), line)];
		const url = text$1(source["url"]) ?? "";
		const kind = kindOf(text$1(source["type"]) ?? "");
		switch (kind) {
			case "registry": return [entry(item["name"], text$1(source["reference"]) ?? url, "registry", files.length > 0 && !files.some(isWheel), line)];
			case "git": return [entry(item["name"], url, "git", true, line)];
			case "remoteTarball":
			case "file": return [entry(item["name"], url, kind, !isWheel(url), line)];
			case "directory": return [entry(item["name"], url, "directory", true, line)];
			default: return [entry(item["name"], `${text$1(source["type"]) ?? "unknown"} ${url}`.trim(), "unknown", void 0, line)];
		}
	});
}
/** pdm.lock: [[package]] with files from an index, or a VCS repository (git = …), a url or a local path instead. */
function pdmEntries(input, format) {
	const document = parseToml(input);
	const key = (name) => String(format[name]);
	const vcs = strings$1(format["vcs"]);
	return list$1(document.root[key("packages")]).flatMap((item, index) => {
		if (!isRecord(item) || typeof item["name"] !== "string") return [];
		const line = document.lineOf([key("packages"), index]);
		const repository = vcs.find((name) => typeof item[name] === "string");
		if (repository !== void 0) return [entry(item["name"], String(item[repository]), repository === "git" ? "git" : "unknown", true, line)];
		const url = text$1(item[key("url")]);
		if (url !== void 0) return [entry(item["name"], url, "remoteTarball", !isWheel(url), line)];
		const path = text$1(item[key("path")]);
		if (path !== void 0) {
			const archive = [WHEEL, ...SDISTS].some((extension) => path.toLowerCase().endsWith(extension));
			return [entry(item["name"], path, archive ? "file" : "directory", archive ? !isWheel(path) : true, line)];
		}
		const files = list$1(item[key("files")]).map((file) => isRecord(file) ? text$1(file[key("file")]) : void 0).filter((file) => file !== void 0);
		return [entry(item["name"], "an index", "registry", files.length > 0 && !files.some(isWheel), line)];
	});
}
/**
* Pipfile.lock: every key but _meta is a category of packages. Git, remote file and local path entries are built;
* for index packages the hashes do not tell wheels from source distributions, so whether they are built is unknown.
*/
function pipfileLockEntries(input, format) {
	const document = JSON.parse(input);
	if (!isRecord(document)) throw new Error("Pipfile.lock is not a JSON object");
	const key = (name) => String(format[name]);
	const entries = [];
	for (const [category, packages] of Object.entries(document)) {
		if (category === key("meta") || !isRecord(packages)) continue;
		for (const [name, item] of Object.entries(packages)) {
			if (!isRecord(item)) continue;
			const git = text$1(item[key("git")]);
			const file = text$1(item[key("file")]);
			const path = text$1(item[key("path")]);
			const anchored = (found) => ({
				...found,
				anchor: JSON.stringify(name)
			});
			if (git !== void 0) entries.push(anchored(entry(name, git, "git", true, void 0)));
			else if (file !== void 0) entries.push(anchored(entry(name, file, "remoteTarball", !isWheel(file), void 0)));
			else if (path !== void 0) entries.push(anchored(entry(name, path, "directory", true, void 0)));
			else entries.push(anchored(entry(name, "an index", "registry", void 0, void 0)));
		}
	}
	return entries;
}
/** pylock.toml (PEP 751): each [[packages]] has one of vcs, directory, archive, or sdist and wheels from an index. */
function pylockEntries(input, format) {
	const document = parseToml(input);
	const key = (name) => String(format[name]);
	return list$1(document.root[key("packages")]).flatMap((item, index) => {
		if (!isRecord(item) || typeof item["name"] !== "string") return [];
		const line = document.lineOf([key("packages"), index]);
		const location = (value) => isRecord(value) ? text$1(value["url"]) ?? text$1(value["path"]) ?? "" : "";
		const vcs = item[key("vcs")];
		if (isRecord(vcs)) return [entry(item["name"], location(vcs), text$1(vcs["type"]) === "git" ? "git" : "unknown", true, line)];
		const directory = item[key("directory")];
		if (isRecord(directory)) return [entry(item["name"], location(directory), "directory", true, line)];
		const archive = item[key("archive")];
		if (isRecord(archive)) {
			const where = location(archive);
			return [entry(item["name"], where, text$1(archive["url"]) !== void 0 ? "remoteTarball" : "file", !isWheel(where), line)];
		}
		const wheels = list$1(item[key("wheels")]);
		const sdist = item[key("sdist")];
		if (wheels.length === 0 && !isRecord(sdist)) return [entry(item["name"], "no source given", "unknown", void 0, line)];
		return [entry(item["name"], text$1(item[key("index")]) ?? "an index", "registry", isRecord(sdist) && wheels.length === 0, line)];
	});
}
/** The logical lines of a requirements file: continuations joined, comments removed, with the line each starts on. */
function requirementsLines(input, format) {
	const comment = String(format["comment"]);
	const continuation = String(format["continuation"]);
	const commentPattern = new RegExp(`(^|\\s)${comment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*$`, "u");
	const lines = input.split(/\r?\n/u);
	const result = [];
	for (let index = 0; index < lines.length; index++) {
		const start = index;
		let line = (lines[index] ?? "").replace(commentPattern, "");
		while (line.trimEnd().endsWith(continuation) && index + 1 < lines.length) {
			index += 1;
			line = `${line.trimEnd().slice(0, -continuation.length)} ${(lines[index] ?? "").replace(commentPattern, "")}`;
		}
		const text = line.trim();
		if (text !== "") result.push({
			text,
			line: start + 1
		});
	}
	return result;
}
const PYTHON_NAME$1 = new RegExp(evidenceOf(environment.python.namePattern)[0]?.value ?? "^[A-Za-z0-9][A-Za-z0-9._-]*$", "iu");
/** The facts about pip requirements files in one record: syntax, includes (-r, -c) and how pip tells paths and URLs. */
function requirementsFormatOf(tool) {
	const record = (key) => {
		const fact = tool.extra?.[key];
		const value = fact === void 0 ? void 0 : values$1(fact)[0];
		return isRecord(value) ? value : {};
	};
	return {
		...record("requirementsFormat"),
		includes: record("requirementsIncludes"),
		paths: record("requirementsPaths")
	};
}
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
/** The requirements and constraints files a requirements file includes (-r, -c), as written, with their lines. */
function requirementsIncludes(input, format) {
	const includes = isRecord(format["includes"]) ? format["includes"] : {};
	const options = [...strings$1(includes["requirements"]), ...strings$1(includes["constraints"])];
	const short = options.filter((option) => !option.startsWith("--")).map(escapeRegExp);
	const long = options.filter((option) => option.startsWith("--")).map(escapeRegExp);
	const pattern = new RegExp(`^(?:(?:${short.join("|") || "(?!)"})\\s*|(?:${long.join("|") || "(?!)"})(?:\\s+|=))(\\S+)`, "u");
	return requirementsLines(input, format).flatMap(({ text: body, line }) => {
		const path = pattern.exec(body)?.[1];
		return path === void 0 ? [] : [{
			path,
			line
		}];
	});
}
/**
* Classifies one requirement (without options or environment markers): a VCS URL, a URL, a local archive or
* directory, the project itself, or a registry package. `editable` is set for the value of -e, which is always a path
* or a VCS URL.
*/
function requirementSource(requirement, format, editable) {
	const vcs = isRecord(format["vcs"]) ? format["vcs"] : {};
	const gitPrefixes = strings$1(vcs["git"]);
	const otherPrefixes = strings$1(vcs["other"]);
	const egg = new RegExp(`${escapeRegExp(String(format["egg"]))}([^&\\s]+)`, "u");
	const paths = isRecord(format["paths"]) ? format["paths"] : {};
	const separators = strings$1(paths["separators"]);
	const currentDirectory = String(paths["currentDirectory"]);
	const archives = strings$1(paths["archiveExtensions"]);
	const urlSchemes = new RegExp(`^(?:${strings$1(paths["urlSchemes"]).map(escapeRegExp).join("|") || "(?!)"})://`, "iu");
	const fileScheme = new RegExp(`^${escapeRegExp(String(paths["fileScheme"]))}(//)?`, "iu");
	const reference = new RegExp(`^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\[[^\\]]*\\])?\\s*${escapeRegExp(String(format["direct"]).trim())}\\s*(.+)$`, "u");
	const looksLikePath = (text) => separators.some((separator) => text.includes(separator)) || text.startsWith(currentDirectory);
	const isArchive = (text) => archives.some((extension) => text.toLowerCase().endsWith(extension));
	const named = reference.exec(requirement);
	const target = named?.[2] ?? requirement;
	const name = named?.[1] ?? egg.exec(target)?.[1];
	const located = (source, location, builds) => ({
		source,
		target: location,
		...name !== void 0 && PYTHON_NAME$1.test(name) ? { name } : {},
		builds
	});
	if (gitPrefixes.some((prefix) => target.startsWith(prefix))) return located("git", target, true);
	if (otherPrefixes.some((prefix) => target.startsWith(prefix))) return located("unknown", target, true);
	if (urlSchemes.test(target)) return located("remoteTarball", target, !isWheel(target));
	if (fileScheme.test(target) || looksLikePath(target) || isArchive(target) || editable) {
		const path = target.replace(fileScheme, "");
		if (/^\.\/?$/u.test(path)) return {
			source: "workspace",
			target,
			name: ".",
			builds: false
		};
		const archive = isArchive(path);
		return located(archive ? "file" : "directory", path, archive ? !isWheel(path) : true);
	}
	const registryName = /^[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(requirement)?.[0];
	return {
		source: "registry",
		target: requirement,
		...registryName === void 0 ? {} : { name: registryName },
		builds: void 0
	};
}
/** A pip requirements file: VCS and URL requirements, local paths and registry requirements (which may or may not have wheels). */
function requirementsEntries(input, format) {
	const editable = strings$1(format["editable"]);
	const entries = [];
	for (const { text: body, line: lineNumber } of requirementsLines(input, format)) {
		let requirement = body;
		const flag = editable.find((option) => requirement.startsWith(`${option} `) || requirement.startsWith(`${option}=`));
		if (flag !== void 0) requirement = requirement.slice(flag.length + 1).trim();
		else if (requirement.startsWith("-")) continue;
		requirement = (requirement.split(/\s+--?[a-z]/u, 1)[0] ?? requirement).split(";", 1)[0]?.trim() ?? requirement;
		const found = requirementSource(requirement, format, flag !== void 0);
		if (found.source === "workspace") entries.push({
			...entry("", found.target, "workspace", false, lineNumber),
			name: "."
		});
		else if (found.source === "registry") {
			if (found.name !== void 0) entries.push(entry(found.name, requirement, "registry", void 0, lineNumber));
		} else if (found.name !== void 0) entries.push(entry(found.name, found.target, found.source, found.builds, lineNumber));
		else entries.push({
			...entry("", found.target, found.source, found.builds, lineNumber),
			name: found.target,
			unnamed: true
		});
	}
	return entries;
}

// src/doctor/lockfiles.ts
/** Lockfiles are often larger than configuration files. */
const MAX_LOCKFILE_SIZE = 67108864;
/**
* Finds the 1-based line of each anchor. Rules ask in the order the entries were parsed, which is the order of the
* file, so each search continues where the last one stopped and a large lockfile is not scanned once per entry.
*/
function lineFinder(text, start = 0) {
	let newlines;
	let cursor = start;
	return (anchor) => {
		let offset = text.indexOf(anchor, cursor);
		if (offset === -1) offset = text.indexOf(anchor);
		if (offset === -1) return void 0;
		cursor = offset + anchor.length;
		if (newlines === void 0) {
			newlines = [];
			for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines.push(index);
		}
		let low = 0;
		let high = newlines.length;
		while (low < high) {
			const middle = low + high >> 1;
			if ((newlines[middle] ?? 0) < offset) low = middle + 1;
			else high = middle;
		}
		return low + 1;
	};
}
function strings(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
/** Splits name@spec, where the name may be scoped and the spec may contain @ (git@host). */
function splitSpec(key) {
	const at = key.startsWith("@") ? key.indexOf("@", key.indexOf("/") + 1) : key.indexOf("@");
	return at <= 0 ? {
		name: key,
		spec: ""
	} : {
		name: key.slice(0, at),
		spec: key.slice(at + 1)
	};
}
const HTTP = /^https?:\/\//u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
/** Where npm installs the dependency `name` of the package at `from`: its own node_modules, else the nearest parent's. */
function installedAt(packages, from, name) {
	for (let base = from;;) {
		const location = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
		if (location in packages) return location;
		if (base === "") return void 0;
		const parent = base.lastIndexOf("/node_modules/");
		base = parent === -1 ? "" : base.slice(0, parent);
	}
}
function urlPath(url) {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}
/** Packages that overrides (npm, root package.json only) replace with a tarball URL, at any depth of nesting. */
function urlOverrides(overrides, parent, selfKey, found = []) {
	if (!isRecord(overrides)) return found;
	for (const [key, value] of Object.entries(overrides)) {
		const name = key === selfKey ? parent : splitSpec(key).name;
		if (typeof value === "string") {
			const path = HTTP.test(value) ? urlPath(value) : "";
			if (name !== void 0 && path !== "") found.push({
				name,
				path
			});
		} else urlOverrides(value, name, selfKey, found);
	}
	return found;
}
function npmEntries(text, format, workspaces, manifest, overridesFormat) {
	const document = JSON.parse(text);
	if (!isRecord(document) || !isRecord(document["packages"])) throw new UnsupportedLockfile("it has no \"packages\" section (lockfileVersion 1 is not read)");
	const packages = document["packages"];
	const registry = new RegExp(String(format["registryTarball"]), "u");
	const scriptsKey = String(format["installScripts"]);
	const fields = strings(format["dependencyFields"]);
	const fromUrl = /* @__PURE__ */ new Set();
	for (const [key, value] of Object.entries(packages)) {
		if (!isRecord(value)) continue;
		for (const field of fields) {
			const dependencies = value[field];
			if (!isRecord(dependencies)) continue;
			for (const [name, spec] of Object.entries(dependencies)) {
				const location = typeof spec === "string" && HTTP.test(spec) ? installedAt(packages, key, name) : void 0;
				if (location !== void 0) fromUrl.add(location);
			}
		}
	}
	const overrides = overridesFormat !== void 0 && isRecord(manifest) ? urlOverrides(manifest[String(overridesFormat["field"])], void 0, String(overridesFormat["selfKey"])) : [];
	const entries = [];
	for (const [key, value] of Object.entries(packages)) {
		if (!key.includes("node_modules/") || !isRecord(value)) continue;
		const name = typeof value["name"] === "string" ? value["name"] : key.slice(key.lastIndexOf("node_modules/") + 13);
		const resolved = typeof value["resolved"] === "string" ? value["resolved"] : "";
		const version = typeof value["version"] === "string" ? value["version"] : "";
		const spec = resolved !== "" || format["specWithoutResolved"] !== "version" ? resolved : version;
		let source = "unknown";
		if (value[String(format["linkFlag"])] === true) source = workspaces.includes(resolved) ? "workspace" : "directory";
		else if (strings(format["gitPrefixes"]).some((prefix) => spec.startsWith(prefix))) source = "git";
		else if (spec.startsWith(String(format["filePrefix"]))) source = /\.(?:tgz|tar\.gz)$/u.test(spec) ? "file" : "directory";
		else if (HTTP.test(spec)) {
			const overridden = overrides.some((override) => override.name === name && urlPath(spec).endsWith(override.path));
			source = registry.test(spec) && !fromUrl.has(key) && !overridden ? "registry" : "remoteTarball";
		} else if (resolved === "" && (spec === "" || EXACT_VERSION.test(spec))) source = "registry";
		entries.push({
			name,
			spec,
			source,
			installScript: value[scriptsKey] === true,
			anchor: `${JSON.stringify(key)}: {`
		});
	}
	return entries;
}
/** The project lockfile of a pnpm-lock.yaml and where it starts: the last document when a boot document comes first. */
function pnpmGraph(text, documents) {
	const marker = documents?.["bootMarker"];
	if (typeof marker !== "string" || documents?.["graph"] !== "last" || text.split(/\r?\n/u, 1)[0] !== marker) return {
		document: (0, import_dist.parse)(text),
		start: 0
	};
	const parsed = (0, import_dist.parseAllDocuments)(text);
	const all = Array.isArray(parsed) ? parsed : [parsed];
	for (const document of all) if (document.errors.length > 0) throw document.errors[0];
	const last = all.at(-1);
	return {
		document: last?.toJS(),
		start: last?.range[0] ?? 0
	};
}
function pnpmEntries(text, format, documents) {
	const { document, start } = pnpmGraph(text, documents);
	if (!isRecord(document)) return {
		entries: [],
		start
	};
	if (!String(document["lockfileVersion"]).startsWith("9")) throw new UnsupportedLockfile(`its lockfileVersion ${String(document["lockfileVersion"])} is not read; depcurfew reads 9.0`);
	const hosts = strings(format["gitHostedTarballHosts"]);
	const entries = [];
	const packages = isRecord(document["packages"]) ? document["packages"] : {};
	for (const [key, value] of Object.entries(packages)) {
		const { name, spec } = splitSpec(key);
		const resolution = isRecord(value) && isRecord(value["resolution"]) ? value["resolution"] : {};
		const tarball = typeof resolution["tarball"] === "string" ? resolution["tarball"] : "";
		let host = "";
		try {
			host = HTTP.test(tarball) ? new URL(tarball).hostname : HTTP.test(spec) ? new URL(spec).hostname : "";
		} catch {
			host = "";
		}
		let source = "registry";
		if (spec.startsWith(String(format["gitKeyPrefix"])) || resolution["type"] === format["gitType"]) source = "git";
		else if (resolution[String(format["gitHostedFlag"])] === true || host !== "" && hosts.includes(host)) source = "git";
		else if (resolution["type"] === format["directoryType"]) source = "directory";
		else if (spec.startsWith("file:")) source = "file";
		else if (HTTP.test(spec)) source = "remoteTarball";
		entries.push({
			name,
			spec,
			source,
			installScript: void 0,
			anchor: key
		});
	}
	const importers = isRecord(document["importers"]) ? document["importers"] : {};
	for (const importer of Object.values(importers)) {
		if (!isRecord(importer)) continue;
		for (const group of [
			"dependencies",
			"devDependencies",
			"optionalDependencies"
		]) {
			const dependencies = isRecord(importer[group]) ? importer[group] : {};
			for (const [name, dependency] of Object.entries(dependencies)) {
				if (!isRecord(dependency) || typeof dependency["version"] !== "string") continue;
				const specifier = typeof dependency["specifier"] === "string" ? dependency["specifier"] : "";
				if (dependency["version"].startsWith("link:") && !specifier.startsWith("workspace:")) entries.push({
					name,
					spec: specifier,
					source: "directory",
					installScript: void 0,
					anchor: `specifier: ${specifier}`
				});
			}
		}
	}
	return {
		entries,
		start
	};
}
function yarnSource(locator, format) {
	if (locator.startsWith(String(format["workspace"]))) return "workspace";
	if (locator.startsWith(String(format["registry"]))) return "registry";
	if (locator.startsWith(String(format["patch"]))) return yarnSource(splitSpec(decodeURIComponent(locator.slice(String(format["patch"]).length).split("#")[0] ?? "")).spec, format);
	if (locator.startsWith(String(format["file"]))) {
		const path = locator.slice(String(format["file"]).length).split("#")[0]?.split("::")[0] ?? "";
		return new RegExp(String(format["tarball"]), "u").test(path) ? "file" : "directory";
	}
	if (strings(format["directory"]).some((prefix) => locator.startsWith(prefix))) return "directory";
	if (locator.includes(String(format["gitCommit"])) || /^(git\+|git:|ssh:|git@|github:)/u.test(locator)) return "git";
	if (HTTP.test(locator)) return "remoteTarball";
	return "unknown";
}
function yarnEntries(text, format) {
	const document = (0, import_dist.parse)(text);
	if (!isRecord(document)) return [];
	return Object.entries(document).filter(([key, value]) => key !== "__metadata" && isRecord(value) && typeof value["resolution"] === "string").map(([, value]) => {
		const resolution = value["resolution"];
		const { name, spec } = splitSpec(resolution);
		return {
			name,
			spec,
			source: yarnSource(spec, format),
			installScript: void 0,
			anchor: `resolution: "${resolution}"`
		};
	});
}
function bunEntries(text, format) {
	const document = parseJsonc(text);
	const packages = isRecord(document) && isRecord(document["packages"]) ? document["packages"] : {};
	const tarball = new RegExp(String(format["tarball"]), "u");
	const scriptsKey = String(format["installScripts"]);
	const entries = [];
	for (const [key, value] of Object.entries(packages)) {
		if (!Array.isArray(value) || typeof value[0] !== "string") continue;
		const { name, spec } = splitSpec(value[0]);
		let source = "registry";
		if (strings(format["git"]).some((prefix) => spec.startsWith(prefix))) source = "git";
		else if (spec.startsWith(String(format["workspace"]))) source = "workspace";
		else if (strings(format["directory"]).some((prefix) => spec.startsWith(prefix))) source = "directory";
		else if (HTTP.test(spec)) source = "remoteTarball";
		else if (/^(\.{1,2}\/|\/)/u.test(spec) && tarball.test(spec)) source = "file";
		const info = value.find((item) => isRecord(item));
		entries.push({
			name,
			spec,
			source,
			installScript: isRecord(info) && info[scriptsKey] === true,
			anchor: `${JSON.stringify(key)}: [`
		});
	}
	return entries;
}
function denoEntries(text, format) {
	const document = JSON.parse(text);
	if (!isRecord(document)) return {
		entries: [],
		recordsScripts: false
	};
	const recordsScripts = Number(document["version"]) >= Number(format["installScriptsSinceLockfile"]);
	const npm = isRecord(document["npm"]) ? document["npm"] : {};
	const scriptsKey = String(format["installScripts"]);
	return {
		entries: Object.entries(npm).map(([key, value]) => {
			const { name, spec } = splitSpec(key);
			return {
				name,
				spec,
				source: "registry",
				installScript: recordsScripts ? isRecord(value) && value[scriptsKey] === true : void 0,
				anchor: `${JSON.stringify(key)}: {`
			};
		}),
		recordsScripts
	};
}
/** A lockfile in a version or shape depcurfew does not read; the message says why. */
var UnsupportedLockfile = class extends Error {};
function documentsOf(tool) {
	const fact = tool.extra?.["lockfileDocuments"];
	const value = fact === void 0 ? void 0 : values$1(fact)[0];
	return isRecord(value) ? value : void 0;
}
/** The lockfiles a package manager uses in the repository root, parsed. */
/** The package.json next to a lockfile, or undefined when it is missing or not JSON. */
function readManifest(repository, lockfile) {
	const text = repository.readText(posix.join(posix.dirname(lockfile), "package.json"));
	if (text === void 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
function overridesFormatOf(tool) {
	const fact = tool.extra?.["overrides"];
	const value = fact === void 0 ? void 0 : values$1(fact)[0];
	return isRecord(value) ? value : void 0;
}
const URL_LIKE = /^[a-z][a-z0-9+.-]+:/iu;
/**
* pip reads the files a requirements file includes with -r and -c too, relative to the including file, and their
* global options apply to the whole install. For each requirements file of the trees under `roots`: every file of its
* tree. An include that cannot be read (a URL, a missing file, a path outside the repository) is reported.
*/
function requirementsTrees(repository, roots, format) {
	const trees = /* @__PURE__ */ new Map();
	for (const root of roots) {
		const tree = [];
		const queue = [root];
		while (queue.length > 0) {
			const file = queue.shift();
			if (tree.includes(file)) continue;
			tree.push(file);
			const text = repository.readText(file, MAX_LOCKFILE_SIZE);
			if (text === void 0) continue;
			const unreadable = [];
			for (const { path, line } of requirementsIncludes(text, format)) {
				const target = posix.normalize(posix.join(posix.dirname(file), path.replaceAll("\\", "/")));
				const reason = URL_LIKE.test(path) ? "a URL" : posix.isAbsolute(path) || target === ".." || target.startsWith("../") ? "outside the repository" : repository.isFile(target) ? void 0 : "missing";
				if (reason === void 0) queue.push(target);
				else unreadable.push(`${path} (line ${line}, ${reason})`);
			}
			if (unreadable.length > 0) repository.warn("unreadable-include", `cannot read the files that ${file} includes: ${listing(unreadable)}`, [file]);
		}
		for (const file of tree) trees.set(file, [.../* @__PURE__ */ new Set([...trees.get(file) ?? [], ...tree])]);
	}
	return trees;
}
function readLockfiles(repository, manager, tool, workspaces) {
	const fact = tool.extra?.["lockfileFormat"];
	const format = fact === void 0 ? void 0 : values$1(fact)[0];
	if (!isRecord(format)) return [];
	const lockfiles = manager.evidence.filter((item) => item.kind === "lockfile").map((item) => item.file);
	const requirements = tool.id === "pip" ? requirementsTrees(repository, manager.configFiles, requirementsFormatOf(tool)) : /* @__PURE__ */ new Map();
	return [.../* @__PURE__ */ new Set([...lockfiles, ...requirements.keys()])].map((file) => {
		if (file.endsWith(".lockb")) return {
			ok: false,
			file,
			reason: "it is a binary file in an undocumented format",
			unreadable: false
		};
		const text = repository.readText(file, MAX_LOCKFILE_SIZE);
		if (text === void 0) {
			if (!repository.warnings.some((warning) => warning.files.includes(file))) repository.warn("invalid-file", `cannot read ${file}`, [file]);
			return {
				ok: false,
				file,
				reason: "it cannot be read",
				unreadable: true
			};
		}
		try {
			let entries;
			let recordsScripts = format["installScripts"] !== null;
			let start = 0;
			if (tool.id === "npm") entries = npmEntries(text, format, workspaces, readManifest(repository, file), overridesFormatOf(tool));
			else if (tool.id === "pnpm") ({entries, start} = pnpmEntries(text, format, documentsOf(tool)));
			else if (tool.id === "yarn") entries = yarnEntries(text, format);
			else if (tool.id === "bun") entries = bunEntries(text, format);
			else if (tool.id === "uv") entries = uvEntries(text, format, workspaces);
			else if (tool.id === "poetry") entries = poetryEntries(text, format);
			else if (tool.id === "pdm") entries = pdmEntries(text, format);
			else if (tool.id === "pipenv") entries = pipfileLockEntries(text, format);
			else if (tool.id === "pip") entries = lockfiles.includes(file) ? pylockEntries(text, format) : requirementsEntries(text, requirementsFormatOf(tool));
			else ({entries, recordsScripts} = denoEntries(text, format));
			const find = lineFinder(text, start);
			const optionFiles = requirements.get(file);
			return {
				ok: true,
				lockfile: {
					file,
					entries,
					recordsScripts,
					lineOf: (entry) => entry.line ?? find(entry.anchor),
					...optionFiles === void 0 ? {} : { optionFiles }
				}
			};
		} catch (error) {
			if (error instanceof UnsupportedLockfile) return {
				ok: false,
				file,
				reason: error.message,
				unreadable: false
			};
			const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
			repository.warn("invalid-file", `cannot parse ${file}: ${message}`, [file]);
			return {
				ok: false,
				file,
				reason: `it cannot be parsed (${message})`,
				unreadable: true
			};
		}
	});
}

// src/apply/json-edit.ts
var Parser = class {
	index = 0;
	text;
	constructor(text) {
		this.text = text;
	}
	skip() {
		for (;;) {
			const char = this.text[this.index];
			if (char === " " || char === "	" || char === "\n" || char === "\r") this.index += 1;
			else if (char === "/" && this.text[this.index + 1] === "/") while (this.index < this.text.length && this.text[this.index] !== "\n") this.index += 1;
			else if (char === "/" && this.text[this.index + 1] === "*") {
				const end = this.text.indexOf("*/", this.index + 2);
				this.index = end === -1 ? this.text.length : end + 2;
			} else return;
		}
	}
	string() {
		const start = this.index;
		this.index += 1;
		while (this.index < this.text.length && this.text[this.index] !== "\"") this.index += this.text[this.index] === "\\" ? 2 : 1;
		this.index += 1;
		return JSON.parse(this.text.slice(start, this.index));
	}
	value() {
		this.skip();
		const start = this.index;
		const char = this.text[this.index];
		if (char === "{") {
			this.index += 1;
			const members = [];
			for (;;) {
				this.skip();
				if (this.text[this.index] === "}") break;
				if (this.text[this.index] === ",") {
					this.index += 1;
					continue;
				}
				if (this.text[this.index] !== "\"") throw new SyntaxError(`unexpected character at ${this.index}`);
				const keyStart = this.index;
				const key = this.string();
				this.skip();
				if (this.text[this.index] !== ":") throw new SyntaxError(`expected ':' at ${this.index}`);
				this.index += 1;
				members.push({
					key,
					keyStart,
					value: this.value()
				});
			}
			this.index += 1;
			return {
				kind: "object",
				start,
				end: this.index,
				members
			};
		}
		if (char === "[") {
			this.index += 1;
			const elements = [];
			for (;;) {
				this.skip();
				if (this.text[this.index] === "]") break;
				if (this.text[this.index] === ",") {
					this.index += 1;
					continue;
				}
				elements.push(this.value());
			}
			this.index += 1;
			return {
				kind: "array",
				start,
				end: this.index,
				elements
			};
		}
		if (char === "\"") {
			this.string();
			return {
				kind: "value",
				start,
				end: this.index
			};
		}
		const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(this.text.slice(this.index));
		if (match === null) throw new SyntaxError(`unexpected character at ${this.index}`);
		this.index += match[0].length;
		return {
			kind: "value",
			start,
			end: this.index
		};
	}
};
function parse$1(text) {
	return new Parser(text).value();
}
function lineIndent(text, position) {
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	return /^[ \t]*/u.exec(text.slice(lineStart))?.[0] ?? "";
}
/** The indentation unit of the file: a tab, or the smallest indentation in spaces; two spaces by default. */
function indentUnit$1(text) {
	const indents = [...text.matchAll(/\n([ \t]+)\S/gu)].map((match) => match[1] ?? "");
	if (indents.some((indent) => indent.startsWith("	"))) return "	";
	const sizes = indents.map((indent) => indent.length).filter((size) => size > 0);
	return " ".repeat(sizes.length === 0 ? 2 : Math.min(...sizes));
}
function serialize(value, unit, indent) {
	return JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`);
}
function isSameLine(text, from, to) {
	return !text.slice(from, to).includes("\n");
}
/** Position after `from` skipping spaces and a comment on the same line; stops at the line break. */
function endOfLine(text, from) {
	let index = from;
	for (;;) {
		while (text[index] === " " || text[index] === "	") index += 1;
		if (text.startsWith("//", index)) {
			while (index < text.length && text[index] !== "\n") index += 1;
			return index;
		}
		if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			if (end === -1 || text.slice(index, end).includes("\n")) return index;
			index = end + 2;
			continue;
		}
		return index;
	}
}
function nest$1(path, value) {
	return path.reduceRight((inner, segment) => ({ [String(segment)]: inner }), value);
}
function equal$1(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
/** Inserts `entry` (already serialized) after the last of `items` in a container that spans start..end. */
function insertItem(text, container, lastEnd, firstStart, entry) {
	const unit = indentUnit$1(text);
	const containerIndent = lineIndent(text, container.start);
	if (lastEnd === void 0 || firstStart === void 0) {
		const indent = containerIndent + unit;
		let at = container.start + 1;
		if (text.slice(container.start + 1, container.end - 1).trim() !== "") {
			at = container.end - 1;
			while (at > container.start + 1 && /\s/u.test(text[at - 1])) at -= 1;
		}
		return `${text.slice(0, at)}\n${indent}${entry(indent)}\n${containerIndent}${text.slice(container.end - 1)}`;
	}
	if (isSameLine(text, container.start, firstStart)) return `${text.slice(0, lastEnd)}, ${entry("").replaceAll(/\n\s*/gu, " ")}${text.slice(lastEnd)}`;
	const indent = lineIndent(text, firstStart);
	let after = lastEnd;
	while (text[after] === " " || text[after] === "	") after += 1;
	if (text[after] === ",") {
		const lineEnd = endOfLine(text, after + 1);
		return `${text.slice(0, lineEnd)}\n${indent}${entry(indent)},${text.slice(lineEnd)}`;
	}
	const lineEnd = endOfLine(text, lastEnd);
	const tail = text[lineEnd] === "}" || text[lineEnd] === "]" ? `\n${containerIndent}` : "";
	return `${text.slice(0, lastEnd)},${text.slice(lastEnd, lineEnd)}\n${indent}${entry(indent)}${tail}${text.slice(lineEnd)}`;
}
function rootObject(text) {
	const root = parse$1(text);
	if (root.kind !== "object") throw new Error("the JSON document is not an object");
	return root;
}
function find(text, path) {
	let node = rootObject(text);
	for (const segment of path) if (node?.kind === "object") node = node.members.filter((member) => member.key === segment).at(-1)?.value;
	else if (node?.kind === "array" && typeof segment === "number") node = node.elements[segment];
	else return void 0;
	return node;
}
/** The offset where the value at `path` starts, or undefined; for reporting line numbers. */
function jsonOffset(text, path) {
	try {
		return find(text, path)?.start;
	} catch {
		return;
	}
}
function jsonGet(text, path) {
	let value = parseJsonc(text);
	for (const segment of path) {
		if (typeof value !== "object" || value === null) return void 0;
		value = value[String(segment)];
	}
	return value;
}
/** Sets the value at `path`, creating missing objects on the way. */
function jsonSet(text, path, value) {
	const unit = indentUnit$1(text);
	let node = rootObject(text);
	for (const [index, segment] of path.entries()) if (node.kind === "object") {
		const member = node.members.filter((item) => item.key === segment).at(-1);
		if (member === void 0) {
			const rest = path.slice(index + 1);
			const last = node.members.at(-1);
			return insertItem(text, node, last?.value.end, node.members[0]?.keyStart, (indent) => `${JSON.stringify(String(segment))}: ${serialize(nest$1(rest, value), unit, indent)}`);
		}
		node = member.value;
	} else if (node.kind === "array" && typeof segment === "number" && node.elements[segment] !== void 0) node = node.elements[segment];
	else {
		const replacement = serialize(nest$1(path.slice(index), value), unit, lineIndent(text, node.start));
		return `${text.slice(0, node.start)}${replacement}${text.slice(node.end)}`;
	}
	if (equal$1(jsonGet(text, path), value)) return text;
	return `${text.slice(0, node.start)}${serialize(value, unit, lineIndent(text, node.start))}${text.slice(node.end)}`;
}
function arrayAt(text, path) {
	const node = find(text, path);
	if (node?.kind !== "array") throw new Error(`no array at ${path.join(".")}`);
	return node;
}
function jsonArrayAppend(text, path, value) {
	const unit = indentUnit$1(text);
	const array = arrayAt(text, path);
	return insertItem(text, array, array.elements.at(-1)?.end, array.elements[0]?.start, (indent) => serialize(value, unit, indent));
}
function jsonArrayReplace(text, path, index, value) {
	const element = arrayAt(text, path).elements[index];
	if (element === void 0) throw new Error(`no element ${index} at ${path.join(".")}`);
	return `${text.slice(0, element.start)}${serialize(value, indentUnit$1(text), lineIndent(text, element.start))}${text.slice(element.end)}`;
}
/** Removes the line around `at` when only whitespace is left on it. */
function dropBlankLine(text, at) {
	const lineStart = text.lastIndexOf("\n", at - 1) + 1;
	const newline = text.indexOf("\n", at);
	const lineEnd = newline === -1 ? text.length : newline;
	return lineStart > 0 && text.slice(lineStart, lineEnd).trim() === "" ? `${text.slice(0, lineStart - 1)}${text.slice(lineEnd)}` : text;
}
/**
* Removes the element and the comma that separates it (the one after it, or before it for the last element), and its
* line when nothing else is left on it. Comments stay, also those next to the element.
*/
function jsonArrayRemove(text, path, index) {
	const { elements, start, end } = arrayAt(text, path);
	const element = elements[index];
	if (element === void 0) throw new Error(`no element ${index} at ${path.join(".")}`);
	const blank = (from, to) => text.slice(from, to).trim() === "";
	if (elements.length === 1 && `${text.slice(start + 1, element.start)}${text.slice(element.end, end - 1)}`.replaceAll(",", "").trim() === "") return `${text.slice(0, start + 1)}${text.slice(end - 1)}`;
	const after = nextSignificant(text, element.end);
	if (text[after] === ",") {
		if (!blank(element.end, after)) return dropBlankLine(`${text.slice(0, element.start)}${text.slice(element.end, after)}${text.slice(after + 1)}`, element.start);
		let stop = after + 1;
		while (text[stop] === " " || text[stop] === "	") stop += 1;
		return dropBlankLine(`${text.slice(0, element.start)}${text.slice(stop)}`, element.start);
	}
	const previous = elements[index - 1];
	const comma = previous === void 0 ? void 0 : nextSignificant(text, previous.end);
	if (previous === void 0 || comma === void 0 || text[comma] !== ",") return dropBlankLine(`${text.slice(0, element.start)}${text.slice(element.end)}`, element.start);
	if (blank(previous.end, comma) && blank(comma + 1, element.start)) return `${text.slice(0, comma)}${text.slice(element.end)}`;
	return dropBlankLine(`${text.slice(0, comma)}${text.slice(comma + 1, element.start)}${text.slice(element.end)}`, element.start - 1);
}

// src/apply/block.ts
const BLOCK_START = "# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead";
const BLOCK_END = "# <<< depcurfew managed block";
const SUPERSEDED = "# depcurfew: superseded by the managed block: ";
/** For a managed key commented out when no block is written, such as a switch the policy turns off. */
const TURNED_OFF = "# depcurfew: turned off; depcurfew.json manages this setting: ";
/** The start marker of a managed block; a file with one block per TOML table names the table in each marker. */
function blockStart(table) {
	return table === void 0 ? BLOCK_START : BLOCK_START.replace(": ", ` [${table}]: `);
}
const LABELED_START = new RegExp(`^${BLOCK_START.replace(": ", " \\[[^\\]]*\\]: ").replace(/[.]/gu, "\\.")}$`, "u");
function isBlockStart(line) {
	const trimmed = line.trim();
	return trimmed === "# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead" || LABELED_START.test(trimmed);
}
/** The lines without the managed block, where it was, and whether a blank line separated it from what came before. */
function removeBlock(lines, marker = BLOCK_START) {
	const start = lines.findIndex((line) => line.trim() === marker);
	if (start === -1) return {
		lines: [...lines],
		at: void 0,
		separated: false
	};
	const end = lines.findIndex((line, index) => index > start && line.trim() === "# <<< depcurfew managed block");
	const stop = end === -1 ? start : end;
	const rest = [...lines.slice(0, start), ...lines.slice(stop + 1)];
	let at = start;
	let separated = false;
	if (at > 0 && rest[at - 1]?.trim() === "") {
		rest.splice(at - 1, 1);
		at -= 1;
		separated = true;
	}
	return {
		lines: rest,
		at,
		separated
	};
}
function blockLines(entries, marker = BLOCK_START) {
	return [
		marker,
		...entries,
		BLOCK_END
	];
}
function splitLines(body) {
	if (body === "") return [];
	const lines = body.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
function joinLines(lines) {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
/** Inserts the block at `at`; a new block is separated by a blank line from preceding content. */
function insertBlock(lines, at, entries, separate, marker = BLOCK_START) {
	const block = blockLines(entries, marker);
	const before = lines.slice(0, at);
	if ((separate ?? true) && before.length > 0 && before.at(-1)?.trim() !== "") block.unshift("");
	return [
		...before,
		...block,
		...lines.slice(at)
	];
}

// src/doctor/settings.ts
/** Every key=value line of an .npmrc file; `key[]` keeps its brackets. */
function iniEntries(text) {
	const entries = [];
	let managed = false;
	text.split(/\r?\n/u).forEach((raw, index) => {
		const line = raw.trim();
		if (line === "# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead") managed = true;
		else if (line === "# <<< depcurfew managed block") managed = false;
		if (line === "" || line.startsWith("#") || line.startsWith(";")) return;
		const equals = line.indexOf("=");
		if (equals === -1) return;
		const value = line.slice(equals + 1).trim().replace(/^"(.*)"$/u, "$1");
		entries.push({
			key: line.slice(0, equals).trim(),
			value,
			line: index + 1,
			managed
		});
	});
	return entries;
}
/** A parsed INI value: true/false, numbers and strings as npm reads them. */
function iniValue(value) {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(\.\d+)?$/u.test(value)) return Number(value);
	return value;
}
function lineAt(text, offset) {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") line += 1;
	return line;
}
/** The YAML value at `path` and the line of its key. */
function yamlSetting(text, path) {
	const lineCounter = new import_dist.LineCounter();
	const document = (0, import_dist.parseDocument)(text, { lineCounter });
	if (document.errors.length > 0) return void 0;
	let node = document.contents;
	let keyOffset = 0;
	for (const segment of path) {
		if (node !== null && (0, import_dist.isSeq)(node) && /^\d+$/u.test(segment)) {
			const item = node.items[Number(segment)];
			if (item === void 0) return void 0;
			keyOffset = item.range?.[0] ?? keyOffset;
			node = item;
			continue;
		}
		if (node === null || !(0, import_dist.isMap)(node)) return void 0;
		const pair = node.items.filter((item) => (0, import_dist.isScalar)(item.key) && String(item.key.value) === segment).at(-1);
		if (pair === void 0) return void 0;
		keyOffset = pair.key.range?.[0] ?? 0;
		node = pair.value;
	}
	return {
		value: node === null ? null : (0, import_dist.isMap)(node) || (0, import_dist.isSeq)(node) || (0, import_dist.isScalar)(node) ? node.toJSON() : void 0,
		line: lineCounter.linePos(keyOffset).line
	};
}
/** The JSON value at `path` and the line where it starts. */
function jsonSetting(text, path) {
	let value;
	try {
		value = jsonGet(text, path);
	} catch {
		return;
	}
	if (value === void 0) return void 0;
	const offset = jsonOffset(text, path);
	return {
		value,
		line: offset === void 0 ? 1 : lineAt(text, offset)
	};
}
function tomlScalar(raw) {
	const text = raw.replace(/\s+#.*$/u, "").trim();
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^[+-]?\d[\d_]*(\.\d+)?$/u.test(text)) return Number(text.replaceAll("_", ""));
	const string = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/u.exec(text);
	if (string !== null) return string[1] === void 0 ? string[2] : JSON.parse(`"${string[1]}"`);
	if (text.startsWith("[") && text.endsWith("]")) return (text.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s][^,]*/gu) ?? []).map((item) => tomlScalar(item.trim()));
	return text;
}
/** A key of a TOML table (`[table]` section or a dotted `table.key` at the top level). Single-line values only. */
function tomlSetting(text, table, key) {
	let current = "";
	let found;
	text.split(/\r?\n/u).forEach((raw, index) => {
		const line = raw.trim();
		const header = /^\[\s*([^\]]+?)\s*\]/u.exec(line);
		if (header !== null) {
			current = header[1] ?? "";
			return;
		}
		if (line === "" || line.startsWith("#")) return;
		const equals = line.indexOf("=");
		if (equals === -1) return;
		const name = line.slice(0, equals).trim().replace(/^["']|["']$/gu, "");
		if (current === table && name === key || current === "" && name === `${table}.${key}`) found = {
			value: tomlScalar(line.slice(equals + 1)),
			line: index + 1
		};
	});
	return found;
}
/**
* A setting as the knowledge base names it, read from one configuration file: `.npmrc` keys, YAML and JSON paths
* with dots, TOML `table.key`. For `.npmrc` the last line wins, as in npm.
*/
function readSetting(repository, file, setting) {
	if (setting.includes("<")) return void 0;
	const text = repository.readText(file);
	if (text === void 0) return void 0;
	const name = file.split("/").at(-1) ?? file;
	let found;
	if (name === ".npmrc") {
		const entries = iniEntries(text).filter((entry) => entry.key === setting || entry.key === `${setting}[]`);
		const last = entries.at(-1);
		if (last !== void 0) found = last.key.endsWith("[]") ? {
			value: entries.filter((entry) => entry.key.endsWith("[]")).map((entry) => entry.value),
			line: entries[0]?.line ?? last.line
		} : {
			value: iniValue(last.value),
			line: last.line
		};
	} else if (/\.ya?ml$/u.test(name)) found = yamlSetting(text, setting.split("."));
	else if (name.endsWith(".toml")) {
		const dot = setting.indexOf(".");
		found = dot === -1 ? tomlSetting(text, "", setting) : tomlSetting(text, setting.slice(0, dot), setting.slice(dot + 1));
	} else if (/\.jsonc?$/u.test(name)) found = jsonSetting(text, setting.split("."));
	return found === void 0 ? void 0 : {
		file,
		...found
	};
}
/** The 1-based line of the first occurrence of `needle`, or undefined. */
function lineOf(text, needle) {
	const offset = text.indexOf(needle);
	return offset === -1 ? void 0 : lineAt(text, offset);
}

// src/doctor/allow-lists.ts
function read(repository, file) {
	return repository.readText(file);
}
function fromKeys(text, file, setting, value, enabled) {
	if (!isRecord(value)) return [];
	return Object.entries(value).filter(([, entry]) => enabled(entry)).map(([name]) => ({
		name,
		package: splitSpec(name).name,
		file,
		line: lineOf(text, JSON.stringify(name)) ?? lineOf(text, `${name}:`),
		setting
	}));
}
function fromList(text, file, setting, value, prefix = "") {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string").map((item) => {
		const name = item.startsWith(prefix) ? item.slice(prefix.length) : item;
		return {
			name,
			package: splitSpec(name).name,
			file,
			line: lineOf(text, item),
			setting
		};
	});
}
/** Entries that let a package run its install scripts, per manager. Unreadable files give no entries. */
function allowEntries(repository, manager, configFiles) {
	const manifest = read(repository, "package.json");
	const entries = [];
	const json = (path) => manifest === void 0 ? void 0 : jsonSetting(manifest, path)?.value;
	switch (manager) {
		case "npm":
			if (manifest !== void 0) entries.push(...fromKeys(manifest, "package.json", "allowScripts", json(["allowScripts"]), (entry) => entry === true));
			break;
		case "pnpm": {
			const workspace = read(repository, "pnpm-workspace.yaml");
			if (workspace !== void 0) {
				entries.push(...fromKeys(workspace, "pnpm-workspace.yaml", "allowBuilds", yamlSetting(workspace, ["allowBuilds"])?.value, (entry) => entry === true));
				entries.push(...fromList(workspace, "pnpm-workspace.yaml", "onlyBuiltDependencies", yamlSetting(workspace, ["onlyBuiltDependencies"])?.value));
			}
			if (manifest !== void 0) entries.push(...fromList(manifest, "package.json", "pnpm.onlyBuiltDependencies", json(["pnpm", "onlyBuiltDependencies"])));
			break;
		}
		case "yarn":
			if (manifest !== void 0) entries.push(...fromKeys(manifest, "package.json", "dependenciesMeta", json(["dependenciesMeta"]), (entry) => isRecord(entry) && entry["built"] === true));
			break;
		case "bun":
			if (manifest !== void 0) entries.push(...fromList(manifest, "package.json", "trustedDependencies", json(["trustedDependencies"])));
			break;
		case "deno": for (const file of configFiles.filter((name) => /^deno\.jsonc?$/u.test(name))) {
			const text = read(repository, file);
			if (text === void 0) continue;
			const value = jsonSetting(text, ["allowScripts"])?.value;
			entries.push(...fromList(text, file, "allowScripts", isRecord(value) ? value["allow"] : value, "npm:"));
		}
	}
	return entries;
}
/** Whether a package name matches a policy pattern; `*` stands for any characters except `/`. */
function matchesPattern(name, pattern) {
	return wildcardMatch(name, pattern);
}

// src/policy/defaults.ts
const POLICY_FILE = "depcurfew.json";

// src/policy/duration.ts
const MINUTES$2 = {
	w: 10080,
	d: 1440,
	h: 60,
	m: 1
};
/** The canonical form; parseDuration accepts nothing else. Also used as the JSON Schema pattern. */
const DURATION_PATTERN = "^[1-9][0-9]*[mhdw]$";
const CANONICAL = new RegExp(DURATION_PATTERN, "u");
/** Durations convert to seconds for Bun, so the number of seconds must stay a safe integer. */
const MAX_MINUTES = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 60));
const HINT = "use a whole number followed by m (minutes), h (hours), d (days) or w (weeks), e.g. \"36h\", \"3d\" or \"1w\"";
const ZERO = "must be longer than zero; to leave release-age settings unmanaged, remove the cooldown section";
const UNIT_WORDS = {
	m: "m",
	min: "m",
	mins: "m",
	minute: "m",
	minutes: "m",
	h: "h",
	hr: "h",
	hrs: "h",
	hour: "h",
	hours: "h",
	d: "d",
	day: "d",
	days: "d",
	w: "w",
	wk: "w",
	wks: "w",
	week: "w",
	weeks: "w",
	mo: "months",
	mos: "months",
	month: "months",
	months: "months",
	y: "months",
	yr: "months",
	yrs: "months",
	year: "months",
	years: "months",
	s: "seconds",
	sec: "seconds",
	secs: "seconds",
	second: "seconds",
	seconds: "seconds",
	ms: "seconds",
	millisecond: "seconds",
	milliseconds: "seconds"
};
/** Splits loosely written input such as "3 Days" or "1d12h" so that errors can suggest the canonical form. */
function tokenize(input) {
	const token = /\s*(\d+(?:\.\d*)?|\.\d+)\s*([A-Za-z]*)\s*/y;
	const tokens = [];
	while (token.lastIndex < input.length) {
		const match = token.exec(input);
		if (match === null) return void 0;
		tokens.push({
			number: match[1] ?? "",
			unit: match[2] ?? ""
		});
	}
	return tokens.length > 0 ? tokens : void 0;
}
function unitOf(unit) {
	if (unit === "M") return "months";
	return UNIT_WORDS[unit.toLowerCase()];
}
/** Writes minutes with the largest unit that represents them exactly, e.g. 2160 → "36h". */
function formatDuration(minutes) {
	for (const symbol of [
		"w",
		"d",
		"h"
	]) if (minutes % MINUTES$2[symbol] === 0) return `${minutes / MINUTES$2[symbol]}${symbol}`;
	return `${minutes}m`;
}
function failure(message) {
	return {
		ok: false,
		message
	};
}
function parseDuration(input) {
	if (input.trim() === "") return failure(HINT);
	if (input.trim().startsWith("-")) return failure(ZERO);
	const tokens = tokenize(input);
	if (tokens === void 0) return failure(HINT);
	const units = tokens.map((token) => token.unit === "" ? void 0 : unitOf(token.unit));
	if (units.includes("months")) return failure("months and years are not supported because their length varies; use days or weeks, e.g. \"30d\"");
	if (units.includes("seconds")) return failure("seconds are not supported; the smallest unit is m (minutes)");
	const unknown = tokens.find((token, index) => token.unit !== "" && units[index] === void 0);
	if (unknown !== void 0) return failure(`unknown unit "${unknown.unit}"; ${HINT}`);
	const decimals = Math.max(...tokens.map((token) => token.number.split(".")[1]?.length ?? 0));
	const scale = 10n ** BigInt(decimals);
	let scaled = 0n;
	for (const [index, token] of tokens.entries()) {
		const [whole = "", fraction = ""] = token.number.split(".");
		const symbol = units[index];
		scaled += BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`) * BigInt(symbol === void 0 ? 0 : MINUTES$2[symbol]);
	}
	if (tokens.every((token) => /^[0.]*$/u.test(token.number))) return failure(ZERO);
	if (units.includes(void 0)) return failure(`a unit is missing; ${HINT}`);
	const minutes = (scaled + scale - 1n) / scale;
	if (minutes > MAX_MINUTES) return failure("too large");
	if (tokens.some((token) => token.number.includes("."))) return failure(`fractions are not supported; ${scaled % scale === 0n ? `write "${formatDuration(Number(minutes))}"` : HINT}`);
	if (CANONICAL.test(input)) return {
		ok: true,
		duration: {
			text: input,
			minutes: Number(minutes)
		}
	};
	const [first] = tokens;
	const suggestion = tokens.length === 1 && first !== void 0 ? `${BigInt(first.number)}${units[0]}` : formatDuration(Number(minutes));
	return failure(`${/\s/u.test(input) ? "spaces are not allowed" : tokens.some((token) => token.unit !== token.unit.toLowerCase()) ? "units are lowercase" : tokens.some((token) => token.unit.length > 1) ? "use the short unit" : tokens.length > 1 ? "use a single unit" : "leading zeros are not allowed"}; write "${suggestion}"`);
}

// src/policy/package-pattern.ts
const NAME = "[A-Za-z0-9~*-][A-Za-z0-9._~*_-]*";
const PYTHON_NAME = "[A-Za-z0-9*](?:[A-Za-z0-9._*-]*[A-Za-z0-9*])?";
const PYPI_PREFIX = "pypi:";
/** Also used as the JSON Schema pattern. The lookaheads reject patterns made only of `*`, which match every package. */
const PACKAGE_PATTERN = `^(?:${PYPI_PREFIX}(?!\\*+$)${PYTHON_NAME}|(?!\\*+$)(@${NAME}/)?${NAME})$`;
const GRAMMAR = new RegExp(PACKAGE_PATTERN, "u");
function validatePythonPattern(pattern) {
	const name = pattern.slice(5);
	if (name === "") return `write a Python package name after ${PYPI_PREFIX}, e.g. "${PYPI_PREFIX}requests"`;
	const versionAt = name.search(/[@=<>!~;[ ]/u);
	if (versionAt > 0 && !name.startsWith("@")) return `versions are not supported; write "${PYPI_PREFIX}${name.slice(0, versionAt)}"`;
	if (/^\*+$/u.test(name)) return "it matches every package; list packages explicitly";
	const example = `e.g. "${PYPI_PREFIX}requests" or "${PYPI_PREFIX}acme-*"`;
	if (name.startsWith("@")) return `Python package names have no scope; expected a name or a name pattern with *, ${example}`;
	if (!GRAMMAR.test(pattern)) return `expected a Python package name or a name pattern with *, ${example}`;
}
/** Returns why the pattern is invalid, or undefined when it is valid. */
function validatePackagePattern(pattern) {
	if (pattern === "") return "must not be empty";
	if (/\s/u.test(pattern)) return "must not contain spaces";
	if (pattern.startsWith("pypi:")) return validatePythonPattern(pattern);
	const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(pattern);
	if (prefix !== null) {
		const rest = pattern.slice(prefix[0].length);
		return prefix[1]?.toLowerCase() === "pypi" ? `the only ecosystem prefix is ${PYPI_PREFIX}; write Python packages as "${PYPI_PREFIX}${rest}"` : `the only ecosystem prefix is ${PYPI_PREFIX}; write npm packages without a prefix, e.g. "${rest}"`;
	}
	const nameStart = pattern.startsWith("@") ? pattern.indexOf("/") + 1 : 0;
	const versionAt = pattern.indexOf("@", Math.max(nameStart, 1));
	if (versionAt > 0) return `versions are not supported; write "${pattern.slice(0, versionAt)}"`;
	if (/^\*+$/u.test(pattern)) return "it matches every package; list packages explicitly";
	if (!GRAMMAR.test(pattern)) return "expected a package name or a name pattern with *, e.g. \"esbuild\", \"@scope/name\" or \"@scope/*\"";
}
/** The ecosystem a policy pattern belongs to. */
function ecosystemOf(pattern) {
	return pattern.startsWith("pypi:") ? "pypi" : "npm";
}
/** The patterns of one ecosystem, without the pypi: prefix. */
function patternsFor(patterns, ecosystem) {
	return patterns.filter((pattern) => ecosystemOf(pattern) === ecosystem).map((pattern) => ecosystem === "pypi" ? pattern.slice(5) : pattern);
}

// src/policy/ecosystem.ts
function ecosystemOfTool(tool) {
	return tool.ecosystem ?? "npm";
}
/** The policy with cooldown.exclude and installScripts.allow reduced to the patterns of one ecosystem. */
function policyFor(policy, ecosystem) {
	return {
		...policy,
		...policy.cooldown === void 0 ? {} : { cooldown: {
			...policy.cooldown,
			exclude: patternsFor(policy.cooldown.exclude, ecosystem)
		} },
		...policy.installScripts === void 0 ? {} : { installScripts: {
			...policy.installScripts,
			allow: patternsFor(policy.installScripts.allow, ecosystem)
		} }
	};
}

// src/policy/file.ts
function readPolicyFile(root) {
	try {
		lstatSync(join(root, POLICY_FILE));
	} catch {
		return { status: "missing" };
	}
	const repository = new Repository(root);
	const text = repository.readText(POLICY_FILE);
	if (text !== void 0) return {
		status: "ok",
		text
	};
	return {
		status: "unreadable",
		reason: repository.warnings[0]?.message ?? `${"depcurfew.json"} is not a regular file and was not read`
	};
}

// src/policy/convert.ts
const DURATION_STRING_UNITS = [
	"minutes",
	"hours",
	"days",
	"weeks"
];
const SECONDS_PER = {
	seconds: 1,
	minutes: 60,
	hours: 3600,
	days: 86400,
	weeks: 604800
};
const SINGULAR = {
	seconds: "second",
	minutes: "minute",
	hours: "hour",
	days: "day",
	weeks: "week"
};
/** The smallest whole number of `unit` that lasts at least `minutes`. Integer arithmetic, exact for safe integers. */
function countIn(minutes, unit) {
	if (unit === "seconds") return {
		value: minutes * 60,
		exact: true
	};
	const size = SECONDS_PER[unit] / 60;
	const remainder = minutes % size;
	return {
		value: (minutes - remainder) / size + (remainder === 0 ? 0 : 1),
		exact: remainder === 0
	};
}
function amount(count, unit) {
	return `${count} ${count === 1 ? SINGULAR[unit] : unit}`;
}
/** The largest unit that represents `minutes` exactly, otherwise the smallest unit, rounded up. */
function pickUnit(minutes, units) {
	const bySize = [...units].sort((a, b) => SECONDS_PER[b] - SECONDS_PER[a]);
	const unit = bySize.find((candidate) => countIn(minutes, candidate).exact) ?? bySize[bySize.length - 1];
	if (unit === void 0) throw new Error("toDurationString needs at least one unit");
	return unit;
}
function valuesOf(fact) {
	return evidenceOf(fact).map((evidence) => evidence.value);
}
function extraValues(tool, key) {
	const fact = tool.extra?.[key];
	return fact === void 0 ? void 0 : valuesOf(fact);
}
function isDurationStringUnit(value) {
	return DURATION_STRING_UNITS.includes(value);
}
/** Units every variant of `extra.durationUnits` agrees on; undefined when missing or malformed. */
function durationUnits(tool) {
	const variants = extraValues(tool, "durationUnits");
	if (variants === void 0) return void 0;
	const lists = [];
	for (const variant of variants) {
		if (!Array.isArray(variant) || !variant.every(isDurationStringUnit)) return void 0;
		lists.push(variant);
	}
	const [first = [], ...rest] = lists;
	return first.filter((unit) => rest.every((list) => list.includes(unit)));
}
/** The lowest maximum among the variants of `extra.maximumDays`, if any. */
function maximumDays(tool) {
	const values = (extraValues(tool, "maximumDays") ?? []).filter((value) => typeof value === "number" && Number.isInteger(value) && value > 0);
	return values.length === 0 ? void 0 : Math.min(...values);
}
/**
* Converts the policy's minimum release age into the value for one tool. When official sources disagree on the
* unit, the smallest unit wins: its larger number is long enough under every reading.
*/
function convertCooldown(tool, duration) {
	const fail = (reason, fix) => ({
		ok: false,
		tool: tool.id,
		reason,
		...fix === void 0 ? {} : { fix }
	});
	const units = valuesOf(tool.cooldown.unit);
	if (units.includes(null)) return fail(`${tool.name} has no release-age setting`);
	let unit;
	let delayUnit;
	if (units.includes("duration-string")) {
		if (units.some((candidate) => candidate !== "duration-string")) return fail(`the unit of the ${tool.name} release-age setting is disputed between a number and a duration string`);
		const words = durationUnits(tool);
		if (words === void 0 || words.length === 0) return fail(`the knowledge base does not list which duration units ${tool.name} accepts (extra.durationUnits)`);
		unit = pickUnit(duration.minutes, words);
		delayUnit = "duration-string";
	} else {
		unit = units.reduce((a, b) => SECONDS_PER[b] < SECONDS_PER[a] ? b : a);
		delayUnit = unit;
	}
	const { value: count, exact } = countIn(duration.minutes, unit);
	const value = delayUnit === "duration-string" ? amount(count, unit) : count;
	const maximum = maximumDays(tool);
	if (maximum !== void 0 && count * SECONDS_PER[unit] > maximum * SECONDS_PER.days) return fail(`${tool.name} accepts at most ${amount(maximum, "days")}, but ${duration.text} needs ${amount(count, unit)}`, `Set cooldown.minimum in ${POLICY_FILE} to ${maximum}d or less`);
	return {
		ok: true,
		tool: tool.id,
		unit: delayUnit,
		value,
		exact
	};
}

// src/knowledge/schema.ts
const TOOL_IDS = [
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"uv",
	"pip",
	"poetry",
	"pdm",
	"pipenv",
	"renovate",
	"dependabot"
];
const SOURCE_KINDS = [
	"git",
	"remoteTarball",
	"file",
	"directory"
];
const SOURCE_GROUPS = SOURCE_KINDS.map((kind) => ({
	anchor: `sources.${kind}.setting`,
	dependents: [
		"values",
		"availableSince",
		"default"
	].map((field) => `sources.${kind}.${field}`)
}));

// src/policy/shape.ts
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
function formatPath(path) {
	let text = "";
	for (const segment of path) if (typeof segment === "number") text += `[${segment}]`;
	else if (IDENTIFIER.test(segment)) text += text === "" ? segment : `.${segment}`;
	else text += `[${JSON.stringify(segment)}]`;
	return text === "" ? "(root)" : text;
}
function jsonTypeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	const type = typeof value;
	return type === "object" || type === "string" || type === "number" || type === "boolean" ? type : "null";
}
/** Shows what was found: scalars as JSON, compound values by kind. */
function describeValue(value) {
	switch (jsonTypeOf(value)) {
		case "array": return "a list";
		case "object": return "an object";
		default: return JSON.stringify(value) ?? String(value);
	}
}
/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions. */
function editDistance(a, b) {
	const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
	const at = (i, j) => rows[i]?.[j] ?? Number.POSITIVE_INFINITY;
	for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
		const cost = a[i - 1] === b[j - 1] ? 0 : 1;
		let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
		if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
		rows[i][j] = best;
	}
	return at(a.length, b.length);
}
/** The closest candidate to a mistyped name, if one is close enough to be a likely typo. */
function suggest(input, candidates) {
	const normalize = (text) => text.toLowerCase().replace(/[-_\s]/gu, "");
	const wanted = normalize(input);
	const exact = candidates.find((candidate) => normalize(candidate) === wanted);
	if (exact !== void 0) return exact;
	const prefix = candidates.find((candidate) => {
		const name = normalize(candidate);
		return Math.min(name.length, wanted.length) >= 3 && (name.startsWith(wanted) || wanted.startsWith(name));
	});
	if (prefix !== void 0) return prefix;
	let best;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const distance = editDistance(wanted, normalize(candidate));
		if (distance <= Math.max(1, Math.floor(candidate.length / 3)) && distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}
function didYouMean(value, candidates) {
	if (typeof value !== "string" || candidates === void 0) return "";
	const match = suggest(value, candidates);
	return match === void 0 ? "" : `; did you mean ${JSON.stringify(match)}?`;
}
function report(issues, path, message) {
	issues.push({
		path: formatPath(path),
		message
	});
	return { ok: false };
}
function mismatch(issues, path, label, value, candidates) {
	return report(issues, path, `must be ${label}, got ${describeValue(value)}${didYouMean(value, candidates)}`);
}
function withDescription(schema, description) {
	return description === void 0 ? schema : {
		description,
		...schema
	};
}
function literal(value, options = {}) {
	const label = JSON.stringify(value);
	return {
		label,
		jsonTypes: [typeof value === "string" ? "string" : "number"],
		...typeof value === "string" ? { suggestions: [value] } : {},
		parse: (input, path, issues) => input === value ? {
			ok: true,
			value
		} : mismatch(issues, path, label, input, typeof value === "string" ? [value] : void 0),
		toJsonSchema: () => {
			return withDescription({
				type: typeof value === "string" ? "string" : Number.isInteger(value) ? "integer" : "number",
				const: value
			}, options.description);
		}
	};
}
function oneOfStrings(values, options = {}) {
	const label = `one of ${values.map((value) => JSON.stringify(value)).join(", ")}`;
	return {
		label,
		jsonTypes: ["string"],
		suggestions: values,
		parse: (input, path, issues) => typeof input === "string" && values.includes(input) ? {
			ok: true,
			value: input
		} : mismatch(issues, path, label, input, values),
		toJsonSchema: () => withDescription({
			type: "string",
			enum: values
		}, options.description)
	};
}
/** A string with its own syntax; the JSON Schema `pattern` must accept exactly the canonical form. */
function text(options) {
	return {
		label: options.label,
		jsonTypes: ["string"],
		parse(input, path, issues) {
			if (typeof input !== "string") return mismatch(issues, path, options.label, input);
			const result = options.parse(input);
			return result.ok ? result : report(issues, path, `${options.kind} ${JSON.stringify(input)}: ${result.message}`);
		},
		toJsonSchema: () => withDescription({
			type: "string",
			pattern: options.pattern,
			...options.examples === void 0 ? {} : { examples: options.examples }
		}, options.description)
	};
}
function anyString(options = {}) {
	return {
		label: "a string",
		jsonTypes: ["string"],
		parse: (input, path, issues) => typeof input === "string" ? {
			ok: true,
			value: input
		} : mismatch(issues, path, "a string", input),
		toJsonSchema: () => withDescription({ type: "string" }, options.description)
	};
}
function list(item, options = {}) {
	const label = options.label ?? "a list";
	return {
		label,
		jsonTypes: ["array"],
		parse(input, path, issues) {
			if (!Array.isArray(input)) return mismatch(issues, path, label, input);
			if (options.nonEmpty !== void 0 && input.length === 0) return report(issues, path, `must not be an empty list; ${options.nonEmpty}`);
			const values = [];
			const firstIndex = /* @__PURE__ */ new Map();
			let ok = true;
			input.forEach((element, index) => {
				const result = item.parse(element, [...path, index], issues);
				if (!result.ok) {
					ok = false;
					return;
				}
				if (options.unique === true) {
					const key = JSON.stringify(element);
					const first = firstIndex.get(key);
					if (first !== void 0) {
						ok = false;
						report(issues, [...path, index], `duplicate entry ${describeValue(element)} (first at index ${first})`);
						return;
					}
					firstIndex.set(key, index);
				}
				values.push(result.value);
			});
			return ok ? {
				ok: true,
				value: values
			} : { ok: false };
		},
		toJsonSchema: () => withDescription({
			type: "array",
			items: item.toJsonSchema(),
			...options.unique === true ? { uniqueItems: true } : {},
			...options.nonEmpty === void 0 ? {} : { minItems: 1 }
		}, options.description)
	};
}
/** Alternatives told apart by JSON type, e.g. `"auto"` or a list of tools. */
function anyOf(shapes, options = {}) {
	const types = shapes.flatMap((shape) => shape.jsonTypes);
	if (new Set(types).size !== types.length) throw new Error("anyOf alternatives must accept different JSON types");
	const label = shapes.map((shape) => shape.label).join(" or ");
	const suggestions = shapes.flatMap((shape) => shape.suggestions ?? []);
	return {
		label,
		jsonTypes: types,
		suggestions,
		parse(input, path, issues) {
			const shape = shapes.find((candidate) => candidate.jsonTypes.includes(jsonTypeOf(input)));
			if (shape === void 0) return mismatch(issues, path, label, input, suggestions);
			const own = [];
			const result = shape.parse(input, path, own);
			if (own.some((issue) => issue.path === formatPath(path) && issue.message.startsWith("must be "))) return mismatch(issues, path, label, input, suggestions);
			issues.push(...own);
			return result;
		},
		toJsonSchema: () => withDescription({ anyOf: shapes.map((shape) => shape.toJsonSchema()) }, options.description)
	};
}
function required(shape) {
	return {
		kind: "required",
		shape
	};
}
/** Absent fields stay absent in the output. */
function optional(shape) {
	return {
		kind: "optional",
		shape
	};
}
/** Absent fields get the default, parsed like a written value. */
function withDefault(shape, value) {
	return {
		kind: "default",
		shape,
		default: value
	};
}
function isPlainObject(value) {
	return jsonTypeOf(value) === "object";
}
/** An object with known fields only; unknown fields are reported, with a suggestion when one looks like a typo. */
function object(fields, options = {}) {
	const names = Object.keys(fields);
	return {
		label: "an object",
		jsonTypes: ["object"],
		parse(input, path, issues) {
			if (!isPlainObject(input)) return mismatch(issues, path, "an object", input);
			let ok = true;
			for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) {
				ok = false;
				report(issues, path, `unknown field ${JSON.stringify(key)}${didYouMean(key, names)}`);
			}
			const output = {};
			for (const [key, field] of Object.entries(fields)) {
				if (!Object.hasOwn(input, key)) {
					if (field.kind === "required") {
						ok = false;
						report(issues, path, `missing required field ${JSON.stringify(key)}`);
					} else if (field.kind === "default") {
						const result = field.shape.parse(field.default, [...path, key], issues);
						if (result.ok) output[key] = result.value;
					}
					continue;
				}
				const result = field.shape.parse(input[key], [...path, key], issues);
				if (result.ok) output[key] = result.value;
				else ok = false;
			}
			return ok ? {
				ok: true,
				value: output
			} : { ok: false };
		},
		toJsonSchema() {
			const properties = {};
			const requiredNames = [];
			for (const [key, field] of Object.entries(fields)) {
				properties[key] = field.kind === "default" ? {
					...field.shape.toJsonSchema(),
					default: field.default
				} : field.shape.toJsonSchema();
				if (field.kind === "required") requiredNames.push(key);
			}
			return withDescription({
				type: "object",
				properties,
				...requiredNames.length > 0 ? { required: requiredNames } : {},
				additionalProperties: false
			}, options.description);
		}
	};
}

// src/policy/schema.ts
const duration = text({
	label: "a duration such as \"3d\"",
	kind: "invalid duration",
	pattern: DURATION_PATTERN,
	examples: [
		"3d",
		"36h",
		"1w"
	],
	description: "Minimum age of a release before it is installed or proposed: a whole number followed by m (minutes), h (hours), d (days) or w (weeks). Converted to each tool's unit, always rounding up.",
	parse: (input) => {
		const result = parseDuration(input);
		return result.ok ? {
			ok: true,
			value: result.duration
		} : result;
	}
});
const packagePatterns = (description) => list(text({
	label: "a package name or pattern",
	kind: "invalid package pattern",
	pattern: PACKAGE_PATTERN,
	description: "An npm package name such as \"esbuild\" or \"@scope/name\", or a pattern with *, such as \"@scope/*\". Python packages take the prefix pypi:, e.g. \"pypi:requests\" or \"pypi:acme-*\". No versions.",
	parse: (input) => {
		const message = validatePackagePattern(input);
		return message === void 0 ? {
			ok: true,
			value: input
		} : {
			ok: false,
			message
		};
	}
}), {
	unique: true,
	description
});
const access = (description) => oneOfStrings(["allow", "deny"], { description });
const cooldownShape = object({
	minimum: required(duration),
	exclude: withDefault(packagePatterns("Packages that skip the release-age delay, e.g. your own scope."), []),
	securityUpdates: withDefault(oneOfStrings(["bypass", "delay"], { description: "Whether security updates skip the delay (\"bypass\") or wait like other updates (\"delay\"), where the tool can tell them apart." }), "bypass")
}, { description: "Release-age delay (cooldown): freshly published versions wait before they are used." });
const installScriptsShape = object({
	default: required(access("Whether dependency lifecycle scripts (preinstall, install, postinstall) run by default; for Python, whether packages may be built from source.")),
	allow: withDefault(packagePatterns("Packages whose lifecycle scripts may run when the default is \"deny\"; Python packages listed here are always built from source."), [])
}, { description: "Code that dependencies run when they are installed: lifecycle scripts in npm, building from source in Python." });
const sourcesShape = object({
	git: optional(access("Dependencies installed from git repositories.")),
	remoteTarball: optional(access("Dependencies installed from tarball URLs outside the registry.")),
	file: optional(access("Dependencies installed from local tarball files.")),
	directory: optional(access("Dependencies installed from local directories."))
}, { description: "Where dependencies may come from besides the registry. An absent field is not managed." });
const targetsShape = anyOf([literal("auto", { description: "Configure the tools detected in the repository." }), list(oneOfStrings(TOOL_IDS, { description: "A tool depcurfew can configure." }), {
	label: "a list of tools",
	unique: true,
	nonEmpty: "use \"auto\" to detect tools",
	description: "Configure exactly these tools."
})], { description: "Tools to configure: \"auto\" detects them in the repository, or list them explicitly." });
const policyShape = object({
	$schema: optional(anyString({ description: "JSON Schema of this file, for editor support." })),
	version: required(literal(1, { description: "Version of the policy format." })),
	cooldown: optional(cooldownShape),
	installScripts: optional(installScriptsShape),
	sources: optional(sourcesShape),
	targets: withDefault(targetsShape, "auto")
}, { description: "One supply-chain security policy for npm, pnpm, Yarn, Bun, Deno, uv, pip, Poetry, PDM, Pipenv, Renovate and Dependabot." });

// src/policy/validate.ts
/** Parses one section on its own, so rules spanning several fields still run when another part of the file is invalid. */
function section(shape, document, key) {
	if (typeof document !== "object" || document === null || !(key in document)) return void 0;
	const result = shape.parse(document[key], [key], []);
	return result.ok ? result.value : void 0;
}
function crossFieldIssues(document, tools) {
	const issues = [];
	const installScripts = section(installScriptsShape, document, "installScripts");
	if (installScripts?.default === "allow" && installScripts.allow.length > 0) issues.push({
		path: formatPath(["installScripts", "allow"]),
		message: "has no effect when default is \"allow\"; remove the list or set default to \"deny\""
	});
	const cooldown = section(cooldownShape, document, "cooldown");
	const targets = section(targetsShape, document, "targets");
	if (cooldown !== void 0 && Array.isArray(targets)) for (const id of targets) {
		const tool = tools.find((candidate) => candidate.id === id);
		if (tool === void 0) continue;
		const conversion = convertCooldown(tool, cooldown.minimum);
		if (!conversion.ok) issues.push({
			path: formatPath(["cooldown", "minimum"]),
			message: conversion.reason
		});
	}
	return issues;
}
/** Validates a parsed policy document and fills in defaults. Reports every problem, each with the path to its field. */
function validatePolicy(document, tools = knowledgeBase) {
	const issues = [];
	const result = policyShape.parse(document, [], issues);
	issues.push(...crossFieldIssues(document, tools));
	if (result.ok && issues.length === 0) return {
		ok: true,
		policy: result.value
	};
	return {
		ok: false,
		issues
	};
}
/**
* V8 reports e.g. `Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)` or
* `Unexpected non-whitespace character after JSON at position 14`; older versions omit the line and column.
*/
function jsonErrorMessage(error, source) {
	const message = error instanceof Error ? error.message : String(error);
	const located = /^(.*?) (in|after) JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/su.exec(message);
	if (located === null) return `invalid JSON: ${message}`;
	const [, text = message, where = "in", position = "0"] = located;
	const reason = where === "after" ? `${text} after the JSON value` : text;
	let line = located[4];
	let column = located[5];
	if (line === void 0 || column === void 0) {
		const before = source.slice(0, Number(position)).split("\n");
		line = String(before.length);
		column = String((before.at(-1)?.length ?? 0) + 1);
	}
	return `invalid JSON at line ${line}, column ${column}: ${reason}`;
}
/** Parses and validates the text of a policy file. */
function parsePolicy(source, tools = knowledgeBase) {
	const text = source.startsWith("﻿") ? source.slice(1) : source;
	let document;
	try {
		document = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			issues: [{
				path: formatPath([]),
				message: jsonErrorMessage(error, text)
			}]
		};
	}
	return validatePolicy(document, tools);
}
function formatIssue(issue) {
	return `${issue.path}: ${issue.message}`;
}

// src/apply/generators/common.ts
const MINUTES$1 = {
	seconds: 1 / 60,
	minutes: 1,
	hours: 60,
	days: 1440,
	weeks: 10080
};
const SOURCE_LABELS = {
	npm: {
		git: "git",
		remoteTarball: "remote tarball",
		file: "local tarball",
		directory: "local directory"
	},
	pypi: {
		git: "git",
		remoteTarball: "URL",
		file: "local archive",
		directory: "local directory"
	}
};
/** The cooldown in the tool's unit, or undefined (with a warning) when it cannot be written. */
function cooldownValue(context, duration = context.policy.cooldown?.minimum) {
	if (duration === void 0) return void 0;
	const setting = settingOf(context.tool.cooldown.setting);
	if (setting === null) return void 0;
	const result = convertCooldown(context.tool, duration);
	if (!result.ok) {
		context.warn({
			code: "cooldown-not-written",
			message: `${context.name}: cooldown not written: ${result.reason}`,
			...result.fix === void 0 ? {} : { fix: result.fix }
		});
		return;
	}
	if (!context.supports(sinceOf(context.tool.cooldown.availableSince), setting)) return void 0;
	if (typeof result.value === "string") {
		const [count = "0", unit = ""] = result.value.split(" ");
		return {
			value: result.value,
			minutes: Number(count) * (MINUTES$1[unit.endsWith("s") ? unit : `${unit}s`] ?? 0)
		};
	}
	return {
		value: result.value,
		minutes: result.value * (MINUTES$1[result.unit] ?? 0)
	};
}
/** The exclusions (the policy's by default) that the tool's exclusion setting accepts; undefined when the setting cannot be used. */
function exclusions(context, patterns = context.policy.cooldown?.exclude ?? []) {
	const setting = settingOf(context.tool.cooldown.exclude.setting);
	if (setting === null) return void 0;
	if (patterns.length > 0 && !context.supports(sinceOf(context.tool.cooldown.exclude.availableSince), setting)) return void 0;
	const wildcards = extraOf(context.tool, "excludeWildcards", isWildcards);
	const wildcardsWork = wildcards.since !== null && context.atLeast(wildcards.since);
	return patterns.filter((pattern) => {
		if (!pattern.includes("*")) return true;
		const accepted = wildcardsWork && (!wildcards.trailingOnly || pattern.indexOf("*") === pattern.length - 1);
		if (!accepted) context.warn({
			code: "exclude-pattern-unsupported",
			message: `${context.name}: ${setting} does not support the pattern "${pattern}"; not written`,
			fix: "List the exact package names in cooldown.exclude"
		});
		return accepted;
	});
}
/** Allow-lists take package names only; patterns are dropped with a warning. */
function allowedNames(context, setting) {
	return (context.policy.installScripts?.allow ?? []).filter((pattern) => {
		if (!pattern.includes("*")) return true;
		context.warn({
			code: "allow-pattern-unsupported",
			message: `${context.name}: ${setting} takes package names only; "${pattern}" not written`,
			fix: "List the package names in installScripts.allow"
		});
		return false;
	});
}
/** Whether depcurfew doctor can tell dependency sources apart in the tool's lockfile. */
function lockfileShowsSources(tool) {
	const fact = tool.extra?.["lockfileFormat"];
	const format = fact === void 0 ? void 0 : values$1(fact)[0];
	return isRecord(format) && format["sources"] !== null;
}
/** Calls `apply` for every dependency source the policy manages and the tool has a setting for. */
function eachSource(context, apply) {
	const sources = context.policy.sources;
	if (sources === void 0) return;
	for (const kind of SOURCE_KINDS) {
		const access = sources[kind];
		if (access === void 0) continue;
		const knowledge = context.tool.sources?.[kind];
		const setting = settingOf(knowledge?.setting);
		if (setting === null) {
			if (access === "deny") context.warn({
				code: "source-not-enforceable",
				message: `${context.name} has no setting for ${SOURCE_LABELS[ecosystemOfTool(context.tool)][kind]} dependencies, so "deny" cannot be enforced`,
				fix: lockfileShowsSources(context.tool) ? "Run depcurfew doctor, which reports such dependencies in the lockfile" : "Review new dependencies by hand; depcurfew doctor cannot see them in the lockfile either"
			});
			continue;
		}
		if (!context.supports(sinceOf(knowledge?.availableSince), setting)) continue;
		apply(kind, setting, access);
	}
}
/** `install.minimumReleaseAge` → table `install`, key `minimumReleaseAge`. */
function splitDotted(setting) {
	const dot = setting.indexOf(".");
	return dot === -1 ? {
		table: "",
		key: setting
	} : {
		table: setting.slice(0, dot),
		key: setting.slice(dot + 1)
	};
}
function sameList(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

// src/apply/generators/bun.ts
const bun = (context) => {
	const { tool, policy } = context;
	const file = firstFile(tool.cooldown.configFiles) ?? "bunfig.toml";
	const entries = [];
	const managed = [];
	let table = "install";
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = splitDotted(settingOf(tool.cooldown.setting) ?? "install.minimumReleaseAge");
		table = setting.table;
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			entries.push(`${setting.key} = ${cooldown.value}`);
			managed.push(setting.key);
			const excludeSetting = settingOf(tool.cooldown.exclude.setting);
			const patterns = exclusions(context);
			if (excludeSetting !== null && patterns !== void 0) {
				const { key } = splitDotted(excludeSetting);
				managed.push(key);
				if (patterns.length > 0) entries.push(`${key} = [${patterns.map((pattern) => JSON.stringify(pattern)).join(", ")}]`);
			}
		}
	}
	if (policy.installScripts !== void 0) {
		if (policy.installScripts.default === "allow") context.warn({
			code: "allow-all-unsupported",
			message: `${context.name} has no setting that allows every install script; "allow" not written`,
			fix: "List the packages under installScripts.allow instead"
		});
		else {
			const setting = settingOf(tool.installScripts.allowList.setting);
			const since = sinceOf(tool.installScripts.allowList.availableSince);
			if (setting !== null && context.supports(since, setting)) {
				const listFile = settingOf(tool.installScripts.allowList.file) ?? "package.json";
				const names = policy.installScripts.allow.length > 0 ? allowedNames(context, setting) : [];
				const current = context.json(listFile).get([setting]);
				if (current === void 0) context.warn({
					code: "built-in-list-replaced",
					message: `${context.name}: ${setting} replaces Bun's built-in list of trusted packages, so packages on that list no longer run install scripts unless listed`,
					fix: "Add the ones that need their scripts to installScripts.allow"
				});
				const list = Array.isArray(current) ? [...current] : [];
				const merged = [...list, ...names.filter((name) => !list.includes(name))];
				if (current === void 0 || !sameList(current, merged)) context.json(listFile).set([setting], merged);
			}
		}
	}
	eachSource(context, () => void 0);
	if (entries.length > 0 || context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead")) context.toml(file, table, entries, managed);
	return minutes;
};

// src/apply/ini.ts
function keyOf$1(line) {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) return void 0;
	const equals = trimmed.indexOf("=");
	if (equals === -1) return void 0;
	return trimmed.slice(0, equals).trim().replace(/\[\]$/u, "");
}
function writeIniBlock(body, entries, managedKeys) {
	const managed = new Set(managedKeys);
	const removed = removeBlock(splitLines(body));
	const lines = removed.lines.map((line) => {
		const key = keyOf$1(line);
		return key !== void 0 && managed.has(key) ? `${entries.length === 0 ? TURNED_OFF : SUPERSEDED}${line.trim()}` : line;
	});
	if (entries.length === 0) return joinLines(lines);
	return joinLines(removed.at === void 0 ? insertBlock(lines, lines.length, entries) : insertBlock(lines, removed.at, entries, removed.separated));
}

// src/apply/pip-requirements.ts
/** The option a requirements line sets (--only-binary=x and --only-binary x alike), if it is an option line. */
function optionOf(line) {
	return /^\s*(--[a-z-]+)(?=[=\s]|$)/u.exec(line)?.[1];
}
function writeRequirementsBlock(body, entries, managedOptions) {
	const managed = new Set(managedOptions);
	const removed = removeBlock(splitLines(body));
	let at = 0;
	while (at < removed.lines.length && (removed.lines[at]?.trim().startsWith("#") ?? false)) at += 1;
	const lines = removed.lines.map((line) => {
		const option = optionOf(line);
		return option !== void 0 && managed.has(option) ? `${SUPERSEDED}${line.trim()}` : line;
	});
	if (entries.length === 0) return joinLines(lines);
	return joinLines(insertBlock(lines, removed.at ?? at, entries, removed.at === void 0 ? void 0 : removed.separated));
}

// src/apply/toml.ts
const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/u;
function keyOf(line) {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) return void 0;
	const equals = trimmed.indexOf("=");
	if (equals === -1) return void 0;
	return trimmed.slice(0, equals).trim().replace(/^["']|["']$/gu, "");
}
/** Follows a value through one line: strings (with escapes), multi-line strings, arrays, inline tables, comments. */
function scanLine(line, state) {
	let { depth, string } = state;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (string === "\"\"\"" || string === "'''") {
			if (string === "\"\"\"" && char === "\\") index += 1;
			else if (line.startsWith(string, index)) {
				string = "";
				index += 2;
			}
			continue;
		}
		if (string === "\"") {
			if (char === "\\") index += 1;
			else if (char === "\"") string = "";
			continue;
		}
		if (string === "'") {
			if (char === "'") string = "";
			continue;
		}
		if (char === "#") break;
		if (line.startsWith("\"\"\"", index) || line.startsWith("'''", index)) {
			string = line.startsWith("\"\"\"", index) ? "\"\"\"" : "'''";
			index += 2;
		} else if (char === "\"" || char === "'") string = char;
		else if (char === "[" || char === "{") depth += 1;
		else if (char === "]" || char === "}") depth -= 1;
	}
	return {
		depth,
		string: string === "\"" || string === "'" ? "" : string
	};
}
/** The index of the last line of the value that starts after the `=` on line `index`. */
function valueEnd(lines, index) {
	const line = lines[index] ?? "";
	let state = scanLine(line.slice(line.indexOf("=") + 1), {
		depth: 0,
		string: ""
	});
	let end = index;
	while ((state.depth > 0 || state.string !== "") && end + 1 < lines.length) {
		end += 1;
		state = scanLine(lines[end] ?? "", state);
	}
	return end;
}
function writeTomlBlock(body, table, entries, managedKeys, label) {
	const managed = new Set(managedKeys);
	const marker = blockStart(label);
	const removed = removeBlock(splitLines(body), marker);
	const lines = [...removed.lines];
	const topLevel = table === "";
	if (topLevel && removed.at === 0 && lines[0]?.trim() === "") lines.shift();
	const headers = /* @__PURE__ */ new Map();
	const boundaries = [];
	let current;
	let definedAtTop = false;
	const isManaged = (key) => managed.has(key) || [...managed].some((name) => key.startsWith(`${name}.`));
	const prefix = topLevel ? "" : `${table}.`;
	const note = entries.length === 0 ? TURNED_OFF : SUPERSEDED;
	let inManagedTable = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const header = HEADER.exec(line);
		if (header !== null) {
			const name = header[1] ?? "";
			inManagedTable = name.startsWith(prefix) && isManaged(name.slice(prefix.length));
			if (inManagedTable) {
				lines[index] = `${note}${line.trim()}`;
				continue;
			}
			current = name;
			boundaries.push(index);
			if (!line.trim().startsWith("[[")) headers.set(index, current);
			continue;
		}
		const key = keyOf(line);
		if (key === void 0) continue;
		const end = valueEnd(lines, index);
		const inTable = (topLevel ? current === void 0 : current === table) && isManaged(key);
		const dotted = !topLevel && current === void 0 && key.startsWith(`${table}.`) && isManaged(key.slice(table.length + 1));
		if (inManagedTable || inTable || dotted) {
			lines[index] = `${note}${line.trim()}`;
			for (let next = index + 1; next <= end; next++) lines[next] = `# ${lines[next] ?? ""}`;
		} else if (!topLevel && current === void 0 && (key === table || key.startsWith(`${table}.`) || table.startsWith(`${key}.`))) definedAtTop = true;
		index = end;
	}
	if (entries.length === 0) return joinLines(lines);
	if (topLevel) {
		const firstTable = boundaries[0] ?? lines.length;
		if (removed.at !== void 0 && removed.at <= firstTable) return joinLines(topBlock(lines, removed.at, entries, removed.separated, marker));
		let end = firstTable;
		while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
		return joinLines(topBlock(lines, end, entries, void 0, marker));
	}
	const headerIndex = [...headers].find(([, name]) => name === table)?.[0] ?? -1;
	const nextHeaderAfter = (from) => boundaries.find((index) => index > from) ?? -1;
	if (headerIndex === -1) {
		if (definedAtTop) throw new Error(`${table} is defined with dotted keys or an inline table, so a [${table}] table cannot be added; move its settings under a [${table}] header`);
		const prefix = lines.length > 0 && lines.at(-1)?.trim() !== "" ? [...lines, ""] : lines;
		return joinLines([
			...prefix,
			`[${table}]`,
			...insertBlock([], 0, entries, void 0, marker)
		]);
	}
	if (removed.at !== void 0 && removed.at > headerIndex) {
		const nextHeader = nextHeaderAfter(headerIndex);
		if (nextHeader === -1 || removed.at <= nextHeader) return joinLines(insertBlock(lines, removed.at, entries, removed.separated, marker));
	}
	let end = nextHeaderAfter(headerIndex);
	if (end === -1) end = lines.length;
	while (end > headerIndex + 1 && lines[end - 1]?.trim() === "") end -= 1;
	return joinLines(insertBlock(lines, end, entries, void 0, marker));
}
/** A top-level block, with a blank line before the first table that follows it. */
function topBlock(lines, at, entries, separate, marker) {
	const result = insertBlock(lines, at, entries, separate, marker);
	const after = at + (result.length - lines.length);
	if (result[after] !== void 0 && result[after]?.trim() !== "") result.splice(after, 0, "");
	return result;
}

// src/apply/yaml-edit.ts
const YAML_MARKER = "# managed by depcurfew";
function parse(text) {
	const lineCounter = new import_dist.LineCounter();
	const document = (0, import_dist.parseDocument)(text, { lineCounter });
	if (document.errors.length > 0) throw new Error(document.errors[0]?.message.split("\n", 1)[0] ?? "invalid YAML");
	return {
		document,
		lineCounter
	};
}
function equal(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function lineStart(text, position) {
	return text.lastIndexOf("\n", position - 1) + 1;
}
/** Whether block sequences in the document are indented under their key (the yaml default) or not. */
function indentsSequences(text) {
	const match = /^([ \t]*)[^\s#-][^\n]*:[ \t]*(?:#[^\n]*)?\n([ \t]*)- /mu.exec(text);
	return match === null ? true : (match[2]?.length ?? 0) > (match[1]?.length ?? 0);
}
function indentUnit(text) {
	const sizes = [...text.matchAll(/\n( +)\S/gu)].map((match) => match[1]?.length ?? 0).filter((size) => size > 0);
	return sizes.length === 0 ? 2 : Math.min(...sizes);
}
function render(value, text) {
	return (0, import_dist.stringify)(value, {
		indent: indentUnit(text),
		indentSeq: indentsSequences(text),
		lineWidth: 0
	});
}
function indentLines(block, indent) {
	return block.split("\n").map((line) => line === "" ? line : `${indent}${line}`).join("\n");
}
function nest(path, value) {
	return path.reduceRight((inner, segment) => ({ [String(segment)]: inner }), value);
}
/** Whether the line above the key at `keyStart` is the marker. */
function marked(text, keyStart) {
	const start = lineStart(text, keyStart);
	return start > 0 && text.slice(lineStart(text, start - 1), start - 1).trim() === "# managed by depcurfew";
}
/** Adds the marker line above the key at `keyStart`, unless it is already there or the key shares a line with "- ". */
function mark(text, keyStart) {
	const start = lineStart(text, keyStart);
	const indent = text.slice(start, keyStart);
	if (!/^[ \t]*$/u.test(indent) || marked(text, keyStart)) return text;
	return `${text.slice(0, start)}${indent}${YAML_MARKER}\n${text.slice(start)}`;
}
function yamlGet(text, path) {
	let current = parse(text).document.toJS();
	for (const segment of path) {
		if (typeof current !== "object" || current === null) return void 0;
		current = current[String(segment)];
	}
	return current;
}
function findPair(node, key) {
	if (!(0, import_dist.isMap)(node)) return void 0;
	return node.items.filter((pair) => (0, import_dist.isScalar)(pair.key) && String(pair.key.value) === key).at(-1);
}
/** Whether a map or sequence is written in flow style ({ ... } or [ ... ]). */
function isFlow(node) {
	return ((0, import_dist.isMap)(node) || (0, import_dist.isSeq)(node)) && node.flow === true;
}
/**
* New keys and block values cannot be written into a flow collection without rewriting it, which would not keep the
* file as it is; the user rewrites it or sets the value by hand. Scalars inside it are still replaced in place.
*/
function refuseFlow(path, index, value) {
	const where = index === 0 ? "the document" : path.slice(0, index).join(".");
	throw new Error(`${where} is written in flow style ({ ... } or [ ... ]), which depcurfew does not edit; rewrite it in block style, or set ${path.join(".")} to ${JSON.stringify(value)} by hand`);
}
/** Sets the value at `path`, creating missing maps on the way, and marks the key that was written. */
function yamlSet(text, path, value) {
	const { document, lineCounter } = parse(text);
	const column = (offset) => lineCounter.linePos(offset).col - 1;
	if (document.contents === null || (0, import_dist.isScalar)(document.contents) && document.contents.value === null) return `${text.trim() === "" ? "" : text.endsWith("\n") ? text : `${text}\n`}${YAML_MARKER}\n${render(nest(path, value), text)}`;
	let node = document.contents;
	if (!(0, import_dist.isMap)(node)) throw new Error("the YAML document is not a map");
	let insideMarked = false;
	for (const [index, segment] of path.entries()) {
		if (typeof segment === "number") {
			if (!(0, import_dist.isSeq)(node) || node.items[segment] === void 0) throw new Error(`no item ${segment} at ${path.slice(0, index).join(".")}`);
			node = node.items[segment];
			continue;
		}
		if (!(0, import_dist.isMap)(node)) throw new Error(`${path.slice(0, index).join(".")} is not a map`);
		const pair = findPair(node, segment);
		if (pair === void 0) {
			if (isFlow(node)) refuseFlow(path, index, value);
			const first = node.items[0];
			const indent = first === void 0 || first.key.range === null || first.key.range === void 0 ? "" : " ".repeat(column(first.key.range[0]));
			let insertAt = (node.range ?? [
				text.length,
				text.length,
				text.length
			])[2];
			const prefix = insertAt > 0 && text[insertAt - 1] !== "\n" ? "\n" : "";
			const addition = indentLines(`${insideMarked ? "" : `${YAML_MARKER}\n`}${render({ [segment]: nest(path.slice(index + 1), value) }, text)}`, indent);
			return `${text.slice(0, insertAt)}${prefix}${addition}${text.slice(insertAt)}`;
		}
		if (index === path.length - 1) {
			if (equal(pair.value === null ? null : pair.value.toJSON(), value)) return text;
			const keyRange = pair.key.range;
			const valueNode = pair.value;
			let replaced;
			if (valueNode !== null && (0, import_dist.isScalar)(valueNode) && (value === null || typeof value !== "object")) {
				const [start, end] = valueNode.range;
				replaced = `${text.slice(0, start)}${render(value, text).trimEnd()}${text.slice(end)}`;
			} else {
				if (isFlow(node)) refuseFlow(path, index, value);
				const colon = text.indexOf(":", keyRange[1]);
				const end = valueNode === null ? text.indexOf("\n", colon) : valueNode.range[2];
				const stop = end === -1 ? text.length : end;
				const keyIndent = column(keyRange[0]);
				const seq = Array.isArray(value);
				const blockIndent = " ".repeat(seq && !indentsSequences(text) ? keyIndent : keyIndent + indentUnit(text));
				const body = value !== null && typeof value === "object" && Object.keys(value).length > 0 ? `\n${indentLines(render(value, text), blockIndent)}` : ` ${render(value, text).trimEnd()}\n`;
				const tail = text.slice(stop);
				replaced = `${text.slice(0, colon + 1)}${body}${tail.startsWith("\n") && body.endsWith("\n") ? tail.slice(1) : tail}`;
			}
			return insideMarked ? replaced : mark(replaced, keyRange[0]);
		}
		if (pair.value === null || !((0, import_dist.isMap)(pair.value) || (0, import_dist.isSeq)(pair.value))) {
			if (isFlow(node)) refuseFlow(path, index, value);
			return yamlSet(text, path.slice(0, index + 1), nest(path.slice(index + 1), value));
		}
		if (pair.key.range !== null && pair.key.range !== void 0 && marked(text, pair.key.range[0])) insideMarked = true;
		node = pair.value;
	}
	return text;
}

// src/apply/generators/context.ts
var EditFailed = class extends Error {};
function createContext(options) {
	const { tool, workspace, warnings, failures } = options;
	const atLeast = (since) => {
		const required = since === void 0 ? void 0 : parseVersion(since);
		return options.version === void 0 || required === void 0 || compareVersions$1(options.version, required) >= 0;
	};
	const unsupported = [];
	const warn = (warning) => {
		const { code, ...rest } = warning;
		if (!warnings.some((known) => known.code === code && known.message === warning.message)) warnings.push({
			code,
			tool: tool.id,
			...rest
		});
	};
	const guard = (file, action) => {
		try {
			return action();
		} catch (error) {
			if (error instanceof EditFailed) throw error;
			const message = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]?.replace(/:$/u, "") ?? "";
			failures.push({
				tool: tool.id,
				file,
				message
			});
			throw new EditFailed(message);
		}
	};
	return {
		tool,
		tools: options.tools,
		targets: options.targets,
		name: tool.name,
		policy: options.policy,
		version: options.version,
		workspace,
		exists: (file) => guard(file, () => workspace.exists(file)),
		read: (file) => guard(file, () => workspace.read(file)),
		warn,
		snippet: (file, text) => options.snippets.push({
			tool: tool.id,
			file,
			text
		}),
		supports(since, setting) {
			if (atLeast(since)) return true;
			if (since !== void 0) unsupported.push({
				setting,
				since
			});
			return false;
		},
		finish() {
			if (unsupported.length === 0) return;
			const needed = unsupported.map((item) => item.since).reduce((a, b) => compareVersions$1(parseVersion(a) ?? [
				0,
				0,
				0
			], parseVersion(b) ?? [
				0,
				0,
				0
			]) >= 0 ? a : b);
			warn({
				code: "version-too-old",
				message: `${tool.name} ${formatVersion(options.version ?? [
					0,
					0,
					0
				])} does not support ${describeRequirements(unsupported)}; not written`,
				fix: `Require ${tool.name} ${needed} or later where the version is pinned`
			});
		},
		atLeast,
		json: (file) => ({
			get: (path) => guard(file, () => workspace.exists(file) ? jsonGet(workspace.read(file), path) : void 0),
			set: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonSet(body === "" ? "{}\n" : body, path, value))),
			append: (path, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayAppend(body, path, value))),
			replace: (path, index, value) => guard(file, () => workspace.edit(file, (body) => jsonArrayReplace(body, path, index, value))),
			remove: (path, index) => guard(file, () => workspace.edit(file, (body) => jsonArrayRemove(body, path, index)))
		}),
		yaml: (file) => ({
			get: (path) => guard(file, () => workspace.exists(file) ? yamlGet(workspace.read(file), path) : void 0),
			set: (path, value) => guard(file, () => workspace.edit(file, (body) => yamlSet(body, path, value)))
		}),
		ini: (file, entries, managedKeys) => guard(file, () => workspace.edit(file, (body) => writeIniBlock(body, entries, managedKeys))),
		toml: (file, table, entries, managedKeys, label) => guard(file, () => workspace.edit(file, (body) => {
			parseToml(body);
			const edited = writeTomlBlock(body, table, entries, managedKeys, label);
			parseToml(edited);
			return edited;
		})),
		requirements: (file, entries, managedOptions) => guard(file, () => workspace.edit(file, (body) => writeRequirementsBlock(body, entries, managedOptions)))
	};
}

// src/apply/generators/deno.ts
const isString$2 = (value) => typeof value === "string";
function configFile(context) {
	const manifests = context.tool.project?.manifests;
	const names = manifests !== void 0 && manifests.status !== "disputed" ? [...manifests.value] : ["deno.json"];
	return names.find((name) => context.exists(name)) ?? names[0] ?? "deno.json";
}
const deno = (context) => {
	const { tool, policy } = context;
	const json = context.json(configFile(context));
	const prefix = extraOf(tool, "npmSpecifierPrefix", isString$2);
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "minimumDependencyAge";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			const patterns = exclusions(context) ?? [];
			const excludeKey = (settingOf(tool.cooldown.exclude.setting) ?? "minimumDependencyAge.exclude").split(".").at(-1) ?? "exclude";
			const value = patterns.length > 0 ? {
				[extraOf(tool, "ageObjectKey", isString$2)]: cooldown.value,
				[excludeKey]: patterns.map((pattern) => `${prefix}${pattern}`)
			} : cooldown.value;
			json.set([setting], value);
		}
	}
	if (policy.installScripts !== void 0) {
		const allowAll = extraOf(tool, "allowAllScripts", isSwitch);
		if (policy.installScripts.default === "allow") {
			if (context.supports(allowAll.since, allowAll.setting)) json.set([allowAll.setting], allowAll.value);
		} else {
			const setting = settingOf(tool.installScripts.allowList.setting) ?? allowAll.setting;
			const since = sinceOf(tool.installScripts.allowList.availableSince);
			const specifiers = (policy.installScripts.allow.length > 0 && context.supports(since, setting) ? allowedNames(context, setting) : []).map((name) => `${prefix}${name}`);
			const current = json.get([setting]);
			const path = isRecord(current) ? [setting, "allow"] : [setting];
			const allowed = isRecord(current) ? current["allow"] : current;
			if (allowed === allowAll.value && context.atLeast(since)) {
				context.warn({
					code: "allow-all-replaced",
					message: `${context.name}: ${setting} allowed every install script; replaced with the policy's allow-list`
				});
				json.set(path, specifiers);
			} else if (specifiers.length > 0) {
				if (Array.isArray(allowed)) {
					for (const specifier of specifiers) if (!allowed.includes(specifier)) json.append(path, specifier);
				} else json.set(path, specifiers);
			}
		}
	}
	eachSource(context, () => void 0);
	return minutes;
};

// src/apply/generators/dependabot.ts
const isKeys = (value) => isRecord(value) && typeof value["days"] === "string" && typeof value["exclude"] === "string" && Array.isArray(value["semverDays"]) && value["semverDays"].every((key) => typeof key === "string");
const dependabot = (context, duration) => {
	const { tool, policy } = context;
	if (policy.cooldown === void 0 || duration === void 0) return;
	const file = (values$1(tool.cooldown.configFiles)[0] ?? []).find((name) => context.exists(name));
	if (file === void 0) {
		context.warn({
			code: "bot-config-missing",
			message: `${context.name}: no configuration file found; depcurfew does not create one`,
			fix: "Add .github/dependabot.yml if you use Dependabot, then run depcurfew apply again"
		});
		return;
	}
	if (policy.cooldown.securityUpdates === "delay") context.warn({
		code: "security-delay-unsupported",
		message: `${context.name} cannot delay security updates (cooldown applies to version updates only); securityUpdates "delay" not applied`
	});
	const result = convertCooldown(tool, duration);
	if (!result.ok) {
		context.warn({
			code: "cooldown-not-written",
			message: `${context.name}: cooldown not written: ${result.reason}`,
			...result.fix === void 0 ? {} : { fix: result.fix }
		});
		return;
	}
	const keys = extraOf(tool, "cooldownKeys", isKeys);
	const managers = extraOf(tool, "ecosystems", isRecord);
	const ecosystems = Object.keys(managers);
	const setting = settingOf(tool.cooldown.setting) ?? "cooldown";
	const yaml = context.yaml(file);
	const updates = yaml.get(["updates"]);
	const patternsOf = (ecosystem) => {
		const covered = Array.isArray(managers[ecosystem]) ? managers[ecosystem] : [];
		const python = context.tools.some((entry) => covered.includes(entry.id) && ecosystemOfTool(entry) === "pypi");
		return exclusions(context, patternsFor(policy.cooldown?.exclude ?? [], python ? "pypi" : "npm")) ?? [];
	};
	let configured = 0;
	(Array.isArray(updates) ? updates : []).forEach((entry, index) => {
		if (!isRecord(entry) || !ecosystems.includes(String(entry["package-ecosystem"]))) return;
		configured += 1;
		const patterns = patternsOf(String(entry["package-ecosystem"]));
		const current = entry[setting];
		if (!isRecord(current)) {
			yaml.set([
				"updates",
				index,
				setting
			], {
				[keys.days]: result.value,
				...patterns.length > 0 ? { [keys.exclude]: patterns } : {}
			});
			return;
		}
		yaml.set([
			"updates",
			index,
			setting,
			keys.days
		], result.value);
		for (const key of keys.semverDays) {
			const days = current[key];
			if (typeof days === "number" && typeof result.value === "number" && days < result.value) yaml.set([
				"updates",
				index,
				setting,
				key
			], result.value);
		}
		if ((patterns.length > 0 || keys.exclude in current) && !sameList(current[keys.exclude], patterns)) yaml.set([
			"updates",
			index,
			setting,
			keys.exclude
		], patterns);
	});
	if (configured === 0) context.warn({
		code: "bot-entries-missing",
		location: { file },
		message: `${context.name}: no ${ecosystems.join(", ")} entries in ${file}; nothing to configure`,
		fix: `Add an updates entry for each package manager Dependabot should update to ${file}, then run depcurfew apply again`
	});
};

// src/apply/generators/npm.ts
const isString$1 = (value) => typeof value === "string";
const npm = (context) => {
	const { tool, policy } = context;
	const file = firstFile(tool.cooldown.configFiles) ?? ".npmrc";
	const entries = [];
	const managed = [];
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "min-release-age";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			entries.push(`${setting}=${cooldown.value}`);
			managed.push(setting);
			const excludeSetting = settingOf(tool.cooldown.exclude.setting);
			const patterns = exclusions(context);
			if (excludeSetting !== null && patterns !== void 0 && context.atLeast(sinceOf(tool.cooldown.exclude.availableSince))) {
				const suffix = extraOf(tool, "npmrcListSyntax", isString$1);
				for (const pattern of patterns) entries.push(`${excludeSetting}${suffix}=${pattern}`);
				managed.push(excludeSetting);
			}
		}
	}
	if (policy.installScripts !== void 0) {
		const allowAll = extraOf(tool, "allowAllScripts", isSwitch);
		if (policy.installScripts.default === "allow") {
			if (context.supports(allowAll.since, allowAll.setting)) {
				entries.push(`${allowAll.setting}=${String(allowAll.value)}`);
				managed.push(allowAll.setting);
			}
		} else {
			if (context.atLeast(allowAll.since)) managed.push(allowAll.setting);
			let defaults;
			for (const entry of values$1(tool.installScripts.defaultPolicy)[0] ?? []) if (context.atLeast(entry.since)) defaults = entry.value;
			const strict = extraOf(tool, "strictAllowScripts", isSwitch);
			if (defaults === "run-with-warning" && context.supports(strict.since, strict.setting)) {
				entries.push(`${strict.setting}=${String(strict.value)}`);
				managed.push(strict.setting);
			} else if (defaults === "run") {
				const since = sinceOf(tool.installScripts.allowList.availableSince) ?? "";
				context.warn({
					code: "scripts-not-enforceable",
					message: `${context.name} ${formatVersion(context.version ?? [
						0,
						0,
						0
					])} runs every dependency install script and has no allow-list, so "deny" cannot be enforced`,
					fix: `Require npm ${since} or later (npm 12 blocks dependency scripts by default)`
				});
			}
			const setting = settingOf(tool.installScripts.allowList.setting);
			const listFile = settingOf(tool.installScripts.allowList.file) ?? "package.json";
			if (setting !== null) {
				if (policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting)) {
					const json = context.json(listFile);
					for (const name of allowedNames(context, setting)) if (json.get([setting, name]) !== true) json.set([setting, name], true);
				}
			}
		}
	}
	eachSource(context, (_kind, setting, access) => {
		entries.push(`${setting}=${access === "deny" ? "none" : "all"}`);
		managed.push(setting);
	});
	if (entries.length > 0 || context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead") || managed.length > 0 && context.exists(file)) context.ini(file, entries, managed);
	return minutes;
};

// src/apply/generators/python.ts
/** The policy's Python allow-list as normalized names; patterns with * are dropped with a warning. */
function buildAllowList(context, setting) {
	return [...new Set(allowedNames(context, setting).map(normalizePythonName))];
}
/** Exclusions as normalized names. */
function pythonNames(names) {
	return [...new Set(names.map(normalizePythonName))];
}
function forcedBuildWarning(context, setting, names) {
	if (names.length === 0) return;
	context.warn({
		code: "forced-source-build",
		message: `${context.name}: ${setting} lets ${names.join(", ")} be built from source while building is forbidden for everything else; ${context.name} then always builds ${names.length === 1 ? "it" : "them"} from source, even where a wheel exists, because it has no setting that only allows building`
	});
}
/** Says when the tool's switch does not stop git, local and URL dependencies from being built. */
function buildSwitchScopeWarning(context, setting, covers) {
	if (Array.isArray(covers) && covers.includes("git") && covers.includes("directory")) return;
	context.warn({
		code: "build-switch-scope",
		message: `${context.name}: ${setting} forbids building only packages from an index; ${context.name} still builds git, local directory and source archive dependencies`,
		fix: "Run depcurfew doctor to find them in the lockfile"
	});
}
/** A TOML string or array value. */
function tomlValue(value) {
	return Array.isArray(value) ? `[${value.map((item) => tomlValue(item)).join(", ")}]` : JSON.stringify(value);
}
const COMPACT_UNITS = {
	hour: "h",
	day: "d",
	week: "w"
};
/** A duration such as "36 hours" in the compact form PDM and Pipenv read: "36h". */
function compactDuration(value) {
	const [count = "", unit = ""] = value.split(" ");
	const letter = COMPACT_UNITS[unit.replace(/s$/u, "")];
	if (letter === void 0) throw new Error(`cannot write the duration "${value}" in compact form`);
	return `${count}${letter}`;
}

// src/apply/generators/pip.ts
const pip = (context) => {
	const { tool, policy } = context;
	const file = (tool.project === void 0 ? void 0 : firstFile(tool.project.manifests)) ?? "requirements.txt";
	if (policy.cooldown !== void 0) {
		const flag = settingOf(tool.cooldown.setting) ?? "uploaded-prior-to";
		const variable = extraOf(tool, "environmentVariable", (value) => typeof value === "string");
		const since = sinceOf(tool.cooldown.availableSince);
		const result = convertCooldown(tool, policy.cooldown.minimum);
		const value = result.ok ? `P${String(result.value)}D` : void 0;
		const version = context.version === void 0 || context.atLeast(since) ? "" : ` (pip ${formatVersion(context.version)} is too old for it)`;
		context.warn({
			code: "cooldown-environment-only",
			message: `${context.name}: cooldown not written: pip reads no configuration from the project and rejects --${flag} in requirements files${version}`,
			fix: `Set ${variable}${value === void 0 ? "" : `=${value}`} where pip installs packages (CI, Dockerfile), with pip ${since ?? "a recent version"} or later`
		});
	}
	const entries = [];
	const managed = [];
	if (policy.installScripts?.default === "deny") {
		const build = extraOf(tool, "buildSwitch", isSwitch);
		const setting = settingOf(tool.installScripts.allowList.setting);
		if (context.supports(build.since, build.setting)) {
			entries.push(`${build.setting}=${String(build.value)}`);
			managed.push(build.setting);
			buildSwitchScopeWarning(context, build.setting, build.covers);
			if (setting !== null) {
				managed.push(setting);
				const names = policy.installScripts.allow.length > 0 ? buildAllowList(context, setting) : [];
				for (const name of names) entries.push(`${setting}=${name}`);
				forcedBuildWarning(context, setting, names);
			}
		}
	}
	eachSource(context, () => void 0);
	if (!context.exists(file)) {
		if (entries.length > 0) context.warn({
			code: "requirements-file-missing",
			message: `${context.name}: no ${file}, so ${entries.join(" and ")} not written`,
			fix: `Add ${entries.length === 1 ? "it" : "them"} to the pip command or the requirements file pip installs from`
		});
		return;
	}
	if (entries.length > 0 || context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead")) context.requirements(file, entries, managed);
};

// src/apply/generators/pnpm.ts
const isLegacy = (value) => isRecord(value) && typeof value["since"] === "string" && typeof value["workspaceFileSince"] === "string" && typeof value["removedIn"] === "string";
const pnpm = (context) => {
	const { tool, policy } = context;
	const file = firstFile(tool.cooldown.configFiles) ?? "pnpm-workspace.yaml";
	const yaml = context.yaml(file);
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "minimumReleaseAge";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			yaml.set([setting], cooldown.value);
			const strict = extraOf(tool, "minimumReleaseAgeStrict", isSwitch);
			if (context.atLeast(strict.since) && yaml.get([strict.setting]) !== strict.value) yaml.set([strict.setting], strict.value);
			const exact = extraOf(tool, "cooldownExactVersions", (value) => typeof value === "string");
			if (!context.atLeast(exact)) context.warn({
				code: "exact-version-gap",
				message: `${context.name} ${formatVersion(context.version ?? [
					0,
					0,
					0
				])} skips ${setting} for packages requested by exact version`,
				fix: `Require pnpm ${exact} or later`
			});
		}
		const excludeSetting = settingOf(tool.cooldown.exclude.setting);
		const patterns = cooldown === void 0 ? void 0 : exclusions(context);
		if (excludeSetting !== null && patterns !== void 0 && (patterns.length > 0 || yaml.get([excludeSetting]) !== void 0)) {
			if (!sameList(yaml.get([excludeSetting]), patterns)) yaml.set([excludeSetting], patterns);
		}
	}
	if (policy.installScripts !== void 0) {
		const allowAll = extraOf(tool, "allowAllBuilds", isSwitch);
		if (policy.installScripts.default === "allow") {
			if (context.supports(allowAll.since, allowAll.setting)) yaml.set([allowAll.setting], allowAll.value);
		} else {
			if (context.atLeast(allowAll.since) && yaml.get([allowAll.setting]) === allowAll.value) {
				context.warn({
					code: "allow-all-replaced",
					message: `${context.name}: ${allowAll.setting} allowed every build script; set to false because the policy denies install scripts`
				});
				yaml.set([allowAll.setting], false);
			}
			const setting = settingOf(tool.installScripts.allowList.setting) ?? "allowBuilds";
			const since = sinceOf(tool.installScripts.allowList.availableSince);
			const wanted = policy.installScripts.allow.length > 0;
			if (context.atLeast(since)) {
				if (wanted) {
					for (const name of allowedNames(context, setting)) if (yaml.get([setting, name]) !== true) yaml.set([setting, name], true);
				}
			} else {
				const legacy = extraOf(tool, "onlyBuiltDependencies", isLegacy);
				if (wanted && context.supports(legacy.since, "onlyBuiltDependencies")) {
					const names = allowedNames(context, "onlyBuiltDependencies");
					const inWorkspaceFile = context.atLeast(legacy.workspaceFileSince);
					const target = inWorkspaceFile ? yaml : context.json("package.json");
					const path = inWorkspaceFile ? ["onlyBuiltDependencies"] : ["pnpm", "onlyBuiltDependencies"];
					const current = target.get(path);
					const list = Array.isArray(current) ? [...current] : [];
					const merged = [...list, ...names.filter((name) => !list.includes(name))];
					if (!sameList(current, merged)) target.set(path, merged);
				}
			}
		}
	}
	const exotic = /* @__PURE__ */ new Map();
	let exoticSetting;
	eachSource(context, (kind, setting, access) => {
		exotic.set(kind, access);
		exoticSetting = setting;
	});
	if (exoticSetting !== void 0) {
		const denied = [...exotic].filter(([, access]) => access === "deny").map(([kind]) => kind === "git" ? "git" : "remote tarball");
		if (denied.length > 0) {
			context.warn({
				code: "source-switch-indirect-only",
				message: `pnpm: ${exoticSetting} stops git and tarball sources only for indirect dependencies; direct ones stay allowed`,
				fix: "Run depcurfew doctor, which reports direct ones in pnpm-lock.yaml"
			});
			if (denied.length < exotic.size) context.warn({
				code: "source-switch-combined",
				message: `pnpm: ${exoticSetting} covers git and tarball dependencies together; set to true because the policy denies ${denied.join(" and ")}`
			});
		}
		yaml.set([exoticSetting], denied.length > 0);
	}
	return minutes;
};

// src/apply/generators/pdm.ts
const pdm = (context) => {
	const { tool, policy } = context;
	const tables = extraOf(tool, "configTables", isRecord);
	const file = "pyproject.toml";
	const table = typeof tables[file] === "string" ? tables[file] : "tool.pdm.resolution";
	const entries = [];
	const managed = [];
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "exclude-newer";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			entries.push(`${setting} = ${tomlValue(compactDuration(String(cooldown.value)))}`);
			managed.push(setting);
			const excludeSetting = settingOf(tool.cooldown.exclude.setting);
			const patterns = exclusions(context);
			if (excludeSetting !== null && patterns !== void 0) {
				managed.push(excludeSetting);
				const exempt = extraOf(tool, "excludeValue", (value) => typeof value === "boolean");
				const names = pythonNames(patterns);
				if (names.length > 0) entries.push(`${excludeSetting} = { ${names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`).join(", ")} }`);
			}
		}
	}
	if (policy.installScripts?.default === "deny") {
		const build = extraOf(tool, "buildSwitch", isSwitch);
		if (context.supports(build.since, build.setting)) {
			entries.push(`${build.setting} = ${tomlValue(build.value)}`);
			managed.push(build.setting);
			buildSwitchScopeWarning(context, build.setting, build.covers);
			const setting = settingOf(tool.installScripts.allowList.setting);
			if (setting !== null) {
				managed.push(setting);
				const names = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting) ? buildAllowList(context, setting) : [];
				if (names.length > 0) entries.push(`${setting} = ${tomlValue(names)}`);
				forcedBuildWarning(context, setting, names);
			}
		}
	}
	eachSource(context, () => void 0);
	if (entries.length > 0 || context.exists(file) && context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead")) context.toml(file, table, entries, managed);
	return minutes;
};

// src/apply/generators/pipenv.ts
const pipenv = (context) => {
	const { tool, policy } = context;
	const tables = extraOf(tool, "configTables", isRecord);
	const file = "Pipfile";
	const table = typeof tables[file] === "string" ? tables[file] : "pipenv";
	const entries = [];
	const managed = [];
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "cool-down-period";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			entries.push(`${setting} = ${tomlValue(compactDuration(String(cooldown.value)))}`);
			managed.push(setting);
		}
		if (policy.cooldown.exclude.length > 0 && settingOf(tool.cooldown.exclude.setting) === null) context.warn({
			code: "exclude-unsupported",
			message: `${context.name}: no setting exempts packages from ${setting}, so the Python packages in cooldown.exclude wait like every other package`
		});
	}
	if (policy.installScripts?.default === "deny" && settingOf(tool.installScripts.disableAll) === null) context.warn({
		code: "build-switch-environment-only",
		message: `${context.name}: the Pipfile has no setting that forbids building packages from source, so installScripts "deny" is not written`,
		fix: "Set PIP_ONLY_BINARY=:all: where Pipenv installs packages (CI, Dockerfile); Pipenv passes it on to pip"
	});
	eachSource(context, () => void 0);
	if (entries.length > 0 || context.exists(file) && context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead")) context.toml(file, table, entries, managed);
	return minutes;
};

// src/apply/generators/poetry.ts
function writeTable(context, file, table, entries, managed) {
	if (entries.length > 0 || context.exists(file) && context.read(file).includes(blockStart(table))) context.toml(file, table, entries, managed, table);
}
const poetry = (context) => {
	const { tool, policy } = context;
	const file = firstFile(tool.cooldown.configFiles) ?? "poetry.toml";
	let minutes;
	const solver = {
		table: "solver",
		entries: [],
		managed: []
	};
	if (policy.cooldown !== void 0) {
		const setting = splitDotted(settingOf(tool.cooldown.setting) ?? "solver.min-release-age");
		solver.table = setting.table;
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			solver.entries.push(`${setting.key} = ${tomlValue(cooldown.value)}`);
			solver.managed.push(setting.key);
			const excludeSetting = settingOf(tool.cooldown.exclude.setting);
			const patterns = exclusions(context);
			if (excludeSetting !== null && patterns !== void 0) {
				const { key } = splitDotted(excludeSetting);
				solver.managed.push(key);
				const names = pythonNames(patterns);
				if (names.length > 0) solver.entries.push(`${key} = ${tomlValue(names)}`);
			}
		}
	}
	writeTable(context, file, solver.table, solver.entries, solver.managed);
	const installer = {
		table: "installer",
		entries: [],
		managed: []
	};
	if (policy.installScripts?.default === "deny") {
		const build = extraOf(tool, "buildSwitch", isSwitch);
		const { table, key } = splitDotted(build.setting);
		installer.table = table;
		if (context.supports(build.since, build.setting)) {
			installer.entries.push(`${key} = ${tomlValue(build.value)}`);
			installer.managed.push(key);
			context.warn({
				code: "build-switch-install-only",
				message: `${context.name}: ${build.setting} applies when packages are installed; poetry lock may still build source distributions to read their dependencies`
			});
			buildSwitchScopeWarning(context, build.setting, build.covers);
			const setting = settingOf(tool.installScripts.allowList.setting);
			if (setting !== null) {
				installer.managed.push(splitDotted(setting).key);
				const names = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting) ? buildAllowList(context, setting) : [];
				if (names.length > 0) installer.entries.push(`${splitDotted(setting).key} = ${tomlValue(names)}`);
				forcedBuildWarning(context, setting, names);
			}
		}
	}
	writeTable(context, file, installer.table, installer.entries, installer.managed);
	eachSource(context, () => void 0);
	return minutes;
};

// src/apply/generators/renovate.ts
const RULE_DESCRIPTION = "depcurfew: packages excluded from minimumReleaseAge";
const PYTHON_RULE_DESCRIPTION = "depcurfew: Python packages excluded from minimumReleaseAge";
const isString = (value) => typeof value === "string";
const isRule = (value) => isRecord(value) && typeof value["list"] === "string" && typeof value["match"] === "string";
const isPath = (value) => Array.isArray(value) && value.every(isString);
const renovate = (context, duration) => {
	const { tool, policy } = context;
	if (policy.cooldown === void 0 || duration === void 0) return;
	const result = convertCooldown(tool, duration);
	if (!result.ok) {
		context.warn({
			code: "cooldown-not-written",
			message: `${context.name}: cooldown not written: ${result.reason}`,
			...result.fix === void 0 ? {} : { fix: result.fix }
		});
		return;
	}
	const setting = settingOf(tool.cooldown.setting) ?? "minimumReleaseAge";
	const rule = extraOf(tool, "excludeRule", isRule);
	const descriptionKey = extraOf(tool, "ruleDescription", isString);
	const securityPath = extraOf(tool, "securityUpdatesSetting", isPath);
	const datasources = extraOf(tool, "datasources", isRecord);
	const excluded = policy.cooldown.exclude;
	const patterns = exclusions(context, patternsFor(excluded, "npm")) ?? [];
	const pythonPatterns = exclusions(context, patternsFor(excluded, "pypi")) ?? [];
	const negative = extraOf(tool, "negativeMatch", isString);
	const python = context.tools.some((entry) => entry.kind === "package-manager" && ecosystemOfTool(entry) === "pypi" && context.targets.has(entry.id));
	const exclusionRule = {
		[descriptionKey]: RULE_DESCRIPTION,
		...python ? { matchDatasources: [`${negative}${String(datasources["pypi"])}`] } : {},
		[rule.match]: patterns,
		[setting]: rule.value
	};
	const pythonRule = {
		[descriptionKey]: PYTHON_RULE_DESCRIPTION,
		matchDatasources: [datasources["pypi"]],
		[rule.match]: pythonPatterns,
		[setting]: rule.value
	};
	const managedRules = [{
		description: RULE_DESCRIPTION,
		rule: exclusionRule,
		wanted: patterns.length > 0
	}, {
		description: PYTHON_RULE_DESCRIPTION,
		rule: pythonRule,
		wanted: pythonPatterns.length > 0
	}];
	const security = policy.cooldown.securityUpdates === "delay" ? result.value : null;
	const file = (values$1(tool.cooldown.configFiles)[0] ?? []).find((name) => context.exists(name));
	const snippet = () => JSON.stringify({
		[setting]: result.value,
		...managedRules.some((entry) => entry.wanted) ? { [rule.list]: managedRules.filter((entry) => entry.wanted).map((entry) => entry.rule) } : {},
		...securityPath.reduceRight((inner, key) => ({ [key]: inner }), security)
	}, null, 2);
	if (file === void 0 || !/\.jsonc?$/u.test(file)) {
		const packageJson = extraOf(tool, "packageJsonConfig", isRecord);
		const where = file ?? (context.exists("package.json") && context.json("package.json").get([String(packageJson["key"])]) !== void 0 ? "package.json" : void 0);
		if (where === void 0) {
			context.warn({
				code: "bot-config-missing",
				message: `${context.name}: no configuration file found; depcurfew does not create one`,
				fix: "Add renovate.json if you use Renovate, then run depcurfew apply again"
			});
			return;
		}
		context.warn(where === "package.json" ? {
			code: "bot-config-not-edited",
			location: { file: where },
			message: `${context.name}: configuration in package.json is deprecated and depcurfew does not edit it`,
			fix: "Move it to renovate.json, or add the snippet by hand"
		} : {
			code: "bot-config-not-edited",
			location: { file: where },
			message: `${context.name}: ${where} is not plain JSON or JSONC, so depcurfew does not edit it`,
			fix: "Add the snippet by hand"
		});
		context.snippet(where, snippet());
		return;
	}
	const json = context.json(file);
	json.set([setting], result.value);
	for (const managed of managedRules) {
		const rules = json.get([rule.list]);
		const index = Array.isArray(rules) ? rules.findIndex((entry) => isRecord(entry) && entry[descriptionKey] === managed.description) : -1;
		if (managed.wanted) {
			if (index >= 0) {
				if (JSON.stringify(rules[index]) !== JSON.stringify(managed.rule)) json.replace([rule.list], index, managed.rule);
			} else if (Array.isArray(rules)) json.append([rule.list], managed.rule);
			else json.set([rule.list], [managed.rule]);
		} else if (index >= 0) json.remove([rule.list], index);
	}
	json.set(securityPath, security);
};

// src/apply/generators/uv.ts
const uv = (context) => {
	const { tool, policy } = context;
	const tables = extraOf(tool, "configTables", isRecord);
	const file = context.exists("uv.toml") || !context.exists("pyproject.toml") ? "uv.toml" : "pyproject.toml";
	const table = typeof tables[file] === "string" ? tables[file] : "";
	const entries = [];
	const managed = [];
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "exclude-newer";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			entries.push(`${setting} = ${tomlValue(cooldown.value)}`);
			managed.push(setting);
			const excludeSetting = settingOf(tool.cooldown.exclude.setting);
			const patterns = exclusions(context);
			if (excludeSetting !== null && patterns !== void 0) {
				managed.push(excludeSetting);
				const exempt = extraOf(tool, "excludeValue", (value) => typeof value === "boolean");
				const names = pythonNames(patterns);
				if (names.length > 0) entries.push(`${excludeSetting} = { ${names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`).join(", ")} }`);
			}
		}
	}
	if (policy.installScripts?.default === "deny") {
		const build = extraOf(tool, "buildSwitch", isSwitch);
		if (context.supports(build.since, build.setting)) {
			entries.push(`${build.setting} = ${tomlValue(build.value)}`);
			managed.push(build.setting);
			const setting = settingOf(tool.installScripts.allowList.setting);
			if (setting !== null) {
				managed.push(setting);
				const names = policy.installScripts.allow.length > 0 && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting) ? buildAllowList(context, setting) : [];
				if (names.length > 0) entries.push(`${setting} = ${tomlValue(names)}`);
				forcedBuildWarning(context, setting, names);
			}
		}
	}
	eachSource(context, () => void 0);
	if (entries.length > 0 || context.exists(file) && context.read(file).includes("# >>> depcurfew managed block: edit depcurfew.json and run depcurfew apply instead")) {
		relockWarning(context, file, table, (body) => writeTomlBlock(body, table, entries, managed));
		context.toml(file, table, entries, managed);
	}
	return minutes;
};
const isStringList$1 = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** A TOML value for comparison: a date-time as written. */
function comparable(value) {
	return JSON.stringify(value instanceof TomlDateTime ? value.text : value ?? null);
}
/**
* uv records some settings in uv.lock (extra.lockedSettings); when the edit changes one, uv lock --check and
* uv sync --locked fail until the lockfile is locked again, so apply says so.
*/
function relockWarning(context, file, table, edit) {
	const { tool } = context;
	const locked = tool.extra?.["lockedSettings"] === void 0 ? [] : extraOf(tool, "lockedSettings", isStringList$1);
	const lockfile = (tool.project === void 0 ? [] : values$1(tool.project.lockfiles)).flatMap((versions) => versions.flatMap((entry) => entry.value)).find((name) => context.exists(name));
	if (lockfile === void 0 || locked.length === 0) return;
	const body = context.exists(file) ? context.read(file) : "";
	let before;
	let after;
	try {
		before = parseToml(body);
		after = parseToml(edit(body));
	} catch {
		return;
	}
	const path = table === "" ? [] : table.split(".");
	const changed = locked.filter((setting) => comparable(tomlValueAt(before, [...path, setting])) !== comparable(tomlValueAt(after, [...path, setting])));
	if (changed.length === 0) return;
	context.warn({
		code: "lockfile-out-of-date",
		location: { file: lockfile },
		message: `${context.name}: ${lockfile} records ${listing(changed)}, so it is out of date after this change`,
		fix: `Run ${context.name} lock and commit ${lockfile}; until then ${context.name} sync --locked and ${context.name} lock --check fail`
	});
}

// src/apply/generators/yarn.ts
const isScriptsSwitch = (value) => isRecord(value) && typeof value["setting"] === "string" && "allow" in value && "deny" in value;
const yarn = (context) => {
	const { tool, policy } = context;
	const yaml = context.yaml(firstFile(tool.cooldown.configFiles) ?? ".yarnrc.yml");
	let minutes;
	if (policy.cooldown !== void 0) {
		const setting = settingOf(tool.cooldown.setting) ?? "npmMinimalAgeGate";
		const cooldown = cooldownValue(context);
		if (cooldown !== void 0) {
			minutes = cooldown.minutes;
			yaml.set([setting], cooldown.value);
		}
		const excludeSetting = settingOf(tool.cooldown.exclude.setting);
		const patterns = cooldown === void 0 ? void 0 : exclusions(context);
		if (excludeSetting !== null && patterns !== void 0 && (patterns.length > 0 || yaml.get([excludeSetting]) !== void 0)) {
			if (!sameList(yaml.get([excludeSetting]), patterns)) yaml.set([excludeSetting], patterns);
		}
	}
	if (policy.installScripts !== void 0) {
		const scripts = extraOf(tool, "scriptsSwitch", isScriptsSwitch);
		const deny = policy.installScripts.default === "deny";
		yaml.set([scripts.setting], deny ? scripts.deny : scripts.allow);
		const template = settingOf(tool.installScripts.allowList.setting);
		if (deny && template !== null && policy.installScripts.allow.length > 0) {
			if (context.supports(sinceOf(tool.installScripts.allowList.availableSince), template)) {
				const json = context.json(settingOf(tool.installScripts.allowList.file) ?? "package.json");
				for (const name of allowedNames(context, template.split(".")[0] ?? template)) {
					const path = template.split(".").map((segment) => segment === "<package>" ? name : segment);
					if (json.get(path) !== true) json.set(path, true);
				}
			}
		}
	}
	eachSource(context, (_kind, setting, access) => {
		const value = access === "deny" ? [] : ["**"];
		if (!sameList(yaml.get([setting]), value)) yaml.set([setting], value);
	});
	return minutes;
};

// src/apply/warnings.ts
/** A warning as one line of text, as ApplyReport.warnings has it. */
function warningText(warning) {
	return warning.fix === void 0 ? warning.message : `${warning.message}. ${warning.fix}`;
}

// src/apply/text.ts
function detectStyle(text) {
	const body = text.startsWith("﻿") ? text.slice(1) : text;
	return {
		eol: body.includes("\r\n") ? "\r\n" : "\n",
		bom: text.startsWith("﻿"),
		finalNewline: body === "" || body.endsWith("\n")
	};
}
function toLf(text) {
	return (text.startsWith("﻿") ? text.slice(1) : text).replaceAll("\r\n", "\n");
}
function restoreStyle(body, style) {
	let text = style.finalNewline || !body.endsWith("\n") ? body : body.slice(0, -1);
	if (style.eol === "\r\n") text = text.replaceAll("\n", "\r\n");
	return style.bom ? `﻿${text}` : text;
}

// src/apply/workspace.ts
var Workspace = class {
	root;
	#files = /* @__PURE__ */ new Map();
	constructor(root) {
		this.root = realpathSync(root);
	}
	#load(file) {
		const cached = this.#files.get(file);
		if (cached !== void 0) return cached;
		const path = join(this.root, file);
		let parent;
		try {
			parent = realpathSync(dirname(path));
		} catch {
			parent = this.root;
		}
		if (parent !== this.root && !parent.startsWith(this.root + sep)) throw new Error(`${file} is outside the repository`);
		let original = null;
		try {
			if (lstatSync(path).isSymbolicLink()) throw new Error(`${file} is a symlink; depcurfew does not write through symlinks`);
			original = readFileSync(path, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const entry = {
			original,
			style: detectStyle(original ?? ""),
			body: toLf(original ?? "")
		};
		this.#files.set(file, entry);
		return entry;
	}
	exists(file) {
		const entry = this.#load(file);
		return entry.original !== null || entry.body !== "";
	}
	read(file) {
		return this.#load(file).body;
	}
	/** Applies an edit to the file's text (LF line endings); a missing file starts empty. */
	edit(file, change) {
		const entry = this.#load(file);
		entry.body = change(entry.body);
	}
	changes() {
		const changes = [];
		for (const [file, entry] of this.#files) {
			if (entry.original === null && entry.body === "") continue;
			const after = restoreStyle(entry.body, entry.style);
			if (after !== entry.original) changes.push({
				file,
				before: entry.original,
				after
			});
		}
		return changes.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
	}
};
/** Writes each changed file through a temporary file and a rename, keeping the permissions of existing files. */
function writeChanges(root, changes) {
	for (const change of changes) {
		const path = join(root, change.file);
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.depcurfew-${process.pid}-${Date.now()}`;
		writeFileSync(temporary, change.after, { flag: "wx" });
		if (change.before !== null) chmodSync(temporary, statSync(path).mode);
		renameSync(temporary, path);
	}
}

// src/apply/index.ts
const MANAGERS = {
	npm,
	pnpm,
	yarn,
	bun,
	deno,
	uv,
	pip,
	poetry,
	pdm,
	pipenv
};
const BOTS = {
	renovate,
	dependabot
};
function latestVersion$1(tool) {
	const fact = tool.extra?.["latestVersion"];
	const value = fact === void 0 ? void 0 : values$1(fact)[0];
	return typeof value === "string" ? value : void 0;
}
/** Where a repository can pin the version of a tool, for the warning when none is pinned. */
/** Where the version of a tool can be pinned, or undefined when the project cannot pin it (PDM, Pipenv). */
function pinPlaces(tool) {
	if (ecosystemOfTool(tool) === "npm") return "packageManager, devEngines, .tool-versions or a CI setup step";
	const required = tool.extra?.["requiredVersion"];
	const value = required === void 0 ? void 0 : values$1(required)[0];
	const places = isRecord(value) && typeof value["key"] === "string" && typeof value["table"] === "string" ? [`${value["key"]} in [${value["table"]}]`] : [];
	const plugins = values$1(environment.asdf.plugins)[0] ?? {};
	if (Object.values(plugins).includes(tool.id)) places.push(".tool-versions");
	if (Object.values(environment.githubActions).flatMap((fact) => values$1(fact)).some((action) => isRecord(action) && Array.isArray(action["inputs"]) && action["inputs"].some((input) => isRecord(input) && input["tool"] === tool.id))) places.push("a CI setup step");
	if (places.length === 0) return void 0;
	return places.length === 1 ? places[0] : `${places.slice(0, -1).join(", ")} or ${places.at(-1) ?? ""}`;
}
function pinFix(tool) {
	const places = pinPlaces(tool);
	if (places !== void 0) return `Pin the version you use (${places}) to configure for it`;
	return `Use ${tool.name} ${latestVersion$1(tool) ?? "latest"} or a recent version wherever the project is installed; ${tool.name} has no setting that pins its version in the project`;
}
/** The bots' delay: the policy's, or longer if a package manager rounded its delay up further. */
function botDuration(policy, managerMinutes) {
	const minutes = Math.max(policy.minutes, ...managerMinutes);
	return minutes === policy.minutes ? policy : {
		text: formatDuration(Math.ceil(minutes)),
		minutes: Math.ceil(minutes)
	};
}
/**
* apply only adds to install-script allow-lists, so a package someone listed by hand keeps running its scripts after
* the policy denies them; say so, and what to do about it.
*/
function allowListWarnings(root, policy, detection, targets, tools) {
	if (policy.installScripts?.default !== "deny") return [];
	const repository = new Repository(root);
	return detection.packageManagers.filter((manager) => manager.supported && targets.has(manager.id)).flatMap((manager) => {
		const tool = tools.find((entry) => entry.id === manager.id);
		const allow = policyFor(policy, tool === void 0 ? "npm" : ecosystemOfTool(tool)).installScripts?.allow ?? [];
		return allowEntries(repository, manager.id, manager.configFiles).filter((entry) => !allow.some((pattern) => matchesPattern(entry.package, pattern))).map((entry) => ({
			code: "allow-list-entry-outside-policy",
			tool: manager.id,
			location: { file: entry.file },
			message: `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it; depcurfew apply does not remove entries it did not write`,
			fix: `Remove ${entry.name} from ${entry.setting} by hand, or add ${entry.package} to installScripts.allow in ${POLICY_FILE}`
		}));
	});
}
/** Computes every change without writing anything. */
function planApply(root, policy, detection, tools = knowledgeBase) {
	const workspace = new Workspace(root);
	const warnings = [];
	const snippets = [];
	const failures = [];
	const targets = new Set(policy.targets === "auto" ? detectedTargets(detection) : policy.targets);
	for (const manager of detection.packageManagers) if (!manager.supported && (policy.targets === "auto" || targets.has(manager.id))) {
		const berry = tools.find((tool) => tool.id === manager.id);
		const since = berry === void 0 ? void 0 : sinceOf(berry.cooldown.availableSince);
		const advice = manager.variant === "classic" && berry !== void 0 ? `Move to ${berry.name}${since === void 0 ? "" : ` ${since} or later`}, or to another package manager depcurfew configures` : void 0;
		warnings.push({
			code: "tool-not-supported",
			tool: manager.id,
			message: `${manager.variant === "classic" ? "Yarn Classic (1.x)" : manager.id} is not supported; nothing written for it`,
			...advice === void 0 ? {} : { fix: advice }
		});
		targets.delete(manager.id);
	}
	for (const warning of detection.warnings.filter((entry) => entry.code === "invalid-file")) {
		const file = warning.files[0];
		warnings.push({
			code: "file-unreadable",
			...file === void 0 ? {} : { location: { file } },
			message: `${warning.message}; depcurfew cannot tell which tools it configures`,
			fix: `Fix the syntax error${file === void 0 ? "" : ` in ${file}`}, then run depcurfew apply again`
		});
	}
	if (targets.size === 0) warnings.push({
		code: "nothing-to-configure",
		message: "no tools to configure: depcurfew found no supported package manager or bot here",
		fix: "Run depcurfew explain to see what depcurfew detects"
	});
	const run = (tool, version, action) => {
		const view = tool.kind === "package-manager" ? policyFor(policy, ecosystemOfTool(tool)) : policy;
		const context = createContext({
			tool,
			tools,
			targets,
			policy: view,
			version,
			workspace,
			warnings,
			snippets,
			failures
		});
		try {
			action(context);
		} catch (error) {
			if (!(error instanceof EditFailed)) throw error;
		}
		context.finish();
	};
	const managerMinutes = [];
	for (const tool of tools) {
		const generator = MANAGERS[tool.id];
		if (generator === void 0 || !targets.has(tool.id)) continue;
		const manager = detection.packageManagers.find((entry) => entry.id === tool.id);
		const version = manager === void 0 ? void 0 : pinnedVersion(manager);
		if (version === void 0) {
			const latest = latestVersion$1(tool);
			warnings.push({
				code: "version-not-pinned",
				tool: tool.id,
				message: `${tool.name}: no exact version is pinned, so depcurfew configures for ${tool.name} ${latest ?? "latest"}, the latest version it knows`,
				fix: pinFix(tool)
			});
		}
		run(tool, version, (context) => {
			const minutes = generator(context);
			if (minutes !== void 0) managerMinutes.push(minutes);
		});
	}
	const duration = policy.cooldown === void 0 ? void 0 : botDuration(policy.cooldown.minimum, managerMinutes);
	for (const tool of tools) {
		const generator = BOTS[tool.id];
		if (generator === void 0 || !targets.has(tool.id)) continue;
		run(tool, void 0, (context) => generator(context, duration));
	}
	warnings.push(...allowListWarnings(root, policy, detection, targets, tools));
	const errors = failures.map((failure) => `${tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool}: cannot edit ${failure.file}: ${failure.message}`);
	return {
		changes: workspace.changes(),
		warnings: warnings.map(warningText),
		warningDetails: warnings,
		snippets,
		errors,
		failures
	};
}
var PolicyError = class extends Error {
	issues;
	code;
	/** What to do, when the message does not say it. */
	fix;
	constructor(message, issues = [], code = "policy-invalid", fix) {
		super(message);
		this.issues = issues;
		this.code = code;
		this.fix = fix;
	}
	/** The message and what to do, as one line of text. */
	get text() {
		return this.fix === void 0 ? this.message : `${this.message}; ${this.fix.charAt(0).toLowerCase()}${this.fix.slice(1)}`;
	}
};
/** What to do about a policy that cannot be used, the same in doctor and in the JSON of apply and check. */
function policyErrorFix(error) {
	if (error.fix !== void 0) return error.fix;
	return error.code === "policy-unreadable" ? `Make ${POLICY_FILE} a regular file inside the repository, so that depcurfew can read it` : `Fix these problems in ${POLICY_FILE}; an editor that reads its $schema shows them as you type`;
}
/** The policy of the repository; undefined when it has no depcurfew.json. Throws PolicyError when it cannot be used. */
function loadPolicyIfPresent(root) {
	const file = readPolicyFile(root);
	if (file.status === "missing") return void 0;
	if (file.status === "unreadable") throw new PolicyError(file.reason, [], "policy-unreadable");
	const result = parsePolicy(file.text);
	if (!result.ok) throw new PolicyError(`${POLICY_FILE} is invalid`, result.issues.map(formatIssue));
	return result.policy;
}

// src/doctor/durations.ts
const MINUTES = {
	ms: 1 / 6e4,
	s: 1 / 60,
	second: 1 / 60,
	m: 1,
	minute: 1,
	h: 60,
	hour: 60,
	d: 1440,
	day: 1440,
	w: 10080,
	week: 10080
};
const UNIT_MINUTES = {
	seconds: 1 / 60,
	minutes: 1,
	hours: 60,
	days: 1440
};
function word(unit) {
	return MINUTES[unit.toLowerCase().replace(/s$/u, "")];
}
const SYNTAX = {
	compact: (text) => {
		const match = /^(\d+)(ms|s|m|h|d|w)$/u.exec(text);
		return match === null ? void 0 : Number(match[1]) * (MINUTES[match[2] ?? ""] ?? NaN);
	},
	"compact-or-words": (text) => SYNTAX["compact"]?.(text) ?? SYNTAX["words"]?.(text),
	words: (text) => {
		const parts = [...text.matchAll(/(\d+)\s*([a-z]+)/giu)];
		if (parts.length === 0 || parts.map((part) => part[0]).join(" ").replaceAll(/\s+/gu, "") !== text.replaceAll(/\s+/gu, "")) return void 0;
		let total = 0;
		for (const part of parts) {
			const unit = word(part[2] ?? "");
			if (unit === void 0) return void 0;
			total += Number(part[1]) * unit;
		}
		return total;
	},
	"words-or-iso8601": (text) => SYNTAX["iso8601"]?.(text) ?? SYNTAX["words"]?.(text),
	iso8601: (text) => {
		const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(text);
		if (match === null || text === "P" || text.endsWith("T")) return void 0;
		const [weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
		return (weeks ?? 0) * 10080 + (days ?? 0) * 1440 + (hours ?? 0) * 60 + (minutes ?? 0) + (seconds ?? 0) / 60;
	}
};
/** A delay as written for `tool` at `version` (undefined: the latest version). null and 0 mean no delay. */
function delayMinutes(tool, value, version) {
	if (value === null || value === void 0 || value === false) return {
		ok: true,
		minutes: 0
	};
	if (typeof value === "number") {
		const unit = values$1(tool.cooldown.unit)[0];
		const factor = unit === null || unit === void 0 ? void 0 : UNIT_MINUTES[unit];
		return factor === void 0 ? {
			ok: false,
			reason: `${tool.name} takes no number here`
		} : {
			ok: true,
			minutes: value * factor
		};
	}
	if (typeof value !== "string") return {
		ok: false,
		reason: `${JSON.stringify(value)} is not a delay`
	};
	const text = value.trim();
	if (/^\d+$/u.test(text)) return delayMinutes(tool, Number(text), version);
	const fact = tool.extra?.["durationStrings"];
	const format = fact === void 0 ? void 0 : values$1(fact)[0];
	if (!isRecord(format) || typeof format["syntax"] !== "string") return {
		ok: false,
		reason: `${tool.name} takes no duration strings`
	};
	const since = typeof format["since"] === "string" ? parseVersion(format["since"]) : void 0;
	if (since !== void 0 && version !== void 0 && compareVersions$1(version, since) < 0) return {
		ok: false,
		reason: `${tool.name} accepts duration strings only since ${format["since"]}`
	};
	const minutes = SYNTAX[format["syntax"]]?.(text);
	return minutes === void 0 ? {
		ok: false,
		reason: `"${text}" is not a duration ${tool.name} understands`
	} : {
		ok: true,
		minutes
	};
}
function formatMinutes(minutes) {
	for (const [unit, size] of [
		["week", 10080],
		["day", 1440],
		["hour", 60]
	]) if (minutes >= size && minutes % size === 0) return `${minutes / size} ${unit}${minutes === size ? "" : "s"}`;
	const rounded = Math.round(minutes * 100) / 100;
	return `${rounded} minute${rounded === 1 ? "" : "s"}`;
}

// src/doctor/python.ts
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** The parsed TOML file, or undefined when it is missing or does not parse (unreadable-config then reports it). */
function readTomlDocument(repository, file) {
	return repository.parseOnce(file, parseToml);
}
/** The value at a key path of a TOML file, with the line of its key. */
function tomlSettingAt(repository, file, path) {
	const document = readTomlDocument(repository, file);
	const value = document === void 0 ? void 0 : tomlValueAt(document, path);
	return document === void 0 || value === void 0 ? void 0 : {
		file,
		line: document.lineOf(path) ?? 1,
		value
	};
}
/** The files and key paths where a Python tool reads `setting`, in the order the tool uses them. */
function pythonSettingPaths(repository, tool, setting) {
	const tables = tool.extra?.["configTables"] === void 0 ? void 0 : extraOf(tool, "configTables", isRecord);
	if (tables !== void 0) {
		const files = (tool.extra?.["configFileOrder"] === void 0 ? Object.keys(tables) : extraOf(tool, "configFileOrder", isStringList)).filter((name) => name in tables);
		const file = files.find((name) => repository.isFile(name)) ?? files[0];
		if (file === void 0) return [];
		const table = String(tables[file] ?? "");
		return [{
			file,
			path: [...table === "" ? [] : table.split("."), setting]
		}];
	}
	const file = values$1(tool.cooldown.configFiles)[0]?.[0];
	return file === void 0 || !file.endsWith(".toml") ? [] : [{
		file,
		path: setting.split(".")
	}];
}
/** A Python tool's setting as the tool reads it in the project, or undefined when it is not set. */
function readPythonSetting(repository, tool, setting) {
	for (const { file, path } of pythonSettingPaths(repository, tool, setting)) {
		const found = tomlSettingAt(repository, file, path);
		if (found !== void 0) return found;
	}
}
/**
* The global option lines of a requirements file, e.g. --only-binary=:all:, with their values and lines. Options after
* a requirement on the same logical line (--hash on a continuation line) belong to that requirement and are skipped.
*/
function requirementsOptions(repository, file, format) {
	const text = repository.readText(file);
	if (text === void 0) return [];
	return requirementsLines(text, format).flatMap(({ text: line, line: number }) => {
		const match = /^(--[a-z-]+)(?:[=\s]\s*(\S+))?/u.exec(line);
		return match === null ? [] : [{
			option: match[1] ?? "",
			value: match[2] ?? "",
			line: number
		}];
	});
}

// src/doctor/effective.ts
function latestVersion(tool) {
	const fact = tool.extra?.["latestVersion"];
	const value = fact === void 0 ? void 0 : values$1(fact)[0];
	return typeof value === "string" ? parseVersion(value) : void 0;
}
/** The value in effect at `version` (or the latest entry when the version is unknown). */
function versionedValue(list, version) {
	let current;
	for (const entry of list) {
		const since = parseVersion(entry.since);
		if (version === void 0 || since === void 0 || compareVersions$1(version, since) >= 0) current = entry.value;
	}
	return current;
}
function managerConfigFiles(tool, manager) {
	if (tool.id === "deno") return manager.configFiles.filter((file) => /^deno\.jsonc?$/u.test(file));
	return (values$1(tool.cooldown.configFiles)[0] ?? []).filter((file) => file !== ".npmrc" || tool.id === "npm").slice(0, 1);
}
/** The package manager's delay, or undefined (with a notice) when a configured value cannot be read. */
function managerDelay(context, manager, tool) {
	const version = pinnedVersion(manager) ?? latestVersion(tool);
	const versionText = version === void 0 ? tool.name : `${tool.name} ${formatVersion(version)}`;
	const setting = settingOf(tool.cooldown.setting);
	const since = sinceOf(tool.cooldown.availableSince);
	if (!(since === void 0 || version === void 0 || compareVersions$1(version, parseVersion(since) ?? [
		0,
		0,
		0
	]) >= 0)) return {
		minutes: 0,
		origin: `${versionText} has no ${setting ?? "release-age setting"}`
	};
	if (setting !== null) {
		let found;
		if (ecosystemOfTool(tool) === "pypi") found = readPythonSetting(context.repository, tool, setting);
		else for (const file of managerConfigFiles(tool, manager)) found ??= readSetting(context.repository, file, setting);
		if (found !== void 0) {
			const raw = isRecord(found.value) ? found.value["age"] : found.value;
			const delay = delayMinutes(tool, raw, version);
			if (!delay.ok) {
				context.notice(`${tool.name}: cannot read ${setting} in ${found.file}: ${delay.reason}`, found.file);
				return;
			}
			return {
				minutes: delay.minutes,
				origin: `${setting}: ${JSON.stringify(raw)} in ${found.file}`,
				location: {
					file: found.file,
					line: found.line
				}
			};
		}
	}
	let longest;
	for (const evidence of evidenceOf(tool.cooldown.default)) {
		const value = versionedValue(evidence.value, version);
		const delay = delayMinutes(tool, value, version);
		if (delay.ok && (longest === void 0 || delay.minutes > longest)) longest = delay.minutes;
	}
	const minutes = longest ?? 0;
	const disputed = tool.cooldown.default.status === "disputed" ? "; official sources disagree, the longest is assumed" : "";
	return {
		minutes,
		origin: minutes === 0 ? `${versionText} has no delay by default` : `the default of ${versionText}${disputed}`
	};
}

// src/doctor/rules/bot-cooldown.ts
const isEcosystems = (value) => isRecord(value) && Object.values(value).every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"));
const isPresets = (value) => isRecord(value) && Array.isArray(value["presets"]) && typeof value["value"] === "string";
const isCooldownKeys = (value) => isRecord(value) && typeof value["days"] === "string" && Array.isArray(value["semverDays"]);
const isPackageJsonConfig = (value) => isRecord(value) && typeof value["file"] === "string" && typeof value["key"] === "string";
function describe$1(minutes) {
	return minutes === 0 ? "no delay" : formatMinutes(minutes);
}
function dependabotDelays(context, bot, file) {
	const text = context.repository.readText(file);
	if (text === void 0) return [];
	const updates = yamlSetting(text, ["updates"]);
	if (updates === void 0 || !Array.isArray(updates.value)) return [];
	const ecosystems = extraOf(bot, "ecosystems", isEcosystems);
	const keys = extraOf(bot, "cooldownKeys", isCooldownKeys);
	const fallback = versionedValue(values$1(bot.cooldown.default)[0] ?? [], void 0);
	const securityBypass = values$1(bot.cooldown.securityUpdates).includes("bypass");
	return updates.value.flatMap((entry, index) => {
		if (!isRecord(entry) || typeof entry["package-ecosystem"] !== "string") return [];
		const managers = ecosystems[entry["package-ecosystem"]] ?? [];
		if (managers.length === 0) return [];
		const cooldown = isRecord(entry["cooldown"]) ? entry["cooldown"] : void 0;
		const configuredDays = cooldown?.[keys.days];
		const base = typeof configuredDays === "number" ? configuredDays : typeof fallback === "number" ? fallback : 0;
		const semver = keys.semverDays.filter((key) => typeof cooldown?.[key] === "number");
		const days = Math.min(base, ...semver.map((key) => cooldown?.[key]));
		const shortest = semver.find((key) => cooldown?.[key] === days);
		const origin = cooldown === void 0 ? `Dependabot's default (${describe$1(days * 1440)})` : shortest !== void 0 && days < base ? `${shortest}: ${days} in ${file}` : typeof cooldown[keys.days] === "number" ? `${keys.days}: ${days} in ${file}` : `Dependabot's default (${describe$1(days * 1440)})`;
		const line = yamlSetting(text, [
			"updates",
			String(index),
			cooldown === void 0 ? "package-ecosystem" : "cooldown"
		])?.line ?? updates.line;
		return [{
			bot,
			managers,
			minutes: days * 1440,
			origin,
			location: {
				file,
				line
			},
			securityBypass,
			scope: `${entry["package-ecosystem"]} updates`
		}];
	});
}
function renovateDelays(context, bot, file) {
	if (!/\.jsonc?$/u.test(file) && !/\.renovaterc$/u.test(file)) {
		context.notice(`bot-cooldown-mismatch cannot read ${file}; only JSON and JSONC Renovate files are read`, file);
		return [];
	}
	const text = context.repository.readText(file);
	if (text === void 0) return [];
	const managersOf = (ecosystem) => context.tools.filter((tool) => tool.kind === "package-manager" && (ecosystem === void 0 || ecosystemOfTool(tool) === ecosystem)).map((tool) => tool.id);
	const packageJson = extraOf(bot, "packageJsonConfig", isPackageJsonConfig);
	const base = file === packageJson.file ? [packageJson.key] : [];
	const configured = jsonSetting(text, [...base, "minimumReleaseAge"]);
	const security = jsonSetting(text, [
		...base,
		"vulnerabilityAlerts",
		"minimumReleaseAge"
	]);
	const securityBypass = security === void 0 ? values$1(bot.cooldown.securityUpdates).includes("bypass") : security.value === null;
	const applies = base.length === 0 && /\.jsonc?$/u.test(file);
	const groups = [];
	if (configured !== void 0) groups.push({
		managers: managersOf(),
		value: configured.value,
		origin: `${[...base, "minimumReleaseAge"].join(".")}: ${JSON.stringify(configured.value)} in ${file}`,
		line: configured.line
	});
	else {
		const extendsList = jsonSetting(text, [...base, "extends"]);
		const extended = Array.isArray(extendsList?.value) ? extendsList.value.filter((item) => typeof item === "string") : [];
		for (const [key, ecosystem] of [["minimumReleaseAgePresets", "npm"], ["pypiPresets", "pypi"]]) {
			const presets = bot.extra?.[key] === void 0 ? void 0 : extraOf(bot, key, isPresets);
			const preset = presets === void 0 ? void 0 : extended.find((item) => presets.presets.includes(item));
			groups.push(presets !== void 0 && preset !== void 0 ? {
				managers: managersOf(ecosystem),
				value: presets.value,
				origin: `the preset ${preset} in ${file} (${presets.value})`,
				line: extendsList?.line ?? 1
			} : {
				managers: managersOf(ecosystem),
				value: null,
				origin: "Renovate has no delay by default",
				line: 1
			});
		}
	}
	return groups.flatMap((group) => {
		const delay = delayMinutes(bot, group.value, latestVersion(bot));
		if (!delay.ok) {
			context.notice(`Renovate: cannot read minimumReleaseAge in ${file}: ${delay.reason}`, file);
			return [];
		}
		return [{
			bot,
			managers: group.managers,
			minutes: delay.minutes,
			origin: group.origin,
			location: {
				file,
				line: group.line
			},
			securityBypass,
			scope: "updates",
			applies
		}];
	});
}
function rechecksLockfile(tool, manager) {
	const fact = tool.extra?.["lockfileRecheck"];
	if (fact === void 0) return false;
	const list = values$1(fact)[0];
	return Array.isArray(list) && versionedValue(list, pinnedVersion(manager) ?? latestVersion(tool)) === true;
}
const botCooldownMismatch = {
	id: "bot-cooldown-mismatch",
	summary: "An update bot waits less than the package manager before proposing a new version.",
	description: "The bot then opens pull requests with versions the package manager would not pick yet: they fail to install where the manager re-checks the lockfile, or they bring in a version younger than the manager allows. Security updates that skip the bot delay fail the same way where the manager re-checks the lockfile.",
	help: "Give the bot a delay at least as long as the package manager's (depcurfew apply does this).",
	level: "error",
	requiresPolicy: false,
	check(context) {
		const managers = context.detection.packageManagers.filter((entry) => entry.supported);
		if (managers.length === 0) return;
		const delays = [];
		for (const detected of context.detection.bots) {
			const bot = context.tools.find((entry) => entry.id === detected.id);
			const file = detected.configFiles[0];
			if (bot === void 0 || file === void 0) continue;
			delays.push(...detected.id === "dependabot" ? dependabotDelays(context, bot, file) : renovateDelays(context, bot, file));
		}
		for (const delay of delays) for (const manager of managers.filter((entry) => delay.managers.includes(entry.id))) {
			const tool = context.tools.find((entry) => entry.id === manager.id);
			if (tool === void 0) continue;
			const own = managerDelay(context, manager, tool);
			if (own === void 0 || delay.location === void 0) continue;
			if (delay.minutes < own.minutes) context.report({
				location: delay.location,
				message: `${delay.bot.name} proposes ${delay.scope} ${delay.minutes === 0 ? "without waiting" : `after ${describe$1(delay.minutes)}`} (${delay.origin}), but ${tool.name} waits ${describe$1(own.minutes)} (${own.origin}); its pull requests bring in versions younger than ${tool.name} accepts, or fail where the lockfile is re-checked`,
				fix: delay.applies === false ? `Make the ${delay.bot.name} delay at least ${describe$1(own.minutes)} in ${delay.location.file} (depcurfew apply does not edit it)` : `Make the ${delay.bot.name} delay at least ${describe$1(own.minutes)}, or run depcurfew apply`
			});
			else if (delay.securityBypass && own.minutes > 0 && rechecksLockfile(tool, manager)) context.report({
				level: "warning",
				location: delay.location,
				message: `${delay.bot.name} security updates skip its delay, but ${tool.name} re-checks the lockfile and waits ${describe$1(own.minutes)} (${own.origin}); a security fix younger than that fails to install`,
				fix: `When a security update fails, exempt the fixed package in the ${tool.name} exclusion list until the delay has passed`
			});
		}
	}
};

// src/doctor/rules/broad-exclusion.ts
/** Patterns that match every package (or every scoped package): *, **, @*\/*, npm:*, and regexes like /.*\/. */
function isBroad(pattern) {
	const name = pattern.replace(/^(npm|jsr):/u, "");
	return /^(@\*+\/)?\*+$/u.test(name) || /^\/\^?\.[*+]\$?\/[a-z]*$/u.test(name);
}
function tool(context, id) {
	return context.tools.find((entry) => entry.id === id);
}
function checkPolicy(context) {
	const policy = context.policy;
	if (policy === void 0) return;
	const text = context.repository.readText("depcurfew.json") ?? "";
	const lists = [["cooldown.exclude", policy.cooldown?.exclude ?? []], ["installScripts.allow", policy.installScripts?.allow ?? []]];
	for (const [field, patterns] of lists) for (const pattern of patterns.filter(isBroad)) {
		const line = lineOf(text, JSON.stringify(pattern));
		context.report({
			location: line === void 0 ? { file: POLICY_FILE } : {
				file: POLICY_FILE,
				line
			},
			message: `${field} contains "${pattern}", which matches every scoped package`,
			fix: `List the packages or scopes that need the exception, e.g. "@your-scope/*"`
		});
	}
}
/** The managers' own exception lists (npm, pnpm, Yarn, Deno; Bun takes no wildcards). */
function checkManagers(context) {
	for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
		const knowledge = tool(context, manager.id);
		if (knowledge === void 0) continue;
		const setting = settingOf(knowledge.cooldown.exclude.setting);
		if (setting === null) continue;
		const files = manager.id === "deno" ? manager.configFiles.filter((file) => /^deno\.jsonc?$/u.test(file)) : (values$1(knowledge.cooldown.configFiles)[0] ?? []).slice(0, 1);
		for (const file of files) {
			const found = readSetting(context.repository, file, setting);
			if (found === void 0 || !Array.isArray(found.value)) continue;
			for (const pattern of found.value.filter((item) => typeof item === "string" && isBroad(item))) context.report({
				location: {
					file,
					line: found.line
				},
				message: `${setting} contains "${pattern}", so ${knowledge.name} applies no release-age delay to any package`,
				fix: `Remove "${pattern}" and list only the packages that need the exception`
			});
		}
	}
}
function checkDependabot(context, file) {
	const text = context.repository.readText(file);
	if (text === void 0) return;
	const updates = yamlSetting(text, ["updates"]);
	if (updates === void 0 || !Array.isArray(updates.value)) return;
	updates.value.forEach((entry, index) => {
		if (!isRecord(entry) || !isRecord(entry["cooldown"]) || !Array.isArray(entry["cooldown"]["exclude"])) return;
		const broad = entry["cooldown"]["exclude"].filter((item) => typeof item === "string" && isBroad(item));
		if (broad.length === 0) return;
		context.report({
			location: {
				file,
				line: yamlSetting(text, [
					"updates",
					String(index),
					"cooldown",
					"exclude"
				])?.line ?? updates.line
			},
			message: `cooldown.exclude in updates[${index}] (${String(entry["package-ecosystem"])}) contains "${broad[0] ?? ""}", so Dependabot applies no cooldown`,
			fix: `Remove "${broad[0] ?? ""}" and list only the dependencies that need the exception`
		});
	});
}
const MATCHERS = /^(match|exclude)[A-Z]/u;
function checkRenovate(context, file) {
	if (!/\.jsonc?$/u.test(file)) return;
	const text = context.repository.readText(file);
	if (text === void 0) return;
	const rules = jsonSetting(text, ["packageRules"]);
	if (rules === void 0 || !Array.isArray(rules.value)) return;
	rules.value.forEach((rule, index) => {
		if (!isRecord(rule) || !("minimumReleaseAge" in rule) || rule["minimumReleaseAge"] !== null && rule["minimumReleaseAge"] !== "0 days") return;
		const broad = (Array.isArray(rule["matchPackageNames"]) ? rule["matchPackageNames"] : []).find((name) => typeof name === "string" && isBroad(name));
		const unscoped = !Object.keys(rule).some((key) => MATCHERS.test(key));
		if (broad === void 0 && !unscoped) return;
		const line = jsonSetting(text, ["packageRules", index])?.line ?? rules.line;
		context.report({
			location: {
				file,
				line
			},
			message: broad === void 0 ? `packageRules[${index}] turns off minimumReleaseAge without matching any packages, so it applies to all of them` : `packageRules[${index}] turns off minimumReleaseAge for "${broad}", which matches every package`,
			fix: "Match only the packages that need the exception, e.g. with matchPackageNames: [\"@your-scope/*\"]"
		});
	});
}
const broadExclusion = {
	id: "broad-exclusion",
	summary: "An exception list matches every package, which turns the protection off.",
	description: "A release-age exception such as \"*\" (or a policy allow-list entry such as \"@*/*\") looks like a narrow exception but exempts every package, so the delay or the install-script block never applies.",
	help: "Replace the pattern with the packages or scopes that really need the exception.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		checkPolicy(context);
		checkManagers(context);
		for (const bot of context.detection.bots) for (const file of bot.configFiles) {
			if (bot.id === "dependabot") checkDependabot(context, file);
			if (bot.id === "renovate") checkRenovate(context, file);
		}
	}
};

// src/apply/diff.ts
/** Marks a last line without a line break, so it differs from the same line with one, as in `diff -u`. */
const NO_EOL = "\0";
function lines(text) {
	if (text === "") return [];
	const result = text.split("\n");
	if (result.at(-1) === "") result.pop();
	else result[result.length - 1] += NO_EOL;
	return result;
}
/** The shortest edit script from `a` to `b`. */
function myers(a, b) {
	const max = a.length + b.length;
	const offset = max + 1;
	const frontier = new Array(2 * max + 3).fill(0);
	const trace = [];
	outer: for (let d = 0; d <= max; d++) {
		trace.push([...frontier]);
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0) ? frontier[offset + k + 1] ?? 0 : (frontier[offset + k - 1] ?? 0) + 1;
			let y = x - k;
			while (x < a.length && y < b.length && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			frontier[offset + k] = x;
			if (x >= a.length && y >= b.length) break outer;
		}
	}
	const operations = [];
	let x = a.length;
	let y = b.length;
	for (let d = trace.length - 1; d >= 0; d--) {
		const v = trace[d];
		const k = x - y;
		const previousK = k === -d || k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0) ? k + 1 : k - 1;
		const previousX = v[offset + previousK] ?? 0;
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			operations.push({
				kind: "same",
				line: a[x - 1]
			});
			x -= 1;
			y -= 1;
		}
		if (d > 0) {
			if (x === previousX) operations.push({
				kind: "insert",
				line: b[y - 1]
			});
			else operations.push({
				kind: "delete",
				line: a[x - 1]
			});
		}
		x = previousX;
		y = previousY;
	}
	return operations.reverse();
}

// src/doctor/plan.ts
const plans = /* @__PURE__ */ new WeakMap();
/** undefined when the repository has no policy. */
function plannedApply(context) {
	const { policy, detection } = context;
	if (policy === void 0) return void 0;
	let byDetection = plans.get(policy);
	if (byDetection === void 0) {
		byDetection = /* @__PURE__ */ new WeakMap();
		plans.set(policy, byDetection);
	}
	let plan = byDetection.get(detection);
	if (plan === void 0) {
		plan = planApply(context.root, policy, detection, context.tools);
		byDetection.set(detection, plan);
	}
	return plan;
}

// src/doctor/rules/config-drift.ts
function clean(line) {
	return line.replace(/[\r\u0000]/gu, "").trim();
}
/** A line without the trailing comma that JSON needs before a following key. */
function withoutComma(line) {
	return line.replace(/,$/u, "");
}
/** Lines depcurfew writes around its settings, which say nothing about a setting themselves. */
function isFrame(line) {
	return line === "" || line === "# managed by depcurfew" || isBlockStart(line) || line === "# <<< depcurfew managed block";
}
/**
* The first block of lines that apply would change, without the lines that only gain or lose a trailing comma
* (adding a JSON key changes the line before it) and without depcurfew's frame lines.
*/
function firstDifference(before, after) {
	const operations = myers(lines(before), lines(after));
	let line = 1;
	let index = 0;
	while (index < operations.length && operations[index]?.kind === "same") {
		line += 1;
		index += 1;
	}
	let removed = [];
	let added = [];
	for (; index < operations.length && operations[index]?.kind !== "same"; index++) {
		const operation = operations[index];
		if (operation === void 0) break;
		(operation.kind === "delete" ? removed : added).push(clean(operation.line));
	}
	const commaOnly = new Set(removed.filter((text) => added.some((other) => withoutComma(other) === withoutComma(text))).map(withoutComma));
	removed = removed.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
	added = added.filter((text) => !commaOnly.has(withoutComma(text)) && !isFrame(text));
	return {
		line: Math.min(line, Math.max(lines(before).length, 1)),
		removed,
		added
	};
}
function code$1(text) {
	return `\`${withoutComma(text)}\``;
}
/** Added lines for a message: a short JSON object or array on one line, otherwise the first line and a count. */
function addedText(added) {
	const [first = ""] = added;
	if (added.length === 1) return code$1(first);
	const joined = added.join(" ").replaceAll(/\s+/gu, " ");
	if (/[{[]$/u.test(first) && joined.length <= 100) return code$1(joined);
	return `${code$1(first)} (and ${added.length - 1} more ${added.length === 2 ? "line" : "lines"})`;
}
/** What is wrong, in words: a value to change, a line to add or remove, or a hand-written line to comment out. */
function describe(difference) {
	const commented = difference.added.find((text) => text.startsWith("# depcurfew: superseded by the managed block: ") || text.startsWith("# depcurfew: turned off; depcurfew.json manages this setting: "));
	if (commented !== void 0) {
		if (commented.startsWith("# depcurfew: superseded by the managed block: ")) return `${code$1(commented.slice(SUPERSEDED.length))} is set outside the block that depcurfew manages; depcurfew apply comments it out, and the block sets what ${POLICY_FILE} requires`;
		return `${code$1(commented.slice(TURNED_OFF.length))} is set by hand, but ${POLICY_FILE} manages this setting; depcurfew apply comments it out`;
	}
	const [removed] = difference.removed;
	if (removed !== void 0 && difference.added.length > 0) return `${code$1(removed)} should be ${addedText(difference.added)}`;
	if (difference.added.length > 0) return `${addedText(difference.added)} is missing`;
	if (removed !== void 0) return `${code$1(removed)} should not be there`;
	return "its layout differs from what depcurfew apply writes";
}
/** apply only adds to allow-lists, so packages the policy does not allow can stay there; report them. */
function checkAllowLists(context) {
	const policy = context.policy;
	if (policy?.installScripts?.default !== "deny") return;
	const targets = policy.targets;
	for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
		if (targets !== "auto" && !targets.includes(manager.id)) continue;
		const knowledge = context.tools.find((entry) => entry.id === manager.id);
		const allow = policyFor(policy, knowledge === void 0 ? "npm" : ecosystemOfTool(knowledge)).installScripts?.allow ?? [];
		for (const entry of allowEntries(context.repository, manager.id, manager.configFiles)) {
			if (allow.some((pattern) => matchesPattern(entry.package, pattern))) continue;
			context.report({
				level: "warning",
				location: entry.line === void 0 ? { file: entry.file } : {
					file: entry.file,
					line: entry.line
				},
				message: `${entry.setting} in ${entry.file} lets ${entry.name} run install scripts, but ${POLICY_FILE} does not allow it`,
				fix: `Remove ${entry.name} from ${entry.setting}, or add ${entry.name === entry.package ? "it" : entry.package} to installScripts.allow in ${POLICY_FILE}`
			});
		}
	}
}
const configDrift = {
	id: "config-drift",
	summary: "A configuration file does not match what depcurfew apply writes for depcurfew.json.",
	description: "A generated setting was edited by hand, or depcurfew.json changed without running depcurfew apply, so the tools enforce something other than the policy.",
	help: "Run depcurfew apply (depcurfew apply --dry-run shows the difference), or change depcurfew.json if the edit was intended.",
	level: "error",
	requiresPolicy: true,
	check(context) {
		const plan = plannedApply(context);
		if (plan === void 0) return;
		for (const change of plan.changes) {
			if (change.before === null) {
				context.report({
					location: { file: POLICY_FILE },
					message: `${change.file} is missing; depcurfew apply would create it with the settings from ${POLICY_FILE}`,
					fix: `Run depcurfew apply to create ${change.file} (depcurfew apply --dry-run shows its content first)`
				});
				continue;
			}
			const difference = firstDifference(change.before, change.after);
			context.report({
				location: {
					file: change.file,
					line: difference.line
				},
				message: `${change.file} does not match ${POLICY_FILE}: ${describe(difference)}`,
				fix: `Run depcurfew apply to bring ${change.file} back in line with ${POLICY_FILE} (depcurfew apply --dry-run shows the change first), or change ${POLICY_FILE} if the edit was intended`
			});
		}
		checkAllowLists(context);
	}
};

// src/doctor/rules/ignored-setting.ts
function atLeast(version, since) {
	const required = typeof since === "string" ? parseVersion(since) : void 0;
	return required !== void 0 && compareVersions$1(version, required) >= 0;
}
function kebab$1(setting) {
	return setting.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
/** Lockfiles an older version read but this one does not (only from verified facts). */
function checkLockfiles(context, tool, version, label) {
	const fact = tool.project?.lockfiles;
	if (fact === void 0 || fact.status !== "verified") return;
	const current = new Set(versionedValue(fact.value, version) ?? []);
	const known = new Set(fact.value.flatMap((entry) => [...entry.value]));
	for (const name of [...known].filter((file) => !current.has(file))) {
		if (!context.repository.isFile(name)) continue;
		context.report({
			level: "warning",
			location: { file: name },
			message: `${label} does not read ${name}, so installs ignore the versions locked in it`,
			fix: `Rename ${name} to ${[...current][0] ?? "the lockfile this version reads"}, or remove it`
		});
	}
}
function checkPnpm(context, tool, version, label) {
	const ignored = extraOf(tool, "ignoredSince", isRecord);
	const workspace = context.repository.readText("pnpm-workspace.yaml");
	if (atLeast(version, ignored["since"])) {
		const manifest = context.repository.readText("package.json");
		const field = String(ignored["packageJsonField"]);
		const found = manifest === void 0 ? void 0 : jsonSetting(manifest, [field]);
		if (found !== void 0 && isRecord(found.value) && Object.keys(found.value).length > 0) context.report({
			location: {
				file: "package.json",
				line: found.line
			},
			message: `${label} ignores the "${field}" field in package.json (${Object.keys(found.value).join(", ")})`,
			fix: "Move these settings to pnpm-workspace.yaml"
		});
		const allowAll = tool.extra?.["allowAllBuilds"] === void 0 ? void 0 : extraOf(tool, "allowAllBuilds", isSwitch);
		const settings = [
			settingOf(tool.cooldown.setting),
			settingOf(tool.cooldown.exclude.setting),
			settingOf(tool.installScripts.allowList.setting),
			"onlyBuiltDependencies",
			allowAll?.setting ?? null,
			settingOf(tool.sources?.git.setting)
		].filter((setting) => setting !== null);
		const npmrc = context.repository.readText(".npmrc");
		for (const entry of npmrc === void 0 ? [] : iniEntries(npmrc)) {
			const setting = settings.find((name) => kebab$1(name) === entry.key.replace(/\[\]$/u, ""));
			if (setting === void 0) continue;
			const inWorkspace = workspace !== void 0 && yamlSetting(workspace, [setting]) !== void 0;
			context.report({
				level: inWorkspace ? "warning" : "error",
				location: {
					file: ".npmrc",
					line: entry.line
				},
				message: `${label} reads only ${String(ignored["npmrc"])} from .npmrc, so ${entry.key} has no effect${inWorkspace ? ` (pnpm-workspace.yaml sets ${setting})` : ""}`,
				fix: `Set ${setting} in pnpm-workspace.yaml and remove the line from .npmrc`
			});
		}
	}
	const legacy = tool.extra?.["onlyBuiltDependencies"] === void 0 ? void 0 : extraOf(tool, "onlyBuiltDependencies", isRecord);
	if (legacy !== void 0 && atLeast(version, legacy["removedIn"]) && workspace !== void 0) {
		const found = yamlSetting(workspace, ["onlyBuiltDependencies"]);
		if (found !== void 0) context.report({
			level: "warning",
			location: {
				file: "pnpm-workspace.yaml",
				line: found.line
			},
			message: `onlyBuiltDependencies was removed in pnpm ${String(legacy["removedIn"])}, so ${label} builds none of these packages`,
			fix: `List the packages under ${settingOf(tool.installScripts.allowList.setting) ?? "allowBuilds"} instead`
		});
	}
}
/** Duration strings written for a version that silently ignores them. */
function checkDurationStrings(context, tool, manager, version, label) {
	const fact = tool.extra?.["durationStrings"];
	const format = fact === void 0 ? void 0 : values$1(fact)[0];
	if (!isRecord(format) || format["before"] !== "no effect" || atLeast(version, format["since"])) return;
	const setting = settingOf(tool.cooldown.setting);
	const file = values$1(tool.cooldown.configFiles)[0]?.[0];
	if (setting === null || file === void 0 || !manager.configFiles.includes(file)) return;
	const found = readSetting(context.repository, file, setting);
	if (found === void 0 || typeof found.value !== "string" || /^\d+$/u.test(found.value.trim())) return;
	context.report({
		location: {
			file,
			line: found.line
		},
		message: `${label} ignores the duration string ${JSON.stringify(found.value)} in ${setting}; strings work only since ${String(format["since"])}, so no delay applies`,
		fix: `Write the delay as a number in ${tool.cooldown.unit.status === "disputed" ? "the tool's unit" : String(values$1(tool.cooldown.unit)[0])}, or require ${tool.name} ${String(format["since"])} or later`
	});
}
const settingIgnoredByVersion = {
	id: "setting-ignored-by-version",
	summary: "A setting or file is ignored by the package manager version in use.",
	description: "Package managers drop old settings and files in new major versions and only accept new forms from some version on. The configuration stays in the repository and looks effective while the version in use ignores it.",
	help: "Move the setting to the place and form this version reads.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
			const tool = context.tools.find((entry) => entry.id === manager.id);
			if (tool === void 0) continue;
			const pinned = pinnedVersion(manager);
			const version = pinned ?? latestVersion(tool);
			if (version === void 0) continue;
			const label = `${tool.name} ${formatVersion(version)}${pinned === void 0 ? " (the latest known version; none is pinned)" : ""}`;
			checkLockfiles(context, tool, version, label);
			if (tool.id === "pnpm") checkPnpm(context, tool, version, label);
			checkDurationStrings(context, tool, manager, version, label);
		}
	}
};

// src/doctor/rules/invalid-policy.ts
const invalidPolicy = {
	id: "invalid-policy",
	summary: `${POLICY_FILE} does not follow the schema or cannot be read.`,
	description: `Without a valid policy, the rules that compare the repository with ${POLICY_FILE} cannot run, so doctor runs only the rules that need no policy, as when there is no policy file.`,
	help: `Fix what the message lists; an editor that reads the $schema of ${POLICY_FILE} shows the problems as you type.`,
	level: "error",
	requiresPolicy: false,
	check(context) {
		try {
			loadPolicyIfPresent(context.root);
		} catch (error) {
			if (!(error instanceof PolicyError)) throw error;
			context.report({
				location: { file: POLICY_FILE },
				message: error.issues.length === 0 ? error.text : `${error.text}: ${error.issues.join("; ")}`,
				fix: policyErrorFix(error)
			});
		}
	}
};

// src/doctor/rules/lockfile.ts
const LABELS = {
	npm: {
		git: "a git repository",
		remoteTarball: "a tarball URL",
		file: "a local tarball",
		directory: "a local directory"
	},
	pypi: {
		git: "a git repository",
		remoteTarball: "a URL",
		file: "a local archive",
		directory: "a local directory"
	}
};
/** Why a Python package is built from source, for messages. */
const BUILT_FROM = {
	registry: "its index has only a source distribution",
	git: "it comes from a git repository",
	remoteTarball: "it is a source archive at a URL",
	file: "it is a local source archive",
	directory: "it is a local directory",
	workspace: "it is part of the workspace",
	unknown: "its source is not recognized"
};
function eachLockfile(context, rule, visit) {
	const workspaces = context.detection.workspaces?.packages ?? [];
	for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
		const tool = context.tools.find((entry) => entry.id === manager.id);
		if (tool === void 0) continue;
		for (const result of readLockfiles(context.repository, manager, tool, workspaces)) if (result.ok) visit(result.lockfile, tool);
		else if (!result.unreadable) context.notice(`${rule} could not check ${result.file}: ${result.reason}`, result.file);
	}
}
function location(lockfile, entry) {
	const line = lockfile.lineOf(entry);
	return line === void 0 ? { file: lockfile.file } : {
		file: lockfile.file,
		line
	};
}
const lockfileForbiddenSource = {
	id: "lockfile-forbidden-source",
	summary: "The lockfile installs a package from a source depcurfew.json denies.",
	description: "A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.",
	help: "Replace the dependency with a registry version, or allow that source in depcurfew.json.",
	level: "error",
	requiresPolicy: true,
	check(context) {
		const sources = context.policy?.sources;
		if (sources === void 0) return;
		const denies = Object.values(sources).includes("deny");
		eachLockfile(context, "lockfile-forbidden-source", (lockfile, tool) => {
			for (const entry of lockfile.entries) {
				if (entry.source === "unknown" && denies) {
					context.report({
						level: "warning",
						location: location(lockfile, entry),
						message: `${lockfile.file} installs ${entry.name} from a source depcurfew does not recognize (${shownSpec(entry.spec) || "no source given"}); it may be one ${POLICY_FILE} denies`,
						fix: `Check where ${entry.name} comes from, and regenerate the lockfile with the package manager if the entry is damaged`
					});
					continue;
				}
				if (entry.source !== "git" && entry.source !== "remoteTarball" && entry.source !== "file" && entry.source !== "directory") continue;
				if (sources[entry.source] !== "deny") continue;
				context.report({
					location: location(lockfile, entry),
					message: `${lockfile.file} installs ${entry.unnamed === true ? "a package" : entry.name} from ${LABELS[ecosystemOfTool(tool)][entry.source]} (${shownSpec(entry.spec)}), which ${POLICY_FILE} denies`,
					fix: `Use a registry version ${entry.unnamed === true ? "instead" : `of ${entry.name}`}, or set sources.${entry.source} to "allow" in ${POLICY_FILE}`
				});
			}
		});
	}
};
/** A lockfile spec for messages, without Yarn's locator parameters (::hash=…&locator=…) and repeated local paths. */
function shownSpec(spec) {
	const text = spec.split("::")[0] ?? spec;
	const hash = text.indexOf("#");
	return /^(?:file|portal|link):/u.test(text) && hash !== -1 ? text.slice(0, hash) : text;
}
/** Whether the version in use runs dependency install scripts without an allow-list, under any official reading. */
function runsScripts(context, tool) {
	const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
	const version = (manager === void 0 ? void 0 : pinnedVersion(manager)) ?? latestVersion(tool);
	return evidenceOf(tool.installScripts.defaultPolicy).some((evidence) => {
		const policy = versionedValue(evidence.value, version);
		return policy === "run" || policy === "run-with-warning";
	});
}
/**
* How the repository keeps dependency scripts from running with the tool's own switch: ignore-scripts in .npmrc turns
* them all off, strict-allow-scripts makes the install fail on scripts that are not allowed.
*/
function scriptsDisabledBy(context, tool) {
	const file = values$1(tool.cooldown.configFiles)[0]?.[0];
	if (file === void 0) return void 0;
	const fact = tool.installScripts.disableAll;
	const value = fact.status === "verified" ? fact.value : void 0;
	const match = typeof value === "string" ? /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value) : null;
	if (match !== null) {
		const [, key = "", expected] = match;
		const found = readSetting(context.repository, file, key);
		if (found !== void 0 && found.value === (expected === void 0 ? true : iniValue(expected))) return `${key} in ${file} turns them off`;
	}
	const strict = tool.extra?.["strictAllowScripts"] === void 0 ? void 0 : extraOf(tool, "strictAllowScripts", isSwitch);
	if (strict !== void 0 && readSetting(context.repository, file, strict.setting)?.value === strict.value) return `${strict.setting} in ${file} stops the install until they are allowed`;
}
/**
* Whether the repository forbids building Python packages from source with the tool's switch (no-build in uv,
* installer.only-binary in Poetry, --only-binary=:all: in a requirements file for pip), and where.
*/
function buildsForbiddenBy(context, tool, lockfile) {
	const build = tool.extra?.["buildSwitch"] === void 0 ? void 0 : extraOf(tool, "buildSwitch", isSwitch);
	if (build === void 0) return void 0;
	if (tool.id === "pip") {
		const format = requirementsFormatOf(tool);
		const found = (lockfile.optionFiles ?? []).find((file) => requirementsOptions(context.repository, file, format).some((line) => line.option === build.setting && line.value === build.value));
		return found === void 0 ? void 0 : `${build.setting}=${String(build.value)} in ${found} forbids building`;
	}
	const found = readPythonSetting(context.repository, tool, build.setting);
	return found !== void 0 && switchIsOn(found.value, build.value) ? `${build.setting} in ${found.file} forbids building` : void 0;
}
/**
* Whether a configured value turns the build switch on. A list switch (Poetry's [":all:"]) is also on when written as
* a comma-separated string or as true, which Poetry reads as the same thing.
*/
function switchIsOn(value, wanted) {
	if (!Array.isArray(wanted)) return value === wanted;
	const items = value === true ? wanted : typeof value === "string" ? value.split(",").map((item) => item.trim()) : Array.isArray(value) ? value : [];
	return wanted.every((item) => items.includes(item));
}
function reportPythonBuilds(context, lockfile, tool, allow) {
	const forbiddenBy = buildsForbiddenBy(context, tool, lockfile);
	const covers = (tool.extra?.["buildSwitch"] === void 0 ? void 0 : extraOf(tool, "buildSwitch", isSwitch))?.covers ?? [];
	const patterns = allow.map(normalizePythonName);
	for (const entry of lockfile.entries) {
		if (entry.installScript !== true || entry.source === "workspace") continue;
		if (entry.unnamed !== true && patterns.some((pattern) => matchesPattern(entry.name, pattern))) continue;
		const stopped = forbiddenBy !== void 0 && covers.includes(entry.source);
		const fix = entry.unnamed === true ? `Give the requirement a package name (name @ ${entry.spec}) so that it can be allowed with "${PYPI_PREFIX}name" in installScripts.allow in ${POLICY_FILE}, or remove it` : `Review ${entry.name} and add "${PYPI_PREFIX}${entry.name}" to installScripts.allow in ${POLICY_FILE} (it is then always built from source), or replace the package`;
		context.report({
			level: stopped ? "warning" : "error",
			location: location(lockfile, entry),
			message: stopped ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy}, so installing it fails until it is allowed` : forbiddenBy === void 0 ? `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} does not allow it` : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code: ${forbiddenBy} only for packages from an index, and ${POLICY_FILE} does not allow it`,
			fix
		});
	}
}
const lockfileInstallScripts = {
	id: "lockfile-install-scripts",
	summary: "The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.",
	description: "Install scripts run arbitrary code during installation, and so does building a Python package from source (a source distribution, a git repository or a local directory). Where the package manager runs them by default, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile; uv.lock, poetry.lock and pylock.toml show which Python packages have no wheel.",
	help: "Remove or replace the package, or add it to installScripts.allow in depcurfew.json after reviewing it (Python packages with the prefix pypi:).",
	level: "error",
	requiresPolicy: true,
	check(context) {
		const policy = context.policy;
		if (policy?.installScripts?.default !== "deny") return;
		eachLockfile(context, "lockfile-install-scripts", (lockfile, tool) => {
			const allow = policyFor(policy, ecosystemOfTool(tool)).installScripts?.allow ?? [];
			if (ecosystemOfTool(tool) === "pypi") {
				reportPythonBuilds(context, lockfile, tool, allow);
				return;
			}
			if (!lockfile.recordsScripts) {
				context.notice(`lockfile-install-scripts could not check ${lockfile.file}: ${tool.name} does not record install scripts in it`, lockfile.file);
				return;
			}
			const flagged = lockfile.entries.filter((entry) => entry.installScript === true);
			if (flagged.length === 0 && tool.id === "bun") context.notice(`${lockfile.file} marks no package with install scripts; Bun records them only since 1.4.4, so an older lockfile may hide some`, lockfile.file);
			const disabledBy = scriptsDisabledBy(context, tool);
			const running = disabledBy === void 0 && runsScripts(context, tool);
			for (const entry of flagged) {
				if (allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
				context.report({
					level: running ? "error" : "warning",
					location: location(lockfile, entry),
					message: running ? `${entry.name} has install scripts and ${tool.name} runs them by default, but ${POLICY_FILE} does not allow it` : disabledBy === void 0 ? `${entry.name} has install scripts that ${tool.name} will not run because ${POLICY_FILE} does not allow it; the package may need them` : `${entry.name} has install scripts that ${tool.name} will not run because ${disabledBy}; the package may need them`,
					fix: `Review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}, or replace the package`
				});
			}
		});
	}
};

// src/doctor/version-range.ts
const PARTIAL = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
/** Comparator operators; a space between an operator and its version is allowed, as in semver. */
const OPERATOR = /(\^|~>?|>=|<=|>|<|=)\s+/gu;
function partial(text) {
	const match = PARTIAL.exec(text);
	if (match === null) return void 0;
	const number = (part) => part === void 0 || /^[xX*]$/u.test(part) ? void 0 : Number(part);
	const major = Number(match[1]);
	const minor = number(match[2]);
	const patch = minor === void 0 ? void 0 : number(match[3]);
	const complete = minor !== void 0 && patch !== void 0;
	const version = [
		major,
		minor ?? 0,
		patch ?? 0
	];
	return {
		bound: complete && match[4] !== void 0 ? {
			version,
			prerelease: match[4]
		} : { version },
		complete
	};
}
/** Orders bounds: by version, and a prerelease before its release. Prereleases of one version count as equal. */
function compareBounds(a, b) {
	return compareVersions$1(a.version, b.version) || (a.prerelease === void 0 ? 0 : -1) - (b.prerelease === void 0 ? 0 : -1);
}
/** Whether `bound` comes before the release `version`. */
function belowVersion(bound, version) {
	return compareBounds(bound, { version }) < 0;
}
function formatBound(bound) {
	return bound.prerelease === void 0 ? formatVersion(bound.version) : `${formatVersion(bound.version)}-${bound.prerelease}`;
}
/** Lower bound of one comparator set (space-separated comparators that must all hold). */
function setLowerBound(set) {
	const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(set);
	if (hyphen !== null) {
		const from = partial(hyphen[1] ?? "");
		return from === void 0 ? void 0 : {
			bound: from.bound,
			exact: false
		};
	}
	const comparators = set.replaceAll(OPERATOR, "$1").split(/\s+/u).filter(Boolean);
	if (comparators.length === 0 || comparators.every((part) => /^[xX*]$/u.test(part))) return {
		bound: { version: [
			0,
			0,
			0
		] },
		exact: false
	};
	let lowest = { version: [
		0,
		0,
		0
	] };
	let exact = comparators.length === 1;
	for (const comparator of comparators) {
		const match = /^(\^|~>?|>=|<=|>|<|=)?(.+)$/u.exec(comparator);
		if (match === null) return void 0;
		const operator = match[1] ?? "";
		const value = partial(match[2] ?? "");
		if (value === void 0) return void 0;
		if (operator === "<" || operator === "<=") {
			exact = false;
			continue;
		}
		let bound = value.bound;
		if (operator === ">" && bound.prerelease === void 0) {
			const given = (match[2] ?? "").split(".").filter((part) => /^\d+$/u.test(part)).length;
			const [major, minor, patch] = bound.version;
			bound = { version: given >= 3 ? [
				major,
				minor,
				patch + 1
			] : given === 2 ? [
				major,
				minor + 1,
				0
			] : [
				major + 1,
				0,
				0
			] };
		}
		if (operator !== "" && operator !== "=") exact = false;
		if (!value.complete) exact = false;
		if (compareBounds(bound, lowest) > 0) lowest = bound;
	}
	return {
		bound: lowest,
		exact
	};
}
function lowestVersion(text) {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed.includes("${{")) return { kind: "unknown" };
	let result;
	for (const set of trimmed.split("||")) {
		const lower = setLowerBound(set.trim());
		if (lower === void 0) return { kind: "unknown" };
		const order = result === void 0 ? -1 : compareBounds(lower.bound, result.bound);
		if (result === void 0 || order < 0) result = lower;
		else if (order === 0) result = {
			bound: result.bound,
			exact: result.exact && lower.exact
		};
	}
	if (result === void 0) return { kind: "unknown" };
	const sets = trimmed.split("||").length;
	return {
		kind: result.exact && sets === 1 ? "exact" : "range",
		...result.bound
	};
}

// src/doctor/rules/manager-version.ts
function feature(setting, since) {
	if (setting === null || since === void 0) return void 0;
	const version = typeof since === "string" ? since : sinceOf(since);
	if (version === void 0 || parseVersion(version) === void 0) return void 0;
	return {
		setting,
		since: version,
		disputed: typeof since !== "string" && since.status === "disputed"
	};
}
/** Settings depcurfew.json makes `apply` write for this tool. */
function policyFeatures(tool, policy) {
	const features = [];
	if (policy.cooldown !== void 0) {
		features.push(feature(settingOf(tool.cooldown.setting), tool.cooldown.availableSince));
		const exact = tool.extra?.["cooldownExactVersions"] === void 0 ? void 0 : values$1(tool.extra["cooldownExactVersions"])[0];
		const setting = settingOf(tool.cooldown.setting);
		if (typeof exact === "string" && setting !== null) features.push(feature(`${setting} for packages requested by exact version`, exact));
		if (policy.cooldown.exclude.length > 0) features.push(feature(settingOf(tool.cooldown.exclude.setting), tool.cooldown.exclude.availableSince));
	}
	if (policy.installScripts !== void 0) {
		const build = tool.extra?.["buildSwitch"] === void 0 ? void 0 : values$1(tool.extra["buildSwitch"])[0];
		if (policy.installScripts.default === "deny" && isSwitch(build)) features.push(feature(build.setting, build.since));
		const allowAll = tool.extra?.["allowAllScripts"] ?? tool.extra?.["allowAllBuilds"];
		const switchFact = allowAll === void 0 ? void 0 : values$1(allowAll)[0];
		if (policy.installScripts.default === "allow" && isSwitch(switchFact)) features.push(feature(switchFact.setting, switchFact.since));
		if (policy.installScripts.default === "deny" && policy.installScripts.allow.length > 0) {
			const legacy = tool.extra?.["onlyBuiltDependencies"] === void 0 ? void 0 : extraOf(tool, "onlyBuiltDependencies", isRecord);
			const setting = settingOf(tool.installScripts.allowList.setting);
			features.push(legacy !== void 0 && typeof legacy["since"] === "string" ? feature(setting, legacy["since"]) : feature(setting?.includes("<") ? setting.split(".")[0] ?? setting : setting, tool.installScripts.allowList.availableSince));
		}
	}
	for (const kind of SOURCE_KINDS) {
		const source = tool.sources?.[kind];
		if (policy.sources?.[kind] !== void 0 && source !== void 0) features.push(feature(settingOf(source.setting), source.availableSince));
	}
	return features.filter((item) => item !== void 0);
}
/** Settings already present in the manager's own configuration file. */
function configuredFeatures(context, tool) {
	const file = values$1(tool.cooldown.configFiles)[0]?.[0];
	if (file === void 0) return [];
	const candidates = [
		[settingOf(tool.cooldown.setting), tool.cooldown.availableSince],
		[settingOf(tool.cooldown.exclude.setting), tool.cooldown.exclude.availableSince],
		...SOURCE_KINDS.map((kind) => [settingOf(tool.sources?.[kind]?.setting), tool.sources?.[kind]?.availableSince])
	];
	const files = tool.id === "deno" ? context.detection.packageManagers.find((entry) => entry.id === "deno")?.configFiles.filter((name) => /^deno\.jsonc?$/u.test(name)) ?? [] : [file];
	const configured = (setting) => ecosystemOfTool(tool) === "pypi" ? readPythonSetting(context.repository, tool, setting) !== void 0 : files.some((name) => readSetting(context.repository, name, setting) !== void 0);
	return candidates.filter(([setting]) => setting !== null && configured(setting)).map(([setting, since]) => feature(setting, since)).filter((item) => item !== void 0);
}
const SOURCE_LABEL = {
	packageManager: "packageManager",
	"tool-config": "the required version",
	devEngines: "devEngines",
	volta: "Volta",
	"tool-versions": ".tool-versions",
	"github-actions": "GitHub Actions"
};
/** Where a version is declared, for messages; a tool's own required version is named by its key. */
function sourceLabel(tool, declaration) {
	if (declaration.source !== "tool-config") return SOURCE_LABEL[declaration.source];
	const required = tool.extra?.["requiredVersion"] === void 0 ? void 0 : values$1(tool.extra["requiredVersion"])[0];
	if (!isRecord(required) || typeof required["key"] !== "string") return SOURCE_LABEL[declaration.source];
	return declaration.file.endsWith("pyproject.toml") && typeof required["table"] === "string" ? `${required["key"]} in [${required["table"]}]` : required["key"];
}
function declarationLine(context, declaration) {
	if (declaration.line !== void 0) return declaration.line;
	const text = context.repository.readText(declaration.file);
	if (text === void 0) return void 0;
	const key = declaration.source === "packageManager" ? "\"packageManager\"" : declaration.source === "devEngines" ? "\"devEngines\"" : declaration.source === "volta" ? "\"volta\"" : void 0;
	return key === void 0 ? void 0 : lineOf(text, key);
}
function checkManager(context, manager, tool) {
	const features = /* @__PURE__ */ new Map();
	for (const item of [...context.policy === void 0 ? [] : policyFeatures(tool, policyFor(context.policy, ecosystemOfTool(tool))), ...configuredFeatures(context, tool)]) features.set(item.setting, item);
	if (features.size === 0) return;
	for (const declaration of manager.versions) {
		if (!("version" in declaration)) continue;
		const lowest = lowestVersion(declaration.version);
		const label = sourceLabel(tool, declaration);
		const where = `${label} (${declaration.file})`;
		if (lowest.kind === "unknown") {
			context.notice(`manager-version-too-old cannot evaluate ${tool.name} version "${declaration.version}" in ${declaration.file}`, declaration.file);
			continue;
		}
		const below = [...features.values()].filter((item) => belowVersion(lowest, parseVersion(item.since)));
		const missing = below.filter((item) => !below.some((other) => other !== item && item.setting.startsWith(`${other.setting} for `)));
		if (missing.length === 0) continue;
		const needed = missing.map((item) => parseVersion(item.since)).reduce((a, b) => compareVersions$1(a, b) >= 0 ? a : b);
		const list = describeRequirements(missing);
		const line = declarationLine(context, declaration);
		const subject = lowest.kind === "exact" ? `${tool.name} ${formatBound(lowest)} in ${where} does not support ${list}` : `${where} allows ${tool.name} ${formatBound(lowest)} ("${declaration.version}"), which does not support ${list}`;
		context.report({
			level: lowest.kind === "exact" ? "error" : "warning",
			location: line === void 0 ? { file: declaration.file } : {
				file: declaration.file,
				line
			},
			message: subject,
			fix: `Require ${tool.name} ${formatVersion(needed)} or later in ${label}`
		});
	}
}
const managerVersionTooOld = {
	id: "manager-version-too-old",
	summary: "A declared package manager version is older than a setting the repository relies on.",
	description: "Package managers ignore settings they do not know yet. When packageManager, devEngines, Volta, .tool-versions or a CI step pins an older version, the setting is silently not applied there.",
	help: "Raise the declared version to at least the version that introduced the setting, everywhere it is declared.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
			const tool = context.tools.find((entry) => entry.id === manager.id);
			if (tool !== void 0) checkManager(context, manager, tool);
		}
		for (const manager of context.detection.packageManagers.filter((entry) => !entry.supported && entry.variant === "classic")) {
			const berry = context.tools.find((entry) => entry.id === manager.id);
			if (context.policy === void 0 || berry === void 0) continue;
			const declaration = manager.versions.find((entry) => entry.source === "packageManager");
			const file = declaration?.file ?? manager.evidence[0]?.file ?? "package.json";
			const line = declaration === void 0 ? void 0 : declarationLine(context, declaration);
			const since = sinceOf(berry.cooldown.availableSince);
			context.report({
				level: "error",
				location: line === void 0 ? { file } : {
					file,
					line
				},
				message: `Yarn Classic (1.x) has none of the settings ${POLICY_FILE} needs (release-age delay, install-script allow-list, dependency sources), so the policy does not apply to it`,
				fix: `Move to ${berry.name}${since === void 0 ? "" : ` ${since} or later`}, or to another package manager depcurfew configures`
			});
		}
	}
};

// src/doctor/rules/npmrc.ts
function kebab(setting) {
	return setting.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
function before(version, limit) {
	const until = typeof limit === "string" ? parseVersion(limit) : void 0;
	return until !== void 0 && compareVersions$1(version, until) < 0;
}
function managerOf(context, id) {
	const manager = context.detection.packageManagers.find((entry) => entry.id === id && entry.supported);
	const tool = context.tools.find((entry) => entry.id === id);
	const version = manager === void 0 || tool === void 0 ? void 0 : pinnedVersion(manager) ?? latestVersion(tool);
	return manager === void 0 || tool === void 0 || version === void 0 ? void 0 : {
		manager,
		tool,
		version
	};
}
/** Security settings of a tool, as they are spelled in .npmrc. */
function npmrcKeys(tool, spell) {
	const allowAll = ["allowAllScripts", "allowAllBuilds"].map((key) => tool.extra?.[key] === void 0 ? void 0 : extraOf(tool, key, isSwitch).setting);
	const settings = [
		settingOf(tool.cooldown.setting),
		settingOf(tool.cooldown.exclude.setting),
		...allowAll,
		...[
			"git",
			"remoteTarball",
			"file",
			"directory"
		].map((kind) => settingOf(tool.sources?.[kind]?.setting))
	].filter((setting) => typeof setting === "string" && !setting.includes(" "));
	return new Map(settings.map((setting) => [spell(setting), setting]));
}
function entriesFor(context, file, keys) {
	const text = context.repository.readText(file);
	if (text === void 0) return [];
	return iniEntries(text).flatMap((entry) => {
		const setting = keys.get(entry.key.replace(/\[\]$/u, ""));
		return setting === void 0 ? [] : [{
			...entry,
			setting
		}];
	});
}
function packageNpmrcFiles(context) {
	return context.detection.npmrcFiles.filter((file) => file !== ".npmrc");
}
/** npm reads only the project root's .npmrc. */
function checkNpmWorkspaces(context) {
	const npm = managerOf(context, "npm");
	if (npm === void 0 || extraOf(npm.tool, "npmrcScope", isRecord)["workspacePackages"] !== "ignored") return;
	const keys = npmrcKeys(npm.tool, (setting) => setting);
	for (const file of packageNpmrcFiles(context)) for (const entry of entriesFor(context, file, keys)) context.report({
		level: "warning",
		location: {
			file,
			line: entry.line
		},
		message: `npm reads .npmrc only at the project root, so ${entry.key} in ${file} has no effect`,
		fix: `Set it in the root .npmrc, or in ${POLICY_FILE} and run depcurfew apply`
	});
}
/** pnpm 10 reads .npmrc too, but pnpm-workspace.yaml wins; a root .npmrc value counts only when the YAML lacks it. */
function checkPnpmRoot(context) {
	const pnpm = managerOf(context, "pnpm");
	const policy = context.policy === void 0 ? void 0 : policyFor(context.policy, "npm");
	if (pnpm === void 0 || policy?.cooldown === void 0) return;
	const ignored = extraOf(pnpm.tool, "ignoredSince", isRecord);
	if (!before(pnpm.version, ignored["since"])) return;
	const precedence = extraOf(pnpm.tool, "npmrcPrecedence", isRecord);
	const workspace = context.repository.readText("pnpm-workspace.yaml");
	const cooldownSetting = settingOf(pnpm.tool.cooldown.setting);
	const excludeSetting = settingOf(pnpm.tool.cooldown.exclude.setting);
	const label = `pnpm ${formatVersion(pnpm.version)}`;
	for (const entry of entriesFor(context, ".npmrc", npmrcKeys(pnpm.tool, kebab))) {
		if (precedence["winner"] === "pnpm-workspace.yaml" && workspace !== void 0 && yamlSetting(workspace, [entry.setting]) !== void 0) continue;
		if (entry.setting === cooldownSetting) {
			const wanted = convertCooldown(pnpm.tool, policy.cooldown.minimum);
			const actual = delayMinutes(pnpm.tool, iniValue(entry.value), pnpm.version);
			if (!wanted.ok || !actual.ok || actual.minutes >= policy.cooldown.minimum.minutes) continue;
			context.report({
				location: {
					file: ".npmrc",
					line: entry.line
				},
				message: `${entry.key}=${entry.value} in .npmrc sets ${label} to wait ${actual.minutes === 0 ? "not at all" : formatMinutes(actual.minutes)}, shorter than ${policy.cooldown.minimum.text} in ${POLICY_FILE}, because pnpm-workspace.yaml does not set ${entry.setting}`,
				fix: "Remove the line and run depcurfew apply, which writes the delay to pnpm-workspace.yaml"
			});
		} else if (entry.setting === excludeSetting && !policy.cooldown.exclude.some((pattern) => matchesPattern(entry.value, pattern) || pattern === entry.value)) context.report({
			location: {
				file: ".npmrc",
				line: entry.line
			},
			message: `${entry.key} in .npmrc exempts ${entry.value} from the ${label} delay, but ${POLICY_FILE} does not`,
			fix: `Remove the line, or add ${entry.value} to cooldown.exclude in ${POLICY_FILE} and run depcurfew apply`
		});
	}
}
const npmrcOverridesPolicy = {
	id: "npmrc-overrides-policy",
	summary: "An .npmrc file changes a security setting in a way the policy does not see, or is ignored.",
	description: "Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages, and pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy.",
	help: "Keep security settings out of .npmrc files that are ignored or that override the policy; set them through depcurfew.json and depcurfew apply.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		checkNpmWorkspaces(context);
		checkPnpmRoot(context);
	}
};
const pnpmSharedWorkspaceLockfile = {
	id: "pnpm-shared-workspace-lockfile",
	summary: "pnpm 10 without a shared lockfile lets a package .npmrc change the release-age delay.",
	description: "With sharedWorkspaceLockfile: false, pnpm 10 installs every workspace project separately with that project's own .npmrc layered over the workspace settings (read from the pnpm 10 source code), so a setting such as minimum-release-age=0 in a package .npmrc applies to that package.",
	help: "Remove security settings from package .npmrc files, or keep the default shared lockfile.",
	level: "warning",
	requiresPolicy: false,
	check(context) {
		const pnpm = managerOf(context, "pnpm");
		if (pnpm === void 0) return;
		const perProject = extraOf(pnpm.tool, "perProjectNpmrc", isRecord);
		const shared = extraOf(pnpm.tool, "sharedWorkspaceLockfile", isRecord);
		if (!before(pnpm.version, perProject["until"])) return;
		const workspace = context.repository.readText("pnpm-workspace.yaml");
		const fromYaml = workspace === void 0 ? void 0 : yamlSetting(workspace, [String(shared["setting"])]);
		const fromNpmrc = iniEntries(context.repository.readText(".npmrc") ?? "").filter((entry) => entry.key === shared["npmrcKey"]).at(-1);
		if ((fromYaml !== void 0 ? fromYaml.value : fromNpmrc !== void 0 ? iniValue(fromNpmrc.value) : shared["default"]) !== perProject["sharedWorkspaceLockfile"]) return;
		const where = fromYaml !== void 0 ? "pnpm-workspace.yaml" : ".npmrc";
		const keys = npmrcKeys(pnpm.tool, kebab);
		for (const file of packageNpmrcFiles(context)) for (const entry of entriesFor(context, file, keys)) context.report({
			location: {
				file,
				line: entry.line
			},
			message: `${String(shared["setting"])} is false (${where}), so pnpm ${formatVersion(pnpm.version)} installs this package with its own .npmrc and ${entry.key}=${entry.value} replaces the workspace setting for it`,
			fix: `Remove the line from ${file}, or set ${String(shared["setting"])}: true`
		});
	}
};

// src/doctor/rules/python-config.ts
const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** The settings depcurfew manages for a Python tool, as keys of its configuration table. */
function managedKeys(tool) {
	const build = tool.extra?.["buildSwitch"] === void 0 ? void 0 : extraOf(tool, "buildSwitch", isSwitch);
	const required = tool.extra?.["requiredVersion"] === void 0 ? void 0 : extraOf(tool, "requiredVersion", isRecord);
	return [
		settingOf(tool.cooldown.setting),
		settingOf(tool.cooldown.exclude.setting),
		build?.setting ?? null,
		settingOf(tool.installScripts.allowList.setting),
		typeof required?.["key"] === "string" ? required["key"] : null
	].filter((key) => key !== null);
}
/** The keys of a TOML table in a file that set one of `keys`, with their lines. */
function keysIn(context, file, table, keys) {
	return keys.flatMap((key) => {
		const found = tomlSettingAt(context.repository, file, [...table, key]);
		return found === void 0 ? [] : [{
			key,
			line: found.line
		}];
	});
}
function checkUv(context, tool) {
	const tables = extraOf(tool, "configTables", isRecord);
	const order = extraOf(tool, "configFileOrder", isStrings);
	const [winner, loser] = order;
	if (winner === void 0 || loser === void 0) return;
	const keys = managedKeys(tool);
	const table = (file) => String(tables[file] ?? "") === "" ? [] : String(tables[file]).split(".");
	if (context.repository.isFile(winner)) for (const { key, line } of keysIn(context, loser, table(loser), keys)) context.report({
		location: {
			file: loser,
			line
		},
		message: `uv reads ${winner} and ignores [${String(tables[loser])}] in ${loser}, so ${key} here has no effect`,
		fix: `Move ${key} to ${winner}, or remove it from ${loser}`
	});
	if (extraOf(tool, "workspaceRootOnly", (value) => typeof value === "boolean")) for (const member of context.detection.workspaces?.packages ?? []) for (const file of order) {
		const path = joinPath(member, file);
		for (const { key, line } of keysIn(context, path, table(file), keys)) context.report({
			location: {
				file: path,
				line
			},
			message: `uv reads settings only from the workspace root, so ${key} in ${path} has no effect`,
			fix: `Set ${key} in the root ${winner} or [${String(tables["pyproject.toml"])}] of the root pyproject.toml, and remove it from ${path}`
		});
	}
	fixedDate(context, tool);
}
/** An exclude-newer date, which never moves, where a duration was meant (uv, PDM). */
function fixedDate(context, tool) {
	const setting = settingOf(tool.cooldown.setting);
	const found = setting === null ? void 0 : readPythonSetting(context.repository, tool, setting);
	if (found === void 0 || !(typeof found.value === "string" || typeof found.value === "object") || !/^\d{4}-\d{2}-\d{2}/u.test(String(found.value))) return;
	const syntax = tool.extra?.["durationStrings"] === void 0 ? void 0 : extraOf(tool, "durationStrings", isRecord)["syntax"];
	context.report({
		level: "warning",
		location: {
			file: found.file,
			line: found.line
		},
		message: `${setting} is the fixed date ${String(found.value)}, so ${tool.name} never uses versions uploaded after it; that is a freeze, not a delay that moves with time`,
		fix: `Write a duration such as "${syntax === "compact" ? "3d" : "3 days"}" (${tool.name} ${sinceOf(tool.cooldown.availableSince) ?? ""} or later), or let depcurfew apply write it from cooldown.minimum`
	});
}
/** PDM in uv mode (use_uv in pdm.toml) installs with uv sync, without its build settings. */
function checkPdm(context, tool) {
	fixedDate(context, tool);
	const mode = tool.extra?.["uvMode"] === void 0 ? void 0 : extraOf(tool, "uvMode", isRecord);
	if (typeof mode?.["file"] !== "string" || typeof mode["key"] !== "string") return;
	const found = tomlSettingAt(context.repository, mode["file"], [mode["key"]]);
	if (found?.value !== true) return;
	const build = tool.extra?.["buildSwitch"] === void 0 ? void 0 : extraOf(tool, "buildSwitch", isSwitch);
	if (build === void 0 || readPythonSetting(context.repository, tool, build.setting) === void 0) return;
	context.report({
		level: "warning",
		location: {
			file: found.file,
			line: found.line
		},
		message: `${mode["key"]} in ${found.file} makes ${tool.name} install with uv sync, which it runs without ${build.setting}, so packages may still be built from source when installing`,
		fix: `Remove ${mode["key"]} from ${found.file}, or forbid building in uv too ([tool.uv] no-build = true in pyproject.toml)`
	});
}
/** Pipenv's pure-Python resolver (resolver_backend = "pure-python") locks without cool-down-period. */
function checkPipenv(context, tool) {
	const bypass = tool.extra?.["resolverBypass"] === void 0 ? void 0 : extraOf(tool, "resolverBypass", isRecord);
	const setting = settingOf(tool.cooldown.setting);
	if (bypass === void 0 || setting === null || !isStrings(bypass["keys"]) || typeof bypass["table"] !== "string") return;
	const delay = readPythonSetting(context.repository, tool, setting);
	if (delay === void 0) return;
	for (const key of bypass["keys"]) {
		const found = tomlSettingAt(context.repository, delay.file, [bypass["table"], key]);
		if (found === void 0 || found.value !== bypass["value"]) continue;
		context.report({
			location: {
				file: found.file,
				line: found.line
			},
			message: `${key} = ${JSON.stringify(found.value)} makes ${tool.name} lock without ${setting}, so the release-age delay in ${delay.file} has no effect`,
			fix: `Remove ${key} from [${bypass["table"]}] in ${delay.file}, so that ${tool.name} locks with pip and applies ${setting}`
		});
	}
}
function checkPip(context, tool, configFiles) {
	const names = extraOf(tool, "configFileNames", isStrings);
	const configVariable = extraOf(tool, "configFileVariable", (value) => typeof value === "string");
	for (const directory of [".", ...context.detection.workspaces?.packages ?? []]) for (const name of names) {
		const file = joinPath(directory, name);
		if (!context.repository.isFile(file)) continue;
		context.report({
			level: "warning",
			location: { file },
			message: `pip reads no configuration from the project, so ${file} has no effect unless ${configVariable} points to it`,
			fix: `Set ${configVariable}=${file} where pip runs, or put the options in the requirements file pip installs from`
		});
	}
	const allowed = new Set(extraOf(tool, "requirementsOptions", isStrings));
	const format = extraOf(tool, "requirementsFormat", isRecord);
	const cooldownFlag = `--${settingOf(tool.cooldown.setting) ?? ""}`;
	const variable = extraOf(tool, "environmentVariable", (value) => typeof value === "string");
	for (const file of configFiles) for (const { option, line } of requirementsOptions(context.repository, file, format)) {
		if (allowed.has(option)) continue;
		context.report({
			location: {
				file,
				line
			},
			message: `pip does not accept ${option} in requirements files, so installing from ${file} fails`,
			fix: option === cooldownFlag ? `Remove the line and set ${variable} where pip runs instead` : `Remove the line, and pass ${option} on the pip command line instead`
		});
	}
}
const pythonConfigIgnored = {
	id: "python-config-ignored",
	summary: "A Python tool ignores a setting where it is written.",
	description: "uv reads uv.toml instead of [tool.uv] when both exist, and in a workspace only the root; pip reads no configuration from the project and rejects options it does not know in requirements files; PDM in uv mode installs without only-binary; Pipenv with resolver_backend = \"pure-python\" locks without cool-down-period. A setting in such a place looks effective but is not, and an exclude-newer date freezes dependencies instead of delaying new versions.",
	help: "Move the setting to the file the tool reads.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		for (const manager of context.detection.packageManagers) {
			const tool = context.tools.find((entry) => entry.id === manager.id);
			if (tool === void 0) continue;
			if (tool.id === "uv") checkUv(context, tool);
			if (tool.id === "pip") checkPip(context, tool, manager.configFiles);
			if (tool.id === "pdm") checkPdm(context, tool);
			if (tool.id === "pipenv") checkPipenv(context, tool);
		}
	}
};

// src/doctor/rules/unreadable-config.ts
/** Repository warnings that mean a file was not checked. */
const UNREADABLE_WARNINGS = {
	"invalid-file": "Fix the syntax error, so that depcurfew can check the file",
	"file-too-large": "Make the file smaller than the limit, or check its settings by hand",
	"outside-repository": "Replace the symlink with a regular file inside the repository",
	"workspace-outside-repository": "Keep workspace packages inside the repository",
	"unreadable-include": "Keep the included files in the repository and refer to them by a relative path, so that depcurfew can check them"
};
const unreadableConfig = {
	id: "unreadable-config",
	summary: "A configuration file or lockfile cannot be read, parsed or edited, so depcurfew cannot check it.",
	description: "A package manager or bot may still read the file and its settings may weaken the policy; depcurfew fails closed and reports an error instead of passing silently.",
	help: "Fix what the message describes: invalid syntax, a symlink, a file over the size limit or a style depcurfew apply cannot edit.",
	level: "error",
	requiresPolicy: false,
	check(context) {
		const reported = /* @__PURE__ */ new Set();
		const warnings = [...context.detection.warnings, ...context.repository.warnings];
		for (const warning of warnings) {
			const fix = UNREADABLE_WARNINGS[warning.code];
			const file = warning.files[0] ?? "depcurfew.json";
			if (fix === void 0 || reported.has(file)) continue;
			reported.add(file);
			context.report({
				location: { file },
				message: `${warning.message.replace(/:$/u, "")}; depcurfew cannot check it`,
				fix
			});
		}
		for (const failure of plannedApply(context)?.failures ?? []) {
			if (reported.has(failure.file)) continue;
			reported.add(failure.file);
			context.report({
				location: { file: failure.file },
				message: `depcurfew apply cannot edit ${failure.file} for ${context.tools.find((tool) => tool.id === failure.tool)?.name ?? failure.tool} (${failure.message}), so it cannot be checked against ${POLICY_FILE}`,
				fix: "Fix what the message describes, then run depcurfew apply; or add the settings by hand"
			});
		}
	}
};

// src/doctor/rules/index.ts
/** Every doctor rule, in the order they are documented. unreadable-config runs last, after every other rule has read its files. */
const RULES = [
	invalidPolicy,
	managerVersionTooOld,
	settingIgnoredByVersion,
	npmrcOverridesPolicy,
	pnpmSharedWorkspaceLockfile,
	pythonConfigIgnored,
	configDrift,
	botCooldownMismatch,
	broadExclusion,
	lockfileForbiddenSource,
	lockfileInstallScripts,
	unreadableConfig
];

// src/color.ts
const CODES = {
	red: [31, 39],
	yellow: [33, 39],
	green: [32, 39],
	cyan: [36, 39],
	bold: [1, 22],
	dim: [2, 22]
};
const style = ([open, close]) => (text) => text === "" ? text : `\u001b[${open}m${text}\u001b[${close}m`;
const same = (text) => text;
const PLAIN = {
	red: same,
	yellow: same,
	green: same,
	cyan: same,
	bold: same,
	dim: same
};
const COLORED = {
	red: style(CODES.red),
	yellow: style(CODES.yellow),
	green: style(CODES.green),
	cyan: style(CODES.cyan),
	bold: style(CODES.bold),
	dim: style(CODES.dim)
};

// src/doctor/render.ts
function countLevels(findings) {
	const counts = {
		error: 0,
		warning: 0,
		note: 0
	};
	for (const finding of findings) counts[finding.level] += 1;
	return counts;
}
function plural$1(count, word) {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}
function levelColor(level, colors) {
	if (level === "error") return (text) => colors.bold(colors.red(text));
	return level === "warning" ? colors.yellow : colors.cyan;
}
function renderText(report, rules, colors = PLAIN) {
	const counts = countLevels(report.findings);
	const lines = [];
	if (report.findings.length === 0) lines.push(colors.green("No problems found."));
	else {
		const count = (level) => counts[level] === 0 ? plural$1(0, level) : levelColor(level, colors)(plural$1(counts[level], level));
		lines.push(`${count("error")}, ${count("warning")}, ${count("note")}`);
		let file;
		for (const finding of report.findings) {
			if (finding.location.file !== file) {
				file = finding.location.file;
				lines.push("", colors.bold(file));
			}
			const where = finding.location.line === void 0 ? "" : `${finding.location.line}: `;
			const help = finding.fix ?? rules.find((rule) => rule.id === finding.rule)?.help;
			lines.push(`  ${where}${levelColor(finding.level, colors)(finding.level)} ${finding.message} ${colors.dim(`(${finding.rule})`)}`);
			if (help !== void 0) lines.push(`    ${colors.green("fix:")} ${help}`);
		}
	}
	if (report.notices.length > 0) lines.push("", colors.bold("Notes:"), ...report.notices.map((notice) => `  ${notice.message}`));
	return `${lines.join("\n")}\n`;
}

// src/doctor/sarif.ts
const SARIF_SCHEMA = "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const INFORMATION_URI = "https://www.npmjs.com/package/depcurfew";
function ruleName(id) {
	return id.replace(/(^|-)([a-z])/gu, (_match, _dash, letter) => letter.toUpperCase());
}
function toSarif(report, rules, version, readLine = () => void 0) {
	const location = (file, line) => {
		const startLine = line ?? 1;
		const text = readLine(file, startLine) ?? "";
		return { physicalLocation: {
			artifactLocation: {
				uri: file,
				uriBaseId: "%SRCROOT%"
			},
			region: {
				startLine,
				startColumn: 1,
				endLine: startLine,
				endColumn: Math.max(text.length, 1) + 1
			}
		} };
	};
	const index = new Map(rules.map((rule, position) => [rule.id, position]));
	return {
		$schema: SARIF_SCHEMA,
		version: "2.1.0",
		runs: [{
			tool: { driver: {
				name: "depcurfew",
				version,
				informationUri: INFORMATION_URI,
				rules: rules.map((rule) => ({
					id: rule.id,
					name: ruleName(rule.id),
					shortDescription: { text: rule.summary },
					fullDescription: { text: rule.description },
					help: { text: rule.help },
					defaultConfiguration: { level: rule.level },
					properties: { tags: ["security", "supply-chain"] }
				}))
			} },
			invocations: [{
				executionSuccessful: true,
				toolExecutionNotifications: report.notices.map((notice) => ({
					level: "note",
					message: { text: notice.message },
					...notice.file === void 0 ? {} : { locations: [location(notice.file, void 0)] }
				}))
			}],
			results: report.findings.map((finding) => ({
				ruleId: finding.rule,
				...index.has(finding.rule) ? { ruleIndex: index.get(finding.rule) } : {},
				level: finding.level,
				message: { text: finding.fix === void 0 ? finding.message : `${finding.message}. Fix: ${finding.fix}` },
				locations: [location(finding.location.file, finding.location.line)]
			}))
		}]
	};
}

// src/doctor/github.ts
const LEVELS = [
	"error",
	"warning",
	"note"
];
function fixOf(finding, rules) {
	return finding.fix ?? rules.find((rule) => rule.id === finding.rule)?.help;
}
function plural(count, word) {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}
function escaped(text, replacements) {
	return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}
/** Annotation commands for the findings, errors first, within the number GitHub shows in one step. */
function annotationCommands(report, rules, format = values$1(environment.githubActions.annotations)[0], limits = values$1(environment.githubActions.annotationLimits)[0]) {
	if (format === void 0 || limits === void 0) return {
		lines: [],
		omitted: report.findings.length
	};
	const data = (text) => escaped(text, format.escape);
	const property = (text) => escaped(escaped(text, format.escape), format.escapeProperty);
	const lines = [];
	for (const level of LEVELS) {
		const findings = report.findings.filter((finding) => finding.level === level);
		for (const finding of findings.slice(0, Math.min(limits.perLevelPerStep, limits.perJob - lines.length))) {
			const properties = [
				[format.properties.file, finding.location.file],
				[format.properties.line, finding.location.line === void 0 ? void 0 : String(finding.location.line)],
				[format.properties.title, `depcurfew: ${finding.rule}`]
			].flatMap(([name, value]) => value === void 0 ? [] : [`${name}=${property(value)}`]);
			const fix = fixOf(finding, rules);
			const message = fix === void 0 ? finding.message : `${finding.message}\nFix: ${fix}`;
			lines.push(`::${format.commands[level]} ${properties.join(",")}::${data(message)}`);
		}
	}
	return {
		lines,
		omitted: report.findings.length - lines.length
	};
}
/** Markdown text with code spans kept: outside them special characters are escaped, inside only the table pipe. */
function markdown(text) {
	return text.replaceAll(/\s*[\r\n]+\s*/gu, " ").split(/(`[^`]*`)/u).map((part, index) => index % 2 === 1 ? part.replaceAll("|", "\\|") : part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(/([\\`*_[\]|~#!])/gu, "\\$1").replaceAll(/(https?|www)(?=[:.])/gu, "$1&#8203;")).join("");
}
function code(text) {
	return text.includes("`") ? markdown(text) : `\`${text.replaceAll("|", "\\|")}\``;
}
/**
* The job summary: the counts, a table of findings with how to fix each one and the notices. Rows that would make it
* longer than `maxBytes` are left out and counted instead, so the summary upload does not fail.
*/
function jobSummary(report, rules, directory, maxBytes) {
	const counts = countLevels(report.findings);
	const where = directory === "" ? "" : ` in ${code(directory)}`;
	const head = ["## depcurfew doctor", ""];
	if (report.findings.length === 0) head.push(`No problems found${where}.`);
	else {
		const count = (level) => counts[level] === 0 ? plural(0, level) : `**${plural(counts[level], level)}**`;
		head.push(`${count("error")}, ${count("warning")}, ${count("note")}${where}.`, "", "| Level | Where | Problem | How to fix |", "| --- | --- | --- | --- |");
	}
	const tail = [...report.notices.length === 0 ? [] : [
		"",
		"### Notes",
		"",
		...report.notices.map((notice) => `- ${markdown(notice.message)}`)
	], ""];
	let size = Buffer.byteLength([...head, ...tail].join("\n")) + 200;
	const rows = [];
	for (const finding of report.findings) {
		const location = finding.location.line === void 0 ? finding.location.file : `${finding.location.file}:${finding.location.line}`;
		const row = `| ${finding.level === "error" ? "**error**" : finding.level} | ${code(location)} | ${markdown(finding.message)} (${code(finding.rule)}) | ${markdown(fixOf(finding, rules) ?? "")} |`;
		size += Buffer.byteLength(row) + 1;
		if (size > maxBytes) break;
		rows.push(row);
	}
	const omitted = report.findings.length - rows.length;
	const more = omitted === 0 ? [] : ["", `${plural(omitted, "more finding")} did not fit in the summary; the step log lists every finding.`];
	return [
		...head,
		...rows,
		...more,
		...tail
	].join("\n");
}
/** The job summary when doctor could not run. */
function failureSummary(message) {
	return [
		"## depcurfew doctor",
		"",
		`depcurfew could not check the repository: ${markdown(message)}`,
		""
	].join("\n");
}

// src/doctor/index.ts
const LEVEL_ORDER = {
	error: 0,
	warning: 1,
	note: 2
};
function byLocation(a, b) {
	if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
	return (a.location.line ?? 0) - (b.location.line ?? 0) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}
/**
* Runs the rules on a repository. When depcurfew.json exists but is invalid, it throws PolicyError, or with
* invalidPolicy: 'report' runs the rules that need no policy and reports the problems as an invalid-policy finding.
*/
function runDoctor(root, options = {}) {
	const tools = options.tools ?? knowledgeBase;
	let policy;
	let invalid = false;
	try {
		policy = loadPolicyIfPresent(root);
	} catch (error) {
		if (!(error instanceof PolicyError) || options.invalidPolicy !== "report") throw error;
		invalid = true;
	}
	const detection = detectProject(root);
	const repository = new Repository(root);
	const findings = [];
	const notices = [];
	const notice = (message, file) => {
		if (!notices.some((item) => item.message === message)) notices.push(file === void 0 ? { message } : {
			message,
			file
		});
	};
	if (invalid) notice(`${POLICY_FILE} is invalid: only the rules that do not need a policy ran`);
	else if (policy === void 0) notice(`no ${POLICY_FILE}: only the rules that do not need a policy ran`);
	const rules = options.rules ?? RULES;
	for (const rule of rules) {
		if (rule.requiresPolicy && policy === void 0) continue;
		rule.check({
			root,
			repository,
			detection,
			policy,
			tools,
			report: ({ level, ...finding }) => findings.push({
				rule: rule.id,
				level: level ?? rule.level,
				...finding
			}),
			notice
		});
	}
	const reported = rules.includes(unreadableConfig);
	for (const warning of repository.warnings) if (!reported || !(warning.code in UNREADABLE_WARNINGS)) notice(warning.message, warning.files[0]);
	return {
		schemaVersion: 1,
		policy: invalid ? "invalid" : policy === void 0 ? "missing" : "valid",
		findings: findings.sort(byLocation),
		notices
	};
}

// src/version.ts
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
let cached;
function getVersion() {
	cached ??= JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
	return cached;
}

// src/action.ts
function input(env, name, fallback) {
	const value = env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`]?.trim();
	return value === void 0 || value === "" ? fallback : value;
}
function enabled(env, name) {
	return input(env, name, "true") !== "false";
}
function summaryLimit() {
	return values$1(environment.githubActions.stepSummary)[0]?.maxBytes ?? 0;
}
/** Report paths relative to the workspace instead of the scanned directory, as code scanning expects. */
function relativeToWorkspace(report, prefix) {
	const move = (file) => prefix === "" ? file : posix.join(prefix, file);
	return {
		...report,
		findings: report.findings.map((finding) => ({
			...finding,
			location: {
				...finding.location,
				file: move(finding.location.file)
			}
		})),
		notices: report.notices.map((notice) => notice.file === void 0 ? notice : {
			...notice,
			file: move(notice.file)
		})
	};
}
/**
* Text from the repository (file and package names, policy errors) goes to the log with workflow commands turned
* off, so a crafted name cannot add annotations or other commands to the run.
*/
function untrusted(text) {
	const commands = values$1(environment.githubActions.stopCommands)[0];
	if (commands === void 0) return text.replaceAll(/^::/gmu, ": :");
	const token = randomUUID();
	return `${commands.stop.replace("{token}", token)}\n${text.endsWith("\n") ? text : `${text}\n`}${commands.resume.replace("{token}", token)}\n`;
}
function inside(root, path) {
	const part = relative(root, path);
	return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
/** The real path of a directory inside the workspace, following symlinks only as far as they stay inside it. */
function scannedDirectory(workspace, input) {
	try {
		const real = realpathSync(resolve(workspace, input));
		return inside(realpathSync(workspace), real) && statSync(real).isDirectory() ? real : void 0;
	} catch {
		return;
	}
}
/**
* Why the SARIF file cannot be written, or undefined. The repository being checked may come from a pull request, so
* no part of the path inside the workspace may be a symlink, which could send the report over a file elsewhere.
*/
function unsafeOutput(workspace, file) {
	if (!inside(workspace, file)) return void 0;
	let current = workspace;
	for (const part of relative(workspace, file).split(sep)) {
		current = resolve(current, part);
		const stats = lstatSync(current, { throwIfNoEntry: false });
		if (stats === void 0) return void 0;
		if (stats.isSymbolicLink()) return `${relative(workspace, current).split(sep).join("/")} is a symlink; depcurfew does not write through symlinks`;
	}
	return lstatSync(file).isFile() ? void 0 : `${relative(workspace, file).split(sep).join("/")} is not a regular file`;
}
function runAction(env, io) {
	const workspace = resolve(env["GITHUB_WORKSPACE"] ?? process.cwd());
	const sarifInput = input(env, "sarif-file", "depcurfew.sarif");
	const sarifFile = resolve(workspace, sarifInput);
	const outputs = {
		"sarif-file": "",
		errors: 0,
		warnings: 0,
		notes: 0,
		failure: ""
	};
	const summary = enabled(env, "job-summary");
	const fail = (message) => {
		outputs.failure = message;
		io.log(untrusted(`depcurfew: ${message}\n`));
		if (summary) io.summary(failureSummary(message));
		return outputs;
	};
	const directory = scannedDirectory(workspace, input(env, "directory", "."));
	if (directory === void 0) return fail(`directory "${input(env, "directory", ".")}" is not a directory inside the workspace`);
	const prefix = relative(realpathSync(workspace), directory).split(sep).join("/");
	let report;
	try {
		report = runDoctor(directory);
	} catch (error) {
		if (!(error instanceof PolicyError)) throw error;
		outputs.failure = [error.message, ...error.issues].join("; ");
		io.log(untrusted(`depcurfew: ${error.text}\n${error.issues.map((issue) => `  ${issue}\n`).join("")}`));
		if (summary) io.summary(failureSummary(outputs.failure));
		return outputs;
	}
	io.log(untrusted(renderText(report, RULES)));
	const moved = relativeToWorkspace(report, prefix);
	if (enabled(env, "annotations")) {
		const annotations = annotationCommands(moved, RULES);
		if (annotations.lines.length > 0) io.log(`${annotations.lines.join("\n")}\n`);
		if (annotations.omitted > 0) io.log(`GitHub shows a limited number of annotations per step; ${annotations.omitted} more ${annotations.omitted === 1 ? "finding is" : "findings are"} in the report above.\n`);
	}
	if (summary) io.summary(jobSummary(moved, RULES, prefix, summaryLimit()));
	const repository = new Repository(workspace);
	const readLine = (file, line) => repository.readText(file)?.split(/\r?\n/u)[line - 1];
	const sarif = `${JSON.stringify(toSarif(moved, RULES, getVersion(), readLine), null, 2)}\n`;
	const shownSarif = inside(workspace, sarifFile) ? relative(workspace, sarifFile).split(sep).join("/") : sarifFile;
	try {
		const unsafe = unsafeOutput(workspace, sarifFile);
		if (unsafe !== void 0) return fail(`cannot write the SARIF file ${sarifInput}: ${unsafe}`);
		const before = lstatSync(sarifFile, { throwIfNoEntry: false }) === void 0 ? null : "";
		mkdirSync(dirname(sarifFile), { recursive: true });
		writeChanges(dirname(sarifFile), [{
			file: basename(sarifFile),
			before,
			after: sarif
		}]);
	} catch (error) {
		return fail(`cannot write the SARIF file ${sarifInput}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const counts = countLevels(report.findings);
	return {
		...outputs,
		"sarif-file": shownSarif,
		errors: counts.error,
		warnings: counts.warning,
		notes: counts.note
	};
}
/** Writes step outputs in the format of the GITHUB_OUTPUT file. */
function formatOutputs(outputs) {
	return Object.entries(outputs).map(([name, value]) => `${name}=${String(value).replaceAll(/[\r\n]+/gu, " ")}\n`).join("");
}
function main(env = process.env) {
	const summaryVariable = values$1(environment.githubActions.stepSummary)[0]?.variable;
	const summaryFile = summaryVariable === void 0 ? void 0 : env[summaryVariable];
	const outputs = runAction(env, {
		log: (text) => process.stdout.write(text),
		summary: (markdown) => {
			if (summaryFile !== void 0 && summaryFile !== "") appendFileSync(summaryFile, markdown);
		}
	});
	const file = env["GITHUB_OUTPUT"];
	if (file !== void 0 && file !== "") appendFileSync(file, formatOutputs(outputs));
}

// src/action-main.ts
try {
	main();
} catch (error) {
	process.stderr.write(`depcurfew: unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
}

export {  };