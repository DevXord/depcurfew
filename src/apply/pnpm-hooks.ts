// The code pnpm runs that can change its settings after it has read them (decision D-164): the pnpmfiles of the
// project (.pnpmfile.mjs, .pnpmfile.cjs, the pnpmfile and globalPnpmfile settings) and those of config dependencies
// named like plugins, all of whose hooks.updateConfig may set any setting (extra.pnpmfiles, extra.configPlugins).
// depcurfew does not run them, so it cannot know what they set; doctor and explain say so.
import { posix } from 'node:path';
import type { PnpmfilesKnowledge, PnpmKnownPlugin, PnpmPluginsKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { yamlSetting } from '../doctor/settings.ts';
import { extraOf, isRecord, mergesYamlKeys, values } from './facts.ts';
import { pnpmOwner, readPnpmIncludes, type PnpmIncludes } from './pnpm-includes.ts';
import { compareVersions, parseVersion, type Version } from './version.ts';

/** A pnpmfile or config-dependency plugin pnpm loads. */
export type PnpmHook =
  | {
      kind: 'pnpmfile';
      /** The pnpmfile when it is a file of the directory; else the file whose setting names it. */
      file: string;
      line?: number;
      /** The setting that names it (pnpmfile, globalPnpmfile); absent for the file pnpm looks for by itself. */
      setting?: string;
      /** The path the setting gives, when the pnpmfile is not a file depcurfew can read. */
      path?: string;
      /** The line of the first mention of updateConfig in the pnpmfile, when there is one. */
      updateConfigLine?: number;
    }
  | {
      kind: 'plugin';
      name: string;
      /** The version given in configDependencies. */
      spec: string;
      file: string;
      line: number;
      /** What the knowledge base knows it sets (extra.knownPlugins), for a version that may be such a release. */
      known?: PnpmKnownPlugin;
    };

type PnpmfileHook = Extract<PnpmHook, { kind: 'pnpmfile' }>;

const isPnpmfiles = (value: unknown): value is PnpmfilesKnowledge =>
  isRecord(value) && typeof value['updateConfigSince'] === 'string' && Array.isArray(value['defaults']) && typeof value['setting'] === 'string';
const isPlugins = (value: unknown): value is PnpmPluginsKnowledge => isRecord(value) && typeof value['setting'] === 'string' && Array.isArray(value['patterns']);
const isKnownPlugins = (value: unknown): value is PnpmKnownPlugin[] =>
  Array.isArray(value) && value.every((item) => isRecord(item) && typeof item['name'] === 'string' && typeof item['since'] === 'string' && isRecord(item['settings']));

const atLeast = (version: Version | undefined, since: string) => {
  const required = parseVersion(since);
  return version === undefined || required === undefined || compareVersions(version, required) >= 0;
};

/** The value of a versioned list in effect at `version` (the latest entry when it is unknown). */
function inEffect<T>(list: readonly { since: string; value: T }[], version: Version | undefined): T | undefined {
  let current: T | undefined;
  for (const entry of list) if (atLeast(version, entry.since)) current = entry.value;
  return current;
}

/** A name pattern with * for any text, as a regular expression. */
function patternOf(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')).join('.*')}$`, 'u');
}

/** Whether a configDependencies entry may be a release from `since` on: an exact version below it is not. */
function mayBeFrom(spec: string, since: string): boolean {
  const exact = /^v?(\d+\.\d+\.\d+)(?:\+.*)?$/u.exec(spec.trim())?.[1];
  const version = exact === undefined ? undefined : parseVersion(exact);
  const required = parseVersion(since);
  return version === undefined || required === undefined || compareVersions(version, required) >= 0;
}

/** A path a setting names, from the directory: undefined when it lies outside it (absolute, ~, an environment variable, ..). */
function insidePath(from: string, path: string): string | undefined {
  if (path === '' || path.includes('\\') || /^[~$/]/u.test(path) || /^[A-Za-z]:/u.test(path)) return undefined;
  const joined = posix.normalize(posix.join(posix.dirname(from), path));
  return joined === '..' || joined.startsWith('../') ? undefined : joined;
}

export interface PnpmHookSources {
  /** The text of a file of the directory, undefined when it is missing or cannot be read. */
  read(file: string): string | undefined;
  /** Whether a regular file is at the path. */
  isFile(file: string): boolean;
  /** The workspace packages, as directories from the directory, for sharedWorkspaceLockfile: false. */
  packages?: readonly string[];
  /** The include index when it is already read. */
  includes?: PnpmIncludes;
}

/**
 * The pnpmfiles and plugins the pnpm version loads in the directory, in the order pnpm loads them; none before the
 * version whose pnpmfiles can change settings, and none with ignorePnpmfile: true.
 */
export function pnpmHooks(tool: ToolKnowledge, version: Version | undefined, sources: PnpmHookSources, manifest = 'pnpm-workspace.yaml'): PnpmHook[] {
  if (tool.extra?.['pnpmfiles'] === undefined) return [];
  const facts = extraOf(tool, 'pnpmfiles', isPnpmfiles);
  if (!atLeast(version, facts.updateConfigSince)) return [];
  const options = { merge: mergesYamlKeys(tool) };
  const includes = sources.includes ?? readPnpmIncludes(tool, version, sources.read, manifest);
  /** A setting where pnpm reads it, with the file; undefined when it is not set or not in a file depcurfew reads. */
  const settingOf = (setting: string): { value: unknown; file: string; line: number } | undefined => {
    const owner = pnpmOwner(includes, setting, manifest);
    if (owner.kind !== 'file') return undefined;
    const text = sources.read(owner.file);
    const found = text === undefined ? undefined : yamlSetting(text, [setting], options);
    return found === undefined ? undefined : { value: found.value, file: owner.file, line: found.line };
  };
  // ignorePnpmfile: true keeps every pnpmfile from loading, those of plugins too; a value depcurfew does not read
  // (a config dependency owns the setting) counts as not set.
  if (settingOf(facts.ignore)?.value === true) return [];

  const hooks: PnpmHook[] = [];
  const pnpmfileAt = (file: string): PnpmfileHook => {
    const text = sources.read(file);
    const index = text?.indexOf('updateConfig') ?? -1;
    return { kind: 'pnpmfile', file, ...(text === undefined || index === -1 ? {} : { updateConfigLine: text.slice(0, index).split('\n').length }) };
  };
  const named = (setting: string, from: { value: unknown; file: string; line: number }) => {
    const paths = Array.isArray(from.value) ? from.value : [from.value];
    for (const path of paths.filter((item): item is string => typeof item === 'string')) {
      const inside = insidePath(from.file, path);
      if (inside !== undefined && sources.isFile(inside)) hooks.push({ ...pnpmfileAt(inside), setting });
      else if (inside === undefined) hooks.push({ kind: 'pnpmfile', file: from.file, line: from.line, setting, path });
    }
  };
  const global = settingOf(facts.global);
  if (global !== undefined && typeof global.value === 'string') named(facts.global, global);

  const plugins = tool.extra?.['configPlugins'] === undefined ? undefined : extraOf(tool, 'configPlugins', isPlugins);
  const patterns = (plugins === undefined ? undefined : inEffect(plugins.patterns, version))?.map(patternOf) ?? [];
  const dependencies = plugins === undefined ? undefined : settingOf(plugins.setting);
  if (plugins !== undefined && dependencies !== undefined && isRecord(dependencies.value)) {
    const known = tool.extra?.['knownPlugins'] === undefined ? [] : (values(tool.extra['knownPlugins'])[0] as unknown);
    const list = isKnownPlugins(known) ? known : [];
    const text = sources.read(dependencies.file) ?? '';
    // pnpm loads the plugins in the order of their names (calc_pnpmfile_paths_of_plugin_deps).
    for (const name of Object.keys(dependencies.value).filter((key) => patterns.some((pattern) => pattern.test(key))).sort()) {
      const spec = String(dependencies.value[name] ?? '');
      const entry = list.find((item) => item.name === name && mayBeFrom(spec, item.since));
      hooks.push({
        kind: 'plugin',
        name,
        spec,
        file: dependencies.file,
        line: yamlSetting(text, [plugins.setting, name], options)?.line ?? dependencies.line,
        ...(entry === undefined ? {} : { known: entry }),
      });
    }
  }

  const configured = settingOf(facts.setting);
  const defaults = inEffect(facts.defaults, version) ?? [];
  const lookFor = (directory: string) => {
    const file = defaults.map((name) => (directory === '' ? name : `${directory}/${name}`)).find((candidate) => sources.isFile(candidate));
    if (file !== undefined) hooks.push(pnpmfileAt(file));
  };
  if (configured !== undefined && configured.value !== null) named(facts.setting, configured);
  else lookFor('');
  // Without a shared lockfile every workspace project also runs the pnpmfile of its own directory.
  if (settingOf('sharedWorkspaceLockfile')?.value === false) for (const directory of sources.packages ?? []) if (directory !== '' && directory !== '.') lookFor(directory);
  // A file named twice (the setting and the default, two workspace projects) is loaded once.
  const key = (hook: PnpmHook) => `${hook.kind}\0${hook.file}\0${hook.kind === 'plugin' ? hook.name : (hook.path ?? '')}`;
  return hooks.filter((hook, index) => hooks.findIndex((other) => key(other) === key(hook)) === index);
}

/** The settings a known plugin sets, for messages: "minimumReleaseAge: 1440 and blockExoticSubdeps: true". */
export function knownSettingsText(known: PnpmKnownPlugin): string {
  const items = Object.entries(known.settings).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * What a hook is, in one sentence of doctor and explain (one source for both): what pnpm loads and why depcurfew cannot
 * verify the settings, with what a known plugin sets.
 */
export function hookMessage(hook: PnpmHook, name: string): string {
  const can = `can change every setting after pnpm has read its configuration files, so depcurfew cannot verify the settings it checks`;
  if (hook.kind === 'plugin') {
    const known = hook.known === undefined ? '' : `; ${hook.name} ${hook.known.since} and later sets ${knownSettingsText(hook.known)}`;
    return `${name} loads the pnpmfile of the config dependency ${hook.name} (configDependencies in ${hook.file}, line ${hook.line}) because of its name, and its updateConfig hook ${can}${known}`;
  }
  if (hook.path !== undefined) return `${name} loads the pnpmfile ${hook.path}, which ${hook.setting ?? 'pnpmfile'} in ${hook.file} names and depcurfew cannot read, and the updateConfig hook of a pnpmfile ${can}`;
  const named = hook.setting === undefined ? '' : `, which ${hook.setting} names`;
  const defines = hook.updateConfigLine === undefined ? '' : ` and names updateConfig at line ${hook.updateConfigLine}`;
  return `${name} loads ${hook.file}${named}${defines}, and the updateConfig hook of a pnpmfile ${can}`;
}

/** What to do about a hook, for doctor and explain. */
export function hookFix(hook: PnpmHook, manifest = 'pnpm-workspace.yaml'): string {
  const check = 'make sure its updateConfig hook leaves minimumReleaseAge, allowBuilds and the other security settings as they are';
  const off = `ignorePnpmfile: true in ${manifest} stops every pnpmfile, those of plugins too`;
  if (hook.kind === 'plugin') {
    return hook.known === undefined
      ? `Remove ${hook.name} from configDependencies in ${hook.file} if the project does not need it, or read the pnpmfile of the version you install and ${check} (${off})`
      : `Remove ${hook.name} from configDependencies in ${hook.file}: what it sets replaces the settings of ${manifest} (${off})`;
  }
  if (hook.setting !== undefined) return `Read ${hook.path ?? hook.file} and ${check}, or take it out of ${hook.setting} in ${hook.path === undefined ? manifest : hook.file} if the project does not need it`;
  return `Read ${hook.file} and ${check}; if the project needs no pnpmfile, remove it and set pnpmfile: [] in ${manifest}, so that pnpm loads no new one by itself`;
}
