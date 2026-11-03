// The policy depcurfew init writes for a directory: the default policy, with the longest release-age delay the
// repository already sets as cooldown.minimum (decision D-075), the packages of the lockfiles whose install scripts
// depcurfew knows in installScripts.deny (decision D-127) and the directories of independent projects (decision D-100).
// init writes it; doctor compares a repository without depcurfew.json with it (decision D-149). Nothing is written.
import { join } from 'node:path';
import { longestDelay, policyDuration, type ConfiguredDelay } from '../apply/delays.ts';
import { inProject } from '../apply/projects.ts';
import { detectProject } from '../detect/index.ts';
import type { Detection } from '../detect/types.ts';
import { DEFAULT_POLICY, renderPolicy } from '../policy/defaults.ts';
import { parseDuration } from '../policy/duration.ts';
import type { ResolvedPolicy } from '../policy/schema.ts';
import { parsePolicy } from '../policy/validate.ts';
import { proposedProjects, type LeftOutProject } from './init-projects.ts';
import { installScriptHints, type ScriptHints } from './init-scripts.ts';

export interface InitialPolicy {
  /** The detection of the directory. */
  detection: Detection;
  /** The directories init lists under projects, each with its detection. */
  projects: { project: string; detection: Detection }[];
  /** Directories with a manifest that are not listed, and why. */
  leftOut: LeftOutProject[];
  /** The longer release-age delay cooldown.minimum keeps, with where it is set; undefined for the default minimum. */
  kept: ConfiguredDelay | undefined;
  /** cooldown.minimum as written. */
  minimum: string;
  /** What init says about install scripts, and the packages it puts into installScripts.deny. */
  scripts: ScriptHints;
  /** The text of depcurfew.json as init writes it. */
  text: string;
}

/** What depcurfew init writes for `directory` (an absolute path), with what it found on the way. Reads files only. */
export function initialPolicy(directory: string): InitialPolicy {
  const detection = detectProject(directory);
  // No manifest in the root, but in direct subdirectories: independent projects (decision D-100).
  const proposed = proposedProjects(directory);
  const projects = proposed.projects.map((project) => ({ project, detection: detectProject(join(directory, project)) }));
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
  const scripts =
    DEFAULT_POLICY.installScripts.default === 'deny'
      ? installScriptHints(directory, [{ detection }, ...projects.map((entry) => ({ project: entry.project, detection: entry.detection }))])
      : { deny: [], notes: [] };
  const text = renderPolicy({
    ...DEFAULT_POLICY,
    cooldown: { ...DEFAULT_POLICY.cooldown, minimum },
    installScripts: { ...DEFAULT_POLICY.installScripts, deny: scripts.deny },
    ...(projects.length === 0 ? {} : { projects: projects.map((entry) => entry.project) }),
  });
  return { detection, projects, leftOut: proposed.leftOut, kept, minimum, scripts, text };
}

/** The policy init would write for `directory`, resolved as doctor reads depcurfew.json (decision D-149). */
export function initialResolvedPolicy(directory: string): ResolvedPolicy {
  const result = parsePolicy(initialPolicy(directory).text);
  if (!result.ok) throw new Error('the policy of depcurfew init is invalid');
  return result.policy;
}
