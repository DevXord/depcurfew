// pnpm: settings in pnpm-workspace.yaml (read in every version that has them, also in single-package projects);
// the allow-list is allowBuilds since 10.26.0 and onlyBuiltDependencies before.
import { POLICY_FILE } from '../../policy/defaults.ts';
import { extraOf, firstFile, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { isSecurityExclusionFormat, restoreEntries, securityEntries, withoutComments, type KeptEntry } from '../renovate-exclusions.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, sameList, scriptsDefault, type SourceKind } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { formatVersion } from '../version.ts';

interface LegacyAllowList {
  since: string;
  workspaceFileSince: string;
  removedIn: string;
}

const isLegacy = (value: unknown): value is LegacyAllowList =>
  isRecord(value) && typeof value['since'] === 'string' && typeof value['workspaceFileSince'] === 'string' && typeof value['removedIn'] === 'string';

/** The same strings, in any order. */
function sameMembers(current: unknown, wanted: readonly string[]): boolean {
  if (!Array.isArray(current) || current.length !== wanted.length) return false;
  const rest = [...wanted];
  for (const item of current) {
    const index = rest.indexOf(item as string);
    if (index === -1) return false;
    rest.splice(index, 1);
  }
  return true;
}

/** The entries Renovate added to the exclusion list for security updates, which apply keeps (decision D-075). */
function renovateEntries(context: Context, file: string, setting: string): KeptEntry[] {
  const renovate = context.tools.find((entry) => entry.id === 'renovate');
  const fact = renovate?.extra?.['pnpmSecurityExclusions'];
  if (renovate === undefined || fact === undefined || !context.exists(file)) return [];
  const format = extraOf(renovate, 'pnpmSecurityExclusions', isSecurityExclusionFormat);
  if (!format.managers.includes(context.tool.id) || format.file !== file || format.setting !== setting) return [];
  return securityEntries(context.read(file), setting, format);
}

export const pnpm: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? 'pnpm-workspace.yaml';
  const yaml = context.yaml(file);
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'minimumReleaseAge';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      yaml.set([setting], cooldown.value);
      // Some versions fall back to a version that is too young unless strict mode is set explicitly.
      const strict = extraOf(tool, 'minimumReleaseAgeStrict', isSwitch);
      if (context.atLeast(strict.since) && yaml.get([strict.setting]) !== strict.value) yaml.set([strict.setting], strict.value);
      const exact = extraOf(tool, 'cooldownExactVersions', (value): value is string => typeof value === 'string');
      if (!context.atLeast(exact)) {
        context.warn({
          code: 'exact-version-gap',
          message: `${context.name} ${formatVersion(context.version ?? [0, 0, 0])} skips ${setting} for packages requested by exact version`,
          fix: `Require pnpm ${exact} or later`,
        });
      }
    }
    const excludeSetting = settingOf(tool.cooldown.exclude.setting);
    const patterns = cooldown === undefined ? undefined : exclusions(context);
    if (excludeSetting !== null && patterns !== undefined && (patterns.length > 0 || yaml.get([excludeSetting]) !== undefined)) {
      const kept = renovateEntries(context, file, excludeSetting);
      const wanted = [...patterns, ...kept.map((entry) => entry.value).filter((value) => !patterns.includes(value))];
      const current = yaml.get([excludeSetting]);
      if (kept.length === 0 ? !sameList(current, wanted) : !sameMembers(current, wanted)) {
        if (kept.length > 0) context.workspace.edit(file, (body) => withoutComments(body, excludeSetting, kept));
        yaml.set([excludeSetting], wanted);
        if (kept.length > 0) context.workspace.edit(file, (body) => restoreEntries(body, excludeSetting, kept));
      }
    }
  }

  if (policy.installScripts !== undefined) {
    const allowAll = extraOf(tool, 'allowAllBuilds', isSwitch);
    if (policy.installScripts.default === 'allow') {
      if (context.supports(allowAll.since, allowAll.setting)) yaml.set([allowAll.setting], allowAll.value);
    } else {
      // Before pnpm 10, every dependency runs its install scripts unless pnpm.onlyBuiltDependencies in package.json
      // names the ones that may (since 6.32.1; any list, even an empty one, blocks the rest), so the list is written
      // even when the policy allows nothing. Older versions have no allow-list at all.
      const defaults = scriptsDefault(context);
      const legacy = extraOf(tool, 'onlyBuiltDependencies', isLegacy);
      const mustList = defaults.value === 'run';
      if (mustList && !context.atLeast(legacy.since)) {
        context.warn({
          code: 'scripts-not-enforceable',
          message: `${context.name} ${formatVersion(context.version ?? [0, 0, 0])} runs every dependency install script and has no allow-list, so "deny" cannot be enforced`,
          fix: `Require pnpm ${legacy.since} or later, which reads pnpm.onlyBuiltDependencies in package.json, or ${defaults.changesIn ?? 'a newer version'}, which blocks dependency install scripts by default`,
        });
      }
      if (context.atLeast(allowAll.since) && yaml.get([allowAll.setting]) === allowAll.value) {
        context.warn({
          code: 'allow-all-replaced',
          message: `${context.name}: ${allowAll.setting} allowed every build script; set to false because the policy denies install scripts`,
          fix: `Add the packages whose install scripts must run to installScripts.allow in ${POLICY_FILE}, then run depcurfew apply again`,
        });
        yaml.set([allowAll.setting], false);
      }
      const setting = settingOf(tool.installScripts.allowList.setting) ?? 'allowBuilds';
      const since = sinceOf(tool.installScripts.allowList.availableSince);
      const wanted = policy.installScripts.allow.length > 0;
      if (context.atLeast(since)) {
        if (wanted) for (const name of allowedNames(context, setting)) if (yaml.get([setting, name]) !== true) yaml.set([setting, name], true);
      } else {
        if ((wanted || mustList) && (mustList ? context.atLeast(legacy.since) : context.supports(legacy.since, 'onlyBuiltDependencies'))) {
          const names = allowedNames(context, 'onlyBuiltDependencies');
          const inWorkspaceFile = context.atLeast(legacy.workspaceFileSince);
          const target = inWorkspaceFile ? yaml : context.json('package.json');
          const path = inWorkspaceFile ? ['onlyBuiltDependencies'] : ['pnpm', 'onlyBuiltDependencies'];
          const current = target.get(path);
          const list = Array.isArray(current) ? [...(current as unknown[])] : [];
          const merged = [...list, ...names.filter((name) => !list.includes(name))];
          if (!sameList(current, merged)) target.set(path, merged);
        }
      }
    }
  }

  // git and remote tarballs share one setting, which only covers subdependencies.
  const exotic = new Map<SourceKind, 'allow' | 'deny'>();
  let exoticSetting: string | undefined;
  eachSource(context, (kind, setting, access) => {
    exotic.set(kind, access);
    exoticSetting = setting;
  });
  if (exoticSetting !== undefined) {
    const denied = [...exotic].filter(([, access]) => access === 'deny').map(([kind]) => (kind === 'git' ? 'git' : 'remote tarball'));
    if (denied.length > 0) {
      context.warn({
        code: 'source-switch-indirect-only',
        message: `pnpm: ${exoticSetting} stops git and tarball sources only for indirect dependencies; direct ones stay allowed`,
        fix: 'Run depcurfew doctor, which reports direct ones in pnpm-lock.yaml',
      });
      if (denied.length < exotic.size) {
        context.warn({
          code: 'source-switch-combined',
          message: `pnpm: ${exoticSetting} covers git and tarball dependencies together; set to true because the policy denies ${denied.join(' and ')}`,
          fix: `pnpm cannot deny one and allow the other: give sources.git and sources.remoteTarball the same value in ${POLICY_FILE}, so that the policy says what pnpm does`,
        });
      }
    }
    yaml.set([exoticSetting], denied.length > 0);
  }
  return minutes;
};

