// Lockfile rules. lockfile-forbidden-source: a package from a source depcurfew.json denies. lockfile-install-scripts:
// a package with install scripts that depcurfew.json does not allow, where the lockfile records scripts.
import { extraOf, isRecord, isSwitch, sinceOf, values } from '../../apply/facts.ts';
import { compareVersions, parseVersion, pinnedVersion } from '../../apply/version.ts';
import { evidenceOf } from '../../knowledge/facts.ts';
import type { ScriptPolicy, ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import { PYPI_PREFIX } from '../../policy/package-pattern.ts';
import { normalizePythonName } from '../../policy/python-names.ts';
import { allowEntries, denyEntries, matchesPattern, type AllowEntry } from '../allow-lists.ts';
import { latestVersion, versionedValue } from '../effective.ts';
import { readLockfiles, type Lockfile, type LockEntry, type Source } from '../lockfiles.ts';
import { requirementsFormatOf } from '../python-lockfiles.ts';
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
    for (const result of readLockfiles(context.repository, manager, tool, workspaces, context.tools)) {
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
          message: `${lockfile.file} installs ${entry.unnamed === true ? 'a package' : entry.name} from ${LABELS[ecosystemOfTool(tool)][entry.source]} (${shownSpec(entry.spec)}), which ${POLICY_FILE} denies`,
          fix: `Use a registry version ${entry.unnamed === true ? 'instead' : `of ${entry.name}`}, or set sources.${entry.source} to "allow" in ${POLICY_FILE}`,
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
 * them all off (`all`), strict-allow-scripts makes the install fail on scripts that are not allowed, while the
 * packages of the allow-list still run theirs.
 */
function scriptsDisabledBy(context: RuleContext, tool: ToolKnowledge): { reason: string; all: boolean } | undefined {
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (file === undefined) return undefined;
  const fact = tool.installScripts.disableAll;
  const value = fact.status === 'verified' ? fact.value : undefined;
  const match = typeof value === 'string' ? /^([\w.-]+)(?::\s*(\S+))?$/u.exec(value) : null;
  if (match !== null) {
    const [, key = '', expected] = match;
    const found = readSetting(context.repository, file, key);
    if (found !== undefined && found.value === (expected === undefined ? true : iniValue(expected))) return { reason: `${key} in ${file} turns them off`, all: true };
  }
  const strict = tool.extra?.['strictAllowScripts'] === undefined ? undefined : extraOf(tool, 'strictAllowScripts', isSwitch);
  if (strict !== undefined && readSetting(context.repository, file, strict.setting)?.value === strict.value) {
    return { reason: `${strict.setting} in ${file} stops the install until they are allowed`, all: false };
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
    const format = requirementsFormatOf(tool);
    // The options of the requirements file pip is given, and of the files it includes, apply to the whole install.
    const files = lockfile.optionFiles ?? [];
    const found = files.find((file) => requirementsOptions(context.repository, file, format).some((line) => line.option === build.setting && line.value === build.value));
    return found === undefined ? undefined : `${build.setting}=${String(build.value)} in ${found} forbids building`;
  }
  const found = readPythonSetting(context.repository, tool, build.setting);
  return found !== undefined && switchIsOn(found.value, build.value) ? `${build.setting} in ${found.file} forbids building` : undefined;
}

/**
 * Whether a configured value turns the build switch on. A list switch (Poetry's [":all:"]) is also on when written as
 * a comma-separated string or as true, which Poetry reads as the same thing.
 */
function switchIsOn(value: unknown, wanted: unknown): boolean {
  if (!Array.isArray(wanted)) return value === wanted;
  const items = value === true ? wanted : typeof value === 'string' ? value.split(',').map((item) => item.trim()) : Array.isArray(value) ? value : [];
  return wanted.every((item) => items.includes(item));
}

/** Dependencies a tool builds whatever its settings say, when its build switch does not cover their source. */
const ALWAYS_BUILT: Record<Source, string> = {
  registry: 'source distributions from an index',
  git: 'git dependencies',
  remoteTarball: 'source archives from a URL',
  file: 'local source archives',
  directory: 'local directory dependencies',
  workspace: 'workspace members',
  unknown: 'dependencies from this source',
};

function reportPythonBuilds(context: RuleContext, lockfile: Lockfile, tool: ToolKnowledge, allow: readonly string[], deny: readonly string[]): void {
  const forbiddenBy = buildsForbiddenBy(context, tool, lockfile);
  const build = tool.extra?.['buildSwitch'] === undefined ? undefined : extraOf(tool, 'buildSwitch', isSwitch);
  const covers = build?.covers ?? [];
  const patterns = allow.map(normalizePythonName);
  const denied = deny.map(normalizePythonName);
  for (const entry of lockfile.entries) {
    if (entry.installScript !== true || entry.source === 'workspace') continue;
    if (entry.unnamed !== true && patterns.some((pattern) => matchesPattern(entry.name, pattern))) continue;
    const stopped = forbiddenBy !== undefined && covers.includes(entry.source);
    if (entry.unnamed !== true && denied.some((pattern) => matchesPattern(entry.name, pattern))) {
      // Denied on purpose: never built from source. Where the tool still builds it, the policy is broken; where it
      // refuses, installing fails, which the owner should still see. Every tool can stop building source
      // distributions from an index (Pipenv through PIP_ONLY_BINARY), but other sources only where the switch covers them.
      const stoppable = entry.source === 'registry' || covers.includes(entry.source);
      const label = `"${PYPI_PREFIX}${entry.name}"`;
      context.report({
        level: stopped ? 'warning' : 'error',
        location: location(lockfile, entry),
        message: stopped
          ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy} and ${POLICY_FILE} denies it, so installing it fails`
          : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} denies it${stoppable ? '' : `, and ${tool.name} builds ${ALWAYS_BUILT[entry.source]} whatever its settings say`}`,
        fix: stopped
          ? `Replace ${entry.name} with a package that has wheels, or remove ${label} from installScripts.deny and add it to installScripts.allow after reviewing it`
          : stoppable
            ? `Make ${tool.name} stop building it (run depcurfew apply and follow its warnings), or replace the package`
            : `Replace ${entry.name} with a registry release that has wheels, or move ${label} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing it`,
      });
      continue;
    }
    const fix =
      entry.unnamed === true
        ? `Give the requirement a package name (name @ ${entry.spec}) so that it can be allowed with "${PYPI_PREFIX}name" in installScripts.allow in ${POLICY_FILE}, or remove it`
        : `Review ${entry.name} and add "${PYPI_PREFIX}${entry.name}" to installScripts.allow in ${POLICY_FILE} (it is then always built from source), or replace the package`;
    context.report({
      level: stopped ? 'warning' : 'error',
      location: location(lockfile, entry),
      message: stopped
        ? `${entry.name} has to be built from source (${BUILT_FROM[entry.source]}), but ${forbiddenBy}, so installing it fails until it is allowed`
        : forbiddenBy === undefined
          ? `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code, but ${POLICY_FILE} does not allow it`
          : `${entry.name} is built from source when installed (${BUILT_FROM[entry.source]}), which runs its build code: ${forbiddenBy} only for packages from an index, and ${POLICY_FILE} does not allow it`,
      fix,
    });
  }
}

export const lockfileInstallScripts: Rule = {
  id: 'lockfile-install-scripts',
  summary: 'The lockfile has packages with install scripts, or Python packages built from source, that depcurfew.json does not allow.',
  description:
    'Install scripts run arbitrary code during installation, and so does building a Python package from source (a source distribution, a git repository or a local directory). Where the package manager runs them by default, or an entry in its own allow-list lets them run, these packages execute code the policy does not allow; where it blocks them, they may not work without a build step. A package in installScripts.deny was reviewed and works without its scripts, so it is reported only while the package manager still runs them (or builds it from source), or when it cannot be installed without a build. Only npm, Bun (1.4.4+) and Deno (lockfile v5) record install scripts in the lockfile; uv.lock, poetry.lock and pylock.toml show which Python packages have no wheel.',
  help: 'Remove or replace the package, or review it and add it to installScripts.allow in depcurfew.json, or to installScripts.deny when it works without its scripts (Python packages with the prefix pypi:). For a package in installScripts.deny, make the package manager block its scripts (depcurfew apply records the denial where the tool can).',
  level: 'error',
  requiresPolicy: true,
  check(context) {
    const policy = context.policy;
    if (policy?.installScripts?.default !== 'deny') return;
    eachLockfile(context, 'lockfile-install-scripts', (lockfile, tool) => {
      const view = policyFor(policy, ecosystemOfTool(tool)).installScripts;
      const allow = view?.allow ?? [];
      const deny = view?.deny ?? [];
      if (ecosystemOfTool(tool) === 'pypi') {
        reportPythonBuilds(context, lockfile, tool, allow, deny);
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
      const lists = ownLists(context, tool);
      for (const entry of flagged) {
        if (allow.some((pattern) => matchesPattern(entry.name, pattern))) continue;
        const isDenied = deny.some((pattern) => matchesPattern(entry.name, pattern));
        // npm and Deno let a denial win over an allow entry of the same package; a name-only denial covers every version.
        const blocked = lists.denied.some((item) => item.package === entry.name && item.name === item.package);
        const lets = disabledBy?.all === true || blocked ? undefined : lists.allowed.find((item) => item.package === entry.name);
        if (lets !== undefined) {
          context.report({
            level: 'error',
            location: location(lockfile, entry),
            message: `${entry.name} has install scripts, and ${lets.setting} in ${lets.file} lets ${tool.name} run them, but ${POLICY_FILE} ${isDenied ? 'denies them' : 'does not allow it'}`,
            fix: isDenied
              ? `Remove ${lets.name} from ${lets.setting} in ${lets.file}, or move ${entry.name} from installScripts.deny to installScripts.allow in ${POLICY_FILE} after reviewing its scripts`
              : `Remove ${lets.name} from ${lets.setting} in ${lets.file}, or review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}`,
          });
          continue;
        }
        if (isDenied) {
          // Reviewed and blocked on purpose: nothing to report while the tool does not run its scripts, which includes a
          // denial the tool records (npm 11.16+ skips a package set to false in allowScripts, also without strict-allow-scripts).
          if (!running || blocked) continue;
          context.report({
            level: 'error',
            location: location(lockfile, entry),
            message: `${entry.name} has install scripts and ${tool.name} runs them by default, but ${POLICY_FILE} denies them`,
            fix: `Make ${tool.name} stop running dependency install scripts (run depcurfew apply and follow its warnings), or replace the package`,
          });
          continue;
        }
        context.report({
          level: running ? 'error' : 'warning',
          location: location(lockfile, entry),
          message: running
            ? `${entry.name} has install scripts and ${tool.name} runs them by default, but ${POLICY_FILE} does not allow it`
            : disabledBy === undefined
              ? `${entry.name} has install scripts that ${tool.name} will not run because ${POLICY_FILE} does not allow it; the package may need them`
              : `${entry.name} has install scripts that ${tool.name} will not run because ${disabledBy.reason}; the package may need them`,
          fix: running
            ? `Review its scripts and add ${entry.name} to installScripts.allow in ${POLICY_FILE}, or replace the package`
            : `Review its scripts: add ${entry.name} to installScripts.allow in ${POLICY_FILE} if it needs them, or to installScripts.deny if it works without them; otherwise replace the package`,
        });
      }
    });
  },
};

/**
 * The tool's own lists as the version in use reads them: allow entries from the version that has an allow-list,
 * denials (extra.denyList) from the version that records them; empty for older versions.
 */
function ownLists(context: RuleContext, tool: ToolKnowledge): { allowed: AllowEntry[]; denied: AllowEntry[] } {
  const manager = context.detection.packageManagers.find((entry) => entry.id === tool.id);
  if (manager === undefined) return { allowed: [], denied: [] };
  const version = pinnedVersion(manager) ?? latestVersion(tool);
  const options = { tool, ...(version === undefined ? {} : { version }) };
  const reads = (since: string | undefined) => {
    const required = since === undefined ? undefined : parseVersion(since);
    return required !== undefined && (version === undefined || compareVersions(version, required) >= 0);
  };
  const denial = tool.extra?.['denyList'] === undefined ? undefined : evidenceOf(tool.extra['denyList'])[0]?.value;
  const denialSince = isRecord(denial) && typeof denial['since'] === 'string' ? denial['since'] : undefined;
  return {
    allowed: reads(sinceOf(tool.installScripts.allowList.availableSince)) ? allowEntries(context.repository, manager.id, manager.configFiles, options) : [],
    denied: reads(denialSince) ? denyEntries(context.repository, manager.id, manager.configFiles, options) : [],
  };
}
