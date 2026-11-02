// known-malicious (doctor --osv, decision D-129): a lockfile locks a package version that OSV.dev lists as malicious.
// The rule runs twice: first it collects the exact version of every registry package of every lockfile doctor reads,
// then, with the answers of one batch query (src/doctor/osv.ts), it reports each version with a MAL- record once per
// package and lockfile, at its line. Versions OSV.dev did not answer for give a warning per lockfile, so the check
// does not pass without having checked. What is looked up is what the tool installs (decision D-135): for npm the
// registry tarball of resolved, for pnpm the one of resolution.tarball, for Yarn the version of the resolution; an
// entry whose name or version says otherwise gets a warning, and so do the registry entries of a lockfile without an
// exact version. Without --osv the rule does nothing and does not apply.
import { linkedIds, osvKey, versionLabel, type OsvPackage, type OsvVerdict } from '../../check/osv.ts';
import { listing } from '../../apply/requirements.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { hasLockfile } from '../applies.ts';
import { readLockfiles, type LockEntry, type Lockfile } from '../lockfiles.ts';
import type { Rule, RuleContext } from '../types.ts';

/** What to do when OSV.dev did not answer, in doctor. */
export const OSV_DOCTOR_RETRY_FIX = 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Most registry entries without an exact version that one warning names; the others are counted. */
const MAX_NAMED = 5;

export const knownMalicious: Rule = {
  id: 'known-malicious',
  checks: 'With --osv: no locked package version is a known malicious version in OSV.dev',
  summary: 'With --osv: a lockfile locks a package version that OSV.dev lists as malicious.',
  description:
    'With --osv, doctor sends the name and version of every package the lockfiles it reads lock (npm, pnpm, Yarn, Bun and Deno lockfiles, uv.lock, poetry.lock, pdm.lock, Pipfile.lock, pylock.toml, requirements pinned with == and the releases in composer.lock) to api.osv.dev in batch queries, and reports each version that has a record of the OpenSSF malicious-packages database there (an id starting with MAL-). Such a version was published to steal or damage, and installing from the lockfile brings it back. It looks up what the tool installs: for npm the registry tarball of resolved, for pnpm the one of resolution.tarball, for Yarn the version of resolution; an entry whose name or version says otherwise gets a warning, as does a registry entry of a lockfile without an exact version. Only reported malware is found, and the database admits false positives. Without --osv nothing is sent and the rule does not run; when OSV.dev cannot be reached it gives a warning instead of passing.',
  help: 'Remove or replace the package version and lock again; if it was installed anywhere, read the record on OSV.dev and treat that machine as exposed.',
  level: 'error',
  requiresPolicy: false,
  applies: (scope) => scope.osv !== undefined && hasLockfile(scope),
  check(context) {
    const osv = context.osv;
    if (osv === undefined) return;
    const workspaces = context.detection.workspaces?.packages ?? [];
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      const ecosystem = ecosystemOfTool(tool);
      for (const result of readLockfiles(context.repository, manager, tool, workspaces, context.tools)) {
        if (!result.ok) {
          // An unreadable lockfile is an error of unreadable-config; another format version is a note.
          if (!result.unreadable && 'answers' in osv) context.notice(`known-malicious could not check ${result.file}: ${result.reason}`, result.file);
          continue;
        }
        const { lockfile } = result;
        const seen = new Set<string>();
        const unchecked = new Map<string, number>();
        const unpinned: LockEntry[] = [];
        let locked = 0;
        for (const entry of lockfile.entries) {
          if (entry.source !== 'registry') continue;
          if (entry.version === undefined) {
            unpinned.push(entry);
            continue;
          }
          // What the tool installs (D-135): the tarball of resolved or resolution.tarball, or the resolution of Yarn.
          const pkg: OsvPackage = { ecosystem, name: entry.registryName ?? entry.name, version: entry.version };
          if (entry.mislabel !== undefined && 'answers' in osv) reportMislabel(context, lockfile, entry, versionLabel(ecosystem, pkg.name, pkg.version));
          const key = osvKey(pkg);
          if (seen.has(key)) continue;
          seen.add(key);
          locked += 1;
          if ('collect' in osv) {
            osv.collect.push(pkg);
            continue;
          }
          const verdict: OsvVerdict = osv.answers.get(key) ?? { status: 'unchecked', reason: 'OSV.dev was not asked about it' };
          if (verdict.status === 'unchecked') {
            unchecked.set(verdict.reason, (unchecked.get(verdict.reason) ?? 0) + 1);
            continue;
          }
          if (verdict.malicious.length === 0) continue;
          const label = versionLabel(ecosystem, pkg.name, pkg.version);
          const line = lockfile.lineOf(entry);
          context.report({
            location: line === undefined ? { file: lockfile.file } : { file: lockfile.file, line },
            message: `${lockfile.file} locks ${label}, a known malicious version: OSV.dev lists it as ${linkedIds(verdict.malicious)}`,
            fix: `Remove ${label} from the project: update or replace the package and lock again. If it was installed anywhere, read the record on OSV.dev for what it does and treat that machine as exposed`,
          });
        }
        if ('collect' in osv) continue;
        reportUnchecked(context, lockfile.file, locked, unchecked);
        const count = unpinned.length;
        if (count > 0 && ecosystem === 'packagist') {
          // composer.lock locks a commit of a branch (dev-main, 1.x-dev); OSV.dev records list releases.
          context.notice(
            `known-malicious did not check ${plural(count, 'package')} of ${lockfile.file}, which locks a branch of ${count === 1 ? 'it' : 'them'} (a dev- or -dev version), not a release`,
            lockfile.file,
            `Require tagged releases of ${count === 1 ? 'this package' : 'these packages'} in composer.json and run composer update, so that doctor --osv can check ${count === 1 ? 'it' : 'them'}`,
          );
        } else if (count > 0 && lockfile.requirements === true) {
          // A requirements file may name a range (requests>=2): a note, as README documents.
          context.notice(
            `known-malicious did not check ${plural(count, 'package')} of ${lockfile.file}, which pins no exact version of ${count === 1 ? 'it' : 'them'}`,
            lockfile.file,
            'Pin exact versions (name==version), for example with a lockfile exported by the tool that resolves them, so that doctor --osv can check them',
          );
        } else if (count > 0) {
          reportUnpinned(context, lockfile, tool, unpinned);
        }
      }
    }
  },
};

/**
 * An entry whose name or version field says otherwise than what the tool installs (decision D-135): the lockfile was
 * edited, and what a reader of the lockfile sees is not what is installed.
 */
function reportMislabel(context: RuleContext, lockfile: Lockfile, entry: LockEntry, installs: string): void {
  const line = lockfile.lineOf(entry);
  const location = line === undefined ? { file: lockfile.file } : { file: lockfile.file, line };
  const mislabel = entry.mislabel;
  if (mislabel === undefined) return;
  if (mislabel.tool === 'pnpm') {
    context.report({
      level: 'warning',
      location,
      message: `${lockfile.file} has the key ${mislabel.key}, but its resolution.tarball is the registry tarball of ${installs}, which is what pnpm installs; known-malicious checked ${installs}`,
      fix: `Find out who changed this entry of ${lockfile.file} (pnpm writes the tarball of the package and version of the key, so an entry where the two differ was edited), then lock the package again with pnpm`,
    });
    return;
  }
  if (mislabel.tool === 'npm') {
    context.report({
      level: 'warning',
      location,
      message: `${lockfile.file} has ${mislabel.key} as ${mislabel.label}, but its resolved URL is the registry tarball of ${installs}, which is what npm installs there; known-malicious checked ${installs}`,
      fix: `Find out who changed this entry of ${lockfile.file} (npm writes the name and version of the tarball it resolves, so an entry that differs from its resolved URL was edited), then lock the package again with npm`,
    });
    return;
  }
  context.report({
    level: 'warning',
    location,
    message: `${lockfile.file} has version: ${mislabel.label} for the resolution ${mislabel.resolution}, but Yarn fetches the version of the resolution; known-malicious checked ${installs}`,
    fix: `Find out who changed this entry of ${lockfile.file} (Yarn writes the version of the resolution it fetches, so an entry where the two differ was edited), then lock the package again with Yarn`,
  });
}

/**
 * Registry entries of a lockfile a tool wrote that give no exact version (decision D-135): a warning, as for versions
 * OSV.dev did not answer for, since the tool installs some version that was not checked. At the first of them.
 */
function reportUnpinned(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, entries: readonly LockEntry[]): void {
  const lines = entries.map((entry) => lockfile.lineOf(entry));
  const named = entries.slice(0, MAX_NAMED).map((entry, index) => (lines[index] === undefined ? entry.name : `${entry.name} (line ${lines[index]})`));
  const more = entries.length - named.length;
  const first = lines.find((line) => line !== undefined);
  const one = entries.length === 1;
  context.report({
    level: 'warning',
    location: first === undefined ? { file: lockfile.file } : { file: lockfile.file, line: first },
    message: `known-malicious could not check ${plural(entries.length, 'registry package')} of ${lockfile.file}, whose ${one ? 'entry gives' : 'entries give'} no exact version that ${tool.name} installs: ${more > 0 ? `${named.join(', ')} and ${more} more` : listing(named)}`,
    fix: one
      ? `Lock this package again with ${tool.name}, so that ${lockfile.file} names its exact version, and find out why it does not; then run depcurfew doctor --osv again`
      : `Lock these packages again with ${tool.name}, so that ${lockfile.file} names the exact version of each, and find out why it does not; then run depcurfew doctor --osv again`,
  });
}

/** One warning per lockfile and reason for the versions OSV.dev did not answer for: the check did not pass. */
function reportUnchecked(context: RuleContext, file: string, locked: number, unchecked: ReadonlyMap<string, number>): void {
  for (const [reason, count] of unchecked) {
    const which = count === locked ? `the ${plural(count, 'package version')} locked in ${file}` : `${count} of the ${plural(locked, 'package version')} locked in ${file}`;
    context.report({
      level: 'warning',
      location: { file },
      message: `${which} ${count === 1 ? 'was' : 'were'} not checked for known malicious versions in OSV.dev: ${reason}`,
      fix: OSV_DOCTOR_RETRY_FIX,
    });
  }
}
