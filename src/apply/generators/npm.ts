// npm: .npmrc keys in a managed block; the allowScripts allow-list in the root package.json.
import { iniEntries } from '../../doctor/settings.ts';
import { hasManagedLines } from '../block.ts';
import { extraOf, firstFile, isRecord, isSwitch, settingOf, sinceOf } from '../facts.ts';
import { formatVersion } from '../version.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, scriptsDefault, writeDenyList } from './common.ts';
import type { ManagerGenerator } from './context.ts';

const isString = (value: unknown): value is string => typeof value === 'string';
const isBefore = (value: unknown): value is { setting: string; exclusive: { since: string; until: string }; beforeWinsSince: string } =>
  isRecord(value) && typeof value['setting'] === 'string' && isRecord(value['exclusive']) && typeof value['beforeWinsSince'] === 'string';

export const npm: ManagerGenerator = (context) => {
  const { tool, policy } = context;
  const file = firstFile(tool.cooldown.configFiles) ?? '.npmrc';
  const entries: string[] = [];
  const managed: string[] = [];
  let minutes: number | undefined;

  if (policy.cooldown !== undefined) {
    const setting = settingOf(tool.cooldown.setting) ?? 'min-release-age';
    const cooldown = cooldownValue(context);
    if (cooldown !== undefined) {
      minutes = cooldown.minutes;
      entries.push(`${setting}=${cooldown.value}`);
      managed.push(setting);
      // before= in the same file wins over min-release-age from 11.15.0 and makes 11.10 to 11.14 stop with an error
      // (extra.beforeInteraction); it is the user's own setting, so it stays, with a warning (decision D-080).
      const fact = extraOf(tool, 'beforeInteraction', isBefore);
      const date = iniEntries(context.read(file)).filter((entry) => entry.key === fact.setting).at(-1);
      if (date !== undefined && context.atLeast(fact.exclusive.since)) {
        const label = `${context.name} ${formatVersion(context.version ?? [0, 0, 0])}`;
        context.warn({
          code: 'before-overrides-cooldown',
          location: { file, line: date.line },
          message: context.atLeast(fact.beforeWinsSince)
            ? `${fact.setting}=${date.value} in ${file} (line ${date.line}) takes the place of ${setting} (${label} uses ${fact.setting} when both are set in the same file), so the release-age delay depcurfew apply writes has no effect`
            : `${label} stops with an error when ${fact.setting} and ${setting} are both set, and ${file} sets ${fact.setting}=${date.value} (line ${date.line}), so every npm command fails once depcurfew apply writes ${setting}`,
          fix: `Remove the ${fact.setting} line from ${file}, so that ${setting} applies`,
        });
      }
      const excludeSetting = settingOf(tool.cooldown.exclude.setting);
      const patterns = exclusions(context);
      if (excludeSetting !== null && patterns !== undefined && context.atLeast(sinceOf(tool.cooldown.exclude.availableSince))) {
        const suffix = extraOf(tool, 'npmrcListSyntax', isString);
        for (const pattern of patterns) entries.push(`${excludeSetting}${suffix}=${pattern}`);
        managed.push(excludeSetting);
      }
    }
  }

  if (policy.installScripts !== undefined) {
    const allowAll = extraOf(tool, 'allowAllScripts', isSwitch);
    if (policy.installScripts.default === 'allow') {
      if (context.supports(allowAll.since, allowAll.setting)) {
        entries.push(`${allowAll.setting}=${String(allowAll.value)}`);
        managed.push(allowAll.setting);
      }
    } else {
      if (context.atLeast(allowAll.since)) managed.push(allowAll.setting);
      // Before npm 12, dependency scripts that allowScripts does not cover still run (with a notice from 11.16.0):
      // strict-allow-scripts turns them into an error; older versions have no allow-list at all.
      const defaults = scriptsDefault(context).value;
      const strict = extraOf(tool, 'strictAllowScripts', isSwitch);
      if (defaults === 'run-with-warning' && context.supports(strict.since, strict.setting)) {
        entries.push(`${strict.setting}=${String(strict.value)}`);
        managed.push(strict.setting);
      } else if (defaults === 'run') {
        const since = sinceOf(tool.installScripts.allowList.availableSince) ?? '';
        context.warn({
          code: 'scripts-not-enforceable',
          message: `${context.name} ${formatVersion(context.version ?? [0, 0, 0])} runs every dependency install script and has no allow-list, so "deny" cannot be enforced`,
          fix: `Require npm ${since} or later (npm 12 blocks dependency scripts by default)`,
        });
      }
      const setting = settingOf(tool.installScripts.allowList.setting);
      const listFile = settingOf(tool.installScripts.allowList.file) ?? 'package.json';
      if (setting !== null) {
        const wanted = policy.installScripts.allow.length > 0;
        if (wanted && context.supports(sinceOf(tool.installScripts.allowList.availableSince), setting)) {
          const json = context.json(listFile);
          for (const name of allowedNames(context, setting)) if (json.get([setting, name]) !== true) json.set([setting, name], true);
        }
      }
      writeDenyList(context);
    }
  }

  eachSource(context, (_kind, setting, access) => {
    entries.push(`${setting}=${access === 'deny' ? 'none' : 'all'}`);
    managed.push(setting);
  });

  // Without entries, the file is still edited when it sets a managed key by hand (such as the switch that allows
  // every install script while the policy denies them), so that the key is commented out.
  if (entries.length > 0 || hasManagedLines(context.read(file)) || (managed.length > 0 && context.exists(file))) {
    context.ini(file, entries, managed);
  }
  return minutes;
};
