import type { Evidence, Fact } from './types.ts';

/** Keys of a tool entry that are plain metadata rather than sourced facts. */
export const METADATA_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'kind', 'ecosystem']);

export interface FactEntry {
  /** Dot path inside the tool entry, e.g. `cooldown.exclude.setting`. */
  path: string;
  fact: Fact<unknown>;
}

/** A value found outside any fact, i.e. without a source. */
export interface StrayValue {
  path: string;
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Anything with a `status` key is treated as a fact; its shape is checked by the validator. */
export function isFactLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && 'status' in value;
}

export function walkKnowledge(tool: object): { facts: FactEntry[]; strays: StrayValue[] } {
  const facts: FactEntry[] = [];
  const strays: StrayValue[] = [];

  const visit = (value: unknown, path: string) => {
    if (isFactLike(value)) {
      facts.push({ path, fact: value as unknown as Fact<unknown> });
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    } else {
      strays.push({ path, value });
    }
  };

  for (const [key, child] of Object.entries(tool)) {
    if (!METADATA_KEYS.has(key)) visit(child, key);
  }
  return { facts, strays };
}

export function collectFacts(tool: object): FactEntry[] {
  return walkKnowledge(tool).facts;
}

export function factAt(tool: object, path: string): Fact<unknown> | undefined {
  return collectFacts(tool).find((entry) => entry.path === path)?.fact;
}

/** The evidence behind a fact: one entry, or every variant of a disputed fact. */
export function evidenceOf<T>(fact: Fact<T>): readonly Evidence<T>[] {
  return fact.status === 'disputed' ? fact.variants : [fact];
}
