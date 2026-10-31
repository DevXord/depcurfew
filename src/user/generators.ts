// What `depcurfew apply --user` writes into each tool's user file: only settings the tool reads from that file
// (user.settings in the knowledge base), for the version in use. Parts of the policy that only a project can hold get
// a warning instead (user-setting-project-only).
import { extraOf, isRecord, isSwitch } from '../apply/facts.ts';
import { BLOCK_START, blockLines, joinLines, removeBlock, splitLines, SUPERSEDED } from '../apply/block.ts';
import { buildAllowList, compactDuration, pythonNames, tomlValue } from '../apply/generators/python.ts';
import { convertCooldown } from '../policy/convert.ts';
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

interface ScriptsSwitch {
  setting: string;
  allow: unknown;
  deny: unknown;
}
const isScriptsSwitch = (value: unknown): value is ScriptsSwitch => isRecord(value) && typeof value['setting'] === 'string' && 'allow' in value && 'deny' in value;

/** pnpm: <configDir>/rc (INI, pnpm 10) or <configDir>/config.yaml (pnpm 11 and later); allowBuilds is project-only. */
function pnpm([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const yaml = target.file.endsWith('.yaml');
  const values: [string, unknown][] = [];
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) values.push([key, value.value]);
    const excludeKey = userKey(context, 'cooldownExclude');
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined && patterns.length > 0) values.push([excludeKey, patterns]);
    const strict = userKey(context, 'cooldownStrict');
    if (strict !== undefined) values.push([strict, true]);
  }
  if (policy.installScripts?.default === 'deny') {
    const strict = userKey(context, 'scriptsStrict');
    if (strict !== undefined) values.push([strict, true]);
    const allowKey = userKey(context, 'scriptsAllow') ?? userKey(context, 'buildsAllow');
    if (policy.installScripts.allow.length > 0) {
      if (allowKey !== undefined) values.push([allowKey, policy.installScripts.allow]);
      else projectOnly(target, 'allowBuilds', 'pnpm-workspace.yaml');
    }
  }
  const sources = policy.sources;
  if (sources?.git === 'deny' || sources?.remoteTarball === 'deny') {
    const exotic = userKey(context, 'sourcesExotic');
    if (exotic !== undefined) values.push([exotic, true]);
  }
  if (yaml) {
    if (values.length > 0) context.yaml(target.file).setMany(values.map(([key, value]) => [[key], value] as const));
    return;
  }
  const entries = values.flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => `${key}[]=${String(item)}`) : [`${key}=${String(value)}`]));
  context.ini(target.file, entries, values.map(([key]) => key));
}

/** Yarn: ~/.yarnrc.yml with the same keys as a project; dependenciesMeta lives in the root package.json only. */
function yarn([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const yaml = context.yaml(target.file);
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) yaml.set([key], value.value);
    const excludeKey = userKey(context, 'cooldownExclude');
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined && patterns.length > 0) yaml.set([excludeKey], patterns);
  }
  if (policy.installScripts !== undefined) {
    const scripts = extraOf(context.tool, 'scriptsSwitch', isScriptsSwitch);
    const key = userKey(context, 'scriptsStrict') ?? userKey(context, 'buildsDeny');
    if (key !== undefined) yaml.set([key], policy.installScripts.default === 'deny' ? scripts.deny : scripts.allow);
    if (policy.installScripts.default === 'deny' && policy.installScripts.allow.length > 0) projectOnly(target, 'dependenciesMeta', 'the root package.json of each project');
  }
  if (policy.sources?.git !== undefined) {
    const key = userKey(context, 'sourceGit');
    if (key !== undefined) yaml.set([key], policy.sources.git === 'deny' ? [] : ['**']);
  }
}

/** Bun: [install] keys in a managed block in .bunfig.toml; trustedDependencies is project-only. */
function bun([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const entries: string[] = [];
  const managed: string[] = [];
  let table = 'install';
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      const split = splitKey(key);
      table = split.table;
      entries.push(`${split.key} = ${String(value.value)}`);
      managed.push(split.key);
    }
    const excludeKey = userKey(context, 'cooldownExclude');
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      const split = splitKey(excludeKey);
      managed.push(split.key);
      if (patterns.length > 0) entries.push(`${split.key} = ${tomlValue(patterns)}`);
    }
  }
  if (policy.installScripts?.default === 'deny' && policy.installScripts.allow.length > 0) projectOnly(target, 'trustedDependencies', 'the package.json of each project');
  context.toml(target.file, table, entries, managed);
}

function splitKey(key: string): { table: string; key: string } {
  const at = key.lastIndexOf('.');
  return at < 0 ? { table: '', key } : { table: key.slice(0, at), key: key.slice(at + 1) };
}

/** uv: top-level keys of uv.toml in a managed block; the build allow-list forces those packages to be built. */
function uv([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const entries: string[] = [];
  const managed: string[] = [];
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      entries.push(`${key} = ${tomlValue(value.value)}`);
      managed.push(key);
    }
    const excludeKey = userKey(context, 'cooldownExclude');
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    if (excludeKey !== undefined && patterns !== undefined) {
      managed.push(excludeKey);
      const exempt = extraOf(context.tool, 'excludeValue', (value): value is boolean => typeof value === 'boolean');
      const names = pythonNames(patterns);
      if (names.length > 0) entries.push(`${excludeKey} = { ${names.map((name) => `${JSON.stringify(name)} = ${String(exempt)}`).join(', ')} }`);
    }
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) {
      const build = extraOf(context.tool, 'buildSwitch', isSwitch);
      entries.push(`${deny} = ${tomlValue(build.value)}`);
      managed.push(deny);
      const allowKey = userKey(context, 'buildsAllow');
      if (allowKey !== undefined) {
        managed.push(allowKey);
        const names = policy.installScripts.allow.length > 0 ? buildAllowList(context, allowKey) : [];
        if (names.length > 0) entries.push(`${allowKey} = ${tomlValue(names)}`);
      }
    }
  }
  context.toml(target.file, '', entries, managed);
}

/** A managed block at the top of an INI section (pip reads [global] for every command). */
export function writeSectionBlock(body: string, section: string, entries: readonly string[], managedKeys: readonly string[]): string {
  const managed = new Set(managedKeys);
  const lines = removeBlock(splitLines(body)).lines;
  const header = lines.findIndex((line) => line.trim().toLowerCase() === `[${section}]`);
  let inSection = false;
  const kept = lines.map((line) => {
    if (/^\s*\[.*\]\s*$/u.test(line)) inSection = line.trim().toLowerCase() === `[${section}]`;
    const key = /^\s*([^#;=\s][^=]*?)\s*[=:]/u.exec(line)?.[1]?.trim().toLowerCase();
    return inSection && key !== undefined && managed.has(key) ? `${SUPERSEDED}${line.trim()}` : line;
  });
  if (entries.length === 0) return joinLines(kept);
  const block = blockLines(entries, BLOCK_START);
  if (header === -1) {
    const trimmed = kept.length > 0 && kept.at(-1) === '' ? kept.slice(0, -1) : kept;
    return joinLines([...trimmed, ...(trimmed.length > 0 ? [''] : []), `[${section}]`, ...block, '']);
  }
  return joinLines([...kept.slice(0, header + 1), ...block, ...kept.slice(header + 1)]);
}

/** pip: [global] of the user pip.conf: uploaded-prior-to as PnD, only-binary and the build allow-list. */
function pip([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const entries: string[] = [];
  const managed: string[] = [];
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const result = convertCooldown(context.tool, policy.cooldown.minimum);
    if (key !== undefined && result.ok) {
      entries.push(`${key} = P${String(result.value)}D`);
      managed.push(key);
    }
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) {
      entries.push(`${deny} = :all:`);
      managed.push(deny);
      const allowKey = userKey(context, 'buildsAllow');
      if (allowKey !== undefined) {
        managed.push(allowKey);
        const names = policy.installScripts.allow.length > 0 ? buildAllowList(context, allowKey) : [];
        if (names.length > 0) entries.push(`${allowKey} = ${names.join(',')}`);
      }
    }
  }
  context.workspace.edit(target.file, (body) => writeSectionBlock(body, 'global', entries, managed));
}

/** Poetry: config.toml with the keys of poetry.toml ([solver] and [installer] tables). */
function poetry([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  const tables = new Map<string, { entries: string[]; managed: string[] }>();
  const put = (dotted: string, value: unknown) => {
    const { table, key } = splitKey(dotted);
    const entry = tables.get(table) ?? { entries: [], managed: [] };
    entry.entries.push(`${key} = ${tomlValue(value)}`);
    entry.managed.push(key);
    tables.set(table, entry);
  };
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) put(key, value.value);
    const excludeKey = userKey(context, 'cooldownExclude');
    const patterns = excludeKey === undefined ? undefined : exclusions(context);
    // Written as a TOML array, as poetry.toml (extra.excludeFormat).
    if (excludeKey !== undefined && patterns !== undefined && patterns.length > 0) put(excludeKey, pythonNames(patterns));
  }
  if (policy.installScripts?.default === 'deny') {
    const deny = userKey(context, 'buildsDeny');
    if (deny !== undefined) put(deny, extraOf(context.tool, 'buildSwitch', isSwitch).value);
    const allowKey = userKey(context, 'buildsAllow');
    const names = allowKey === undefined || policy.installScripts.allow.length === 0 ? [] : buildAllowList(context, allowKey);
    if (allowKey !== undefined && names.length > 0) put(allowKey, names);
  }
  for (const [table, entry] of tables) context.toml(target.file, table, entry.entries, entry.managed, table);
}

/** PDM: strategy.exclude-newer in the global config.toml; build settings exist only in pyproject.toml. */
function pdm([target]: readonly UserTarget[]): void {
  if (target === undefined) return;
  const { context } = target;
  const { policy } = context;
  if (policy.cooldown !== undefined) {
    const key = userKey(context, 'cooldown');
    const value = key === undefined ? undefined : cooldownValue(context);
    if (key !== undefined && value !== undefined) {
      const { table, key: name } = splitKey(key);
      const text = typeof value.value === 'string' ? compactDuration(value.value) : `${String(value.value)}d`;
      context.toml(target.file, table, [`${name} = ${JSON.stringify(text)}`], [name], table);
    }
  }
  if (policy.installScripts?.default === 'deny') projectOnly(target, 'only-binary and no-binary', 'pyproject.toml');
}

/** Tools with a user file that depcurfew writes; tools sharing one file (npm and Deno) are written together. */
export const USER_GENERATORS: Partial<Record<ToolId, (targets: readonly UserTarget[]) => void>> = {
  npm: npmrc,
  deno: npmrc,
  pnpm,
  yarn,
  bun,
  uv,
  pip,
  poetry,
  pdm,
};

/** A tool's policy parts its user file cannot hold, reported once per tool. */
export function reportProjectOnly(target: UserTarget): void {
  const { context } = target;
  const allow = context.policy.installScripts?.allow ?? [];
  if (context.tool.id === 'deno' && allow.length > 0) projectOnly(target, 'allowScripts', 'deno.json');
  if (context.tool.id === 'deno' && (context.policy.cooldown?.exclude.length ?? 0) > 0) projectOnly(target, 'the release-age exceptions', 'deno.json');
}
