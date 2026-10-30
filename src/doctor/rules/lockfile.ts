// Lockfile rules. lockfile-forbidden-source: a package from a source depcurfew.json denies. lockfile-install-scripts:
// a package with install scripts that depcurfew.json does not allow, where the lockfile records scripts.
import { extraOf, isSwitch, values } from '../../apply/facts.ts';
import { pinnedVersion } from '../../apply/version.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ScriptPolicy, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { PYPI_PREFIX } from '../../policy/package-pattern.ts';
import { normalizePythonName } from '../../policy/python-names.ts';
import { matchesPattern } from '../allow-lists.ts';
import { latestVersion, versionedValue } from '../effective.ts';
import { readLockfiles, type Lockfile, type LockEntry, type Source } from '../lockfiles.ts';
import { readPythonSetting, requirementsOptions } from '../python.ts';
import { iniValue, readSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

const LABELS = {
  npm: { git: 'a git repository', remoteTarball: 'a tarball URL', file: 'a local tarball', directory: 'a local directory' },
  pypi: { git: 'a git repository', remoteTarball: 'a URL', file: 'a local archive', directory: 'a local directory' },
} as const;

/** Why a Python package is built from source, for messages. */
const BUILT_FROM: Record<Source, string> = {
  registry: 'its index has only a source distribution',
  git: 'it comes from a git repository',
  remoteTarball: 'it is a source archive at a URL',
  file: 'it is a local source archive',
  directory: 'it is a local directory',
  workspace: 'it is part of the workspace',
  unknown: 'its source is not recognized',
};

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
  summary: 'The lockfile installs a package from a source depcurfew.json denies.',
  description:
    'A git repository, a tarball URL or a local path bypasses the registry and its checks (release age, provenance, integrity from the registry). The lockfile shows what installs really fetch, whatever the package manager settings say.',
  help: 'Replace the dependency with a registry version, or allow that source in depcurfew.json.',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const sources = context.policy?.sources;
    if (sources === undefined) return;
    const denies = Object.values(sources).includes('deny');
    eachLockfile(context, 'lockfile-forbidden-source', (lockfile, tool) => {
      for (const entry of lockfile.entries) {
        if (entry.source === 'unknown' && denies) {
          // Fail closed: a source depcurfew cannot recognize may be one the policy denies.
          context.report({
            level: 'warning',
            location: location(lockfile, entry),
            message: `${lockfile.file} installs ${entry.name} from a source depcurfew does not recognize (${shownSpec(entry.spec) || 'no source given'}); it may be one ${POLICY_FILE} denies`,
            fix: `Check where ${entry.name} comes from, and regenerate the lockfile with the package manager if the entry is damaged`,
          });
          continue;
        }
        if (entry.source !== 'git' && entry.source !== 'remoteTarball' && entry.source !== 'file' && entry.source !== 'directory') continue;
        if (sources[entry.source] !== 'deny') continue;
        context.report({
          location: location(lockfile, entry),
          message: `${lockfile.file} installs ${entry.name} from ${LABELS[ecosystemOfTool(tool)][entry.source]} (${shownSpec(entry.spec)}), which ${POLICY_FILE} denies`,
          fix: `Use a registry version of ${entry.name}, or set sources.${entry.source} to "allow" in ${POLICY_FILE}`,
        });
      }
    });
  },
};

/** A lockfile spec for messages, without Yarn's locator parameters (::hash=…&locator=…) and repeated local paths. */
function shownSpec(spec: string): string {
  const text = spec.split('::')[0] ?? spec;
  const hash = text.indexOf('#');
  return /^(?:file|portal|link):/u.test(text) && hash !== -1 ? text.slice(0, hash) : text;
}

/** Whether the version in use runs dependency install scripts without an allow-list, under any official reading. */
function runsScripts(context: RuleContext, tool: ToolKnowledge): boolean {
  const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
  const version = (manager === undefined ? undefined : pinnedVersion(manager)) ?? latestVersion(tool);
  return evidenceOf(tool.installScripts.defaultPolicy).some((evidence) => {
    const policy: ScriptPolicy | undefined = versionedValue(evidence.value, version);
    return policy === 'run' || policy === 'run-with-warning';
  });
}

/**
 * How the repository keeps dependency scripts from running with the tool's own switch: ignore-scripts in .npmrc turns
 * them all off, strict-allow-scripts makes the install fail on scripts that are not allowed.
 */
function scriptsDisabledBy(context: RuleContext, tool: ToolKnowledge): string | undefined {
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (file === undefined) return undefined;
  const fact = tool.installScripts.disableAll;
  const value = fact.status === 'verified' ? fact.value : undefined;
  const match = typeof value === 'string' ? /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value) : null;
  if (match !== null) {
    const [, key = '', expected] = match;
    const found = readSetting(context.repository, file, key);
    if (found !== undefined && found.value === (expected === undefined ? true : iniValue(expected))) return `${key} in ${file} turns them off`;
  }
  const strict = tool.extra?.['strictAllowScripts'] === undefined ? undefined : extraOf(tool, 'strictAllowScripts', isSwitch);
  if (strict !== undefined && readSetting(context.repository, file, strict.setting)?.value === strict.value) {
    return `${strict.setting} in ${file} stops the install until they are allowed`;
  }
  return undefined;
}

/**
 * Whether the repository forbids building Python packages from source with the tool's switch (no-build in uv,
 * installer.only-binary in Poetry, --only-binary=:all: in a requirements file for pip), and where.
 */
function buildsForbiddenBy(context: RuleContext, tool: ToolKnowledge, lockfile: Lockfile): string | undefined {
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  if (build === undefined) return undefined;
  if (tool.id === 'pip') {
    const files = lockfile.file.endsWith('.toml') ? [] : [lockfile.file];
    const found = files.find((file) => requirementsOptions(context.repository, file).some((line) => line.option === build.setting && line.value === build.value));
    return found === undefined ? undefined : `${build.setting}=${String(build.value)} in ${found} forbids building`;
  }
  const found = readPythonSetting(context.repository, tool, build.setting);
  const wanted = JSON.stringify(build.value);
  return found !== undefined && (JSON.stringify(found.value) === wanted || (Array.isArray(found.value) && Array.isArray(build.value) && build.value.every((item) => (found.value as unknown[]).includes(item))))
    ? `${build.setting} in ${found.file} forbids building`
    : undefined;
}

function reportPythonBuilds(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, allow: readonly string[]): void {
  const forbiddenBy = buildsForbiddenBy(context, tool, lockfile);
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  const covers = build?.covers ?? [];
  const patterns = allow.map(normalizePythonName);
  for (const entry of lockfile.entries) {
    if (entry.installScript !== true || entry.source === 'workspace') continue;
    if (patterns.some((pattern) => matchesPattern(entry.name, pattern))) continue;
    const stopped = forbiddenBy !== undefined && covers.includes(entry.source);
    context.report({
      level: stopped ? 'warning' : 'error',
      location: location(lockfile, entry),
      message: stopped
        ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy}, so installing it fails until it is allowed`
        : forbiddenBy === undefined
          ? `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} does not allow it`
          : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code: ${forbiddenBy} only for packages from an index, and ${POLICY_FILE} does not allow it`,
      fix: `Review ${entry.name} and add "${PYPI_PREFIX}${entry.name}" to installScripts.allow in ${POLICY_FILE} (it is then always built from source), or replace the package`,
    });
  }
}

export const lockfileInstallScripts: Rule = {
  id: 'lockfile-install-scripts',
  summary: 'The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.',
  description:
    'Install scripts run arbitrary code during installation, and so does building a Python package from source (a source distribution, a git repository or a local directory). Where the package manager runs them by default, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile; uv.lock, poetry.lock and pylock.toml show which Python packages have no wheel.',
  help: 'Remove or replace the package, or add it to installScripts.allow in depcurfew.json after reviewing it (Python packages with the prefix pypi:).',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const policy = context.policy;
    if (policy?.installScripts?.default !== 'deny') return;
    eachLockfile(context, 'lockfile-install-scripts', (lockfile, tool) => {
      const allow = policyFor(policy, ecosystemOfTool(tool)).installScripts?.allow ?? [];
      if (ecosystemOfTool(tool) === 'pypi') {
        reportPythonBuilds(context, lockfile, tool, allow);
        return;
      }
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
        if (allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
        context.report({
          level: running ? 'error' : 'warning',
          location: location(lockfile, entry),
          message: running
            ? `${entry.name} has install scripts and ${tool.name} runs them by default, but ${POLICY_FILE} does not allow it`
            : disabledBy === undefined
              ? `${entry.name} has install scripts that ${tool.name} will not run because ${POLICY_FILE} does not allow it; the package may need them`
              : `${entry.name} has install scripts that ${tool.name} will not run because ${disabledBy}; the package may need them`,
          fix: `Review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}, or replace the package`,
        });
      }
    });
  },
};
