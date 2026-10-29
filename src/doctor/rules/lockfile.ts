// Lockfile rules. lockfile-forbidden-source: a package from a source depgate.json denies. lockfile-install-scripts:
// a package with install scripts that depgate.json does not allow, where the lockfile records scripts.
import { values } from '../../apply/facts.ts';
import { pinnedVersion } from '../../apply/version.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ScriptPolicy, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { matchesPattern } from '../allow-lists.ts';
import { latestVersion, versionedValue } from '../effective.ts';
import { readLockfiles, type Lockfile, type LockEntry } from '../lockfiles.ts';
import { iniValue, readSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

const LABELS = { git: 'a git repository', remoteTarball: 'a tarball URL', file: 'a local tarball', directory: 'a local directory' } as const;

function eachLockfile(context: RuleContext, rule: string, visit: (lockfile: Lockfile, tool: ToolKnowledge) => void): void {
  const workspaces = context.detection.workspaces?.packages ?? [];
  for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
    const tool = context.tools.find((entry) => entry.id === manager.id);
    if (tool === undefined) continue;
    for (const result of readLockfiles(context.repository, manager, tool, workspaces)) {
      if (result.ok) visit(result.lockfile, tool);
      // An unreadable lockfile is an error of unreadable-config.
      else if (!result.unreadable) context.notice(`${rule} could not check ${result.file}: ${result.reason}`, result.file);
    }
  }
}

function location(lockfile: Lockfile, entry: LockEntry): { file: string; line?: number } {
  const line = lockfile.lineOf(entry);
  return line === undefined ? { file: lockfile.file } : { file: lockfile.file, line };
}

export const lockfileForbiddenSource: Rule = {
  id: 'lockfile-forbidden-source',
  summary: 'The lockfile installs a package from a source depgate.json denies.',
  description:
    'A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.',
  help: 'Replace the dependency with a registry version, or allow that source in depgate.json.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const sources = context.policy?.sources;
    if (sources === undefined) return;
    const denies = Object.values(sources).includes('deny');
    eachLockfile(context, 'lockfile-forbidden-source', (lockfile) => {
      for (const entry of lockfile.entries) {
        if (entry.source === 'unknown' && denies) {
          // Fail closed: a source depgate cannot recognise may be one the policy denies.
          context.report({
            level: 'warning',
            location: location(lockfile, entry),
            message: `${lockfile.file} installs ${entry.name} from a source depgate does not recognise (${entry.spec || 'no source given'}); it may be one ${POLICY_FILE} denies`,
            fix: `Check where ${entry.name} comes from, and regenerate the lockfile with the package manager if the entry is damaged`,
          });
          continue;
        }
        if (entry.source !== 'git' && entry.source !== 'remoteTarball' && entry.source !== 'file' && entry.source !== 'directory') continue;
        if (sources[entry.source] !== 'deny') continue;
        context.report({
          location: location(lockfile, entry),
          message: `${lockfile.file} installs ${entry.name} from ${LABELS[entry.source]} (${entry.spec}), which ${POLICY_FILE} denies`,
          fix: `Use a registry version of ${entry.name}, or set sources.${entry.source} to "allow" in ${POLICY_FILE}`,
        });
      }
    });
  },
};

/** Whether the version in use runs dependency install scripts without an allow-list, under any official reading. */
function runsScripts(context: RuleContext, tool: ToolKnowledge): boolean {
  const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
  const version = (manager === undefined ? undefined : pinnedVersion(manager)) ?? latestVersion(tool);
  return evidenceOf(tool.installScripts.defaultPolicy).some((evidence) => {
    const policy: ScriptPolicy | undefined = versionedValue(evidence.value, version);
    return policy === 'run' || policy === 'run-with-warning';
  });
}

/** Where the repository turns off every dependency script with the tool's own switch (e.g. ignore-scripts in .npmrc). */
function scriptsDisabledBy(context: RuleContext, tool: ToolKnowledge): string | undefined {
  const fact = tool.installScripts.disableAll;
  const value = fact.status === 'verified' ? fact.value : undefined;
  const match = typeof value === 'string' ? /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value) : null;
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (match === null || file === undefined) return undefined;
  const [, key = '', expected] = match;
  const found = readSetting(context.repository, file, key);
  return found !== undefined && found.value === (expected === undefined ? true : iniValue(expected)) ? `${key} in ${file}` : undefined;
}

export const lockfileInstallScripts: Rule = {
  id: 'lockfile-install-scripts',
  summary: 'The lockfile has packages with install scripts that depgate.json does not allow.',
  description:
    'Install scripts run arbitrary code during installation. Where the package manager runs them by default, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile.',
  help: 'Remove or replace the package, or add it to installScripts.allow in depgate.json after reviewing its scripts.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const scripts = context.policy?.installScripts;
    if (scripts?.default !== 'deny') return;
    eachLockfile(context, 'lockfile-install-scripts', (lockfile, tool) => {
      if (!lockfile.recordsScripts) {
        context.notice(`lockfile-install-scripts could not check ${lockfile.file}: ${tool.name} does not record install scripts in it`, lockfile.file);
        return;
      }
      const flagged = lockfile.entries.filter((entry) => entry.installScript === true);
      if (flagged.length === 0 && tool.id === 'bun') {
        context.notice(`${lockfile.file} marks no package with install scripts; Bun records them only since 1.4.4, so an older lockfile may hide some`, lockfile.file);
      }
      const disabledBy = scriptsDisabledBy(context, tool);
      const running = disabledBy === undefined && runsScripts(context, tool);
      for (const entry of flagged) {
        if (scripts.allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
        context.report({
          level: running ? 'error' : 'warning',
          location: location(lockfile, entry),
          message: running
            ? `${entry.name} has install scripts and ${tool.name} runs them by default, but ${POLICY_FILE} does not allow it`
            : disabledBy === undefined
              ? `${entry.name} has install scripts that ${tool.name} will not run because ${POLICY_FILE} does not allow it; the package may need them`
              : `${entry.name} has install scripts that ${tool.name} will not run because ${disabledBy} turns them off; the package may need them`,
          fix: `Review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}, or replace the package`,
        });
      }
    });
  },
};
