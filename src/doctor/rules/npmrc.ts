// .npmrc rules. npmrc-overrides-policy: a workspace package .npmrc that npm ignores, and in pnpm 10 a root .npmrc
// setting that takes effect because pnpm-workspace.yaml does not set it. pnpm-shared-workspace-lockfile: without a
// shared lockfile pnpm 10 installs each project with its own .npmrc, so a package .npmrc can change the delay.
import { extraOf, isRecord, isSwitch, settingOf } from '../../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import type { PackageManagerInfo } from '../../detect/types.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { matchesPattern } from '../allow-lists.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import { iniEntries, iniValue, yamlSetting, type IniEntry } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

function kebab(setting: string): string {
  return setting.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function before(version: Version, limit: unknown): boolean {
  const until = typeof limit === 'string' ? parseVersion(limit) : undefined;
  return until !== undefined && compareVersions(version, until) < 0;
}

function managerOf(context: RuleContext, id: string): { manager: PackageManagerInfo; tool: ToolKnowledge; version: Version } | undefined {
  const manager = context.detection.packageManagers.find((entry) => entry.id === id && entry.supported);
  const tool = context.tools.find((entry) => entry.id === id);
  const version = manager === undefined || tool === undefined ? undefined : (pinnedVersion(manager) ?? latestVersion(tool));
  return manager === undefined || tool === undefined || version === undefined ? undefined : { manager, tool, version };
}

/** Security settings of a tool, as they are spelled in .npmrc. */
function npmrcKeys(tool: ToolKnowledge, spell: (setting: string) => string): Map<string, string> {
  const allowAll = ['allowAllScripts', 'allowAllBuilds'].map((key) => (tool.extra?.[key] === undefined ? undefined : extraOf(tool, key, isSwitch).setting));
  const settings = [
    settingOf(tool.cooldown.setting),
    settingOf(tool.cooldown.exclude.setting),
    ...allowAll,
    ...(['git', 'remoteTarball', 'file', 'directory'] as const).map((kind) => settingOf(tool.sources?.[kind]?.setting)),
  ].filter((setting): setting is string => typeof setting === 'string' && !setting.includes(' '));
  return new Map(settings.map((setting) => [spell(setting), setting]));
}

function entriesFor(context: RuleContext, file: string, keys: Map<string, string>): (IniEntry & { setting: string })[] {
  const text = context.repository.readText(file);
  if (text === undefined) return [];
  return iniEntries(text).flatMap((entry) => {
    const setting = keys.get(entry.key.replace(/\[\]$/u, ''));
    return setting === undefined ? [] : [{ ...entry, setting }];
  });
}

function packageNpmrcFiles(context: RuleContext): string[] {
  return context.detection.npmrcFiles.filter((file) => file !== '.npmrc');
}

/** npm reads only the project root's .npmrc. */
function checkNpmWorkspaces(context: RuleContext): void {
  const npm = managerOf(context, 'npm');
  if (npm === undefined || extraOf(npm.tool, 'npmrcScope', isRecord)['workspacePackages'] !== 'ignored') return;
  const keys = npmrcKeys(npm.tool, (setting) => setting);
  for (const file of packageNpmrcFiles(context)) {
    for (const entry of entriesFor(context, file, keys)) {
      context.report({
        level: 'warning',
        location: { file, line: entry.line },
        message: `npm reads .npmrc only at the project root, so ${entry.key} in ${file} has no effect`,
        fix: `Set it in the root .npmrc, or in ${POLICY_FILE} and run depcurfew apply`,
      });
    }
  }
}

/** pnpm 10 reads .npmrc too, but pnpm-workspace.yaml wins; a root .npmrc value counts only when the YAML lacks it. */
function checkPnpmRoot(context: RuleContext): void {
  const pnpm = managerOf(context, 'pnpm');
  const policy = context.policy;
  if (pnpm === undefined || policy?.cooldown === undefined) return;
  const ignored = extraOf(pnpm.tool, 'ignoredSince', isRecord);
  if (!before(pnpm.version, ignored['since'])) return;
  const precedence = extraOf(pnpm.tool, 'npmrcPrecedence', isRecord);
  const workspace = context.repository.readText('pnpm-workspace.yaml');
  const cooldownSetting = settingOf(pnpm.tool.cooldown.setting);
  const excludeSetting = settingOf(pnpm.tool.cooldown.exclude.setting);
  const label = `pnpm ${formatVersion(pnpm.version)}`;
  for (const entry of entriesFor(context, '.npmrc', npmrcKeys(pnpm.tool, kebab))) {
    if (precedence['winner'] === 'pnpm-workspace.yaml' && workspace !== undefined && yamlSetting(workspace, [entry.setting]) !== undefined) continue;
    if (entry.setting === cooldownSetting) {
      const wanted = convertCooldown(pnpm.tool, policy.cooldown.minimum);
      const actual = delayMinutes(pnpm.tool, iniValue(entry.value), pnpm.version);
      if (!wanted.ok || !actual.ok || actual.minutes >= policy.cooldown.minimum.minutes) continue;
      context.report({
        location: { file: '.npmrc', line: entry.line },
        message: `${entry.key}=${entry.value} in .npmrc sets ${label} to wait ${actual.minutes === 0 ? 'not at all' : formatMinutes(actual.minutes)}, shorter than ${policy.cooldown.minimum.text} in ${POLICY_FILE}, because pnpm-workspace.yaml does not set ${entry.setting}`,
        fix: 'Remove the line and run depcurfew apply, which writes the delay to pnpm-workspace.yaml',
      });
    } else if (entry.setting === excludeSetting && !policy.cooldown.exclude.some((pattern) => matchesPattern(entry.value, pattern) || pattern === entry.value)) {
      context.report({
        location: { file: '.npmrc', line: entry.line },
        message: `${entry.key} in .npmrc exempts ${entry.value} from the ${label} delay, but ${POLICY_FILE} does not`,
        fix: `Remove the line, or add ${entry.value} to cooldown.exclude in ${POLICY_FILE} and run depcurfew apply`,
      });
    }
  }
}

export const npmrcOverridesPolicy: Rule = {
  id: 'npmrc-overrides-policy',
  summary: 'An .npmrc file changes a security setting in a way the policy does not see, or is ignored.',
  description:
    'Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages, and pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy.',
  help: 'Keep security settings out of .npmrc files that are ignored or that override the policy; set them through depcurfew.json and depcurfew apply.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    checkNpmWorkspaces(context);
    checkPnpmRoot(context);
  },
};

export const pnpmSharedWorkspaceLockfile: Rule = {
  id: 'pnpm-shared-workspace-lockfile',
  summary: 'pnpm 10 without a shared lockfile lets a package .npmrc change the release-age delay.',
  description:
    'With sharedWorkspaceLockfile: false, pnpm 10 installs every workspace project separately with that project\'s own .npmrc layered over the workspace settings (read from the pnpm 10 source code), so a setting such as minimum-release-age=0 in a package .npmrc applies to that package.',
  help: 'Remove security settings from package .npmrc files, or keep the default shared lockfile.',
  level: 'warning',
  requiresPolicy: false,
  check(context) {
    const pnpm = managerOf(context, 'pnpm');
    if (pnpm === undefined) return;
    const perProject = extraOf(pnpm.tool, 'perProjectNpmrc', isRecord);
    const shared = extraOf(pnpm.tool, 'sharedWorkspaceLockfile', isRecord);
    if (!before(pnpm.version, perProject['until'])) return;
    const workspace = context.repository.readText('pnpm-workspace.yaml');
    const fromYaml = workspace === undefined ? undefined : yamlSetting(workspace, [String(shared['setting'])]);
    const fromNpmrc = iniEntries(context.repository.readText('.npmrc') ?? '').filter((entry) => entry.key === shared['npmrcKey']).at(-1);
    const value = fromYaml !== undefined ? fromYaml.value : fromNpmrc !== undefined ? iniValue(fromNpmrc.value) : shared['default'];
    if (value !== perProject['sharedWorkspaceLockfile']) return;
    const where = fromYaml !== undefined ? 'pnpm-workspace.yaml' : '.npmrc';
    const keys = npmrcKeys(pnpm.tool, kebab);
    for (const file of packageNpmrcFiles(context)) {
      for (const entry of entriesFor(context, file, keys)) {
        context.report({
          location: { file, line: entry.line },
          message: `${String(shared['setting'])} is false (${where}), so pnpm ${formatVersion(pnpm.version)} installs this package with its own .npmrc and ${entry.key}=${entry.value} replaces the workspace setting for it`,
          fix: `Remove the line from ${file}, or set ${String(shared['setting'])}: true`,
        });
      }
    }
  },
};
