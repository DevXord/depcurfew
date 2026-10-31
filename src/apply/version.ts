import type { PackageManagerInfo } from '../detect/types.ts';

/**
 * An exact version: major, minor and patch, and the identifiers of a prerelease such as 11.0.0-pre.1. apply and every
 * doctor rule read pinned versions with these functions, and manager-version-too-old orders ranges the same way.
 */
export type Version = readonly [number, number, number] | readonly [number, number, number, string];

const EXACT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** An exact version such as 11.6.0, v2.9.8 or 11.0.0-pre.1 (build metadata ignored); ranges, tags and expressions are not exact. */
export function parseVersion(text: string): Version | undefined {
  const match = EXACT.exec(text.trim());
  if (match === null) return undefined;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return match[4] === undefined ? [major, minor, patch] : [major, minor, patch, match[4]];
}

/** Prerelease identifiers in semver order: numbers by value and before words, a shorter list before a longer one. */
function comparePrereleases(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = [/^\d+$/u.test(x), /^\d+$/u.test(y)];
    if (numeric[0] === true && numeric[1] === true) {
      const order = x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
      if (order !== 0) return order;
    } else if (numeric[0] !== numeric[1]) {
      return numeric[0] === true ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Orders versions as semver does: a prerelease comes before its release (11.0.0-pre.1 < 11.0.0). */
export function compareVersions(a: Version, b: Version): number {
  const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (order !== 0) return order;
  const [left, right] = [a[3], b[3]];
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return comparePrereleases(left, right);
}

export function formatVersion(version: Version): string {
  const release = `${version[0]}.${version[1]}.${version[2]}`;
  return version[3] === undefined ? release : `${release}-${version[3]}`;
}

/** The first exact version the repository pins, in the order of the detection (packageManager first). */
export function pinnedVersion(manager: PackageManagerInfo): Version | undefined {
  for (const declaration of manager.versions) {
    const version = 'version' in declaration ? parseVersion(declaration.version) : undefined;
    if (version !== undefined) return version;
  }
  return undefined;
}
