// npm: .npmrc keys in a managed block; the allowScripts allow-list in the root package.json.
import { versionedValue } from '../../doctor/effective.ts';
import { iniEntries } from '../../doctor/settings.ts';
import type { ScriptPolicy } from '../../knowledge/types.ts';
import { hasManagedLines } from '../block.ts';
import { extraOf, firstFile, isRecord, isSwitch, settingOf, sinceOf, values } from '../facts.ts';
import { compareVersions, formatVersion, parseVersion, type Version } from '../version.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, scriptsDefault, writeDenyList } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';

const isString = (value: unknown): value is string => typeof value === 'string';
const isBefore = (value: unknown): value is { setting: string; exclusive: { since: string; until: string }; beforeWinsSince: string } =>
  isRecord(value) && typeof value['setting'] === 'string' && isRecord(value['exclusive']) && typeof value['beforeWinsSince'] === 'string';
const isEffects = (value: unknown): value is { since: string; value: string }[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry['since'] === 'string' && typeof entry['value'] === 'string');

/** "npm 10.9.9, which Node.js 22 in .nvmrc comes with", "npm 11.3.0 to 11.15.0, which ... can come with". */
function inUseText(versions: readonly Version[], from: string): string {
  const sorted = [...versions].sort(compareVersions);
  const low = formatVersion(sorted[0] as Version);
  const high = formatVersion(sorted.at(-1) as Version);
  return `npm ${low === high ? low : `${low} to ${high}`} (which ${from})`;
}

/**
 * installScripts "deny" when npm is not pinned for the repository (decision D-105): what the npm versions it runs need.
 * Any of 11.16 to 11.x runs scripts allowScripts does not cover with a notice unless strict-allow-scripts is set, so it is
 * written; npm 12 reads it too and stops the install at such a script, which a warning says. An npm before 11.16 cannot
 * block them at all, which scripts-not-enforceable says with where that npm comes from.
 */
function scriptsForVersionsInUse(context: Context, entries: string[], managed: string[]): void {
  const { tool } = context;
  const defaults = values(tool.installScripts.defaultPolicy)[0] ?? [];
  const strict = extraOf(tool, 'strictAllowScripts', isSwitch);
  const effects = tool.extra?.['strictAllowScriptsEffect'] === undefined ? [] : extraOf(tool, 'strictAllowScriptsEffect', isEffects);
  const of = (policy: ScriptPolicy) =>
    context.inUse.flatMap((entry) => {
      const versions = entry.versions.filter((version) => versionedValue(defaults, version) === policy);
      return versions.length === 0 ? [] : [{ text: inUseText(versions, entry.from), location: entry.location }];
    });
  // The first place that declares such an npm, for the warning's location.
  const where = (found: ReturnType<typeof of>) => {
    const location = found.find((item) => item.location !== undefined)?.location;
    return location === undefined ? {} : { location };
  };
  const notices = of('run-with-warning');
  if (notices.length > 0) {
    entries.push(`${strict.setting}=${String(strict.value)}`);
    managed.push(strict.setting);
    const later = effects.at(-1);
    context.warn({
      code: 'strict-allow-scripts-from-node',
      ...where(notices),
      message: `npm is not pinned for the repository, and ${notices.map((item) => item.text).join(', and ')} ${notices.length === 1 ? 'runs' : 'run'} dependency install scripts that allowScripts does not cover unless ${strict.setting} is set, so depcurfew apply writes ${strict.setting}=${String(strict.value)}${later === undefined ? '' : `; with it, in npm ${later.since} and later ${later.value}`}`,
      fix: `Pin one npm version (packageManager or devEngines) to configure for it alone; with ${strict.setting}, review the packages an install stops at and add them to installScripts.allow or installScripts.deny in depcurfew.json`,
    });
  }
  const running = of('run');
  if (running.length > 0) {
    const since = sinceOf(tool.installScripts.allowList.availableSince) ?? '';
    context.warn({
      code: 'scripts-not-enforceable',
      ...where(running),
      message: `${running.map((item) => item.text).join(', and ')} ${running.length === 1 ? 'runs' : 'run'} every dependency install script and ${running.length === 1 ? 'has' : 'have'} no allow-list, so "deny" cannot be enforced there`,
      fix: `Install npm ${since} or later before packages are installed there (npm install -g npm@${since}), or move to a Node.js release that comes with it; npm 12 blocks dependency scripts by default`,
    });
  }
}

/** Whether some npm in use (or the pinned one) has a setting available since `since`. */
function someSupports(context: Context, since: string | undefined, setting: string): boolean {
  if (context.inUse.length === 0) return context.supports(since, setting);
  const required = since === undefined ? undefined : parseVersion(since);
  return required === undefined || context.inUse.some((entry) => entry.versions.some((version) => compareVersions(version, required) >= 0));
}

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
      if (context.inUse.length > 0) {
        scriptsForVersionsInUse(context, entries, managed);
      } else if (defaults === 'run-with-warning' && context.supports(strict.since, strict.setting)) {
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
        if (wanted && someSupports(context, sinceOf(tool.installScripts.allowList.availableSince), setting)) {
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
