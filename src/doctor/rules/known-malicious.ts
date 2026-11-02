// known-malicious (doctor --osv, decision D-129): a lockfile locks a package version that OSV.dev lists as malicious.
// The rule runs twice: first it collects the exact version of every registry package of every lockfile doctor reads,
// then, with the answers of one batch query (src/doctor/osv.ts), it reports each version with a MAL- record once per
// package and lockfile, at its line. Versions OSV.dev did not answer for give a warning per lockfile, so the check
// does not pass without having checked. Without --osv the rule does nothing and does not apply.
import { linkedIds, osvKey, versionLabel, type OsvPackage, type OsvVerdict } from '../../check/osv.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { hasLockfile } from '../applies.ts';
import { readLockfiles } from '../lockfiles.ts';
import type { Rule, RuleContext } from '../types.ts';

/** What to do when OSV.dev did not answer, in doctor. */
export const OSV_DOCTOR_RETRY_FIX = 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export const knownMalicious: Rule = {
  id: 'known-malicious',
  checks: 'With --osv: no locked package version is a known malicious version in OSV.dev',
  summary: 'With --osv: a lockfile locks a package version that OSV.dev lists as malicious.',
  description:
    'With --osv, doctor sends the name and version of every package the lockfiles it reads lock (npm, pnpm, Yarn, Bun and Deno lockfiles, uv.lock, poetry.lock, pdm.lock, Pipfile.lock, pylock.toml and requirements pinned with ==) to api.osv.dev in batch queries, and reports each version that has a record of the OpenSSF malicious-packages database there (an id starting with MAL-). Such a version was published to steal or damage, and installing from the lockfile brings it back. Only reported malware is found, and the database admits false positives. Without --osv nothing is sent and the rule does not run; when OSV.dev cannot be reached it gives a warning instead of passing.',
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
        let unpinned = 0;
        let locked = 0;
        for (const entry of lockfile.entries) {
          if (entry.source !== 'registry') continue;
          if (entry.version === undefined) {
            unpinned += 1;
            continue;
          }
          const pkg: OsvPackage = { ecosystem, name: entry.name, version: entry.version };
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
          const label = versionLabel(ecosystem, entry.name, entry.version);
          const line = lockfile.lineOf(entry);
          context.report({
            location: line === undefined ? { file: lockfile.file } : { file: lockfile.file, line },
            message: `${lockfile.file} locks ${label}, a known malicious version: OSV.dev lists it as ${linkedIds(verdict.malicious)}`,
            fix: `Remove ${label} from the project: update or replace the package and lock again. If it was installed anywhere, read the record on OSV.dev for what it does and treat that machine as exposed`,
          });
        }
        if ('collect' in osv) continue;
        reportUnchecked(context, lockfile.file, locked, unchecked);
        if (unpinned > 0) {
          context.notice(
            `known-malicious did not check ${plural(unpinned, 'package')} of ${lockfile.file}, which pins no exact version of ${unpinned === 1 ? 'it' : 'them'}`,
            lockfile.file,
            'Pin exact versions (name==version), for example with a lockfile exported by the tool that resolves them, so that doctor --osv can check them',
          );
        }
      }
    }
  },
};

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
