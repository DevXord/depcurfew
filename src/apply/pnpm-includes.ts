// pnpm 12.15+ takes settings from the local YAML files and config dependencies that `include` in pnpm-workspace.yaml
// names, each setting with one owner (extra.configIncludes, decision D-164). This module reads the index as pnpm does,
// for apply (which writes each setting into the file that owns it) and doctor (which reads it there). Older versions
// read pnpm-workspace.yaml alone, so there is no index for them.
import { posix } from 'node:path';
import type { PnpmIncludesKnowledge, ToolKnowledge } from '../knowledge/types.ts';
import { yamlSetting } from '../doctor/settings.ts';
import { isMap, isScalar } from 'yaml';
import { parseYaml, readYamlDocument } from '../yaml-parse.ts';
import { extraOf, isRecord, mergesYamlKeys } from './facts.ts';
import { compareVersions, parseVersion, type Version } from './version.ts';

/** Where pnpm takes a setting from. */
export type PnpmOwner =
  /** A file of the directory: pnpm-workspace.yaml, or a local file of include. */
  | { kind: 'file'; file: string }
  /** A config dependency include delegates the setting to; `line` is that of its include entry. */
  | { kind: 'dependency'; name: string; line: number }
  /** A local file of include that lies outside the directory, or whose path depcurfew cannot read the way pnpm does. */
  | { kind: 'outside'; spec: string; line: number };

/** One entry of include. */
export interface PnpmIncludeSource {
  /** The source as written: ./config/security.yaml, or the name of a config dependency. */
  spec: string;
  kind: 'file' | 'dependency';
  /** A local file inside the directory: its path from there; absent for a dependency and a file outside. */
  file?: string;
  /** The line of the entry in pnpm-workspace.yaml. */
  line: number;
  /** '*': the file may define any setting no other source owns. */
  all: boolean;
  /** The settings a list delegates, by their canonical name (catalog is catalogs.default). */
  slots: string[];
  /** The settings of the list as written, in the order of `slots`. */
  selectors: string[];
}

/** Something in the index that makes pnpm stop, with its error code. */
export interface PnpmIncludeProblem {
  code: 'ERR_PNPM_INVALID_WORKSPACE_INCLUDE' | 'ERR_PNPM_DUPLICATE_SETTING' | 'ERR_PNPM_SETTING_NOT_DELEGATED';
  message: string;
  file: string;
  line: number;
}

export interface PnpmIncludes {
  /** pnpm-workspace.yaml. */
  manifest: string;
  /** The line of the include key. */
  line: number;
  sources: PnpmIncludeSource[];
  problems: PnpmIncludeProblem[];
  /** Where pnpm takes `setting` from, and where its commands write it. */
  owner(setting: string): PnpmOwner;
  /** The local files of include inside the directory, as named from there. */
  files: string[];
}

const isIncludesFact = (value: unknown): value is PnpmIncludesKnowledge =>
  isRecord(value) && typeof value['since'] === 'string' && typeof value['key'] === 'string' && isRecord(value['spellings']) && Array.isArray(value['notForDependencies']);

/** The facts of include, when the version reads it (the latest known when the version is unknown). */
export function includesFacts(tool: ToolKnowledge, version: Version | undefined): PnpmIncludesKnowledge | undefined {
  if (tool.extra?.['configIncludes'] === undefined) return undefined;
  const facts = extraOf(tool, 'configIncludes', isIncludesFact);
  const since = parseVersion(facts.since);
  return version !== undefined && since !== undefined && compareVersions(version, since) < 0 ? undefined : facts;
}

/** The slot a selector of a list names, as pnpm reads it (SettingSlot::parse_selector); undefined for an invalid one. */
function selectorSlot(facts: PnpmIncludesKnowledge, selector: string): string | undefined {
  if (selector === '' || selector === facts.key) return undefined;
  if (selector === 'catalog') return 'catalogs.default';
  if (selector === 'catalogs') return 'catalogs';
  if (selector.startsWith('catalogs.')) return selector === 'catalogs.' ? undefined : selector;
  if (selector.includes('.')) return undefined;
  return facts.spellings[selector] ?? selector;
}

/** The slots a top-level key of a settings file defines (defined_slots). */
function definedSlots(facts: PnpmIncludesKnowledge, key: string, value: unknown): string[] {
  if (key === '$schema') return [];
  if (key === 'catalog') return ['catalogs.default'];
  if (key === 'catalogs') return isRecord(value) ? Object.keys(value).map((name) => `catalogs.${name}`) : [];
  return [facts.spellings[key] ?? key];
}

/** A slot as pnpm names it in messages. */
export function slotName(slot: string): string {
  return slot === 'catalogs.default' ? 'catalog' : slot;
}

const covers = (listed: string, slot: string) => listed === slot || (listed === 'catalogs' && slot.startsWith('catalogs.'));

/** A source that can only be a package name: no path, URL or protocol (is_package_name_shaped). */
function isPackageName(spec: string): boolean {
  let unscoped = spec;
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash <= 1) return false;
    unscoped = spec.slice(slash + 1);
  }
  return unscoped !== '' && !/[/\\:]/u.test(unscoped) && !unscoped.startsWith('.');
}

/** A local path from the directory, or undefined when it leads out of it (or has a backslash, which pnpm reads by platform). */
function localPath(spec: string): string | undefined {
  if (spec.includes('\\')) return undefined;
  const path = posix.normalize(spec);
  return path === '..' || path.startsWith('../') || path.startsWith('/') ? undefined : path;
}

type Claimant = 'root' | number;

/** The most problems of one index that are reported (pnpm itself stops at the first). */
export const MAX_PROBLEMS = 20;

/**
 * The include index of `manifest` as pnpm reads it, or undefined when the version does not read include (before
 * 12.15.0), the manifest is missing or cannot be parsed (unreadable-config reports that), or has no include. `read`
 * gives the text of a file of the directory, undefined when it is missing or cannot be read.
 */
export function readPnpmIncludes(tool: ToolKnowledge, version: Version | undefined, read: (file: string) => string | undefined, manifest = 'pnpm-workspace.yaml'): PnpmIncludes | undefined {
  const facts = includesFacts(tool, version);
  if (facts === undefined) return undefined;
  const text = read(manifest);
  if (text === undefined || !text.includes(facts.key)) return undefined;
  const options = { merge: mergesYamlKeys(tool) };
  let root: unknown;
  try {
    root = parseYaml(text, options);
  } catch {
    return undefined;
  }
  if (!isRecord(root) || !Object.hasOwn(root, facts.key)) return undefined;
  const lineOf = (path: readonly string[]) => yamlSetting(text, path, options)?.line ?? 1;
  const entryLine = entryLines(text, facts.key, options);
  const line = lineOf([facts.key]);
  const problems: PnpmIncludeProblem[] = [];
  // pnpm stops at the first problem; a few say enough, and a file with thousands of keys that are all wrong costs no
  // more than one with a few.
  const add = (found: PnpmIncludeProblem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(found);
  };
  const problem = (code: PnpmIncludeProblem['code'], message: string, at: number) => add({ code, message, file: manifest, line: at });
  const sources: PnpmIncludeSource[] = [];
  const index = root[facts.key];
  if (!isRecord(index)) problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `${facts.key} is not a mapping of sources to the settings they may define`, line);
  for (const [spec, delegation] of Object.entries(isRecord(index) ? index : {})) {
    const at = entryLine.get(spec) ?? line;
    const local = facts.localPrefixes.some((prefix) => spec.startsWith(prefix));
    if (!local && !isPackageName(spec)) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the source "${spec}" is neither a relative path that starts with ${facts.localPrefixes.join(' or ')} nor the name of a config dependency`, at);
      continue;
    }
    if (local && [...facts.globCharacters].some((character) => spec.includes(character))) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the source "${spec}" is a glob, which pnpm does not accept`, at);
      continue;
    }
    if (local && !facts.localExtensions.some((extension) => spec.endsWith(extension))) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the source "${spec}" is not a ${facts.localExtensions.join(' or ')} file`, at);
      continue;
    }
    const all = delegation === facts.unrestricted;
    const slots: string[] = [];
    const selectors: string[] = [];
    if (!all) {
      if (!Array.isArray(delegation) || delegation.some((item) => typeof item !== 'string')) {
        problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `"${spec}" is delegated neither '${facts.unrestricted}' nor a list of settings`, at);
        continue;
      }
      let valid = true;
      const seenSlots = new Set<string>();
      for (const selector of delegation as string[]) {
        const slot = selectorSlot(facts, selector);
        if (slot === undefined || seenSlots.has(slot)) {
          problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `"${selector}" in the list of "${spec}" is ${slot === undefined ? 'not a setting that can be delegated' : 'listed twice'}`, at);
          valid = false;
          break;
        }
        slots.push(slot);
        seenSlots.add(slot);
        selectors.push(selector);
      }
      if (!valid) continue;
    }
    if (!local) {
      if (all) {
        problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the config dependency ${spec} is delegated '${facts.unrestricted}', but a config dependency always needs a list of settings`, at);
        continue;
      }
      const forbidden = slots.find((slot) => facts.notForDependencies.includes(slot));
      if (forbidden !== undefined) {
        problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `${forbidden} cannot be delegated to the config dependency ${spec}`, at);
        continue;
      }
      sources.push({ spec, kind: 'dependency', line: at, all, slots, selectors });
      continue;
    }
    const file = localPath(spec);
    sources.push({ spec, kind: 'file', ...(file === undefined ? {} : { file }), line: at, all, slots, selectors });
  }

  // The settings of each local file inside the directory; a file that cannot be read or parsed defines nothing here.
  const fragments = new Map<number, Record<string, unknown>>();
  const seen = new Map<string, string>();
  for (const [position, source] of sources.entries()) {
    if (source.kind !== 'file' || source.file === undefined) continue;
    if (source.file === posix.normalize(manifest)) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the source "${source.spec}" is ${manifest} itself`, source.line);
      continue;
    }
    const other = seen.get(source.file);
    if (other !== undefined) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `"${source.spec}" names the same file as "${other}"`, source.line);
      continue;
    }
    seen.set(source.file, source.spec);
    const fragment = read(source.file);
    if (fragment === undefined) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `${source.file}, which include names, does not exist or cannot be read (pnpm needs every included file, also an empty one)`, source.line);
      continue;
    }
    let settings: unknown;
    try {
      settings = parseYaml(fragment, options);
    } catch {
      continue;
    }
    if (settings === null || settings === undefined) settings = {};
    if (!isRecord(settings)) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `${source.file}, which include names, is not a mapping of settings`, source.line);
      continue;
    }
    if (Object.hasOwn(settings, facts.key)) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `${source.file} has an ${facts.key} of its own, which only ${manifest} may have`, source.line);
      continue;
    }
    fragments.set(position, settings);
  }

  // Ownership as pnpm builds it (Ownership::build): the reservations of the lists first, then what each file defines.
  const describe = (claimant: Claimant) => (claimant === 'root' ? manifest : (sources[claimant]?.spec ?? ''));
  const reserved = new Map<string, number>();
  const defined = new Map<string, Claimant>();
  const reservationOf = (slot: string) => reserved.get(slot) ?? (slot.startsWith('catalogs.') ? reserved.get('catalogs') : undefined);
  // A slot overlaps a reserved one when it is the same, or when one is every catalog and the other one catalog: a map
  // lookup each, so that long lists take linear time.
  let firstCatalog: string | undefined;
  const overlapping = (slot: string): string | undefined => {
    if (reserved.has(slot)) return slot;
    if (slot.startsWith('catalogs.') && reserved.has('catalogs')) return 'catalogs';
    return slot === 'catalogs' ? firstCatalog : undefined;
  };
  for (const [position, source] of sources.entries()) {
    for (const slot of source.slots) {
      const listed = overlapping(slot);
      const other = listed === undefined ? undefined : reserved.get(listed);
      if (listed !== undefined && other !== undefined) {
        problem('ERR_PNPM_DUPLICATE_SETTING', `${slotName(listed === 'catalogs' ? slot : slot === 'catalogs' ? listed : listed < slot ? listed : slot)} is delegated to ${describe(other)} and to ${source.spec}`, source.line);
        continue;
      }
      reserved.set(slot, position);
      if (slot.startsWith('catalogs.')) firstCatalog ??= slot;
    }
  }
  // What each list permits, as a set: a lookup per key, so that a long list and a large file take linear time.
  const listed = sources.map((source) => new Set(source.slots));
  const permits = (claimant: number, slot: string) => listed[claimant]?.has(slot) === true || (slot.startsWith('catalogs.') && listed[claimant]?.has('catalogs') === true);
  const define = (claimant: Claimant, settings: Record<string, unknown>, at: number) => {
    const source = claimant === 'root' ? undefined : sources[claimant];
    for (const [key, value] of Object.entries(settings)) {
      if (key === facts.key) continue;
      for (const slot of definedSlots(facts, key, value)) {
        if (source !== undefined && claimant !== 'root' && !source.all && !permits(claimant, slot)) {
          if (problems.length < MAX_PROBLEMS) add({ code: 'ERR_PNPM_SETTING_NOT_DELEGATED', message: `${source.spec} defines ${key}, which include does not give to it`, file: source.file ?? manifest, line: (source.file === undefined ? undefined : yamlLine(read(source.file), key, options)) ?? source.line });
          continue;
        }
        const owner = reservationOf(slot);
        // The line only for a problem: looking it up for every key would read a large file once per key.
        const where = () => (claimant === 'root' ? (yamlLine(text, key, options) ?? at) : at);
        if (owner !== undefined && owner !== claimant) {
          if (problems.length < MAX_PROBLEMS) problem('ERR_PNPM_DUPLICATE_SETTING', `${slotName(slot)} is delegated to ${describe(owner)} and defined in ${describe(claimant)}`, where());
          continue;
        }
        const other = defined.get(slot);
        if (other !== undefined && other !== claimant) {
          if (problems.length < MAX_PROBLEMS) problem('ERR_PNPM_DUPLICATE_SETTING', `${slotName(slot)} is defined in ${describe(other)} and in ${describe(claimant)}`, where());
          continue;
        }
        if (owner === undefined) defined.set(slot, claimant);
      }
    }
  };
  define('root', root, line);
  for (const [position, settings] of fragments) define(position, settings, sources[position]?.line ?? line);

  // Every config dependency source must be declared, in the root or in a file of include.
  const declared = new Set<string>();
  for (const settings of [root, ...fragments.values()]) {
    const dependencies = settings[facts.dependencies];
    if (isRecord(dependencies)) for (const name of Object.keys(dependencies)) declared.add(name);
  }
  for (const source of sources) {
    if (source.kind === 'dependency' && !declared.has(source.spec)) {
      problem('ERR_PNPM_INVALID_WORKSPACE_INCLUDE', `the config dependency ${source.spec} is not declared in ${facts.dependencies}`, source.line);
    }
  }

  const ownerOf = (claimant: Claimant): PnpmOwner => {
    const source = claimant === 'root' ? undefined : sources[claimant];
    if (source === undefined) return { kind: 'file', file: manifest };
    if (source.kind === 'dependency') return { kind: 'dependency', name: source.spec, line: source.line };
    return source.file === undefined ? { kind: 'outside', spec: source.spec, line: source.line } : { kind: 'file', file: source.file };
  };
  return {
    manifest,
    line,
    sources,
    problems,
    owner(setting) {
      const slot = definedSlots(facts, setting, {})[0] ?? setting;
      const claimant = reservationOf(slot) ?? defined.get(slot);
      return ownerOf(claimant ?? 'root');
    },
    files: sources.flatMap((source) => (source.kind === 'file' && source.file !== undefined ? [source.file] : [])),
  };
}

/** The line of each entry of the include map, read once: a lookup per entry would walk the map once per entry. */
function entryLines(text: string, key: string, options: { merge: boolean }): Map<string, number> {
  const lines = new Map<string, number>();
  const { document, lineCounter } = readYamlDocument(text, options);
  const root = document.contents;
  if (!isMap(root)) return lines;
  const index = root.items.find((pair) => isScalar(pair.key) && String(pair.key.value) === key)?.value;
  if (!isMap(index)) return lines;
  for (const pair of index.items) {
    if (!isScalar(pair.key) || pair.key.range === undefined || pair.key.range === null) continue;
    const name = String(pair.key.value);
    if (!lines.has(name)) lines.set(name, lineCounter.linePos(pair.key.range[0]).line);
  }
  return lines;
}

/** The line of a top-level key of a YAML file, for messages. */
function yamlLine(text: string | undefined, key: string, options: { merge: boolean }): number | undefined {
  return text === undefined ? undefined : yamlSetting(text, [key], options)?.line;
}

/** Where pnpm takes `setting` from: its owner in include, else pnpm-workspace.yaml. */
export function pnpmOwner(includes: PnpmIncludes | undefined, setting: string, manifest = 'pnpm-workspace.yaml'): PnpmOwner {
  return includes?.owner(setting) ?? { kind: 'file', file: manifest };
}

/** The owner in words, for messages: "the config dependency @acme/policy (include in pnpm-workspace.yaml, line 3)". */
export function ownerText(owner: Exclude<PnpmOwner, { kind: 'file' }>, manifest = 'pnpm-workspace.yaml'): string {
  return owner.kind === 'dependency'
    ? `the config dependency ${owner.name} (include in ${manifest}, line ${owner.line})`
    : `${owner.spec}, which lies outside the directory (include in ${manifest}, line ${owner.line})`;
}
