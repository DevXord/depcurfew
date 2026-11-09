// Lockfile rules. lockfile-forbidden-source: a package from a source depcurfew.json denies. lockfile-install-scripts:
// a package with install scripts that depcurfew.json does not allow, where the lockfile records scripts.
import { posix } from 'node:path';
import { extraOf, isRecord, isSwitch, sinceOf, values } from '../../apply/facts.ts';
import { listing } from '../../apply/requirements.ts';
import { compareVersions, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ScriptPolicy, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { COMPOSER_PREFIX, PYPI_PREFIX } from '../../policy/package-pattern.ts';
import {
  checkedOut,
  checkoutsByPreference,
  COMPOSER_MANIFEST,
  composerManifest,
  declaredRepositories,
  fallbackRemoved,
  hostOf,
  isComposerName,
  listedCheckouts,
  lockedPluginApi,
  pluginDecision,
  preferenceChange,
  preferenceLine,
  sourceHostOf,
  unmatchedRepositories,
  type Checkouts,
} from '../composer.ts';
import { normalizePythonName } from '../../policy/python-names.ts';
import { allowEntries, denyEntries, matchesPattern, type AllowEntry } from '../allow-lists.ts';
import { latestVersion, versionedValue } from '../effective.ts';
import { readLockfiles, type Lockfile, type LockEntry, type Source } from '../lockfiles.ts';
import { requirementsFormatOf } from '../python-lockfiles.ts';
import { readPythonSetting, requirementsLongOptions } from '../python.ts';
import { formatControlAfter, formatControlFacts, MAX_REQUIREMENTS_FILES } from '../../apply/pip-includes.ts';
import { iniValue, readSetting } from '../settings.ts';
import { readRuleSetting } from '../pnpm-config.ts';
import type { Rule, RuleContext } from '../types.ts';
import { hasBuildRecords, showsBuilds } from '../python-lockfiles.ts';
import { hasLockfile } from '../applies.ts';
import { npmInUseSeveral, npmInUseText, npmPlaces, repositoryPin, type NpmInUse } from './bundled-versions.ts';
import { denyFix, knownPackageOf, omittedOptionalText, optionalOmissions, scriptsPurpose, versionNote, type OmitPlace } from '../install-script-packages.ts';

const LABELS = {
  npm: { git: 'a git repository', remoteTarball: 'a tarball URL', file: 'a local tarball', directory: 'a local directory' },
  pypi: { git: 'a git repository', remoteTarball: 'a URL', file: 'a local archive', directory: 'a local directory' },
  packagist: { git: 'a VCS repository', remoteTarball: 'a package repository at a URL', file: 'an artifact repository', directory: 'a path repository' },
  rubygems: { git: 'a git repository', remoteTarball: 'an archive URL', file: 'a local archive', directory: 'a path' },
} as const;

/** Why a Python package is built from source, for messages. */
const BUILT_FROM: Record<Source, string> = {
  registry: 'its index has only a source distribution',
  git: 'it comes from a git repository',
  remoteTarball: 'it is a source archive at a URL',
  file: 'it is a local source archive',
  directory: 'it is a local directory',
  workspace: 'it is part of the workspace',
  unknown: 'its source is not recognized',
};

function eachLockfile(context: RuleContext, rule: string, visit: (lockfile: Lockfile, tool: ToolKnowledge) => void): void {
  const workspaces = context.detection.workspaces?.packages ?? [];
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
    const tool = context.tools.find((entry) => entry.id === manager.id);
    if (tool === undefined) continue;
    for (const result of readLockfiles(context.repository, manager, tool, workspaces, context.tools)) {
      if (result.ok) visit(result.lockfile, tool);
      // An unreadable lockfile is an error of unreadable-config.
      else if (!result.unreadable) context.notice(`${rule} could not check ${result.file}: ${result.reason}`, result.file);
    }
  }
}

function location(lockfile: Lockfile, entry: LockEntry): { file: string; line?: number } {
  const line = lockfile.lineOf(entry);
  return line === undefined ? { file: lockfile.file } : { file: lockfile.file, line };
}

export const lockfileForbiddenSource: Rule = {
  id: 'lockfile-forbidden-source',
  checks: 'The lockfile installs no package from a source depcurfew.json denies',
  summary: 'The lockfile installs a package from a source depcurfew.json denies.',
  description:
    'A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say. For Composer, whose lockfile does not name the repository of a package, packages of a path or artifact repository are told by their dist, those of a VCS or package repository by the repositories of composer.json; a package without a usable dist, or one that config.preferred-install makes Composer check out, is a VCS checkout. Warnings: archives from a host that neither the archives of Packagist.org (GitHub, GitLab, Bitbucket, Codeberg) nor a repository of composer.json use (with the archive host depcurfew knows for one, such as downloads.wordpress.org for WPackagist), one per host, such an archive next to a source on another host, and a repository of a denied kind that no package of composer.lock comes from.',
  help: 'Replace the dependency with a registry version, or allow that source in depcurfew.json.',
  level: 'error',
  requiresPolicy: true,
  applies: hasLockfile,
  check(context) {
    const sources = context.policy?.sources;
    if (sources === undefined) return;
    const denies = Object.values(sources).includes('deny');
    eachLockfile(context, 'lockfile-forbidden-source', (lockfile, tool) => {
      // Composer: the packages from archive hosts depcurfew does not recognize, by host, for one warning each (D-141).
      const unknownHosts = new Map<string, LockEntry[]>();
      for (const entry of lockfile.entries) {
        if (entry.source === 'unknown' && denies && tool.id === 'composer') {
          const host = archiveHost(entry.spec);
          unknownHosts.set(host, [...(unknownHosts.get(host) ?? []), entry]);
          continue;
        }
        if (entry.source === 'unknown' && denies) {
          // Fail closed: a source depcurfew cannot recognize may be one the policy denies.
          context.report({
            level: 'warning',
            location: location(lockfile, entry),
            message: `${lockfile.file} installs ${entry.name} from a source depcurfew does not recognize (${shownSpec(entry.spec) || 'no source given'}); it may be one ${POLICY_FILE} denies`,
            // Composer: an archive from a host that neither Packagist.org's archives nor a declared repository use (D-134).
            fix:
              tool.id === 'composer'
                ? `Check where ${entry.name} comes from: if a Composer repository serves it, declare that repository in ${COMPOSER_MANIFEST}; otherwise lock it again from Packagist with composer update`
                : `Check where ${entry.name} comes from, and regenerate the lockfile with the package manager if the entry is damaged`,
          });
          continue;
        }
        // Composer: an archive of Packagist.org's hosts next to a source on another host, which Packagist.org never
        // writes; Composer installs from that source in some cases (decision D-136).
        const other = entry.otherSource;
        if (other !== undefined && sources.git === 'deny') {
          const expected = sourceHostOf(tool, other.distHost);
          context.report({
            level: 'warning',
            location: location(lockfile, entry),
            message: `${lockfile.file} gives ${entry.name} an archive from ${other.distHost} but a VCS source on another host (${shownSpec(other.spec)}), which ${POLICY_FILE} denies; for an archive from ${other.distHost} the source is on ${expected}, so the entry was edited, and Composer installs from that source with --prefer-source, with preferred-install "source" in COMPOSER_HOME/config.json, and before Composer ${fallbackRemoved(tool)} when the archive cannot be downloaded`,
            fix: `Find out who changed this entry of ${lockfile.file}, then lock ${entry.name} again with composer update ${entry.name}`,
          });
        }
        if (entry.source !== 'git' && entry.source !== 'remoteTarball' && entry.source !== 'file' && entry.source !== 'directory') continue;
        if (sources[entry.source] !== 'deny') continue;
        // Composer: reported once for the entry of config.preferred-install that causes it, below (decision D-138).
        if (entry.preferredInstall !== undefined) continue;
        context.report({
          location: location(lockfile, entry),
          message: `${lockfile.file} installs ${entry.unnamed === true ? 'a package' : entry.name} from ${LABELS[ecosystemOfTool(tool)][entry.source]} (${shownSpec(entry.spec)}), which ${POLICY_FILE} denies${entry.why === undefined ? '' : `: ${entry.why}`}`,
          fix: entry.registrySpec === true ? registrySpecFix(lockfile, entry) : `Use a registry version ${entry.unnamed === true ? 'instead' : `of ${entry.name}`}, or set sources.${entry.source} to "allow" in ${POLICY_FILE}`,
        });
      }
      for (const [host, entries] of unknownHosts) reportUnknownArchives(context, tool, lockfile, host, entries);
      if (sources.git === 'deny') for (const group of checkoutsByPreference(lockfile.entries)) reportPreferredInstall(context, lockfile, group);
      if (tool.id === 'composer') reportComposerRepositories(context, tool, lockfile, sources);
    });
  },
};

/**
 * What to do about a tarball URL of package-lock.json that package.json asks for by version (decision D-168): npm 12
 * installs it as a registry package only from the registry it is set to use for the package (npm
 * extra.registryHostTarballs), so the fix says how to set that registry, and never to allow tarball URLs, which would
 * let any URL in.
 */
function registrySpecFix(lockfile: Lockfile, entry: LockEntry): string {
  const scope = entry.name.startsWith('@') ? entry.name.slice(0, entry.name.indexOf('/')) : undefined;
  const directory = posix.dirname(lockfile.file);
  const npmrc = directory === '.' ? '.npmrc' : `${directory}/.npmrc`;
  return `package.json asks for ${entry.name} by version, not by URL: if it comes from a private registry, set ${scope === undefined ? 'registry' : `${scope}:registry`}= to the URL of that registry in the ${npmrc} next to ${posix.basename(lockfile.file)}, as npm installs the tarballs of the registry it is set to use as registry packages; otherwise lock ${entry.name} again from the registry with npm install`;
}

/** The host of the archive of a composer.lock entry from its spec ("zip https://host/…"), or "" when it names none. */
function archiveHost(spec: string): string {
  const url = spec.split(/\s+/u).find((word) => /^[a-z][a-z0-9+.-]*:\/\//iu.test(word));
  return url === undefined ? '' : hostOf(url);
}

/**
 * Composer: the packages of composer.lock whose archives come from one host that neither Packagist.org's archives nor a
 * repository of composer.json (with the archive hosts the knowledge base knows for it) use (decisions D-134 and D-141):
 * one warning per host, at the first of them, naming the packages with their lines. composer.lock does not record the
 * repository of a package, so when composer.json declares Composer repositories, the message names them and the fix
 * says how to check that one of them serves these archives; the warning stays, since a host depcurfew cannot tie to a
 * repository may be one depcurfew.json denies (fail closed).
 */
function reportUnknownArchives(context: RuleContext, tool: ToolKnowledge, lockfile: Lockfile, host: string, entries: readonly LockEntry[]): void {
  const lines = (entry: LockEntry) => lockfile.lineOf(entry);
  const first = entries.map(lines).find((line) => line !== undefined);
  const one = entries.length === 1;
  const registries = declaredRepositories(context.repository, tool).filter((repository) => repository.kind === 'registry' && repository.url !== undefined);
  const from = host === '' ? `from ${one ? 'a source' : 'sources'} depcurfew does not recognize (${shownSpec(entries[0]?.spec ?? '') || 'no source given'})` : `from ${one ? `an archive on ${host} (${shownSpec(entries[0]?.spec ?? '')})` : `archives on ${host}`}, a host depcurfew does not recognize`;
  const declared = registries.map((repository) => `${repository.url ?? ''} (line ${repository.line})`);
  const repositories =
    registries.length === 0
      ? ''
      : `; ${COMPOSER_MANIFEST} declares the Composer ${registries.length === 1 ? 'repository' : 'repositories'} ${listing(declared)}, which may keep ${registries.length === 1 ? 'its' : 'their'} archives there, but ${lockfile.file} does not say which repository a package comes from`;
  const names = one ? (entries[0]?.name ?? '') : 'these packages';
  context.report({
    level: 'warning',
    location: first === undefined ? { file: lockfile.file } : { file: lockfile.file, line: first },
    message: `${lockfile.file} installs ${one ? (entries[0]?.name ?? '') : `${entries.length} packages`} ${from}, so ${one ? 'it' : 'they'} may come from a source ${POLICY_FILE} denies${one ? '' : `: ${listedCheckouts(entries, lines)}`}${repositories}`,
    fix:
      registries.length === 0
        ? `Check where ${names} ${one ? 'comes' : 'come'} from: if a Composer repository serves ${one ? 'it' : 'them'}, declare that repository in ${COMPOSER_MANIFEST}; otherwise lock ${one ? 'it' : 'them'} again from Packagist with composer update`
        : `Check that ${registries.length === 1 ? 'this repository serves' : 'one of these repositories serves'} ${names} with ${host === '' ? 'this source' : `archives on ${host}`} (composer show --all ${one ? (entries[0]?.name ?? '') : '<package>'} names the dist URL Composer gets); depcurfew cannot tie ${host === '' ? 'it' : host} to a repository, so this warning stays while ${lockfile.file} installs from it. If the archives come from elsewhere, lock ${one ? 'the package' : 'the packages'} again with composer update`,
  });
}

/**
 * Composer: one entry of config.preferred-install in composer.json that makes Composer check packages of composer.lock
 * out of their VCS repositories, which the policy denies (decision D-138): one finding at that entry, naming the
 * packages with their lines in the lockfile, and a fix in composer.json; the packages are registry versions.
 */
function reportPreferredInstall(context: RuleContext, lockfile: Lockfile, { preference, entries }: Checkouts): void {
  const line = preferenceLine(context.repository.readText(COMPOSER_MANIFEST), preference);
  context.report({
    location: line === undefined ? { file: COMPOSER_MANIFEST } : { file: COMPOSER_MANIFEST, line },
    message: `${preference.why}, so Composer installs ${checkedOut(entries.length, lockfile.file)}, which ${POLICY_FILE} denies: ${listedCheckouts(entries, (entry) => lockfile.lineOf(entry))}`,
    fix: `${preferenceChange(preference)}; or set sources.git to "allow" in ${POLICY_FILE}`,
  });
}

/**
 * Composer: a repository of composer.json of a kind the policy denies whose packages depcurfew cannot find in
 * composer.lock (a VCS repository at another URL than the lock records, a path or artifact repository not locked yet).
 * Composer installs from it on the next update, so it is reported at its declaration, as a warning (fail closed).
 */
function reportComposerRepositories(context: RuleContext, tool: ToolKnowledge, lockfile: Lockfile, sources: NonNullable<NonNullable<RuleContext['policy']>['sources']>): void {
  for (const repository of unmatchedRepositories(tool, declaredRepositories(context.repository, tool), lockfile.entries)) {
    const kind = repository.kind;
    if (kind !== 'git' && kind !== 'remoteTarball' && kind !== 'file' && kind !== 'directory') continue;
    if (sources[kind] !== 'deny') continue;
    const what = repository.url === undefined ? `a ${repository.type} repository` : `the ${repository.type} repository ${repository.url}`;
    context.report({
      level: 'warning',
      location: { file: COMPOSER_MANIFEST, line: repository.line },
      message: `${COMPOSER_MANIFEST} declares ${what} (repositories[${String(repository.key)}]), ${LABELS.packagist[kind]}, which ${POLICY_FILE} denies (sources.${kind}); ${lockfile.file} shows no package from it that depcurfew can tell, so Composer may install from it on the next update`,
      fix: `Remove the repository from ${COMPOSER_MANIFEST} and require the packages from Packagist, or set sources.${kind} to "allow" in ${POLICY_FILE}`,
    });
  }
}

/**
 * Composer plugins (type composer-plugin) are the dependency code Composer runs. allow-plugins in composer.json decides
 * which may run (the first key that matches, true or false; true or false for the whole setting): one it allows that the
 * policy does not is an error; one it does not list makes Composer ask, or fail without a terminal (a warning).
 */
function reportComposerPlugins(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, allow: readonly string[], deny: readonly string[]): void {
  const manifest = composerManifest(context.repository);
  const lock = { tool, pluginApi: lockedPluginApi(context.repository, tool, lockfile.file)?.version };
  // composer update --lock writes composer.lock again without updating packages (extra.contentHash).
  const relock = extraOf(tool, 'contentHash', (value): value is { command: string } => isRecord(value) && typeof value['command'] === 'string').command;
  for (const entry of lockfile.entries.filter((item) => item.installScript === true)) {
    if (allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
    const isDenied = deny.some((pattern) => matchesPattern(entry.name, pattern));
    const decision = pluginDecision(manifest, entry.name, lock);
    const at = location(lockfile, entry);
    // Only a Composer package name goes into a fix; another one is told by its line (decision D-134).
    const named = isComposerName(entry.name);
    const plugin = named ? entry.name : `the plugin at ${at.line === undefined ? '' : `line ${at.line} of `}${lockfile.file}`;
    const policyName = named ? `${COMPOSER_PREFIX}${entry.name}` : undefined;
    const unnamed = `its name ${JSON.stringify(entry.name)} is not a Composer package name (lowercase vendor/name), so ${POLICY_FILE} cannot list it; remove the entry and lock again with composer update`;
    if (decision.legacy !== undefined) {
      const api = decision.legacy.pluginApi === undefined ? 'has no plugin-api-version' : `has plugin-api-version ${decision.legacy.pluginApi}`;
      context.report({
        level: 'error',
        location: at,
        message: `${entry.name} is a Composer plugin, whose code runs during Composer commands, and ${lockfile.file} ${api}, which Composer takes for a lock file from before allow-plugins (Composer ${decision.legacy.below}): with config.allow-plugins in ${COMPOSER_MANIFEST} empty or missing, a Composer older than ${decision.legacy.allowsAllUntil} runs every plugin of it without asking, but ${POLICY_FILE} ${isDenied ? 'denies it' : 'does not allow it'}`,
        fix: `Lock again with a current Composer (${relock}), which records plugin-api-version, and commit ${lockfile.file}; ${
          policyName === undefined
            ? unnamed
            : isDenied
              ? 'depcurfew apply then writes the denial into config.allow-plugins'
              : `review the plugin and add ${policyName} to installScripts.allow or installScripts.deny in ${POLICY_FILE}, and run depcurfew apply`
        }`,
      });
      continue;
    }
    const by = decision.key === undefined ? 'config.allow-plugins' : `"${decision.key}" in config.allow-plugins`;
    if (decision.allowed === true) {
      if (policyName === undefined) {
        context.report({
          level: 'error',
          location: at,
          message: `${entry.name} is a Composer plugin, whose code runs during Composer commands, and ${by} in ${COMPOSER_MANIFEST} lets Composer run it, but ${POLICY_FILE} does not allow it`,
          fix: `Check ${plugin}: ${unnamed}, and narrow ${by} in ${COMPOSER_MANIFEST} to the plugins that may run`,
        });
        continue;
      }
      // Composer takes the first key that matches, so a denial goes before a pattern that allows the plugin.
      const block =
        decision.key === undefined
          ? `replace true in config.allow-plugins of ${COMPOSER_MANIFEST} with the plugins that may run`
          : decision.key.toLowerCase() === entry.name
            ? `set it to false in config.allow-plugins of ${COMPOSER_MANIFEST}`
            : `put "${entry.name}": false before "${decision.key}" in config.allow-plugins of ${COMPOSER_MANIFEST}, because Composer takes the first key that matches`;
      context.report({
        level: 'error',
        location: at,
        message: `${entry.name} is a Composer plugin, whose code runs during Composer commands, and ${by} in ${COMPOSER_MANIFEST} lets Composer run it, but ${POLICY_FILE} ${isDenied ? 'denies it' : 'does not allow it'}`,
        fix: isDenied
          ? `${block.charAt(0).toUpperCase()}${block.slice(1)}, or move ${policyName} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing the plugin`
          : `Review the plugin and add ${policyName} to installScripts.allow in ${POLICY_FILE}, or ${block}`,
      });
      continue;
    }
    if (decision.allowed === false || isDenied) continue;
    // Without a terminal Composer stops at a plugin allow-plugins does not list, or skips it when it is optional.
    const withoutTerminal = entry.optional === true ? 'a run without a terminal (CI) skips it, since it declares extra.plugin-optional' : 'a run without a terminal (CI) fails';
    context.report({
      level: 'warning',
      location: at,
      message: `${entry.name} is a Composer plugin that config.allow-plugins in ${COMPOSER_MANIFEST} does not list, so Composer asks whether to run it, and ${withoutTerminal}; ${POLICY_FILE} does not allow it`,
      fix:
        policyName === undefined
          ? `Check ${plugin}: ${unnamed}`
          : `Review the plugin: add ${policyName} to installScripts.allow in ${POLICY_FILE} if the project needs it, or to installScripts.deny if it works without it, then run depcurfew apply`,
    });
  }
}

/** A lockfile spec for messages, without Yarn's locator parameters (::hash=…&locator=…) and repeated local paths. */
function shownSpec(spec: string): string {
  const text = spec.split('::')[0] ?? spec;
  const hash = text.indexOf('#');
  return /^(?:file|portal|link):/u.test(text) && hash !== -1 ? text.slice(0, hash) : text;
}

/**
 * The versions of the tool the directory runs, each with where it comes from: for npm every place npm runs, as apply
 * sees them (npmPlaces, decisions D-105 and D-109); for the other tools the version they pin. The latest known version
 * when none is declared.
 */
function versionsInUse(context: RuleContext, tool: ToolKnowledge): { version: Version | undefined; place?: NpmInUse }[] {
  const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
  if (manager === undefined) return [{ version: latestVersion(tool) }];
  if (tool.id !== 'npm') return [{ version: repositoryPin(manager) ?? pinnedVersion(manager) ?? latestVersion(tool) }];
  const places = npmPlaces(context).flatMap((place): { version: Version | undefined; place: NpmInUse }[] =>
    place.unknown !== undefined ? [{ version: undefined, place }] : place.versions.map((version) => ({ version, place })),
  );
  return places.length > 0 ? places : [{ version: pinnedVersion(manager) ?? latestVersion(tool) }];
}

/**
 * The first npm in use (or the version of another tool) that runs dependency install scripts no list covers: one that
 * runs them all, or, unless strict-allow-scripts is set (`strict`), one that runs them with a notice. `text` names the
 * versions of that place that run them ("npm 11.16.0 (with Node.js 24.18.0 in Dockerfile)"), absent without a place.
 */
function runsScripts(context: RuleContext, tool: ToolKnowledge, strict: boolean, counts: (version: Version | undefined) => boolean = () => true): { text?: string; several?: boolean; unknown?: true } | undefined {
  const runs = (version: Version | undefined) =>
    counts(version) &&
    evidenceOf(tool.installScripts.defaultPolicy).some((evidence) => {
      const policy: ScriptPolicy | undefined = versionedValue(evidence.value, version);
      return policy === 'run' || (policy === 'run-with-warning' && !strict);
    });
  // An npm depcurfew cannot tell counts as one that runs them (decision D-111).
  const found = versionsInUse(context, tool).find((entry) => entry.place?.unknown !== undefined || runs(entry.version));
  if (found === undefined) return undefined;
  const place = found.place;
  if (place?.unknown !== undefined) return { text: npmInUseText(place), unknown: true };
  const versions = place?.versions.filter(runs) ?? [];
  return place === undefined ? {} : { text: npmInUseText(place, versions), several: npmInUseSeveral(place, versions) };
}

/**
 * How the repository keeps dependency scripts from running with the tool's own switch: ignore-scripts in .npmrc turns
 * them all off (`all`), strict-allow-scripts makes the install fail on scripts that are not allowed, while the
 * packages of the allow-list still run theirs.
 */
function scriptsDisabledBy(context: RuleContext, tool: ToolKnowledge): { reason: string; all: boolean; setting: string } | undefined {
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (file === undefined) return undefined;
  const fact = tool.installScripts.disableAll;
  const value = fact.status === 'verified' ? fact.value : undefined;
  const match = typeof value === 'string' ? /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value) : null;
  if (match !== null) {
    const [, key = '', expected] = match;
    const found = readRuleSetting(context, tool, file, key);
    if (found !== undefined && found.value === (expected === undefined ? true : iniValue(expected))) return { reason: `${key} in ${found.file} turns them off`, all: true, setting: `${key} in ${found.file}` };
  }
  const strict = tool.extra?.['strictAllowScripts'] === undefined ? undefined : extraOf(tool, 'strictAllowScripts', isSwitch);
  if (strict !== undefined && readSetting(context.repository, file, strict.setting)?.value === strict.value) {
    return { reason: `${strict.setting} in ${file} stops the install until they are allowed`, all: false, setting: `${strict.setting} in ${file}` };
  }
  return undefined;
}

/** formatControlAfter of each requirements file, once per repository: every lockfile of its tree asks for it (decision D-191). */
const formatControls = new WeakMap<RuleContext['repository'], Map<string, ReturnType<typeof formatControlAfter>>>();

function formatControlOf(context: RuleContext, root: string, reading: Parameters<typeof formatControlAfter>[2]): ReturnType<typeof formatControlAfter> {
  let known = formatControls.get(context.repository);
  if (known === undefined) {
    known = new Map();
    formatControls.set(context.repository, known);
  }
  let result = known.get(root);
  if (result === undefined) {
    result = formatControlAfter((file) => context.repository.readText(file), root, reading, (file) => context.repository.realPath(file) ?? file);
    if (result.stopped) {
      const { onlyBinary, all } = reading.facts;
      context.repository.warn('too-many-includes', `${root} includes more than ${MAX_REQUIREMENTS_FILES} requirements files, or the same ones so many times over, that depcurfew stops following them, so it cannot tell whether ${onlyBinary}=${all} holds there`, [root]);
    }
    known.set(root, result);
  }
  return result;
}

/**
 * Whether the repository forbids building Python packages from source with the tool's switch (no-build in uv,
 * installer.only-binary in Poetry, --only-binary=:all: in a requirements file for pip), and where.
 */
function buildsForbiddenBy(context: RuleContext, tool: ToolKnowledge, lockfile: Lockfile): string | undefined {
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  if (build === undefined) return undefined;
  if (tool.id === 'pip') {
    const format = requirementsFormatOf(tool);
    const facts = formatControlFacts(tool);
    // The options of the requirements file pip is given, and of the files it includes, apply to the whole install, in
    // the order pip reads them: a later --no-binary=:all: or --only-binary=:none: undoes the switch (decision D-167).
    const files = lockfile.optionFiles ?? [];
    const roots = files.filter((file) => context.detection.packageManagers.some((manager) => manager.id === 'pip' && manager.configFiles.includes(file)));
    if (facts === undefined || roots.length === 0) return undefined;
    const reading = { facts, format, longOptions: requirementsLongOptions(format) };
    const results = roots.map((root) => formatControlOf(context, root, reading));
    const found = results[0]?.from;
    return found === undefined || !results.every((result) => result.onlyAll) ? undefined : `${build.setting}=${String(build.value)} in ${found} forbids building`;
  }
  const found = readPythonSetting(context.repository, tool, build.setting);
  return found !== undefined && switchIsOn(found.value, build.value) ? `${build.setting} in ${found.file} forbids building` : undefined;
}

/**
 * Whether a configured value turns the build switch on. A list switch (Poetry's [":all:"]) is also on when written as
 * a comma-separated string or as true, which Poetry reads as the same thing.
 */
function switchIsOn(value: unknown, wanted: unknown): boolean {
  if (!Array.isArray(wanted)) return value === wanted;
  const items = value === true ? wanted : typeof value === 'string' ? value.split(',').map((item) => item.trim()) : Array.isArray(value) ? value : [];
  return wanted.every((item) => items.includes(item));
}

/** Dependencies a tool builds whatever its settings say, when its build switch does not cover their source. */
const ALWAYS_BUILT: Record<Source, string> = {
  registry: 'source distributions from an index',
  git: 'git dependencies',
  remoteTarball: 'source archives from a URL',
  file: 'local source archives',
  directory: 'local directory dependencies',
  workspace: 'workspace members',
  unknown: 'dependencies from this source',
};

function reportPythonBuilds(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, allow: readonly string[], deny: readonly string[]): void {
  const forbiddenBy = buildsForbiddenBy(context, tool, lockfile);
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  const covers = build?.covers ?? [];
  const patterns = allow.map(normalizePythonName);
  const denied = deny.map(normalizePythonName);
  for (const entry of lockfile.entries) {
    if (entry.installScript !== true || entry.source === 'workspace') continue;
    if (entry.unnamed !== true && patterns.some((pattern) => matchesPattern(entry.name, pattern))) continue;
    const stopped = forbiddenBy !== undefined && covers.includes(entry.source);
    if (entry.unnamed !== true && denied.some((pattern) => matchesPattern(entry.name, pattern))) {
      // Denied on purpose: never built from source. Where the tool still builds it, the policy is broken; where it
      // refuses, installing fails, which the owner should still see. Every tool can stop building source
      // distributions from an index (Pipenv through PIP_ONLY_BINARY), but other sources only where the switch covers them.
      const stoppable = entry.source === 'registry' || covers.includes(entry.source);
      const label = `"${PYPI_PREFIX}${entry.name}"`;
      context.report({
        level: stopped ? 'warning' : 'error',
        location: location(lockfile, entry),
        message: stopped
          ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy} and ${POLICY_FILE} denies it, so installing it fails`
          : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} denies it${stoppable ? '' : `, and ${tool.name} builds ${ALWAYS_BUILT[entry.source]} whatever its settings say`}`,
        fix: stopped
          ? `Replace ${entry.name} with a package that has wheels, or remove ${label} from installScripts.deny and add it to installScripts.allow after reviewing it`
          : stoppable
            ? `Make ${tool.name} stop building it (run depcurfew apply and follow its warnings), or replace the package`
            : `Replace ${entry.name} with a registry release that has wheels, or move ${label} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing it`,
      });
      continue;
    }
    const fix =
      entry.unnamed === true
        ? `Give the requirement a package name (name @ ${entry.spec}) so that it can be allowed with "${PYPI_PREFIX}name" in installScripts.allow in ${POLICY_FILE}, or remove it`
        : `Review ${entry.name} and add "${PYPI_PREFIX}${entry.name}" to installScripts.allow in ${POLICY_FILE} (it is then always built from source), or replace the package`;
    context.report({
      level: stopped ? 'warning' : 'error',
      location: location(lockfile, entry),
      message: stopped
        ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy}, so installing it fails until it is allowed`
        : forbiddenBy === undefined
          ? `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} does not allow it`
          : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code: ${forbiddenBy} only for packages from an index, and ${POLICY_FILE} does not allow it`,
      fix,
    });
  }
}

export const lockfileInstallScripts: Rule = {
  id: 'lockfile-install-scripts',
  checks: 'The lockfile has no install scripts or source builds that depcurfew.json does not allow',
  summary: 'The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.',
  description:
    'Install scripts run arbitrary code during installation, and so do building a Python package from source (a source distribution, a git repository or a local directory) and loading a Composer plugin. Where the package manager runs them by default, or its own allow-list lets them run, they run code the policy does not allow; where it blocks them, a package may not work. A package in installScripts.deny works without its scripts, so it is reported only while the package manager in use still runs them (or builds it from source), or when it cannot be installed (a Python package without wheels, esbuild without optional dependencies). npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile and composer.lock records plugins; uv.lock, poetry.lock, pdm.lock and pylock.toml show which Python packages have no wheel. pip requirements files and Pipfile.lock list hashes only, so the check does not apply to their packages from an index, only to requirements from a repository, a URL or a local path.',
  help: 'Remove or replace the package, or review it and add it to installScripts.allow in depcurfew.json, or to installScripts.deny when it works without its scripts (Python packages with the prefix pypi:, Composer plugins with composer:). For a package in installScripts.deny, make the package manager block its scripts (depcurfew apply records the denial where the tool can). For packages whose scripts depcurfew knows (esbuild, fsevents, lefthook), from a registry, the finding names the fix: installScripts.deny, and for lefthook running lefthook install after each clone, as its documentation says for projects that do not use its postinstall script.',
  level: 'error',
  requiresPolicy: true,
  // pip requirements files and Pipfile.lock list hashes only, so they cannot show a package without wheels (D-107).
  applies: (scope) => hasBuildRecords(scope.detection.packageManagers, scope.tools),
  check(context) {
    const policy = context.policy;
    if (policy?.installScripts?.default !== 'deny') return;
    eachLockfile(context, 'lockfile-install-scripts', (lockfile, tool) => {
      const view = policyFor(policy, ecosystemOfTool(tool)).installScripts;
      const allow = view?.allow ?? [];
      const deny = view?.deny ?? [];
      if (ecosystemOfTool(tool) === 'packagist') {
        reportComposerPlugins(context, lockfile, tool, allow, deny);
        return;
      }
      if (ecosystemOfTool(tool) === 'pypi') {
        reportPythonBuilds(context, lockfile, tool, allow, deny);
        if (!showsBuilds(tool, lockfile.file, context.tools) && lockfile.entries.some((entry) => entry.source === 'registry' && entry.installScript === undefined)) {
          context.notice(
            `lockfile-install-scripts cannot tell from ${lockfile.file} which packages from the index are built from source: it lists no wheels or source distributions; depcurfew check pypi:<name> shows whether a package has wheels`,
            lockfile.file,
          );
        }
        return;
      }
      if (!lockfile.recordsScripts) {
        context.notice(`lockfile-install-scripts could not check ${lockfile.file}: ${tool.name} does not record install scripts in it`, lockfile.file);
        return;
      }
      const flagged = lockfile.entries.filter((entry) => entry.installScript === true);
      if (flagged.length === 0 && tool.id === 'bun') {
        context.notice(`${lockfile.file} marks no package with install scripts; Bun records them only since 1.4.4, so an older lockfile may hide some`, lockfile.file);
      }
      const disabledBy = scriptsDisabledBy(context, tool);
      // strict-allow-scripts does nothing in an npm that does not know it, so such an npm in use still runs them.
      const runner = disabledBy?.all === true ? undefined : runsScripts(context, tool, disabledBy !== undefined);
      const running = runner !== undefined;
      // "npm 11.16.0 (with Node.js 24.18.0 in Dockerfile) runs them": the npm in use that does (decision D-109).
      const runs = runner?.text === undefined ? `${tool.name} runs them by default` : `${runner.text} ${runner.unknown === true ? 'may run' : runner.several === true ? 'run' : 'runs'} them`;
      const lists = ownLists(context, tool);
      // Where npm leaves out optional dependencies, which a denied package that takes its binary from one needs (D-127).
      let omissions: OmitPlace[] | undefined;
      const omitted = () => (omissions ??= tool.id === 'npm' ? optionalOmissions(context.repository, context.detection, tool) : []);
      for (const entry of flagged) {
        if (allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
        const isDenied = deny.some((pattern) => matchesPattern(entry.name, pattern));
        // npm and Deno let a denial win over an allow entry of the same package; a name-only denial covers every version.
        const blockedBy = lists.denied.find((item) => item.package === entry.name && item.name === item.package);
        const blocked = blockedBy !== undefined;
        const lets = disabledBy?.all === true || blocked ? undefined : lists.allowed.find((item) => item.package === entry.name);
        if (lets !== undefined) {
          context.report({
            level: 'error',
            location: location(lockfile, entry),
            message: `${entry.name} has install scripts, and ${lets.setting} in ${lets.file} lets ${tool.name} run them, but ${POLICY_FILE} ${isDenied ? 'denies them' : 'does not allow it'}`,
            fix: isDenied
              ? `Remove ${lets.name} from ${lets.setting} in ${lets.file}, or move ${entry.name} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing its scripts`
              : `Remove ${lets.name} from ${lets.setting} in ${lets.file}, or review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}`,
          });
          continue;
        }
        if (isDenied) {
          // Reviewed and blocked on purpose: nothing to report while the tool does not run its scripts, which includes a
          // denial the tool records (npm 11.16+ skips a package set to false in allowScripts, also without strict-allow-scripts).
          // A known package that takes its binary from an optional dependency then needs that dependency (decision D-127).
          // A recorded denial holds only where every npm in use reads it: one older than the denial list runs the scripts
          // anyway (decision D-141).
          const ignoring = running && blockedBy !== undefined ? runsScripts(context, tool, disabledBy !== undefined, (version) => !lists.readsDenial(version)) : undefined;
          if (ignoring !== undefined && blockedBy !== undefined) {
            const npm = ignoring.text === undefined ? `${tool.name}` : ignoring.text;
            context.report({
              level: 'error',
              location: location(lockfile, entry),
              message: `${entry.name} has install scripts and ${npm} ${ignoring.unknown === true ? 'may run' : ignoring.several === true ? 'run' : 'runs'} them, because ${tool.name} before ${lists.denialSince ?? ''} does not read the denial in ${blockedBy.setting} in ${blockedBy.file}; ${POLICY_FILE} denies them`,
              fix: `Use ${tool.name} ${lists.denialSince ?? ''} or later wherever the project installs, or make ${tool.name} stop running dependency install scripts there (run depcurfew apply and follow its warnings)`,
            });
            continue;
          }
          if (!running || blocked) {
            const known = knownPackageOf(entry);
            if (known?.needsOptionalDependencies !== true) continue;
            for (const place of omitted()) context.report({ level: 'warning', location: place.location, ...omittedOptionalText(known, place) });
            continue;
          }
          context.report({
            level: 'error',
            location: location(lockfile, entry),
            message: `${entry.name} has install scripts and ${runs}, but ${POLICY_FILE} denies them`,
            fix: `Make ${tool.name} stop running dependency install scripts (run depcurfew apply and follow its warnings), or replace the package`,
          });
          continue;
        }
        // A package whose scripts depcurfew knows gets its own fix: deny it, and for a project task do that task as the
        // package documents it (decisions D-127 and D-135); only for that package from a registry.
        const known = knownPackageOf(entry);
        const why = known === undefined ? 'the package may need them' : `${scriptsPurpose(known)}${versionNote(known, entry.version)}`;
        const knownFix = known === undefined ? undefined : denyFix(known, tool);
        context.report({
          level: running ? 'error' : 'warning',
          location: location(lockfile, entry),
          message: running
            ? `${entry.name} has install scripts and ${runs}, but ${POLICY_FILE} does not allow it`
            : disabledBy === undefined
              ? `${entry.name} has install scripts that ${tool.name} will not run because ${POLICY_FILE} does not allow it; ${why}`
              : `${entry.name} has install scripts that ${tool.name} will not run because ${disabledBy.reason}; ${why}`,
          fix: running
            ? knownFix === undefined
              ? `Review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}, or replace the package`
              : `${knownFix}. Then make ${tool.name} stop running dependency install scripts (run depcurfew apply and follow its warnings)`
            : (knownFix ?? `Review its scripts: add ${entry.name} to installScripts.allow in ${POLICY_FILE} if it needs them, or to installScripts.deny if it works without them; otherwise replace the package`),
        });
      }
    });
  },
};

/**
 * The tool's own lists as the version in use reads them: allow entries from the version that has an allow-list,
 * denials (extra.denyList) from the version that records them; empty for older versions.
 */
function ownLists(context: RuleContext, tool: ToolKnowledge): { allowed: AllowEntry[]; denied: AllowEntry[]; denialSince?: string; readsDenial: (version: Version | undefined) => boolean } {
  const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
  if (manager === undefined) return { allowed: [], denied: [], readsDenial: () => false };
  const version = pinnedVersion(manager) ?? latestVersion(tool);
  const options = { tool, ...(version === undefined ? {} : { version }) };
  const reads = (since: string | undefined) => {
    const required = since === undefined ? undefined : parseVersion(since);
    return required !== undefined && (version === undefined || compareVersions(version, required) >= 0);
  };
  const denial = tool.extra?.['denyList'] === undefined ? undefined : evidenceOf(tool.extra['denyList'])[0]?.value;
  const denialSince = isRecord(denial) && typeof denial['since'] === 'string' ? denial['since'] : undefined;
  // Whether a version in use reads the denials (an unknown version does not count as one that does).
  const required = denialSince === undefined ? undefined : parseVersion(denialSince);
  const readsDenial = (inUse: Version | undefined) => required !== undefined && inUse !== undefined && compareVersions(inUse, required) >= 0;
  return {
    allowed: reads(sinceOf(tool.installScripts.allowList.availableSince)) ? allowEntries(context.repository, manager.id, manager.configFiles, options) : [],
    denied: reads(denialSince) ? denyEntries(context.repository, manager.id, manager.configFiles, options) : [],
    ...(denialSince === undefined ? {} : { denialSince }),
    readsDenial,
  };
}
