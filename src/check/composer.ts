// `depcurfew check composer:<package>`: the Composer side of check (decision D-133). A package is looked up in the v2
// metadata of Packagist.org: whether it exists, the version its constraint makes Composer pick (the highest tagged
// release the constraint and the stability allow, minimum stability stable unless the constraint says otherwise), the
// age of that version against the cooldown, counted from published-time as Composer 2.11 counts it, whether it is a
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
import { compareVersions, matches, namesBranch, parseConstraint, parseStability, stabilities, stabilityFlag, stabilityPriority, type Constraint } from './composer-version.ts';
import { describeAge, quoted, type CheckFinding, type CheckOptions, type PackageReport } from './findings.ts';
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

/** The type of Composer plugins, whose code runs during Composer commands (extra.lockfileFormat.pluginType). */
function pluginType(): string {
  const format = composerFact<{ pluginType?: unknown }>('lockfileFormat');
  return typeof format.pluginType === 'string' ? format.pluginType : 'composer-plugin';
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
  if (name === '') return undefined;
  if (isPlatformPackage(name)) return { name, platform: true, ...(constraint === undefined ? {} : { constraint }) };
  if (!new RegExp(composerArguments().namePattern, 'u').test(name)) return undefined;
  if (constraint === undefined) return { name };
  const parsed = parseConstraint(constraint);
  return parsed === undefined ? undefined : { name, constraint, parsed };
}

/** The highest of some versions, as Composer orders them. */
function highest(versions: readonly PackagistVersion[]): PackagistVersion | undefined {
  let best: PackagistVersion | undefined;
  for (const version of versions) if (best === undefined || compareVersions(version.normalized, best.normalized) > 0) best = version;
  return best;
}

/** Whether a version's stability is one a package with this allowed stability may install (StabilityFilter). */
function acceptable(version: PackagistVersion, allowed: string): boolean {
  return stabilityPriority(parseStability(version.normalized)) <= stabilityPriority(allowed);
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

export async function checkComposerSpec(raw: string, options: CheckOptions): Promise<PackageReport> {
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
  const minimum = stabilities().minimumStability;
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
  const allowed = spec.constraint === undefined ? minimum : (stabilityFlag(spec.constraint, minimum) ?? minimum);
  const version = highest(candidates(found, spec.parsed, allowed));
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
  const versionLabel = `${label} ${version.version}`;
  if (allowed === 'dev') {
    add({
      level: 'error',
      code: 'unverified',
      message: `"${constraint}" allows dev versions of ${label}, so Composer may install a branch instead of ${version.version}: a branch is not a release and has no publication time to check, and Composer's cooldown never holds it back`,
      fix: `Require tagged releases only (leave out @dev)${suggestion}, so that the age of the version Composer installs can be checked`,
    });
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
        const instead = highest(candidates(found, spec.parsed, allowed).filter((entry) => publishedAt(entry) <= cutoff));
        add({
          level: 'error',
          code: 'too-young',
          message: `${versionLabel} was published on Packagist ${describeAge(age)} ago; depcurfew.json requires ${formatMinutes(cooldown.minimum.minutes)}${instead === undefined ? '' : ` (${label} ${instead.version} is old enough)`}`,
          fix: `${instead === undefined ? 'Wait' : `Install ${label}:${instead.version} instead, or wait`} until ${versionLabel} is ${formatMinutes(cooldown.minimum.minutes)} old`,
        });
      }
    }
  }

  // A plugin of installScripts.deny is not loaded where apply wrote allow-plugins, and installing it follows the policy (D-085).
  const scripts = policy.installScripts;
  const allowedPlugin = scripts?.allow.some((pattern) => matchesPattern(spec.name, pattern)) ?? false;
  const deniedPlugin = scripts?.deny.some((pattern) => matchesPattern(spec.name, pattern)) ?? false;
  if (version.type === pluginType() && scripts?.default === 'deny' && !allowedPlugin && !deniedPlugin) {
    add({
      level: 'error',
      code: 'install-scripts',
      message: `${versionLabel} is a Composer plugin (type ${pluginType()}), whose code runs during Composer commands, and depcurfew.json does not allow it (installScripts)`,
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
