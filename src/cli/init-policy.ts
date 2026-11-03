// The policy depcurfew init writes for a directory: the default policy, with the longest release-age delay the
// repository already sets as cooldown.minimum (decision D-075), the packages of the lockfiles whose install scripts
// depcurfew knows in installScripts.deny (decision D-127) and the directories of independent projects (decision D-100).
// init writes it; doctor compares a repository without depcurfew.json with it (decision D-149). Nothing is written.
import { join } from 'node:path';
import { longestDelay, policyDuration, type ConfiguredDelay } from '../apply/delays.ts';
import { inProject } from '../apply/projects.ts';
import { Detections } from '../detect/cache.ts';
import type { Detection } from '../detect/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePolicy } from '../policy/validate.ts';
import { proposedProjects, type LeftOutProject } from './init-projects.ts';
import { keptSettings } from './init-kept.ts';
import type { InitMessage } from './init-codes.ts';
import { installScriptHints, type ScriptHints } from './init-scripts.ts';

export interface InitialPolicy {
  /** The detection of the directory. */
  detection: Detection;
  /** The directories init lists under projects, each with its detection. */
  projects: { project: string; detection: Detection }[];
  /** Directories with a manifest that are not listed, and why. */
  leftOut: LeftOutProject[];
  /** Directories init lists under projects beyond the most that were asked for, which `projects` and `text` leave out. */
  notCompared: string[];
  /** The longer release-age delay cooldown.minimum keeps, with where it is set; undefined for the default minimum. */
  kept: ConfiguredDelay | undefined;
  /** cooldown.minimum as written. */
  minimum: string;
  /** What init says about install scripts, and the packages it puts into installScripts.deny. */
  scripts: ScriptHints;
  /**
   * The notes on what init carries over from the repository besides the delay (decision D-167): sources it denies, a
   * delay of security updates, cooldown exceptions and install-script approvals.
   */
  keptNotes: InitMessage[];
  /** The text of depcurfew.json as init writes it. */
  text: string;
}

/**
 * The most projects doctor without depcurfew.json compares with the policy init would write (decision D-157): each one
 * is detected, planned and checked by the rules that need a policy, so thousands of them would take seconds. The
 * notice projects-not-compared names the others; depcurfew init lists them all.
 */
export const MAX_COMPARED_PROJECTS = 20;

/**
 * What depcurfew init writes for `directory` (an absolute path), with what it found on the way. Reads files only.
 * `detections` shares the detection of each directory with the rest of a doctor run (decision D-157); with
 * `maxProjects`, only the first that many projects are detected and written, and `notCompared` has the others.
 */
export function initialPolicy(directory: string, detections: Detections = new Detections(), maxProjects = Number.POSITIVE_INFINITY): InitialPolicy {
  const detection = detections.detect(directory);
  // No manifest in the root, but in direct subdirectories: independent projects (decision D-100).
  const proposed = proposedProjects(directory);
  const projects = proposed.projects.slice(0, maxProjects).map((project) => ({ project, detection: detections.detect(join(directory, project)) }));
  const defaultMinimum = parseDuration(DEFAULT_POLICY.cooldown.minimum);
  // The longest delay of the root and of every project, which apply would otherwise shorten (decision D-075).
  let kept = defaultMinimum.ok ? longestDelay(directory, detection, defaultMinimum.duration.minutes) : undefined;
  for (const entry of defaultMinimum.ok ? projects : []) {
    const longer = longestDelay(join(directory, entry.project), entry.detection, kept?.minutes ?? (defaultMinimum.ok ? defaultMinimum.duration.minutes : 0));
    if (longer !== undefined) kept = { ...longer, location: { ...longer.location, file: inProject(entry.project, longer.location.file) } };
  }
  const minimum = kept === undefined ? DEFAULT_POLICY.cooldown.minimum : policyDuration(kept.minutes);
  // Packages of the lockfiles whose install scripts depcurfew knows go into installScripts.deny, each with a note, and
  // the other packages with install scripts are listed to review (decision D-127).
  const directories = [{ detection }, ...projects.map((entry) => ({ project: entry.project, detection: entry.detection }))];
  const scripts = DEFAULT_POLICY.installScripts.default === 'deny' ? installScriptHints(directory, directories) : { deny: [], notes: [] };
  // What the repository is already stricter in, or already exempts, is carried over (decision D-167).
  const carried = keptSettings(directory, directories);
  const text = renderPolicy({
    ...DEFAULT_POLICY,
    cooldown: { ...DEFAULT_POLICY.cooldown, minimum, exclude: carried.exclude, securityUpdates: carried.securityUpdates ?? DEFAULT_POLICY.cooldown.securityUpdates },
    installScripts: { ...DEFAULT_POLICY.installScripts, allow: carried.allow, deny: scripts.deny },
    sources: { ...DEFAULT_POLICY.sources, ...carried.sources },
    ...(projects.length === 0 ? {} : { projects: projects.map((entry) => entry.project) }),
  });
  return { detection, projects, leftOut: proposed.leftOut, notCompared: proposed.projects.slice(projects.length), kept, minimum, scripts, keptNotes: carried.notes, text };
}

function resolved(text: string): ResolvedPolicy {
  const result = parsePolicy(text);
  if (!result.ok) throw new Error('the policy of depcurfew init is invalid');
  return result.policy;
}

/** The policy init would write for `directory`, resolved as doctor reads depcurfew.json (decision D-149). */
export function initialResolvedPolicy(directory: string, detections?: Detections): ResolvedPolicy {
  return resolved(initialPolicy(directory, detections).text);
}

/**
 * The policy doctor without depcurfew.json compares the repository with (decision D-149): the one init would write,
 * with at most MAX_COMPARED_PROJECTS of its projects; `notCompared` names the others (decision D-157).
 */
export function comparedPolicy(directory: string, detections?: Detections): { policy: ResolvedPolicy; notCompared: string[] } {
  const initial = initialPolicy(directory, detections, MAX_COMPARED_PROJECTS);
  return { policy: resolved(initial.text), notCompared: initial.notCompared };
}
