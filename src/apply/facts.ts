// Reading the knowledge base for generators. Where official sources disagree about the first version with a
// setting, the latest variant wins, so depcurfew never writes a key that the pinned version might not know.
import { evidenceOf } from '../knowledge/facts.ts';
import { knowledgeBase } from '../knowledge/index.ts';
import type { Fact, ToolKnowledge } from '../knowledge/types.ts';
import type { YamlOptions } from '../yaml-parse.ts';
import { compareVersions, parseVersion } from './version.ts';

export function values<T>(fact: Fact<T>): T[] {
  return evidenceOf(fact).map((evidence) => evidence.value);
}

/** The first file of a list of configuration files. */
export function firstFile(fact: Fact<readonly string[]>): string | undefined {
  return values(fact)[0]?.[0];
}

/** The setting name, or null if any official source says it does not exist. */
export function settingOf(fact: Fact<string | null> | undefined): string | null {
  if (fact === undefined) return null;
  const all = values(fact);
  return all.includes(null) ? null : (all[0] ?? null);
}

/** The latest first version among the variants; undefined when not recorded. */
export function sinceOf(fact: Fact<string | null> | undefined): string | undefined {
  if (fact === undefined) return undefined;
  const versions = values(fact).filter((value): value is string => value !== null && parseVersion(value) !== undefined);
  if (versions.length === 0) return undefined;
  return versions.sort((a, b) => compareVersions(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0])).at(-1);
}

/** A structured fact from `extra`; throws when the knowledge base lacks it, which tests catch. */
export function extraOf<T>(tool: ToolKnowledge, key: string, check: (value: unknown) => value is T): T {
  const fact = tool.extra?.[key];
  const value = fact === undefined ? undefined : values(fact)[0];
  if (!check(value)) throw new Error(`knowledge base: ${tool.id} extra.${key} is missing or malformed`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SwitchFact {
  setting: string;
  since?: string;
  value: unknown;
  /** The dependency sources the switch applies to, where it does not apply to all (Python build switches). */
  covers?: readonly string[];
  /**
   * For a switch that turns a protection off: the values the tool reads as off. Every other value turns it on, also a
   * string "false" where the tool tests the value for truth (pnpm's dangerouslyAllowAllBuilds).
   */
  off?: readonly unknown[];
}

export function isSwitch(value: unknown): value is SwitchFact {
  return isRecord(value) && typeof value['setting'] === 'string' && 'value' in value;
}

/**
 * Whether a configured value leaves a switch that turns a protection off really off: only the values the knowledge
 * base names (`off`), else only false. Anything else counts as on (fail closed); undefined is a value not set.
 */
export function switchIsOff(fact: SwitchFact, value: unknown): boolean {
  if (value === undefined) return true;
  return (fact.off ?? [false]).some((off) => off === value);
}

/** Whether the tool's YAML loader applies merge keys (<<), by a verified extra.yamlMergeKeys; false when not known. */
export function mergesYamlKeys(tool: ToolKnowledge | undefined): boolean {
  const fact = tool?.extra?.['yamlMergeKeys'];
  return fact?.status === 'verified' && fact.value === true;
}

/**
 * How the tool that reads a YAML configuration file of a repository parses it: with merge keys (<<) where its loader
 * applies them, for the tools whose configuration files include the file's name (pnpm-workspace.yaml).
 */
export function yamlOptionsFor(file: string, tools: readonly ToolKnowledge[] = knowledgeBase): YamlOptions {
  const name = file.split('/').at(-1) ?? file;
  return { merge: tools.some((tool) => mergesYamlKeys(tool) && values(tool.cooldown.configFiles).some((files) => files.includes(name))) };
}

export interface WildcardFact {
  since: string | null;
  trailingOnly: boolean;
}

export function isWildcards(value: unknown): value is WildcardFact {
  return isRecord(value) && (typeof value['since'] === 'string' || value['since'] === null) && typeof value['trailingOnly'] === 'boolean';
}
