// pnpm: settings in pnpm-workspace.yaml (read in every version that has them, also in single-package projects);
// the allow-list is allowBuilds since 10.26.0 and onlyBuiltDependencies before.
import { POLICY_FILE } from '../../policy/defaults.ts';
import { pnpmNpmrcAllowsAllBuilds } from '../../doctor/effective.ts';
import { yamlSetting } from '../../doctor/settings.ts';
import { extraOf, firstFile, isRecord, isSwitch, mergesYamlKeys, settingOf, sinceOf, switchIsOff } from '../facts.ts';
import { isSecurityExclusionFormat, restoreEntries, securityEntries, withoutComments, type KeptEntry } from '../renovate-exclusions.ts';
import { allowedInFiles, allowedNames, cooldownValue, deniedNames, eachSource, exclusions, sameList, scriptsDefault, writeDenyList, type SourceKind } from './common.ts';
import type { Context, ManagerGenerator } from './context.ts';
import { formatVersion } from '../version.ts';

interface LegacyAllowList {
  since: string;
  workspaceFileSince: string;
  removedIn: string;
}

const isLegacy = (value: unknown): value is LegacyAllowList =>
  isRecord(value) && typeof value['since'] === 'string' && typeof value['workspaceFileSince'] === 'string' && typeof value['removedIn'] === 'string';

const isIgnoredList = (value: unknown): value is { since: string; workspaceFileSince: string } =>
  isRecord(value) && typeof value['since'] === 'string' && typeof value['workspaceFileSince'] === 'string';

/**
 * Adds names to a list setting of pnpm 10 (onlyBuiltDependencies, ignoredBuiltDependencies): in pnpm-workspace.yaml from
 * the version that reads it there, else in the "pnpm" field of package.json. Entries already there stay.
 */
function mergeList(context: Context, workspaceFileSince: string, setting: string, names: readonly string[]): void {
  const inWorkspaceFile = context.atLeast(workspaceFileSince);
  const file = inWorkspaceFile ? (firstFile(context.tool.cooldown.configFiles) ?? 'pnpm-workspace.yaml') : 'package.json';
  const target = inWorkspaceFile ? context.yaml(file) : context.json(file);
  const path = inWorkspaceFile ? [setting] : ['pnpm', setting];
  context.writes('installScripts', path.join('.'), file);
  const current = target.get(path);
  const list = Array.isArray(current) ? [...(current as unknown[])] : [];
  const merged = [...list, ...names.filter((name) => !list.includes(name))];
  if (!sameList(current, merged)) target.set(path, merged);
}

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
      if (context.supports(allowAll.since, allowAll.setting)) {
        yaml.set([allowAll.setting], allowAll.value);
        context.writes('installScripts', allowAll.setting, file);
      }
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
      // pnpm tests the switch for truth, so every value but the ones it reads as off allows every build: "false"
      // and yes too, also when the key comes in through a merge key (<<), which the value written here overrides.
      const current = yaml.get([allowAll.setting]);
      if (context.atLeast(allowAll.since) && !switchIsOff(allowAll, current)) {
        const found = context.exists(file) ? yamlSetting(context.read(file), [allowAll.setting], { merge: mergesYamlKeys(tool) }) : undefined;
        const written = `${allowAll.setting}: ${JSON.stringify(current)}`;
        const where = found === undefined ? '' : ` (line ${found.line}${found.mergedAt === undefined ? '' : `, through the merge key << at line ${found.mergedAt}`})`;
        const off = (allowAll.off ?? [false]).map((value) => JSON.stringify(value));
        const reading = current === allowAll.value ? '' : ` (${context.name} reads every value but ${[off.slice(0, -1).join(', '), off.at(-1)].filter(Boolean).join(' and ')} as true)`;
        context.warn({
          code: 'allow-all-replaced',
          ...(found === undefined ? {} : { location: { file, line: found.line } }),
          message: `${context.name}: ${written} in ${file}${where} allowed every build script${reading}; set to false because the policy denies install scripts`,
          fix: `Add the packages whose install scripts must run to installScripts.allow in ${POLICY_FILE}, then run depcurfew apply again`,
        });
        yaml.set([allowAll.setting], false);
        context.writes('installScripts', allowAll.setting, file);
      }
      const setting = settingOf(tool.installScripts.allowList.setting) ?? 'allowBuilds';
      const since = sinceOf(tool.installScripts.allowList.availableSince);
      const wanted = policy.installScripts.allow.length > 0;
      if (context.atLeast(since)) {
        const names = wanted ? allowedNames(context, setting) : [];
        if (names.length > 0) context.writes('installScripts', setting, file);
        for (const name of names) if (yaml.get([setting, name]) !== true) yaml.set([setting, name], true);
        writeDenyList(context);
      } else {
        if ((wanted || mustList) && (mustList ? context.atLeast(legacy.since) : context.supports(legacy.since, 'onlyBuiltDependencies'))) {
          mergeList(context, legacy.workspaceFileSince, 'onlyBuiltDependencies', allowedNames(context, 'onlyBuiltDependencies'));
        }
        // Before allowBuilds, ignoredBuiltDependencies records the denials (the 10.26.0 changelog calls allowBuilds
        // false the same thing); a package an allow-list entry lets build is left alone (decision D-088).
        const ignored = extraOf(tool, 'ignoredBuiltDependencies', isIgnoredList);
        if (policy.installScripts.deny.length > 0 && context.supports(ignored.since, 'ignoredBuiltDependencies')) {
          const allowedByFile = allowedInFiles(context);
          const names = deniedNames(context, 'ignoredBuiltDependencies').filter((name) => !allowedByFile.has(name));
          if (names.length > 0) mergeList(context, ignored.workspaceFileSince, 'ignoredBuiltDependencies', names);
        }
      }
      // pnpm 10 also takes dangerously-allow-all-builds from the root .npmrc while pnpm-workspace.yaml has no build
      // settings (extra.npmrcBuildSettings), checked after the lists above are written. The line stays, as every setting
      // apply does not manage; the switch is turned off in pnpm-workspace.yaml, which pnpm reads over .npmrc.
      const fromNpmrc = pnpmNpmrcAllowsAllBuilds(tool, context.version, (name) => (context.exists(name) ? context.read(name) : undefined));
      if (fromNpmrc !== undefined) {
        context.warn({
          code: 'allow-all-replaced',
          location: { file: '.npmrc', line: fromNpmrc.line },
          message: `${context.name}: ${fromNpmrc.key}=${fromNpmrc.value} in .npmrc (line ${fromNpmrc.line}) allowed every build script, because ${file} has no build settings that override it; set ${allowAll.setting}: false in ${file}, which wins, because the policy denies install scripts`,
          fix: `Remove the ${fromNpmrc.key} line from .npmrc; add the packages whose install scripts must run to installScripts.allow in ${POLICY_FILE}, then run depcurfew apply again`,
        });
        yaml.set([allowAll.setting], false);
        context.writes('installScripts', allowAll.setting, file);
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
    context.writes('sources', exoticSetting, file);
  }
  return minutes;
};

