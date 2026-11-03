// Whether an OSV record affects a version, as the OSV schema evaluates affected[] (decision D-150): a version is affected
// when it is in the versions list or lies within a range of type SEMVER or ECOSYSTEM. A range is evaluated as the
// Evaluation section of the schema does it: its events sorted by version (introduced "0" first), introduced makes the
// versions from it on affected, fixed ends that at its version, last_affected after its version, and a limit event
// bounds the range from above (limit "*" or none: no bound). Versions are compared with depcurfew's own comparators:
// semantic versions for npm, PEP 440 for Python, PHP's version_compare for Composer, after leaving out what OSV.dev
// leaves out (a leading v of a Packagist version, decision D-142). A range whose versions do not parse is not used,
// except one that only says introduced "0", which holds every version.
import { values } from '../apply/facts.ts';
import { compareVersions as compareComposer } from '../check/composer-version.ts';
import { compareVersions as comparePython, parseVersion as parsePython } from '../check/pep440.ts';
import { compareSemver, parseSemver } from '../check/semver.ts';
import { osv as facts } from '../knowledge/osv.ts';
import type { OsvAffectedKnowledge } from '../knowledge/types.ts';

/** The versions and ranges of one record for one package: ranges as [type, event, version, event, version, ...]. */
export interface AffectedVersions {
  versions: readonly string[];
  ranges: readonly (readonly string[])[];
}

interface Ordering<T> {
  parse(text: string): T | undefined;
  compare(a: T, b: T): number;
}

const SEMVER: Ordering<ReturnType<typeof parseSemver> & object> = { parse: parseSemver, compare: compareSemver };
const PEP440: Ordering<ReturnType<typeof parsePython> & object> = { parse: parsePython, compare: comparePython };

/** The prefixes OSV.dev leaves out of a version of an ecosystem before comparing (versionMatching). */
function ignoredPrefixes(ecosystem: string): readonly string[] {
  const matching = values(facts.versionMatching)[0] ?? {};
  return Object.hasOwn(matching, ecosystem) ? (matching[ecosystem]?.ignoredPrefixes ?? []) : [];
}

function composerOrdering(): Ordering<string> {
  const prefixes = ignoredPrefixes('packagist');
  // One leading v or V, as semantic.ParsePackagistVersion removes it.
  const strip = (text: string) => (prefixes.some((prefix) => text.startsWith(prefix)) ? text.slice(1) : text);
  return { parse: (text) => strip(text.trim()), compare: compareComposer };
}

/** How versions of a depcurfew ecosystem are ordered; undefined for one depcurfew does not know. */
function orderingOf(ecosystem: string): Ordering<unknown> | undefined {
  if (ecosystem === 'npm') return SEMVER as Ordering<unknown>;
  if (ecosystem === 'pypi') return PEP440 as Ordering<unknown>;
  if (ecosystem === 'packagist') return composerOrdering() as Ordering<unknown>;
  return undefined;
}

export function affectedFields(): OsvAffectedKnowledge {
  const fact = values(facts.affected)[0];
  if (fact === undefined) throw new Error('the knowledge base has no OSV affected fact');
  return fact;
}

/** A version of an event: the start of all versions, a parsed version, or no limit. */
type Point = { kind: 'earliest' } | { kind: 'unlimited' } | { kind: 'version'; value: unknown };

function comparePoints(ordering: Ordering<unknown>, a: Point, b: Point): number {
  if (a.kind === b.kind && a.kind !== 'version') return 0;
  if (a.kind === 'earliest' || b.kind === 'unlimited') return -1;
  if (a.kind === 'unlimited' || b.kind === 'earliest') return 1;
  return ordering.compare((a as { value: unknown }).value, (b as { value: unknown }).value);
}

/** Whether the range [type, event, version, ...] holds the version; undefined when it cannot be evaluated. */
function inRange(range: readonly string[], version: unknown, ordering: Ordering<unknown>, fields: OsvAffectedKnowledge): boolean | undefined {
  const events: { event: string; point: Point }[] = [];
  for (let index = 1; index + 1 < range.length; index += 2) {
    const event = range[index] as string;
    const text = range[index + 1] as string;
    let point: Point;
    if (event === fields.events.introduced && text === fields.earliest) point = { kind: 'earliest' };
    else if (event === fields.events.limit && text === fields.unlimited) point = { kind: 'unlimited' };
    else {
      const value = ordering.parse(text);
      if (value === undefined) return undefined;
      point = { kind: 'version', value };
    }
    events.push({ event, point });
  }
  const at: Point = { kind: 'version', value: version };
  const limits = events.filter((entry) => entry.event === fields.events.limit);
  // BeforeLimits: no limit event (an implicit "*"), or a limit above the version.
  if (limits.length > 0 && !limits.some((entry) => comparePoints(ordering, at, entry.point) < 0)) return false;
  // A stable sort: events at the same version keep their order in the record.
  const sorted = events.map((entry, index) => ({ ...entry, index })).sort((a, b) => comparePoints(ordering, a.point, b.point) || a.index - b.index);
  let vulnerable = false;
  for (const { event, point } of sorted) {
    const order = comparePoints(ordering, at, point);
    if (event === fields.events.introduced && order >= 0) vulnerable = true;
    else if (event === fields.events.fixed && order >= 0) vulnerable = false;
    else if (event === fields.events.lastAffected && order > 0) vulnerable = false;
  }
  return vulnerable;
}

/** Whether a range holds every version: only introduced "0" (with no limit but "*"). */
function holdsEvery(range: readonly string[], fields: OsvAffectedKnowledge): boolean {
  let introduced = false;
  for (let index = 1; index + 1 < range.length; index += 2) {
    const event = range[index];
    const text = range[index + 1];
    if (event === fields.events.introduced && text === fields.earliest) introduced = true;
    else if (!(event === fields.events.limit && text === fields.unlimited)) return false;
  }
  return introduced;
}

/** Whether the versions and ranges of a record affect `version` of a package of the depcurfew ecosystem `ecosystem`. */
export function affects(affected: AffectedVersions, ecosystem: string, version: string): boolean {
  const fields = affectedFields();
  const ordering = orderingOf(ecosystem);
  const parsed = ordering?.parse(version);
  for (const listed of affected.versions) {
    if (listed === version) return true;
    if (ordering === undefined || parsed === undefined) continue;
    const other = ordering.parse(listed);
    if (other !== undefined && ordering.compare(parsed, other) === 0) return true;
  }
  for (const range of affected.ranges) {
    if (!fields.versionRangeTypes.includes(range[0] ?? '')) continue;
    if (holdsEvery(range, fields)) return true;
    if (ordering === undefined || parsed === undefined) continue;
    if (inRange(range, parsed, ordering, fields) === true) return true;
  }
  return false;
}
