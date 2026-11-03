// What depcurfew init carries into the policy from a repository that is already stricter than the default, or that
// already makes exceptions (decision D-167), so that the first depcurfew apply does not loosen it or drop what the
// project decided without a word: a dependency source an .npmrc denies (sources), a delay of security updates in
// Renovate (cooldown.securityUpdates "delay"), the cooldown exceptions of the tools' own lists (cooldown.exclude) and the
// packages the package managers' own allow-lists let run install scripts (installScripts.allow). Each comes with a note
// that says where it was found, so that the user reviews it before apply. Nothing is written here.
import { join } from 'node:path';
import { configuredExclusions } from '../apply/exclusions.ts';
import { extraOf, settingOf, values } from '../apply/facts.ts';
import { inProject } from '../apply/projects.ts';
import { listing } from '../apply/requirements.ts';
import { Repository } from '../detect/repository.ts';
import { policyName } from '../doctor/allow-lists.ts';
import { matchesEveryName } from '../doctor/renovate.ts';
import { delayMinutes } from '../doctor/durations.ts';
import { knownPackage } from '../doctor/install-script-packages.ts';
import { jsonSetting, readSetting } from '../doctor/settings.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import { SOURCE_KINDS } from '../knowledge/schema.ts';
import { DEFAULT_POLICY, POLICY_FILE } from '../policy/defaults.ts';
import type { InitMessage } from './init-codes.ts';
import { ownAllowed, type ScriptDirectory } from './init-scripts.ts';

/** The most entries one note lists; the rest are counted. */
const MAX_NAMES = 10;

type SourceKind = (typeof SOURCE_KINDS)[number];

export interface KeptSettings {
  /** The sources the default policy allows that the repository denies. */
  sources: Partial<Record<SourceKind, 'deny'>>;
  /** "delay" when Renovate already delays security updates. */
  securityUpdates?: 'delay';
  /** cooldown.exclude, sorted. */
  exclude: string[];
  /** installScripts.allow, sorted. */
  allow: string[];
  notes: InitMessage[];
}

function shortList(items: readonly string[]): string {
  const unique = [...new Set(items)];
  return unique.length <= MAX_NAMES ? listing(unique) : `${unique.slice(0, MAX_NAMES).join(', ')} and ${unique.length - MAX_NAMES} more`;
}

const SOURCE_WORDS: Readonly<Record<SourceKind, string>> = { git: 'git', remoteTarball: 'remote tarball', file: 'local tarball', directory: 'local directory' };

/** A setting of an npm-style source list (allow-file=none) that denies what the default policy allows. */
function deniedSources(directories: readonly (ScriptDirectory & { repository: Repository; shown: (file: string) => string })[]): { sources: KeptSettings['sources']; notes: InitMessage[] } {
  const sources: KeptSettings['sources'] = {};
  const notes: InitMessage[] = [];
  for (const kind of SOURCE_KINDS) {
    if (DEFAULT_POLICY.sources[kind] !== 'allow') continue;
    for (const { detection, repository, shown } of directories) {
      for (const manager of detection.packageManagers.filter((entry) => entry.supported)) {
        const tool = knowledgeBase.find((entry) => entry.id === manager.id);
        const knowledge = tool?.sources?.[kind];
        const setting = settingOf(knowledge?.setting);
        const file = tool === undefined ? undefined : values(tool.cooldown.configFiles)[0]?.[0];
        // npm's allow-file and allow-directory take none, which is what "deny" writes.
        if (setting === null || file === undefined || knowledge?.values === undefined || !(values(knowledge.values)[0] ?? []).includes('none')) continue;
        const found = readSetting(repository, file, setting);
        if (found?.value !== 'none' || sources[kind] !== undefined) continue;
        sources[kind] = 'deny';
        notes.push({
          code: 'sources-kept',
          level: 'note',
          location: { file: shown(found.file), line: found.line },
          message: `sources.${kind} is "deny" instead of "allow", to keep what the repository already sets: ${setting}=none in ${shown(found.file)} (line ${found.line}); depcurfew apply then denies ${SOURCE_WORDS[kind]} dependencies for every package manager it configures`,
          fix: `Leave sources.${kind} as it is to keep them out, or set it to "allow" in ${POLICY_FILE} before you run depcurfew apply`,
        });
      }
    }
  }
  return { sources, notes };
}

/** Renovate's delay of security updates (extra.securityUpdatesSetting), which "bypass" would set to null. */
function securityDelay(directory: ScriptDirectory & { repository: Repository }): { kept: boolean; notes: InitMessage[] } {
  const renovate = knowledgeBase.find((tool) => tool.id === 'renovate');
  const file = directory.detection.bots.find((bot) => bot.id === 'renovate')?.configFiles[0];
  if (renovate?.extra?.['securityUpdatesSetting'] === undefined || file === undefined || !/\.jsonc?$|\.renovaterc$/u.test(file)) return { kept: false, notes: [] };
  const path = extraOf(renovate, 'securityUpdatesSetting', (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'));
  const text = directory.repository.readText(file);
  const found = text === undefined ? undefined : jsonSetting(text, path);
  const delay = found === undefined ? undefined : delayMinutes(renovate, found.value, undefined);
  if (found === undefined || delay?.ok !== true || delay.minutes <= 0) return { kept: false, notes: [] };
  return {
    kept: true,
    notes: [
      {
        code: 'security-delay-kept',
        level: 'note',
        location: { file, line: found.line },
        message: `cooldown.securityUpdates is "delay" instead of "bypass", to keep the delay of security updates already set: ${path.join('.')} ${JSON.stringify(found.value)} in ${file} (line ${found.line}); depcurfew apply then gives security updates the delay of cooldown.minimum`,
        fix: `Leave cooldown.securityUpdates as it is to keep delaying security updates, or set it to "bypass" in ${POLICY_FILE} before you run depcurfew apply`,
      },
    ],
  };
}

/** The settings init carries over from the root and every project it lists (decision D-167). */
export function keptSettings(base: string, directories: readonly ScriptDirectory[]): KeptSettings {
  const read = directories.map((entry) => ({
    ...entry,
    repository: new Repository(entry.project === undefined ? base : join(base, entry.project)),
    shown: (file: string) => (entry.project === undefined ? file : inProject(entry.project, file)),
  }));
  const notes: InitMessage[] = [];
  const { sources, notes: sourceNotes } = deniedSources(read);
  notes.push(...sourceNotes);
  // Bots are configured from the root (decision D-100).
  const root = read.find((entry) => entry.project === undefined);
  const security = root === undefined ? { kept: false, notes: [] } : securityDelay(root);
  notes.push(...security.notes);

  const exclude = new Set<string>();
  const places: string[] = [];
  const unnamed: string[] = [];
  const broad: string[] = [];
  let first: { file: string; line: number } | undefined;
  for (const { detection, repository, shown } of read) {
    for (const exclusion of configuredExclusions(repository, detection, knowledgeBase)) {
      // A pattern that matches every package (@*/*) would turn the delay off in every tool: broad-exclusion reports it
      // where it is, and init does not spread it.
      broad.push(...exclusion.entries.filter((entry) => entry.policy !== undefined && matchesEveryName(entry.policy)).map((entry) => entry.written));
      const named = exclusion.entries.filter((entry) => entry.policy !== undefined && !matchesEveryName(entry.policy));
      for (const entry of named) exclude.add(entry.policy as string);
      unnamed.push(...exclusion.entries.filter((entry) => entry.policy === undefined).map((entry) => entry.written));
      if (named.length === 0) continue;
      const file = shown(exclusion.location.file);
      first ??= { file, line: exclusion.location.line };
      places.push(`${shortList(named.map((entry) => entry.policy as string))} (${exclusion.setting} in ${file}, line ${exclusion.location.line}${exclusion.label === undefined ? '' : `, ${exclusion.label}`})`);
    }
  }
  if (first !== undefined) {
    notes.push({
      code: 'exclusions-kept',
      level: 'note',
      location: first,
      message: `cooldown.exclude lists the packages the repository already exempts from the release-age delay, so that depcurfew apply keeps them: ${places.join('; ')}${unnamed.length === 0 ? '' : `; ${POLICY_FILE} cannot name ${shortList(unnamed)}, which depcurfew apply then removes`}${broad.length === 0 ? '' : `; init leaves out ${shortList(broad)}, which ${broad.length === 1 ? 'matches' : 'match'} every package (depcurfew doctor reports ${broad.length === 1 ? 'it' : 'them'} as broad-exclusion)`}`,
      fix: `Review each one before you run depcurfew apply: cooldown.exclude exempts it in every tool depcurfew configures, so remove the ones that do not need the exception from ${POLICY_FILE}`,
    });
  }

  // The entries of the package managers' own allow-lists (allowBuilds, onlyBuiltDependencies, trustedDependencies,
  // dependenciesMeta, allowScripts), as init-scripts reads them for installScripts.deny (decision D-141).
  const allowed = ownAllowed(base, directories);
  const allow = new Set<string>();
  const labels: string[] = [];
  let at: { file: string; line?: number } | undefined;
  for (const [name, entries] of allowed) {
    for (const entry of entries) allow.add(policyName(entry));
    const where = entries.map((entry) => `${entry.setting} in ${entry.file}${entry.line === undefined ? '' : `, line ${entry.line}`}`).join('; ');
    const known = knownPackage(name);
    labels.push(`${name} (${where}${known === undefined ? '' : '; depcurfew knows it works without its install script, so installScripts.deny may suit it better'})`);
    const [entry] = entries;
    if (entry !== undefined) at ??= entry.line === undefined ? { file: entry.file } : { file: entry.file, line: entry.line };
  }
  if (at !== undefined) {
    notes.push({
      code: 'install-scripts-kept',
      level: 'note',
      location: at,
      message: `installScripts.allow lists the packages that the package managers' own allow-lists already let run install scripts, so that depcurfew apply and depcurfew doctor keep them allowed: ${shortList(labels)}`,
      fix: `Review each one before you run depcurfew apply: installScripts.allow lets it run its install scripts in every tool depcurfew configures, so remove the ones that do not need them from ${POLICY_FILE} and from the package manager's allow-list`,
    });
  }
  return {
    sources,
    ...(security.kept ? { securityUpdates: 'delay' as const } : {}),
    exclude: [...exclude].sort(),
    allow: [...allow].sort(),
    notes,
  };
}
