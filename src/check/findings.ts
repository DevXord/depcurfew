// The findings of depcurfew check and what the npm and Python checks share: the report of one package, the options, the
// way an age is written and the findings for sources other than the registry.
import type { ResolvedPolicy } from '../policy/schema.ts';
import type { FetchLike } from './registry.ts';
import type { PopularNames } from './similar.ts';
import type { PackageSpec, SpecKind } from './spec.ts';

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
  | 'deprecated'
  | 'yanked'
  | 'archived'
  | 'quarantined';

export interface CheckFinding {
  level: 'error' | 'warning';
  code: FindingCode;
  message: string;
  /** What to do about it. */
  fix: string;
}

export const CHECK_BY_HAND = 'Make sure you trust this source before installing it';

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
  /** The Python package index pypi: packages are looked up in; PyPI when not given. */
  index?: string;
  /** Popular Python projects, by normalized name, for look-alike names. */
  popularPython?: PopularNames;
}

export const SOURCE_LABELS: Record<'git' | 'remoteTarball' | 'file' | 'directory', string> = {
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

/** Python sources: an archive URL or file may be a wheel, a zip file or a tarball. */
export const PYTHON_SOURCE_LABELS: typeof SOURCE_LABELS = { ...SOURCE_LABELS, remoteTarball: 'an archive URL', file: 'a local archive' };

export type SourceKind = keyof typeof SOURCE_LABELS;

export function sourceFindings(spec: Pick<PackageSpec, 'maybeGit'>, kind: SourceKind, policy: ResolvedPolicy, labels = SOURCE_LABELS): CheckFinding[] {
  // A URL without a tarball extension may be cloned as a git repository instead, so both settings apply to it.
  const keys: SourceKind[] = spec.maybeGit === true ? [kind, 'git'] : [kind];
  const label = spec.maybeGit === true ? 'a URL that may be read as a tarball or a git repository' : labels[kind];
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

