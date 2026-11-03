// Known malicious versions before anything else (decision D-155): the Claude Code hook, depcurfew check and check_packages
// of depcurfew mcp look up every spec that names an exact version in the local OSV.dev data of depcurfew osv update
// first, without the network, so that a version the data lists is denied (an error, in check and check_packages)
// whatever else would have answered first: a depcurfew.json that cannot be used, an option that points the install at
// another registry or index, more packages than one command or call checks, or a registry that does not answer. An
// exact version is one that needs no registry to tell: npm name@1.0.1, also =1.0.1, v1.0.1 and behind an npm: alias
// (npm reads them as one version, as pickVersion does); PyPI name==1.0.0 and name===1.0.0; a Composer constraint that
// is a single version, with or without v. Ranges, dist-tags and branches need the registry and keep their answer.
import { parseStability, normalizeVersion as normalizeComposerVersion, isBranch } from './composer-version.ts';
import { isComposerSpec, parseComposerSpec } from './composer.ts';
import type { PackageReport } from './findings.ts';
import { maliciousFinding, type OsvLocalLookup } from './osv.ts';
import { normalizeVersion as normalizePythonVersion } from './pep440.ts';
import { parsePythonSpec } from './python-spec.ts';
import { isPythonSpec } from './python.ts';
import { parseSemver } from './semver.ts';
import { parseSpec } from './spec.ts';
import { COMPOSER_PREFIX, PYPI_PREFIX } from '../policy/package-pattern.ts';

/**
 * Most distinct specs of one command (or one call or check) looked up in the local data: far above the 50 the hook and
 * check_packages check against a registry, since a lookup needs no network (each is a binary search in the file of an
 * ecosystem). The specs after it are not looked up; a command with that many packages is asked about anyway, as one
 * with more than 50.
 */
export const MAX_LISTED_SPECS = 10_000;

/** The version a spec names exactly, as the local data looks it up. */
export interface ExactVersion {
  /** depcurfew's ecosystem: npm, pypi or packagist. */
  ecosystem: 'npm' | 'pypi' | 'packagist';
  /** The name the local data knows: without pypi: or composer:, PyPI names normalized, Composer names in lower case. */
  name: string;
  /** The version as messages show it: npm's without v, = and build metadata, PEP 440's normal form for ==. */
  version: string;
  /**
   * The versions looked up: for Composer also the forms that PHP's version_compare tells apart but Composer installs
   * alike (5.0.2 and 5.0.2.0 are both the release 5.0.2).
   */
  candidates: string[];
}

/** npm: a version (also v1.0.1 or 1.0.1+build), or one with the comparator =, which npm reads as that version. */
function npmVersion(spec: string): ExactVersion | undefined {
  const parsed = parseSpec(spec);
  if (parsed?.kind !== 'registry' || parsed.name === undefined) return undefined;
  const selector = (parsed.selector ?? '').trim();
  const version = parseSemver(selector.startsWith('=') ? selector.slice(1) : selector);
  if (version === undefined) return undefined;
  const text = `${version.major}.${version.minor}.${version.patch}${version.prerelease.length === 0 ? '' : `-${version.prerelease.join('.')}`}`;
  return { ecosystem: 'npm', name: parsed.name, version: text, candidates: [text] };
}

/** PyPI: the version of a == clause without a wildcard, or of ===; with several, the first (the others must agree). */
function pythonVersion(spec: string): ExactVersion | undefined {
  const parsed = parsePythonSpec(spec.trim().slice(PYPI_PREFIX.length));
  if (parsed?.kind !== 'registry' || parsed.name === undefined || parsed.latest === true) return undefined;
  const pin = (parsed.clauses ?? []).find((clause) => clause.operator === '===' || (clause.operator === '==' && !clause.wildcard));
  if (pin === undefined) return undefined;
  const version = pin.operator === '===' ? pin.version : (normalizePythonVersion(pin.version) ?? pin.version);
  return { ecosystem: 'pypi', name: parsed.name, version, candidates: [version] };
}

/**
 * Composer: a constraint that compares with one version (5.0.2, v5.0.2, =5.0.2, ==5.0.2, 5.0.2.0), not a branch or
 * dev version; shown as written when it is that version, else in Composer's normal form.
 */
function composerVersion(spec: string): ExactVersion | undefined {
  const parsed = parseComposerSpec(spec.trim().slice(COMPOSER_PREFIX.length));
  if (parsed === undefined || parsed.platform === true || parsed.parsed === undefined || parsed.constraint === undefined) return undefined;
  const constraint = parsed.parsed;
  if (constraint.kind !== 'compare' || constraint.operator !== '==' || isBranch(constraint.version) || parseStability(constraint.version) === 'dev') return undefined;
  const written = parsed.constraint.replace(/^==?/u, '').trim();
  const version = normalizeComposerVersion(written) === constraint.version ? written : constraint.version;
  // The normal form has four numbers: the shorter forms a release is tagged with differ for version_compare only.
  const dash = constraint.version.indexOf('-');
  const numbers = (dash === -1 ? constraint.version : constraint.version.slice(0, dash)).split('.');
  const suffix = dash === -1 ? '' : constraint.version.slice(dash);
  const candidates = new Set([version, constraint.version]);
  for (let length = numbers.length - 1; length >= 1 && numbers[length] === '0'; length--) candidates.add(`${numbers.slice(0, length).join('.')}${suffix}`);
  return { ecosystem: 'packagist', name: parsed.name, version, candidates: [...candidates] };
}

/** The version a spec names exactly, so that it can be looked up without the network; undefined when it names none. */
export function exactVersion(spec: string): ExactVersion | undefined {
  if (isPythonSpec(spec)) return pythonVersion(spec);
  if (isComposerSpec(spec)) return composerVersion(spec);
  return npmVersion(spec);
}

/** The name of a report: with the prefix of the policy for PyPI and Composer. */
function reportName(exact: ExactVersion): string {
  return exact.ecosystem === 'pypi' ? `${PYPI_PREFIX}${exact.name}` : exact.ecosystem === 'packagist' ? `${COMPOSER_PREFIX}${exact.name}` : exact.name;
}

/**
 * A report for each spec (each once, at most MAX_LISTED_SPECS of them) whose exact version the local data lists, with
 * known-malicious from it (source osv-local), in the order of the specs; the others are left out.
 */
export function listedReports(specs: readonly string[], local: OsvLocalLookup): PackageReport[] {
  const reports: PackageReport[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec)) continue;
    if (seen.size >= MAX_LISTED_SPECS) break;
    seen.add(spec);
    const exact = exactVersion(spec);
    if (exact === undefined) continue;
    const ids = new Set<string>();
    for (const version of exact.candidates) for (const id of local.lookup({ ecosystem: exact.ecosystem, name: exact.name, version }) ?? []) ids.add(id);
    if (ids.size === 0) continue;
    const name = reportName(exact);
    reports.push({ spec, kind: 'registry', name, version: exact.version, findings: [maliciousFinding(name, { ecosystem: exact.ecosystem, name: exact.name, version: exact.version }, [...ids], 'osv-local')] });
  }
  return reports;
}

/**
 * The listed versions in the reports of a check: a report of the same spec that names no version (the registry did not
 * answer, has no such package, or was not asked) and has no known-malicious finding gets it first; a report that names
 * the version keeps the answer it got for it (the local data, or with --osv the API, which is fresher). A listed spec
 * without a report (one that was not checked) is added at the end.
 */
export function addListedVersions(reports: PackageReport[], listed: readonly PackageReport[]): void {
  for (const entry of listed) {
    const same = reports.filter((report) => report.spec === entry.spec);
    if (same.length === 0) {
      reports.push(entry);
      continue;
    }
    for (const report of same) {
      if (report.version !== undefined || report.findings.some((finding) => finding.code === 'known-malicious')) continue;
      report.findings.unshift(...entry.findings);
    }
  }
}
