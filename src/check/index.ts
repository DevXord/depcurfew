// `depcurfew check`: whether installing a package now would follow the policy. For a registry package: whether it exists,
// how old the version the spec picks is compared with the cooldown, whether it runs install scripts the policy does
// not allow, whether it is deprecated and whether its name imitates a popular package. Git, tarball and local sources
// are checked against the policy's sources section only. Anything that cannot be checked is an error, so callers fail
// closed.
import { values } from '../apply/facts.ts';
import { matchesPattern } from '../doctor/allow-lists.ts';
import { formatMinutes } from '../doctor/durations.ts';
import { environment } from '../knowledge/environment.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { policyFor } from '../policy/ecosystem.ts';
import { CHECK_BY_HAND, describeAge, insecureFinding, quoted, sourceFindings, type CheckFinding, type CheckOptions, type CheckRequest, type PackageReport } from './findings.ts';
import { checkPythonSpec, isPythonSpec } from './python.ts';
import { fetchPackument, type Packument } from './registry.ts';
import { compareSemver, maxSatisfying, parseRange, parseSemver, satisfies } from './semver.ts';
import { parseSpec } from './spec.ts';

export { describeAge } from './findings.ts';

/** What to do when the registry cannot be reached, for a person at the command line. */
export const REGISTRY_RETRY_FIX = 'Run depcurfew check again when the registry is reachable, or pass --registry with a registry you can reach';
export type { CheckFinding, CheckOptions, CheckRequest, FindingCode, PackageReport } from './findings.ts';

function defaultTag(): string {
  return values(environment.npmRegistry.api)[0]?.defaultTag ?? 'latest';
}

function tag(packument: Packument, name: string): string | undefined {
  return Object.hasOwn(packument.distTags, name) ? packument.distTags[name] : undefined;
}

function versionSelection(): { bareRange: string } {
  const npm = knowledgeBase.find((tool) => tool.id === 'npm');
  const fact = npm?.extra?.['versionSelection'];
  const value = fact === undefined ? undefined : (values(fact)[0] as { bareRange?: unknown } | undefined);
  return { bareRange: typeof value?.bareRange === 'string' ? value.bareRange : '*' };
}

function deprecated(packument: Packument, version: string): boolean {
  const reason = packument.versions[version]?.deprecated;
  return reason !== undefined && reason !== null && reason !== false && reason !== '';
}

/**
 * The version a registry spec installs, like npm (npm-pick-manifest): an exact version or a dist-tag as named;
 * for a range (a bare name is *), the version of the preferred dist-tag when the range is * or it satisfies the range
 * and it is not deprecated, else the highest match, preferring versions that are not deprecated.
 */
export function pickVersion(packument: Packument, selector: string, preferred = defaultTag()): string | undefined {
  const bare = versionSelection().bareRange;
  const wanted = selector.trim() === '' ? bare : selector.trim();
  const exact = parseSemver(wanted);
  if (exact !== undefined) {
    if (Object.hasOwn(packument.versions, wanted)) return wanted;
    // npm reads v1.2.3 and 1.2.3+build as 1.2.3.
    return Object.keys(packument.versions).find((version) => {
      const parsed = parseSemver(version);
      return parsed !== undefined && compareSemver(parsed, exact) === 0;
    });
  }
  if (parseRange(wanted) === undefined) return tag(packument, wanted);
  const tagged = tag(packument, preferred);
  if (tagged !== undefined && Object.hasOwn(packument.versions, tagged) && (wanted === bare || satisfies(tagged, wanted)) && !deprecated(packument, tagged)) return tagged;
  const all = Object.keys(packument.versions);
  const current = all.filter((version) => !deprecated(packument, version));
  return maxSatisfying(current, wanted) ?? maxSatisfying(all, wanted);
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

async function checkRegistryPackage(report: PackageReport, name: string, selector: string, options: CheckOptions, preferred: string): Promise<void> {
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

  const insecure = insecureFinding(options.registry, 'registry');
  if (insecure !== undefined) add(insecure);
  const lookup = await fetchPackument(name, { registry: options.registry, fetch: options.fetch, signal: options.signal });
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
      fix: lookup.fix ?? REGISTRY_RETRY_FIX,
    });
    return;
  }
  const packument = lookup.packument;
  const latest = tag(packument, defaultTag());
  if (latest !== undefined) {
    const publishedAt = packument.time[latest];
    report.latest = publishedAt === undefined ? { version: latest } : { version: latest, publishedAt };
  }
  const version = pickVersion(packument, selector, preferred);
  if (version === undefined) {
    add({
      level: 'error',
      code: 'no-version',
      message: `no version of ${name} matches "${selector || preferred}"`,
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
  // A package of installScripts.deny was reviewed and works without its scripts: installing it follows the policy, and
  // blocking the scripts is the package manager's job, which doctor checks (decision D-085).
  const allowed = policy.installScripts?.allow.some((pattern) => matchesPattern(name, pattern)) ?? false;
  const denied = policy.installScripts?.deny.some((pattern) => matchesPattern(name, pattern)) ?? false;
  if (scripts.length > 0 && policy.installScripts?.default === 'deny' && !allowed && !denied) {
    // The body of a script is the publisher's text, so it is quoted; the names come from the knowledge base.
    const listed = scripts.map((script) => (options.scriptBodies === false ? script : `${script}: ${quoted(String(document?.scripts?.[script]))}`)).join('; ');
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
      // The message is the publisher's: quoted, so that it reads as data, and a replacement it names is only a suggestion.
      message: `${name}@${version} is deprecated, with the message ${quoted(document.deprecated)}`,
      fix: DEPRECATED_FIX,
    });
  }
}

/** What to do about a deprecated version: a replacement the publisher names is checked like any other package. */
export const DEPRECATED_FIX = 'Pick a version or package that is not deprecated; check a replacement the message suggests like any other package before installing it';

export async function checkSpec(request: string | CheckRequest, options: CheckOptions): Promise<PackageReport> {
  const { spec: raw, ...chosen } = typeof request === 'string' ? { spec: request } : request;
  if (isPythonSpec(raw)) return checkPythonSpec(raw, options, chosen);
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
    const preferred = chosen.tag ?? (chosen.ignoresConfigTag === true ? undefined : options.defaultTag) ?? defaultTag();
    if (preferred !== defaultTag()) report.tag = preferred;
    await checkRegistryPackage(report, spec.name, spec.selector ?? '', options, preferred);
  }
  return report;
}

/** How many packages are looked up at once. */
const CONCURRENCY = 6;

/**
 * Checks the specs a few at a time; the reports keep the order of the specs. When `options.signal` aborts, no further
 * spec is looked up and the promise rejects with the signal's reason.
 */
export async function checkSpecs(specs: readonly (string | CheckRequest)[], options: CheckOptions): Promise<PackageReport[]> {
  const reports: PackageReport[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length && options.signal?.aborted !== true) {
      const index = next++;
      reports[index] = await checkSpec(specs[index] as string | CheckRequest, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, specs.length) }, worker));
  options.signal?.throwIfAborted();
  return reports;
}
