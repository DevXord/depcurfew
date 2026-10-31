// What `depcurfew apply --user` writes into each tool's user file: only settings the tool reads from that file
// (user.settings in the knowledge base), for the version in use. Parts of the policy that only a project can hold get
// a warning instead (user-setting-project-only).
import { extraOf } from '../apply/facts.ts';
import { cooldownValue, eachSource, exclusions, scriptsDefault } from '../apply/generators/common.ts';
import type { Context } from '../apply/generators/context.ts';
import { evidenceOf } from '../knowledge/facts.ts';
import type { ToolId, UserSetting, UserSettingPurpose } from '../knowledge/types.ts';
import { compareVersions, parseVersion } from '../apply/version.ts';

export interface UserTarget {
  context: Context;
  /** The user file, relative to the context's workspace root. */
  file: string;
  /** The user file as messages show it (~/.npmrc). */
  shown: string;
}

/** The user-file key for a purpose and the version in use: undefined when the tool has none or the version does not read it. */
export function userKey(context: Context, purpose: UserSettingPurpose): string | undefined {
  const settings = context.tool.user === undefined ? [] : (evidenceOf(context.tool.user.settings)[0]?.value ?? []);
  const candidates = settings.filter((setting) => setting.purpose === purpose);
  const usable = candidates.filter((setting) => before(context, setting));
  const current = usable.find((setting) => context.atLeast(setting.since));
  if (current !== undefined) return current.key;
  // Too old for every spelling: report the oldest one the tool has, as for project settings.
  const oldest = usable[0];
  if (oldest !== undefined) context.supports(oldest.since, oldest.key);
  return undefined;
}

function before(context: Context, setting: UserSetting): boolean {
  if (setting.until === undefined || context.version === undefined) return setting.until === undefined || context.version !== undefined;
  const until = parseVersion(setting.until);
  return until === undefined || compareVersions(context.version, until) < 0;
}

function projectOnly(target: UserTarget, part: string, where: string): void {
  target.context.warn({
    code: 'user-setting-project-only',
    location: { file: target.shown },
    message: `${target.context.name} reads ${part} only from ${where}, not from ${target.shown}, so depcurfew apply --user does not write it`,
    fix: `Run depcurfew apply in each project to write ${part} there`,
  });
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** npm and Deno: keys in a managed block at the top of ~/.npmrc; Deno reads only min-release-age, in whole days. */
function npmrc(targets: readonly UserTarget[]): void {
  const entries: string[] = [];
  const managed: string[] = [];
  const add = (key: string, lines: readonly string[]) => {
    if (managed.includes(key)) return;
    managed.push(key);
    entries.push(...lines);
  };
  for (const target of targets) {
    const { context } = target;
    const { policy } = context;
    if (policy.cooldown !== undefined) {
      const key = userKey(context, 'cooldown');
      if (key !== undefined) {
        if (context.tool.id === 'deno') {
          add(key, [`${key}=${Math.ceil(policy.cooldown.minimum.minutes / 1440)}`]);
        } else {
          const value = cooldownValue(context);
          if (value !== undefined) add(key, [`${key}=${value.value}`]);
        }
      }
      const excludeKey = userKey(context, 'cooldownExclude');
      const patterns = excludeKey === undefined ? undefined : exclusions(context);
      if (excludeKey !== undefined && patterns !== undefined) {
        const suffix = extraOf(context.tool, 'npmrcListSyntax', isString);
        add(excludeKey, patterns.map((pattern) => `${excludeKey}${suffix}=${pattern}`));
      }
    }
    if (context.tool.id !== 'npm') continue;
    if (policy.installScripts?.default === 'deny') {
      if (scriptsDefault(context).value === 'run-with-warning') {
        const strict = userKey(context, 'scriptsStrict');
        if (strict !== undefined) add(strict, [`${strict}=true`]);
      }
      const allowKey = policy.installScripts.allow.length === 0 ? undefined : userKey(context, 'scriptsAllow');
      if (allowKey !== undefined) add(allowKey, [`${allowKey}=${policy.installScripts.allow.join(',')}`]);
    }
    eachSource(context, (kind, setting, access) => {
      const purpose = ({ git: 'sourceGit', remoteTarball: 'sourceRemote', file: 'sourceFile', directory: 'sourceDirectory' } as const)[kind];
      const key = userKey(context, purpose) ?? setting;
      add(key, [`${key}=${access === 'deny' ? 'none' : 'all'}`]);
    });
  }
  const first = targets[0];
  if (first === undefined) return;
  // Keys this run does not write but an earlier one may have: the block is replaced as a whole.
  first.context.ini(first.file, entries, managed);
}

/** Tools with a user file that depcurfew writes; tools sharing one file (npm and Deno) are written together. */
export const USER_GENERATORS: Partial<Record<ToolId, (targets: readonly UserTarget[]) => void>> = {
  npm: npmrc,
  deno: npmrc,
};

/** A tool's policy parts its user file cannot hold, reported once per tool. */
export function reportProjectOnly(target: UserTarget): void {
  const { context } = target;
  const allow = context.policy.installScripts?.allow ?? [];
  if (context.tool.id === 'deno' && allow.length > 0) projectOnly(target, 'allowScripts', 'deno.json');
  if (context.tool.id === 'deno' && (context.policy.cooldown?.exclude.length ?? 0) > 0) projectOnly(target, 'the release-age exceptions', 'deno.json');
}
