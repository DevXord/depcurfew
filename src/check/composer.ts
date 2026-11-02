// `depcurfew check composer:<package>`: the Composer side of check (decision D-133). A package is looked up in the v2
// metadata of Packagist.org: whether it exists, the version its constraint makes Composer pick (the highest tagged
// release the constraint and the stability allow, at the minimum-stability of the root composer.json, stable without
// it, unless the constraint says otherwise, the most stable first with prefer-stable; decision D-136), the age of that
// version against the cooldown, counted from published-time as Composer 2.11 counts it, whether it is a
// plugin (type composer-plugin: Composer's counterpart of install scripts, decision D-126) and whether the package is
// abandoned. A constraint that names a branch, or allows dev versions, may install a commit that has no release to
// check. Platform packages (php, ext-*) are not installed by Composer and are not looked up.
import { values } from '../apply/facts.ts';
import { matchesPattern } from '../doctor/allow-lists.ts';
import { formatMinutes } from '../doctor/durations.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { ComposerCommandsKnowledge } from '../knowledge/types.ts';
import { policyFor } from '../policy/ecosystem.ts';
import { COMPOSER_PREFIX } from '../policy/package-pattern.ts';
import { comparableVersion, compareComparable, matches, MAX_CONSTRAINT_LENGTH, namesBranch, parseConstraint, parseStability, stabilities, stabilityFlag, stabilityPriority, type Constraint } from './composer-version.ts';
import { describeAge, quoted, type CheckFinding, type CheckOptions, type CheckRequest, type PackageReport } from './findings.ts';
import { fetchPackage, packagistUrl, type PackagistPackage, type PackagistVersion } from './packagist.ts';
import { cachedLookup } from './registry.ts';

/** What to do when Packagist cannot be reached, for a person at the command line. */
export const PACKAGIST_RETRY_FIX = 'Run depcurfew check again when Packagist (repo.packagist.org) can be reached';

/** Whether a spec names a Composer package: it starts with composer:. */
export function isComposerSpec(raw: string): boolean {
  return raw.trim().startsWith(COMPOSER_PREFIX);
}

function composerFact<T>(key: string): T {
  const fact = knowledgeBase.find((tool) => tool.id === 'composer')?.extra?.[key];
  const value = fact === undefined ? undefined : (values(fact)[0] as T | undefined);
  if (value === undefined) throw new Error(`the knowledge base has no Composer fact ${key}`);
  return value;
}

export function composerArguments(): ComposerCommandsKnowledge {
  return composerFact<ComposerCommandsKnowledge>('commandArguments');
}

/** The types Composer loads as plugins, lowercase as Composer compares them (extra.lockfileFormat.pluginTypes, D-134). */
function pluginTypes(): Set<string> {
  const format = composerFact<{ pluginType?: unknown; pluginTypes?: unknown }>('lockfileFormat');
  const types = Array.isArray(format.pluginTypes) ? format.pluginTypes.filter((type): type is string => typeof type === 'string') : [];
  return new Set((types.length > 0 ? types : [typeof format.pluginType === 'string' ? format.pluginType : 'composer-plugin']).map((type) => type.toLowerCase()));
}

/** Whether a name is a platform package (php, ext-json, lib-curl, composer-plugin-api), which Composer does not install. */
export function isPlatformPackage(name: string): boolean {
  return new RegExp(composerArguments().platformPackages, 'iu').test(name);
}

export interface ComposerSpec {
  /** vendor/name in lower case, as Composer looks it up. */
  name: string;
  /** As written; undefined when Composer picks one. */
  constraint?: string;
  parsed?: Constraint;
  platform?: true;
}

/**
 * A spec after composer: as composer require takes it (VersionParser::parseNameVersionPairs): vendor/name, or
 * vendor/name followed by :, = or a space and a constraint; undefined when it is not one.
 */
export function parseComposerSpec(text: string): ComposerSpec | undefined {
  const trimmed = text.trim();
  const separators = composerArguments()
    .pairSeparators.map((separator) => separator.replace(/[\\\]^-]/gu, '\\$&'))
    .join('');
  const pair = new RegExp(`^([^${separators}]+)[${separators}](.*)$`, 'su').exec(trimmed);
  const name = (pair === null ? trimmed : (pair[1] as string)).toLowerCase();
  const constraint = pair === null ? undefined : (pair[2] as string).trim();
  // Real names are a few dozen characters (decision D-136).
  if (name === '' || name.length > MAX_CONSTRAINT_LENGTH) return undefined;
  if (isPlatformPackage(name)) return { name, platform: true, ...(constraint === undefined ? {} : { constraint }) };
  if (!new RegExp(composerArguments().namePattern, 'u').test(name)) return undefined;
  if (constraint === undefined) return { name };
  const parsed = parseConstraint(constraint);
  return parsed === undefined ? undefined : { name, constraint, parsed };
}

/**
 * The highest of some versions, as Composer orders them. Each version is put into the form version_compare reads once,
 * so that a long list of long versions is read in time linear in its length (decision D-136).
 */
function highest(versions: readonly PackagistVersion[]): PackagistVersion | undefined {
  let best: PackagistVersion | undefined;
  let bestForm: string | undefined;
  for (const version of versions) {
    const form = readOnce(version).form;
    if (best === undefined || bestForm === undefined || compareComparable(form, bestForm) > 0) {
      best = version;
      bestForm = form;
    }
  }
  return best;
}

/** What check reads of a version, once per version: the answer of a package is shared by the checks of a command. */
const READ = new WeakMap<PackagistVersion, { form: string; priority: number }>();

function readOnce(version: PackagistVersion): { form: string; priority: number } {
  let read = READ.get(version);
  if (read === undefined) {
    read = { form: comparableVersion(version.normalized), priority: stabilityPriority(parseStability(version.normalized)) };
    READ.set(version, read);
  }
  return read;
}

/** The stability priority of a version (higher is less stable). */
function priorityOf(version: PackagistVersion): number {
  return readOnce(version).priority;
}

/** The most stable versions of a list (DefaultPolicy::versionCompare with prefer-stable: the more stable one first). */
function mostStable(versions: readonly PackagistVersion[]): PackagistVersion[] {
  let best = Number.POSITIVE_INFINITY;
  for (const version of versions) best = Math.min(best, priorityOf(version));
  return versions.filter((version) => priorityOf(version) === best);
}

/**
 * The version Composer picks among the versions a constraint allows: the highest, or with prefer-stable the highest
 * of the most stable ones (DefaultPolicy::versionCompare, extra.rootStability).
 */
function picked(versions: readonly PackagistVersion[], preferStable: boolean): PackagistVersion | undefined {
  return highest(preferStable ? mostStable(versions) : versions);
}

/**
 * The version composer require picks for a package named without a constraint (VersionSelector::findBestCandidate):
 * the highest of the versions at least as stable as the preferred stability ("stable" with prefer-stable, else the
 * minimum stability), else the highest of the most stable others.
 */
function bestCandidate(versions: readonly PackagistVersion[], preferred: string): PackagistVersion | undefined {
  const limit = stabilityPriority(preferred);
  const stableEnough = versions.filter((version) => priorityOf(version) <= limit);
  return highest(stableEnough.length > 0 ? stableEnough : mostStable(versions));
}

/** Whether a version's stability is one a package with this allowed stability may install (StabilityFilter). */
function acceptable(version: PackagistVersion, allowed: string): boolean {
  return priorityOf(version) <= stabilityPriority(allowed);
}

/** The versions a constraint allows at a stability, the ones Composer chooses from. */
function candidates(found: PackagistPackage, constraint: Constraint | undefined, allowed: string): PackagistVersion[] {
  return found.versions.filter((version) => acceptable(version, allowed) && (constraint === undefined || matches(constraint, version.normalized)));
}

function publishedAt(version: PackagistVersion): number {
  return Date.parse(version.publishedTime ?? '');
}

function invalid(raw: string): PackageReport {
  return {
    spec: raw,
    kind: 'invalid',
    findings: [
      {
        level: 'error',
        code: 'invalid-spec',
        message: `"${raw}" is not a Composer package spec`,
        fix: `Write it as ${COMPOSER_PREFIX}vendor/name or ${COMPOSER_PREFIX}vendor/name:<constraint>, as composer require takes it, such as ${COMPOSER_PREFIX}monolog/monolog:^3.9 or ${COMPOSER_PREFIX}vendor/name:^1.0@beta`,
      },
    ],
  };
}

export async function checkComposerSpec(raw: string, options: CheckOptions, request: Omit<CheckRequest, 'spec'> = {}): Promise<PackageReport> {
  const spec = parseComposerSpec(raw.trim().slice(COMPOSER_PREFIX.length));
  if (spec === undefined) return invalid(raw);
  const label = `${COMPOSER_PREFIX}${spec.name}`;
  if (spec.platform === true) {
    return {
      spec: raw,
      kind: 'other',
      name: label,
      findings: [
        {
          level: 'warning',
          code: 'unchecked-source',
          message: `${spec.name} is a platform package (PHP, a PHP extension, a system library or Composer itself), which Composer does not install; depcurfew looks up Packagist packages only`,
          fix: 'Nothing to do: Composer checks a platform package against the PHP and the extensions it runs with',
        },
      ],
    };
  }
  const report: PackageReport = { spec: raw, kind: 'registry', name: label, findings: [] };
  // Another repository of composer.json may serve the package: the caller says why, and the name does not go to
  // Packagist, where a private name could leak and a look-alike could answer (decision D-136).
  if (options.skipLookup?.(label, 'composer', request) === true) return report;
  const add = (finding: CheckFinding) => report.findings.push(finding);
  const repository = packagistUrl();
  const lookup = await cachedLookup(options.lookups, `packagist\0${spec.name}`, () => fetchPackage(spec.name, { fetch: options.fetch, signal: options.signal }));
  if (lookup.status === 'not-found') {
    add({
      level: 'error',
      code: 'not-found',
      message: `${label} does not exist in ${repository}; the name may be mistyped or made up`,
      fix: 'Check the spelling against the documentation of the package you want; do not install a name that was guessed',
    });
    return report;
  }
  if (lookup.status === 'error') {
    add({ level: 'error', code: 'unverified', message: `it cannot be checked: ${lookup.reason}`, fix: lookup.fix ?? PACKAGIST_RETRY_FIX });
    return report;
  }
  const found = lookup.package;
  // minimum-stability and prefer-stable of the root composer.json, for a command that reads it (decision D-136).
  const root = request.readsManifest === false ? undefined : options.composerStability;
  const minimum = root?.minimum ?? stabilities().minimumStability;
  const preferStable = root?.preferStable === true;
  const latest = highest(candidates(found, undefined, minimum));
  if (latest !== undefined) report.latest = latest.publishedTime === undefined ? { version: latest.version } : { version: latest.version, publishedAt: latest.publishedTime };
  const suggestion = latest === undefined ? '' : `, such as ${label}:${latest.version}`;
  const constraint = spec.constraint ?? '*';

  if (spec.parsed !== undefined && namesBranch(spec.parsed)) {
    // Branches are in another file of the metadata; depcurfew does not look them up, as a branch has no release.
    add({
      level: 'error',
      code: 'unverified',
      message: `"${constraint}" names a branch of ${label}, not a release: Composer installs the commit the branch points to when it runs, which has no publication time to check, and its cooldown never holds back a branch`,
      fix: `Require a tagged release instead${suggestion}, so that its age can be checked`,
    });
    return report;
  }
  const flag = spec.constraint === undefined ? undefined : stabilityFlag(spec.constraint, minimum);
  const allowed = flag ?? minimum;
  const allowedVersions = candidates(found, spec.parsed, allowed);
  // composer require without a constraint picks a version itself (VersionSelector::findBestCandidate).
  const choose = (versions: readonly PackagistVersion[]) => (spec.constraint === undefined ? bestCandidate(versions, preferStable ? 'stable' : minimum) : picked(versions, preferStable));
  const version = choose(allowedVersions);
  if (version === undefined) {
    const unstable = candidates(found, spec.parsed, 'dev');
    const stabilitiesFound = [...new Set(unstable.map((entry) => parseStability(entry.normalized)))].sort((a, b) => stabilityPriority(a) - stabilityPriority(b));
    add({
      level: 'error',
      code: 'no-version',
      message: `no version of ${label} matches "${constraint}"${unstable.length === 0 ? '' : ` at the stability ${allowed} (only ${stabilitiesFound.join(' and ')} versions do, which Composer installs only with a stability flag such as @${stabilitiesFound.at(-1) ?? 'beta'})`}`,
      fix: latest === undefined ? `Pick a version of ${label} that exists` : `Pick a version of ${label} that exists${suggestion}`,
    });
    return report;
  }
  report.version = version.version;
  if (version.publishedTime !== undefined) report.publishedAt = version.publishedTime;
  // Versions are written as composer require takes them: vendor/name:version (decisions D-133 and D-136).
  const versionLabel = `${label}:${version.version}`;
  if (allowed === 'dev' && !preferStable) {
    if (flag === undefined && root?.minimum !== undefined) {
      add({
        level: 'error',
        code: 'unverified',
        message: `minimum-stability "dev" in ${root.file} lets "${constraint}" take dev versions of ${label}, so Composer may install a branch instead of ${version.version}: a branch is not a release and has no publication time to check, and Composer's cooldown never holds it back`,
        fix: `Set "prefer-stable": true in ${root.file}, or a stabler minimum-stability, so that Composer picks tagged releases${suggestion}; then the age of the version it installs can be checked`,
      });
    } else {
      add({
        level: 'error',
        code: 'unverified',
        message: `"${constraint}" allows dev versions of ${label}, so Composer may install a branch instead of ${version.version}: a branch is not a release and has no publication time to check, and Composer's cooldown never holds it back`,
        fix: `Require tagged releases only (leave out @dev)${suggestion}, so that the age of the version Composer installs can be checked`,
      });
    }
  }

  const policy = policyFor(options.policy, 'packagist');
  const cooldown = policy.cooldown;
  if (cooldown !== undefined && !cooldown.exclude.some((pattern) => matchesPattern(spec.name, pattern))) {
    const time = publishedAt(version);
    if (Number.isNaN(time)) {
      add({
        level: 'error',
        code: 'unverified',
        message: `Packagist gives no publication time (published-time) for ${versionLabel}, so its age cannot be checked, and Composer 2.11 refuses it while a cooldown is set`,
        fix: `Check when ${versionLabel} was published before installing it, or pick a version that Packagist dates`,
      });
    } else {
      const age = (options.now.getTime() - time) / 60000;
      if (age < cooldown.minimum.minutes) {
        const cutoff = options.now.getTime() - cooldown.minimum.minutes * 60000;
        const instead = choose(allowedVersions.filter((entry) => publishedAt(entry) <= cutoff));
        add({
          level: 'error',
          code: 'too-young',
          message: `${versionLabel} was published on Packagist ${describeAge(age)} ago; depcurfew.json requires ${formatMinutes(cooldown.minimum.minutes)}${instead === undefined ? '' : ` (${label}:${instead.version} is old enough)`}`,
          fix: `${instead === undefined ? 'Wait' : `Install ${label}:${instead.version} instead, or wait`} until ${versionLabel} is ${formatMinutes(cooldown.minimum.minutes)} old`,
        });
      }
    }
  }

  // A plugin of installScripts.deny is not loaded where apply wrote allow-plugins, and installing it follows the policy (D-085).
  const scripts = policy.installScripts;
  const allowedPlugin = scripts?.allow.some((pattern) => matchesPattern(spec.name, pattern)) ?? false;
  const deniedPlugin = scripts?.deny.some((pattern) => matchesPattern(spec.name, pattern)) ?? false;
  if (version.type !== undefined && pluginTypes().has(version.type) && scripts?.default === 'deny' && !allowedPlugin && !deniedPlugin) {
    add({
      level: 'error',
      code: 'install-scripts',
      message: `${versionLabel} is a Composer plugin (type ${version.type}), whose code runs during Composer commands, and depcurfew.json does not allow it (installScripts)`,
      fix: `Pick a package that is not a plugin, or add ${label} to installScripts.allow in depcurfew.json if you trust it`,
    });
  }
  if (version.abandoned !== undefined) {
    // The replacement is the author's text: quoted, so that it reads as data.
    const replacement = typeof version.abandoned === 'string' ? `; its author suggests ${quoted(version.abandoned)} instead` : '';
    add({
      level: 'warning',
      code: 'deprecated',
      message: `${label} is abandoned and no longer maintained${replacement}`,
      fix: `Pick a package that is maintained; check a replacement the author suggests like any other package (as ${COMPOSER_PREFIX}vendor/name) before installing it`,
    });
  }
  return report;
}
