// Which npm a Node.js version declaration can bring, and which pip a python image tag can bring, from the knowledge
// base: the releases each line bundled (environment.node.bundledNpm, environment.python.bundledPip), the release
// schedule and the names of moving versions (lts/*, lts/jod, node:lts, python:latest). A range such as 24 or >=22
// allows every known release that matches, so it can bring several versions of the tool.
import { compareVersions, formatVersion, parseVersion, type Version } from '../apply/version.ts';
import { satisfies } from '../check/semver.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { BundledVersionsLine, EnvironmentKnowledge, Fact, NodeVersionNamesKnowledge, ReleaseLineSchedule } from '../knowledge/types.ts';
import type { VersionDeclaration, VersionSource } from '../detect/types.ts';
import { lowestVersion } from './version-range.ts';

function first<T>(fact: Fact<T>): T {
  return evidenceOf(fact)[0]?.value as T;
}

/** Which names a declaration may use besides semver ranges. */
export type Naming = 'setup-node' | 'nvm' | 'docker' | 'semver';

/** The names a declaration may use: setup-node in CI, image tags in a Dockerfile, nvm names in .nvmrc and .node-version. */
export function namingOf(source: VersionSource): Naming {
  if (source === 'github-actions') return 'setup-node';
  if (source === 'dockerfile') return 'docker';
  if (source === 'nvmrc' || source === 'node-version') return 'nvm';
  return 'semver';
}

/** The names a declaration may use: a job container's image tag reads like a Dockerfile's (decision D-115). */
export function namingFor(declaration: VersionDeclaration): Naming {
  return declaration.container === undefined ? namingOf(declaration.source) : 'docker';
}

interface Segment {
  line: string;
  /** The first release of the segment, and the first release after it (absent for the last one of a line). */
  from: Version;
  until?: Version;
  latest: Version;
  bundled: Version;
}

export interface Resolution {
  kind: 'exact' | 'range';
  /** The versions of the tool the allowed releases bundle, lowest first. */
  bundled: Version[];
  /** The release lines the declaration allows. */
  lines: string[];
}

export type Resolved = Resolution | { kind: 'unknown'; reason: string };

function segmentsOf(lines: readonly BundledVersionsLine[]): Segment[] {
  return lines.flatMap((entry) => {
    const latest = parseVersion(entry.latest);
    if (latest === undefined) return [];
    return entry.bundles.flatMap(([release, tool], index): Segment[] => {
      const from = parseVersion(release);
      const bundled = parseVersion(tool);
      const next = entry.bundles[index + 1]?.[0];
      const until = next === undefined ? undefined : parseVersion(next);
      if (from === undefined || bundled === undefined) return [];
      return [{ line: entry.line, from, ...(until === undefined ? {} : { until }), latest, bundled }];
    });
  });
}

function max(a: Version, b: Version): Version {
  return compareVersions(a, b) >= 0 ? a : b;
}

function release(version: Version): Version {
  return [version[0], version[1], version[2]];
}

/** Every segment some release of which satisfies the range; undefined when the text is not a range. */
function matching(text: string, segments: readonly Segment[]): Segment[] | undefined {
  const found = new Set<Segment>();
  for (const set of text.split('||')) {
    const lowest = lowestVersion(set);
    if (lowest.kind === 'unknown') return undefined;
    for (const segment of segments) {
      // A comparator set is an interval: if its lowest release in the segment does not satisfy it, none does.
      const candidate = max(segment.from, release(lowest.version));
      const inside = segment.until === undefined ? compareVersions(candidate, segment.latest) <= 0 : compareVersions(candidate, segment.until) < 0;
      if (inside && satisfies(formatVersion(candidate), set.trim() === '' ? '*' : set)) found.add(segment);
    }
  }
  return segments.filter((segment) => found.has(segment));
}

function sortedUnique(versions: readonly Version[]): Version[] {
  const sorted = [...versions].sort(compareVersions);
  return sorted.filter((version, index) => index === 0 || compareVersions(version, sorted[index - 1] as Version) !== 0);
}

export interface RuntimeFacts {
  node: Segment[];
  python: Segment[];
  schedule: readonly ReleaseLineSchedule[];
  /** The day the schedule was read: which lines were LTS then. */
  scheduleDate: string;
  setupNode: NodeVersionNamesKnowledge;
  nvm: NodeVersionNamesKnowledge;
  nodeTags: Readonly<Record<string, string>>;
  pythonTags: Readonly<Record<string, string>>;
}

export function runtimeFacts(environment: EnvironmentKnowledge): RuntimeFacts {
  const schedule = environment.node.releaseSchedule;
  return {
    node: segmentsOf(first(environment.node.bundledNpm)),
    python: segmentsOf(first(environment.python.bundledPip)),
    schedule: first(schedule),
    scheduleDate: evidenceOf(schedule)[0]?.verifiedAt ?? '',
    setupNode: first(environment.githubActions.setupNodeVersions),
    nvm: first(environment.node.nvmrc),
    nodeTags: first(environment.docker.nodeImageTags).tags,
    pythonTags: first(environment.docker.pythonImageTags).tags,
  };
}

/** LTS lines on the day the schedule was read, newest first. */
function ltsLines(facts: RuntimeFacts): ReleaseLineSchedule[] {
  return facts.schedule.filter((line) => line.lts !== undefined && line.lts <= facts.scheduleDate).sort((a, b) => b.line - a.line);
}

/** A name of a moving Node.js version as the release line it means; undefined for anything else. */
function nodeName(text: string, naming: Naming, facts: RuntimeFacts): string | undefined {
  const name = text.toLowerCase();
  const newestLine = facts.node.reduce((newest, segment) => (Number(segment.line) > Number(newest) ? segment.line : newest), '0');
  const codename = (word: string) => facts.schedule.find((line) => line.codename === word)?.line;
  if (naming === 'docker') {
    if (Object.hasOwn(facts.nodeTags, name)) return facts.nodeTags[name];
    const line = codename(name);
    return line === undefined ? undefined : String(line);
  }
  if (naming !== 'setup-node' && naming !== 'nvm') return undefined;
  const names = naming === 'setup-node' ? facts.setupNode : facts.nvm;
  if (names.newest.includes(name)) return newestLine;
  if (name === names.newestLts) return String(ltsLines(facts)[0]?.line ?? newestLine);
  if (names.previousLtsPrefix !== undefined && name.startsWith(names.previousLtsPrefix)) {
    const back = Number(name.slice(names.previousLtsPrefix.length));
    const line = Number.isInteger(back) ? ltsLines(facts)[back]?.line : undefined;
    return line === undefined ? undefined : String(line);
  }
  if (name.startsWith(names.ltsPrefix)) {
    const line = codename(name.slice(names.ltsPrefix.length));
    return line === undefined ? undefined : String(line);
  }
  return undefined;
}

function resolveIn(text: string, segments: readonly Segment[], lineOf: (version: Version) => string): Resolved {
  const lowest = lowestVersion(text);
  if (lowest.kind === 'unknown') return { kind: 'unknown', reason: 'it is not a version or a range depcurfew can read' };
  if (lowest.kind === 'exact') {
    const version = release(lowest.version);
    const line = lineOf(version);
    const ofLine = segments.filter((segment) => segment.line === line);
    const latest = ofLine[0]?.latest;
    if (latest === undefined) return { kind: 'unknown', reason: `depcurfew does not know which version its line ${line} bundles` };
    if (compareVersions(version, latest) > 0) return { kind: 'unknown', reason: `it is newer than the releases depcurfew knows (${line} up to ${formatVersion(latest)})` };
    // Releases of a line before its first segment came without the tool (Node.js before 0.6.3 had no npm).
    const segment = ofLine.findLast((entry) => compareVersions(entry.from, version) <= 0);
    if (segment === undefined) return { kind: 'unknown', reason: `depcurfew knows no version that it comes with (the first release of ${line} that does is ${formatVersion(ofLine[0]?.from as Version)})` };
    return { kind: 'exact', bundled: [segment.bundled], lines: [line] };
  }
  const found = matching(text, segments);
  if (found === undefined) return { kind: 'unknown', reason: 'it is not a version or a range depcurfew can read' };
  if (found.length === 0) return { kind: 'unknown', reason: 'it matches no release depcurfew knows' };
  return { kind: 'range', bundled: sortedUnique(found.map((segment) => segment.bundled)), lines: [...new Set(found.map((segment) => segment.line))] };
}

/** The npm versions the Node.js releases a declaration allows come with. */
export function nodeBundledNpm(written: string, naming: Naming, facts: RuntimeFacts): Resolved {
  const text = written.trim();
  const line = nodeName(text, naming, facts);
  return resolveIn(line ?? text, facts.node, nodeLineOf);
}

/** The last release before `until` in the same line, for testing a range against the end of a segment. */
function justBefore(until: Version): Version {
  if (until[2] > 0) return [until[0], until[1], until[2] - 1];
  if (until[1] > 0) return [until[0], until[1] - 1, Number.MAX_SAFE_INTEGER];
  return [until[0] - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
}

/**
 * Whether the Node.js releases a declaration allows lie in a range (engines.node of npm, decision D-115): `all`, `none`
 * or `some`, undefined when the declaration cannot be read. Each known segment of releases is tested at its first and
 * its last release the declaration allows; the ranges npm declares (^20.17.0 || >=22.9.0) are intervals, so that is
 * enough.
 */
export function nodeReleasesIn(written: string, naming: Naming, range: string, facts: RuntimeFacts): 'all' | 'none' | 'some' | undefined {
  const text = nodeName(written.trim(), naming, facts) ?? written.trim();
  const lowest = lowestVersion(text);
  if (lowest.kind === 'unknown') return undefined;
  const inside = (version: Version) => satisfies(formatVersion(version), range);
  if (lowest.kind === 'exact') return inside(release(lowest.version)) ? 'all' : 'none';
  const found = matching(text, facts.node);
  if (found === undefined || found.length === 0) return undefined;
  let yes = false;
  let no = false;
  for (const segment of found) {
    const first = max(segment.from, release(lowest.version));
    const end = segment.until === undefined ? segment.latest : justBefore(segment.until);
    const last = satisfies(formatVersion(end), text) ? end : first;
    for (const version of [first, last]) {
      if (inside(version)) yes = true;
      else no = true;
    }
  }
  return yes && no ? 'some' : yes ? 'all' : 'none';
}

/** The release line of a Node.js version: the major version from 4 on, the minor one before (0.12). */
function nodeLineOf(version: Version): string {
  return version[0] === 0 ? `0.${version[1]}` : String(version[0]);
}

/** The pip versions the CPython releases of a python image tag version (3.12, 3.12.4, latest) come with. */
export function pythonBundledPip(written: string, facts: RuntimeFacts): Resolved {
  const text = written.trim().toLowerCase();
  const line = Object.hasOwn(facts.pythonTags, text) ? facts.pythonTags[text] : undefined;
  return resolveIn(line ?? text, facts.python, (version) => `${version[0]}.${version[1]}`);
}

/** The Node.js release lines a declaration allows, from the schedule (so also lines older than the bundled-npm data). */
export function nodeLines(written: string, naming: Naming, facts: RuntimeFacts): ReleaseLineSchedule[] | undefined {
  const text = written.trim();
  const named = nodeName(text, naming, facts);
  // A prerelease (16.20.0-rc.1) belongs to its line: a range would not match it, so its release stands for it.
  const exact = named === undefined ? parseVersion(text) : undefined;
  const range = exact !== undefined && exact[3] !== undefined ? formatVersion(release(exact)) : (named ?? text);
  const sets = range.split('||');
  const found: ReleaseLineSchedule[] = [];
  for (const line of facts.schedule) {
    const start: Version = [line.line, 0, 0];
    const next: Version = [line.line + 1, 0, 0];
    let allowed = false;
    for (const set of sets) {
      const lowest = lowestVersion(set);
      if (lowest.kind === 'unknown') return undefined;
      const candidate = max(start, release(lowest.version));
      if (compareVersions(candidate, next) < 0 && satisfies(formatVersion(candidate), set.trim() === '' ? '*' : set)) allowed = true;
    }
    if (allowed) found.push(line);
  }
  return found;
}

/** The lines that are LTS and not past their end of life on the given day (YYYY-MM-DD), oldest first. */
export function supportedLtsLines(facts: RuntimeFacts, today: string): ReleaseLineSchedule[] {
  return facts.schedule.filter((line) => line.lts !== undefined && line.lts <= today && line.end > today).sort((a, b) => a.line - b.line);
}

/**
 * Per release line, the first release that bundles `needed` or later, lowest line first; only the given lines (the
 * supported Node.js LTS lines) when they are given.
 */
export function firstReleasesWith(needed: Version, segments: readonly Segment[], lines?: readonly string[]): { line: string; release: Version }[] {
  const found = new Map<string, Version>();
  for (const segment of segments) {
    if (lines !== undefined && !lines.includes(segment.line)) continue;
    if (compareVersions(segment.bundled, needed) < 0) continue;
    const known = found.get(segment.line);
    if (known === undefined || compareVersions(segment.from, known) < 0) found.set(segment.line, segment.from);
  }
  return [...found].map(([line, release]) => ({ line, release })).sort((a, b) => compareVersions(a.release, b.release));
}

/** "24.14.1 or a later 24.x; 26.0.0 or later": a later release of a line keeps the bundled version, a later line may not. */
export function releasesPhrase(found: readonly { line: string; release: Version }[], newestLine: string): string {
  const parts = found.map(({ line, release }) => (line === newestLine ? `${formatVersion(release)} or later` : `${formatVersion(release)} or a later ${line}.x`));
  return parts.join('; ');
}

/** The newest line of the data. */
export function newestLineOf(segments: readonly Segment[]): string {
  return segments.reduce((newest, segment) => (compareVersions(segment.from, newest.from) > 0 ? segment : newest), segments[0] as Segment).line;
}

/** Today as YYYY-MM-DD in UTC. */
export function today(): string {
  return new Date(Date.now()).toISOString().slice(0, 10);
}
