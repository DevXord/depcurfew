// pnpm: settings in pnpm-workspace.yaml (read in every version that has them, also in single-package projects);
// the allow-list is allowBuilds since 10.26.0 and onlyBuiltDependencies before.
import { extraOf, firstFile, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, sameList, type SourceKind } from './common.ts';
import type { ManagerGenerator } from './context.ts';

interface LegacyAllowList {
  since: string;
  workspaceFileSince: string;
  removedIn: string;
}

const isLegacy = (value: unknown): value is LegacyAllowList =>
  isRecord(value) && typeof value['since'] === 'string' && typeof value['workspaceFileSince'] === 'string' && typeof value['removedIn'] === 'string';

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
    }
    const excludeSetting = settingOf(tool.cooldown.exclude.setting);
    const patterns = cooldown === undefined ? undefined : exclusions(context);
    if (excludeSetting !== null && patterns !== undefined && (patterns.length > 0 || yaml.get([excludeSetting]) !== undefined)) {
      if (!sameList(yaml.get([excludeSetting]), patterns)) yaml.set([excludeSetting], patterns);
    }
  }

  if (policy.installScripts !== undefined) {
    const allowAll = extraOf(tool, 'allowAllBuilds', isSwitch);
    if (policy.installScripts.default === 'allow') {
      if (context.supports(allowAll.since, allowAll.setting)) yaml.set([allowAll.setting], allowAll.value);
    } else {
      if (context.atLeast(allowAll.since) && yaml.get([allowAll.setting]) === allowAll.value) {
        context.warn(`${context.name}: ${allowAll.setting} allowed every build script; set to false because the policy denies install scripts`);
        yaml.set([allowAll.setting], false);
      }
      const setting = settingOf(tool.installScripts.allowList.setting) ?? 'allowBuilds';
      const since = sinceOf(tool.installScripts.allowList.availableSince);
      const wanted = policy.installScripts.allow.length > 0;
      if (context.atLeast(since)) {
        if (wanted) for (const name of allowedNames(context, setting)) if (yaml.get([setting, name]) !== true) yaml.set([setting, name], true);
      } else {
        const legacy = extraOf(tool, 'onlyBuiltDependencies', isLegacy);
        if (wanted && context.supports(legacy.since, 'onlyBuiltDependencies')) {
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
      context.warn(`pnpm: ${exoticSetting} blocks git and tarball dependencies only when they are subdependencies; direct ones stay allowed`);
      if (denied.length < exotic.size) context.warn(`pnpm: ${exoticSetting} covers git and tarball dependencies together; set to true because the policy denies ${denied.join(' and ')}`);
    }
    yaml.set([exoticSetting], denied.length > 0);
  }
  return minutes;
};

