// npm: .npmrc keys in a managed block; the allowScripts allow-list in the root package.json.
import { versionedValue } from '../../doctor/effective.ts';
import { iniEntries } from '../../doctor/settings.ts';
import type { ScriptPolicy } from '../../knowledge/types.ts';
import { npmInUseText } from '../../doctor/rules/bundled-versions.ts';
import { POLICY_FILE } from '../../policy/defaults.ts';
import { hasManagedLines } from '../block.ts';
import { listing } from '../requirements.ts';
import { extraOf, firstFile, isRecord, isSwitch, settingOf, sinceOf, values } from '../facts.ts';
import { compareVersions, formatVersion, parseVersion, type Version } from '../version.ts';
import { allowedNames, cooldownValue, eachSource, exclusions, scriptsDefault, writeDenyList } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';

const isString = (value: unknown): value is string => typeof value === 'string';
/** The most places a warning names; a matrix of many Node.js versions would otherwise make one sentence of hundreds. */
const MAX_PLACES = 6;
const isBefore = (value: unknown): value is { setting: string; exclusive: { since: string; until: string }; beforeWinsSince: string } =>
  isRecord(value) && typeof value['setting'] === 'string' && isRecord(value['exclusive']) && typeof value['beforeWinsSince'] === 'string';
const isEffects = (value: unknown): value is { since: string; value: string }[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry['since'] === 'string' && typeof entry['value'] === 'string');

/**
 * installScripts "deny" (decisions D-105 and D-109): what the npm versions the directory runs need, from every place
 * npm runs (the pin among them). Any of 11.16 to 11.x runs scripts allowScripts does not cover with a notice unless
 * strict-allow-scripts is set, so it is written; npm 12 reads it too and stops the install at such a script, which a
 * warning says unless the pin is such an npm and no place runs npm 12. An npm before 11.16 cannot block them at all,
 * which scripts-not-enforceable says with where that npm comes from.
 */
function scriptsForVersionsInUse(context: Context, file: string, entries: string[], managed: string[]): void {
  const { tool } = context;
  const defaults = values(tool.installScripts.defaultPolicy)[0] ?? [];
  const strict = extraOf(tool, 'strictAllowScripts', isSwitch);
  const effects = tool.extra?.['strictAllowScriptsEffect'] === undefined ? [] : extraOf(tool, 'strictAllowScriptsEffect', isEffects);
  const of = (policy: ScriptPolicy) =>
    context.inUse.flatMap((entry) => {
      const versions = entry.versions.filter((version) => versionedValue(defaults, version) === policy);
      return versions.length === 0 ? [] : [{ text: npmInUseText(entry, versions), several: versions.length > 1, entry }];
    });
  // The first place that declares such an npm, for the warning's location.
  const where = (found: ReturnType<typeof of>) => {
    const location = found.find((item) => item.entry.location !== undefined)?.entry.location;
    return location === undefined ? {} : { location };
  };
  // One list, "npm 11.19.1 (installed in job test of ci.yml, line 9) and npm 11.16.0 (…)", of at most MAX_PLACES places.
  const places = (found: ReturnType<typeof of>) => {
    const texts = found.map((item) => item.text);
    return texts.length <= MAX_PLACES ? listing(texts) : `${texts.slice(0, MAX_PLACES - 1).join(', ')} and ${texts.length - MAX_PLACES + 1} more places`;
  };
  // "runs" for one version of one place, "run" for more.
  const plural = (found: ReturnType<typeof of>) => found.length > 1 || found[0]?.several === true;
  const notices = of('run-with-warning');
  if (notices.length > 0) {
    entries.push(`${strict.setting}=${String(strict.value)}`);
    managed.push(strict.setting);
    context.writes('installScripts', strict.setting, file);
    const blocking = of('deny-except-allowlist');
    const pin = context.inUse.find((entry) => entry.pin === true);
    const pinNeedsIt = pin !== undefined && notices.some((item) => item.entry === pin);
    // A pinned npm 11.16 to 11.x needs the setting itself (decision D-060); the warning is for what else it does.
    if (!pinNeedsIt || blocking.length > 0) {
      const later = effects.at(-1);
      const since = values(tool.installScripts.defaultPolicy)[0]?.find((entry) => entry.value === 'deny-except-allowlist')?.since ?? later?.since ?? '';
      const target = pin !== undefined && versionedValue(defaults, pin.versions[0] as Version) === 'deny-except-allowlist' ? formatVersion(pin.versions[0] as Version) : since;
      const effect = later === undefined ? '' : `; with it, in npm ${later.since} and later ${later.value}${blocking.length === 0 ? '' : `, which applies to ${places(blocking)}`}`;
      context.warn({
        code: 'strict-allow-scripts-for-npm-in-use',
        ...where(notices),
        message: `${pin === undefined ? `npm is not pinned for ${context.project ?? 'the repository'}, and ` : ''}${places(notices)} ${plural(notices) ? 'run' : 'runs'} dependency install scripts that allowScripts does not cover unless ${strict.setting} is set, so depcurfew apply writes ${strict.setting}=${String(strict.value)}${effect}`,
        fix: `Make every place listed here run npm ${since} or later (npm install -g npm@${target} before it installs packages), and depcurfew apply leaves ${strict.setting} out; pinning npm in packageManager or devEngines does not change the npm they run. Until then, review the packages an install stops at and add them to installScripts.allow or installScripts.deny in ${POLICY_FILE}`,
      });
    }
  }
  // An npm depcurfew cannot tell counts as one that runs every dependency install script (decision D-111).
  const unknown = context.inUse.filter((entry) => entry.unknown !== undefined).map((entry) => ({ text: npmInUseText(entry), several: false, entry }));
  if (unknown.length > 0) {
    const since = sinceOf(tool.installScripts.allowList.availableSince) ?? '';
    context.warn({
      code: 'scripts-not-enforceable',
      ...where(unknown),
      message: `${places(unknown)} may run every dependency install script, so depcurfew counts ${unknown.length > 1 ? 'them as ones that do' : 'it as one that does'}, and "deny" may not be enforced there`,
      fix: `Declare a Node.js version depcurfew knows there (an exact release it knows or a release line such as 24), or install npm ${since} or later before packages are installed there (npm install -g npm@${since}); npm 12 blocks dependency scripts by default`,
    });
  }
  const running = of('run');
  if (running.length > 0) {
    const since = sinceOf(tool.installScripts.allowList.availableSince) ?? '';
    const several = plural(running);
    const pinRuns = running.find((item) => item.entry.pin === true)?.entry;
    context.warn({
      code: 'scripts-not-enforceable',
      ...where(running),
      message: `${places(running)} ${several ? 'run' : 'runs'} every dependency install script and ${several ? 'have' : 'has'} no allow-list, so "deny" cannot be enforced there`,
      // The pinned version is raised where it is pinned; the other places install a newer npm or choose a newer Node.js.
      fix: pinRuns !== undefined && running.length === 1
        ? `Require npm ${since} or later in ${pinRuns.where} (npm 12 blocks dependency scripts by default)`
        : `Install npm ${since} or later before packages are installed there (npm install -g npm@${since}), or move to a Node.js release that comes with it${pinRuns === undefined ? '' : `, and require it in ${pinRuns.where}`}; npm 12 blocks dependency scripts by default`,
    });
  }
}

/** Whether some npm in use (or the pinned one) has a setting available since `since`. */
function someSupports(context: Context, since: string | undefined, setting: string): boolean {
  if (context.inUse.length === 0) return context.supports(since, setting);
  const required = since === undefined ? undefined : parseVersion(since);
  // An npm depcurfew cannot tell may have it: the setting is written for it.
  if (required === undefined || context.inUse.some((entry) => entry.unknown !== undefined || entry.versions.some((version) => compareVersions(version, required) >= 0))) return true;
  // No npm in use has it: a pinned version too old for it says so in version-too-old, as without other places.
  context.supports(since, setting);
  return false;
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
        context.writes('installScripts', allowAll.setting, file);
      }
    } else {
      if (context.atLeast(allowAll.since)) managed.push(allowAll.setting);
      // Before npm 12, dependency scripts that allowScripts does not cover still run (with a notice from 11.16.0):
      // strict-allow-scripts turns them into an error; older versions have no allow-list at all.
      const defaults = scriptsDefault(context).value;
      const strict = extraOf(tool, 'strictAllowScripts', isSwitch);
      if (context.inUse.length > 0) {
        scriptsForVersionsInUse(context, file, entries, managed);
      } else if (defaults === 'run-with-warning' && context.supports(strict.since, strict.setting)) {
        entries.push(`${strict.setting}=${String(strict.value)}`);
        managed.push(strict.setting);
        context.writes('installScripts', strict.setting, file);
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
          const names = allowedNames(context, setting);
          if (names.length > 0) context.writes('installScripts', setting, listFile);
          for (const name of names) if (json.get([setting, name]) !== true) json.set([setting, name], true);
        }
      }
      writeDenyList(context);
    }
  }

  eachSource(context, (_kind, setting, access) => {
    entries.push(`${setting}=${access === 'deny' ? 'none' : 'all'}`);
    managed.push(setting);
    context.writes('sources', setting, file);
  });

  // Without entries, the file is still edited when it sets a managed key by hand (such as the switch that allows
  // every install script while the policy denies them), so that the key is commented out.
  if (entries.length > 0 || hasManagedLines(context.read(file)) || (managed.length > 0 && context.exists(file))) {
    context.ini(file, entries, managed);
  }
  return minutes;
};
