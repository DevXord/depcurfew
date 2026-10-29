// manager-version-too-old: a setting only works from some version on. Every version the repository declares for a
// package manager (packageManager, devEngines, Volta, .tool-versions, CI) must have every setting in use: the ones
// depgate.json needs and the ones already written in the manager's configuration.
import { compareVersions, formatVersion, parseVersion, type Version } from '../../apply/version.ts';
import { extraOf, isRecord, isSwitch, settingOf, sinceOf, values } from '../../apply/facts.ts';
import type { PackageManagerInfo, VersionDeclaration } from '../../detect/types.ts';
import { SOURCE_KINDS } from '../../knowledge/schema.ts';
import type { Fact, ToolKnowledge } from '../../knowledge/types.ts';
import type { ResolvedPolicy } from '../../policy/schema.ts';
import { lineOf, readSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';
import { lowestVersion } from '../version-range.ts';

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

/** Settings depgate.json makes `apply` write for this tool. */
function policyFeatures(tool: ToolKnowledge, policy: ResolvedPolicy): Feature[] {
  const features: (Feature | undefined)[] = [];
  if (policy.cooldown !== undefined) {
    features.push(feature(settingOf(tool.cooldown.setting), tool.cooldown.availableSince));
    if (policy.cooldown.exclude.length > 0) features.push(feature(settingOf(tool.cooldown.exclude.setting), tool.cooldown.exclude.availableSince));
  }
  if (policy.installScripts !== undefined) {
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
  return candidates
    .filter(([setting]) => setting !== null && files.some((name) => readSetting(context.repository, name, setting) !== undefined))
    .map(([setting, since]) => feature(setting, since))
    .filter((item): item is Feature => item !== undefined);
}

const SOURCE_LABEL: Record<VersionDeclaration['source'], string> = {
  packageManager: 'packageManager',
  devEngines: 'devEngines',
  volta: 'Volta',
  'tool-versions': '.tool-versions',
  'github-actions': 'GitHub Actions',
};

function declarationLine(context: RuleContext, declaration: VersionDeclaration): number | undefined {
  if (declaration.line !== undefined) return declaration.line;
  const text = context.repository.readText(declaration.file);
  if (text === undefined) return undefined;
  const key = declaration.source === 'packageManager' ? '"packageManager"' : declaration.source === 'devEngines' ? '"devEngines"' : declaration.source === 'volta' ? '"volta"' : undefined;
  return key === undefined ? undefined : lineOf(text, key);
}

function checkManager(context: RuleContext, manager: PackageManagerInfo, tool: ToolKnowledge): void {
  const features = new Map<string, Feature>();
  for (const item of [...(context.policy === undefined ? [] : policyFeatures(tool, context.policy)), ...configuredFeatures(context, tool)]) features.set(item.setting, item);
  if (features.size === 0) return;
  for (const declaration of manager.versions) {
    if (!('version' in declaration)) continue;
    const lowest = lowestVersion(declaration.version);
    const where = `${SOURCE_LABEL[declaration.source]} (${declaration.file})`;
    if (lowest.kind === 'unknown') {
      context.notice(`manager-version-too-old cannot evaluate ${tool.name} version "${declaration.version}" in ${declaration.file}`, declaration.file);
      continue;
    }
    const missing = [...features.values()].filter((item) => compareVersions(lowest.version, parseVersion(item.since) as Version) < 0);
    if (missing.length === 0) continue;
    const needed = missing.map((item) => parseVersion(item.since) as Version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    const list = missing.map((item) => `${item.setting} (since ${item.since}${item.disputed ? ', sources disagree; the later version is assumed' : ''})`).join(', ');
    const line = declarationLine(context, declaration);
    const subject =
      lowest.kind === 'exact'
        ? `${tool.name} ${formatVersion(lowest.version)} in ${where} does not support ${list}`
        : `${where} allows ${tool.name} ${formatVersion(lowest.version)} ("${declaration.version}"), which does not support ${list}`;
    context.report({
      level: lowest.kind === 'exact' ? 'error' : 'warning',
      location: line === undefined ? { file: declaration.file } : { file: declaration.file, line },
      message: subject,
      fix: `Require ${tool.name} ${formatVersion(needed)} or later in ${SOURCE_LABEL[declaration.source]}`,
    });
  }
}

export const managerVersionTooOld: Rule = {
  id: 'manager-version-too-old',
  summary: 'A declared package manager version is older than a setting the repository relies on.',
  description:
    'Package managers ignore settings they do not know yet. When packageManager, devEngines, Volta, .tool-versions or a CI step pins an older version, the setting is silently not applied there.',
  help: 'Raise the declared version to at least the version that introduced the setting, everywhere it is declared.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool !== undefined) checkManager(context, manager, tool);
    }
  },
};
