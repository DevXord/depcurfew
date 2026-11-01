// manager-version-too-old: a setting only works from some version on. Every version the repository declares for a
// package manager (packageManager, devEngines, Volta, .tool-versions, CI) must have every setting in use: the ones
// depcurfew.json needs and the ones already written in the manager's configuration.
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

interface Feature {
  setting: string;
  since: string;
  disputed: boolean;
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

const SOURCE_LABEL: Record<VersionDeclaration['source'], string> = {
  packageManager: 'packageManager',
  'tool-config': 'the required version',
  devEngines: 'devEngines',
  volta: 'Volta',
  'tool-versions': '.tool-versions',
  'github-actions': 'GitHub Actions',
};

/** Where a version is declared, for messages; a tool's own required version is named by its key. */
function sourceLabel(tool: ToolKnowledge, declaration: VersionDeclaration): string {
  if (declaration.source !== 'tool-config') return SOURCE_LABEL[declaration.source];
  const required = tool.extra?.['requiredVersion'] === undefined ? undefined : values(tool.extra['requiredVersion'])[0];
  if (!isRecord(required) || typeof required['key'] !== 'string') return SOURCE_LABEL[declaration.source];
  return declaration.file.endsWith('pyproject.toml') && typeof required['table'] === 'string' ? `${required['key']} in [${required['table']}]` : required['key'];
}

function declarationLine(context: RuleContext, declaration: VersionDeclaration): number | undefined {
  if (declaration.line !== undefined) return declaration.line;
  const text = context.repository.readText(declaration.file);
  if (text === undefined) return undefined;
  const key = declaration.source === 'packageManager' ? '"packageManager"' : declaration.source === 'devEngines' ? '"devEngines"' : declaration.source === 'volta' ? '"volta"' : undefined;
  return key === undefined ? undefined : lineOf(text, key);
}

function checkManager(context: RuleContext, manager: PackageManagerInfo, tool: ToolKnowledge): void {
  const features = new Map<string, Feature>();
  for (const item of [...(context.policy === undefined ? [] : policyFeatures(tool, policyFor(context.policy, ecosystemOfTool(tool)))), ...configuredFeatures(context, tool)]) features.set(item.setting, item);
  if (features.size === 0) return;
  for (const declaration of manager.versions) {
    if (!('version' in declaration)) continue;
    const lowest = lowestVersion(declaration.version);
    const label = sourceLabel(tool, declaration);
    const where = `${label} (${declaration.file})`;
    if (lowest.kind === 'unknown') {
      context.notice(`manager-version-too-old cannot evaluate ${tool.name} version "${declaration.version}" in ${declaration.file}`, declaration.file);
      continue;
    }
    const below = [...features.values()].filter((item) => belowVersion(lowest, parseVersion(item.since) as Version));
    // "minimumReleaseAge for packages requested by exact version" says nothing new when minimumReleaseAge itself is missing.
    const missing = below.filter((item) => !below.some((other) => other !== item && item.setting.startsWith(`${other.setting} for `)));
    if (missing.length === 0) continue;
    const needed = missing.map((item) => parseVersion(item.since) as Version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    const list = describeRequirements(missing);
    const line = declarationLine(context, declaration);
    const subject =
      lowest.kind === 'exact'
        ? `${tool.name} ${formatBound(lowest)} in ${where} does not support ${list}`
        : `${where} allows ${tool.name} ${formatBound(lowest)} ("${declaration.version}"), which does not support ${list}`;
    context.report({
      level: lowest.kind === 'exact' ? 'error' : 'warning',
      location: line === undefined ? { file: declaration.file } : { file: declaration.file, line },
      message: subject,
      fix: `Require ${tool.name} ${formatVersion(needed)} or later in ${label}`,
    });
  }
}

export const managerVersionTooOld: Rule = {
  id: 'manager-version-too-old',
  checks: 'The declared package manager versions support the settings the repository relies on',
  summary: 'A declared package manager version is older than a setting the repository relies on.',
  description:
    'Package managers ignore settings they do not know yet. When packageManager, devEngines, Volta, .tool-versions or a CI step pins an older version, the setting is silently not applied there.',
  help: 'Raise the declared version to at least the version that introduced the setting, everywhere it is declared.',
  level: 'error',
  requiresPolicy: false,
  // Any package manager: the rule also says that a policy does nothing for Yarn Classic, which is not supported.
  applies: (scope) => scope.detection.packageManagers.length > 0,
  check(context) {
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool !== undefined) checkManager(context, manager, tool);
    }
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
