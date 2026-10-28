import type { PackageManagerInfo } from '../detect/types.ts';

export type Version = readonly [number, number, number];

/** An exact version such as 11.6.0 or v2.9.8; ranges, tags and expressions are not exact. */
export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function formatVersion(version: Version): string {
  return version.join('.');
}

/** The first exact version the repository pins, in the order of the detection (packageManager first). */
export function pinnedVersion(manager: PackageManagerInfo): Version | undefined {
  for (const declaration of manager.versions) {
    const version = 'version' in declaration ? parseVersion(declaration.version) : undefined;
    if (version !== undefined) return version;
  }
  return undefined;
}
