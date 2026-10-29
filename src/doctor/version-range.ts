// The lowest version a declaration allows: an exact version, or the lower bound of a range such as ^10.2.0, ~1.3,
// >=4.10 <5, 10.x or "1.2.3 - 2.0.0". Tags, expressions and files are not versions.
import { compareVersions, type Version } from '../apply/version.ts';

export type Lowest =
  | { kind: 'exact'; version: Version }
  /** A range; `version` is the lowest version it admits ([0, 0, 0] when it has no lower bound). */
  | { kind: 'range'; version: Version }
  | { kind: 'unknown' };

const PARTIAL = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function partial(text: string): { version: Version; complete: boolean } | undefined {
  const match = PARTIAL.exec(text);
  if (match === null) return undefined;
  const number = (part: string | undefined) => (part === undefined || /^[xX*]$/u.test(part) ? undefined : Number(part));
  const major = Number(match[1]);
  const minor = number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);
  return { version: [major, minor ?? 0, patch ?? 0], complete: minor !== undefined && patch !== undefined };
}

/** Lower bound of one comparator set (space-separated comparators that must all hold). */
function setLowerBound(set: string): { version: Version; exact: boolean } | undefined {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(set);
  if (hyphen !== null) {
    const from = partial(hyphen[1] ?? '');
    return from === undefined ? undefined : { version: from.version, exact: false };
  }
  const comparators = set.split(/\s+/u).filter(Boolean);
  if (comparators.length === 0 || comparators.every((part) => /^[xX*]$/u.test(part))) return { version: [0, 0, 0], exact: false };
  let lowest: Version = [0, 0, 0];
  let exact = comparators.length === 1;
  for (const comparator of comparators) {
    const match = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/u.exec(comparator);
    if (match === null) return undefined;
    const operator = match[1] ?? '';
    const value = partial(match[2] ?? '');
    if (value === undefined) return undefined;
    if (operator === '<' || operator === '<=') {
      exact = false;
      continue;
    }
    let bound = value.version;
    if (operator === '>') {
      // >1.2.3 starts at 1.2.4, >1.2 at 1.3.0 and >1 at 2.0.0.
      const given = (match[2] ?? '').split('.').filter((part) => /^\d+$/u.test(part)).length;
      bound = given >= 3 ? [bound[0], bound[1], bound[2] + 1] : given === 2 ? [bound[0], bound[1] + 1, 0] : [bound[0] + 1, 0, 0];
    }
    if (operator !== '' && operator !== '=') exact = false;
    if (!value.complete) exact = false;
    if (compareVersions(bound, lowest) > 0) lowest = bound;
  }
  return { version: lowest, exact };
}

export function lowestVersion(text: string): Lowest {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.includes('${{')) return { kind: 'unknown' };
  let result: { version: Version; exact: boolean } | undefined;
  for (const set of trimmed.split('||')) {
    const bound = setLowerBound(set.trim());
    if (bound === undefined) return { kind: 'unknown' };
    if (result === undefined || compareVersions(bound.version, result.version) < 0) result = bound;
    else if (compareVersions(bound.version, result.version) === 0) result = { version: result.version, exact: result.exact && bound.exact };
  }
  if (result === undefined) return { kind: 'unknown' };
  const sets = trimmed.split('||').length;
  return result.exact && sets === 1 ? { kind: 'exact', version: result.version } : { kind: 'range', version: result.version };
}
