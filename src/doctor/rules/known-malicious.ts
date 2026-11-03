// known-malicious (doctor --osv, decision D-129, and the local OSV.dev data of depcurfew osv update, decision D-150): a
// lockfile locks a package version that OSV.dev lists as malicious. The rule runs twice: first it collects the exact
// version of every registry package of every lockfile doctor reads, then, with the answers of one batch query or of
// the local data (src/doctor/osv.ts), it reports each version with a MAL- record once per package and lockfile, at its
// line. Versions OSV.dev did not answer for give a warning per lockfile, so the check
// does not pass without having checked. What is looked up is what the tool installs (decision D-135): for npm the
// registry tarball of resolved, for pnpm the one of resolution.tarball, for Yarn the version of the resolution; an
// entry whose name or version says otherwise gets a warning, and so do the registry entries of a lockfile without an
// exact version. With the local data, a lockfile of an ecosystem without it gets a note, and data older than 7 days
// a note (older than 30 days a warning) per lockfile. Without either the rule only says, once, how to get them, and
// does not apply.
import { linkedIds, osvEcosystem, osvKey, versionLabel, type OsvPackage, type OsvVerdict } from '../../check/osv.ts';
import { listing } from '../../apply/requirements.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { ecosystemOfTool } from '../../policy/ecosystem.ts';
import { hasLockfile, readsLockfile } from '../applies.ts';
import { readLockfiles, type LockEntry, type Lockfile } from '../lockfiles.ts';
import type { OsvLocalEcosystem, Rule, RuleContext } from '../types.ts';

/** What to do when OSV.dev did not answer, in doctor. */
export const OSV_DOCTOR_RETRY_FIX = 'Run depcurfew doctor --osv again when api.osv.dev can be reached; --osv needs HTTPS access to it';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Most registry entries without an exact version that one warning names; the others are counted. */
const MAX_NAMED = 5;

export const knownMalicious: Rule = {
  id: 'known-malicious',
  checks: 'With --osv or the local OSV.dev data of depcurfew osv update: no locked package version is a known malicious version in OSV.dev',
  summary: 'With --osv or the local OSV.dev data of depcurfew osv update: a lockfile locks a package version that OSV.dev lists as malicious.',
  description:
    'Doctor looks up the exact version of every package the lockfiles it reads lock (npm, pnpm, Yarn, Bun and Deno lockfiles, uv.lock, poetry.lock, pdm.lock, Pipfile.lock, pylock.toml, requirements pinned with == and the releases in composer.lock) and reports each version that has a record of the OpenSSF malicious-packages database (an id starting with MAL-): with --osv in api.osv.dev (which then gets the names and versions), else offline in the local OSV.dev data of depcurfew osv update. It looks up what the tool installs (for npm the registry tarball of resolved, for pnpm that of resolution.tarball, for Yarn the resolution); an entry that says otherwise gets a warning, as does a registry entry without an exact version. Local data older than 7 days gives a note; older than 30 days, or in a directory others can write, a warning; OSV.dev out of reach gives a warning. Only reported malware is found, and the database admits false positives. With neither --osv nor local data, a note says how to get them.',
  help: 'Remove or replace the package version and lock again; if it was installed anywhere, read the record on OSV.dev and treat that machine as exposed.',
  level: 'error',
  requiresPolicy: false,
  applies: (scope) => scope.osv !== undefined && !('unavailable' in scope.osv) && hasLockfile(scope),
  check(context) {
    const osv = context.osv;
    if (osv === undefined) return;
    if ('unavailable' in osv) {
      // One note: its text names no file, so the notes of the projects are one (runDoctor keeps one of each text).
      const file = firstLockfile(context);
      if (file !== undefined) context.notice(NO_DATA_MESSAGE, file, NO_DATA_FIX);
      return;
    }
    const local = 'answers' in osv ? osv.local : undefined;
    // The command that checks again: with the local data the same doctor, else doctor --osv.
    const again = local === undefined ? 'depcurfew doctor --osv' : 'depcurfew doctor';
    const checker = local === undefined ? 'doctor --osv' : 'doctor';
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
        const data = local === undefined ? undefined : (local.ecosystems[ecosystem] ?? { status: 'missing' as const });
        if (data !== undefined && data.status !== 'ready') {
          if ('answers' in osv) reportNoLocalData(context, lockfile.file, ecosystem, data);
          continue;
        }
        const seen = new Set<string>();
        const unchecked = new Map<string, number>();
        const unpinned: LockEntry[] = [];
        let locked = 0;
        for (const entry of lockfile.entries) {
          // A release from a registry, also one composer.lock installs from an archive host depcurfew does not recognize
          // or from its VCS source (decision D-141): every entry with a version is looked up.
          if (entry.source !== 'registry' && entry.version === undefined) continue;
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
            // Where the answer comes from (decision D-150): api.osv.dev or the local data.
            source: verdict.source ?? 'osv-api',
            message: `${lockfile.file} locks ${label}, a known malicious version: OSV.dev lists it as ${linkedIds(verdict.malicious)}`,
            fix: `Remove ${label} from the project: update or replace the package and lock again. If it was installed anywhere, read the record on OSV.dev for what it does and treat that machine as exposed`,
          });
        }
        if ('collect' in osv) continue;
        reportUnchecked(context, lockfile.file, locked, unchecked);
        if (data !== undefined && data.status === 'ready' && locked > 0) reportOldData(context, lockfile.file, ecosystem, data);
        if (data !== undefined && data.status === 'ready' && locked > 0 && local?.shared !== undefined) reportSharedData(context, lockfile.file, local.shared);
        const count = unpinned.length;
        if (count > 0 && ecosystem === 'packagist') {
          // composer.lock locks a commit of a branch (dev-main, 1.x-dev); OSV.dev records list releases.
          context.notice(
            `known-malicious did not check ${plural(count, 'package')} of ${lockfile.file}, which locks a branch of ${count === 1 ? 'it' : 'them'} (a dev- or -dev version), not a release`,
            lockfile.file,
            `Require tagged releases of ${count === 1 ? 'this package' : 'these packages'} in composer.json and run composer update, so that ${checker} can check ${count === 1 ? 'it' : 'them'}`,
          );
        } else if (count > 0 && lockfile.requirements === true) {
          // A requirements file may name a range (requests>=2): a note, as README documents.
          context.notice(
            `known-malicious did not check ${plural(count, 'package')} of ${lockfile.file}, which pins no exact version of ${count === 1 ? 'it' : 'them'}`,
            lockfile.file,
            `Pin exact versions (name==version), for example with a lockfile exported by the tool that resolves them, so that ${checker} can check them`,
          );
        } else if (count > 0) {
          reportUnpinned(context, lockfile, tool, unpinned, again);
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
function reportUnpinned(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, entries: readonly LockEntry[], again: string): void {
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
      ? `Lock this package again with ${tool.name}, so that ${lockfile.file} names its exact version, and find out why it does not; then run ${again} again`
      : `Lock these packages again with ${tool.name}, so that ${lockfile.file} names the exact version of each, and find out why it does not; then run ${again} again`,
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

/** The note without --osv and without local data (decision D-150): one for the whole repository. */
export const NO_DATA_MESSAGE = 'known-malicious did not check the locked package versions: there is no local OSV.dev data, and --osv was not given';
export const NO_DATA_FIX =
  'Run depcurfew osv update to download the OSV.dev data of known malicious packages (it requests only the public export files and sends no package names), then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev';

/** The first lockfile (or requirements file of pip) of the directory, from detection: where the note without data stands. */
function firstLockfile(context: RuleContext): string | undefined {
  // Only lockfiles depcurfew reads: it does not look up the gems of Gemfile.lock (decision D-152).
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported && readsLockfile(context.tools, entry.id))) {
    const lockfile = manager.evidence.find((evidence) => evidence.kind === 'lockfile');
    if (lockfile !== undefined) return lockfile.file;
    if (manager.id === 'pip' && manager.configFiles.length > 0) return manager.configFiles[0];
  }
  return undefined;
}

/** A lockfile of an ecosystem whose local data is missing or cannot be read, without --osv (decision D-150). */
function reportNoLocalData(context: RuleContext, file: string, ecosystem: string, data: Exclude<OsvLocalEcosystem, { status: 'ready' }>): void {
  const name = osvEcosystem(ecosystem) ?? ecosystem;
  if (data.status === 'missing') {
    context.notice(
      `known-malicious did not check ${file}: there is no local OSV.dev data for ${name}`,
      file,
      `Run depcurfew osv update --ecosystem ${ecosystem} to download it, then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev`,
    );
    return;
  }
  context.notice(
    `known-malicious did not check ${file}: the local OSV.dev data for ${name} cannot be read (${data.reason})`,
    file,
    `Run depcurfew osv update --ecosystem ${ecosystem} to write it again, then run depcurfew doctor again`,
  );
}

/** Local data in a directory other users can write: a warning per lockfile checked against it (decision D-156). */
function reportSharedData(context: RuleContext, file: string, shared: { reason: string; fix: string }): void {
  context.report({
    level: 'warning',
    location: { file },
    message: `known-malicious checked ${file} against local OSV.dev data that other users may change, so a malicious version may pass: ${shared.reason}`,
    fix: shared.fix,
  });
}

/** Local data older than 7 days: a note per lockfile checked against it; older than 30 days a warning (decision D-150). */
function reportOldData(context: RuleContext, file: string, ecosystem: string, data: Extract<OsvLocalEcosystem, { status: 'ready' }>): void {
  if (data.staleness === 'fresh') return;
  const name = osvEcosystem(ecosystem) ?? ecosystem;
  const message = `known-malicious checked ${file} against the local OSV.dev data for ${name} from ${data.date}, ${plural(data.days, 'day')} old: malicious versions reported since then are not in it`;
  const fix = 'Run depcurfew osv update to download the current data, then run depcurfew doctor again; or run depcurfew doctor --osv to ask api.osv.dev';
  if (data.staleness === 'note') context.notice(message, file, fix);
  else context.report({ level: 'warning', location: { file }, message, fix });
}
