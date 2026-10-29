// Semantic versions and ranges as npm reads them, for picking the version a package spec installs: comparators
// (=, >, >=, <, <=), x-ranges (1.x, 1.2.*, *), tilde, caret, hyphen ranges and ||. A prerelease satisfies a range only
// when one of its comparators names a prerelease of the same version, as in npm.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseSemver(text: string): SemVer | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  const main = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (main !== 0) return main;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  operator: Operator;
  version: SemVer;
}

/** A partial version: missing or x parts are undefined. */
interface Partial {
  major: number | undefined;
  minor: number | undefined;
  patch: number | undefined;
  prerelease: readonly (string | number)[];
}

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function partial(text: string): Partial | undefined {
  if (text === '' || text === '*' || text === 'x' || text === 'X') return { major: undefined, minor: undefined, patch: undefined, prerelease: [] };
  const match = PARTIAL.exec(text);
  if (match === null) return undefined;
  const number = (part: string | undefined) => (part === undefined || /^[xX*]$/u.test(part) ? undefined : Number(part));
  const major = number(match[1]);
  const minor = major === undefined ? undefined : number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);
  const prerelease = patch === undefined || match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  return { major, minor, patch, prerelease };
}

const version = (major: number, minor: number, patch: number, prerelease: readonly (string | number)[] = []): SemVer => ({ major, minor, patch, prerelease });
/** The lowest version of a release line, below its prereleases: x.y.z-0. */
const floor = (major: number, minor: number, patch: number): SemVer => version(major, minor, patch, [0]);

function full(value: Partial): SemVer {
  return version(value.major ?? 0, value.minor ?? 0, value.patch ?? 0, value.prerelease);
}

/** Comparators of one operator and partial version, as npm desugars them. */
function desugar(operator: string, value: Partial): Comparator[] | undefined {
  const { major, minor, patch } = value;
  if (major === undefined) return operator === '<' || operator === '>' ? [{ operator: '<', version: floor(0, 0, 0) }] : [];
  switch (operator) {
    case '':
    case '=':
      if (minor === undefined) return [{ operator: '>=', version: version(major, 0, 0) }, { operator: '<', version: floor(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: '>=', version: version(major, minor, 0) }, { operator: '<', version: floor(major, minor + 1, 0) }];
      return [{ operator: '=', version: full(value) }];
    case '~':
    case '~>':
      if (minor === undefined) return [{ operator: '>=', version: version(major, 0, 0) }, { operator: '<', version: floor(major + 1, 0, 0) }];
      return [{ operator: '>=', version: full(value) }, { operator: '<', version: floor(major, minor + 1, 0) }];
    case '^': {
      const lower: Comparator = { operator: '>=', version: full(value) };
      if (major > 0 || minor === undefined) return [lower, { operator: '<', version: floor(major + 1, 0, 0) }];
      if (minor > 0 || patch === undefined) return [lower, { operator: '<', version: floor(0, minor + 1, 0) }];
      return [lower, { operator: '<', version: floor(0, 0, patch + 1) }];
    }
    case '>':
      if (minor === undefined) return [{ operator: '>=', version: version(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: '>=', version: version(major, minor + 1, 0) }];
      return [{ operator: '>', version: full(value) }];
    case '>=':
      return [{ operator: '>=', version: full(value) }];
    case '<':
      return [{ operator: '<', version: patch === undefined ? floor(major, minor ?? 0, 0) : full(value) }];
    case '<=':
      if (minor === undefined) return [{ operator: '<', version: floor(major + 1, 0, 0) }];
      if (patch === undefined) return [{ operator: '<', version: floor(major, minor + 1, 0) }];
      return [{ operator: '<=', version: full(value) }];
    default:
      return undefined;
  }
}

/** Comparator sets joined by ||; undefined when the text is not a range (for example a dist-tag). */
export function parseRange(text: string): Comparator[][] | undefined {
  const sets: Comparator[][] = [];
  for (const raw of text.split('||')) {
    const set = raw.trim().replaceAll(/(\^|~>?|>=|<=|>|<|=)\s+/gu, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(set);
    if (hyphen !== null) {
      const from = partial(hyphen[1] ?? '');
      const to = partial(hyphen[2] ?? '');
      if (from === undefined || to === undefined) return undefined;
      const lower = desugar('>=', from) ?? [];
      const upper = to.major === undefined ? [] : (desugar('<=', to) ?? []);
      sets.push([...lower, ...upper]);
      continue;
    }
    const comparators: Comparator[] = [];
    for (const part of set === '' ? [''] : set.split(/\s+/u)) {
      const match = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/u.exec(part);
      const value = partial(match?.[2] ?? '');
      if (match === null || value === undefined) return undefined;
      const desugared = desugar(match[1] ?? '', value);
      if (desugared === undefined) return undefined;
      comparators.push(...desugared);
    }
    sets.push(comparators);
  }
  return sets;
}

function holds(comparator: Comparator, candidate: SemVer): boolean {
  const order = compareSemver(candidate, comparator.version);
  switch (comparator.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '=':
      return order === 0;
  }
}

function satisfiesSet(candidate: SemVer, set: readonly Comparator[]): boolean {
  if (!set.every((comparator) => holds(comparator, candidate))) return false;
  if (candidate.prerelease.length === 0) return true;
  // npm: a prerelease only matches a comparator that names a prerelease of the same major.minor.patch.
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      !(comparator.version.prerelease.length === 1 && comparator.version.prerelease[0] === 0 && comparator.operator === '<') &&
      comparator.version.major === candidate.major &&
      comparator.version.minor === candidate.minor &&
      comparator.version.patch === candidate.patch,
  );
}

export function satisfies(candidate: string, range: string): boolean {
  const parsed = parseSemver(candidate);
  const sets = parseRange(range);
  return parsed !== undefined && sets !== undefined && sets.some((set) => satisfiesSet(parsed, set));
}

/** The highest of `versions` that satisfies `range`. */
export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
  const sets = parseRange(range);
  if (sets === undefined) return undefined;
  let best: { text: string; version: SemVer } | undefined;
  for (const text of versions) {
    const parsed = parseSemver(text);
    if (parsed === undefined || !sets.some((set) => satisfiesSet(parsed, set))) continue;
    if (best === undefined || compareSemver(parsed, best.version) > 0) best = { text, version: parsed };
  }
  return best?.text;
}
