// .npmrc rules. npmrc-overrides-policy: a workspace package .npmrc that npm ignores, security settings below a
// [section] header, a before date that replaces min-release-age, and in pnpm 10 a root .npmrc setting that takes
// effect because pnpm-workspace.yaml does not set it. pnpm-shared-workspace-lockfile: without a
// shared lockfile pnpm 10 installs each project with its own .npmrc, so a package .npmrc can change the delay.
import { extraOf, isRecord, isSwitch, settingOf } from '../../apply/facts.ts';
import { compareVersions, formatVersion, parseVersion, pinnedVersion, type Version } from '../../apply/version.ts';
import type { PackageManagerInfo } from '../../detect/types.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { convertCooldown } from '../../policy/convert.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { policyFor } from '../../policy/ecosystem.ts';
import { matchesPattern } from '../allow-lists.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { latestVersion } from '../effective.ts';
import { iniEntries, iniLines, iniValue, npmrcKey, yamlSetting, type IniEntry } from '../settings.ts';
import type { Rule, RuleContext } from '../types.ts';

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

/**
 * npm takes settings only from the top of .npmrc: a key below a [section] header belongs to that section (extra.npmrcFormat),
 * so a security setting there, or a managed block an older depcurfew apply appended there, has no effect.
 */
function checkNpmSections(context: RuleContext): void {
  const npm = managerOf(context, 'npm');
  const text = npm === undefined ? undefined : context.repository.readText('.npmrc');
  if (npm === undefined || text === undefined) return;
  const strict = extraOf(npm.tool, 'strictAllowScripts', isSwitch).setting;
  const keys = new Set([...npmrcKeys(npm.tool, (setting) => setting).keys(), settingOf(npm.tool.installScripts.disableAll), strict]);
  const lines = iniLines(text);
  const bare = (entry: IniEntry) => entry.key.replace(/\[\]$/u, '');
  const topLevel = new Set(lines.filter((entry) => entry.section === undefined).map(bare));
  let blockReported = false;
  for (const entry of lines) {
    const key = bare(entry);
    if (entry.section === undefined || !keys.has(key)) continue;
    const location = { file: '.npmrc', line: entry.line };
    if (entry.managed) {
      if (blockReported) continue;
      blockReported = true;
      context.report({
        location,
        message: `the depcurfew managed block in .npmrc is below the [${entry.section}] header, so npm reads its settings as ${entry.section}.${key} and so on and applies none of them`,
        fix: 'Run depcurfew apply, which moves the managed block above the first [section] header',
      });
    } else if (topLevel.has(key)) {
      context.report({
        level: 'warning',
        location,
        message: `${key} in .npmrc is below the [${entry.section}] header, so npm reads it as ${entry.section}.${key} and does not apply it; the value above the header applies`,
        fix: 'Remove the line, or move it above the first [section] header of .npmrc if this value is the one you want',
      });
    } else {
      context.report({
        location,
        message: `${key} in .npmrc is below the [${entry.section}] header, so npm reads it as ${entry.section}.${key} and does not apply it`,
        fix: 'Move the line above the first [section] header of .npmrc',
      });
    }
  }
}

const isBefore = (value: unknown): value is { setting: string; exclusive: { since: string; until: string }; beforeWinsSince: string } =>
  isRecord(value) && typeof value['setting'] === 'string' && isRecord(value['exclusive']) && typeof value['beforeWinsSince'] === 'string';

/**
 * before= in the project .npmrc (extra.beforeInteraction): from npm 11.15.0 it takes the place of min-release-age set in
 * the same file, so a future date turns the delay off and a past one freezes every dependency; npm 11.10 to 11.14
 * refuse to run with both.
 */
function checkNpmBefore(context: RuleContext): void {
  const npm = managerOf(context, 'npm');
  const text = npm === undefined ? undefined : context.repository.readText('.npmrc');
  if (npm === undefined || text === undefined) return;
  const fact = extraOf(npm.tool, 'beforeInteraction', isBefore);
  const ageSetting = settingOf(npm.tool.cooldown.setting);
  const entries = iniEntries(text);
  const date = entries.filter((entry) => entry.key === fact.setting).at(-1);
  const age = entries.filter((entry) => entry.key === ageSetting).at(-1);
  // Before 11.10.0 npm has no min-release-age; manager-version-too-old reports that.
  if (date === undefined || ageSetting === null || before(npm.version, fact.exclusive.since)) return;
  const policy = context.policy === undefined ? undefined : policyFor(context.policy, 'npm');
  const configured = age === undefined ? undefined : delayMinutes(npm.tool, iniValue(age.value), npm.version);
  const wanted = policy?.cooldown?.minimum.minutes ?? (configured?.ok === true ? configured.minutes : 0);
  if (wanted <= 0) return;
  const label = `npm ${formatVersion(npm.version)}`;
  const location = { file: '.npmrc', line: date.line };
  if (before(npm.version, fact.exclusive.until)) {
    if (age === undefined) return;
    context.report({
      location,
      message: `${label} does not accept ${fact.setting} and ${ageSetting} together and stops with an error, so every npm command fails while both are set in .npmrc`,
      fix: `Remove the ${fact.setting} line from .npmrc (npm ${fact.beforeWinsSince} and later accept both, but ${fact.setting} then takes the place of ${ageSetting})`,
    });
    return;
  }
  const cutoff = Date.parse(date.value);
  if (Number.isNaN(cutoff)) return;
  const now = Date.now();
  const replaces = `${fact.setting}=${date.value} in .npmrc takes the place of ${ageSetting} (${label} uses ${fact.setting} when both are set in the same file)`;
  if (cutoff > now - wanted * 60_000) {
    context.report({
      location,
      message:
        cutoff > now
          ? `${replaces}, and the date is in the future, so npm installs new versions without any release-age delay`
          : `${replaces}, so npm installs versions published up to ${date.value}, less than ${formatMinutes(wanted)} ago`,
      fix: `Remove the ${fact.setting} line from .npmrc, so that ${ageSetting} applies`,
    });
  } else {
    context.report({
      level: 'warning',
      location,
      message: `${replaces}, so npm never installs a version published after ${date.value}: that freezes dependencies, security fixes included, instead of a delay that moves with time`,
      fix: `Remove the ${fact.setting} line from .npmrc, so that ${ageSetting} applies; for a one-off install from a fixed date, pass --${fact.setting} on the command line`,
    });
  }
}

/** pnpm 10 reads .npmrc too, but pnpm-workspace.yaml wins; a root .npmrc value counts only when the YAML lacks it. */
function checkPnpmRoot(context: RuleContext): void {
  const pnpm = managerOf(context, 'pnpm');
  const policy = context.policy === undefined ? undefined : policyFor(context.policy, 'npm');
  if (pnpm === undefined || policy?.cooldown === undefined) return;
  const ignored = extraOf(pnpm.tool, 'ignoredSince', isRecord);
  if (!before(pnpm.version, ignored['since'])) return;
  const precedence = extraOf(pnpm.tool, 'npmrcPrecedence', isRecord);
  const workspace = context.repository.readText('pnpm-workspace.yaml');
  const cooldownSetting = settingOf(pnpm.tool.cooldown.setting);
  const excludeSetting = settingOf(pnpm.tool.cooldown.exclude.setting);
  const label = `pnpm ${formatVersion(pnpm.version)}`;
  for (const entry of entriesFor(context, '.npmrc', npmrcKeys(pnpm.tool, npmrcKey))) {
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
    'Package managers read .npmrc from different places with different priorities. npm ignores the .npmrc of workspace packages and the keys below a [section] header, and a before date in .npmrc takes the place of min-release-age; pnpm 10 applies a root .npmrc value whenever pnpm-workspace.yaml does not set the same setting, which can weaken the policy.',
  help: 'Keep security settings out of .npmrc files that are ignored or that override the policy; set them through depcurfew.json and depcurfew apply.',
  level: 'error',
  requiresPolicy: false,
  check(context) {
    checkNpmWorkspaces(context);
    checkNpmSections(context);
    checkNpmBefore(context);
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
    const keys = npmrcKeys(pnpm.tool, npmrcKey);
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
