// Python versions and version specifiers as the version specifiers specification (PEP 440) defines them, for picking
// the version a requirement installs: normalization, ordering, the clauses ~=, ==, !=, <=, >=, <, > and ===, prefix
// matching with .* and the default handling of pre-releases. The rules are those of
// https://packaging.python.org/en/latest/specifications/version-specifiers/ (tests/check/pep440.test.ts), which began
// as PEP 440 (https://peps.python.org/pep-0440/, in the public domain).

export interface Pep440 {
  epoch: number;
  release: readonly number[];
  pre?: readonly ['a' | 'b' | 'rc', number];
  post?: number;
  dev?: number;
  local?: readonly (string | number)[];
}

// Adapted to JavaScript from the regular expression of PEP 440, Appendix B, "Parsing version strings with regular
// expressions" (public domain).
const VERSION =
  /^\s*v?(?:(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<preL>alpha|beta|preview|pre|rc|a|b|c)[-_.]?(?<preN>[0-9]+)?)?(?<post>(?:-(?<postN1>[0-9]+))|(?:[-_.]?(?<postL>post|rev|r)[-_.]?(?<postN2>[0-9]+)?))?(?<dev>[-_.]?(?<devL>dev)[-_.]?(?<devN>[0-9]+)?)?)(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/iu;

const PRE_SPELLINGS: Readonly<Record<string, 'a' | 'b' | 'rc'>> = { a: 'a', alpha: 'a', b: 'b', beta: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' };

export function parseVersion(text: string): Pep440 | undefined {
  const match = VERSION.exec(text);
  const groups = match?.groups;
  if (groups === undefined) return undefined;
  const number = (value: string | undefined) => (value === undefined ? 0 : Number.parseInt(value, 10));
  const version: Pep440 = { epoch: number(groups['epoch']), release: (groups['release'] ?? '0').split('.').map((part) => Number.parseInt(part, 10)) };
  if (groups['pre'] !== undefined) version.pre = [PRE_SPELLINGS[(groups['preL'] ?? '').toLowerCase()] ?? 'rc', number(groups['preN'])];
  if (groups['post'] !== undefined) version.post = number(groups['postN1'] ?? groups['postN2']);
  if (groups['dev'] !== undefined) version.dev = number(groups['devN']);
  if (groups['local'] !== undefined) {
    version.local = groups['local']
      .toLowerCase()
      .split(/[-_.]/u)
      .map((part) => (/^[0-9]+$/u.test(part) ? Number.parseInt(part, 10) : part));
  }
  return version;
}

function publicText(version: Pep440): string {
  let text = version.epoch === 0 ? '' : `${version.epoch}!`;
  text += version.release.join('.');
  if (version.pre !== undefined) text += `${version.pre[0]}${version.pre[1]}`;
  if (version.post !== undefined) text += `.post${version.post}`;
  if (version.dev !== undefined) text += `.dev${version.dev}`;
  return text;
}

export function formatVersion(version: Pep440): string {
  return version.local === undefined ? publicText(version) : `${publicText(version)}+${version.local.join('.')}`;
}

/** The normal form of a version, or undefined when it is not a valid version. */
export function normalizeVersion(text: string): string | undefined {
  const version = parseVersion(text);
  return version === undefined ? undefined : formatVersion(version);
}

export function isPrerelease(version: Pep440): boolean {
  return version.pre !== undefined || version.dev !== undefined;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelease(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const result = compareNumbers(a[index] ?? 0, b[index] ?? 0);
    if (result !== 0) return result;
  }
  return 0;
}

const PRE_ORDER = { a: 0, b: 1, rc: 2 } as const;

/** Pre-release rank: a dev release of a final release sorts before its pre-releases, a final release after them. */
function preKey(version: Pep440): [number, number] {
  if (version.pre === undefined) return version.post === undefined && version.dev !== undefined ? [-1, 0] : [3, 0];
  return [PRE_ORDER[version.pre[0]], version.pre[1]];
}

function compareLocal(a: readonly (string | number)[] | undefined, b: readonly (string | number)[] | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
    // Numeric segments sort after alphanumeric ones.
    if (typeof left !== typeof right) return typeof left === 'number' ? 1 : -1;
    const result = typeof left === 'number' ? compareNumbers(left, right as number) : left < (right as string) ? -1 : left > (right as string) ? 1 : 0;
    if (result !== 0) return result;
  }
  return 0;
}

export function compareVersions(a: Pep440, b: Pep440): number {
  const [aPre, aPreNumber] = preKey(a);
  const [bPre, bPreNumber] = preKey(b);
  return (
    compareNumbers(a.epoch, b.epoch) ||
    compareRelease(a.release, b.release) ||
    compareNumbers(aPre, bPre) ||
    compareNumbers(aPreNumber, bPreNumber) ||
    compareNumbers(a.post ?? -1, b.post ?? -1) ||
    compareNumbers(a.dev ?? Number.POSITIVE_INFINITY, b.dev ?? Number.POSITIVE_INFINITY) ||
    compareLocal(a.local, b.local)
  );
}

export type Operator = '~=' | '==' | '!=' | '<=' | '>=' | '<' | '>' | '===';

export interface Clause {
  operator: Operator;
  version: string;
  /** == or != with a trailing .*: a prefix match. */
  wildcard: boolean;
}

const CLAUSE = /^\s*(~=|===|==|!=|<=|>=|<|>)\s*(.*?)\s*$/u;

function validClause(clause: Clause): boolean {
  if (clause.operator === '===') return clause.version !== '' && !/\s/u.test(clause.version);
  const version = parseVersion(clause.version);
  if (version === undefined) return false;
  if (clause.wildcard) return version.dev === undefined && version.local === undefined;
  if (clause.operator === '~=' && version.release.length < 2) return false;
  // Local versions are allowed only in == and != without a wildcard.
  return version.local === undefined || clause.operator === '==' || clause.operator === '!=';
}

/** The clauses of a specifier such as ">=1.0, !=1.3.*"; [] for an empty one, undefined when it is not valid. */
export function parseSpecifiers(text: string): Clause[] | undefined {
  if (text.trim() === '') return [];
  const clauses: Clause[] = [];
  for (const part of text.split(',')) {
    const match = CLAUSE.exec(part);
    if (match === null) return undefined;
    const operator = match[1] as Operator;
    let version = match[2] ?? '';
    const wildcard = (operator === '==' || operator === '!=') && version.endsWith('.*');
    if (wildcard) version = version.slice(0, -2);
    const clause = { operator, version, wildcard };
    if (!validClause(clause)) return undefined;
    clauses.push(clause);
  }
  return clauses;
}

function withoutLocal(version: Pep440): Pep440 {
  const { local: _local, ...rest } = version;
  return rest;
}

function base(version: Pep440): Pep440 {
  return { epoch: version.epoch, release: version.release };
}

/** Segments for prefix matching: epoch, release numbers, then the pre-, post- and dev-release parts. */
function segments(version: Pep440, releaseLength: number): string[] {
  const release = Array.from({ length: Math.max(releaseLength, version.release.length) }, (_, index) => String(version.release[index] ?? 0));
  return [
    String(version.epoch),
    ...release,
    ...(version.pre === undefined ? [] : [`${version.pre[0]}${version.pre[1]}`]),
    ...(version.post === undefined ? [] : [`post${version.post}`]),
    ...(version.dev === undefined ? [] : [`dev${version.dev}`]),
  ];
}

function prefixMatches(candidate: Pep440, prefix: Pep440): boolean {
  const wanted = segments(prefix, 0);
  const actual = segments(withoutLocal(candidate), prefix.release.length).slice(0, wanted.length);
  return actual.length === wanted.length && actual.every((segment, index) => segment === wanted[index]);
}

function equals(candidate: Pep440, clause: Clause, specified: Pep440): boolean {
  if (clause.wildcard) return prefixMatches(candidate, specified);
  // A public version ignores the local label of the candidate; a local version compares it too.
  return specified.local === undefined ? compareVersions(withoutLocal(candidate), specified) === 0 : compareVersions(candidate, specified) === 0;
}

function matchesClause(raw: string, candidate: Pep440 | undefined, clause: Clause): boolean {
  if (clause.operator === '===') return raw.trim().toLowerCase() === clause.version.toLowerCase();
  // A legacy version that is not valid can be matched with === only.
  const specified = parseVersion(clause.version);
  if (specified === undefined || candidate === undefined) return false;
  const order = compareVersions(withoutLocal(candidate), specified);
  switch (clause.operator) {
    case '==':
      return equals(candidate, clause, specified);
    case '!=':
      return !equals(candidate, clause, specified);
    case '<=':
      return order <= 0;
    case '>=':
      return order >= 0;
    case '<':
      // Not a pre-release of the specified version, unless that is a pre-release itself.
      return order < 0 && (isPrerelease(specified) || !isPrerelease(candidate) || compareVersions(base(candidate), base(specified)) !== 0);
    case '>':
      if (order <= 0) return false;
      // Not a post-release of the specified version (unless it is one itself), nor a local version of it.
      if (specified.post === undefined && candidate.post !== undefined && compareVersions(base(candidate), base(specified)) === 0) return false;
      return candidate.local === undefined || compareVersions(base(candidate), base(specified)) !== 0;
    case '~=': {
      // >= V.N and == V.*, where the prefix drops the last release number and any suffix.
      const prefix: Pep440 = { epoch: specified.epoch, release: specified.release.slice(0, -1) };
      return order >= 0 && prefixMatches(candidate, prefix);
    }
  }
}

/** Whether a version matches every clause, without regard to pre-releases. */
export function matchesSpecifiers(raw: string, clauses: readonly Clause[]): boolean {
  const candidate = parseVersion(raw);
  if (candidate === undefined && clauses.length === 0) return false;
  return clauses.every((clause) => matchesClause(raw, candidate, clause));
}

/** A clause that names a pre-release (other than !=) asks for pre-releases. */
export function requestsPrereleases(clauses: readonly Clause[]): boolean {
  return clauses.some((clause) => {
    if (clause.operator === '!=') return false;
    const version = parseVersion(clause.version);
    return version !== undefined && isPrerelease(version);
  });
}

/** A clause that pins one version: == without a wildcard, or ===. */
export function pinsVersion(clauses: readonly Clause[]): boolean {
  return clauses.some((clause) => clause.operator === '===' || (clause.operator === '==' && !clause.wildcard));
}

function highest(versions: readonly string[]): string | undefined {
  let best: { raw: string; parsed: Pep440 } | undefined;
  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (parsed !== undefined && (best === undefined || compareVersions(parsed, best.parsed) > 0)) best = { raw, parsed };
  }
  return best?.raw;
}

/**
 * The version a specifier installs: the highest match, leaving out pre-releases unless a clause asks for them or no
 * final or post release matches.
 */
export function pickVersion(versions: readonly string[], clauses: readonly Clause[]): string | undefined {
  const matching = versions.filter((version) => matchesSpecifiers(version, clauses));
  if (requestsPrereleases(clauses)) return highest(matching);
  const finals = matching.filter((version) => {
    const parsed = parseVersion(version);
    return parsed !== undefined && !isPrerelease(parsed);
  });
  return highest(finals.length > 0 ? finals : matching);
}
