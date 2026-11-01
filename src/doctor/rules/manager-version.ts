// manager-version-too-old: a setting only works from some version on. Every version the repository declares for a
// package manager (packageManager, devEngines, Volta, .tool-versions, CI, Dockerfiles) must have every setting in use:
// the ones depcurfew.json needs and the ones already written in the manager's configuration. So must the npm that
// comes with a declared Node.js and the pip of a python image, where nothing replaces them (bundled-versions.ts).
import { compareVersions, formatVersion, parseVersion, type Version } from '../../apply/version.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf, values } from '../../apply/facts.ts';
import { describeRequirements } from '../../apply/requirements.ts';
import type { PackageManagerInfo, VersionDeclaration } from '../../detect/types.ts';
import { SOURCE_KINDS } from '../../knowledge/schema.ts';
import type { Fact, ToolKnowledge } from '../../knowledge/types.ts';
import { ecosystemOfTool, policyFor } from '../../policy/ecosystem.ts';
import type { ResolvedPolicy } from '../../policy/schema.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { readPythonSetting } from '../python.ts';
import { lineOf, readSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';
import { belowVersion, formatBound, lowestVersion } from '../version-range.ts';
import { checkBundledVersions, SOURCE_LABEL, strictAdvice, type StrictAdvice } from './bundled-versions.ts';

export interface Feature {
  setting: string;
  since: string;
  disputed: boolean;
  /** Another way to have it from an earlier version: a setting in a file (strict-allow-scripts=true in .npmrc). */
  instead?: { setting: string; file: string; since: string };
}

/**
 * When a missing feature can also be had with a setting from an earlier version (decision D-105): that version, the
 * newest of it and the other missing features, and how to say it in a fix. The fix promises that depcurfew apply writes
 * the setting only where it does (decision D-109): "which depcurfew apply writes for this repository" when apply writes it
 * now; after a change of the repository that apply sees (a pinned version, a CI step, a Dockerfile, a version file),
 * "which depcurfew apply then writes"; otherwise (npm installed on a machine, npm not in targets) "by hand".
 */
export function alternativeOf(
  missing: readonly { setting: string; since: string; instead?: Feature['instead'] }[],
  name: string,
  advice: StrictAdvice,
): { version: Version; suffix: (change: 'repository' | 'machine') => string; set: string; text: string } | undefined {
  const instead = missing.find((item) => item.instead !== undefined)?.instead;
  if (instead === undefined) return undefined;
  const versions = [instead.since, ...missing.filter((item) => item.instead === undefined).map((item) => item.since)].map((since) => parseVersion(since) as Version);
  const version = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const { setting, file } = instead;
  const now = advice.now && advice.targeted;
  const suffix = (change: 'repository' | 'machine') =>
    now
      ? `with ${setting} in ${file}, which depcurfew apply writes for this repository`
      : change === 'machine'
        ? `and add ${setting} to ${file} by hand`
        : advice.targeted
          ? `with ${setting} in ${file}, which depcurfew apply then writes`
          : `with ${setting} added to ${file} by hand`;
  return {
    version,
    suffix,
    set: now ? `set ${setting} in ${file}, which depcurfew apply writes for this repository` : `add ${setting} to ${file} by hand`,
    text: `${name} ${formatVersion(version)} or later ${suffix('repository')}`,
  };
}

function feature(setting: string | null, since: Fact<string | null> | string | undefined): Feature | undefined {
  if (setting === null || since === undefined) return undefined;
  const version = typeof since === 'string' ? since : sinceOf(since);
  if (version === undefined || parseVersion(version) === undefined) return undefined;
  return { setting, since: version, disputed: typeof since !== 'string' && since.status === 'disputed' };
}

/** Settings depcurfew.json makes `apply` write for this tool. */
function policyFeatures(tool: ToolKnowledge, policy: ResolvedPolicy): Feature[] {
  const features: (Feature | undefined)[] = [];
  if (policy.cooldown !== undefined) {
    features.push(feature(settingOf(tool.cooldown.setting), tool.cooldown.availableSince));
    // A version that has the setting but skips it in some cases (pnpm before 10.17.0: exact versions).
    const exact = tool.extra?.['cooldownExactVersions'] === undefined ? undefined : values(tool.extra['cooldownExactVersions'])[0];
    const setting = settingOf(tool.cooldown.setting);
    if (typeof exact === 'string' && setting !== null) features.push(feature(`${setting} for packages requested by exact version`, exact));
    if (policy.cooldown.exclude.length > 0) features.push(feature(settingOf(tool.cooldown.exclude.setting), tool.cooldown.exclude.availableSince));
  }
  if (policy.installScripts !== undefined) {
    // Python tools forbid building from source with a switch (decision D-065).
    const build = tool.extra?.['buildSwitch'] === undefined ? undefined : values(tool.extra['buildSwitch'])[0];
    if (policy.installScripts.default === 'deny' && isSwitch(build)) features.push(feature(build.setting, build.since));
    const allowAll = tool.extra?.['allowAllScripts'] ?? tool.extra?.['allowAllBuilds'];
    const switchFact = allowAll === undefined ? undefined : values(allowAll)[0];
    if (policy.installScripts.default === 'allow' && isSwitch(switchFact)) features.push(feature(switchFact.setting, switchFact.since));
    if (policy.installScripts.default === 'deny' && policy.installScripts.allow.length > 0) {
      // pnpm falls back to onlyBuiltDependencies before allowBuilds existed.
      const legacy = tool.extra?.['onlyBuiltDependencies'] === undefined ? undefined : extraOf(tool, 'onlyBuiltDependencies', isRecord);
      const setting = settingOf(tool.installScripts.allowList.setting);
      features.push(
        legacy !== undefined && typeof legacy['since'] === 'string'
          ? feature(setting, legacy['since'])
          : feature(setting?.includes('<') ? (setting.split('.')[0] ?? setting) : setting, tool.installScripts.allowList.availableSince),
      );
    }
  }
  for (const kind of SOURCE_KINDS) {
    const source = tool.sources?.[kind];
    if (policy.sources?.[kind] !== undefined && source !== undefined) features.push(feature(settingOf(source.setting), source.availableSince));
  }
  return features.filter((item): item is Feature => item !== undefined);
}

/** Settings already present in the manager's own configuration file. */
function configuredFeatures(context: RuleContext, tool: ToolKnowledge): Feature[] {
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (file === undefined) return [];
  const candidates: [string | null, Fact<string | null> | undefined][] = [
    [settingOf(tool.cooldown.setting), tool.cooldown.availableSince],
    [settingOf(tool.cooldown.exclude.setting), tool.cooldown.exclude.availableSince],
    ...SOURCE_KINDS.map((kind): [string | null, Fact<string | null> | undefined] => [settingOf(tool.sources?.[kind]?.setting), tool.sources?.[kind]?.availableSince]),
  ];
  const files = tool.id === 'deno' ? context.detection.packageManagers.find((entry) => entry.id === 'deno')?.configFiles.filter((name) => /^deno\.jsonc?$/u.test(name)) ?? [] : [file];
  const configured = (setting: string) =>
    ecosystemOfTool(tool) === 'pypi'
      ? readPythonSetting(context.repository, tool, setting) !== undefined
      : files.some((name) => readSetting(context.repository, name, setting) !== undefined);
  return candidates
    .filter(([setting]) => setting !== null && configured(setting))
    .map(([setting, since]) => feature(setting, since))
    .filter((item): item is Feature => item !== undefined);
}

export { SOURCE_LABEL } from './bundled-versions.ts';

/** Where a version is declared, for messages; a tool's own required version is named by its key. */
function sourceLabel(tool: ToolKnowledge, declaration: VersionDeclaration): string {
  if (declaration.source !== 'tool-config') return SOURCE_LABEL[declaration.source];
  const required = tool.extra?.['requiredVersion'] === undefined ? undefined : values(tool.extra['requiredVersion'])[0];
  if (!isRecord(required) || typeof required['key'] !== 'string') return SOURCE_LABEL[declaration.source];
  return declaration.file.endsWith('pyproject.toml') && typeof required['table'] === 'string' ? `${required['key']} in [${required['table']}]` : required['key'];
}

export function declarationLine(context: RuleContext, declaration: VersionDeclaration): number | undefined {
  if (declaration.line !== undefined) return declaration.line;
  const text = context.repository.readText(declaration.file);
  if (text === undefined) return undefined;
  const keys: Partial<Record<VersionDeclaration['source'], string>> = { packageManager: '"packageManager"', devEngines: '"devEngines"', volta: '"volta"', engines: '"engines"' };
  const key = keys[declaration.source];
  return key === undefined ? undefined : lineOf(text, key);
}

/**
 * npm with installScripts "deny": what keeps dependency install scripts from running with the files as written
 * (decision D-105). ignore-scripts=true turns them off in every version; strict-allow-scripts=true stops the install
 * at a script allowScripts does not cover from 11.16.0; without either, only npm 12 blocks such scripts by default,
 * and 11.16 to 11.x run them with a notice.
 */
function scriptFeatures(context: RuleContext, tool: ToolKnowledge, policy: ResolvedPolicy): Feature[] {
  if (policy.installScripts?.default !== 'deny' || tool.extra?.['strictAllowScripts'] === undefined) return [];
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (file === undefined) return [];
  const disable = tool.installScripts.disableAll.status === 'verified' ? tool.installScripts.disableAll.value : undefined;
  if (typeof disable === 'string' && /^[\w.-]+$/u.test(disable) && readSetting(context.repository, file, disable)?.value === true) return [];
  const strict = extraOf(tool, 'strictAllowScripts', isSwitch);
  if (readSetting(context.repository, file, strict.setting)?.value === strict.value) {
    const found = feature(strict.setting, strict.since);
    return found === undefined ? [] : [found];
  }
  const blocks = feature(`blocking dependency install scripts without ${strict.setting}`, (values(tool.installScripts.defaultPolicy)[0] ?? []).find((entry) => entry.value === 'deny-except-allowlist')?.since);
  return blocks === undefined || strict.since === undefined ? [] : [{ ...blocks, instead: { setting: `${strict.setting}=${String(strict.value)}`, file, since: strict.since } }];
}

/** Every setting in use for a tool: the ones depcurfew.json needs and the ones already in its configuration. */
export function featuresOf(context: RuleContext, tool: ToolKnowledge): Feature[] {
  const features = new Map<string, Feature>();
  const policy = context.policy === undefined ? undefined : policyFor(context.policy, ecosystemOfTool(tool));
  const fromPolicy = policy === undefined ? [] : [...policyFeatures(tool, policy), ...scriptFeatures(context, tool, policy)];
  for (const item of [...fromPolicy, ...configuredFeatures(context, tool)]) features.set(item.setting, item);
  return [...features.values()];
}

/** Features a version lacks, without "minimumReleaseAge for packages requested by exact version" when minimumReleaseAge itself is missing. */
export function missingFeatures<T extends { setting: string; since: string }>(features: readonly T[], below: (since: Version) => boolean): T[] {
  const missing = features.filter((item) => below(parseVersion(item.since) as Version));
  return missing.filter((item) => !missing.some((other) => other !== item && item.setting.startsWith(`${other.setting} for `)));
}

function checkManager(context: RuleContext, manager: PackageManagerInfo, tool: ToolKnowledge, features: readonly Feature[]): void {
  if (features.length === 0) return;
  const advice = features.some((item) => item.instead !== undefined) ? strictAdvice(context, tool) : { now: false, targeted: false };
  for (const declaration of manager.versions) {
    if (!('version' in declaration)) continue;
    const lowest = lowestVersion(declaration.version);
    const label = sourceLabel(tool, declaration);
    // "Dockerfile" or ".tool-versions" at the root is both the label and the file: named once.
    const where = label === declaration.file ? label : `${label} (${declaration.file})`;
    if (lowest.kind === 'unknown') {
      context.notice(`manager-version-too-old cannot evaluate ${tool.name} version "${declaration.version}" in ${declaration.file}`, declaration.file);
      continue;
    }
    const missing = missingFeatures(features, (since) => belowVersion(lowest, since));
    if (missing.length === 0) continue;
    const needed = missing.map((item) => parseVersion(item.since) as Version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    const list = describeRequirements(missing);
    const line = declarationLine(context, declaration);
    const subject =
      lowest.kind === 'exact'
        ? `${tool.name} ${formatBound(lowest)} in ${where} does not support ${list}`
        : `${where} allows ${tool.name} ${formatBound(lowest)} ("${declaration.version}"), which does not support ${list}`;
    const alternative = alternativeOf(missing, tool.name, advice);
    context.report({
      level: lowest.kind === 'exact' ? 'error' : 'warning',
      location: line === undefined ? { file: declaration.file } : { file: declaration.file, line },
      message: subject,
      fix:
        alternative !== undefined && lowest.kind === 'exact' && compareVersions(lowest.version, alternative.version) >= 0
          ? `${alternative.set.charAt(0).toUpperCase()}${alternative.set.slice(1)}, or require ${tool.name} ${formatVersion(needed)} or later in ${label}`
          : `Require ${tool.name} ${formatVersion(needed)} or later in ${label}${alternative === undefined ? '' : `, or ${alternative.text}`}`,
    });
  }
}

export const managerVersionTooOld: Rule = {
  id: 'manager-version-too-old',
  checks: 'The declared package manager versions, and the npm and pip that come with the declared Node.js and Python versions, support the settings the repository relies on',
  summary: 'A declared package manager version, or the npm or pip that comes with a declared Node.js or Python version, is older than a setting the repository relies on.',
  description:
    'Package managers ignore settings they do not know yet; npm 10 does not even warn. When packageManager, devEngines, Volta, .tool-versions, a CI step or a Dockerfile pins an older version, the setting is silently not applied there. The same holds for the npm that comes with the Node.js a CI job, a Dockerfile stage or a version file (.nvmrc, .node-version) chooses, and for the pip of a python image: Node.js 22 comes with npm 10, which has no min-release-age.',
  help: 'Raise the declared version to at least the version that introduced the setting, everywhere it is declared, or install a newer npm or pip before installing packages.',
  level: 'error',
  requiresPolicy: false,
  // Any package manager: the rule also says that a policy does nothing for Yarn Classic, which is not supported.
  applies: (scope) => scope.detection.packageManagers.length > 0,
  check(context) {
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool !== undefined) checkManager(context, manager, tool, featuresOf(context, tool));
    }
    // The npm that comes with the declared Node.js, and the pip of a python image, where nothing replaces them.
    checkBundledVersions(context, {
      features: (tool, where) => featuresOf(where, tool),
      alternative: (missing, name, advice) => alternativeOf(missing, name, advice),
      missing: missingFeatures,
      line: (declaration) => declarationLine(context, declaration),
      label: (declaration) => SOURCE_LABEL[declaration.source],
    });
    // Yarn Classic has none of the settings, so a policy silently does nothing for it.
    for (const manager of context.detection.packageManagers.filter((entry) => !entry.supported && entry.variant === 'classic')) {
      const berry = context.tools.find((entry) => entry.id === manager.id);
      if (context.policy === undefined || berry === undefined) continue;
      const declaration = manager.versions.find((entry) => entry.source === 'packageManager');
      const file = declaration?.file ?? manager.evidence[0]?.file ?? 'package.json';
      const line = declaration === undefined ? undefined : declarationLine(context, declaration);
      const since = sinceOf(berry.cooldown.availableSince);
      context.report({
        level: 'error',
        location: line === undefined ? { file } : { file, line },
        message: `Yarn Classic (1.x) has none of the settings ${POLICY_FILE} needs (release-age delay, install-script allow-list, dependency sources), so the policy does not apply to it`,
        fix: `Move to ${berry.name}${since === undefined ? '' : ` ${since} or later`}, or to another package manager depcurfew configures`,
      });
    }
  },
};
