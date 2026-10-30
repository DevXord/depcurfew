// `depcurfew check`: whether installing a package now would follow the policy. For a registry package: whether it exists,
// how old the version the spec picks is compared with the cooldown, whether it runs install scripts the policy does
// not allow, whether it is deprecated and whether its name imitates a popular package. Git, tarball and local sources
// are checked against the policy's sources section only. Anything that cannot be checked is an error, so callers fail
// closed.
import { values } from '../apply/facts.ts';
import { matchesPattern } from '../doctor/allow-lists.ts';
import { formatMinutes } from '../doctor/durations.ts';
import { environment } from '../knowledge/environment.ts';
import { policyFor } from '../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { fetchPackument, type FetchLike, type Packument } from './registry.ts';
import { compareSemver, maxSatisfying, parseRange, parseSemver, satisfies } from './semver.ts';
import type { PopularNames } from './similar.ts';
import { parseSpec, type PackageSpec, type SpecKind } from './spec.ts';

export type FindingCode =
  | 'invalid-spec'
  | 'forbidden-source'
  | 'unchecked-source'
  | 'unverified'
  | 'not-found'
  | 'no-version'
  | 'too-young'
  | 'install-scripts'
  | 'similar-name'
  | 'deprecated';

export interface CheckFinding {
  level: 'error' | 'warning';
  code: FindingCode;
  message: string;
  /** What to do about it. */
  fix: string;
}

const CHECK_BY_HAND = 'Make sure you trust this source before installing it';

export interface PackageReport {
  spec: string;
  kind: SpecKind | 'invalid';
  name?: string;
  version?: string;
  publishedAt?: string;
  latest?: { version: string; publishedAt?: string };
  findings: CheckFinding[];
}

export interface CheckOptions {
  policy: ResolvedPolicy;
  fetch: FetchLike;
  now: Date;
  registry: string;
  popular: PopularNames;
  /** Registries the project assigns to scopes (@scope:registry in .npmrc); those packages are not looked up. */
  scopeRegistries?: ReadonlyMap<string, string>;
}

const SOURCE_LABELS: Record<'git' | 'remoteTarball' | 'file' | 'directory', string> = {
  git: 'a git repository',
  remoteTarball: 'a tarball URL',
  file: 'a local tarball',
  directory: 'a local directory',
};

/** An age in whole units, rounded down: 59 minutes, 23 hours, 6 days. */
export function describeAge(minutes: number): string {
  const [size, unit] = minutes >= 1440 ? [1440, 'day'] : minutes >= 60 ? [60, 'hour'] : [1, 'minute'];
  const count = Math.max(0, Math.floor(minutes / size));
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function defaultTag(): string {
  return values(environment.npmRegistry.api)[0]?.defaultTag ?? 'latest';
}

function tag(packument: Packument, name: string): string | undefined {
  return Object.hasOwn(packument.distTags, name) ? packument.distTags[name] : undefined;
}

/** The version a registry spec installs, like npm: the default tag when it satisfies the range, else the highest match. */
export function pickVersion(packument: Packument, selector: string): string | undefined {
  const latest = tag(packument, defaultTag());
  if (selector === '') return latest;
  const exact = parseSemver(selector);
  if (exact !== undefined) {
    if (Object.hasOwn(packument.versions, selector)) return selector;
    // npm reads v1.2.3 and 1.2.3+build as 1.2.3.
    return Object.keys(packument.versions).find((version) => {
      const parsed = parseSemver(version);
      return parsed !== undefined && compareSemver(parsed, exact) === 0;
    });
  }
  if (parseRange(selector) === undefined) return tag(packument, selector);
  if (latest !== undefined && satisfies(latest, selector)) return latest;
  const all = Object.keys(packument.versions);
  const current = all.filter((version) => packument.versions[version]?.deprecated === undefined);
  return maxSatisfying(current, selector) ?? maxSatisfying(all, selector);
}

/** The newest version the spec allows that is old enough, to suggest instead. */
function oldEnough(packument: Packument, selector: string, cutoff: number): string | undefined {
  const range = selector === '' || parseRange(selector) === undefined ? '*' : selector;
  const versions = Object.keys(packument.versions).filter((version) => {
    const time = Date.parse(packument.time[version] ?? '');
    return !Number.isNaN(time) && time <= cutoff && packument.versions[version]?.deprecated === undefined;
  });
  return maxSatisfying(versions, range);
}

type SourceKind = keyof typeof SOURCE_LABELS;

function sourceFindings(spec: PackageSpec, kind: SourceKind, policy: ResolvedPolicy): CheckFinding[] {
  // A URL without a tarball extension may be cloned as a git repository instead, so both settings apply to it.
  const keys: SourceKind[] = spec.maybeGit === true ? [kind, 'git'] : [kind];
  const label = spec.maybeGit === true ? 'a URL that may be read as a tarball or a git repository' : SOURCE_LABELS[kind];
  const denied = keys.find((key) => policy.sources?.[key] === 'deny');
  if (denied !== undefined) {
    return [
      {
        level: 'error',
        code: 'forbidden-source',
        message: `it installs from ${label}, which depcurfew.json denies (sources.${denied})`,
        fix: `Install the package from the registry instead, or set sources.${denied} to "allow" in depcurfew.json if this source is intended`,
      },
    ];
  }
  return [{ level: 'warning', code: 'unchecked-source', message: `it installs from ${label}; depcurfew looks up registry packages only`, fix: CHECK_BY_HAND }];
}

async function checkRegistryPackage(report: PackageReport, name: string, selector: string, options: CheckOptions): Promise<void> {
  // check looks up npm packages, so only the policy's npm names apply.
  const policy = policyFor(options.policy, 'npm');
  const add = (finding: CheckFinding) => report.findings.push(finding);
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  const scopeRegistry = scope === undefined ? undefined : options.scopeRegistries?.get(scope);
  if (scopeRegistry !== undefined) {
    add({
      level: 'error',
      code: 'unverified',
      message: `${scope} packages come from ${scopeRegistry} (.npmrc); depcurfew looks up the public registry only`,
      fix: `Check the package in ${scopeRegistry} yourself before installing it`,
    });
    return;
  }
  const similar = options.popular.similar(name);
  if (similar !== undefined) {
    const how = similar.reason === 'edit' ? 'differs by a letter or two from' : 'differs only in separators from';
    add({
      level: 'error',
      code: 'similar-name',
      message: `the name ${how} the popular package ${similar.match}; make sure it is the package you want`,
      fix: `Install ${similar.match} if that is what you meant; otherwise check that ${name} is the package its documentation names`,
    });
  }

  const lookup = await fetchPackument(name, { registry: options.registry, fetch: options.fetch });
  if (lookup.status === 'not-found') {
    if (scope !== undefined) {
      // A scope may belong to a private registry that no .npmrc depcurfew reads names, so a person decides.
      add({
        level: 'error',
        code: 'unverified',
        message: `${name} is not in ${options.registry}; if ${scope} packages come from another registry, set ${scope}:registry in .npmrc, otherwise the name may be mistyped or made up`,
        fix: `Set ${scope}:registry in .npmrc if ${scope} packages come from another registry; otherwise check the spelling of the name`,
      });
      return;
    }
    add({
      level: 'error',
      code: 'not-found',
      message: `${name} does not exist in the registry; the name may be mistyped or made up`,
      fix: 'Check the spelling against the documentation of the package you want; do not install a name that was guessed',
    });
    return;
  }
  if (lookup.status === 'error') {
    add({
      level: 'error',
      code: 'unverified',
      message: `it cannot be checked: ${lookup.reason}`,
      fix: 'Run depcurfew check again when the registry is reachable, or pass --registry with a registry you can reach',
    });
    return;
  }
  const packument = lookup.packument;
  const latest = tag(packument, defaultTag());
  if (latest !== undefined) {
    const publishedAt = packument.time[latest];
    report.latest = publishedAt === undefined ? { version: latest } : { version: latest, publishedAt };
  }
  const version = pickVersion(packument, selector);
  if (version === undefined) {
    add({
      level: 'error',
      code: 'no-version',
      message: `no version of ${name} matches "${selector || 'latest'}"`,
      fix: latest === undefined ? `Pick a version of ${name} that exists` : `Pick a version of ${name} that exists, such as ${name}@${latest}`,
    });
    return;
  }
  report.version = version;
  const published = packument.time[version];
  if (published !== undefined) report.publishedAt = published;

  const cooldown = policy.cooldown;
  if (cooldown !== undefined && !cooldown.exclude.some((pattern) => matchesPattern(name, pattern))) {
    const time = Date.parse(published ?? '');
    if (Number.isNaN(time)) {
      add({
        level: 'error',
        code: 'unverified',
        message: `the registry gives no publish time for ${name}@${version}, so its age cannot be checked`,
        fix: `Check when ${name}@${version} was published before installing it, or pin a version the registry dates`,
      });
    } else {
      const age = (options.now.getTime() - time) / 60000;
      if (age < cooldown.minimum.minutes) {
        const instead = oldEnough(packument, selector, options.now.getTime() - cooldown.minimum.minutes * 60000);
        add({
          level: 'error',
          code: 'too-young',
          message: `${name}@${version} was published ${describeAge(age)} ago; depcurfew.json requires ${formatMinutes(cooldown.minimum.minutes)}${instead === undefined ? '' : ` (${name}@${instead} is old enough)`}`,
          fix: `${instead === undefined ? 'Wait' : `Install ${name}@${instead} instead, or wait`} until ${name}@${version} is ${formatMinutes(cooldown.minimum.minutes)} old`,
        });
      }
    }
  }

  const document = packument.versions[version];
  const scriptNames = values(environment.npmRegistry.api)[0]?.installScripts ?? [];
  const scripts = scriptNames.filter((script) => typeof document?.scripts?.[script] === 'string');
  const allowed = policy.installScripts?.allow.some((pattern) => matchesPattern(name, pattern)) ?? false;
  if (scripts.length > 0 && policy.installScripts?.default === 'deny' && !allowed) {
    const listed = scripts.map((script) => `${script}: ${String(document?.scripts?.[script])}`).join('; ');
    add({
      level: 'error',
      code: 'install-scripts',
      message: `${name}@${version} runs install scripts (${listed}) that depcurfew.json does not allow`,
      fix: `Pick a package without install scripts, or add ${name} to installScripts.allow in depcurfew.json if you trust them`,
    });
  }
  if (typeof document?.deprecated === 'string' && document.deprecated !== '') {
    add({
      level: 'warning',
      code: 'deprecated',
      message: `${name}@${version} is deprecated: ${document.deprecated}`,
      fix: 'Pick a version or package that is not deprecated; the deprecation message often names one',
    });
  }
}

export async function checkSpec(raw: string, options: CheckOptions): Promise<PackageReport> {
  const spec = parseSpec(raw);
  if (spec === undefined) {
    const finding: CheckFinding = { level: 'error', code: 'invalid-spec', message: `"${raw}" is not a package spec`, fix: 'Write it as name, name@version, name@range or name@tag' };
    return { spec: raw, kind: 'invalid', findings: [finding] };
  }
  const report: PackageReport = { spec: raw, kind: spec.kind, findings: [] };
  if (spec.kind === 'workspace') {
    report.findings.push({
      level: 'warning',
      code: 'unchecked-source',
      message: 'it is a package of this workspace; depcurfew looks up registry packages only',
      fix: 'Nothing to do if the package is part of this repository',
    });
  } else if (spec.kind === 'other') {
    report.findings.push({ level: 'error', code: 'unverified', message: `it is not looked up: ${spec.reason ?? 'unknown source'}`, fix: CHECK_BY_HAND });
  } else if (spec.kind !== 'registry') {
    report.findings.push(...sourceFindings(spec, spec.kind, options.policy));
  } else if (spec.name !== undefined) {
    report.name = spec.name;
    await checkRegistryPackage(report, spec.name, spec.selector ?? '', options);
  }
  return report;
}

/** How many packages are looked up at once. */
const CONCURRENCY = 6;

/** Checks the specs a few at a time; the reports keep the order of the specs. */
export async function checkSpecs(specs: readonly string[], options: CheckOptions): Promise<PackageReport[]> {
  const reports: PackageReport[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length) {
      const index = next++;
      reports[index] = await checkSpec(specs[index] as string, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, specs.length) }, worker));
  return reports;
}
