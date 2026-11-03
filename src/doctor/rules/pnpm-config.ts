// pnpm-config-unverifiable (decision D-164): pnpm takes settings from places depcurfew does not read. The updateConfig
// hook of a pnpmfile, and of the pnpmfile pnpm loads from a config dependency named like a plugin, can change every
// setting after pnpm has read its files (extra.pnpmfiles, extra.configPlugins); from pnpm 12.15, include in
// pnpm-workspace.yaml can give a setting to a config dependency, whose values are in a package depcurfew does not read,
// and a broken include makes pnpm stop (extra.configIncludes). A known plugin that shortens the delay is an error.
import { evidenceOf } from '../../knowledge/facts.ts';
import { extraOf, isRecord, settingOf, values } from '../../apply/facts.ts';
import { hookFix, hookMessage, pnpmHooks } from '../../apply/pnpm-hooks.ts';
import { includesFacts, slotName } from '../../apply/pnpm-includes.ts';
import { listing } from '../../apply/requirements.ts';
import { formatVersion } from '../../apply/version.ts';
import type { ToolKnowledge } from '../../knowledge/types.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { usesManager } from '../applies.ts';
import { delayMinutes, formatMinutes } from '../durations.ts';
import { pnpmOf, repositoryIncludes } from '../pnpm-config.ts';
import type { Rule } from '../types.ts';

const hasSetting = (value: unknown): value is { setting: string } => isRecord(value) && typeof value['setting'] === 'string';

/**
 * The settings of pnpm that depcurfew manages or that weaken the policy, by the canonical name include uses for them
 * (allowBuilds stands for permissions too).
 */
export function securitySettings(tool: ToolKnowledge): Set<string> {
  const names = [
    settingOf(tool.cooldown.setting),
    settingOf(tool.cooldown.exclude.setting),
    settingOf(tool.installScripts.allowList.setting),
    settingOf(tool.sources?.git.setting),
    ...['minimumReleaseAgeStrict', 'allowAllBuilds', 'buildPermissions'].map((key) => (tool.extra?.[key] === undefined ? undefined : extraOf(tool, key, hasSetting).setting)),
    // The camelCase keys of user.weakening: the settings that weaken the policy wherever pnpm 11 and 12 read them.
    ...(tool.user === undefined ? [] : (evidenceOf(tool.user.weakening)[0]?.value ?? []).map((entry) => entry.key).filter((key) => /^[a-z][A-Za-z]*$/u.test(key))),
  ].filter((name): name is string => typeof name === 'string' && name !== '');
  const spellings = includesFacts(tool, undefined)?.spellings ?? {};
  return new Set(names.map((name) => spellings[name] ?? name));
}

export const pnpmConfigUnverifiable: Rule = {
  id: 'pnpm-config-unverifiable',
  checks: 'pnpm takes its security settings only from files depcurfew reads',
  summary: 'pnpm loads a pnpmfile or a config-dependency plugin that can change every setting, takes a security setting from a config dependency, or stops at include in pnpm-workspace.yaml.',
  description:
    'The updateConfig hook of a pnpmfile (.pnpmfile.mjs, .pnpmfile.cjs, or the files the pnpmfile and globalPnpmfile settings name) and of the pnpmfile pnpm loads by itself from a config dependency named pnpm-plugin-*, @*/pnpm-plugin-* or @pnpm/plugin-* can change every setting after pnpm has read pnpm-workspace.yaml, so the delay and the build settings depcurfew checks may not hold; ignoreScripts does not stop them, ignorePnpmfile does. A plugin the knowledge base knows to set a shorter release-age delay than depcurfew.json is an error. From pnpm 12.15, include in pnpm-workspace.yaml can give a setting to a config dependency, whose values depcurfew cannot read, or to a file outside the directory; and an include pnpm rejects (ERR_PNPM_INVALID_WORKSPACE_INCLUDE, ERR_PNPM_DUPLICATE_SETTING, ERR_PNPM_SETTING_NOT_DELEGATED) makes every pnpm command stop.',
  help: 'Read what the pnpmfile or plugin changes; set pnpmfile: [] when the project needs no pnpmfile, remove plugins it does not need, keep security settings in pnpm-workspace.yaml or a local file of include, and fix what pnpm rejects in include.',
  level: 'warning',
  requiresPolicy: false,
  applies: (scope) => usesManager(scope, ['pnpm']),
  check(context) {
    const pnpm = pnpmOf(context.detection, context.tools);
    if (pnpm === undefined) return;
    const { tool, version } = pnpm;
    const manifest = values(tool.cooldown.configFiles)[0]?.[0] ?? 'pnpm-workspace.yaml';
    const name = version === undefined ? tool.name : `${tool.name} ${formatVersion(version)}`;
    const includes = repositoryIncludes(context.repository, tool, version);

    for (const problem of includes?.problems ?? []) {
      context.report({
        location: { file: problem.file, line: problem.line },
        message: `${name} stops with ${problem.code}: ${problem.message}, so it runs no command in this directory and depcurfew cannot tell which settings it would use`,
        fix: `Fix include in ${manifest} as the message says (each setting may have one owner, and a list names the only settings its file may define)`,
      });
    }

    const security = securitySettings(tool);
    for (const source of includes?.sources ?? []) {
      if (source.kind === 'file' && source.file !== undefined) continue;
      // The settings as include names them (permissions, which shares the owner of allowBuilds, stays permissions).
      const owned = source.slots.flatMap((slot, index) => (security.has(slot) ? [source.selectors[index] ?? slotName(slot)] : []));
      if (source.kind === 'dependency') {
        if (owned.length === 0) continue;
        context.report({
          location: { file: manifest, line: source.line },
          message: `include in ${manifest} gives ${listing(owned)} to the config dependency ${source.spec}, whose settings depcurfew cannot read, so it cannot verify ${owned.length === 1 ? 'that setting' : 'these settings'}, and depcurfew apply does not write ${owned.length === 1 ? 'it' : 'them'}`,
          fix: `Take ${listing(owned)} out of the list of ${source.spec} in include, so that depcurfew apply writes ${owned.length === 1 ? 'it' : 'them'} into ${manifest} and depcurfew doctor checks ${owned.length === 1 ? 'it' : 'them'}; or check the pnpm.config file of ${source.spec} by hand against ${POLICY_FILE}`,
        });
        continue;
      }
      if (!source.all && owned.length === 0) continue;
      context.report({
        location: { file: manifest, line: source.line },
        message: `include in ${manifest} gives ${source.all ? 'every setting it defines' : listing(owned)} to ${source.spec}, which lies outside the directory, so depcurfew cannot read the settings ${name} takes from it`,
        fix: `Move ${source.spec} into the directory and refer to it from there, or keep the security settings in ${manifest}`,
      });
    }

    const minimum = context.policy?.cooldown?.minimum;
    const delaySetting = settingOf(tool.cooldown.setting);
    for (const hook of pnpmHooks(tool, version, {
      read: (file) => context.repository.readText(file),
      isFile: (file) => context.repository.isFile(file),
      packages: context.detection.workspaces?.packages ?? [],
      ...(includes === undefined ? {} : { includes }),
    })) {
      // A known plugin that sets a shorter delay than the policy is a weakening, not only a doubt.
      const known = hook.kind === 'plugin' && delaySetting !== null ? hook.known?.settings[delaySetting] : undefined;
      const delay = known === undefined ? undefined : delayMinutes(tool, known, version);
      const shorter = minimum !== undefined && delay?.ok === true && delay.minutes < minimum.minutes;
      const line = hook.kind === 'plugin' ? hook.line : (hook.line ?? hook.updateConfigLine);
      context.report({
        ...(shorter ? { level: 'error' as const } : {}),
        location: { file: hook.file, ...(line === undefined ? {} : { line }) },
        message: `${hookMessage(hook, name)}${shorter && delay?.ok === true ? `, so pnpm waits only ${formatMinutes(delay.minutes)}, shorter than ${minimum.text} in ${POLICY_FILE}` : ''}`,
        fix: hookFix(hook, manifest),
      });
    }
  },
};
