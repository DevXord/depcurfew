// What init writes into installScripts.deny and says about install scripts (decision D-127): the packages of the
// lockfiles whose scripts depcurfew knows (environment.installScriptPackages) go into installScripts.deny, each with a
// note that says why and what changes; the other packages with install scripts are listed in a note to review, and a
// lockfile that does not record install scripts gets a note too, so nothing the default "deny" blocks goes unsaid. The
// lockfiles are read as lockfile-install-scripts reads them (src/doctor/lockfiles.ts); nothing is run, and the scripts
// of package.json are never edited.
import { join } from 'node:path';
import { inProject } from '../apply/projects.ts';
import { listing } from '../apply/requirements.ts';
import { Repository } from '../detect/repository.ts';
import type { Detection } from '../detect/types.ts';
import { allScriptsOffBy, keepFix, knownPackage, knownPackages, versionNote, withoutScript } from '../doctor/install-script-packages.ts';
import { readLockfiles, type Lockfile, type LockEntry } from '../doctor/lockfiles.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { InstallScriptPackageKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { POLICY_FILE } from '../policy/defaults.ts';
import { ecosystemOfTool } from '../policy/ecosystem.ts';
import type { InitMessage } from './init-codes.ts';

/** The most package names one note lists; the rest are counted. */
const MAX_NAMES = 10;

export interface ScriptHints {
  /** The packages init writes into installScripts.deny, in the order of the knowledge base. */
  deny: string[];
  notes: InitMessage[];
}

/** A directory init looks at: the root (no project) or a directory it lists under projects. */
export interface ScriptDirectory {
  project?: string;
  detection: Detection;
}

function names(items: readonly string[]): string {
  const unique = [...new Set(items)];
  return unique.length <= MAX_NAMES ? listing(unique) : `${unique.slice(0, MAX_NAMES).join(', ')} and ${unique.length - MAX_NAMES} more`;
}

function located(file: string, line: number | undefined): { file: string; line?: number } {
  return line === undefined ? { file } : { file, line };
}

/** The note for a known package init denies: why it does not need its script, and what changes without it. */
function knownNote(known: InstallScriptPackageKnowledge, entry: LockEntry, lockfile: Lockfile, shown: string, tool: ToolKnowledge, manifest: string, scriptsOff: string | undefined): InitMessage {
  const location = located(shown, lockfile.lineOf(entry));
  const what = known.kind === 'project-task' ? 'that only does a task of the project' : 'that it does not need';
  const message = `${known.name} in ${shown} has an install script (${known.script}) ${what}, so init adds it to installScripts.deny: ${known.does}; ${withoutScript(known)}${versionNote(known, entry.version, shown)}`;
  const fix = keepFix(known, tool, { manifest, ...(scriptsOff === undefined ? {} : { scriptsOff }) });
  return known.kind === 'project-task'
    ? { code: 'install-script-project-task', level: 'note', location, message, fix }
    : { code: 'install-script-denied', level: 'note', location, message, fix };
}

/**
 * The packages to deny and the notes about install scripts, for the root and every listed project. A package of
 * several lockfiles is denied and noted once, at the first one.
 */
export function installScriptHints(base: string, directories: readonly ScriptDirectory[]): ScriptHints {
  const deny = new Set<string>();
  const notes: InitMessage[] = [];
  const review: InitMessage[] = [];
  for (const { project, detection } of directories) {
    const repository = new Repository(project === undefined ? base : join(base, project));
    const shownFile = (file: string) => (project === undefined ? file : inProject(project, file));
    const workspaces = detection.workspaces?.packages ?? [];
    for (const manager of detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = knowledgeBase.find((entry) => entry.id === manager.id);
      if (tool === undefined || ecosystemOfTool(tool) !== 'npm') continue;
      const scriptsOff = allScriptsOffBy(repository, tool);
      for (const result of readLockfiles(repository, manager, tool, workspaces, knowledgeBase)) {
        if (!result.ok) {
          // An unreadable lockfile is reported by doctor (unreadable-config); a format depcurfew does not read is said here.
          if (!result.unreadable) review.push(notRecorded(shownFile(result.file), result.reason, tool));
          continue;
        }
        const { lockfile } = result;
        const shown = shownFile(lockfile.file);
        const others: string[] = [];
        // Packages depcurfew does not know, whose scripts a lockfile without records cannot show.
        let unknown = 0;
        for (const entry of lockfile.entries) {
          if (entry.source === 'workspace' || entry.installScript === false || entry.unnamed === true) continue;
          const known = knownPackage(entry.name);
          if (known === undefined) {
            unknown += 1;
            if (entry.installScript === true) others.push(entry.name);
            continue;
          }
          if (deny.has(known.name)) continue;
          deny.add(known.name);
          notes.push(knownNote(known, entry, lockfile, shown, tool, shownFile('package.json'), scriptsOff));
        }
        if (!lockfile.recordsScripts) {
          if (unknown > 0) review.push(notRecorded(shown, `${tool.name} does not record install scripts in it`, tool));
        } else if (others.length > 0) {
          review.push({
            code: 'install-scripts-to-review',
            level: 'note',
            location: { file: shown },
            message: `${shown} has packages with install scripts that installScripts.default "deny" blocks and depcurfew does not know: ${names(others)}`,
            fix: `Review each one before you run depcurfew apply: add it to installScripts.allow in ${POLICY_FILE} if it needs its scripts, or to installScripts.deny if it works without them (depcurfew doctor lists them with their lines in ${shown})`,
          });
        }
      }
    }
  }
  // The order of the knowledge base, so that the policy does not depend on the order of the lockfiles.
  return { deny: knownPackages().map((known) => known.name).filter((name) => deny.has(name)), notes: [...notes, ...review] };
}

/** A lockfile from which init cannot tell which packages have install scripts. */
function notRecorded(shown: string, reason: string, tool: ToolKnowledge): InitMessage {
  return {
    code: 'install-scripts-not-recorded',
    level: 'note',
    location: { file: shown },
    message: `init cannot tell from ${shown} which packages have install scripts (${reason}), so it names only the packages depcurfew knows, and installScripts.default "deny" blocks the scripts of the others`,
    fix: `Install once and review the packages whose install scripts ${tool.name} skips or stops at: add each to installScripts.allow in ${POLICY_FILE} if it needs them, or to installScripts.deny if it works without them`,
  };
}
