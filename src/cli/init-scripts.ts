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
import { checkedOut, checkoutsByPreference, COMPOSER_MANIFEST, composerManifest, isComposerName, listedCheckouts, pluginDecision, preferenceChange, preferenceLine } from '../doctor/composer.ts';
import { keepFix, knownPackageOf, knownPackages, versionNote, withoutScript } from '../doctor/install-script-packages.ts';
import { allowEntries, type AllowEntry } from '../doctor/allow-lists.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import { pinnedVersion } from '../apply/version.ts';
import { COMPOSER_PREFIX } from '../policy/package-pattern.ts';
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
function knownNote(known: InstallScriptPackageKnowledge, entry: LockEntry, lockfile: Lockfile, shown: string, tool: ToolKnowledge): InitMessage {
  const line = lockfile.lineOf(entry);
  const location = located(shown, line);
  const what = known.kind === 'project-task' ? 'that only does a task of the project' : 'that it does not need';
  // The line in the message too, as the text of init shows no location (decision D-141).
  const message = `${known.name} in ${shown}${line === undefined ? '' : ` (line ${line})`} has an install script (${known.script}) ${what}, so init adds it to installScripts.deny: ${known.does}; ${withoutScript(known)}${versionNote(known, entry.version, shown)}`;
  const fix = keepFix(known, tool);
  return known.kind === 'project-task'
    ? { code: 'install-script-project-task', level: 'note', location, message, fix }
    : { code: 'install-script-denied', level: 'note', location, message, fix };
}

/**
 * The entries of the package managers' own allow-lists (onlyBuiltDependencies, allowBuilds, allowScripts...) of every
 * directory, by package: a known package one of them already lets run its install script is not denied, since
 * installScripts.deny would contradict the project's own decision (decision D-141), and init lists every one of them in
 * installScripts.allow (decision D-167).
 */
export function ownAllowed(base: string, directories: readonly ScriptDirectory[]): Map<string, AllowEntry[]> {
  const allowed = new Map<string, AllowEntry[]>();
  for (const { project, detection } of directories) {
    const repository = new Repository(project === undefined ? base : join(base, project));
    for (const manager of detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = knowledgeBase.find((entry) => entry.id === manager.id);
      if (tool === undefined || ecosystemOfTool(tool) !== 'npm') continue;
      const version = pinnedVersion(manager);
      for (const entry of allowEntries(repository, manager.id, manager.configFiles, { tool, ...(version === undefined ? {} : { version }) })) {
        const file = project === undefined ? entry.file : inProject(project, entry.file);
        allowed.set(entry.package, [...(allowed.get(entry.package) ?? []), { ...entry, file }]);
      }
    }
  }
  return allowed;
}

/**
 * The packages to deny and the notes about install scripts, for the root and every listed project. A package of
 * several lockfiles is denied and noted once, at the first one; a known package that a package manager's own
 * allow-list already allows is not denied (decision D-141) but goes into installScripts.allow with the others of those
 * lists, which the note install-scripts-kept names (decision D-167).
 */
export function installScriptHints(base: string, directories: readonly ScriptDirectory[]): ScriptHints {
  const deny = new Set<string>();
  const notes: InitMessage[] = [];
  const review: InitMessage[] = [];
  const allowedByProject = ownAllowed(base, directories);
  for (const { project, detection } of directories) {
    const repository = new Repository(project === undefined ? base : join(base, project));
    const shownFile = (file: string) => (project === undefined ? file : inProject(project, file));
    const workspaces = detection.workspaces?.packages ?? [];
    for (const manager of detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = knowledgeBase.find((entry) => entry.id === manager.id);
      if (tool !== undefined && tool.id === 'composer') {
        review.push(...composerPlugins(repository, manager, tool, shownFile));
        continue;
      }
      if (tool === undefined || ecosystemOfTool(tool) !== 'npm') continue;
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
          // What depcurfew knows holds for the package from a registry only (decision D-135).
          const known = knownPackageOf(entry);
          if (known === undefined) {
            unknown += 1;
            // A package an allow-list of the project lets run its scripts goes into installScripts.allow (decision D-167).
            if (entry.installScript === true && !allowedByProject.has(entry.name)) others.push(entry.name);
            continue;
          }
          if (allowedByProject.has(known.name)) continue;
          if (deny.has(known.name)) continue;
          deny.add(known.name);
          notes.push(knownNote(known, entry, lockfile, shown, tool));
        }
        // Bun records install scripts in bun.lock only since a version (extra.lockfileFormat.installScriptsSince), so a
        // lockfile that marks none may be older, as doctor says too (decision D-167).
        const since = tool.id === 'bun' ? scriptsSince(tool) : undefined;
        if (!lockfile.recordsScripts) {
          if (unknown > 0) review.push(notRecorded(shown, `${tool.name} does not record install scripts in it`, tool));
        } else if (since !== undefined && lockfile.entries.some((entry) => entry.source !== 'workspace') && !lockfile.entries.some((entry) => entry.installScript === true)) {
          review.push(notRecorded(shown, `it marks no package with install scripts, and ${tool.name} records them only since ${since}, so an older lockfile may hide some`, tool));
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

/**
 * The Composer plugins of composer.lock, which installScripts.default "deny" blocks (decision D-136): one note per
 * lockfile with their names as the policy writes them, and for each that config.allow-plugins of composer.json already
 * allows, that it does, so that the user reviews it and adds it to installScripts.allow before apply.
 */
function composerPlugins(repository: Repository, manager: Detection['packageManagers'][number], tool: ToolKnowledge, shownFile: (file: string) => string): InitMessage[] {
  const notes: InitMessage[] = [];
  const manifest = composerManifest(repository);
  for (const result of readLockfiles(repository, manager, tool, [], knowledgeBase)) {
    if (!result.ok) continue;
    const { lockfile } = result;
    const plugins = lockfile.entries.filter((entry) => entry.installScript === true);
    if (plugins.length === 0) continue;
    const shown = shownFile(lockfile.file);
    const named = [...new Set(plugins.map((entry) => entry.name))].map((name) => {
      const label = isComposerName(name) ? `${COMPOSER_PREFIX}${name}` : name;
      const decision = pluginDecision(manifest, name);
      return decision.allowed === true && decision.key !== undefined ? `${label} (config.allow-plugins in ${shownFile(COMPOSER_MANIFEST)} allows it)` : label;
    });
    const one = named.length === 1;
    notes.push({
      code: 'install-scripts-to-review',
      level: 'note',
      location: { file: shown },
      message: `${shown} has ${one ? 'a Composer plugin' : 'Composer plugins'}, whose code runs during Composer commands, that installScripts.default "deny" blocks: ${names(named)}`,
      fix: `Review each one before you run depcurfew apply: add it to installScripts.allow in ${POLICY_FILE} if the project needs it (as ${COMPOSER_PREFIX}vendor/name), or to installScripts.deny if it works without it; depcurfew apply then writes config.allow-plugins from ${POLICY_FILE}`,
    });
  }
  return notes;
}

/**
 * The packages of composer.lock that config.preferred-install of composer.json makes Composer check out of their VCS
 * repositories, which sources.git "deny" of the policy init writes does not allow (decision D-138): one note per entry
 * of the setting, at its line in composer.json, so that the first doctor after init and apply has no unexplained error.
 */
export function composerCheckoutNotes(base: string, directories: readonly ScriptDirectory[]): InitMessage[] {
  const notes: InitMessage[] = [];
  for (const { project, detection } of directories) {
    const repository = new Repository(project === undefined ? base : join(base, project));
    const shownFile = (file: string) => (project === undefined ? file : inProject(project, file));
    for (const manager of detection.packageManagers.filter((entry) => entry.supported && entry.id === 'composer')) {
      const tool = knowledgeBase.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      for (const result of readLockfiles(repository, manager, tool, [], knowledgeBase)) {
        if (!result.ok) continue;
        const { lockfile } = result;
        const manifest = shownFile(COMPOSER_MANIFEST);
        const shownLock = shownFile(lockfile.file);
        for (const { preference, entries } of checkoutsByPreference(lockfile.entries)) {
          // The file of the project and the line, in the message too (decision D-141).
          const line = preferenceLine(repository.readText(COMPOSER_MANIFEST), preference);
          notes.push({
            code: 'composer-source-checkouts',
            level: 'note',
            location: located(manifest, line),
            message: `config.preferred-install in ${manifest}${line === undefined ? '' : ` (line ${line})`} ${preference.cause}, so Composer installs ${checkedOut(entries.length, shownLock)}, which sources.git "deny" in ${POLICY_FILE} does not allow, and depcurfew doctor reports it (lockfile-forbidden-source): ${listedCheckouts(entries, (entry) => lockfile.lineOf(entry), MAX_NAMES)}`,
            fix: `${preferenceChange(preference, manifest)}; or, if the project installs them from source on purpose, set sources.git to "allow" in ${POLICY_FILE} before you run depcurfew apply`,
          });
        }
      }
    }
  }
  return notes;
}

/** The version since which the tool records install scripts in its lockfile (extra.lockfileFormat), if it says. */
function scriptsSince(tool: ToolKnowledge): string | undefined {
  const fact = tool.extra?.['lockfileFormat'];
  const format = fact === undefined ? undefined : evidenceOf(fact)[0]?.value;
  const since = typeof format === 'object' && format !== null ? (format as Record<string, unknown>)['installScriptsSince'] : undefined;
  return typeof since === 'string' ? since : undefined;
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
