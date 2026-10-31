// setting-ignored-by-version: settings and files that a newer version no longer reads, or an older one does not
// understand yet, but that still look like they work: npm-shrinkwrap.json in npm 12, the package.json "pnpm" field
// and non-auth .npmrc settings in pnpm 11, onlyBuiltDependencies after its removal, duration strings in Yarn 4.10.
import { extraOf, isRecord, isSwitch, settingOf, values, yamlOptionsFor } from '../../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import type { PackageManagerInfo } from '../../detect/types.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { latestVersion, versionedValue } from '../effective.ts';
import { iniEntries, jsonSetting, npmrcKey, readSetting, yamlSetting } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

function atLeast(version: Version, since: unknown): boolean {
  const required = typeof since === 'string' ? parseVersion(since) : undefined;
  return required !== undefined && compareVersions(version, required) >= 0;
}

/** Lockfiles an older version read but this one does not (only from verified facts). */
function checkLockfiles(context: RuleContext, tool: ToolKnowledge, version: Version, label: string): void {
  const fact = tool.project?.lockfiles;
  if (fact === undefined || fact.status !== 'verified') return;
  const current = new Set(versionedValue(fact.value, version) ?? []);
  const known = new Set(fact.value.flatMap((entry) => [...entry.value]));
  for (const name of [...known].filter((file) => !current.has(file))) {
    if (!context.repository.isFile(name)) continue;
    context.report({
      level: 'warning',
      location: { file: name },
      message: `${label} does not read ${name}, so installs ignore the versions locked in it`,
      fix: `Rename ${name} to ${[...current][0] ?? 'the lockfile this version reads'}, or remove it`,
    });
  }
}

function checkPnpm(context: RuleContext, tool: ToolKnowledge, version: Version, label: string): void {
  const ignored = extraOf(tool, 'ignoredSince', isRecord);
  const workspace = context.repository.readText('pnpm-workspace.yaml');
  if (atLeast(version, ignored['since'])) {
    const manifest = context.repository.readText('package.json');
    const field = String(ignored['packageJsonField']);
    const found = manifest === undefined ? undefined : jsonSetting(manifest, [field]);
    if (found !== undefined && isRecord(found.value) && Object.keys(found.value).length > 0) {
      context.report({
        location: { file: 'package.json', line: found.line },
        message: `${label} ignores the "${field}" field in package.json (${Object.keys(found.value).join(', ')})`,
        fix: 'Move these settings to pnpm-workspace.yaml',
      });
    }
    const allowAll = tool.extra?.['allowAllBuilds'] === undefined ? undefined : extraOf(tool, 'allowAllBuilds', isSwitch);
    const settings = [
      settingOf(tool.cooldown.setting),
      settingOf(tool.cooldown.exclude.setting),
      settingOf(tool.installScripts.allowList.setting),
      'onlyBuiltDependencies',
      allowAll?.setting ?? null,
      settingOf(tool.sources?.git.setting),
    ].filter((setting): setting is string => setting !== null);
    const npmrc = context.repository.readText('.npmrc');
    for (const entry of npmrc === undefined ? [] : iniEntries(npmrc)) {
      const setting = settings.find((name) => npmrcKey(name) === entry.key.replace(/\[\]$/u, ''));
      if (setting === undefined) continue;
      const inWorkspace = workspace !== undefined && yamlSetting(workspace, [setting], yamlOptionsFor('pnpm-workspace.yaml', context.tools)) !== undefined;
      context.report({
        level: inWorkspace ? 'warning' : 'error',
        location: { file: '.npmrc', line: entry.line },
        message: `${label} reads only ${String(ignored['npmrc'])} from .npmrc, so ${entry.key} has no effect${inWorkspace ? ` (pnpm-workspace.yaml sets ${setting})` : ''}`,
        fix: `Set ${setting} in pnpm-workspace.yaml and remove the line from .npmrc`,
      });
    }
  }
  const legacy = tool.extra?.['onlyBuiltDependencies'] === undefined ? undefined : extraOf(tool, 'onlyBuiltDependencies', isRecord);
  if (legacy !== undefined && atLeast(version, legacy['removedIn']) && workspace !== undefined) {
    const found = yamlSetting(workspace, ['onlyBuiltDependencies'], yamlOptionsFor('pnpm-workspace.yaml', context.tools));
    if (found !== undefined) {
      context.report({
        level: 'warning',
        location: { file: 'pnpm-workspace.yaml', line: found.line },
        message: `onlyBuiltDependencies was removed in pnpm ${String(legacy['removedIn'])}, so ${label} builds none of these packages`,
        fix: `List the packages under ${settingOf(tool.installScripts.allowList.setting) ?? 'allowBuilds'} instead`,
      });
    }
  }
}

/** Duration strings written for a version that silently ignores them. */
function checkDurationStrings(context: RuleContext, tool: ToolKnowledge, manager: PackageManagerInfo, version: Version, label: string): void {
  const fact = tool.extra?.['durationStrings'];
  const format = fact === undefined ? undefined : values(fact)[0];
  if (!isRecord(format) || format['before'] !== 'no effect' || atLeast(version, format['since'])) return;
  const setting = settingOf(tool.cooldown.setting);
  const file = values(tool.cooldown.configFiles)[0]?.[0];
  if (setting === null || file === undefined || !manager.configFiles.includes(file)) return;
  const found = readSetting(context.repository, file, setting);
  if (found === undefined || typeof found.value !== 'string' || /^\d+$/u.test(found.value.trim())) return;
  context.report({
    location: { file, line: found.line },
    message: `${label} ignores the duration string ${JSON.stringify(found.value)} in ${setting}; strings work only since ${String(format['since'])}, so no delay applies`,
    fix: `Write the delay as a number in ${tool.cooldown.unit.status === 'disputed' ? 'the tool\'s unit' : String(values(tool.cooldown.unit)[0])}, or require ${tool.name} ${String(format['since'])} or later`,
  });
}

export const settingIgnoredByVersion: Rule = {
  id: 'setting-ignored-by-version',
  summary: 'A setting or file is ignored by the package manager version in use.',
  description:
    'Package managers drop old settings and files in new major versions and only accept new forms from some version on. The configuration stays in the repository and looks effective while the version in use ignores it.',
  help: 'Move the setting to the place and form this version reads.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    for (const manager of context.detection.packageManagers.filter((entry) => entry.supported)) {
      const tool = context.tools.find((entry) => entry.id === manager.id);
      if (tool === undefined) continue;
      const pinned = pinnedVersion(manager);
      const version = pinned ?? latestVersion(tool);
      if (version === undefined) continue;
      const label = `${tool.name} ${formatVersion(version)}${pinned === undefined ? ' (the latest known version; none is pinned)' : ''}`;
      checkLockfiles(context, tool, version, label);
      if (tool.id === 'pnpm') checkPnpm(context, tool, version, label);
      checkDurationStrings(context, tool, manager, version, label);
    }
  },
};
