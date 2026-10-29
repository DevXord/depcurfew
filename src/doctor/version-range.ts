// The lowest version a declaration allows: an exact version, or the lower bound of a range such as ^10.2.0, ~1.3,
// >=4.10 <5, 10.x or "1.2.3 - 2.0.0". Tags, expressions and files are not versions. A prerelease such as
// 10.16.0-rc.1 comes before 10.16.0, as in semver, so it never passes for the release.
import { compareVersions, formatVersion, type Version } from '../apply/version.ts';

/** A version, with the prerelease identifiers when it is a prerelease of `version`. */
export interface Bound {
  version: Version;
  prerelease?: string;
}

export type Lowest =
  | ({ kind: 'exact' } & Bound)
  /** A range; `version` is the lowest version it admits ([0, 0, 0] when it has no lower bound). */
  | ({ kind: 'range' } & Bound)
  | { kind: 'unknown' };

const PARTIAL = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Comparator operators; a space between an operator and its version is allowed, as in semver. */
const OPERATOR = /(\^|~>?|>=|<=|>|<|=)\s+/gu;

function partial(text: string): { bound: Bound; complete: boolean } | undefined {
  const match = PARTIAL.exec(text);
  if (match === null) return undefined;
  const number = (part: string | undefined) => (part === undefined || /^[xX*]$/u.test(part) ? undefined : Number(part));
  const major = Number(match[1]);
  const minor = number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);
  const complete = minor !== undefined && patch !== undefined;
  const version: Version = [major, minor ?? 0, patch ?? 0];
  // Only a complete version can be a prerelease (1.2-rc.1 is not a version).
  return { bound: complete && match[4] !== undefined ? { version, prerelease: match[4] } : { version }, complete };
}

/** Orders bounds: by version, and a prerelease before its release. Prereleases of one version count as equal. */
function compareBounds(a: Bound, b: Bound): number {
  return compareVersions(a.version, b.version) || (a.prerelease === undefined ? 0 : -1) - (b.prerelease === undefined ? 0 : -1);
}

/** Whether `bound` comes before the release `version`. */
export function belowVersion(bound: Bound, version: Version): boolean {
  return compareBounds(bound, { version }) < 0;
}

export function formatBound(bound: Bound): string {
  return bound.prerelease === undefined ? formatVersion(bound.version) : `${formatVersion(bound.version)}-${bound.prerelease}`;
}

/** Lower bound of one comparator set (space-separated comparators that must all hold). */
function setLowerBound(set: string): { bound: Bound; exact: boolean } | undefined {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(set);
  if (hyphen !== null) {
    const from = partial(hyphen[1] ?? '');
    return from === undefined ? undefined : { bound: from.bound, exact: false };
  }
  const comparators = set.replaceAll(OPERATOR, '$1').split(/\s+/u).filter(Boolean);
  if (comparators.length === 0 || comparators.every((part) => /^[xX*]$/u.test(part))) return { bound: { version: [0, 0, 0] }, exact: false };
  let lowest: Bound = { version: [0, 0, 0] };
  let exact = comparators.length === 1;
  for (const comparator of comparators) {
    const match = /^(\^|~>?|>=|<=|>|<|=)?(.+)$/u.exec(comparator);
    if (match === null) return undefined;
    const operator = match[1] ?? '';
    const value = partial(match[2] ?? '');
    if (value === undefined) return undefined;
    if (operator === '<' || operator === '<=') {
      exact = false;
      continue;
    }
    let bound = value.bound;
    if (operator === '>' && bound.prerelease === undefined) {
      // >1.2.3 starts at 1.2.4, >1.2 at 1.3.0 and >1 at 2.0.0. >1.2.3-rc.1 admits later prereleases of 1.2.3, so its
      // bound stays below the release.
      const given = (match[2] ?? '').split('.').filter((part) => /^\d+$/u.test(part)).length;
      const [major, minor, patch] = bound.version;
      bound = { version: given >= 3 ? [major, minor, patch + 1] : given === 2 ? [major, minor + 1, 0] : [major + 1, 0, 0] };
    }
    if (operator !== '' && operator !== '=') exact = false;
    if (!value.complete) exact = false;
    if (compareBounds(bound, lowest) > 0) lowest = bound;
  }
  return { bound: lowest, exact };
}

export function lowestVersion(text: string): Lowest {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.includes('${{')) return { kind: 'unknown' };
  let result: { bound: Bound; exact: boolean } | undefined;
  for (const set of trimmed.split('||')) {
    const lower = setLowerBound(set.trim());
    if (lower === undefined) return { kind: 'unknown' };
    const order = result === undefined ? -1 : compareBounds(lower.bound, result.bound);
    if (result === undefined || order < 0) result = lower;
    else if (order === 0) result = { bound: result.bound, exact: result.exact && lower.exact };
  }
  if (result === undefined) return { kind: 'unknown' };
  const sets = trimmed.split('||').length;
  return { kind: result.exact && sets === 1 ? 'exact' : 'range', ...result.bound };
}
